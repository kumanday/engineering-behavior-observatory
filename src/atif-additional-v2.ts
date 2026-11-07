import { readFileSync } from "node:fs";
import { digestBytes } from "./artifacts.js";
import { normalizePiAtif } from "./atif-pi.js";
import { selectAdditionalAtifProfileV2 } from "./atif-producers-v2.js";
import { createSourceEvidenceResolverV2, type RetainedBehaviorEvidenceV2 } from "./native-v2.js";
import { validateNormalizedDatasetV2, type MeasurementV2, type NormalizedDatasetV2, type UniformEventV2 } from "./normalization-v2.js";
import { buildOperationsV2, contextFact, digestValue, known, messageFact, object, recordedClock, unreported, type EventProjection, type OperationContribution } from "./projection-v2.js";
import type { AtifProducerFingerprint } from "./atif-profiles.js";
import type { AtifReadResult } from "./atif-reader.js";
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Producer-specific interpretations over admitted bytes. No native capture authority is conferred. */
export async function projectAdditionalAtifV2(input: { read: AtifReadResult; producer: AtifProducerFingerprint; runId: string; attemptId: string;
  manifestDigest: `sha256:${string}`; artifactId?: string }): Promise<RetainedBehaviorEvidenceV2> {
  const selected = selectAdditionalAtifProfileV2(input.producer);
  if (!selected) throw new Error("ATIF v2 requires a registered producer profile.");
  const { profile } = selected;
  // The frozen v1 registry retains these sources without interpreting their producer conventions.
  const retained = await normalizePiAtif(input), document = input.read.document!;
  const sourceId = `atif:${profile.id}`, artifactId = input.artifactId ?? "atif-trajectory";
  const capture = { ...retained.capture, sourceLimitations: [...new Set([...input.read.inspection.limitations, ...profile.limitations])].sort() };
  const resolver = createSourceEvidenceResolverV2(capture), events: UniformEventV2[] = [], projections: EventProjection[] = [];
  const limitations = new Set(capture.sourceLimitations);
  const ref = (recordLocator: string) => ({ artifactId, recordLocator });
  const emit = (step: Record<string, unknown>, stepPointer: string, pointer: string, suffix: string, family: UniformEventV2["family"],
    projection: EventProjection, contentPointer?: string) => {
    const event: UniformEventV2 = { schemaVersion: "ebo.uniform-event/v2", id: `${pointer}/${suffix}`, runId: input.runId, attemptId: input.attemptId,
      source: { sourceId, nativeType: `atif:${suffix}`, nativeReference: ref(pointer) }, family,
      phase: family === "tool" ? projection.operation?.endpoint === "call" ? "before" : projection.operation?.endpoint === "result" ? "after" : "instant" : "instant",
      nativeOrder: { status: "known", domain: `${artifactId}:#`, value: Number(step.step_id) }, clock: unreported,
      actor: { kind: family === "tool" && projection.operation?.endpoint !== "call" ? "tool" : step.source === "agent" ? "model" : step.source === "user" ? "user" : "harness" },
      scope: { kind: "session", id: "document:#" }, relations: { parent: unreported, known: [] }, attributes: {},
      content: contentPointer === undefined ? unreported : known([{ nativeReference: ref(contentPointer), role: family === "tool"
        ? projection.operation?.endpoint === "call" ? "tool-input" : "tool-result" : "message" }]), facts: projection.facts };
    if (profile.family !== "hermes") {
      const clock = recordedClock({ event: { ...event, schemaVersion: "ebo.uniform-event/v1", source: { harness: profile.family, nativeType: event.source.nativeType, nativeReference: event.source.nativeReference }, nativeTime: unreported }, record: step, records: [] }, step.timestamp, "producer-observation", `${sourceId}:#`);
      if (clock.status === "known") projection.clock = known({ ...clock.value, provenance: "converter-derived", source: ref(`${stepPointer}/timestamp`) });
    }
    event.clock = projection.clock; events.push(event); projections.push(projection);
  };
  const steps = array(document.steps).map(object), frequencies = new Map<string, number>(), ordinals = new Set<number>();
  for (const step of steps) {
    if (!integer(step.step_id) || step.step_id < 1 || step.is_copied_context !== undefined && typeof step.is_copied_context !== "boolean") throw new Error("ATIF projection requires canonical step ordinals and copied-context flags.");
    if (ordinals.has(step.step_id)) throw new Error("ATIF step ordinals must be unique.");
    ordinals.add(step.step_id);
    if (profile.family === "codex" && step.llm_call_count !== undefined && step.llm_call_count !== null && !integer(step.llm_call_count)) throw new Error("Invalid declared inference count.");
    if (step.is_copied_context === true || object(step.extra).added_by === "hlb") continue;
    for (const value of array(step.tool_calls)) {
      const id = object(value).tool_call_id; if (typeof id === "string") frequencies.set(id, (frequencies.get(id) ?? 0) + 1);
    }
  }
  let gap = !!object(document.extra).partial, omitted = false;
  if (gap) limitations.add("PRODUCER_PARTIAL_HISTORY");
  if (array(document.subagent_trajectories).length) { gap = true; limitations.add("CHILD_SCOPE_UNQUALIFIED"); }
  for (const [index, step] of steps.entries()) {
    const pointer = `#/steps/${index}`, extra = object(step.extra);
    if (step.is_copied_context === true) continue;
    if (extra.added_by === "hlb") {
      gap = true; limitations.add("CONVERSION_GAP");
      emit(step, pointer, pointer, "gap", "context", { facts: { context: contextFact("conversion-gap") }, clock: unreported });
      continue;
    }
    if (profile.family === "openclaw" && object(extra.context_management).type === "compaction") {
      emit(step, pointer, pointer, "context", "context", { facts: { context: contextFact("compaction") }, clock: unreported }, `${pointer}/message`);
      continue;
    }
    // Hermes replaces empty assistant tool-call text with this literal placeholder.
    const message = step.message, placeholder = profile.family === "hermes" && message === "[tool call]" && array(step.tool_calls).length > 0;
    if ((typeof message === "string" || Array.isArray(message)) && message.length > 0 && !placeholder) {
      emit(step, pointer, pointer, "message", "message", { facts: { message: messageFact(step.source === "agent" ? "assistant" : step.source, undefined, "canonical", known({ id: pointer, scope: "document:#", identityClass: "converter-assigned" })) }, clock: unreported }, `${pointer}/message`);
    }
    const declared = profile.family === "codex" && integer(step.llm_call_count) ? known(step.llm_call_count) : unreported;
    if (step.source === "agent") emit(step, pointer, pointer, "inference", "runtime", { facts: { inference: { llmCallCount: declared, nativeRequestId: unreported } }, clock: unreported });
    const calls = array(step.tool_calls).map(object), results = array(object(step.observation).results).map(object);
    const issued = profile.family === "codex" && step.llm_call_count === 1 ? known({ id: pointer, scope: "document:#", identityClass: "declared-single-inference" as const }) : unreported;
    const callIds = new Set<string>();
    for (const [callIndex, call] of calls.entries()) {
      const id = call.tool_call_id, name = call.function_name;
      if (typeof id !== "string" || !id.trim() || typeof name !== "string" || !name.trim() || frequencies.get(id) !== 1) {
        gap = true; omitted = true; limitations.add("AMBIGUOUS_OPERATION_IDENTITY"); continue;
      }
      callIds.add(id);
      const operation: OperationContribution = { nativeId: id, scope: "document:#", identityClass: "converter-assigned", canonical: true, toolName: name, endpoint: "call", issuingInference: issued,
        ...(Object.keys(object(call.arguments)).length ? { inputDigest: digestValue(call.arguments) } : {}) };
      const callPointer = `${pointer}/tool_calls/${callIndex}`;
      emit(step, pointer, callPointer, "call", "tool", { facts: {}, clock: unreported, operation }, `${callPointer}/arguments`);
      const linked = results.map((result, resultIndex) => ({ result, resultIndex })).filter(({ result }) => result.source_call_id === id);
      const primary = linked.filter(({ result }) => !(profile.family === "openclaw" && object(result.extra).nested_tool !== undefined));
      if (primary.length !== 1 || primary[0]!.result.content === undefined || primary[0]!.result.content === null) limitations.add(primary.length > 1 ? "AMBIGUOUS_RESULT_LINK" : "PENDING_CALL");
      for (const { result, resultIndex } of linked) {
        const nested = profile.family === "openclaw" && object(result.extra).nested_tool !== undefined;
        const terminal = !nested && primary.length === 1 && result.content !== undefined && result.content !== null;
        const failure = terminal && profile.family === "openclaw" && object(result.extra).is_error === true ? known(true) : unreported;
        emit(step, pointer, `${pointer}/observation/results/${resultIndex}`, "result", "tool", { facts: {}, clock: unreported,
          operation: { ...operation, endpoint: terminal ? "result" : "observation", failure } }, result.content === undefined ? undefined : `${pointer}/observation/results/${resultIndex}/content`);
      }
    }
    if (results.some((result) => typeof result.source_call_id !== "string" || !callIds.has(result.source_call_id))) { gap = true; limitations.add("UNLINKED_OBSERVATION_RETAINED_ONLY"); }
  }
  // Usage is retained as converter-reported snapshots in separate populations. It is never treated as normalized native input tokens.
  for (const [index, step] of steps.entries()) {
    if (step.is_copied_context === true || object(step.extra).added_by === "hlb") continue;
    const values = Object.fromEntries(Object.entries(object(step.metrics)).filter(([key, value]) => ["prompt_tokens", "completion_tokens", "cached_tokens", "cost_usd"].includes(key) && typeof value === "number" && Number.isFinite(value) && value > 0));
    if (Object.keys(values).length) emit(step, `#/steps/${index}`, `#/steps/${index}`, "usage", "runtime", { facts: { resource: { scope: "step", authority: "converter", semantics: "unknown", populationId: known(`#/steps/${index}`), values: values as Record<string, number> } }, clock: unreported });
  }
  const final = Object.fromEntries(Object.entries(object(document.final_metrics)).filter(([key, value]) => ["total_prompt_tokens", "total_completion_tokens", "total_cached_tokens", "total_cost_usd"].includes(key) && typeof value === "number" && Number.isFinite(value) && value > 0));
  if (Object.keys(final).length) {
    const finalEvent: UniformEventV2 = { schemaVersion: "ebo.uniform-event/v2", id: "#/final_metrics/usage", runId: input.runId, attemptId: input.attemptId,
      source: { sourceId, nativeType: "atif:final-metrics", nativeReference: ref("#") }, family: "runtime", phase: "instant", nativeOrder: unreported, clock: unreported,
      actor: { kind: "harness" }, scope: { kind: "session", id: "document:#" }, relations: { parent: unreported, known: [] }, attributes: {}, content: unreported,
      facts: { resource: { scope: "session", authority: "converter", semantics: "unknown", populationId: known("source-reported-final:#"), values: final as Record<string, number> } } };
    events.push(finalEvent); projections.push({ facts: finalEvent.facts, clock: unreported });
  }
  const operations = buildOperationsV2(events, projections);
  const callCount = operations.filter(({ callEventIds }) => callEventIds.length).length;
  const sourceReason = gap || omitted ? "PRODUCER_PARTIAL_HISTORY" : profile.family === "codex" ? "CONVERTER_OMITS_PENDING_CALLS" : "CAPTURE_COMPLETENESS_UNPROVEN";
  const measurements: MeasurementV2[] = [{ id: "source-attempt-tool-operation-count", scope: { kind: "attempt", id: input.attemptId }, unit: "identified-logical-tool-operations",
    value: callCount > 0 ? { status: "lower-bound", value: callCount, reason: sourceReason } : { status: "unknown", reason: sourceReason }, coverage: callCount > 0 ? "partial" : "unavailable", sourceEventIds: operations.flatMap(({ callEventIds }) => callEventIds) },
    { id: "source-context-reconstruction", scope: { kind: "recorded-document", id: "#" }, unit: "availability", value: { status: "unsupported", reason: "CONTEXT_REPLACEMENT_BOUNDARIES_UNAVAILABLE" }, coverage: "unavailable", sourceEventIds: [] }];
  const nativeRecords = await Promise.all(capture.records.map(async ({ reference }) => {
    const result = await resolver.resolve(reference); if (!result || result === true) throw new Error("Unresolved ATIF record.");
    return { reference, nativeType: "atif:retained-record", digest: result.digest };
  }));
  const content = new Map<string, NormalizedDatasetV2["contentReferences"][number]>();
  for (const event of events) if (event.content.status === "known") for (const item of event.content.value) {
    const result = await resolver.resolve(item.nativeReference); if (!result || result === true) throw new Error("Unresolved ATIF content.");
    content.set(JSON.stringify(item.nativeReference), { reference: item.nativeReference, digest: result.digest });
  }
  const implementationDigest = digestValue(["atif-additional-v2.js", "atif-producers-v2.js", "atif-pi.js", "atif-profiles.js", "projection-v2.js", "normalization-v2.js", "evidence-pointers.js", "../../schemas/normalization.v2.json"].map((path) => ({ path, digest: digestBytes(readFileSync(new URL(path, import.meta.url))).value })));
  const eventIds = new Map<string, string[]>();
  for (const event of events) { const key = JSON.stringify(event.source.nativeReference); eventIds.set(key, [...eventIds.get(key) ?? [], event.id]); }
  const dataset: NormalizedDatasetV2 = { schemaVersion: "ebo.normalized-dataset/v2", runId: input.runId, attemptId: input.attemptId,
    normalizer: { id: `ebo.${profile.family}-atif-v2`, version: "2.0.0", implementationDigest }, origin: { kind: "imported", qualification: "imported", manifestDigest: input.manifestDigest },
    sources: [{ id: sourceId, format: { kind: "atif", version: input.producer.formatVersion }, reader: { id: `ebo.${profile.family}-atif-v2`, version: "2.0.0", implementationDigest },
      producerProfile: known({ id: profile.id, version: profile.version, digest: selected.digest }), executedHarness: { id: profile.family, version: input.producer.agent.version === null ? unreported : known(input.producer.agent.version) }, authority: "third-party" }],
    events, operations, measurements, nativeRecords, contentReferences: [...content.values()], recordCoverage: nativeRecords.map(({ reference }) => {
      const ids = eventIds.get(JSON.stringify(reference)) ?? [];
      return { reference, disposition: ids.length ? "mapped" : "retained-only", eventIds: ids, reason: ids.length ? unreported : known("RETAINED_ATIF_CONTEXT_OR_METADATA") };
    }) };
  await validateNormalizedDatasetV2(dataset, resolver);
  const { dataset: _dataset, coverage: _coverage, resolver: _resolver, mapping: _mapping, projection: _projection, ...base } = retained;
  capture.sourceLimitations = [...limitations].sort();
  if (retained.outcomeCapture.qualification !== "imported") throw new Error("ATIF outcome evidence must remain imported.");
  return { ...base, capture, outcomeCapture: { ...retained.outcomeCapture, sourceLimitations: capture.sourceLimitations }, dataset, resolver };
}
