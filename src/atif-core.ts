import { readFileSync } from "node:fs";
import { digestBytes } from "./artifacts.js";
import { atifFeaturesForVersion, atifPointerValue, type AtifReadResult } from "./atif-reader.js";
import type { AtifProducerFingerprint } from "./atif-profiles.js";
import { createSourceEvidenceResolverV2, type RetainedBehaviorEvidenceV2 } from "./native-v2.js";
import { describeImportedDataset, validateNormalizedDataset } from "./normalization-integrity.js";
import { validateNormalizedDatasetV2, type MeasurementV2, type NormalizedDatasetV2, type UniformEventV2 } from "./normalization-v2.js";
import { buildOperationsV2, digestValue, known, messageFact, object, recordedClock, unreported, type EventProjection } from "./projection-v2.js";
import type { RetainedBehaviorEvidence } from "./retained-evidence.js";
import { UNIFORM_EVENT_FAMILIES, type AdapterCapabilityProfile, type ImportedNativeEvidence, type UniformEvent } from "./uniform-events.js";

export type AtifCoreInput = { read: AtifReadResult; producer?: AtifProducerFingerprint; runId: string; attemptId: string;
  manifestDigest: `sha256:${string}`; artifactId?: string };
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function atifCoreIdentity() {
  const modules = ["atif-core.js", "atif-reader.js", "atif-validation.js", "projection-v2.js", "native-v2.js",
    "normalization-v2.js", "normalization-integrity.js", "evidence-pointers.js", "../../schemas/normalization.v2.json",
    "../../schemas/normalization-integrity.v1.json", "../../schemas/atif-inspection.v1.json"];
  return { id: "ebo.atif-core", version: "2.0.0", implementationDigest: digestValue(modules
    .map((path) => ({ path, digest: digestBytes(readFileSync(new URL(path, import.meta.url))).value }))) };
}

/** Interpret only the standard document. Operator producer declarations never select this projector. */
export async function projectAtifCore(input: AtifCoreInput): Promise<{ v1: RetainedBehaviorEvidence; v2: RetainedBehaviorEvidenceV2 }> {
  const { inspection, document } = input.read;
  if (!document || inspection.versionPolicy.status === "unsupported" || inspection.versionPolicy.status === "unavailable" || inspection.structural.status !== "valid") {
    const diagnostic = inspection.versionPolicy.diagnostics[0] ?? inspection.structural.diagnostics[0];
    throw new Error(`ATIF core cannot project malformed or unsupported format: ${diagnostic?.code ?? "INVALID_DOCUMENT"} at ${diagnostic?.pointer ?? "#"}.`);
  }
  const artifactId = input.artifactId ?? "atif-trajectory";
  const reference = (recordLocator: string) => ({ artifactId, recordLocator });
  const capture: ImportedNativeEvidence<unknown> = { runId: input.runId, attemptId: input.attemptId, qualification: "imported",
    sourceLimitations: inspection.limitations, records: inspection.records.map(({ pointer }) => ({ reference: reference(pointer), record: atifPointerValue(document, pointer) })) };
  const resolver = createSourceEvidenceResolverV2(capture);
  const nativeTypes = new Map(capture.records.map(({ record }, index) => [record, `atif:${inspection.records[index]!.kind}`]));
  const legacy: UniformEvent[] = [], events: UniformEventV2[] = [], projections: EventProjection[] = [];
  const measurements: MeasurementV2[] = [], sources: NormalizedDatasetV2["sources"] = [];
  const aliases = new Set<string>();
  const { implementationDigest } = atifCoreIdentity();
  const emit = (pointer: string, stepPointer: string, documentPointer: string, step: Record<string, unknown>, family: UniformEvent["family"],
    phase: UniformEvent["phase"], projection: EventProjection, contentPointer?: string, attributes: UniformEvent["attributes"] = {}) => {
    const role = projection.facts.message?.role.status === "known" && projection.facts.message.role.value === "tool" || family === "tool" && phase === "after" ? "tool" : step.source === "agent" ? "model" : step.source === "user" ? "user" : step.source === "system" ? "system" : "harness";
    const trajectory = object(atifPointerValue(document, documentPointer));
    const id = `${pointer}/${family}-${phase}`, sourceId = `atif:${artifactId}:${documentPointer}`;
    const original: UniformEvent = { schemaVersion: "ebo.uniform-event/v1", id, runId: input.runId, attemptId: input.attemptId,
      source: { harness: "atif.generic", nativeType: nativeTypes.get(atifPointerValue(document, pointer)) ?? "atif:trajectory", nativeReference: reference(pointer) }, family, phase,
      nativeOrder: projection.nativeOrder ?? (phase === "after" ? { status: "unknown", reason: "RESULT_CHRONOLOGY_UNRECORDED" }
        : integer(step.step_id) ? { status: "known", domain: sourceId, value: step.step_id } : unreported), nativeTime: unreported,
      actor: { kind: role }, scope: { kind: "session", id: `document:${documentPointer}` },
      relations: { parent: unreported, known: [] }, attributes: { ...attributes, documentScope: documentPointer, stepPointer,
        ...(typeof trajectory.session_id === "string" ? { sessionId: trajectory.session_id } : {}),
        ...(typeof trajectory.trajectory_id === "string" ? { agentId: trajectory.trajectory_id } : {}) },
      content: contentPointer === undefined ? unreported : known([{ nativeReference: reference(contentPointer), role: family === "tool" ? phase === "before" ? "tool-input" : "tool-result" : "message" }]) };
    if (phase !== "after") projection.clock = recordedClock({ event: original, record: step, records: [] }, step.timestamp, "producer-observation", sourceId);
    if (family === "message" && projection.facts.message?.role.status === "known") original.attributes = { ...original.attributes, role: projection.facts.message.role.value };
    legacy.push(original);
    const { nativeTime: _time, source: _source, ...rest } = original;
    events.push({ ...rest, schemaVersion: "ebo.uniform-event/v2", source: { sourceId, nativeType: original.source.nativeType, nativeReference: original.source.nativeReference },
      clock: projection.clock, facts: projection.facts });
    projections.push(projection);
  };
  const visit = (trajectory: Record<string, unknown>, pointer: string, inheritedCopied: boolean) => {
    const features = atifFeaturesForVersion(trajectory.schema_version);
    if (!features) return;
    const scope = `document:${pointer}`, sourceId = `atif:${artifactId}:${pointer}`, agent = object(trajectory.agent);
    sources.push({ id: sourceId, format: { kind: "atif", version: String(trajectory.schema_version) },
      reader: { id: "ebo.atif-core", version: "2.0.0", implementationDigest }, producerProfile: { status: "unknown", reason: "NO_OVERLAY_APPLIED" },
      executedHarness: { id: String(agent.name), version: typeof agent.version === "string" ? known(agent.version) : unreported }, authority: "third-party" });
    if (typeof agent.model_name === "string") aliases.add(agent.model_name);
    const firstEvent = events.length;
    emit(`${pointer}/agent`, pointer, pointer, {}, "runtime", "instant", { clock: unreported, facts: {} }, `${pointer}/agent`, { sourceMetadata: true });
    let calls = 0, explicitCalls = false, inference = 0, inferenceTracked = true, agentSteps = 0;
    for (const [index, value] of array(trajectory.steps).entries()) {
      const step = object(value), sp = `${pointer}/steps/${index}`, operationScope = `${scope}/step:${step.step_id}`, copied = inheritedCopied || features.copiedContext && step.is_copied_context === true;
      const declaredInference = features.declaredInference && integer(step.llm_call_count) ? step.llm_call_count : undefined;
      if (typeof step.model_name === "string") aliases.add(step.model_name);
      if (Object.hasOwn(step, "message") && step.message !== null) emit(sp, sp, pointer, step, "message", "instant",
        { clock: unreported, facts: { message: messageFact(step.source === "agent" ? "assistant" : step.source, undefined, copied ? "duplicate" : "canonical",
          known({ id: sp, scope, identityClass: "source-declared" })) } }, `${sp}/message`, { copiedContext: copied });
      if (copied) continue;
      if (step.source === "agent") {
        agentSteps++;
        if (declaredInference !== undefined) inference += declaredInference; else inferenceTracked = false;
        emit(sp, sp, pointer, step, "runtime", "instant", { clock: unreported,
          facts: { inference: { llmCallCount: declaredInference !== undefined ? known(declaredInference) : unreported, nativeRequestId: unreported } } });
        const values = Object.fromEntries(Object.entries(object(step.metrics)).filter(([key, value]) =>
          ["prompt_tokens", "completion_tokens", "cached_tokens", "cost_usd"].includes(key) && typeof value === "number" && Number.isFinite(value) && value >= 0)) as Record<string, number>;
        if (Object.keys(values).length) emit(`${sp}/metrics`, sp, pointer, step, "runtime", "instant", { clock: unreported,
          facts: { resource: { scope: "step", populationId: known(sp), authority: "source-declared", semantics: "unknown", values } } });
      }
      if (Array.isArray(step.tool_calls)) explicitCalls = true;
      const names = new Map<string, string | undefined>();
      const callIds = new Map<string, number>();
      for (const value of array(step.tool_calls)) {
        const id = object(value).tool_call_id;
        if (typeof id === "string" && id.trim()) callIds.set(id, (callIds.get(id) ?? 0) + 1);
      }
      for (const [ci, value] of array(step.tool_calls).entries()) {
        const call = object(value), cp = `${sp}/tool_calls/${ci}`, id = typeof call.tool_call_id === "string" && call.tool_call_id.trim() ? call.tool_call_id : undefined;
        const ambiguous = id !== undefined && callIds.get(id)! > 1;
        const name = typeof call.function_name === "string" && call.function_name.trim() ? call.function_name : undefined;
        if (id !== undefined) names.set(id, names.has(id) ? undefined : name); calls++;
        emit(cp, sp, pointer, step, "tool", "before", { clock: unreported, facts: {}, operation: { nativeId: ambiguous ? undefined : id, scope: operationScope,
          identityClass: "source-declared", ...(id === undefined || ambiguous ? { scopeStatus: "record-local" as const } : {}), endpoint: "call", canonical: true, toolName: name,
          ...(Object.hasOwn(call, "arguments") && call.arguments !== null ? { inputDigest: digestValue(call.arguments) } : {}),
          issuingInference: declaredInference === 1 ? known({ id: sp, scope, identityClass: "declared-single-inference" }) : unreported } },
          Object.hasOwn(call, "arguments") && call.arguments !== null ? `${cp}/arguments` : undefined, { ...(id === undefined ? { identityUnavailable: "SOURCE_IDENTITY_UNREPORTED" } : { nativeToolCallId: id }), ...(name ? { toolName: name } : {}) });
      }
      for (const [ri, value] of array(object(step.observation).results).entries()) {
        const result = object(value), rp = `${sp}/observation/results/${ri}`;
        const id = typeof result.source_call_id === "string" && result.source_call_id.length ? result.source_call_id : undefined;
        if (id === undefined) {
          emit(rp, sp, pointer, step, "message", "instant", { clock: unreported, facts: { message: messageFact("tool", undefined, "canonical") } },
            Object.hasOwn(result, "content") && result.content !== null ? `${rp}/content` : undefined, { observationOnly: true });
          continue;
        }
        if (callIds.get(id)! > 1) {
          emit(rp, sp, pointer, step, "message", "instant", { clock: unreported, facts: { message: messageFact("tool", undefined, "canonical") } },
            Object.hasOwn(result, "content") && result.content !== null ? `${rp}/content` : undefined,
            { observationOnly: true, declaredSourceCallId: id, associationLimitation: "AMBIGUOUS_TOOL_CALL_ID" });
          continue;
        }
        emit(rp, sp, pointer, step, "tool", "after", { clock: unreported, facts: {}, operation: { nativeId: id, scope: operationScope,
          identityClass: "source-declared", scopeStatus: "established", endpoint: "result", canonical: true,
          toolName: names.get(id), failure: unreported, issuingInference: unreported } },
          Object.hasOwn(result, "content") && result.content !== null ? `${rp}/content` : undefined, { nativeToolCallId: id });
      }
    }
    for (const ref of inspection.references) {
      const owner = ref.pointer.includes("/steps/") ? ref.pointer.slice(0, ref.pointer.lastIndexOf("/steps/"))
        : ref.pointer.slice(0, ref.pointer.lastIndexOf("/"));
      if (owner !== pointer) continue;
      const stepMatch = /^(.*\/steps\/[0-9]+)/u.exec(ref.pointer);
      const stepPointer = stepMatch?.[1] ?? pointer;
      const step = object(atifPointerValue(document, stepPointer));
      emit(ref.pointer, stepPointer, pointer, step, ref.kind === "media" ? "artifact" : "context", "instant", { clock: unreported, facts: {}, nativeOrder: unreported }, ref.pointer,
        { referenceKind: ref.kind, referenceTarget: ref.target, referenceStatus: ref.status,
          ...(ref.reason ? { referenceLimitation: ref.reason } : {}), ...(ref.digest ? { referenceDigest: ref.digest } : {}) });
    }
    const finalEvents = new Map<string, string>();
    for (const [key, value] of Object.entries(object(trajectory.final_metrics))) if (typeof value === "number"
        && ["total_prompt_tokens", "total_completion_tokens", "total_cached_tokens", "total_cost_usd", "total_steps"].includes(key)) {
      const location = `${pointer}/final_metrics/${key}`;
      emit(location, pointer, pointer, {}, "runtime", "instant", { clock: unreported, facts: key === "total_steps" ? {} : {
        resource: { scope: "session", populationId: known(pointer), authority: "source-declared", semantics: "cumulative-final", values: { [key]: value } } } }, location, { declaredMetric: key });
      finalEvents.set(key, events.at(-1)!.id);
    }
    const ids = events.slice(firstEvent).map(({ id }) => id);
    const measure = (id: string, value: MeasurementV2["value"], unit: string, sourceEventIds = ids) => measurements.push({ id, value, unit,
      scope: { kind: "recorded-document", id: `${artifactId}:${pointer}` }, coverage: value.status === "known" ? "exact" : value.status === "lower-bound" ? "partial" : "unavailable", sourceEventIds });
    measure("source-tool-operation-count", calls || explicitCalls ? known(calls) : { status: "unknown", reason: "CALL_COLLECTION_UNREPORTED" }, "recorded-calls");
    measure("source-tool-error-count", { status: "unknown", reason: "TOOL_FAILURE_NOT_IN_ATIF_CORE" }, "recorded-errors");
    measure("source-declared-inference-count", agentSteps && inferenceTracked && Number.isSafeInteger(inference) ? known(inference) : { status: "unknown", reason: "DECLARED_INFERENCE_INCOMPLETE" }, "declared-inferences");
    for (const [key, value] of Object.entries(object(trajectory.final_metrics))) if (typeof value === "number"
        && ["total_prompt_tokens", "total_completion_tokens", "total_cached_tokens", "total_cost_usd", "total_steps"].includes(key)) {
      measure(`source-final-${key}`, known(value), key === "total_steps" ? "steps" : key === "total_cost_usd" ? "usd" : "tokens", [finalEvents.get(key)!]);
    }
    for (const [index, child] of array(trajectory.subagent_trajectories).entries()) visit(object(child), `${pointer}/subagent_trajectories/${index}`, inheritedCopied);
  };
  visit(document, "#", false);
  const operations = buildOperationsV2(events, projections);
  // Use the common operation identities in both consumer views.
  for (let index = 0; index < events.length; index++) legacy[index]!.scope = events[index]!.scope;
  const capabilities: AdapterCapabilityProfile = { schemaVersion: "ebo.adapter-capability-profile/v1", adapterId: "atif-core", harness: "atif.generic",
    nativeTypes: ["atif:trajectory", "atif:step", "atif:call", "atif:result", "atif:field"], families: Object.fromEntries(UNIFORM_EVENT_FAMILIES.map((family) => [family,
      { status: legacy.some((e) => e.family === family) ? "partial" : "unsupported", detail: "Recorded document content; attempt completeness remains unproven." }])) as AdapterCapabilityProfile["families"],
    evidence: { nativeOrder: { status: "partial" }, nativeTime: { status: "partial" }, parentage: { status: "partial" }, content: { status: "partial" } } };
  const used = new Set(legacy.map((e) => e.source.nativeReference.recordLocator));
  const unmappedFields = new Map(inspection.unmappedFields?.map(({ pointer, reason }) => [pointer, reason]) ?? []);
  const v1Dataset = describeImportedDataset({ capture, normalization: { events: legacy, unmapped: capture.records.filter((r) => !used.has(r.reference.recordLocator))
    .map(({ reference }) => ({ reference, reason: unmappedFields.get(reference.recordLocator) ?? "RETAINED_SOURCE_WITHOUT_CORE_EVENT" })) }, capabilityProfile: capabilities, adapterVersion: "2.0.0",
    nativeType: (record) => nativeTypes.get(record) ?? "atif:trajectory", contentDigestPolicy: "canonical-json-pointers/v1",
    contentDigest: (ref) => digestValue(atifPointerValue(document, ref.recordLocator)),
    origin: { kind: "imported", qualification: "imported", manifestDigest: input.manifestDigest, exactAttemptMeasures: "unavailable", reason: "CAPTURE_COMPLETENESS_UNPROVEN" } });
  const coverage = await validateNormalizedDataset(v1Dataset, resolver);
  const retained = { capture, resolver, modelAliases: [...aliases].sort(), outcomeCapture: { ...capture, records: capture.records.map(({ reference, record }) => ({ reference,
    record: { schemaVersion: "ebo.imported-outcome-record/v1" as const, kind: "imported-source" as const, authority: "third-party" as const, document: record } })) } };
  const eventIdsByPointer = new Map<string, string[]>();
  for (const event of events) {
    const pointer = event.source.nativeReference.recordLocator, ids = eventIdsByPointer.get(pointer) ?? [];
    ids.push(event.id); eventIdsByPointer.set(pointer, ids);
  }
  const dataset: NormalizedDatasetV2 = { schemaVersion: "ebo.normalized-dataset/v2", runId: input.runId, attemptId: input.attemptId,
    normalizer: { id: "ebo.atif-core", version: "2.0.0", implementationDigest }, origin: { kind: "imported", qualification: "imported", manifestDigest: input.manifestDigest },
    sources, events, operations, measurements, nativeRecords: [...v1Dataset.nativeRecords], contentReferences: [...v1Dataset.contentReferences],
    recordCoverage: capture.records.map(({ reference }) => {
      const eventIds = eventIdsByPointer.get(reference.recordLocator) ?? [];
      const fieldReason = unmappedFields.get(reference.recordLocator);
      return { reference, disposition: eventIds.length ? "mapped" : fieldReason ? "unmapped" : "retained-only", eventIds,
        reason: eventIds.length ? unreported : known(fieldReason ?? "RETAINED_SOURCE_WITHOUT_CORE_EVENT") };
    }) };
  await validateNormalizedDatasetV2(dataset, resolver);
  return { v1: { ...retained, dataset: v1Dataset, coverage }, v2: { ...retained, dataset } };
}
