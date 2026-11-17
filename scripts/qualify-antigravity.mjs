// Owned personal-OAuth qualification captures. Never runs as part of the offline suite.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { captureAntigravityCliRun } from '../dist/src/antigravity-run.js';
import { ANTIGRAVITY_CLI_VERSION } from '../dist/src/antigravity.js';
import { createRetainedBehaviorEvidenceV2 } from '../dist/src/native-v2.js';
import { exportAntigravityAtif } from '../dist/src/antigravity-atif.js';
import { digestMetadata } from '../dist/src/artifacts.js';
const [studyArgument, rootArgument, model] = process.argv.slice(2);
if (!studyArgument || !rootArgument || !model || process.argv.length !== 5) throw new Error('Use <frozen-study> <new-private-output> <native-model>');
const studyRoot = resolve(studyArgument), root = resolve(rootArgument);
await mkdir(root, {recursive: false, mode: 0o700});
const hash = value => `sha256:${digestMetadata(value).value}`;
const profile = {permissionMode:'always-proceed', sandbox:false, shutdownGraceMs:5000};
const cases = [];
for (const kind of ['success', 'failure-recovery', 'interruption']) {
  const directory = join(root, kind), workspace = join(directory, 'workspace'), baseline = join(directory, 'baseline'), bundle = join(directory, 'bundle');
  await mkdir(directory, {mode:0o700}); await mkdir(workspace); await mkdir(baseline);
  for (const path of [workspace, baseline]) {
    await writeFile(join(path,'math.mjs'), 'export const add = (a,b) => a-b;\n');
    await writeFile(join(path,'test.mjs'), "import assert from 'node:assert/strict';import {add} from './math.mjs';assert.equal(add(2,3),5);console.log('PASS');\n");
  }
  const instruction = kind === 'success' ? 'Read math.mjs and test.mjs, fix add, and run node test.mjs. Reply DONE after it passes.'
    : kind === 'failure-recovery' ? 'First run node test.mjs and observe its deliberate failure. Then read math.mjs, fix add, and run node test.mjs again. Reply DONE after it passes.'
    : 'Run sleep 90 as a foreground terminal command now. Wait for it to finish. Do nothing else.';
  const runId = `agy-qualification-${randomUUID()}`, attemptId = randomUUID();
  const controller = new AbortController();
  let watcher;
  if (kind === 'interruption') watcher = setInterval(async () => {
    const native = await readFile(join(bundle,'session.jsonl'),'utf8').catch(()=> '');
    const running = native.split('\n').filter(Boolean).some(line => {
      try { const r = JSON.parse(line), s = r.payload?.step_update;
        return r.kind === 'frame' && s?.step_type === 'tool' && s.state === 'ACTIVE' && s.tool_info?.parameters?.CommandLine?.includes('sleep');
      } catch { return false; }
    });
    if (running) controller.abort();
  }, 250);
  let result;
  try {
    result = await captureAntigravityCliRun({ runtime:{studyRoot},
      definition:{bundleRoot:bundle,bundleId:`bundle-${attemptId}`,run:{id:runId,assessmentMode:'observational',task:{id:'synthetic-qualification'},
        fixture:{id:'synthetic-math',digest:hash('synthetic-math-v1')},model:{provider:'google',id:model},harness:{id:'antigravity-cli',version:ANTIGRAVITY_CLI_VERSION},runtime:[]},
        attempt:{id:attemptId,number:1},configuration:{digest:hash(profile),captureProfileDigest:hash(profile),budgetDigest:hash({maxWallClockMs:120000}),toolPolicyDigest:hash(profile)}},
      startingWorkspacePath:baseline,workspace:{setup:()=>({status:'ready',path:workspace,artifactId:'workspace',retained:true}),cleanup:()=>{}},
      configuration:{executable:'/opt/ebo/bin/agy',version:ANTIGRAVITY_CLI_VERSION,model,permissionMode:'always-proceed',sandbox:false},
      prompt:instruction,signal:controller.signal,maxWallClockMs:120000,shutdownGraceMs:5000 });
  } finally {if(watcher) clearInterval(watcher);}
  const retained = await createRetainedBehaviorEvidenceV2(bundle);
  const atif = await exportAntigravityAtif(bundle,{sharingClass:'public',maxArtifactBytes:8*1024*1024,maxStringBytes:64*1024});
  await writeFile(join(directory,'trajectory.json'),JSON.stringify(atif,null,2)+'\n',{mode:0o600,flag:'wx'});
  const expected = kind === 'interruption' ? 'interrupted' : 'completed';
  assert.equal(result.manifest.terminal.state,expected,`Inspect the private ${kind} bundle`);
  assert.ok(retained.dataset.events.length);
  if (kind !== 'interruption') assert.equal(execFileSync(process.execPath,['test.mjs'],{cwd:workspace,encoding:'utf8',timeout:5000}).trim(),'PASS');
  const summary={case:kind,terminal:result.manifest.terminal.state,events:retained.dataset.events.length,operations:retained.dataset.operations.length,
    pairedTools:retained.dataset.operations.filter(op=>op.identity.kind==='tool'&&op.callEventIds.length&&op.resultEventIds.length).length,
    nativeSessionId:result.capture?.sessionId,taskProof:kind === 'interruption' ? 'active-tool-interrupted' : 'test-passed',atif:'valid'};
  await writeFile(join(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({...summary,nativeSessionId:undefined}));
  cases.push({kind:'owned-capture',case:kind,bundleRoot:bundle});
}
await writeFile(join(root,'verification-request.json'),JSON.stringify({studyRoot,role:'antigravity-cli',cases},null,2)+'\n',{mode:0o600,flag:'wx'});

// All owned children and evidence writers have drained.
process.exit(0);
