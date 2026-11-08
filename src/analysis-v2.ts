import { digestMetadata, validateArtifact } from "./artifacts.js";
import { datasetV2Digest, validateNormalizedDatasetV2, type MeasurementV2, type NormalizedDatasetV2, type Operation, type UniformEventV2 } from "./normalization-v2.js";
import type { NativeEvidenceReference, NativeEvidenceResolver } from "./uniform-events.js";
import type { SourceEvidenceResolverV2 } from "./native-v2.js";
import { visibleEvidence } from "./evidence-projection.js";

export type HashV2 = `sha256:${string}`;
export const ANALYSIS_V2_VERSION = "2.0.0";
export const analysisDigestV2 = (value: unknown): HashV2 => `sha256:${digestMetadata(value).value}`;
export type EvidenceCitationV2 = { eventId: string; nativeReference: NativeEvidenceReference; digest: HashV2 };
export type ObservationV2 = Omit<MeasurementV2, "id"> & {
  schemaVersion: "ebo.structural-observation/v2";
  id: string;
  measure: string;
  definition: string;
  citations: EvidenceCitationV2[];
};
export type ObservationSetV2 = {
  schemaVersion: "ebo.structural-observation-set/v2";
  runId: string;
  attemptId: string;
  extractorVersion: typeof ANALYSIS_V2_VERSION;
  dataset: { schemaVersion: "ebo.normalized-dataset/v2"; digest: HashV2 };
  origin: NormalizedDatasetV2["origin"];
  observations: ObservationV2[];
};
export const referenceKeyV2 = (reference: NativeEvidenceReference): string => JSON.stringify([reference.artifactId, reference.recordLocator]);

export function operationScopeV2(operation: Operation): string | undefined {
  if (operation.scope.status !== "known") return undefined;
  return operation.issuingInference.status === "known" ? operation.issuingInference.value.scope : operation.scope.value;
}
export function operationEventsV2(dataset: NormalizedDatasetV2, operation: Operation): UniformEventV2[] {
  const ids = new Set([...operation.callEventIds, ...operation.resultEventIds, ...operation.observationEventIds ?? []]);
  return dataset.events.filter(({ id }) => ids.has(id));
}

/** Consumers read normalized content roles; absent roles stay unavailable. */
export function operationContentV2(dataset: NormalizedDatasetV2, operation: Operation, resolver: SourceEvidenceResolverV2,
  role: "tool-input" | "tool-result" | "tool-error"): { values: unknown[]; citations: Array<{ eventId: string; nativeReference: NativeEvidenceReference }> } {
  const values: unknown[] = [], citations: Array<{ eventId: string; nativeReference: NativeEvidenceReference }> = [];
  const retained = new Set<string>();
  for (const event of operationEventsV2(dataset, operation)) if (event.content.status === "known") for (const content of event.content.value) {
    if (content.role !== role) continue;
    const key = referenceKeyV2(content.nativeReference); if (retained.has(key)) continue; retained.add(key);
    const value = resolver.read(content.nativeReference); if (value === undefined) continue;
    values.push(visibleEvidence(value)); citations.push({ eventId: event.id, nativeReference: content.nativeReference });
  }
  return { values, citations };
}

export async function citeEventV2(dataset: NormalizedDatasetV2, resolver: NativeEvidenceResolver, eventId: string,
  reference?: NativeEvidenceReference): Promise<EvidenceCitationV2> {
  const event = dataset.events.find(({ id }) => id === eventId);
  if (!event) throw new Error("V2 citation names an unknown event.");
  const selected = reference ?? event.source.nativeReference;
  const permitted = [event.source.nativeReference, ...event.content.status === "known" ? event.content.value.map(({ nativeReference }) => nativeReference) : []];
  if (!permitted.some((reference) => referenceKeyV2(reference) === referenceKeyV2(selected))) throw new Error("V2 citation does not belong to its named event.");
  const resolution = await resolver.resolve(selected);
  if (!resolution || resolution === true || resolution.runId !== dataset.runId || resolution.attemptId !== dataset.attemptId) throw new Error("V2 citation is unresolved or belongs to another attempt.");
  return { eventId, nativeReference: structuredClone(selected), digest: resolution.digest };
}
export async function validateCitationV2(dataset: NormalizedDatasetV2, resolver: NativeEvidenceResolver, citation: EvidenceCitationV2): Promise<void> {
  const resolved = await citeEventV2(dataset, resolver, citation.eventId, citation.nativeReference);
  if (resolved.digest !== citation.digest) throw new Error("V2 citation pointed-value digest is stale.");
}

export async function createStructuralObservationSetV2(dataset: NormalizedDatasetV2, resolver: NativeEvidenceResolver): Promise<ObservationSetV2> {
  await validateNormalizedDatasetV2(dataset, resolver);
  if (dataset.origin.kind === "imported") {
    const observations: ObservationV2[] = [];
    for (const source of dataset.sources) {
      const events = dataset.events.filter((event) => event.source.sourceId === source.id);
      const ids = new Set(events.map(({ id }) => id));
      const document = source.id.slice(source.id.indexOf(":#") + 1);
      const population = { ...dataset, events, operations: dataset.operations.filter((operation) => operation.identity.sourceId === source.id),
        measurements: dataset.measurements.filter((measurement) => measurement.scope.id.endsWith(`:${document}`) || measurement.sourceEventIds.some((id) => ids.has(id))) };
      observations.push(...await deriveStructuralObservationsV2(population, resolver, { kind: "recorded-document", id: source.id }));
    }
    return { schemaVersion: "ebo.structural-observation-set/v2", runId: dataset.runId, attemptId: dataset.attemptId, extractorVersion: ANALYSIS_V2_VERSION,
      dataset: { schemaVersion: dataset.schemaVersion, digest: datasetV2Digest(dataset) }, origin: structuredClone(dataset.origin), observations };
  }
  return { schemaVersion: "ebo.structural-observation-set/v2", runId: dataset.runId, attemptId: dataset.attemptId, extractorVersion: ANALYSIS_V2_VERSION,
    dataset: { schemaVersion: dataset.schemaVersion, digest: datasetV2Digest(dataset) }, origin: structuredClone(dataset.origin),
    observations: await deriveStructuralObservationsV2(dataset, resolver, { kind: "recorded-operations", id: `${dataset.runId}/${dataset.attemptId}` }) };
}
async function deriveStructuralObservationsV2(dataset: NormalizedDatasetV2, resolver: NativeEvidenceResolver, scope: MeasurementV2["scope"]): Promise<ObservationV2[]> {
  const observations: ObservationV2[] = [], events = new Map(dataset.events.map((event) => [event.id, event]));
  const add = async (measure: string, definition: string, unit: string, value: MeasurementV2["value"], ids: readonly string[], population = scope) => {
    const sourceEventIds = [...new Set(ids)].sort(), citations = await Promise.all(sourceEventIds.map((id) => citeEventV2(dataset, resolver, id)));
    observations.push({ schemaVersion: "ebo.structural-observation/v2", id: `observation:${analysisDigestV2({ runId: dataset.runId, attemptId: dataset.attemptId, measure, population, version: ANALYSIS_V2_VERSION }).slice(7)}`,
      measure, definition, scope: population, unit, value, coverage: value.status === "known" ? "exact" : value.status === "lower-bound" ? "partial" : "unavailable", sourceEventIds, citations });
  };
  const endpoints = (operations: readonly Operation[]) => operations.flatMap((operation) => [...operation.callEventIds, ...operation.resultEventIds, ...operation.observationEventIds ?? []]);
  const tools = dataset.operations.filter(({ identity }) => identity.kind === "tool"), identified = tools.filter((operation) => operation.scope.status === "known" && operation.identity.identityClass !== "ebo-derived");
  const count = (value: number, complete: boolean, reason: string): MeasurementV2["value"] => complete ? { status: "known", value }
    : value > 0 ? { status: "lower-bound", value, reason } : { status: "unknown", reason };
  await add("tool-operation-count", "Source-identified logical tool operations represented in the normalized operation population.", "identified-logical-tool-operations",
    identified.length ? count(identified.length, identified.length === tools.length, "UNIDENTIFIED_OPERATION_RECORDS") : { status: "unknown", reason: "NO_IDENTIFIED_TOOL_OPERATION_POPULATION" }, endpoints(tools));
  const failed = identified.filter(({ failure }) => failure.status === "known" && failure.value);
  await add("tool-error-count", "Identified recorded tool operations with explicit native failure evidence.", "logical-tool-operations",
    tools.length ? count(failed.length, identified.length === tools.length && identified.every(({ failure }) => failure.status === "known"), "OPERATION_FAILURE_UNREPORTED")
      : { status: "unknown", reason: "NO_IDENTIFIED_TOOL_OPERATION_POPULATION" }, endpoints(failed));
  const requests = dataset.operations.filter(({ identity }) => identity.kind === "model-request"), nativeRequests = requests.filter((operation) => operation.scope.status === "known" && operation.identity.identityClass === "source-native");
  await add("native-request-count", "Recorded request identities supplied by the source producer.", "native-request-identities",
    nativeRequests.length ? count(nativeRequests.length, nativeRequests.length === requests.length, "REQUEST_IDENTITIES_UNREPORTED") : { status: "unknown", reason: "SOURCE_NATIVE_REQUEST_IDENTITIES_UNREPORTED" }, endpoints(nativeRequests));
  await add("observed-request-boundary-count", "Recorded model-request operations, including explicitly EBO-derived observation identities.", "request-observations",
    requests.length ? { status: "known", value: requests.length } : { status: "unknown", reason: "NO_RECORDED_REQUEST_BOUNDARIES" }, endpoints(requests));
  const inferences = new Map<string, { value: number; events: string[] }>(); let inferenceConflict = false, inferenceUnknown = false;
  for (const event of dataset.events) {
    const fact = event.facts.inference; if (!fact) continue;
    if (fact.llmCallCount.status !== "known") { inferenceUnknown = true; continue; }
    const message = event.facts.message?.identity;
    const key = message?.status === "known" ? JSON.stringify([event.source.sourceId, message.value]) : referenceKeyV2(event.source.nativeReference);
    const previous = inferences.get(key);
    if (previous && previous.value !== fact.llmCallCount.value) inferenceConflict = true;
    inferences.set(key, { value: fact.llmCallCount.value, events: [...previous?.events ?? [], event.id] });
  }
  const inferenceCount = [...inferences.values()].reduce((total, value) => total + value.value, 0);
  await add("declared-inference-count", "Source-declared inference counts, deduplicated by normalized message identity or source record.", "declared-inferences",
    inferenceConflict ? { status: "unknown", reason: "CONFLICTING_DECLARED_INFERENCE_COUNTS" }
      : inferences.size ? count(inferenceCount, !inferenceUnknown, "SOME_INFERENCE_COUNTS_UNREPORTED") : { status: "unknown", reason: "SOURCE_INFERENCE_COUNTS_UNREPORTED" }, [...inferences.values()].flatMap(({ events }) => events));
  const groups = new Map<string, Operation[]>(); let repetitionIncomplete = false;
  for (const operation of identified) {
    const population = operationScopeV2(operation);
    if (!population || operation.toolName.status !== "known" || operation.inputDigest.status !== "known") { repetitionIncomplete = true; continue; }
    const key = JSON.stringify([operation.identity.sourceId, population, operation.toolName.value, operation.inputDigest.value]);
    groups.set(key, [...groups.get(key) ?? [], operation]);
  }
  const repeated = [...groups.values()].filter((group) => group.length > 1);
  await add("repeated-tool-operation-count", "Recorded identified operations beyond one per common scope, tool name and canonical input digest.", "logical-tool-operations",
    tools.length ? count(repeated.reduce((sum, group) => sum + group.length - 1, 0), !repetitionIncomplete && identified.length === tools.length, "SOME_OPERATION_SIGNATURES_UNREPORTED")
      : { status: "unknown", reason: "NO_IDENTIFIED_TOOL_OPERATION_POPULATION" }, endpoints(repeated.flat()));
  for (const type of ["compaction", "summarization", "conversion-gap"] as const) {
    const selected = dataset.events.filter(({ facts }) => facts.context?.type === type), references = new Set(selected.map(({ source }) => referenceKeyV2(source.nativeReference)));
    await add(`context-${type}-record-count`, `Recorded context events explicitly typed as ${type}.`, "native-records",
      selected.length ? { status: "known", value: references.size } : { status: "unknown", reason: "CONTEXT_POPULATION_COMPLETENESS_UNREPORTED" }, selected.map(({ id }) => id), dataset.origin.kind === "imported" ? scope : { kind: "recorded-document", id: `${dataset.runId}/${dataset.attemptId}` });
  }
  for (const measurement of dataset.measurements) {
    if (observations.some((observation) => observation.measure === measurement.id && analysisDigestV2(observation.scope) === analysisDigestV2(measurement.scope))) throw new Error("V2 source and derived measurements declare the same population.");
    await add(measurement.id, "Source measurement retained with its declared population and coverage.", measurement.unit, measurement.value, measurement.sourceEventIds, measurement.scope);
  }
  await resourceObservationsV2(dataset, add);
  for (const observation of observations) if (observation.sourceEventIds.some((id) => !events.has(id))) throw new Error("V2 observation source event is unresolved.");
  return observations;
}

async function resourceObservationsV2(dataset: NormalizedDatasetV2, add: (measure: string, definition: string, unit: string, value: MeasurementV2["value"], ids: readonly string[], population?: MeasurementV2["scope"]) => Promise<void>): Promise<void> {
  const groups = new Map<string, { scope: MeasurementV2["scope"]; dimension: string; semantics: string; authority: string; seen: Set<string>; rows: Array<{ event: UniformEventV2; value: number }> }>();
  for (const event of dataset.events) {
    const resource = event.facts.resource; if (!resource) continue;
    const population: MeasurementV2["scope"] = dataset.origin.kind === "imported" ? { kind: "recorded-document", id: `${event.source.sourceId}/${resource.scope}:${resource.populationId.status === "known" ? resource.populationId.value : referenceKeyV2(event.source.nativeReference)}` } : resource.scope === "attempt" && resource.populationId.status === "known"
      ? { kind: "attempt", id: resource.populationId.value }
      : resource.scope === "session" && resource.populationId.status === "known" ? { kind: "session", id: `${event.source.sourceId}/${resource.populationId.value}` }
        : { kind: "recorded-document", id: resource.populationId.status === "known" ? `${event.source.sourceId}/${resource.scope}:${resource.populationId.value}` : `${event.source.sourceId}/${referenceKeyV2(event.source.nativeReference)}` };
    for (const [dimension, value] of Object.entries(resource.values)) {
      const key = JSON.stringify([event.source.sourceId, population, dimension, resource.semantics, resource.authority]);
      const group = groups.get(key) ?? { scope: population, dimension, semantics: resource.semantics, authority: resource.authority, seen: new Set<string>(), rows: [] };
      const ref = referenceKeyV2(event.source.nativeReference);
      if (!group.seen.has(ref)) { group.seen.add(ref); group.rows.push({ event, value }); }
      groups.set(key, group);
    }
  }
  for (const group of groups.values()) {
    let value: MeasurementV2["value"];
    if (group.semantics === "increment") value = { status: "known", value: group.rows.reduce((sum, row) => sum + row.value, 0) };
    else if (group.semantics === "cumulative-final") value = new Set(group.rows.map(({ value }) => value)).size === 1
      ? { status: "known", value: group.rows[0]!.value } : { status: "unknown", reason: "CONFLICTING_FINAL_RESOURCE_TOTALS" };
    else if (group.rows.length === 1) value = { status: "known", value: group.rows[0]!.value };
    else value = { status: "unknown", reason: "MULTIPLE_RESOURCE_SNAPSHOTS_WITHOUT_A_FINAL_BOUNDARY" };
    if (dataset.origin.kind === "imported" && group.scope.kind === "attempt") value = { status: "unknown", reason: "IMPORTED_COMPLETE_ATTEMPT_RESOURCE_UNAVAILABLE" };
    const unit = /cost|credits/iu.test(group.dimension) ? /usd/iu.test(group.dimension) ? "usd" : "credits" : "tokens";
    await add(`resource-${group.dimension}-${group.semantics}-${group.authority}`, `${group.authority} resource values within one declared population; cumulative snapshots and increments remain separate.`, unit, value, group.rows.map(({ event }) => event.id), group.scope);
  }
}

export async function validateStructuralObservationSetV2(report: ObservationSetV2, dataset: NormalizedDatasetV2, resolver: NativeEvidenceResolver): Promise<void> {
  if (validateArtifact("V2 observation set", report).length) throw new Error("Invalid v2 observation set.");
  if (report.runId !== dataset.runId || report.attemptId !== dataset.attemptId || report.dataset.digest !== datasetV2Digest(dataset)
      || analysisDigestV2(report.origin) !== analysisDigestV2(dataset.origin)) throw new Error("V2 observation set belongs to a different dataset or origin.");
  const ids = new Set<string>();
  for (const observation of report.observations) {
    if (ids.has(observation.id)) throw new Error("Duplicate v2 observation identity."); ids.add(observation.id);
    const expected = observation.value.status === "known" ? "exact" : observation.value.status === "lower-bound" ? "partial" : "unavailable";
    if (observation.coverage !== expected || observation.citations.some(({ eventId }) => !observation.sourceEventIds.includes(eventId))) throw new Error("V2 observation coverage or citation is inconsistent.");
    for (const citation of observation.citations) await validateCitationV2(dataset, resolver, citation);
  }
  if (analysisDigestV2(report) !== analysisDigestV2(await createStructuralObservationSetV2(dataset, resolver))) throw new Error("V2 structural measurements differ from their declared extractor and dataset.");
}
