// Run inside an authenticated Linux guest, through the production Harbor worker.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { digestBytes } from '../dist/src/artifacts.js';
import { ANTIGRAVITY_CLI_VERSION, ANTIGRAVITY_CONTRACT_DIGEST } from '../dist/src/antigravity.js';
import { runHarborWorker } from '../dist/src/harbor/worker.js';
import { createRetainedBehaviorEvidenceV2 } from '../dist/src/native-v2.js';
import { exportAntigravityAtif } from '../dist/src/antigravity-atif.js';
import { readStudyRuntimeLock } from '../dist/src/study-runtimes.js';

assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
assert.equal(process.versions.node, '26.13.0');
const root = '/var/tmp/ebo-agy-branch-proof';
const workspace = '/workspace';
const model = process.argv[2];
assert.ok(model, 'Supply a native account model slug');
await mkdir(root, { recursive: false });
await mkdir(workspace, { recursive: true });
const instruction = 'Synthetic integration test. Create capture-proof.txt containing exactly done followed by a newline in the current directory, then reply DONE. Do nothing else.';
const instructionDigest = digestBytes(Buffer.from(instruction));
const runId = 'agy-branch-run-'+randomUUID();
const attemptId = 'agy-branch-attempt-'+randomUUID();
const records = {
  model: { kind: 'model', provider: 'google', model },
  harness: { kind: 'harness', adapter: 'antigravity-cli', executable: '/opt/ebo/bin/agy', version: ANTIGRAVITY_CLI_VERSION, contractDigest: ANTIGRAVITY_CONTRACT_DIGEST, accountHome: process.env.HOME },
  nativeLimits: { kind: 'native-limits', shutdownGraceMs: 3000 },
  nativeToolPolicy: { kind: 'native-tool-policy', permissionMode: 'always-proceed', sandbox: false },
  captureProfile: { kind: 'capture-profile', workspaceOutcome: { excludeDirectoryNames: ['node_modules'] } },
};
const configuration = {};
for (const [key, value] of Object.entries(records)) {
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 'ebo.antigravity-config/v1', ...value }));
  const locator = `${key}.json`;
  await writeFile(join(root, locator), bytes, { flag: 'wx', mode: 0o600 });
  configuration[key] = { locator, digest: digestBytes(bytes) };
}
const studyRoot = '/opt/ebo/study';
const lock = await readStudyRuntimeLock(studyRoot);
const input = {
  runtimeLock: {studyRoot, digest: lock.digest},
  prepared: {
    run: { id: runId, attemptId, taskId: 'synthetic-proof', modelId: model, harnessId: 'antigravity-cli', trialIndex: 1 },
    task: { taskSourceId: 'synthetic-proof', harborDigest: instructionDigest.value, assessmentMode: 'observational', snapshotDirectory: '', resolutionDigest: instructionDigest },
    steps: [{ index: 1, name: null, effectiveInstruction: instruction, instructionDigest, minReward: null, verifierTimeoutSec: 0 }],
    environment: { profile: 'smol', provider: 'smol', containerized: false, enforcement: 'vm', dockerImage: process.env.EBO_AUTH_IMAGE, networkMode: 'public' },
    verifier: { requested: false, environmentMode: null, timeoutSec: 0, multiStepRewardStrategy: 'mean' },
    budget: { coordinatorWallClockMs: 120000 },
    evidence: { attemptRoot: root, harborDir: root, stepsDir: root, workspaceDir: workspace, eboDir: root },
  },
  configuration, configurationRoot: root, instruction, stepIndex: 1, workspacePath: workspace,
  outputRoot: join(root, 'worker'), maxWallClockMs: 120000,
};
await writeFile(join(root, 'worker-input.json'), JSON.stringify(input), { flag: 'wx', mode: 0o600 });
const result = await runHarborWorker(input);
assert.equal(result.terminal.state, 'completed', 'Guest native worker failed; retain its partial evidence');
assert.equal(await readFile(join(workspace, 'capture-proof.txt'), 'utf8'), 'done\n');
const retained = await createRetainedBehaviorEvidenceV2(join(root, 'worker/bundle'));
assert.ok(retained.dataset.operations.some(op => op.callEventIds.length && op.resultEventIds.length));
const atif = await exportAntigravityAtif(join(root, 'worker/bundle'), {sharingClass:'public', maxArtifactBytes:8*1024*1024,maxStringBytes:64*1024});
await writeFile(join(root,'trajectory.json'), JSON.stringify(atif,null,2)+'\n', {flag:'wx',mode:0o600});
const summary = { status: 'passed', platform: process.platform, architecture: process.arch, model, runId, attemptId,
  qualification: result.qualification, terminal: result.terminal.state, nativeSessionId: result.nativeSessionId,
  normalizedEvents: retained.dataset.events.length, mappedNativeRecords: retained.dataset.recordCoverage.filter(r => r.disposition === 'mapped').length,
  operations: retained.dataset.operations.length, atif: 'valid',
  proofFile: 'passed' };
await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(summary));
// The capture is drained. SDK background handles must not delay Harbor cleanup.
process.exit(0);
