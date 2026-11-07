import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectHarborTrial, importHarborTrial, readHarborCapture } from "../src/harbor-import.js";
import { listAtifProducerProfiles } from "../src/atif-profiles.js";
import { readImportedBehaviorEvidence } from "../src/atif-import.js";

const python = process.env.EBO_ATIF_TEST_PYTHON;
const producer = listAtifProducerProfiles()[0]!.producer;
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
type ObjectValue = Record<string, any>;
function temporary() { const root = mkdtempSync(join(tmpdir(), "ebo-harbor-import-")); return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }; }
function fixture(root: string, name = "original", id = ids[0]!) {
  const directory = join(root, name);
  mkdirSync(join(directory, "agent/pi/sessions"), { recursive: true });
  mkdirSync(join(directory, "verifier"));
  const config = { task: { path: "tasks/synthetic" }, agent: { name: "pi", model_name: "synthetic-model" }, source_trial: null as unknown };
  const result = { id, task_name: "synthetic/task", trial_name: "synthetic", trial_uri: "file:///synthetic/trial", task_id: { path: "tasks/synthetic" }, task_checksum: "a".repeat(64), config,
    agent_info: { name: "pi", version: "unknown", model_info: { name: "synthetic-model", provider: "synthetic" } },
    started_at: "2026-11-07T00:00:00Z", finished_at: "2026-11-07T00:01:00Z", verifier_result: { rewards: { reward: 0 } }, exception_info: null as unknown };
  writeFileSync(join(directory, "result.json"), JSON.stringify(result));
  writeFileSync(join(directory, "config.json"), JSON.stringify(config));
  writeFileSync(join(directory, "agent/pi/sessions/session.jsonl"), '{"synthetic":"native-source"}\n');
  cpSync("test/fixtures/atif/pi/parallel-failure-cache-write.atif.json", join(directory, "agent/trajectory.json"));
  writeFileSync(join(directory, "verifier/reward.txt"), "0\n");
  return { directory, result };
}
function save(directory: string, result: ObjectValue) {
  writeFileSync(join(directory, "result.json"), JSON.stringify(result));
  writeFileSync(join(directory, "config.json"), JSON.stringify(result.config));
}
const inspect = (directory: string, extra = {}) => inspectHarborTrial({ directory, namespace: "synthetic-source", pythonExecutable: python, ...extra });

test("missing trial records retain source inventory without manufacturing an execution", async () => {
  const temp = temporary();
  try {
    const source = fixture(temp.root); rmSync(join(source.directory, "result.json"));
    const read = await inspect(source.directory);
    assert.equal(read.inspection.status, "inspect-only");
    assert.ok(read.inspection.diagnostics.includes("TRIAL_RESULT_MISSING"));
    assert.ok(read.inspection.files.some(({ path }) => path === "agent/trajectory.json"));
    assert.equal(read.inspection.execution, undefined);
  } finally { temp.cleanup(); }
});

test("unsupported original references never fetch or follow source paths", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const source = fixture(temp.root); source.result.config.source_trial = { action: "regrade", type: "local", path: "/unlisted/source" }; save(source.directory, source.result);
    const read = await inspect(source.directory);
    assert.equal(read.inspection.status, "inspect-only");
    assert.ok(read.inspection.diagnostics.includes("ORIGINAL_TRIAL_NOT_BOUND"));
    assert.equal(read.inspection.execution, undefined);
  } finally { temp.cleanup(); }
});

test("source namespace and TrialResult UUID define identity independently of source directory location", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const source = fixture(temp.root), copy = join(temp.root, "relocated"); cpSync(source.directory, copy, { recursive: true });
    const first = await inspect(source.directory), second = await inspect(copy);
    assert.equal(first.inspection.status, "eligible");
    assert.equal(first.inspection.structural!.status, "valid");
    assert.deepEqual(first.inspection, second.inspection);
    assert.notEqual((await inspectHarborTrial({ directory: copy, namespace: "another-source", pythonExecutable: python })).inspection.execution!.id, first.inspection.execution!.id);
  } finally { temp.cleanup(); }
});

test("identical Harbor imports are no-ops and preserve imported qualification", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const source = fixture(temp.root), options = { directory: source.directory, store: join(temp.root, "store"), namespace: "synthetic-source", producer, pythonExecutable: python };
    const first = await importHarborTrial(options), second = await importHarborTrial(options);
    assert.equal(first.status, "imported"); assert.equal(second.status, "imported");
    if (first.status !== "imported" || second.status !== "imported") return;
    assert.equal(first.reused, false); assert.equal(second.reused, true);
    assert.equal(first.bundleRoot, second.bundleRoot);
    assert.equal((await readImportedBehaviorEvidence(first.bundleRoot)).capture.qualification, "imported");
    assert.equal(readdirSync(join(options.store, "captures")).length, 1);
    assert.equal(readdirSync(join(options.store, "assessments")).length, 1);
    assert.equal(readdirSync(join(options.store, "pending")).length, 0);
  } finally { temp.cleanup(); }
});

test("trajectory backfills create immutable capture revisions of the same execution", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const source = fixture(temp.root), options = { directory: source.directory, store: join(temp.root, "store"), namespace: "synthetic-source", producer, pythonExecutable: python };
    const first = await importHarborTrial(options);
    const trajectory = JSON.parse(readFileSync(join(source.directory, "agent/trajectory.json"), "utf8")); trajectory.steps[0].message = "Changed retained trajectory";
    writeFileSync(join(source.directory, "agent/trajectory.json"), JSON.stringify(trajectory));
    const second = await importHarborTrial(options);
    assert.equal(first.status, "imported"); assert.equal(second.status, "imported");
    if (first.status !== "imported" || second.status !== "imported") return;
    assert.equal(first.inspection.execution!.id, second.inspection.execution!.id);
    assert.notEqual(first.bundleRoot, second.bundleRoot);
    assert.equal(first.inspection.assessment!.id, second.inspection.assessment!.id);
    assert.equal(existsSync(join(first.bundleRoot, "manifest.json")), true);
  } finally { temp.cleanup(); }
});

test("a proven regrade adds an assessment while reusing its original execution and capture", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const original = fixture(temp.root), regrade = fixture(temp.root, "regrade", ids[1]);
    regrade.result.config.source_trial = { action: "regrade", type: "hub", trial_id: ids[0] };
    regrade.result.verifier_result.rewards.reward = 1; regrade.result.task_checksum = "b".repeat(64); save(regrade.directory, regrade.result);
    const options = { store: join(temp.root, "store"), namespace: "synthetic-source", producer, pythonExecutable: python };
    const first = await importHarborTrial({ ...options, directory: original.directory });
    const second = await importHarborTrial({ ...options, directory: regrade.directory, originals: [{ sourceReference: ids[0]!, directory: original.directory }] });
    assert.equal(first.status, "imported"); assert.equal(second.status, "imported");
    if (first.status !== "imported" || second.status !== "imported") return;
    assert.equal(first.bundleRoot, second.bundleRoot); assert.equal(second.reused, true);
    assert.equal(second.inspection.execution!.originalTrialId, ids[0]);
    assert.equal(second.inspection.execution!.taskChecksum, "a".repeat(64));
    assert.equal(second.inspection.assessment!.taskChecksum, "b".repeat(64));
    assert.equal(second.inspection.assessment!.kind, "regrade");
    assert.equal(readHarborCapture(options.store, second.binding.captureRevision, second.inspection.snapshotDigest).assessment.kind, "regrade");
    assert.equal(readdirSync(join(options.store, "assessments")).length, 2);
  } finally { temp.cleanup(); }
});

test("unproven, cyclic and conflicting regrades stay inspect-only", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const original = fixture(temp.root), regrade = fixture(temp.root, "regrade", ids[1]);
    regrade.result.config.source_trial = { action: "regrade", type: "hub", trial_id: ids[0] }; save(regrade.directory, regrade.result);
    writeFileSync(join(regrade.directory, "agent/pi/sessions/session.jsonl"), "different-native-source\n");
    const conflict = await inspect(regrade.directory, { originals: [{ sourceReference: ids[0], directory: original.directory }] });
    assert.equal(conflict.inspection.status, "inspect-only");
    assert.ok(conflict.inspection.diagnostics.includes("REGRADE_EXECUTION_EVIDENCE_CONFLICT"));
    original.result.config.source_trial = { action: "regrade", type: "hub", trial_id: ids[1] }; save(original.directory, original.result);
    const cyclic = await inspect(regrade.directory, { originals: [{ sourceReference: ids[0], directory: original.directory }, { sourceReference: ids[1], directory: regrade.directory }] });
    assert.equal(cyclic.inspection.status, "inspect-only");
    assert.equal(cyclic.inspection.execution, undefined);
  } finally { temp.cleanup(); }
});

test("conflicting reuse of a trial UUID cannot overwrite the admitted execution", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const source = fixture(temp.root), options = { directory: source.directory, store: join(temp.root, "store"), namespace: "synthetic-source", producer, pythonExecutable: python };
    const first = await importHarborTrial(options); assert.equal(first.status, "imported");
    source.result.started_at = "2026-11-08T00:00:00Z"; save(source.directory, source.result);
    await assert.rejects(importHarborTrial(options), /identity or source bytes conflict/u);
    assert.equal(readdirSync(join(options.store, "executions")).length, 1);
  } finally { temp.cleanup(); }
});

test("owned adapter trials require an owned binding and source links are never traversed", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const source = fixture(temp.root); (source.result.config.agent as ObjectValue).import_path = "ebo_native.worker:Agent"; save(source.directory, source.result);
    assert.ok((await inspect(source.directory)).inspection.diagnostics.includes("OWNED_TRIAL_BINDING_REQUIRED"));
    symlinkSync("/unlisted/private", join(source.directory, "agent/linked"));
    await assert.rejects(inspect(source.directory), /links are not admitted/u);
  } finally { temp.cleanup(); }
});

test("finished_at does not turn a third-party timeout or arbitrary reward into owned success", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const source = fixture(temp.root);
    source.result.exception_info = { exception_type: "AgentTimeoutError", exception_message: "synthetic timeout", exception_traceback: "synthetic", occurred_at: "2026-11-07T00:00:59Z" };
    source.result.verifier_result.rewards.reward = 0.5; save(source.directory, source.result);
    const read = await inspect(source.directory);
    assert.equal(read.inspection.assessment!.exceptionType, "AgentTimeoutError");
    assert.deepEqual(read.inspection.assessment!.rewards, { reward: 0.5 });
    assert.equal("terminalState" in read.inspection.assessment!, false);
    assert.equal("passed" in read.inspection.assessment!, false);
  } finally { temp.cleanup(); }
});


test("a retained inspect-only regrade can be resolved by adding an explicit original binding", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const original = fixture(temp.root), regrade = fixture(temp.root, "regrade", ids[1]);
    regrade.result.config.source_trial = { action: "regrade", type: "hub", trial_id: ids[0] }; save(regrade.directory, regrade.result);
    const options = { directory: regrade.directory, store: join(temp.root, "store"), namespace: "synthetic-source", producer, pythonExecutable: python };
    const unknown = await importHarborTrial(options);
    assert.equal(unknown.status, "inspect-only");
    const resolved = await importHarborTrial({ ...options, originals: [{ sourceReference: ids[0]!, directory: original.directory }] });
    assert.equal(resolved.status, "imported");
    assert.equal(unknown.inspection.snapshotDigest, resolved.inspection.snapshotDigest);
    assert.ok(readdirSync(join(options.store, "inspections")).length >= 3);
  } finally { temp.cleanup(); }
});


test("Harbor readback binds capture, execution, assessment and retained raw context", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const source = fixture(temp.root), store = join(temp.root, "store");
    const admitted = await importHarborTrial({ directory: source.directory, store, namespace: "synthetic-source", producer, pythonExecutable: python });
    assert.equal(admitted.status, "imported"); if (admitted.status !== "imported") return;
    const capture = admitted.binding.captureRevision, snapshot = admitted.inspection.snapshotDigest;
    const retained = readHarborCapture(store, capture, snapshot);
    assert.equal(retained.inspection.execution!.id, admitted.inspection.execution!.id);
    assert.equal(retained.assessment.authority, "third-party");
    writeFileSync(join(admitted.snapshot, "verifier/reward.txt"), "1\n");
    assert.throws(() => readHarborCapture(store, capture, snapshot), /snapshot is stale/u);
  } finally { temp.cleanup(); }
});

test("Harbor imports reject incompatible ATIF and trial agent identities", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const source = fixture(temp.root); source.result.agent_info.version = "9.0.0";
    const trajectoryPath = join(source.directory, "agent/trajectory.json");
    const trajectory = JSON.parse(readFileSync(trajectoryPath, "utf8")); trajectory.agent.version = "1.2.0";
    writeFileSync(trajectoryPath, JSON.stringify(trajectory)); save(source.directory, source.result);
    assert.ok((await inspect(source.directory)).inspection.diagnostics.includes("ATIF_TRIAL_AGENT_CONFLICT"));
  } finally { temp.cleanup(); }
});


test("retained store links cannot redirect admission or readback", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const source = fixture(temp.root), store = join(temp.root, "store"), outside = join(temp.root, "outside");
    mkdirSync(store); mkdirSync(outside); symlinkSync(outside, join(store, "sources"));
    await assert.rejects(importHarborTrial({ directory: source.directory, store, namespace: "synthetic-source", producer, pythonExecutable: python }), /store links/u);
    assert.deepEqual(readdirSync(outside), []);
    rmSync(join(store, "sources"));
    const admitted = await importHarborTrial({ directory: source.directory, store, namespace: "synthetic-source", producer, pythonExecutable: python });
    assert.equal(admitted.status, "imported"); if (admitted.status !== "imported") return;
    const record = join(store, "bindings", `${admitted.binding.captureRevision.slice(7)}.json`);
    const replacement = join(outside, "binding.json"); cpSync(record, replacement); rmSync(record); symlinkSync(replacement, record);
    assert.throws(() => readHarborCapture(store, admitted.binding.captureRevision, admitted.inspection.snapshotDigest), /store links/u);
  } finally { temp.cleanup(); }
});
