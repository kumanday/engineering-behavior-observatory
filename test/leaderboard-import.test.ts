import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importLeaderboardCohort, readLeaderboardCohort, type LeaderboardCohortRequest } from "../src/leaderboard-import.js";
import { LEADERBOARD_BUCKET, rawHash, readLeaderboardSource, scanImportedFiles, type LeaderboardAcquisition } from "../src/leaderboard-source.js";
import { LEADERBOARD_PUBLIC_POLICY } from "../src/leaderboard-policy.js";
import { listAtifProducerProfiles } from "../src/atif-profiles.js";
const python = process.env.EBO_LEADERBOARD_TEST_PYTHON;
const id = "11111111-1111-4111-8111-111111111111";
const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ebo-leaderboard-import-")), snapshot = join(root, "snapshot"), trial = join(root, "trial"), store = join(root, "store");
  mkdirSync(snapshot); mkdirSync(join(trial, "agent/pi/sessions"), { recursive: true }); mkdirSync(join(trial, "verifier"));
  const config = { task: { path: "tasks/adaptive-rejection-sampler" }, agent: { name: "pi", model_name: "zai-org/GLM-5.3-Flash" }, source_trial: null };
  const result = { id, task_name: "adaptive-rejection-sampler", trial_name: "trial-0", trial_uri: "file:///synthetic/trial", task_id: { path: "tasks/adaptive-rejection-sampler" }, task_checksum: "a".repeat(64), config,
    agent_info: { name: "pi", version: "1.2.0", model_info: { name: "zai-org/GLM-5.3-Flash", provider: "synthetic" } },
    started_at: "2026-11-01T00:00:00Z", finished_at: "2026-11-01T00:01:00Z", verifier_result: { rewards: { reward: 0 } }, exception_info: null };
  write(join(trial, "result.json"), result); write(join(trial, "config.json"), config);
  writeFileSync(join(trial, "agent/pi/sessions/session.jsonl"), '{"synthetic":"source"}\n'); writeFileSync(join(trial, "verifier/reward.txt"), "0\n");
  const trajectory = JSON.parse(readFileSync("test/fixtures/atif/pi/parallel-failure-cache-write.atif.json", "utf8")); trajectory.agent.version = "1.2.0";
  write(join(trial, "agent/trajectory.json"), trajectory);
  const run = { run_id: "full", created_at: "2026-11-01T00:00:00Z", model: "zai-org/GLM-5.3-Flash", provider: "zai-org", reasoning_effort: "low", stage: "full", harness_versions: { pi: "1.2.0" }, benchmark_setups: { "terminal-bench-2.1": { commit: "d49e28f1e4ddd13d289e85a5f312a66750951932", network: null } }, price: { input: 0.15, cached_input: 0.03, output: 0.5 } };
  const fact = { id, trial: "trial-0", task: "adaptive-rejection-sampler", harness: "pi", harness_version: "1.2.0", run_id: "full", benchmark: "terminal-bench-2.1", reused_from: null, reward: 0, exception: null, agent_started: true, meter: { n_calls: 1, last_status: 200 } };
  const metadata = new Map([["runs/full/run.json", Buffer.from(JSON.stringify(run))], ["runs/full/terminal-bench-2.1/trials-0.jsonl", Buffer.from(JSON.stringify(fact) + "\n")]]);
  for (const [path, bytes] of metadata) { mkdirSync(join(snapshot, path, ".."), { recursive: true }); writeFileSync(join(snapshot, path), bytes); }
  const acquisition: LeaderboardAcquisition = { schemaVersion: "ebo.leaderboard-acquisition/v1", source: LEADERBOARD_BUCKET, retrievedAt: "2026-11-07T00:00:00Z", sharing: "restricted", terms: "unstated", attribution: "Synthetic fixtures; source policy by Joël Niklaus / Harness Leaderboard",
    artifacts: [...metadata].map(([path, bytes]) => ({ remotePath: path, localPath: path, sha256: rawHash(bytes).slice(7), bytes: bytes.length, listedXetHash: null, authority: "protected-leaderboard-record" })) };
  write(join(snapshot, "acquisition.json"), acquisition);
  const request: LeaderboardCohortRequest = { schemaVersion: "ebo.leaderboard-cohort-request/v1", policyRevision: LEADERBOARD_PUBLIC_POLICY.revision, snapshotRoot: snapshot, historyCompleteness: "bounded-subset", nativeBindings: [{ factId: id, directory: trial, profileId: listAtifProducerProfiles()[1]!.id }] };
  return { root, store, snapshot, trial, trajectory, acquisition, request, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
test("protected source records remain distinct from agent-writable logs and preserve relocation identity", () => {
  const f = fixture();
  try {
    const first = readLeaderboardSource(f.snapshot); f.acquisition.artifacts.reverse(); write(join(f.snapshot, "acquisition.json"), f.acquisition);
    const second = readLeaderboardSource(f.snapshot);
    assert.equal(first.snapshotDigest, second.snapshotDigest); assert.deepEqual(first.input, second.input);
    f.acquisition.artifacts[0]!.remotePath = "runs/full/trial/agent/hlb-meter.jsonl"; write(join(f.snapshot, "acquisition.json"), f.acquisition);
    assert.throws(() => readLeaderboardSource(f.snapshot), /Protected leaderboard sources/u);
  } finally { f.cleanup(); }
});
test("changed or linked acquired source bytes fail the protected readback gate", () => {
  const f = fixture();
  try {
    const path = join(f.snapshot, f.acquisition.artifacts[0]!.localPath), original = readFileSync(path);
    writeFileSync(path, "{}"); assert.throws(() => readLeaderboardSource(f.snapshot), /source bytes/u);
    rmSync(path); writeFileSync(join(f.root, "outside.json"), original); symlinkSync(join(f.root, "outside.json"), path);
    assert.throws(() => readLeaderboardSource(f.snapshot), /traverse links/u);
  } finally { f.cleanup(); }
});
test("HF token patterns are quarantined in text, JSON and binary without retaining matched values in findings", () => {
  const token = "hf_" + "S".repeat(32);
  const scan = scanImportedFiles(new Map([["source.json", Buffer.from(JSON.stringify({ notes: token }))], ["media.bin", Buffer.concat([Buffer.from([0, 255]), Buffer.from(token)])]]));
  assert.equal(scan.status, "quarantined"); assert.equal(scan.findings.length, 2);
  assert.equal(JSON.stringify(scan).includes(token), false); assert.match(scan.inputDigest, /^sha256:/u);
});
test("identical cohort imports reuse byte-identical capture manifests and one execution", { skip: !python }, async () => {
  const f = fixture();
  try {
    const first = await importLeaderboardCohort(f.request, f.store, python), second = await importLeaderboardCohort(f.request, f.store, python);
    assert.equal(first.status, "imported"); assert.equal(second.status, "imported"); if (first.status !== "imported" || second.status !== "imported") return;
    assert.equal(first.cohortId, second.cohortId); assert.equal(first.reused, false); assert.equal(second.reused, true); assert.equal(second.admittedExecutions, 1);
    const read = readLeaderboardCohort(f.store, first.cohortId), member = read.manifest.members[0]!;
    assert.ok(readFileSync(join(read.root, member.corpusPath, "manifest.json")).equals(readFileSync(join(f.store, "harbor/captures", member.captureRevision.slice(7), "manifest.json"))));
    f.acquisition.artifacts.reverse(); write(join(f.snapshot, "acquisition.json"), f.acquisition);
    const reordered = await importLeaderboardCohort(f.request, f.store, python); assert.equal(reordered.status, "imported");
    if (reordered.status === "imported") assert.equal(reordered.cohortId, first.cohortId);
  } finally { f.cleanup(); }
});
test("ATIF backfills revise capture data while preserving the execution and earlier cohort", { skip: !python }, async () => {
  const f = fixture();
  try {
    const first = await importLeaderboardCohort(f.request, f.store, python); assert.equal(first.status, "imported"); if (first.status !== "imported") return;
    f.trajectory.steps[0].message = "Synthetic backfill"; write(join(f.trial, "agent/trajectory.json"), f.trajectory);
    const second = await importLeaderboardCohort({ ...f.request, priorCohortId: first.cohortId }, f.store, python); assert.equal(second.status, "imported"); if (second.status !== "imported") return;
    const old = readLeaderboardCohort(f.store, first.cohortId), current = readLeaderboardCohort(f.store, second.cohortId);
    assert.equal(old.manifest.members[0]!.executionId, current.manifest.members[0]!.executionId);
    assert.notEqual(old.manifest.members[0]!.captureRevision, current.manifest.members[0]!.captureRevision);
  } finally { f.cleanup(); }
});
test("quarantined native revisions retain raw evidence without publishing an import capture", { skip: !python }, async () => {
  const f = fixture();
  try {
    f.trajectory.steps[0].message = "hf_" + "S".repeat(32); write(join(f.trial, "agent/trajectory.json"), f.trajectory);
    const result = await importLeaderboardCohort(f.request, f.store, python);
    assert.equal(result.status, "imported"); if (result.status !== "imported") return;
    assert.equal(result.admittedExecutions, 0); assert.equal(result.cases[0]!.status, "quarantined");
    assert.equal(existsSync(join(f.store, "harbor/captures")), false); assert.equal(readdirSync(join(f.store, "native-sources")).length, 1);
  } finally { f.cleanup(); }
});
test("missing sources and explicit withdrawals produce new memberships without replacing retained cohorts", { skip: !python }, async () => {
  const f = fixture();
  try {
    const first = await importLeaderboardCohort(f.request, f.store, python); assert.equal(first.status, "imported"); if (first.status !== "imported") return;
    const withdrawn = await importLeaderboardCohort({ ...f.request, priorCohortId: first.cohortId, withdrawnFactIds: [id] }, f.store, python);
    assert.equal(withdrawn.status, "imported"); if (withdrawn.status === "imported") { assert.equal(withdrawn.admittedExecutions, 0); assert.equal(withdrawn.cases[0]!.status, "withdrawn"); }
    rmSync(f.trial, { recursive: true });
    const missing = await importLeaderboardCohort({ ...f.request, priorCohortId: first.cohortId }, f.store, python);
    assert.equal(missing.status, "imported"); if (missing.status === "imported") assert.equal(missing.cases[0]!.status, "missing");
    assert.equal(readLeaderboardCohort(f.store, first.cohortId).manifest.admittedExecutions, 1);
  } finally { f.cleanup(); }
});

test("linked regrades occupy one execution and every assessment binds its own scan", { skip: !python }, async () => {
  const f = fixture();
  try {
    const secondId = "22222222-2222-4222-8222-222222222222", regrade = join(f.root, "regrade");
    const { cpSync } = await import("node:fs"); cpSync(f.trial, regrade, { recursive: true });
    const result = JSON.parse(readFileSync(join(regrade, "result.json"), "utf8"));
    result.id = secondId; result.config.source_trial = { type: "hub", action: "regrade", trial_id: id };
    write(join(regrade, "result.json"), result); write(join(regrade, "config.json"), result.config);
    const artifact = f.acquisition.artifacts.find(({remotePath}) => remotePath.endsWith(".jsonl"))!;
    const fact = JSON.parse(readFileSync(join(f.snapshot, artifact.localPath), "utf8")); fact.id = secondId; fact.trial = "regrade-0";
    const bytes = Buffer.concat([readFileSync(join(f.snapshot, artifact.localPath)), Buffer.from(JSON.stringify(fact) + "\n")]);
    writeFileSync(join(f.snapshot, artifact.localPath), bytes); artifact.bytes = bytes.length; artifact.sha256 = rawHash(bytes).slice(7); write(join(f.snapshot, "acquisition.json"), f.acquisition);
    const request = { ...f.request, nativeBindings: [...f.request.nativeBindings, { factId: secondId, directory: regrade, profileId: f.request.nativeBindings[0]!.profileId, originals: [{ sourceReference: id, directory: f.trial }] }] };
    const imported = await importLeaderboardCohort(request, f.store, python);
    assert.equal(imported.status, "imported"); if (imported.status !== "imported") return;
    const retained = readLeaderboardCohort(f.store, imported.cohortId), member = retained.manifest.members[0]!;
    assert.equal(retained.manifest.admittedExecutions, 1); assert.equal(member.assessments.length, 2);
    const secondary = member.assessments.find(({factId}) => factId === secondId)!;
    write(join(f.store, "native-scans", secondary.nativeScanDigest.slice(7), "scan.json"), {});
    assert.throws(() => readLeaderboardCohort(f.store, imported.cohortId), /native source scan/u);
  } finally { f.cleanup(); }
});
