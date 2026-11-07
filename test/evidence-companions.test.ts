import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digestBytes, digestMetadata, validateArtifact } from "../src/artifacts.js";
import { importAtifFile } from "../src/atif-import.js";
import { listAtifProducerProfiles } from "../src/atif-profiles.js";
import { createRetainedBehaviorEvidence } from "../src/retained-evidence.js";
import { buildCorpusIndex } from "../src/corpus.js";
import { writeEvidenceCompanion, readEvidenceCompanion, companionArtifactId, type EvidenceCompanionRequest } from "../src/evidence-companions.js";
const python = process.env.EBO_ATIF_TEST_PYTHON;
const hash = (value: unknown): `sha256:${string}` => `sha256:${digestMetadata(value).value}`;
const rawHash = (bytes: Buffer): `sha256:${string}` => `sha256:${digestBytes(bytes).value}`;
async function fixture() {
  const root=mkdtempSync(join(tmpdir(),"ebo-companion-")), base=join(root,"attempt"), companion=join(root,"companion"), source=join(root,"source.json");
  writeFileSync(source,readFileSync("test/fixtures/atif/pi/parallel-failure-cache-write.atif.json"));
  await importAtifFile({ sourcePath:source, destination:base, producer:listAtifProducerProfiles()[0]!.producer,runId:"r",attemptId:"a",pythonExecutable:python });
  const evidence=await createRetainedBehaviorEvidence(base), reference=evidence.dataset.nativeRecords[0]!.reference, resolved=await evidence.resolver.resolve(reference);
  assert.ok(resolved && resolved !== true);
  const text="Synthetic history with a recording gap.";const bytes=Buffer.from(JSON.stringify({text}));
  const request: EvidenceCompanionRequest={targetManifestDigest:hash(JSON.parse(readFileSync(join(base,"manifest.json"),"utf8"))),kind:"workspace-history",producer:{id:"synthetic",version:"1.0.0",policyDigest:hash({policy:"synthetic"})},
    sourceRanges:[{reference,digest:resolved.digest}],artifacts:[{id:"history",path:"history.json",digest:rawHash(bytes),bytes:bytes.length,mediaType:"application/json"}],
    supplementalObservations:[{kind:"coverage-gap",citations:[{reference:{artifactId:"history",recordLocator:"#/text"},digest:hash(text)}],attributes:{reason:"unobserved interval"}}],coverage:{status:"partial",reasons:["History incomplete"]}};
  return{root,base,companion,evidence,request,bytes,files:new Map([["history",bytes]]),cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test("a digest-bound partial companion preserves the attempt and remains outside corpus trial discovery",{skip:!python},async()=>{
 const f=await fixture();try{
  const before=readFileSync(join(f.base,"manifest.json")), old=hash(f.evidence.dataset), index=buildCorpusIndex(f.root);
  const written=await writeEvidenceCompanion(f.base,f.companion,f.request,f.files), read=await readEvidenceCompanion(f.base,f.companion);
  assert.deepEqual(validateArtifact("companion",written.companion),[]);assert.equal(read.baseQualification,"imported");assert.equal(read.companion.coverage.status,"partial");
  assert.equal(read.digest,written.digest);assert.deepEqual(readFileSync(join(f.base,"manifest.json")),before);assert.equal(hash((await createRetainedBehaviorEvidence(f.base)).dataset),old);
  assert.deepEqual(buildCorpusIndex(f.root),index);
  const citation={artifactId:companionArtifactId(read.digest,"history"),recordLocator:"#/text"};const resolution=await read.resolver.resolve(citation);
  assert.ok(resolution&&resolution!==true);assert.equal(resolution.digest,hash("Synthetic history with a recording gap."));
  assert.equal(await read.resolver.resolve({artifactId:"history",recordLocator:"#/text"}),false);
  await assert.rejects(()=>writeEvidenceCompanion(f.base,f.companion,f.request,f.files));assert.deepEqual(readFileSync(join(f.base,"manifest.json")),before);
 }finally{f.cleanup();}
});
test("wrong original manifests, cross-attempt ranges and invented outcome fields fail closed",{skip:!python},async()=>{
 const f=await fixture();try{
  await assert.rejects(()=>writeEvidenceCompanion(f.base,f.companion,{...f.request,targetManifestDigest:hash({wrong:true})},f.files),/manifest digest/u);
  const wrong=structuredClone(f.request);wrong.sourceRanges[0]!.reference.artifactId="different-attempt";
  await assert.rejects(()=>writeEvidenceCompanion(f.base,f.companion,wrong,f.files),/source range/u);
  const invented={...f.request,supplementalObservations:[{...f.request.supplementalObservations[0]!,kind:"outcome"}]};
  await assert.rejects(()=>writeEvidenceCompanion(f.base,f.companion,invented as unknown as EvidenceCompanionRequest,f.files),/Invalid evidence companion/u);
 }finally{f.cleanup();}
});
test("changed source bytes and linked companion artifacts fail retained readback",{skip:!python},async()=>{
 const f=await fixture();try{
  await writeEvidenceCompanion(f.base,f.companion,f.request,f.files);
  writeFileSync(join(f.companion,"history.json"),"{}");await assert.rejects(()=>readEvidenceCompanion(f.base,f.companion),/artifact bytes/u);
  unlinkSync(join(f.companion,"history.json"));const outside=join(f.root,"outside.json");writeFileSync(outside,f.bytes);symlinkSync(outside,join(f.companion,"history.json"));
  await assert.rejects(()=>readEvidenceCompanion(f.base,f.companion),/links/u);
 }finally{f.cleanup();}
});
test("JSONL citations preserve source line numbers and canonical pointed-value digests",{skip:!python},async()=>{
 const f=await fixture();try{
  const bytes=Buffer.from('\n{"message":"sanitized content"}\n'),request=structuredClone(f.request);
  request.artifacts=[{id:"history",path:"history.jsonl",digest:rawHash(bytes),bytes:bytes.length,mediaType:"application/x-ndjson"}];
  request.supplementalObservations[0]!.citations=[{reference:{artifactId:"history",recordLocator:"#/lines/2/message"},digest:hash("sanitized content")}];
  await writeEvidenceCompanion(f.base,f.companion,request,new Map([["history",bytes]]));const read=await readEvidenceCompanion(f.base,f.companion);
  const result=await read.resolver.resolve({artifactId:companionArtifactId(read.digest,"history"),recordLocator:"#/lines/2/message"});assert.ok(result&&result!==true);assert.equal(result.digest,hash("sanitized content"));
  assert.equal(await read.resolver.resolve({artifactId:companionArtifactId(read.digest,"history"),recordLocator:"#/lines/1/message"}),false);
 }finally{f.cleanup();}
});

test("companions on an owned attempt retain its qualification and create no normalized events",async()=>{
 const { createAtlasFixture }=await import("./atlas-fixture.js");
 const root=mkdtempSync(join(tmpdir(),"ebo-owned-companion-"));
 try{
  await createAtlasFixture(join(root,"fixture"));const base=join(root,"fixture/corpus/synthetic-attempt-0"), evidence=await createRetainedBehaviorEvidence(base);
  const event=evidence.dataset.events.find(({content})=>content.status==="known")!,reference=event.source.nativeReference,resolved=await evidence.resolver.resolve(reference);assert.ok(resolved&&resolved!==true);
  const bytes=Buffer.from(JSON.stringify({diagnostic:"Owned conversion fixture"})),request:EvidenceCompanionRequest={targetManifestDigest:hash(JSON.parse(readFileSync(join(base,"manifest.json"),"utf8"))),kind:"converted-trajectory",producer:{id:"synthetic-converter",version:"1.0.0",policyDigest:hash({synthetic:true})},sourceRanges:[{reference,digest:resolved.digest}],artifacts:[{id:"converted",path:"trajectory.json",digest:rawHash(bytes),bytes:bytes.length,mediaType:"application/json"}],supplementalObservations:[],coverage:{status:"partial",reasons:["Conversion omits native timing"]}};
  await writeEvidenceCompanion(base,join(root,"companion"),request,new Map([["converted",bytes]]));const read=await readEvidenceCompanion(base,join(root,"companion"));
  assert.equal(read.baseQualification,evidence.capture.qualification);assert.equal(hash((await createRetainedBehaviorEvidence(base)).dataset),hash(evidence.dataset));
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("sanitized supplemental values retain resolvable citations with recomputed digests",{skip:!python},async()=>{
 const f=await fixture();try{
  const {sanitizeDerivedExport}=await import("../src/exports.js");
  const value=sanitizeDerivedExport({text:"api_key=syntheticcredential123"},{sharingClass:"public",maxArtifactBytes:1024*1024,maxStringBytes:65536}) as {text:string};
  assert.equal(value.text.includes("syntheticcredential123"),false);
  const bytes=Buffer.from(JSON.stringify(value)),request=structuredClone(f.request);request.artifacts[0]!.digest=rawHash(bytes);request.artifacts[0]!.bytes=bytes.length;request.supplementalObservations[0]!.citations[0]!.digest=hash(value.text);
  await writeEvidenceCompanion(f.base,f.companion,request,new Map([["history",bytes]]));const read=await readEvidenceCompanion(f.base,f.companion);
  const resolved=await read.resolver.resolve({artifactId:companionArtifactId(read.digest,"history"),recordLocator:"#/text"});assert.ok(resolved&&resolved!==true);assert.equal(resolved.digest,hash(value.text));
 }finally{f.cleanup();}
});
