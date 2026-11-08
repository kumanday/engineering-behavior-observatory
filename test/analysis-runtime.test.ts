import { runtimeTest } from "./with-runtime-fixture.js";
const test = runtimeTest("claude-agent-sdk");
import assert from "node:assert/strict";
import {cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync,unlinkSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {listAnalysisRuntimes,loadAnalysisRuntime,validateRuntimeSnapshot} from "../src/analysis-runtime.js";
import {createRetainedBehaviorEvidence} from "../src/retained-evidence.js";
import {digestMetadata} from "../src/artifacts.js";
const taggedHash=(value:unknown):`sha256:${string}`=>`sha256:${digestMetadata(value).value}`;
const identity=listAnalysisRuntimes()[0]!,snapshot=resolve('compatibility',identity.id),hash=(value:unknown)=>digestMetadata(value).value;
test("frozen SDK imports preserve historical Pi siblings and current SDK module identities", async () => {
 const {registerHooks} = await import("node:module"), {fileURLToPath} = await import("node:url"), {dirname} = await import("node:path");
 const activePi = await import("@earendil-works/pi-coding-agent"), activeCursor = await import("@cursor/sdk");
 const routed: string[] = [];
 const observer = registerHooks({resolve(specifier, context, next) {const result = next(specifier, context); if (["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-telemetry"].includes(specifier) && result.url.startsWith("file:")) routed.push(result.url); return result;}});
 try {
  await loadAnalysisRuntime(identity.id);
  const versions = routed.map(url => {let path = dirname(fileURLToPath(url)); for (;;) {try {const metadata = JSON.parse(readFileSync(join(path, "package.json"), "utf8")); if (["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-telemetry"].includes(metadata.name)) return metadata.version;} catch {} const parent = dirname(path); if (parent === path) throw new Error("No historical SDK metadata"); path = parent;}});
  assert.ok(versions.length >= 2, "loading the fixed reader must exercise historical Pi sibling imports"); assert.ok(versions.every(version => version === "1.1.0"));
  assert.equal(await import("@earendil-works/pi-coding-agent"), activePi); assert.equal(await import("@cursor/sdk"), activeCursor);
 } finally {observer.deregister();}
});
test('the frozen v1 reader is selected only by a shipped runtime identity',async()=>{
 await assert.rejects(loadAnalysisRuntime('../../untrusted-reader'),/Unsupported/u);
 const runtime=await loadAnalysisRuntime(identity.id);assert.deepEqual(runtime.identity,identity);
 const path=resolve('test/fixtures/codex/legacy-0.150.1'),native=await createRetainedBehaviorEvidence(path),frozen=await runtime.createRetainedBehaviorEvidence(path);
 assert.equal(hash(native.dataset),hash(frozen.dataset));assert.equal(hash(native.coverage),hash(frozen.coverage));assert.equal(frozen.capture.qualification,native.capture.qualification);
});
test('the frozen source snapshot verifies its manifest and every listed asset',()=>{
 const manifest=validateRuntimeSnapshot(snapshot,identity.manifestDigest);assert.equal(manifest.source.commit,identity.sourceCommit);assert.ok(manifest.files.length>50);
 const root=mkdtempSync(join(tmpdir(),'ebo-runtime-integrity-'));try{
  const copy=join(root,'snapshot');cpSync(snapshot,copy,{recursive:true});const file=manifest.files.find(({path})=>path.endsWith('reader.mjs'))!;
  const original=readFileSync(join(copy,file.path));writeFileSync(join(copy,file.path),'changed');assert.throws(()=>validateRuntimeSnapshot(copy,identity.manifestDigest),/frozen digest/u);
  writeFileSync(join(copy,file.path),original);writeFileSync(join(copy,'unlisted.txt'),'unexpected');assert.throws(()=>validateRuntimeSnapshot(copy,identity.manifestDigest),/unlisted/u);unlinkSync(join(copy,'unlisted.txt'));
  unlinkSync(join(copy,file.path));writeFileSync(join(root,'outside.mjs'),original);symlinkSync(join(root,'outside.mjs'),join(copy,file.path));assert.throws(()=>validateRuntimeSnapshot(copy,identity.manifestDigest),/links/u);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('the frozen runtime retains RO-Crate packet verification',{skip:!process.env.EBO_COMPATIBILITY_PACKET_ROOT},async()=>{
 const runtime=await loadAnalysisRuntime(identity.id);assert.deepEqual(runtime.verifyPacket(process.env.EBO_COMPATIBILITY_PACKET_ROOT!),{ok:true,changed:[],missing:[],unlisted:[]});
});

test('the original main runtime preserves occurrence rules 1.1 alongside corrected 1.x analysis',async()=>{
 const {captureClaudeAgentSdkRun}=await import('../src/agent-sdk-run.js');
 const {probeClaudeAgentSdkCapabilities}=await import('../src/agent-sdk.js');
 const {mkdirSync}=await import('node:fs');
 const root=mkdtempSync(join(tmpdir(),'ebo-legacy-occurrence-'));
 try{
  const workspace=join(root,'workspace');mkdirSync(workspace);writeFileSync(join(workspace,'result.txt'),'synthetic');const sdk=probeClaudeAgentSdkCapabilities(),bundle=join(root,'bundle');
  const query:import('../src/agent-sdk.js').ClaudeAgentSdkQuery=(input)=>({close:()=>{},async *[Symbol.asyncIterator](){
   await input.options?.hooks?.SessionStart?.[0]?.hooks[0]?.({hook_event_name:'SessionStart',session_id:'s',transcript_path:'/synthetic/session.jsonl',cwd:workspace,source:'startup'} as import('@anthropic-ai/claude-agent-sdk').HookInput,undefined,{signal:new AbortController().signal});
   const messages=[{type:'assistant',uuid:'one',message:{role:'assistant',content:[{type:'tool_use',id:'call-1',name:'Bash',input:{command:'synthetic-check'}}]}},{type:'user',uuid:'two',message:{role:'user',content:[{type:'tool_result',tool_use_id:'call-1',is_error:true,content:'Synthetic failure'}]}},{type:'assistant',uuid:'three',message:{role:'assistant',content:[{type:'tool_use',id:'call-2',name:'Bash',input:{command:'synthetic-retry'}}]}},{type:'user',uuid:'four',message:{role:'user',content:[{type:'tool_result',tool_use_id:'call-2',is_error:false,content:'Synthetic success'}]}},{type:'result',uuid:'five',subtype:'success',duration_ms:12,duration_api_ms:8,is_error:false,num_turns:1,stop_reason:null,total_cost_usd:0,usage:{input_tokens:3,output_tokens:2},modelUsage:{},permission_denials:[],result:'Synthetic complete'}];
   for(const message of messages)yield{...message,session_id:'s',parent_tool_use_id:null} as unknown as import('@anthropic-ai/claude-agent-sdk').SDKMessage;
  }});
  await captureClaudeAgentSdkRun({definition:{bundleRoot:bundle,bundleId:'legacy-fixture',run:{id:'r',trial:{index:1},assessmentMode:'observational',task:{id:'synthetic'},fixture:{id:'fixture',digest:taggedHash('fixture')},model:{provider:'synthetic',id:'synthetic-model'},harness:{id:'agent-sdk',version:sdk.sdkVersion},runtime:[{source:'anthropic',name:'agent-sdk',version:sdk.sdkVersion}]},attempt:{id:'a',number:1},configuration:{digest:taggedHash('configuration'),budgetDigest:taggedHash('budget'),toolPolicyDigest:taggedHash('tools')}},startingWorkspacePath:workspace,workspace:{setup:async()=>({status:'ready',path:workspace,artifactId:'workspace',retained:true})},configuration:{prompt:'Synthetic fixture',model:'synthetic-model',tools:['Bash'],permissionMode:'dontAsk'},expectedHooks:['SessionStart'],query});
  // Author the original v1 interchange shape from this synthetic native run.
  // The shipped readers consume their original contract; their bytes stay frozen.
  const manifestPath=join(bundle,'manifest.json'),legacyManifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  legacyManifest.schemaVersion='run-manifest/v1';delete legacyManifest.runtimeLock;
  legacyManifest.evidence=legacyManifest.evidence.filter((entry:{source:string})=>entry.source!=='ebo-runtime');
  writeFileSync(manifestPath,JSON.stringify(legacyManifest));rmSync(join(bundle,'runtime'),{recursive:true,force:true});
  const legacy=await loadAnalysisRuntime('ebo-v1.4.0-86a6010'),corrected=await loadAnalysisRuntime('ebo-v1.4-atif-20261107'),old=await legacy.createRetainedStructuralObservationSet(bundle),current=await corrected.createRetainedStructuralObservationSet(bundle);
  assert.equal(old.normalization.datasetDigest,current.normalization.datasetDigest);assert.ok(old.occurrences!.length>0);assert.ok(old.occurrences!.every(({rule})=>rule.version==='1.1.0'));assert.ok(current.occurrences!.every(({rule})=>rule.version==='1.2.0'));assert.notEqual(hash(old),hash(current));
 }finally{rmSync(root,{recursive:true,force:true});}
});


test("fresh installs isolate the frozen reader roots and Pi sibling graph", async () => {
  const {createRequire} = await import("node:module");
  const local = createRequire(import.meta.url);
  const config = JSON.parse(readFileSync(new URL("../../compatibility/runtime-dependencies.json", import.meta.url), "utf8"));
  const anchor = createRequire(local.resolve(`${config.anchor}/package.json`));
  const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  for (const runtime of listAnalysisRuntimes()) {
    const snapshot = JSON.parse(readFileSync(new URL(`../../compatibility/${runtime.id}/runtime-manifest.json`, import.meta.url), "utf8"));
    for (const [name, version] of Object.entries({...snapshot.dependencies, ...config.aliases})) {
      const alias = "@ebo-compat/" + name.replace(/^@/u, "").replace("/", "-");
      const resolveFrom = Object.hasOwn(config.aliases, name) ? local : anchor;
      const installed = (resolveFrom.resolve.paths(Object.hasOwn(config.aliases, name) ? alias : name) ?? []).map(root => join(root, Object.hasOwn(config.aliases, name) ? alias : name, "package.json")).find(path => {try {return JSON.parse(readFileSync(path, "utf8")).name === name;} catch {return false;}});
      assert.ok(installed, name);
      assert.equal(JSON.parse(readFileSync(installed, "utf8")).version, version, `${runtime.id}: ${name}`);
      if (Object.hasOwn(config.aliases, name)) assert.equal(packageJson.dependencies[alias], `npm:${name}@${version}`);
    }
    // Loading exercises the original ESM-only Pi export through the scoped resolver.
    await loadAnalysisRuntime(runtime.id);
  }
});
