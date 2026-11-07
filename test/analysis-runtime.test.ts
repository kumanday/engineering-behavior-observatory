import assert from "node:assert/strict";
import {cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync,unlinkSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import test from "node:test";
import {listAnalysisRuntimes,loadAnalysisRuntime,validateRuntimeSnapshot} from "../src/analysis-runtime.js";
import {createRetainedBehaviorEvidence} from "../src/retained-evidence.js";
import {digestMetadata} from "../src/artifacts.js";
const identity=listAnalysisRuntimes()[0]!,snapshot=resolve('compatibility',identity.id),hash=(value:unknown)=>digestMetadata(value).value;
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
