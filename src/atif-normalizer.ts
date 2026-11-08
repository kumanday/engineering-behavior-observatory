import { projectAtifCore, type AtifCoreInput } from "./atif-core.js";
import { applyAtifOverlays } from "./atif-overlays.js";
import { validateNormalizedDataset } from "./normalization-integrity.js";
import { digestValue, object } from "./projection-v2.js";
import { atifPointerValue } from "./atif-reader.js";
import type { UniformEvent } from "./uniform-events.js";
import type { MeasurementV2 } from "./normalization-v2.js";
type Measure = { status: "known"; value: number; unit: string } | { status: "unavailable"; reason: string };
export type AtifMappingReport = {
  schemaVersion: "ebo.atif-core-mapping/v1"; scope: "recorded-documents"; producerStatus: "supported";
  profileDigest?: `sha256:${string}`; limitations: string[]; measurements: MeasurementV2[];
  recorded: { calls: number | null; linkedResults: number | null; copiedStepsExcluded: number | null; contextOnlyStepsExcluded: number | null };
  signatures: Array<{ document: string; operationId: string; scope: string | null; identityClass: string; id: string | null; name: string | null; failed: boolean | null }>;
  measures: Record<string, Measure>;
};
/** The compatibility view uses the same standard facts as typed v2 consumers. */
export async function normalizeAtif(input: AtifCoreInput) {
  const core = await projectAtifCore(input), enhanced = await applyAtifOverlays(core.v2, input);
  const operationsById = new Map(enhanced.dataset.operations.map((operation) => [operation.id, operation]));
  const legacyEvents = new Map(core.v1.dataset.events.map((event) => [event.id, event]));
  const events: UniformEvent[] = enhanced.dataset.events.map((typed) => {
    const { source: _source, clock: _clock, facts: _facts, ...common } = typed;
    const event: UniformEvent = legacyEvents.get(typed.id) ?? { ...common, schemaVersion: "ebo.uniform-event/v1",
      source: { harness: "atif.generic", nativeType: typed.source.nativeType, nativeReference: typed.source.nativeReference },
      nativeTime: { status: "unknown", reason: "EXECUTION_TIME_UNREPORTED" } };
    const operation = typed.scope.kind === "operation" ? operationsById.get(typed.scope.id!) : undefined;
    return { ...event, nativeOrder: typed.nativeOrder, content: typed.content, attributes: { ...event.attributes,
      ...(operation ? { toolCallId: operation.id,
        ...(operation.inputDigest.status === "known" ? { inputDigest: operation.inputDigest.value } : {}),
        ...(typed.facts.operation?.endpoint === "result" && typed.facts.operation.failure.status === "known" && typed.facts.operation.failure.value ? { isError: true } : {}),
        ...(operation.issuingInference.status === "known" ? { inferenceId: operation.issuingInference.value.id } : {}) } : {}) } };
  });
  const capabilityProfile = structuredClone(core.v1.dataset.capabilityProfile);
  for (const event of events) if (capabilityProfile.families[event.family].status === "unsupported") capabilityProfile.families[event.family] = { status: "partial", detail: "Optional overlay interpretation over retained document records." };
  const contentReferences = new Map(events.flatMap((event) => event.content.status === "known" ? event.content.value.map(({ nativeReference }) =>
    [JSON.stringify(nativeReference), { reference: nativeReference, digest: digestValue(atifPointerValue(input.read.document, nativeReference.recordLocator)) }] as const) : []));
  const dataset = { ...core.v1.dataset, events, capabilityProfile, contentReferences: [...contentReferences.values()] }, coverage = await validateNormalizedDataset(dataset, core.v1.resolver);
  const limitations = enhanced.capture.qualification === "imported" ? [...enhanced.capture.sourceLimitations ?? []] : [];
  const rootSource = enhanced.dataset.sources[0]!, root = enhanced.dataset.measurements.filter(({ scope }) => scope.id.endsWith(":#"));
  const measures: Record<string, Measure> = {};
  const aliases: Record<string, string> = { "source-tool-operation-count": "tool-operation-count", "source-tool-error-count": "tool-error-count", "source-declared-inference-count": "declared-inference-count", "pi-input-token-count": "input-token-count", "pi-output-token-count": "output-token-count", "pi-cache-read-input-token-count": "cache-read-input-token-count" };
  for (const measurement of root) {
    const id = aliases[measurement.id] ?? measurement.id;
    measures[id] = measurement.value.status === "known" && typeof measurement.value.value === "number"
      ? { status: "known", value: measurement.value.value, unit: measurement.unit } : { status: "unavailable", reason: "reason" in measurement.value ? measurement.value.reason : "NON_NUMERIC_DECLARATION" };
  }
  for (const id of ["tool-operation-count", "tool-error-count", "declared-inference-count", "input-token-count", "output-token-count", "cache-read-input-token-count", "model-request-count"]) measures[id] ??= { status: "unavailable", reason: "NOT_DECLARED_BY_CORE_OR_OVERLAY" };
  const rootOperations = enhanced.dataset.operations.filter(({ identity }) => identity.sourceId === rootSource.id);
  const calls = rootOperations.reduce((sum, op) => sum + op.callEventIds.length, 0), linked = rootOperations.filter((op) => op.callEventIds.length > 0).reduce((sum, op) => sum + op.resultEventIds.length, 0);
  const mapping: AtifMappingReport = { schemaVersion: "ebo.atif-core-mapping/v1", scope: "recorded-documents", producerStatus: "supported", limitations,
    measurements: enhanced.dataset.measurements, recorded: { calls: measures["tool-operation-count"]?.status === "known" ? calls : null,
      linkedResults: linked, copiedStepsExcluded: input.read.inspection.fieldCoverage.copiedSteps ?? 0, contextOnlyStepsExcluded: 0 },
    signatures: rootOperations.map((op) => ({ document: "#", operationId: op.id, scope: op.scope.status === "known" ? op.scope.value : null,
      identityClass: op.identity.identityClass, id: op.identity.identityClass === "ebo-derived" ? null : op.identity.nativeId, name: op.toolName.status === "known" ? op.toolName.value : null,
      failed: op.failure.status === "known" ? op.failure.value : null })), measures,
    ...(rootSource.producerProfile.status === "known" ? { profileDigest: rootSource.producerProfile.value.digest } : {}) };
  const steps = Array.isArray(input.read.document?.steps) ? input.read.document.steps : [];
  return { ...core.v1, dataset, coverage, capture: enhanced.capture, outcomeCapture: enhanced.outcomeCapture, mapping,
    overlayAdjustments: enhanced.overlayAdjustments, projection: { agentSteps: steps.flatMap((value, i) => object(value).source === "agent"
      ? [{ pointer: `#/steps/${i}`, llmCallCount: typeof object(value).llm_call_count === "number" ? Number(object(value).llm_call_count) : null }] : []) } };
}
