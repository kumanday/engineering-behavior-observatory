import { runAgentSdkSemanticJudge, type SemanticJudgeRequest } from "../src/semantic-judge.js";
import { createRetainedStructuralObservationSet } from "../src/structural-observations.js";
import { probeClaudeAgentSdkCapabilities } from "../src/agent-sdk.js";
import { main } from "../src/cli.js";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectHarborTrial, importHarborTrial, readHarborCapture, HARBOR_IMPORT_LIMITS } from "../src/harbor-import.js";
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
    const another = (await inspectHarborTrial({ directory: copy, namespace: "another-source", pythonExecutable: python })).inspection.execution!;
    assert.notEqual(another.id, first.inspection.execution!.id);
    assert.notEqual(another.attemptId, first.inspection.execution!.attemptId);
    assert.notEqual(another.runId, first.inspection.execution!.runId);
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


test("descendant trajectory changes create capture revisions and preserve earlier evidence", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const source = fixture(temp.root); mkdirSync(join(source.directory, "agent/child"));
    const child = join(source.directory, "agent/child/trajectory.json"); writeFileSync(child, '{"synthetic":1}');
    const options = { directory: source.directory, store: join(temp.root, "store"), namespace: "synthetic-source", producer, pythonExecutable: python };
    const first = await importHarborTrial(options); writeFileSync(child, '{"synthetic":2}'); const second = await importHarborTrial(options);
    assert.equal(first.status, "imported"); assert.equal(second.status, "imported");
    if (first.status !== "imported" || second.status !== "imported") return;
    assert.notEqual(first.binding.captureRevision, second.binding.captureRevision);
    assert.equal(first.inspection.execution!.id, second.inspection.execution!.id);
    readHarborCapture(options.store, first.binding.captureRevision, first.inspection.snapshotDigest);
  } finally { temp.cleanup(); }
});

test("refreshed original assessments retain selectable membership contexts for the same regrade", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const original = fixture(temp.root), regrade = fixture(temp.root, "regrade", ids[1]);
    regrade.result.config.source_trial = { action: "regrade", type: "hub", trial_id: ids[0] }; save(regrade.directory, regrade.result);
    const options = { directory: regrade.directory, originals: [{ sourceReference: ids[0]!, directory: original.directory }], store: join(temp.root, "store"), namespace: "synthetic-source", producer, pythonExecutable: python };
    const first = await importHarborTrial(options);
    original.result.verifier_result.rewards.reward = 1; save(original.directory, original.result);
    const second = await importHarborTrial(options);
    assert.equal(first.status, "imported"); assert.equal(second.status, "imported");
    if (first.status !== "imported" || second.status !== "imported") return;
    assert.equal(first.binding.captureRevision, second.binding.captureRevision); assert.equal(second.reused, true);
    assert.notEqual(first.inspectionDigest, second.inspectionDigest);
    assert.throws(() => readHarborCapture(options.store, second.binding.captureRevision, second.inspection.snapshotDigest), /select an inspection digest/u);
    readHarborCapture(options.store, first.binding.captureRevision, first.inspection.snapshotDigest, first.inspectionDigest);
    readHarborCapture(options.store, second.binding.captureRevision, second.inspection.snapshotDigest, second.inspectionDigest);
  } finally { temp.cleanup(); }
});

test("interrupted staged source writes remain retained and a retry can finish admission", { skip: !python }, async () => {
  const temp = temporary(), originalWrite = fs.writeFileSync;
  try {
    const source = fixture(temp.root), store = join(temp.root, "store"); let failed = false;
    fs.writeFileSync = ((path: fs.PathOrFileDescriptor, data: any, options: any) => {
      if (!failed && String(path).includes("pending-writes")) {
        failed = true; originalWrite(path, Buffer.from(data).subarray(0, 5), options);
        throw Object.assign(new Error("Synthetic interrupted write"), { code: "ENOSPC" });
      }
      return originalWrite(path, data, options);
    }) as typeof fs.writeFileSync; syncBuiltinESMExports();
    const options = { directory: source.directory, store, namespace: "synthetic-source", producer, pythonExecutable: python };
    await assert.rejects(importHarborTrial(options), /Synthetic interrupted write/u);
    const retained = readdirSync(join(store, "pending-writes")); assert.equal(retained.length, 1);
    const retry = await importHarborTrial(options); assert.equal(retry.status, "imported");
    assert.deepEqual(readdirSync(join(store, "pending-writes")), retained);
    assert.equal(readFileSync(join(store, "pending-writes", retained[0]!, "bytes")).length, 5);
  } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); temp.cleanup(); }
});


test("root trial and exception logs distinguish retained incomplete failures", async () => {
  const temp = temporary();
  try {
    const directory = join(temp.root, "failure"); mkdirSync(directory);
    writeFileSync(join(directory, "trial.log"), "Synthetic startup failure A"); writeFileSync(join(directory, "exception.txt"), "Synthetic exception A");
    const first = await inspect(directory); writeFileSync(join(directory, "exception.txt"), "Synthetic exception B");
    const second = await inspect(directory);
    assert.equal(first.inspection.status, "inspect-only");
    assert.deepEqual(first.inspection.files.map(({ path }) => path), ["exception.txt", "trial.log"]);
    assert.notEqual(first.inspection.snapshotDigest, second.inspection.snapshotDigest);
  } finally { temp.cleanup(); }
});

test("admitted inventories larger than four MiB remain readable under the shared context limit", { skip: !python }, async () => {
  const temp = temporary(), store = mkdtempSync("/tmp/ebo-wide-");
  try {
    const source = fixture(temp.root);
    const nested = join(source.directory, "agent", ...Array.from({ length: 4 }, () => "d".repeat(190))); mkdirSync(nested, { recursive: true });
    for (let index = 0; index < 4000; index++) writeFileSync(join(nested, `${String(index).padStart(5, "0")}-${"f".repeat(104)}`), "");
    const admitted = await importHarborTrial({ directory: source.directory, store, namespace: "synthetic-source", producer, pythonExecutable: python });
    assert.equal(admitted.status, "imported"); if (admitted.status !== "imported") return;
    assert.ok(readFileSync(join(admitted.snapshot, "inventory.json")).length > 4 * 1024 * 1024);
    assert.equal(readHarborCapture(store, admitted.binding.captureRevision, admitted.inspection.snapshotDigest).inspection.status, "eligible");
  } finally { temp.cleanup(); rmSync(store, { recursive: true, force: true }); }
});


test("the Harbor CLI returns stored capture and context identities usable for readback", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const source = fixture(temp.root), store = join(temp.root, "store"), output: string[] = [];
    assert.equal(await main(["atif", "import-harbor", source.directory, store, "--namespace", "synthetic-source", "--profile", listAtifProducerProfiles()[0]!.id, "--python", python!], (text) => output.push(text)), 0);
    const receipt = JSON.parse(output.join(""));
    assert.notEqual(receipt.captureRevision, receipt.sourceCaptureDigest);
    assert.match(receipt.inspectionDigest, /^sha256:/u);
    assert.equal(readHarborCapture(store, receipt.captureRevision, receipt.snapshotDigest, receipt.inspectionDigest).inspection.status, "eligible");
  } finally { temp.cleanup(); }
});


test("lineage traversal shares one source byte budget instead of multiplying limits per original", { skip: !python }, async () => {
  const temp = temporary(), limit = HARBOR_IMPORT_LIMITS.totalBytes;
  try {
    const original = fixture(temp.root), regrade = fixture(temp.root, "regrade", ids[1]);
    regrade.result.config.source_trial = { action: "regrade", type: "hub", trial_id: ids[0] }; save(regrade.directory, regrade.result);
    const one = await inspect(original.directory), other = await inspect(regrade.directory);
    const maximum = Math.max(...[one, other].map(({ inspection }) => inspection.files.reduce((sum, file) => sum + file.bytes, 0)));
    (HARBOR_IMPORT_LIMITS as unknown as { totalBytes: number }).totalBytes = maximum + 16;
    await assert.rejects(inspect(regrade.directory, { originals: [{ sourceReference: ids[0], directory: original.directory }] }), /byte\/file limits|byte limit/u);
  } finally { (HARBOR_IMPORT_LIMITS as unknown as { totalBytes: number }).totalBytes = limit; temp.cleanup(); }
});


test("Harbor-only executed model aliases reach retained semantic blinding", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const source = fixture(temp.root), alias = "provider/actual-model";
    source.result.config.agent.model_name = alias; source.result.agent_info.model_info.name = alias; save(source.directory, source.result);
    const trajectoryPath = join(source.directory, "agent/trajectory.json");
    const trajectory = JSON.parse(readFileSync(trajectoryPath, "utf8")); trajectory.steps.at(-1).message = `${alias} visible report`; writeFileSync(trajectoryPath, JSON.stringify(trajectory));
    const imported = await importHarborTrial({ directory: source.directory, store: join(temp.root, "store"), namespace: "synthetic-source", producer, pythonExecutable: python });
    assert.equal(imported.status, "imported"); if (imported.status !== "imported") return;
    const evidence = await readImportedBehaviorEvidence(imported.bundleRoot); assert.ok(evidence.modelAliases!.includes(alias));
    const observations = await createRetainedStructuralObservationSet(imported.bundleRoot);
    const event = evidence.dataset.events.findLast(({ family, actor }) => family === "message" && actor.kind === "model")!;
    const request: SemanticJudgeRequest = { schemaVersion: "ebo.semantic-judge-request/v1", id: "alias", behavior: { vocabularyVersion: "1.0.0", categoryId: "verification-completion", dimensionId: "verification-completion" },
      rubric: { id: "r", version: "1", instructions: "Synthetic blinding check." }, evaluator: { provider: "anthropic", model: "synthetic-judge", effort: "low" },
      selection: { eventIds: [event.id], structuralObservationIds: [], includeOutcomeObservations: false },
      limits: { maxEvidenceItems: 8, maxRecordChars: 8000, maxInputChars: 32000, maxOutputChars: 8192, maxCitations: 4, maxWallClockMs: 5000, maxTurns: 1 }, blinding: { evaluatedModelIdentity: "redact" } };
    let called = false;
    await runAgentSdkSemanticJudge({ bundleRoot: imported.bundleRoot, outputRoot: join(temp.root, "judge"), observations, request,
      backend: { id: "claude-agent-sdk", version: probeClaudeAgentSdkCapabilities().sdkVersion, run: async (prompt) => {
        called = true; assert.equal(prompt.includes(alias), false); assert.match(prompt, /visible report/u);
        return { status: "failed", kind: "provider", message: "Synthetic backend; no model call", raw: {} };
      } } });
    assert.equal(called, true);
  } finally { temp.cleanup(); }
});

test("a backfilled regrade can resolve its original executor without an original ATIF document", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const original = fixture(temp.root), regrade = fixture(temp.root, "regrade", ids[1]);
    rmSync(join(original.directory, "agent/trajectory.json"));
    regrade.result.config.source_trial = { action: "regrade", type: "hub", trial_id: ids[0] }; save(regrade.directory, regrade.result);
    const options = { directory: regrade.directory, store: join(temp.root, "store"), namespace: "synthetic-source", producer, pythonExecutable: python,
      originals: [{ sourceReference: ids[0]!, directory: original.directory }] };
    const imported = await importHarborTrial(options); assert.equal(imported.status, "imported"); if (imported.status !== "imported") return;
    assert.equal(imported.inspection.execution!.originalTrialId, ids[0]);
    assert.equal(imported.inspection.assessment!.kind, "regrade");
    readHarborCapture(options.store, imported.binding.captureRevision, imported.inspection.snapshotDigest, imported.inspectionDigest);
  } finally { temp.cleanup(); }
});

test("Harbor CLI exit status distinguishes rejected admission from eligible context", { skip: !python }, async () => {
  const temp = temporary();
  try {
    const source = fixture(temp.root), store = join(temp.root, "store");
    const flags = ["--namespace", "synthetic-source", "--profile", listAtifProducerProfiles()[0]!.id, "--python", python!];
    const invoke = async (action: string) => {
      const output: string[] = [];
      const code = await main(["atif", action, source.directory, ...(action === "import-harbor" ? [store] : []), ...flags], (text) => output.push(text));
      return { code, receipt: JSON.parse(output.join("")) };
    };
    const first = await invoke("import-harbor");
    assert.equal(first.code, 0); assert.equal(first.receipt.status, "imported"); assert.equal(first.receipt.reused, false);
    const reused = await invoke("import-harbor");
    assert.equal(reused.code, 0); assert.equal(reused.receipt.status, "imported"); assert.equal(reused.receipt.reused, true);
    const path = join(source.directory, "agent/trajectory.json"), document = JSON.parse(readFileSync(path, "utf8"));
    document.steps = "malformed"; writeFileSync(path, JSON.stringify(document));
    const inspected = await invoke("inspect-harbor");
    assert.equal(inspected.code, 0); assert.equal(inspected.receipt.status, "eligible");
    const rejected = await invoke("import-harbor");
    assert.equal(rejected.receipt.status, "inspect-only"); assert.equal(rejected.code, 1);
  } finally { temp.cleanup(); }
});
