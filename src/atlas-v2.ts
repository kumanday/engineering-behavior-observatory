import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analysisDigestV2, citeEventV2, createStructuralObservationSetV2, type EvidenceCitationV2, type HashV2, type ObservationSetV2 } from "./analysis-v2.js";
import { loadAnalysisRuntime, type AnalysisRuntimeIdentity } from "./analysis-runtime.js";
import { visibleEvidence } from "./evidence-projection.js";
import { ATIF_TOKEN_ACCOUNTING_LABEL } from "./atif-display.js";
import type { RetainedBehaviorEvidenceV2 } from "./native-v2.js";
import { datasetV2Digest, executionDurationMs, type EventFactsV2 } from "./normalization-v2.js";
import { createOccurrenceLedgerV2, operationCommandV2, type OccurrenceLedgerV2 } from "./occurrences-v2.js";
import type { EvidenceValue } from "./uniform-events.js";

export type AtlasUnitV2 = { id: string; kind: "tool" | "message" | "delegation" | "model-request" | "context"; sourceId: string; eventIds: string[];
  message?: EventFactsV2["message"]; label: string; role: EvidenceValue<string>; failure: EvidenceValue<boolean>; durationMs: EvidenceValue<number>; command: string | null };
export type AtlasViewV2 = { schemaVersion: "ebo.atlas-view/v2"; runtime: { id: "ebo-typed-v2"; version: "2.0.0"; datasetDigest: HashV2 };
  runId: string; attemptId: string; origin: RetainedBehaviorEvidenceV2["dataset"]["origin"]; sources: RetainedBehaviorEvidenceV2["dataset"]["sources"];
  observations: ObservationSetV2; ledger: OccurrenceLedgerV2; units: AtlasUnitV2[];
  evidence: Array<{ citationId: HashV2; citation: EvidenceCitationV2; content: EvidenceValue<unknown> }>;
};
const unknown = { status: "unknown", reason: "SOURCE_UNREPORTED" } as const;
/** Source-independent units and exactly the citation recipe used by the semantic judge. */
export async function buildAtlasViewV2(evidence: RetainedBehaviorEvidenceV2): Promise<AtlasViewV2> {
  const { dataset, resolver } = evidence;
  const observations = await createStructuralObservationSetV2(dataset, resolver), ledger = await createOccurrenceLedgerV2(dataset, resolver);
  const units: AtlasUnitV2[] = [], events = new Map(dataset.events.map((event) => [event.id, event]));
  for (const operation of dataset.operations) {
    const starts = operation.callEventIds.map((id) => events.get(id)!), ends = operation.resultEventIds.map((id) => events.get(id)!);
    const durationMs = starts.length === 1 && ends.length === 1 ? executionDurationMs(starts[0]!, ends[0]!) : unknown;
    units.push({ id: operation.id, kind: operation.identity.kind, sourceId: operation.identity.sourceId,
      eventIds: [...operation.callEventIds, ...operation.resultEventIds, ...operation.observationEventIds ?? []], label: operation.toolName.status === "known" ? operation.toolName.value : operation.identity.kind,
      role: unknown, failure: operation.failure, durationMs, command: operationCommandV2(dataset, operation, resolver) ?? null });
  }
  const messages = new Map<string, AtlasUnitV2>();
  for (const event of dataset.events) {
    if (event.facts.message && ["canonical", "fragment"].includes(event.facts.message.representation)) {
      const identity = event.facts.message.identity, key = identity.status === "known" ? JSON.stringify([event.source.sourceId, identity.value]) : event.id;
      const existing = messages.get(key);
      const label = event.facts.message.completeness.status === "known" ? `${event.facts.message.completeness.value} message` : "recorded message";
      if (existing) {
        existing.eventIds.push(event.id);
        if (existing.label !== label) existing.label = "recorded message";
        if (analysisDigestV2(existing.message!.completeness) !== analysisDigestV2(event.facts.message.completeness)) existing.message!.completeness = { status: "unknown", reason: "MIXED_MESSAGE_COMPLETENESS_OBSERVATIONS" };
        if (existing.message!.representation !== event.facts.message.representation) existing.message!.representation = "unknown";
        if (analysisDigestV2(existing.role) !== analysisDigestV2(event.facts.message.role)) {
          const role = { status: "unknown", reason: "CONFLICTING_MESSAGE_ROLE_OBSERVATIONS" } as const;
          existing.role = role; existing.message!.role = role;
        }
        continue;
      }
      const unit: AtlasUnitV2 = { id: `message:${analysisDigestV2(key).slice(7)}`, kind: "message", sourceId: event.source.sourceId, eventIds: [event.id],
        message: structuredClone(event.facts.message), label, role: event.facts.message.role, failure: unknown, durationMs: unknown, command: null };
      messages.set(key, unit); units.push(unit);
    } else if (event.facts.context) units.push({ id: `context:${event.id}`, kind: "context", sourceId: event.source.sourceId, eventIds: [event.id], label: event.facts.context.type,
      role: unknown, failure: unknown, durationMs: unknown, command: null });
  }
  const citations = new Map<HashV2, EvidenceCitationV2>();
  for (const event of dataset.events) {
    for (const reference of [event.source.nativeReference, ...event.content.status === "known" ? event.content.value.map(({ nativeReference }) => nativeReference) : []]) {
      const citation = await citeEventV2(dataset, resolver, event.id, reference); citations.set(analysisDigestV2(citation), citation);
    }
  }
  return { schemaVersion: "ebo.atlas-view/v2", runtime: { id: "ebo-typed-v2", version: "2.0.0", datasetDigest: datasetV2Digest(dataset) }, runId: dataset.runId, attemptId: dataset.attemptId,
    origin: structuredClone(dataset.origin), sources: structuredClone(dataset.sources), observations, ledger, units: units.sort((a, b) => a.id.localeCompare(b.id)),
    evidence: [...citations].map(([citationId, citation]) => ({ citationId, citation, content: resolver.read(citation.nativeReference) === undefined ? { status: "unknown" as const, reason: "RETAINED_REFERENCE_CONTENT_UNAVAILABLE" } : { status: "known" as const, value: visibleEvidence(resolver.read(citation.nativeReference)) } })) };
}
export async function validateAtlasViewV2(view: AtlasViewV2, evidence: RetainedBehaviorEvidenceV2): Promise<void> {
  if (analysisDigestV2(view) !== analysisDigestV2(await buildAtlasViewV2(evidence))) throw new Error("V2 Atlas view differs from its dataset and evidence.");
}
export type AtlasCohortSummaryV2 = { id: string; runId: string; attemptId: string; origin: "owned" | "imported"; datasetDigest: HashV2;
  runtime: AnalysisRuntimeIdentity | AtlasViewV2["runtime"]; unitCount: number | null; observations: unknown };
/** Fixed shipped v1 readers are the only compatibility execution route. Cohorts retain independent measures. */
export async function buildAtlasCohortsV2(inputs: Array<{ id: string; evidence: RetainedBehaviorEvidenceV2 } | { id: string; bundleRoot: string; runtimeId: string }>): Promise<AtlasCohortSummaryV2[]> {
  if (new Set(inputs.map(({ id }) => id)).size !== inputs.length) throw new Error("Duplicate Atlas cohort identity.");
  const result: AtlasCohortSummaryV2[] = [];
  for (const input of inputs) {
    if ("evidence" in input) { const view = await buildAtlasViewV2(input.evidence); result.push({ id: input.id, runId: view.runId, attemptId: view.attemptId,
      origin: view.origin.kind, datasetDigest: view.runtime.datasetDigest, runtime: view.runtime, unitCount: view.units.length, observations: view.observations }); }
    else { const runtime = await loadAnalysisRuntime(input.runtimeId), evidence = await runtime.createRetainedBehaviorEvidence(input.bundleRoot);
      result.push({ id: input.id, runId: evidence.dataset.runId, attemptId: evidence.dataset.attemptId, origin: evidence.dataset.origin?.kind ?? "owned",
        datasetDigest: analysisDigestV2(evidence.dataset), runtime: runtime.identity, unitCount: null, observations: await runtime.createRetainedStructuralObservationSet(input.bundleRoot) }); }
  }
  return result;
}

/** Restricted local inspection artifact. Publication/export uses a separately reviewed sharing policy. */
export function writeAtlasViewV2(view: AtlasViewV2, outputRoot: string): void {
  mkdirSync(outputRoot, { mode: 0o700 });
  writeFileSync(join(outputRoot, "view.json"), `${JSON.stringify(view, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  const data = JSON.stringify(view).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e").replace(/&/gu, "\\u0026");
  writeFileSync(join(outputRoot, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EBO v2 Atlas</title>
<style>body{font:16px/1.5 system-ui;margin:0;background:#f6f5f0;color:#162e2c}header,main{max-width:1100px;margin:auto;padding:24px}h1{margin:0}input,button{font:inherit;padding:10px;border:1px solid #687b77;border-radius:5px}input{width:min(90%,500px)}button{cursor:pointer;background:white;text-align:left;width:100%}li{list-style:none;margin:8px 0}ul{padding:0}section{background:white;border:1px solid #b7c5c0;padding:16px;margin:16px 0;border-radius:6px}pre{max-height:32rem;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace}summary{cursor:pointer;font-weight:600}small{color:#425a55}</style>
<header><small>Engineering Behavior Observatory · Restricted local evidence</small><h1>Trajectory inspection</h1><p id="identity"></p>${view.origin.kind === "imported" ? `<p>${ATIF_TOKEN_ACCOUNTING_LABEL}</p>` : ""}<label for="search">Find units</label><br><input id="search" type="search" placeholder="Search commands, roles and tools"></header>
<main><details><summary>Measurements and coverage</summary><pre id="measures"></pre></details><p id="count" aria-live="polite"></p><ul id="units"></ul><section id="detail" hidden><h2>Evidence</h2><pre id="content"></pre></section></main>
<script id="data" type="application/json">${data}</script><script>
const view=JSON.parse(document.getElementById('data').textContent), units=document.getElementById('units'), detail=document.getElementById('detail');
document.getElementById('identity').textContent=view.runId+' / '+view.attemptId+' · '+view.origin.qualification+' · '+view.runtime.id+' '+view.runtime.version;
document.getElementById('measures').textContent=JSON.stringify({observations:view.observations.observations,coverage:view.ledger.coverage},null,2);
function render(){const q=document.getElementById('search').value.toLowerCase();units.replaceChildren();const rows=view.units.filter(u=>JSON.stringify(u).toLowerCase().includes(q));document.getElementById('count').textContent=rows.length+' of '+view.units.length+' recorded units';for(const u of rows){const li=document.createElement('li'),b=document.createElement('button');b.textContent=u.kind+' · '+u.label+(u.command?' · '+u.command.slice(0,200)+(u.command.length>200?'…':''):'');b.onclick=()=>{detail.hidden=false;document.getElementById('content').textContent=JSON.stringify({unit:u,evidence:view.evidence.filter(e=>u.eventIds.includes(e.citation.eventId))},null,2);detail.scrollIntoView({behavior:'instant',block:'start'});};li.append(b);units.append(li);}}
document.getElementById('search').addEventListener('input',render);render();</script></html>`, { flag: "wx", mode: 0o600 });
}
