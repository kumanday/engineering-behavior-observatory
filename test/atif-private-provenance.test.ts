import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { atifPointerValue, inspectAtifBytes } from "../src/atif-reader.js";
import { projectAtifCore } from "../src/atif-core.js";
import { createRetainedBehaviorEvidenceV2 } from "../src/native-v2.js";
const root = process.env.EBO_ATIF_PRIVATE_FIXTURES;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const text = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value)
  ? value.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : "";

test("positive OpenClaw acquisition binds the requested ATIF and every supporting native artifact", { skip: !root }, () => {
  const directory = join(root!, "openclaw-positive"), receipt = json(join(directory, "acquisition.json"));
  assert.equal(receipt.terms, "unstated"); assert.equal(receipt.sharing, "restricted");
  assert.equal(receipt.trialPath, "runs/20261106-180950-glm-5-3-flash-smoke-low-9b91/terminal-bench-2.1/configure-git-webserver__iLKmjGE");
  const paths: string[] = [];
  for (const artifact of receipt.artifacts) {
    const relative = artifact.sourcePath.slice(receipt.trialPath.length + 1);
    assert.ok(artifact.sourcePath.startsWith(`${receipt.trialPath}/agent/`));
    const bytes = readFileSync(join(directory, relative));
    assert.equal(sha(bytes), artifact.sha256, relative); assert.equal(bytes.length, artifact.bytes, relative);
    paths.push(relative);
  }
  assert.ok(paths.includes("agent/openclaw-session.jsonl"));
  assert.deepEqual(paths.filter((path) => path.startsWith("agent/openclaw-trajectory/")).map((path) => path.split("/").at(-1)).sort(), readdirSync(join(directory, "agent/openclaw-trajectory")).sort());
  assert.equal(paths.length, 9);
  const bytes = readFileSync(join(directory, "agent/trajectory.json")), doc = JSON.parse(bytes.toString());
  assert.equal(bytes.length, 82325); assert.equal(sha(bytes), "9bc85e815bba3b807294df10e78e2a1622c81529242071e3d83bc4481036a298");
  assert.equal(doc.schema_version, "ATIF-v1.8"); assert.deepEqual(doc.agent.version, "2026.11.1");
  assert.equal(doc.steps.length, 68);
  assert.equal(doc.steps.flatMap((step: { tool_calls?: unknown[] }) => step.tool_calls ?? []).length, 65);
  assert.equal(doc.steps.flatMap((step: { observation?: { results?: unknown[] } }) => step.observation?.results ?? []).length, 65);
  assert.equal(Boolean(doc.extra?.partial), false);
  assert.equal(doc.steps.some((step: { message?: unknown }) => typeof step.message === "string" && step.message.includes("[COMPACTED HISTORY]")), false);
  assert.ok(readFileSync(join(root!, "unknown-producers/openclaw-partial.json")).length > 0);
});

test("authored Droid and DeepSeek selections reproduce the retained messages and call/result values", { skip: !root }, () => {
  for (const name of ["factory-droid", "deepseek-harness"]) {
    const directory = join(root!, "capture-derived-authored"), receipt = json(join(directory, `${name}.receipt.json`));
    const bytes = readFileSync(receipt.sourcePath), manifest = readFileSync(receipt.manifestPath), atif = readFileSync(join(directory, `${name}.json`));
    assert.equal(sha(bytes), receipt.sourceSha256); assert.equal(bytes.length, receipt.sourceBytes);
    assert.equal(sha(manifest), receipt.manifestSha256); assert.equal(sha(atif), receipt.trajectorySha256);
    const lines = bytes.toString().split("\n"), document = JSON.parse(atif.toString());
    const values = receipt.mapping.map((mapping: { native: string | null; atif: string }) => {
      if (mapping.native === null) { assert.equal(atifPointerValue(document, mapping.atif), ""); return null; }
      const [, line, pointer] = /^line:([0-9]+)(#.*)$/u.exec(mapping.native)!;
      return atifPointerValue(JSON.parse(lines[Number(line) - 1]!), pointer!);
    });
    assert.equal(document.steps[0].message, text(values[0]));
    if (values[1] !== null) assert.equal(document.steps[1].message, text(values[1]));
    const call = document.steps[1].tool_calls[0], native = values[2];
    assert.equal(call.function_name, native.name); assert.equal(call.tool_call_id, name === "factory-droid" ? native.id : native.callId);
    assert.deepEqual(call.arguments, name === "factory-droid" ? native.input : JSON.parse(native.arguments));
    const result = document.steps[1].observation.results[0];
    assert.equal(result.source_call_id, call.tool_call_id);
    const nativeResultRecord = name === "factory-droid" ? null : values[3].content.find((part: { toolCallId?: string }) => part.toolCallId === call.tool_call_id);
    const nativeResult = name === "factory-droid" ? values[3] : nativeResultRecord.content;
    assert.equal(result.content, text(nativeResult));
    if (name === "deepseek-harness") assert.equal(nativeResultRecord.toolCallId, call.tool_call_id);
    assert.equal(receipt.authored, true);
  }
});

test("real retained Pi and Agent SDK pairs agree on call/result identities and report extra native populations", { skip: !root }, async () => {
  for (const [name, expected, extra] of [["pi-qualified", 2, 0], ["claude-agent-sdk", 202, 57]] as const) {
    const directory = join(root!, "retained-conversions", name), receipt = json(join(directory, "receipt.json"));
    assert.equal(sha(readFileSync(receipt.sourcePath)), receipt.sourceSha256);
    const nativeRoot = receipt.nativeCaptureRoot ?? dirname(receipt.sourcePath);
    if (receipt.manifestSha256) assert.equal(sha(readFileSync(join(nativeRoot, "manifest.json"))), receipt.manifestSha256);
    const bytes = readFileSync(join(directory, "trajectory.json")); assert.equal(sha(bytes), receipt.trajectorySha256);
    const native = await createRetainedBehaviorEvidenceV2(nativeRoot), imported = (await projectAtifCore({ read: inspectAtifBytes(bytes), runId: "same-run", attemptId: name, manifestDigest: `sha256:${"0".repeat(64)}` })).v2;
    for (const endpoint of ["callEventIds", "resultEventIds"] as const) {
      const actual = imported.dataset.operations.filter((operation) => operation.identity.kind === "tool" && operation[endpoint].length), own = native.dataset.operations.filter((operation) => operation.identity.kind === "tool" && operation[endpoint].length);
      assert.equal(actual.length, expected); assert.equal(own.length, expected);
      assert.deepEqual(actual.map(({ identity }) => identity.nativeId).sort(), own.map(({ identity }) => identity.nativeId).sort());
      const names = new Map(own.map((operation) => [operation.identity.nativeId, operation.toolName]));
      for (const operation of actual) assert.deepEqual(operation.toolName, names.get(operation.identity.nativeId));
    }
    const progressOnly = native.dataset.operations.filter(({ identity, callEventIds, resultEventIds }) => identity.kind === "tool" && !callEventIds.length && !resultEventIds.length);
    assert.equal(progressOnly.length, extra);
    const importedIds = new Set(imported.dataset.operations.map(({ identity }) => identity.nativeId));
    assert.ok(progressOnly.every(({ identity }) => !importedIds.has(identity.nativeId)));
  }
});

test("retained v1 imports reopen without editing their source or admission receipts", { skip: !root }, async () => {
  const { readImportedBehaviorEvidence } = await import("../src/atif-import.js");
  const { readImportedBehaviorEvidenceV2 } = await import("../src/atif-v2.js");
  const imports = json(join(root!, "compatibility-imports.json"));
  assert.ok(imports.length >= 3);
  for (const source of imports) {
    const path = join(source.root, "manifest.json"), before = readFileSync(path);
    assert.equal(sha(before), source.manifestSha256);
    assert.equal(sha(readFileSync(join(source.root, "trajectory.json"))), source.sourceSha256);
    assert.ok((await readImportedBehaviorEvidence(source.root)).dataset.events.length > 0);
    const evidence = await readImportedBehaviorEvidenceV2(source.root);
    assert.ok(evidence.dataset.events.length > 0); assert.equal(evidence.interpretationRevision?.changed, true);
    assert.deepEqual(readFileSync(path), before);
  }
});
