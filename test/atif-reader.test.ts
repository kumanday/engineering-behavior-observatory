import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ATIF_LIMITS, ATIF_VERSION_FEATURES, atifPointerValue, inspectAtifBytes, readAtifFile, type AtifObject } from "../src/atif-reader.js";
import { digestMetadata, validateArtifact } from "../src/artifacts.js";
import { main } from "../src/cli.js";

const fixture = (version = "ATIF-v1.7"): AtifObject => ({ schema_version: version, session_id: "same-run",
  agent: { name: "synthetic", version: "fixture-1" }, steps: [{ step_id: 1, source: "agent", message: "Synthetic message." }] });
const inspect = (document: unknown) => inspectAtifBytes(Buffer.from(JSON.stringify(document)));
const python = process.env.EBO_ATIF_TEST_PYTHON;
function temporary() { const root = mkdtempSync(join(tmpdir(), "ebo-atif-reader-")); return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }; }

test("ATIF inspection recognizes every admitted version without claiming behavior or capture qualification", () => {
  for (const version of Object.keys(ATIF_VERSION_FEATURES)) {
    const { inspection } = inspect(fixture(version));
    assert.equal(inspection.versionPolicy.status, "supported");
    assert.equal(inspection.structural.status, "valid");
    assert.equal(inspection.fieldCoverage.declaredInferenceFields, undefined);
    assert.deepEqual(validateArtifact("inspection", inspection), []);
    assert.equal("qualification" in inspection, false);
    assert.equal("observations" in inspection, false);
  }
});

test("feature policy rejects relabelled steps, copied context, multimodal and audio fields separately", () => {
  const relabelled = fixture("ATIF-v1.2");
  (relabelled.steps as AtifObject[])[0]!.llm_call_count = 1;
  assert.equal(inspect(relabelled).inspection.versionPolicy.status, "inconsistent");
  const copied = fixture("ATIF-v1.4");
  (copied.steps as AtifObject[])[0]!.is_copied_context = false;
  assert.equal(inspect(copied).inspection.versionPolicy.status, "inconsistent");
  const media = fixture("ATIF-v1.5");
  (media.steps as AtifObject[])[0]!.message = [{ type: "image", source: { media_type: "image/png", path: "image.png" } }];
  assert.equal(inspect(media).inspection.versionPolicy.status, "inconsistent");
  media.schema_version = "ATIF-v1.7";
  (media.steps as AtifObject[])[0]!.message = [{ type: "audio", source: { media_type: "audio/wav", path: "audio.wav" } }];
  assert.equal(inspect(media).inspection.versionPolicy.status, "inconsistent");
  media.schema_version = "ATIF-v1.8";
  assert.equal(inspect(media).inspection.versionPolicy.status, "supported");
});

test("token IDs, tool definitions and call extensions respect their introduction versions", () => {
  for (const [version, field, minimum] of [["ATIF-v1.2", "completion_token_ids", "ATIF-v1.3"], ["ATIF-v1.3", "prompt_token_ids", "ATIF-v1.4"]]) {
    const source = fixture(version);
    (source.steps as AtifObject[])[0]!.metrics = { [field!]: [1] };
    assert.equal(inspect(source).inspection.versionPolicy.status, "inconsistent");
    source.schema_version = minimum;
    assert.equal(inspect(source).inspection.versionPolicy.status, "supported");
  }
  const definitions = fixture("ATIF-v1.4"); (definitions.agent as AtifObject).tool_definitions = [];
  assert.equal(inspect(definitions).inspection.versionPolicy.status, "inconsistent");
  definitions.schema_version = "ATIF-v1.5";
  assert.equal(inspect(definitions).inspection.versionPolicy.status, "supported");
  const extension = fixture("ATIF-v1.6");
  (extension.steps as AtifObject[])[0]!.tool_calls = [{ tool_call_id: "a", function_name: "synthetic", arguments: {}, extra: {} }];
  assert.equal(inspect(extension).inspection.versionPolicy.status, "inconsistent");
  extension.schema_version = "ATIF-v1.7";
  assert.equal(inspect(extension).inspection.versionPolicy.status, "supported");
});

test("pointer inventory binds raw bytes separately from canonical nested values", () => {
  const parent = fixture(), child = { ...fixture(), trajectory_id: "child" };
  parent.subagent_trajectories = [child];
  (parent.steps as AtifObject[])[0]!.observation = { results: [{ subagent_trajectory_ref: [{ trajectory_id: "child", session_id: "same-run" }] }] };
  const { inspection, document } = inspect(parent);
  const pointer = "#/subagent_trajectories/0/steps/0";
  const record = inspection.records.find((value) => value.pointer === pointer)!;
  assert.equal(record.digest, `sha256:${digestMetadata(atifPointerValue(document, pointer)).value}`);
  assert.equal(record.sourceDigest, inspection.source.digest);
  assert.notEqual(record.digest, record.sourceDigest);
  assert.equal(inspection.references[0]!.target, "#/subagent_trajectories/0");
  assert.equal(inspection.references[0]!.status, "retained");
  assert.equal(atifPointerValue(document, "#/steps/00"), undefined);
  assert.equal(atifPointerValue(document, "#/constructor/prototype"), undefined);
  assert.equal(atifPointerValue(document, "#/steps/~2"), undefined);
});

test("many embedded references reuse the retained child pointer digest", () => {
  const source = fixture(), child: AtifObject = { ...fixture(), trajectory_id: "shared-child" };
  (child.steps as AtifObject[])[0]!.message = "x".repeat(512 * 1024);
  source.subagent_trajectories = [child];
  (source.steps as AtifObject[])[0]!.observation = { results: [{ subagent_trajectory_ref: Array.from({ length: 10_000 }, () => ({ trajectory_id: "shared-child" })) }] };
  const { inspection } = inspect(source);
  assert.equal(inspection.versionPolicy.status, "supported");
  assert.equal(inspection.references.length, 10_000);
  const digest = inspection.records.find(({ pointer }) => pointer === "#/subagent_trajectories/0")!.digest;
  assert.ok(inspection.references.every((reference) => reference.digest === digest && reference.status === "retained"));
});

test("unsupported labels and duplicate keys preserve source identity with explicit diagnostics", () => {
  const unsupported = inspect(fixture("ATIF-v9.9")).inspection;
  assert.equal(unsupported.versionPolicy.status, "unsupported");
  assert.match(unsupported.source.digest!, /^sha256:/u);
  const duplicate = inspectAtifBytes(Buffer.from('{"schema_version":"ATIF-v1.7","schema_version":"ATIF-v1.2"}')).inspection;
  assert.equal(duplicate.versionPolicy.diagnostics[0]!.code, "DUPLICATE_JSON_KEY");
  assert.equal(duplicate.records.length, 0);
  for (const version of ["__proto__", "constructor", "toString"]) assert.equal(inspect(fixture(version)).inspection.versionPolicy.status, "unsupported");
});

test("unsafe integer evidence is rejected before creating potentially aliased pointer digests", () => {
  const source = JSON.stringify({ ...fixture(), extra: { numeric: "SENTINEL" } });
  const receipts = ["9007199254740992", "9007199254740993"].map((literal) =>
    inspectAtifBytes(Buffer.from(source.replace('"SENTINEL"', literal))).inspection);
  for (const receipt of receipts) {
    assert.equal(receipt.versionPolicy.diagnostics[0]!.code, "UNSAFE_JSON_INTEGER");
    assert.equal(receipt.records.length, 0);
  }
  assert.notEqual(receipts[0]!.source.digest, receipts[1]!.source.digest);
  assert.equal(inspectAtifBytes(Buffer.from(source.replace('"SENTINEL"', "1e400"))).inspection.versionPolicy.diagnostics[0]!.code, "NONFINITE_JSON_NUMBER");
  assert.equal(inspect({ ...fixture(), extra: { numeric: "9007199254740993" } }).document!.extra !== undefined, true);
});

test("step, token-array and nesting limits fail explicitly", () => {
  const step = fixture();
  (step.steps as AtifObject[])[0]!.message = "x".repeat(ATIF_LIMITS.stepBytes);
  assert.equal(inspect(step).inspection.versionPolicy.diagnostics[0]!.code, "STEP_BYTE_LIMIT");
  const tokens = fixture();
  (tokens.steps as AtifObject[])[0]!.metrics = { prompt_token_ids: Array(ATIF_LIMITS.tokenArrayItems + 1).fill(0) };
  assert.equal(inspect(tokens).inspection.versionPolicy.diagnostics[0]!.code, "TOKEN_ARRAY_LIMIT");
  let nested: unknown = {};
  for (let depth = 0; depth < ATIF_LIMITS.depth + 1; depth += 1) nested = { nested };
  assert.equal(inspect(nested).inspection.versionPolicy.diagnostics[0]!.code, "DOCUMENT_COMPLEXITY_LIMIT");
  assert.equal(inspect({ extra: { wide: Array(ATIF_LIMITS.nodes + 1).fill(0) } }).inspection.versionPolicy.diagnostics[0]!.code, "DOCUMENT_COMPLEXITY_LIMIT");
});

test("legacy session-only references stay inventoried and unavailable before validation", () => {
  const source = fixture("ATIF-v1.6");
  (source.steps as AtifObject[])[0]!.observation = { results: [{ subagent_trajectory_ref: [{ session_id: "legacy-child" }] }] };
  const { inspection } = inspect(source);
  assert.equal(inspection.versionPolicy.status, "supported");
  assert.equal(inspection.references[0]!.kind, "session-only");
  assert.equal(inspection.references[0]!.status, "unavailable");
  assert.ok(inspection.limitations.includes("EXTERNAL_REFERENCE_UNAVAILABLE"));
});

test("repeated retained media is read once per target and unique targets obey the remaining budget", async () => {
  const { root, cleanup } = temporary();
  try {
    const targets = Array.from({ length: 5 }, (_, index) => `image-${index}.png`);
    for (const target of targets) { const path = join(root, target); writeFileSync(path, ""); truncateSync(path, ATIF_LIMITS.attachmentBytes); }
    const source = fixture("ATIF-v1.8");
    const paths = [targets[0]!, targets[0]!, targets[0]!, targets[0]!, targets[0]!, targets[0]!, ...targets.slice(1)];
    (source.steps as AtifObject[])[0]!.message = paths.map((path) => ({ type: "image", source: { media_type: "image/png", path } }));
    const path = join(root, "trajectory.json"); writeFileSync(path, JSON.stringify(source));
    const { inspection } = await readAtifFile(path, { pythonExecutable: "/nonexistent-python", retainedFiles: targets });
    assert.ok(inspection.references.slice(0, 9).every(({ status }) => status === "retained"));
    assert.equal(inspection.references[9]!.reason, "ATTACHMENT_TOTAL_BYTE_LIMIT");
    assert.deepEqual(validateArtifact("inspection", inspection), []);
  } finally { cleanup(); }
});

test("admitted dot-segment aliases share one retained attachment budget", async () => {
  const { root, cleanup } = temporary();
  try {
    const file = join(root, "image.png"); writeFileSync(file, ""); truncateSync(file, ATIF_LIMITS.attachmentBytes);
    const aliases = ["image.png", "./image.png", "././image.png", "./././image.png", "././././image.png"];
    const source = fixture("ATIF-v1.8");
    (source.steps as AtifObject[])[0]!.message = aliases.map((path) => ({ type: "image", source: { media_type: "image/png", path } }));
    const path = join(root, "trajectory.json"); writeFileSync(path, JSON.stringify(source));
    const { inspection } = await readAtifFile(path, { pythonExecutable: "/nonexistent-python", retainedFiles: aliases });
    assert.ok(inspection.references.every(({ status }) => status === "retained"));
    assert.deepEqual(inspection.references.map(({ target }) => target), aliases);
  } finally { cleanup(); }
});

test("media inventory reads only ATIF content fields and preserves pre-v1.7 file references", () => {
  const document = fixture("ATIF-v1.2");
  (document.steps as AtifObject[])[0]!.tool_calls = [{ tool_call_id: "call", function_name: "read", arguments: {
    path: "private.png", media_type: "image/png", trajectory_path: "not-a-dependency.json", type: "audio" } }];
  (document.steps as AtifObject[])[0]!.observation = { results: [{ subagent_trajectory_ref: [{ session_id: "child-run", trajectory_path: "child.json" }] }] };
  const { inspection } = inspect(document);
  assert.equal(inspection.versionPolicy.status, "supported");
  assert.equal(inspection.references.length, 1);
  assert.equal(inspection.references[0]!.target, "child.json");
});

test("references use explicit retained-file admission and reject traversal, URLs and symlink parents", async () => {
  const { root, cleanup } = temporary();
  try {
    const source = fixture("ATIF-v1.8");
    const targets = ["image.png", "../private.png", "/private.png", "https://example.invalid/image.png", "linked/image.png", "missing.png"];
    (source.steps as AtifObject[])[0]!.message = targets.map((path) => ({ type: "image", source: { media_type: "image/png", path } }));
    const path = join(root, "trajectory.json"); writeFileSync(path, JSON.stringify(source));
    mkdirSync(join(root, "images")); writeFileSync(join(root, "images/image.png"), "synthetic bytes");
    writeFileSync(join(root, "image.png"), "synthetic bytes"); symlinkSync(join(root, "images"), join(root, "linked"));
    const unadmitted = await readAtifFile(path, { pythonExecutable: "/nonexistent-python" });
    assert.ok(unadmitted.inspection.references.every(({ status }) => status === "unavailable"));
    const result = await readAtifFile(path, { retainedFiles: targets, pythonExecutable: "/nonexistent-python" });
    assert.equal(result.inspection.references[0]!.status, "retained");
    assert.ok(result.inspection.references.slice(1).every(({ status }) => status === "unavailable"));
    assert.deepEqual(validateArtifact("inspection", result.inspection), []);
    const oversized = join(root, "oversized.json"); writeFileSync(oversized, ""); truncateSync(oversized, ATIF_LIMITS.documentBytes + 1);
    const rejected = await readAtifFile(oversized);
    assert.equal(rejected.document, undefined);
    assert.equal(rejected.inspection.source.bytes, ATIF_LIMITS.documentBytes + 1);
  } finally { cleanup(); }
});

test("optional installed Harbor cross-check records its version independently of EBO structural validation", { skip: python === undefined }, async () => {
  const { root, cleanup } = temporary();
  try {
    const path = join(root, "trajectory.json");
    for (const version of Object.keys(ATIF_VERSION_FEATURES)) {
      writeFileSync(path, JSON.stringify(fixture(version)));
      const { inspection } = await readAtifFile(path, { pythonExecutable: python });
      assert.equal(inspection.structural.status, "valid", version);
      assert.match(inspection.harborCrossCheck!.modelDigest!, /^sha256:[0-9a-f]{64}$/u);
    }
    const relabelled = fixture("ATIF-v1.2"); (relabelled.steps as AtifObject[])[0]!.llm_call_count = 1;
    writeFileSync(path, JSON.stringify(relabelled));
    const result = await readAtifFile(path, { pythonExecutable: python });
    assert.equal(result.inspection.structural.status, "valid");
    assert.equal(result.inspection.versionPolicy.status, "inconsistent");
    const invalid = fixture(); (invalid.steps as AtifObject[])[0]!.step_id = 2;
    writeFileSync(path, JSON.stringify(invalid));
    assert.equal((await readAtifFile(path, { pythonExecutable: python })).inspection.structural.status, "invalid");
    assert.equal(await main(["atif", "inspect", path, "--python", python!], () => undefined), 1);
    writeFileSync(path, JSON.stringify(fixture()));
    assert.equal(await main(["atif", "inspect", path, "--python", python!], () => undefined), 0);
    const legacy = fixture("ATIF-v1.6");
    (legacy.steps as AtifObject[])[0]!.observation = { results: [{ subagent_trajectory_ref: [{ session_id: "legacy-child" }] }] };
    writeFileSync(path, JSON.stringify(legacy));
    const compatible = await readAtifFile(path, { pythonExecutable: python });
    assert.equal(compatible.inspection.structural.status, "valid");
    assert.equal(compatible.inspection.harborCrossCheck!.nativeModelStatus, "invalid");
    assert.equal(compatible.inspection.harborCrossCheck!.compatibilityDiagnostics!.length, 1);
    assert.equal(compatible.inspection.references[0]!.status, "unavailable");
    assert.equal((compatible.document!.steps as AtifObject[])[0]!.observation !== undefined, true);
    assert.equal(JSON.stringify(compatible.document).includes("ebo-validation-unresolved"), false, "validation placeholders never enter retained source data");
    assert.deepEqual(validateArtifact("legacy inspection", compatible.inspection), []);
    (legacy.steps as AtifObject[])[0]!.step_id = 2;
    writeFileSync(path, JSON.stringify(legacy));
    assert.equal((await readAtifFile(path, { pythonExecutable: python })).inspection.structural.status, "invalid", "legacy handling preserves the remaining structural checks");
    for (const malformed of [{ ...fixture("ATIF-v1.6"), steps: 1 }, { ...fixture(), subagent_trajectories: 1 }]) {
      writeFileSync(path, JSON.stringify(malformed));
      const { inspection } = await readAtifFile(path, { pythonExecutable: python });
      assert.equal(inspection.structural.status, "invalid");
      assert.match(inspection.harborCrossCheck!.modelDigest!, /^sha256:/u);
      assert.equal(inspection.harborCrossCheck!.diagnostics[0]!.code, "HARBOR_STRUCTURAL_INVALID");
    }
    const many = fixture("ATIF-v1.6");
    (many.steps as AtifObject[])[0]!.observation = { results: [{ subagent_trajectory_ref: Array.from({ length: 600 }, (_, index) => ({ session_id: `child-${index}` })) }] };
    writeFileSync(path, JSON.stringify(many));
    const bounded = await readAtifFile(path, { pythonExecutable: python });
    assert.equal(bounded.inspection.structural.status, "valid");
    assert.equal(bounded.inspection.harborCrossCheck!.compatibilityDiagnosticCount, 600);
    assert.equal(bounded.inspection.harborCrossCheck!.compatibilityDiagnostics!.length, 32);
    assert.equal(bounded.inspection.harborCrossCheck!.compatibilityDiagnosticsTruncated, true);
    assert.equal(bounded.inspection.references.length, 600);
    assert.deepEqual(validateArtifact("bounded compatibility receipt", bounded.inspection), []);
    writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(fixture()))]));
    assert.equal((await readAtifFile(path, { pythonExecutable: python })).inspection.structural.status, "valid");
    writeFileSync(path, JSON.stringify({ ...fixture(), ["x".repeat(70_000)]: true }));
    const extended = await readAtifFile(path, { pythonExecutable: python });
    assert.equal(extended.inspection.structural.status, "valid");
    assert.ok(extended.inspection.unmappedFields?.some(({ reason }) => reason === "ATIF_FIELD_UNRECOGNIZED"));
  } finally { cleanup(); }
});


test("a second installed Harbor version remains an optional cross-check", { skip: !process.env.EBO_ATIF_NEXT_PYTHON }, async () => {
  const { root, cleanup } = temporary();
  try {
    const path = join(root, "trajectory.json");writeFileSync(path, JSON.stringify(fixture()));
    const read = await readAtifFile(path, { pythonExecutable: process.env.EBO_ATIF_NEXT_PYTHON });
    assert.equal(read.inspection.structural.validator, "ebo");assert.equal(read.inspection.structural.status, "valid");
    assert.equal(read.inspection.harborCrossCheck!.version, "0.25.0");assert.equal(read.inspection.harborCrossCheck!.status, "valid");
  } finally { cleanup(); }
});


test("an unfamiliar installed validator version and its disagreement never replace EBO validation", async () => {
  const { root, cleanup } = temporary();
  try {
    const path = join(root, "trajectory.json"), executable = join(root, "validator");
    writeFileSync(path, JSON.stringify(fixture()));
    writeFileSync(executable, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({status:"invalid",version:"9.9.9",modelDigest:"sha256:${"0".repeat(64)}",diagnostics:[{code:"HARBOR_STRUCTURAL_INVALID",pointer:"#"}]})));\n`);
    chmodSync(executable, 0o700);
    const read = await readAtifFile(path, { pythonExecutable: executable });
    assert.equal(read.inspection.structural.status, "valid");assert.equal(read.inspection.structural.validator, "ebo");
    assert.equal(read.inspection.harborCrossCheck!.version, "9.9.9");assert.equal(read.inspection.harborCrossCheck!.status, "invalid");
  } finally { cleanup(); }
});
