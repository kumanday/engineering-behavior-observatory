import assert from 'node:assert/strict';
import {cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import test from 'node:test';
import {buildAtlasBundle,verifyAtlasBundle,assertEquivalentAtlasProjection,type AtlasBundleRequest} from '../src/atlas-bundle.js';
import {listAnalysisRuntimes,loadAnalysisRuntime} from '../src/analysis-runtime.js';
import {createRetainedBehaviorEvidence} from '../src/retained-evidence.js';
import {createAtlasFixture} from './atlas-fixture.js';
const identity=listAnalysisRuntimes()[0]!,pin={id:identity.id,manifestDigest:identity.manifestDigest};
test('cohorts retain shipped runtime receipts and deduplicate equivalent projections of the same attempts',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ebo-runtime-atlas-'));try{
  await createAtlasFixture(join(root,'study'),{legacyManifest:true});
  const original=join(root,'study'),copy=join(root,'copied-study');cpSync(original,copy,{recursive:true});
  const rewrite=(value:unknown):unknown=>typeof value==='string'&&value.startsWith(original)?copy+value.slice(original.length):Array.isArray(value)?value.map(rewrite):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,rewrite(item)])):value;
  writeFileSync(join(copy,'aggregation.json'),JSON.stringify(rewrite(JSON.parse(readFileSync(join(copy,'aggregation.json'),'utf8')))));
  const request:AtlasBundleRequest={schemaVersion:'ebo.atlas-bundle-request/v1',id:'runtime-study',title:'Runtime study',cohorts:[{id:'current',atlasRequest:'study/atlas.json'},{id:'frozen',atlasRequest:'copied-study/atlas.json',analysisRuntime:pin}]};
  const path=join(root,'request.json');writeFileSync(path,JSON.stringify(request));const out=join(root,'atlas'),manifest=await buildAtlasBundle(path,out);
  assert.equal(manifest.tables.attempts!.rows,7);assert.equal(manifest.cohorts.length,2);assert.deepEqual(manifest.cohorts.find(({id})=>id==='frozen')!.analysisRuntime,identity);assert.equal(manifest.cohorts.find(({id})=>id==='current')!.analysisRuntime,undefined);
  const report=JSON.parse(readFileSync(join(out,'reports/frozen.json'),'utf8'));assert.deepEqual(report.analysisRuntime,identity);assert.equal(verifyAtlasBundle(out).ok,true);
  writeFileSync(path,JSON.stringify({...request,cohorts:[{id:'bad',atlasRequest:'study/atlas.json',analysisRuntime:{...pin,manifestDigest:'sha256:'+'0'.repeat(64)}}]}));await assert.rejects(buildAtlasBundle(path,join(root,'bad-digest')),/runtime digest/u);
  writeFileSync(path,JSON.stringify({...request,cohorts:[{id:'bad',atlasRequest:'study/atlas.json',analysisRuntime:{...pin,id:'packet-provided-module'}}]}));await assert.rejects(buildAtlasBundle(path,join(root,'bad-runtime')),/Unsupported analysis runtime/u);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('a shared attempt cannot silently use a different normalized projection or qualification',async()=>{
 const path=resolve('test/fixtures/codex/legacy-0.150.1'),first=await createRetainedBehaviorEvidence(path),runtime=await loadAnalysisRuntime(identity.id),same=await runtime.createRetainedBehaviorEvidence(path);assertEquivalentAtlasProjection(first,same);
 const changed={...same,dataset:{...same.dataset,adapter:{...same.dataset.adapter,version:'different'}}};assert.throws(()=>assertEquivalentAtlasProjection(first,changed),/conflicting analysis-runtime/u);
 const unknown={...same,modelAliases:['another model alias']};assert.throws(()=>assertEquivalentAtlasProjection(first,unknown),/conflicting analysis-runtime/u);
});
