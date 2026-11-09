import assert from "node:assert/strict";
import test from "node:test";
import { digestMetadata, validateArtifact } from "../src/artifacts.js";
import { createPointerEvidenceResolver } from "../src/evidence-pointers.js";
import { precedes, executionDurationMs, operationId, datasetV2Digest, validateNormalizedDatasetV2, type ClockEvidence, type NormalizedDatasetV2, type OperationIdentity } from "../src/normalization-v2.js";
const hash=(value:unknown):`sha256:${string}`=>`sha256:${digestMetadata(value).value}`;
const unknown={status:"unknown" as const,reason:"SOURCE_UNREPORTED"};
const pos=(nativeOrder:Parameters<typeof precedes>[0]["nativeOrder"])=>({runId:"r",attemptId:"a",nativeOrder});
const clockPos=(clock:ClockEvidence)=>({runId:"r",attemptId:"a",clock});
const reference={artifactId:"trajectory",recordLocator:"#"};
function fixture(){
 const record={tool:"shell",callId:"call-1"},resolver=createPointerEvidenceResolver({runId:"r",attemptId:"a",records:[{reference,record}]}),identity:OperationIdentity={runId:"r",attemptId:"a",sourceId:"s",scope:"document:root/session:one",kind:"tool",nativeId:"call-1",identityClass:"source-native"},id=operationId(identity);
 const dataset:NormalizedDatasetV2={schemaVersion:"ebo.normalized-dataset/v2",runId:"r",attemptId:"a",normalizer:{id:"synthetic",version:"2.0.0",implementationDigest:hash("implementation")},origin:{kind:"imported",qualification:"imported",manifestDigest:hash("manifest")},sources:[{id:"s",format:{kind:"atif",version:"ATIF-v1.7"},reader:{id:"synthetic-reader",version:"1.0.0",implementationDigest:hash("reader")},producerProfile:{status:"known",value:{id:"synthetic-profile",version:"1.0.0",digest:hash("profile")}},executedHarness:{id:"pi",version:unknown},authority:"third-party"}],
 events:[{schemaVersion:"ebo.uniform-event/v2",id:"call",runId:"r",attemptId:"a",source:{sourceId:"s",nativeType:"tool_call",nativeReference:reference},nativeOrder:{status:"known",value:1,domain:"root"},clock:unknown,actor:{kind:"agent"},family:"tool",phase:"before",scope:{kind:"operation",id},relations:{parent:unknown,known:[]},attributes:{},facts:{inference:{llmCallCount:{status:"known",value:1},nativeRequestId:unknown}},content:unknown}],
 operations:[{schemaVersion:"ebo.operation/v1",id,identity,scope:{status:"known",value:identity.scope},callEventIds:["call"],resultEventIds:[],toolName:{status:"known",value:"shell"},inputDigest:unknown,failure:unknown,issuingInference:{status:"known",value:{id:"step-1",scope:"root",identityClass:"declared-single-inference"}},startOrder:{status:"known",value:1,domain:"root"},endOrder:unknown}],
 measurements:[{id:"tool-operation-count",scope:{kind:"recorded-document",id:"root"},unit:"identified-logical-tool-operations",value:{status:"lower-bound",value:1,reason:"CAPTURE_COMPLETENESS_UNPROVEN"},coverage:"partial",sourceEventIds:["call"]}],nativeRecords:[{reference,nativeType:"document",digest:hash(record)}],contentReferences:[],recordCoverage:[{reference,disposition:"mapped",eventIds:["call"],reason:unknown}]};
 return{dataset,resolver};
}
test("v2 contracts retain pending operations, declared inference boundaries and lower bounds independently",async()=>{
 const{dataset,resolver}=fixture();assert.deepEqual(validateArtifact("dataset",dataset),[]);await validateNormalizedDatasetV2(dataset,resolver);
 assert.equal(dataset.operations[0]!.failure.status,"unknown");assert.equal(dataset.events[0]!.facts.inference!.nativeRequestId.status,"unknown");assert.equal(dataset.measurements[0]!.value.status,"lower-bound");
 const clone=structuredClone(dataset);assert.equal(datasetV2Digest(clone),datasetV2Digest(dataset));clone.measurements[0]!.value={status:"known",value:1};await assert.rejects(validateNormalizedDatasetV2(clone,resolver),/coverage/u);
});
test("operation IDs distinguish document/session scopes, operation kinds and identity classes",()=>{
 const base=fixture().dataset.operations[0]!.identity;const variants=[base,{...base,scope:"document:child/session:one"},{...base,kind:"delegation" as const},{...base,identityClass:"converter-assigned" as const}];
 assert.equal(new Set(variants.map(operationId)).size,variants.length);assert.equal(operationId({...base}),operationId(base));assert.throws(()=>operationId({...base,scope:""}),/identity/u);
});
test("source-local precedence ignores clocks, presentation order and unknown domains",()=>{
 const a={status:"known" as const,value:2,domain:"root"},b={status:"known" as const,value:3,domain:"root"};
 assert.equal(precedes(pos(a),pos(b)),"before");assert.equal(precedes(pos(b),pos(a)),"after");assert.equal(precedes(pos(a),pos({...a})),"same-observation");assert.equal(precedes(pos(a),pos({...b,domain:"child"})),"unknown");assert.equal(precedes(pos(a),pos(unknown)),"unknown");
 assert.equal(precedes(pos({...a,value:NaN}),pos(b)),"unknown");
});
test("receipt and inferred clocks cannot become recorded execution duration",()=>{
 const start:ClockEvidence={status:"known",value:{timestamp:"2026-11-07T00:00:00.000Z",kind:"execution",domain:"native-process",precisionMs:0,provenance:"source-recorded",source:reference}},end=structuredClone(start);end.value.timestamp="2026-11-07T00:00:01.000Z";
 assert.deepEqual(executionDurationMs(clockPos(start),clockPos(end)),{status:"known",value:1000});
 for(const changed of [{...end.value,kind:"receipt" as const},{...end.value,domain:"other"},{...end.value,provenance:"converter-derived" as const},{...end.value,precisionMs:1}])assert.equal(executionDurationMs(clockPos(start),clockPos({status:"known",value:changed})).status,"unknown");
});
test("v2 validation rejects cross-attempt sources, unresolved scopes, duplicate membership and stale digests",async()=>{
 for(const mutate of [(d:NormalizedDatasetV2)=>{d.events[0]!.attemptId="other";},(d:NormalizedDatasetV2)=>{d.operations[0]!.identity.scope="other";},(d:NormalizedDatasetV2)=>{d.operations[0]!.callEventIds.push("call");},(d:NormalizedDatasetV2)=>{d.nativeRecords[0]!.digest=hash("stale");},(d:NormalizedDatasetV2)=>{d.sources[0]!.authority="owned-capture";},(d:NormalizedDatasetV2)=>{d.events[0]!.scope={kind:"session",id:"native-id-alias"};}]){
  const{dataset,resolver}=fixture();mutate(dataset);await assert.rejects(validateNormalizedDatasetV2(dataset,resolver));
 }
});
test("same-inference sibling calls share order without manufacturing a response or native request",async()=>{
 const{dataset,resolver}=fixture(),operation=structuredClone(dataset.operations[0]!),event=structuredClone(dataset.events[0]!);operation.identity.nativeId="call-2";operation.id=operationId(operation.identity);operation.callEventIds=["call-2"];event.id="call-2";event.scope.id=operation.id;dataset.operations.push(operation);dataset.events.push(event);dataset.recordCoverage[0]!.eventIds.push(event.id);
 await validateNormalizedDatasetV2(dataset,resolver);assert.equal(precedes(pos(dataset.events[0]!.nativeOrder),pos(event.nativeOrder)),"same-observation");assert.equal(dataset.operations.every(({failure})=>failure.status==="unknown"),true);
});

test("digest-bound inventories and explicit endpoint order prevent unbound v2 evidence",async()=>{
 for(const mutate of [(d:NormalizedDatasetV2)=>{d.nativeRecords=[];},(d:NormalizedDatasetV2)=>{d.operations[0]!.startOrder={status:"known",value:99,domain:"root"};},(d:NormalizedDatasetV2)=>{d.measurements[0]!.scope.kind="attempt";d.measurements[0]!.value={status:"known",value:1};d.measurements[0]!.coverage="exact";}]){
  const{dataset,resolver}=fixture();mutate(dataset);await assert.rejects(validateNormalizedDatasetV2(dataset,resolver));
 }
});

test("durable key order does not change v2 validation or hide duplicate identities",async()=>{
 const{dataset,resolver}=fixture(),oldDigest=datasetV2Digest(dataset);
 dataset.recordCoverage[0]!.reference={recordLocator:reference.recordLocator,artifactId:reference.artifactId};
 await validateNormalizedDatasetV2(dataset,resolver);assert.equal(datasetV2Digest(dataset),oldDigest);
 dataset.nativeRecords.push({...dataset.nativeRecords[0]!,reference:{recordLocator:reference.recordLocator,artifactId:reference.artifactId}});await assert.rejects(validateNormalizedDatasetV2(dataset,resolver),/Duplicate/u);
 const second=fixture();second.dataset.measurements.push({...structuredClone(second.dataset.measurements[0]!),scope:{id:'root',kind:'recorded-document'}});await assert.rejects(validateNormalizedDatasetV2(second.dataset,second.resolver),/Duplicate/u);
});
test("fractional timestamps and cross-attempt positions cannot produce false exact evidence",()=>{
 const clock=(timestamp:string):ClockEvidence=>({status:'known',value:{timestamp,kind:'execution',domain:'process',precisionMs:0,provenance:'source-recorded',source:reference}});
 assert.equal(executionDurationMs(clockPos(clock('2026-11-07T00:00:00.0009Z')),clockPos(clock('2026-11-07T00:00:00.0011Z'))).status,'unknown');
 assert.equal(executionDurationMs(clockPos(clock('2026-11-07T00:00:00.0009Z')),clockPos(clock('2026-11-07T00:00:00.0001Z'))).status,'unknown');
 const position=pos({status:'known',value:1,domain:'same-name'});assert.equal(precedes(position,{...position,attemptId:'other'}),'unknown');
 assert.equal(executionDurationMs(clockPos(clock('2026-11-07T00:00:00Z')),{...clockPos(clock('2026-11-07T00:00:01Z')),attemptId:'other'}).status,'unknown');
});
test("attempt measurements and record mappings cannot name unrelated evidence",async()=>{
 const f=fixture();f.dataset.measurements[0]!.scope={kind:'attempt',id:'other'};await assert.rejects(validateNormalizedDatasetV2(f.dataset,f.resolver),/different attempt/u);
 const second=fixture();second.dataset.nativeRecords.push({...second.dataset.nativeRecords[0]!,reference:{artifactId:'unrelated',recordLocator:'#'}});second.dataset.recordCoverage.push({reference:{artifactId:'unrelated',recordLocator:'#'},disposition:'mapped',eventIds:['call'],reason:unknown});
 await assert.rejects(validateNormalizedDatasetV2(second.dataset,{resolve:()=>({runId:'r',attemptId:'a',digest:hash({tool:'shell',callId:'call-1'})})}),/unrelated/u);
});

test("permission lifecycle hooks retain operation association without becoming tool endpoints",async()=>{
 const{dataset,resolver}=fixture(),permission=structuredClone(dataset.events[0]!);permission.id='permission';permission.family='permission';permission.actor.kind='harness';dataset.events.push(permission);dataset.recordCoverage[0]!.eventIds.push(permission.id);
 await validateNormalizedDatasetV2(dataset,resolver);assert.deepEqual(dataset.operations[0]!.callEventIds,['call']);assert.deepEqual(dataset.operations[0]!.resultEventIds,[]);
 permission.scope.id='absent';await assert.rejects(validateNormalizedDatasetV2(dataset,resolver),/unresolved/u);
});
test("RFC3339 lowercase UTC markers cannot bypass fractional precision checks",()=>{
 const clock=(timestamp:string):ClockEvidence=>({status:'known',value:{timestamp,kind:'execution',domain:'process',precisionMs:0,provenance:'source-recorded',source:reference}});
 for(const [start,end]of[['2026-11-07T00:00:00.0009z','2026-11-07T00:00:00.0011z'],['2026-11-07T00:00:00.0009z','2026-11-07T00:00:00.0001z']])assert.equal(executionDurationMs(clockPos(clock(start!)),clockPos(clock(end!))).status,'unknown');
});

test('standalone workspace content keeps its own digest-bound inventory and resolver',async()=>{
 const{dataset}=fixture(),workspace={artifactId:'workspace',recordLocator:'#'},record={files:['result.txt']};dataset.contentReferences.push({reference:workspace,digest:hash(record)});dataset.events[0]!.content={status:'known',value:[{nativeReference:workspace}]};
 const resolver=createPointerEvidenceResolver({runId:'r',attemptId:'a',records:[{reference,record:{tool:'shell',callId:'call-1'}},{reference:workspace,record}]});await validateNormalizedDatasetV2(dataset,resolver);
 const stale=structuredClone(dataset);stale.contentReferences[0]!.digest=hash({wrong:true});await assert.rejects(validateNormalizedDatasetV2(stale,resolver),/stale/u);
 const missing=structuredClone(dataset);missing.contentReferences=[];await assert.rejects(validateNormalizedDatasetV2(missing,resolver),/outside/u);
});
test('unsupported timestamp offset syntax never reaches lossy exact-duration parsing',()=>{
 const clock=(timestamp:string):ClockEvidence=>({status:'known',value:{timestamp,kind:'execution',domain:'process',precisionMs:0,provenance:'source-recorded',source:reference}});
 assert.equal(executionDurationMs(clockPos(clock('2026-11-07T00:00:00.0009+0000')),clockPos(clock('2026-11-07T00:00:00.0011+0000'))).status,'unknown');
});

test('calendar rollover and invalid clock fields remain unknown before exact subtraction',()=>{
 const clock=(timestamp:string):ClockEvidence=>({status:'known',value:{timestamp,kind:'execution',domain:'process',precisionMs:0,provenance:'source-recorded',source:reference}});
 for(const invalid of['2026-02-30T00:00:00Z','2025-02-29T00:00:00Z','2026-12-31T24:00:00Z','2026-03-02T00:00:00+24:00'])assert.equal(executionDurationMs(clockPos(clock(invalid)),clockPos(clock('2026-03-02T00:00:01Z'))).status,'unknown');
 assert.deepEqual(executionDurationMs(clockPos(clock('2024-02-29T00:00:00Z')),clockPos(clock('2024-02-29T00:00:01Z'))),{status:'known',value:1000});
});
