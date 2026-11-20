import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkEmbeddingRuntime, EMBEDDINGGEMMA_MODEL, EMBEDDINGGEMMA_REVISION, embeddingConfig, embedTexts, LOCAL_EMBEDDING_MODEL } from "../src/atlas-embeddings.js";

// A stand-in for scripts/embeddings/embed.py with the same command-line contract: it reads JSON lines and writes one
// float32 row per line (the text's length and code-point sum, then zeros), records each text it saw and writes stats.
const STAND_IN = `
const fs = require("node:fs");
const a = process.argv.slice(2), arg = (name) => a[a.indexOf(name) + 1];
const d = Number(arg("--dimensions")), texts = fs.readFileSync(arg("--input"), "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l));
if (process.env.STAND_IN_FAIL) { console.error(JSON.stringify({ error: "boom" })); process.exit(3); }
fs.appendFileSync(process.env.STAND_IN_SEEN, texts.map((t) => JSON.stringify(t) + "\\n").join(""));
const out = new Float32Array(texts.length * d);
texts.forEach((t, i) => { out[i * d] = t.length; out[i * d + 1] = [...t].reduce((s, c) => s + c.codePointAt(0), 0); });
fs.writeFileSync(arg("--output"), new Uint8Array(out.buffer));
console.error(JSON.stringify({ device: "cpu", warning: "No CUDA or MPS device is available; embedding on CPU, which is much slower." }));
fs.writeFileSync(arg("--stats"), JSON.stringify({ model: arg("--model"), revision: arg("--revision"), promptName: arg("--prompt-name"), prompt: "task: clustering | query: ",
  dimensions: d, device: "cpu", dtype: "float32", batchSize: 32, texts: texts.length, seconds: 0.01, textsPerSecond: 100, packages: { python: "stand-in" } }));
`;

function rows(path: string, d: number) {
  const bytes = readFileSync(path), v = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return Array.from({ length: v.length / d }, (_, i) => [v[i * d]!, v[i * d + 1]!]);
}

test("EmbeddingGemma 2 is the default provider at 768 dimensions, with the documented truncations and an explicit offline option", () => {
  const config = embeddingConfig(undefined, "/base", {});
  assert.deepEqual([config.provider, config.model, config.revision, config.dimensions, config.python], ["embeddinggemma", EMBEDDINGGEMMA_MODEL, EMBEDDINGGEMMA_REVISION, 768, undefined]);
  assert.equal(embeddingConfig(undefined, "/base", { EBO_EMBEDDINGS_PYTHON: "/venv/bin/python" }).python, "/venv/bin/python");
  assert.equal(embeddingConfig({ python: "venv/bin/python" }, "/base", {}).python, "/base/venv/bin/python");
  for (const dimensions of [512, 256, 128]) assert.equal(embeddingConfig({ dimensions }, "/base", {}).dimensions, dimensions);
  assert.throws(() => embeddingConfig({ dimensions: 300 }, "/base", {}), /768, 512, 256, 128/u);
  const offline = embeddingConfig({ provider: "hashed-tfidf" }, "/base", {});
  assert.deepEqual([offline.model, offline.dimensions], [LOCAL_EMBEDDING_MODEL, 256]);
});

test("embedding runs embed each distinct redacted text once, reuse the cache and report the runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-embeddings-"));
  try {
    const script = join(root, "stand-in.cjs"), seen = join(root, "seen.jsonl");
    writeFileSync(script, STAND_IN);
    process.env.STAND_IN_SEEN = seen;
    const command = [process.execPath, script];
    const config = { ...embeddingConfig({ dimensions: 128, cache: "cache" }, root, {}) };
    const secret = "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";
    const texts = ["read the file", "run the tests", "read the file", secret];
    const lines: string[] = [];
    const first = await embedTexts(texts, config, join(root, "a.f32"), { command, progress: (line) => lines.push(line) });
    assert.deepEqual([first.texts, first.distinct, first.cached, first.embedded], [4, 3, 0, 3]);
    assert.equal(first.runtime?.device, "cpu");
    assert.equal(first.runtime?.prompt, "task: clustering | query: ");
    assert.ok(lines.some((line) => line.includes("embedding on CPU")), "the runtime's CPU fallback is relayed");
    // What reached the runtime is the redacted text, each distinct text once.
    const sent = readFileSync(seen, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string);
    assert.equal(sent.length, 3);
    assert.ok(!sent.some((text) => text.includes("abcdefghijklmnopqrstuvwxyz")), JSON.stringify(sent));
    const out = rows(join(root, "a.f32"), 128);
    assert.equal(statSync(join(root, "a.f32")).size, 4 * 128 * 4);
    assert.deepEqual(out[0], out[2]);
    assert.equal(out[1]![0], "run the tests".length);

    // A second pass reads every row from the cache and calls no runtime.
    const second = await embedTexts([...texts].reverse(), config, join(root, "b.f32"), { command: [process.execPath, "-e", "process.exit(9)"] });
    assert.deepEqual([second.cached, second.embedded, second.runtime], [3, 0, undefined]);
    assert.deepEqual(rows(join(root, "b.f32"), 128), [...out].reverse());

    // An interrupted append (vectors without their keys) is dropped; only whole entries count.
    const [cacheDir] = (await import("node:fs")).readdirSync(join(root, "cache"));
    const keys = join(root, "cache", cacheDir!, "keys.bin");
    truncateSync(keys, 2 * 32);
    const third = await embedTexts(["run the tests", "something new"], config, join(root, "c.f32"), { command });
    assert.deepEqual([third.cached, third.embedded], [1, 1]);
    assert.equal(statSync(keys).size, 3 * 32);
    assert.equal(statSync(join(root, "cache", cacheDir!, "vectors.f32")).size, 3 * 128 * 4);
    assert.equal(rows(join(root, "c.f32"), 128)[1]![0], "something new".length);

    // A failing runtime fails the pass with its own output.
    process.env.STAND_IN_FAIL = "1";
    await assert.rejects(embedTexts(["another"], config, join(root, "d.f32"), { command }), /exited with 3[\s\S]*boom/u);
    delete process.env.STAND_IN_FAIL;
    // Without a runtime the error says how to provide one.
    await assert.rejects(embedTexts(["another"], config, join(root, "e.f32")), /EBO_EMBEDDINGS_PYTHON[\s\S]*hashed-tfidf/u);
    assert.equal(existsSync(join(root, "e.f32")), false);
  } finally {
    delete process.env.STAND_IN_SEEN;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runtime check loads the model before a build starts and reports a broken runtime", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-embeddings-check-"));
  try {
    const fake = (name: string, body: string) => { const path = join(root, name); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path; };
    const seen = join(root, "args.txt");
    const ok = fake("ok-python", `echo "$@" >> ${JSON.stringify(seen)}; echo '{"ok":true}'`);
    await checkEmbeddingRuntime(embeddingConfig({ python: ok }, root, {}), { layout: true });
    const calls = readFileSync(seen, "utf8").trim().split("\n");
    assert.equal(calls.length, 2);
    assert.match(calls[0]!, /embed\.py .*--model google\/embeddinggemma-2 .*--check/u);
    assert.match(calls[1]!, /layout\.py --check/u);
    const broken = fake("broken-python", `echo 'ValueError: Could not load any image processor class. Missing optional dependencies: torchvision, Pillow' >&2; exit 1`);
    await assert.rejects(checkEmbeddingRuntime(embeddingConfig({ python: broken }, root, {}), { layout: false }), /failed its check before the build started[\s\S]*torchvision, Pillow/u);
    // No runtime, nothing to check (the build reports the missing runtime itself); the offline provider needs no model.
    await checkEmbeddingRuntime(embeddingConfig(undefined, root, {}), { layout: true });
    await checkEmbeddingRuntime(embeddingConfig({ provider: "hashed-tfidf", python: ok }, root, {}), { layout: false });
    assert.equal(readFileSync(seen, "utf8").trim().split("\n").length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
