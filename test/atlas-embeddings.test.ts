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
// Like embed.py: each chunk is flushed, then reported as embedded; STAND_IN_FAIL_AFTER fails after that many chunks.
const chunk = Number(process.env.STAND_IN_CHUNK ?? texts.length) || 1;
fs.writeFileSync(arg("--output"), new Uint8Array(0));
for (let start = 0, n = 0; start < texts.length; start += chunk, n++) {
  if (process.env.STAND_IN_FAIL_AFTER && n === Number(process.env.STAND_IN_FAIL_AFTER)) { console.error(JSON.stringify({ error: "out of memory" })); process.exit(4); }
  fs.appendFileSync(arg("--output"), new Uint8Array(out.buffer, start * d * 4, Math.min(chunk, texts.length - start) * d * 4));
  console.error(JSON.stringify({ embedded: Math.min(texts.length, start + chunk), seconds: 0.01 }));
}
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

test("a run that fails after some chunks keeps their vectors, and the rerun embeds only the rest", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-embeddings-resume-"));
  try {
    const script = join(root, "stand-in.cjs"), seen = join(root, "seen.jsonl");
    writeFileSync(script, STAND_IN);
    Object.assign(process.env, { STAND_IN_SEEN: seen, STAND_IN_CHUNK: "2", STAND_IN_FAIL_AFTER: "2" });
    const config = embeddingConfig({ dimensions: 128, cache: "cache" }, root, {});
    const texts = ["a", "bb", "ccc", "dddd", "eeeee"];
    await assert.rejects(embedTexts(texts, config, join(root, "a.f32"), { command: [process.execPath, script] }),
      /exited with 4[\s\S]*out of memory[\s\S]*4 of 5 new vectors were cached/u);
    delete process.env.STAND_IN_FAIL_AFTER;
    writeFileSync(seen, "");
    const rerun = await embedTexts(texts, config, join(root, "b.f32"), { command: [process.execPath, script] });
    assert.deepEqual([rerun.cached, rerun.embedded], [4, 1]);
    assert.deepEqual(readFileSync(seen, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string), ["eeeee"]);
    assert.deepEqual(rows(join(root, "b.f32"), 128).map(([length]) => length), [1, 2, 3, 4, 5]);
  } finally {
    for (const name of ["STAND_IN_SEEN", "STAND_IN_CHUNK", "STAND_IN_FAIL_AFTER"]) delete process.env[name];
    rmSync(root, { recursive: true, force: true });
  }
});

test("the runtime sizes batches by padded tokens and caps each text's tokens", { skip: process.platform === "win32" }, async () => {
  // embed.py's batching is plain Python, importable without the model runtime.
  const { execFileSync } = await import("node:child_process");
  const script = join(process.cwd(), "scripts/embeddings/embed.py");
  const program = [
    "import importlib.util, json, sys",
    "sys.dont_write_bytecode = True",
    "spec = importlib.util.spec_from_file_location('embed', sys.argv[1]); embed = importlib.util.module_from_spec(spec); spec.loader.exec_module(embed)",
    "lengths = [10, 10, 10, 10, 400, 400, 900, 3000]",
    "print(json.dumps([list(b) for b in embed.batches(sorted(range(8), key=lambda i: lengths[i]), lengths, 3, 1000)]))",
  ].join("\n");
  let python: string | undefined;
  for (const candidate of ["python3", "python"]) { try { execFileSync(candidate, ["--version"], { stdio: "ignore" }); python = candidate; break; } catch { /* next */ } }
  if (!python) return;
  const out = JSON.parse(execFileSync(python, ["-I", "-c", program, script], { encoding: "utf8" })) as number[][];
  // At most 3 texts per batch and 1,000 padded tokens; a text over the budget goes alone.
  assert.deepEqual(out, [[0, 1, 2], [3, 4], [5], [6], [7]]);
  assert.match(readFileSync(script, "utf8"), /model\.max_seq_length = args\.max_tokens/u);
});

test("the layout check builds the cuML estimators with cuML's own arguments", { skip: process.platform === "win32" }, async () => {
  // Stand-ins for cupy and cuML whose constructors take the arguments cuML 26.10's do: its PCA has no random_state.
  const { execFileSync } = await import("node:child_process");
  const script = join(process.cwd(), "scripts/embeddings/layout.py");
  const program = [
    "import json, runpy, sys, types",
    "sys.dont_write_bytecode = True",
    "def module(name, **attrs):",
    "    m = types.ModuleType(name); m.__dict__.update(attrs); sys.modules[name] = m; return m",
    "class PCA:",
    "    def __init__(self, *, handle=None, copy=True, iterated_power=15, n_components=None, svd_solver='auto', tol=1e-7, verbose=False, whiten=False, output_type=None): self.n_components = n_components",
    "class UMAP:",
    "    def __init__(self, *, n_neighbors=15, n_components=2, metric='euclidean', min_dist=0.1, random_state=None, **rest): pass",
    "class NearestNeighbors:",
    "    def __init__(self, *, n_neighbors=5, metric='euclidean', **rest): pass",
    "module('numpy')",
    "module('cupy', cuda=types.SimpleNamespace(runtime=types.SimpleNamespace(getDeviceCount=lambda: 1)))",
    "module('cuml', __version__='26.10.00')",
    "module('cuml.decomposition', PCA=PCA); module('cuml.manifold', UMAP=UMAP); module('cuml.neighbors', NearestNeighbors=NearestNeighbors)",
    "sys.argv = [sys.argv[1], '--check']",
    "runpy.run_path(sys.argv[0], run_name='__main__')",
  ].join("\n");
  let python: string | undefined;
  for (const candidate of ["python3", "python"]) { try { execFileSync(candidate, ["--version"], { stdio: "ignore" }); python = candidate; break; } catch { /* next */ } }
  if (!python) return;
  const out = JSON.parse(execFileSync(python, ["-I", "-c", program, script], { encoding: "utf8" })) as { ok: boolean; backend: string; backendVersion: string };
  assert.deepEqual(out, { ok: true, backend: "cuml", backendVersion: "26.10.00" });
  // A seed passed to cuML's PCA fails the check, before any unit is built or embedded.
  const seeded = readFileSync(script, "utf8").replace("PCA(n_components=dims),", "PCA(n_components=dims, random_state=args.seed),");
  assert.notEqual(seeded, readFileSync(script, "utf8"));
  const dir = mkdtempSync(join(tmpdir(), "ebo-layout-check-"));
  try {
    writeFileSync(join(dir, "layout.py"), seeded);
    assert.throws(() => execFileSync(python, ["-I", "-c", program, join(dir, "layout.py")], { encoding: "utf8", stdio: "pipe" }), /random_state/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the runtime replaces a lone surrogate in its input, which tokenizers reject", { skip: process.platform === "win32" }, async () => {
  const { execFileSync } = await import("node:child_process");
  const script = join(process.cwd(), "scripts/embeddings/embed.py");
  // The input line as JSON.stringify writes a lone high surrogate: json.loads keeps it, so embed.py must replace it.
  const program = [
    "import importlib.util, json, sys",
    "sys.dont_write_bytecode = True",
    "spec = importlib.util.spec_from_file_location('embed', sys.argv[1]); embed = importlib.util.module_from_spec(spec); spec.loader.exec_module(embed)",
    "texts = [embed.well_formed(json.loads(line)) for line in sys.argv[2:]]",
    "[t.encode('utf-8') for t in texts]",
    "print(json.dumps(texts))",
  ].join("\n");
  let python: string | undefined;
  for (const candidate of ["python3", "python"]) { try { execFileSync(candidate, ["--version"], { stdio: "ignore" }); python = candidate; break; } catch { /* next */ } }
  if (!python) return;
  const lines = [JSON.stringify("ab\ud83d"), JSON.stringify("ab\u{1F600}"), JSON.stringify("\udc00cd")];
  const out = JSON.parse(execFileSync(python, ["-I", "-c", program, script, ...lines], { encoding: "utf8" })) as string[];
  assert.deepEqual(out, ["ab\ufffd", "ab\u{1F600}", "\ufffdcd"], "a whole pair is kept; each half pair becomes U+FFFD");
});
