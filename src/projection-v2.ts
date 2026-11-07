import { digestMetadata } from "./artifacts.js";
import { operationId, type ClockEvidence, type EventFactsV2, type Operation, type OperationIdentity, type UniformEventV2 } from "./normalization-v2.js";
import type { CapturedNativeRecord, ContentReference, EvidenceValue, NativeOrderEvidence, UniformEvent } from "./uniform-events.js";

export const unreported = { status: "unknown", reason: "SOURCE_UNREPORTED" } as const;
export const known = <T>(value: T): EvidenceValue<T> => ({ status: "known", value });
export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
export const digestValue = (value: unknown): `sha256:${string}` => `sha256:${digestMetadata(value).value}`;
export type ProjectionContext = { event: UniformEvent; record: Record<string, unknown>; records: readonly Record<string, unknown>[] };
export type OperationContribution = {
  nativeId?: string;
  scope: string;
  scopeStatus?: "established" | "record-local";
  identityClass?: OperationIdentity["identityClass"];
  endpoint: "call" | "result" | "observation";
  canonical?: boolean;
  toolName?: string;
  inputDigest?: `sha256:${string}`;
  failure?: EvidenceValue<boolean>;
  issuingInference?: Operation["issuingInference"];
};
export type EventProjection = {
  facts: EventFactsV2;
  clock: ClockEvidence;
  operation?: OperationContribution;
  family?: UniformEvent["family"];
  phase?: UniformEvent["phase"];
  nativeOrder?: NativeOrderEvidence;
  content?: EvidenceValue<readonly ContentReference[]>;
  association?: { nativeId: string; scope: string; kind: OperationIdentity["kind"]; identityClass?: OperationIdentity["identityClass"] };
};
export type NativeProjectionProfile = {
  id: string;
  version: string;
  harness: string;
  module: string;
  project(context: ProjectionContext): EventProjection;
  expand?(context: ProjectionContext): UniformEvent[];
  additional?(population: ProjectionPopulation): UniformEvent[];
};
export type ProjectionPopulation = { runId: string; attemptId: string; records: readonly CapturedNativeRecord<unknown>[]; events: readonly UniformEvent[] };
export function subrecordLocator(locator: string, pointer: string): string {
  if (!pointer.startsWith("/") || !(locator === "#" || locator.startsWith("#/") || /^line:[1-9][0-9]*(?:#\/.*)?$/u.test(locator))) throw new Error("Invalid native subrecord locator.");
  return locator.startsWith("line:") && !locator.includes("#") ? `${locator}#${pointer}` : `${locator}${pointer}`;
}

export function supplementalEvent(population: ProjectionPopulation, captured: CapturedNativeRecord<unknown>, options: {
  harness: string; id: string; nativeType: string; family: UniformEvent["family"]; phase: UniformEvent["phase"];
  nativeOrder: NativeOrderEvidence; contentPointer?: string;
}): UniformEvent {
  return { schemaVersion: "ebo.uniform-event/v1", id: options.id, runId: population.runId, attemptId: population.attemptId,
    source: { harness: options.harness, nativeType: options.nativeType, nativeReference: captured.reference }, nativeOrder: options.nativeOrder,
    nativeTime: unreported, actor: { kind: "harness" }, family: options.family, phase: options.phase,
    scope: { kind: "attempt", id: population.attemptId }, relations: { parent: unreported, known: [] }, attributes: {},
    content: options.contentPointer ? known([{ nativeReference: { ...captured.reference, recordLocator: subrecordLocator(captured.reference.recordLocator, options.contentPointer) } }]) : unreported };
}

/** Timestamp presence records a clock observation; source profiles must explicitly qualify execution time. */
export function recordedClock(context: ProjectionContext, timestamp: unknown, kind: "receipt" | "producer-observation" | "execution", domain: string): ClockEvidence {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    const date = new Date(timestamp); timestamp = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) return unreported;
  const match = /^(\d{4})-(\d\d)-(\d\d)[Tt](\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:[Zz]|[+-](\d\d):(\d\d))$/u.exec(timestamp);
  if (!match) return unreported;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || hour >= 24 || minute >= 60 || second >= 60
      || match[7] !== undefined && (Number(match[7]) >= 24 || Number(match[8]) >= 60)) return unreported;
  const fraction = /\.(\d+)(?:[Zz]|[+-]\d\d:\d\d)$/u.exec(timestamp)?.[1];
  return known({ timestamp, kind, domain, precisionMs: fraction ? 1000 / 10 ** fraction.length : 1000,
    provenance: "source-recorded", source: context.event.source.nativeReference });
}

export function messageFact(role: unknown, complete: boolean | undefined, representation: NonNullable<EventFactsV2["message"]>["representation"],
  identity: NonNullable<EventFactsV2["message"]>["identity"] = unreported): EventFactsV2["message"] {
  return { role: ["user", "assistant", "system", "tool"].includes(String(role)) ? known(role as "user" | "assistant" | "system" | "tool") : unreported,
    completeness: complete === undefined ? unreported : known(complete ? "complete" : "partial"), representation, identity };
}
export function pointedContent(context: ProjectionContext, pointer: string, role: "tool-input" | "tool-result"): EvidenceValue<readonly ContentReference[]> {
  return known([{ nativeReference: { ...context.event.source.nativeReference,
    recordLocator: subrecordLocator(context.event.source.nativeReference.recordLocator, pointer) }, role, mediaType: "application/json" }]);
}
export function contextFact(type: NonNullable<EventFactsV2["context"]>["type"]): EventFactsV2["context"] {
  return { type, replacementBoundary: unreported };
}
export function resultFailure(value: unknown, exitCode?: unknown): EvidenceValue<boolean> {
  if (value === true || typeof exitCode === "number" && Number.isSafeInteger(exitCode) && exitCode !== 0) return known(true);
  if (typeof exitCode === "number" && Number.isSafeInteger(exitCode)) return known(exitCode !== 0);
  if (typeof value === "boolean") return known(value);
  return unreported;
}
export function resources(values: Record<string, unknown>, scope: NonNullable<EventFactsV2["resource"]>["scope"], semantics: NonNullable<EventFactsV2["resource"]>["semantics"], populationId: NonNullable<EventFactsV2["resource"]>["populationId"] = unreported): EventFactsV2["resource"] {
  const retained = Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0)) as Record<string, number>;
  return Object.keys(retained).length ? { scope, authority: "native", semantics, values: retained, populationId } : undefined;
}

type Contribution = { event: UniformEventV2; contribution: OperationContribution };
/** One builder owns identity, endpoint membership and disagreement handling for every source adapter. */
export function buildOperationsV2(events: UniformEventV2[], projections: readonly EventProjection[]): Operation[] {
  if (events.length !== projections.length) throw new Error("V2 projection count differs from its event population.");
  const groups = new Map<string, { identity: OperationIdentity; contributions: Contribution[] }>();
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!, contribution = projections[index]!.operation;
    if (!["tool", "model-request", "delegation"].includes(event.family)) {
      // An original native operation scope cannot leak an unregistered ID into v2.
      if (event.scope.kind === "operation") event.scope = { kind: "attempt", id: event.attemptId };
      continue;
    }
    if (!contribution) throw new Error(`V2 source adapter omitted operation semantics for ${event.id}.`);
    const identity: OperationIdentity = { runId: event.runId, attemptId: event.attemptId, sourceId: event.source.sourceId,
      scope: contribution.scope, kind: event.family as OperationIdentity["kind"],
      nativeId: contribution.nativeId ?? event.id, identityClass: contribution.nativeId ? contribution.identityClass ?? "source-native" : "ebo-derived" };
    const id = operationId(identity);
    event.scope = { kind: "operation", id };
    event.facts.operation = { endpoint: contribution.endpoint, failure: contribution.endpoint === "result" ? contribution.failure ?? unreported : unreported };
    const group = groups.get(id) ?? { identity, contributions: [] };
    group.contributions.push({ event, contribution }); groups.set(id, group);
  }
  const select = <T>(values: Array<EvidenceValue<T> | undefined>): EvidenceValue<T> => {
    const supplied = values.filter((value): value is { status: "known"; value: T } => value?.status === "known");
    if (!supplied.length) return unreported;
    return new Set(supplied.map(({ value }) => digestValue(value))).size === 1 ? structuredClone(supplied[0]!) : { status: "unknown", reason: "CONFLICTING_SOURCE_OBSERVATIONS" };
  };
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!, association = projections[index]!.association;
    if (!association || ["tool", "model-request", "delegation"].includes(event.family)) continue;
    const id = operationId({ runId: event.runId, attemptId: event.attemptId, sourceId: event.source.sourceId,
      ...association, identityClass: association.identityClass ?? "source-native" });
    if (groups.has(id)) event.scope = { kind: "operation", id };
  }
  const order = (values: Contribution[]): NativeOrderEvidence => {
    const canonical = values.filter(({ contribution }) => contribution.canonical);
    const candidates = (canonical.length ? canonical : values).map(({ event }) => event.nativeOrder);
    if (!candidates.length || candidates.some((value) => value.status !== "known")) return unreported;
    const orders = candidates as Array<{ status: "known"; domain: string; value: number }>;
    return new Set(orders.map(({ domain }) => domain)).size === 1 ? structuredClone(orders.reduce((first, current) => current.value < first.value ? current : first)) : { status: "unknown", reason: "INCOMPARABLE_ENDPOINT_ORDER_DOMAINS" };
  };
  return [...groups].map(([id, { identity, contributions }]): Operation => {
    const calls = contributions.filter(({ contribution }) => contribution.endpoint === "call");
    const results = contributions.filter(({ contribution }) => contribution.endpoint === "result");
    return { schemaVersion: "ebo.operation/v1", id, identity,
      scope: contributions.every(({ contribution }) => contribution.nativeId && contribution.scopeStatus !== "record-local") ? known(identity.scope) : { status: "unknown", reason: "UNESTABLISHED_LOGICAL_OPERATION_SCOPE" },
      callEventIds: calls.map(({ event }) => event.id), resultEventIds: results.map(({ event }) => event.id),
      observationEventIds: contributions.filter(({ contribution }) => contribution.endpoint === "observation").map(({ event }) => event.id),
      toolName: select(contributions.map(({ contribution }) => contribution.toolName ? known(contribution.toolName) : undefined)),
      inputDigest: select(contributions.map(({ contribution }) => contribution.inputDigest ? known(contribution.inputDigest) : undefined)),
      failure: results.length ? select(results.map(({ contribution }) => contribution.failure)) : unreported,
      issuingInference: select(contributions.map(({ contribution }) => contribution.issuingInference)), startOrder: order(calls), endOrder: order(results) };
  }).sort((first, second) => first.id.localeCompare(second.id));
}
