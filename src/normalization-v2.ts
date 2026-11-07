import { digestMetadata, validateArtifact } from "./artifacts.js";
import type { EvidenceValue, NativeEvidenceReference, NativeEvidenceResolver, NativeOrderEvidence, UniformEvent } from "./uniform-events.js";
import type { NormalizedContentReference, NormalizedNativeRecord } from "./normalization-integrity.js";

type Hash = `sha256:${string}`;
export const NORMALIZATION_V2_VERSION = "2.0.0";
export type ClockValue = {
  timestamp: string;
  kind: "execution" | "producer-observation" | "receipt";
  domain: string;
  precisionMs: number;
  provenance: "source-recorded" | "converter-derived" | "ebo-derived";
  source: NativeEvidenceReference;
};
export type ClockEvidence = EvidenceValue<ClockValue>;
export type OrderPosition = { runId: string; attemptId: string; nativeOrder: NativeOrderEvidence };
export type ClockPosition = { runId: string; attemptId: string; clock: ClockEvidence };
export type Precedence = "before" | "after" | "same-observation" | "unknown";
export type SourceIdentityV2 = {
  id: string;
  format: { kind: "native" | "atif"; version: string };
  reader: { id: string; version: string; implementationDigest: Hash };
  producerProfile: EvidenceValue<{ id: string; version: string; digest: Hash }>;
  executedHarness: { id: string; version: EvidenceValue<string> };
  authority: "owned-capture" | "third-party";
};
export type OperationIdentity = {
  runId: string;
  attemptId: string;
  sourceId: string;
  /** An adapter-established document/session namespace; matching IDs never join unknown scopes. */
  scope: string;
  kind: "tool" | "model-request" | "delegation";
  nativeId: string;
  identityClass: "source-native" | "converter-assigned" | "ebo-derived";
};
export type Operation = {
  schemaVersion: "ebo.operation/v1";
  id: string;
  identity: OperationIdentity;
  callEventIds: string[];
  resultEventIds: string[];
  toolName: EvidenceValue<string>;
  inputDigest: EvidenceValue<Hash>;
  failure: EvidenceValue<boolean>;
  issuingInference: EvidenceValue<{ id: string; scope: string; identityClass: "native-request" | "declared-single-inference" }>;
  startOrder: NativeOrderEvidence;
  endOrder: NativeOrderEvidence;
};
export type EventFactsV2 = {
  message?: { role: EvidenceValue<"user" | "assistant" | "system" | "tool">; completeness: EvidenceValue<"complete" | "partial"> };
  context?: { type: "compaction" | "summarization" | "delegation" | "conversion-gap" | "other";
    replacementBoundary: EvidenceValue<{ previousEventId: string; nextEventId: string }> };
  inference?: { llmCallCount: EvidenceValue<number>; nativeRequestId: EvidenceValue<string> };
  resource?: { scope: "attempt" | "session" | "step" | "operation" | "child-inclusive"; authority: "native" | "converter" | "estimated" };
};
export type UniformEventV2 = Omit<UniformEvent, "schemaVersion" | "source" | "nativeTime" | "attributes"> & {
  schemaVersion: "ebo.uniform-event/v2";
  source: { sourceId: string; nativeType: string; nativeReference: NativeEvidenceReference };
  clock: ClockEvidence;
  facts: EventFactsV2;
  /** Retained source annotations; analytical consumers use typed facts and operations. */
  attributes: UniformEvent["attributes"];
};
export type MeasurementV2 = {
  id: string;
  scope: { kind: "attempt" | "recorded-document" | "recorded-operations" | "session"; id: string };
  unit: string;
  value: { status: "known"; value: string | boolean | number }
    | { status: "lower-bound"; value: number; reason: string }
    | { status: "unknown" | "unsupported"; reason: string };
  coverage: "exact" | "partial" | "unavailable";
  sourceEventIds: string[];
};
export type RecordCoverageV2 = {
  reference: NativeEvidenceReference;
  disposition: "mapped" | "retained-only" | "unmapped";
  eventIds: string[];
  reason: EvidenceValue<string>;
};
export type NormalizedDatasetV2 = {
  schemaVersion: "ebo.normalized-dataset/v2";
  runId: string;
  attemptId: string;
  normalizer: { id: string; version: string; implementationDigest: Hash };
  origin: { kind: "owned"; qualification: "qualified" | "qualified-with-gaps"; manifestDigest: Hash }
    | { kind: "imported"; qualification: "imported"; manifestDigest: Hash };
  sources: SourceIdentityV2[];
  events: UniformEventV2[];
  operations: Operation[];
  measurements: MeasurementV2[];
  nativeRecords: NormalizedNativeRecord[];
  contentReferences: NormalizedContentReference[];
  recordCoverage: RecordCoverageV2[];
};

/** Source-local precedence only. Event IDs, array positions and clocks never provide missing order. */
export function precedes(first: OrderPosition, second: OrderPosition): Precedence {
  if (first.runId !== second.runId || first.attemptId !== second.attemptId) return "unknown";
  const a = first.nativeOrder, b = second.nativeOrder;
  if (a.status !== "known" || b.status !== "known" || a.domain !== b.domain
      || !Number.isSafeInteger(a.value) || !Number.isSafeInteger(b.value) || a.value < 0 || b.value < 0) return "unknown";
  return a.value < b.value ? "before" : a.value > b.value ? "after" : "same-observation";
}

/** Recorded execution clocks can support duration only within an explicitly shared domain. */
export function executionDurationMs(firstPosition: ClockPosition, lastPosition: ClockPosition): EvidenceValue<number> {
  if (firstPosition.runId !== lastPosition.runId || firstPosition.attemptId !== lastPosition.attemptId) return {status:"unknown",reason:"DIFFERENT_EXECUTION_ATTEMPTS"};
  const start = firstPosition.clock, end = lastPosition.clock;
  if (start.status !== "known" || end.status !== "known" || start.value.kind !== "execution" || end.value.kind !== "execution"
      || start.value.domain !== end.value.domain || start.value.provenance !== "source-recorded" || end.value.provenance !== "source-recorded") {
    return { status: "unknown", reason: "COMPARABLE_RECORDED_EXECUTION_CLOCKS_REQUIRED" };
  }
  const submillisecond = (timestamp: string) => {
    const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/u.exec(timestamp)?.[1];
    return fraction !== undefined && /[1-9]/u.test(fraction.slice(3));
  };
  if (submillisecond(start.value.timestamp) || submillisecond(end.value.timestamp)) return {status:"unknown",reason:"SUBMILLISECOND_CLOCK_PRECISION_UNSUPPORTED"};
  const first = Date.parse(start.value.timestamp), last = Date.parse(end.value.timestamp);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return { status: "unknown", reason: "INVALID_OR_REVERSED_EXECUTION_CLOCKS" };
  if (start.value.precisionMs !== 0 || end.value.precisionMs !== 0) return { status: "unknown", reason: "EXACT_DURATION_UNAVAILABLE_AT_RECORDED_PRECISION" };
  return { status: "known", value: last - first };
}

/** Stable across event insertion order and unrelated source changes; scope/kind/authority participate. */
export function operationId(identity: OperationIdentity): string {
  const probe = { schemaVersion: "ebo.operation-identity/v1", ...identity };
  const errors = validateArtifact("Operation identity", probe);
  if (errors.length) throw new Error(`Invalid operation identity: ${errors[0]!.message}`);
  return `operation:${digestMetadata(probe).value}`;
}

export function datasetV2Digest(dataset: NormalizedDatasetV2): Hash { return `sha256:${digestMetadata(dataset).value}`; }

/** Validate a typed projection without interpreting native attribute aliases or trusting embedded reader code. */
export async function validateNormalizedDatasetV2(dataset: NormalizedDatasetV2, resolver: NativeEvidenceResolver): Promise<void> {
  const errors = validateArtifact("Normalized dataset v2", dataset);
  if (errors.length) throw new Error(`Invalid normalized dataset v2: ${errors[0]!.message}`);
  const sources = new Map(dataset.sources.map((source) => [source.id, source]));
  if (sources.size !== dataset.sources.length) throw new Error("Duplicate v2 source identity.");
  if (dataset.sources.some((source) => source.authority !== (dataset.origin.kind === "owned" ? "owned-capture" : "third-party"))) throw new Error("Source authority differs from the dataset origin.");
  const events = new Map(dataset.events.map((event) => [event.id, event]));
  if (events.size !== dataset.events.length) throw new Error("Duplicate v2 event identity.");
  const operations = new Map(dataset.operations.map((operation) => [operation.id, operation]));
  if (operations.size !== dataset.operations.length) throw new Error("Duplicate v2 operation identity.");
  const referenceKey = (reference: NativeEvidenceReference) => JSON.stringify([reference.artifactId, reference.recordLocator]);
  const coveringReferences = (reference: NativeEvidenceReference) => {
    const keys: string[] = []; let locator: string | undefined = reference.recordLocator;
    while (locator !== undefined) {
      keys.push(referenceKey({artifactId:reference.artifactId,recordLocator:locator}));
      if (locator === "#" || /^line:[1-9][0-9]*$/u.test(locator)) break;
      const slash = locator.lastIndexOf("/");
      if (locator.startsWith("#/")) locator = slash > 1 ? locator.slice(0, slash) : "#";
      else if (/^line:[1-9][0-9]*#\//u.test(locator)) locator = slash > locator.indexOf("#") + 1 ? locator.slice(0, slash) : locator.slice(0, locator.indexOf("#"));
      else locator = undefined;
    }
    return keys;
  };
  const inventory = new Set<string>();
  for (const record of dataset.nativeRecords) {
    const key = referenceKey(record.reference);
    if (inventory.has(key)) throw new Error("Duplicate v2 native record reference."); inventory.add(key);
  }
  const isCovered = (reference: NativeEvidenceReference) => coveringReferences(reference).some((key) => inventory.has(key));
  const resolveReference = async (reference: NativeEvidenceReference, expectedDigest?: Hash) => {
    if (!isCovered(reference)) throw new Error("V2 evidence reference is outside the digest-bound native inventory.");
    const result = await resolver.resolve(reference);
    if (!result || result === true || result.runId !== dataset.runId || result.attemptId !== dataset.attemptId
        || expectedDigest !== undefined && result.digest !== expectedDigest) throw new Error("V2 evidence reference is unresolved, cross-attempt or stale.");
  };
  for (const record of [...dataset.nativeRecords, ...dataset.contentReferences]) await resolveReference(record.reference, record.digest);
  const recordCoverage = new Map(dataset.recordCoverage.map((record) => [referenceKey(record.reference), record]));
  if (recordCoverage.size !== dataset.recordCoverage.length || recordCoverage.size !== inventory.size || [...inventory].some((key) => !recordCoverage.has(key))) throw new Error("V2 native record coverage differs from its inventory.");
  const mappedEvents = new Set<string>();
  for (const record of dataset.recordCoverage) {
    if (record.disposition === "mapped" ? !record.eventIds.length : record.eventIds.length !== 0 || record.reason.status !== "known") throw new Error("V2 native record coverage is inconsistent.");
    if (new Set(record.eventIds).size !== record.eventIds.length) throw new Error("V2 native record mapping has duplicate events.");
    for (const id of record.eventIds) {
      const event = events.get(id);
      if (!event || !coveringReferences(event.source.nativeReference).includes(referenceKey(record.reference))) throw new Error("V2 native record mapping has unresolved or unrelated events.");
      mappedEvents.add(id);
    }
  }
  for (const event of dataset.events) {
    if (event.runId !== dataset.runId || event.attemptId !== dataset.attemptId || !sources.has(event.source.sourceId)) throw new Error("V2 event source or attempt identity is unresolved.");
    if (event.facts.message && event.family !== "message" || event.facts.context && event.family !== "context") throw new Error("V2 typed facts disagree with the event family.");
    if (!mappedEvents.has(event.id)) throw new Error("V2 event is absent from its native record mapping.");
    await resolveReference(event.source.nativeReference);
    if (event.clock.status === "known") await resolveReference(event.clock.value.source);
    if (event.content.status === "known") for (const content of event.content.value) await resolveReference(content.nativeReference);
    const targets = [...event.relations.known.map(({ eventId }) => eventId), ...(event.relations.parent.status === "known" ? [event.relations.parent.value] : [])];
    if (targets.some((target) => !events.has(target))) throw new Error("V2 event relation is unresolved.");
    if (["tool", "model-request", "delegation"].includes(event.family)) {
      if (event.scope.kind !== "operation" || !event.scope.id || !operations.has(event.scope.id)) throw new Error("V2 operation-bearing event requires an explicit operation scope.");
    }
    if (event.facts.context?.replacementBoundary.status === "known") {
      const boundary = event.facts.context.replacementBoundary.value;
      if (!events.has(boundary.previousEventId) || !events.has(boundary.nextEventId)) throw new Error("V2 context boundary is unresolved.");
    }
  }
  const endpointMembership = new Map<string, {calls:Set<string>;results:Set<string>;all:Set<string>}>();
  for (const operation of dataset.operations) {
    const identity = operation.identity;
    if (operation.id !== operationId(identity) || identity.runId !== dataset.runId || identity.attemptId !== dataset.attemptId || !sources.has(identity.sourceId)) throw new Error("V2 operation identity is stale or cross-attempt.");
    if (operation.failure.status === "known" && operation.resultEventIds.length === 0) throw new Error("A pending v2 operation has no known failure result.");
    const ids = [...operation.callEventIds, ...operation.resultEventIds];
    const calls = new Set(operation.callEventIds), results = new Set(operation.resultEventIds), all = new Set(ids);
    endpointMembership.set(operation.id, {calls,results,all});
    if (!ids.length || new Set(ids).size !== ids.length) throw new Error("V2 operation endpoints are empty or duplicated.");
    for (const [order, endpoints] of [[operation.startOrder, operation.callEventIds], [operation.endOrder, operation.resultEventIds]] as const) {
      if (order.status === "known" && !endpoints.some((id) => {
        const actual = events.get(id)?.nativeOrder; return actual?.status === "known" && actual.domain === order.domain && actual.value === order.value;
      })) throw new Error("V2 operation order is not recorded by its endpoint events.");
    }
    for (const id of ids) {
      const event = events.get(id);
      if (!event || calls.has(id) && event.phase === "after" || results.has(id) && event.phase === "before"
          || event.scope.kind !== "operation" || event.scope.id !== operation.id || event.source.sourceId !== identity.sourceId || event.family !== identity.kind) throw new Error("V2 operation endpoint does not belong to its explicit scope.");
    }
  }
  for (const event of dataset.events) if (event.scope.kind === "operation") {
    const operation = operations.get(event.scope.id ?? "");
    if (!operation || !endpointMembership.get(operation.id)?.all.has(event.id)) throw new Error("V2 operation scope does not retain its event endpoint.");
  }
  const measurements = new Set<string>();
  for (const measure of dataset.measurements) {
    const key = JSON.stringify([measure.id, measure.scope.kind, measure.scope.id]);
    if (measurements.has(key)) throw new Error("Duplicate v2 measurement scope."); measurements.add(key);
    if (measure.scope.kind === "attempt" && measure.scope.id !== dataset.attemptId) throw new Error("V2 measurement belongs to a different attempt.");
    const expected = measure.value.status === "known" ? "exact" : measure.value.status === "lower-bound" ? "partial" : "unavailable";
    if (dataset.origin.kind === "imported" && measure.scope.kind === "attempt" && measure.value.status === "known") throw new Error("Imported evidence cannot assert exact complete-attempt measurements.");
    if (measure.coverage !== expected || measure.sourceEventIds.some((id) => !events.has(id))) throw new Error("V2 measurement coverage or citation is inconsistent.");
  }
  // Parentage is source evidence. Cycles cannot be repaired with display order.
  const resolved = new Set<string>();
  for (const event of dataset.events) {
    const visiting = new Set<string>(); let current: UniformEventV2 | undefined = event;
    while (current && !resolved.has(current.id)) {
      if (visiting.has(current.id)) throw new Error("V2 parent relation cycle."); visiting.add(current.id);
      current = current.relations.parent.status === "known" ? events.get(current.relations.parent.value) : undefined;
    }
    for (const id of visiting) resolved.add(id);
  }
}
