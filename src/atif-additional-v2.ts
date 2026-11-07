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

/** The converter can collapse raw custom input or malformed function arguments into an object wrapper. */
function codexInput(extra: Record<string, unknown>, call: Record<string, unknown>, id: string, stepPointer: string, callPointer: string, callCount: number): { inputDigest?: `sha256:${string}`; contentPointer?: string } {
  const details = object(object(extra.tool_call_details)[id]);
  const detailed = typeof details.raw_arguments === "string";
  const raw = detailed ? details.raw_arguments : callCount === 1 ? extra.raw_arguments : undefined;
  if (typeof raw !== "string") return {};
  const escaped = id.replaceAll("~", "~0").replaceAll("/", "~1");
  const rawPointer = detailed ? `${stepPointer}/extra/tool_call_details/${escaped}/raw_arguments` : `${stepPointer}/extra/raw_arguments`;
  const itemType = details.item_type;
  if (!raw.length || !["function_call", "custom_tool_call"].includes(String(itemType))) return { contentPointer: rawPointer };
  let value: unknown = raw, encoding = "raw", contentPointer = rawPointer;
  if (itemType === "function_call") {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { /* Exact retained raw input remains available. */ }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (digestValue(parsed) !== digestValue(call.arguments)) return { contentPointer: rawPointer };
      value = parsed; encoding = "json-object"; contentPointer = `${callPointer}/arguments`;
    }
  }
  return { inputDigest: digestValue({ itemType, encoding, value }), contentPointer };
}

function codexOriginalCall(extra: Record<string, unknown>, call: Record<string, unknown>): boolean {
  const itemType = object(object(extra.tool_call_details)[String(call.tool_call_id)]).item_type;
  return itemType === "function_call" || itemType === "custom_tool_call"
    || call.function_name === "web_search_call" && Object.hasOwn(object(call.arguments), "action_type");
}

function codexOutputProven(step: Record<string, unknown>): boolean {
  return typeof step.message === "string" && step.message.length > 0 || Array.isArray(step.message) && step.message.length > 0
    || typeof step.reasoning_content === "string" && step.reasoning_content.length > 0
    || array(step.tool_calls).map(object).some((call) => codexOriginalCall(object(step.extra), call));
}

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
      nativeOrder: profile.family === "codex" ? { status: "unknown", reason: "CONVERTER_REORDERS_MODEL_OUTPUTS" }
        : projection.operation && projection.operation.endpoint !== "call" ? { status: "unknown", reason: "CONVERTER_RESULT_ORDER_UNESTABLISHED" }
        : { status: "known", domain: `${artifactId}:#`, value: Number(step.step_id) }, clock: unreported,
      actor: { kind: family === "tool" && projection.operation?.endpoint !== "call" ? "tool" : step.source === "agent" ? "model" : step.source === "user" ? "user" : "harness" },
      scope: { kind: "session", id: "document:#" }, relations: { parent: unreported, known: [] }, attributes: { convertedStepId: Number(step.step_id) },
      content: contentPointer === undefined ? unreported : known([{ nativeReference: ref(contentPointer), role: family === "tool"
        ? projection.operation?.endpoint === "call" ? "tool-input" : "tool-result" : "message" }]), facts: projection.facts };
    if (profile.family !== "hermes" && (!projection.operation || projection.operation.endpoint === "call")) {
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
  // The converter can flush one generated API group into multiple ATIF steps around user/system records.
  const inferenceGroups = new Map<string, { anchor: number; proven: boolean; single: boolean }>();
  if (profile.family === "codex") for (const [index, step] of steps.entries()) {
    if (step.source !== "agent" || step.is_copied_context === true || object(step.extra).added_by === "hlb") continue;
    const id = object(step.extra).api_call_id;
    if (typeof id !== "string" || !id.trim()) continue;
    const proven = codexOutputProven(step), previous = inferenceGroups.get(id);
    inferenceGroups.set(id, previous ? { anchor: !previous.proven && proven ? index : previous.anchor,
      proven: previous.proven || proven, single: previous.single && (!proven || step.llm_call_count === 1) }
      : { anchor: index, proven, single: !proven || step.llm_call_count === 1 });
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
    const calls = array(step.tool_calls).map(object), results = array(object(step.observation).results).map(object);
    const groupId = typeof extra.api_call_id === "string" && extra.api_call_id.trim() ? extra.api_call_id : undefined;
    const group = groupId === undefined ? undefined : inferenceGroups.get(groupId);
    const declared = profile.family === "codex" && group?.proven && group.single ? known(1) : unreported;
    if (profile.family === "codex" && !codexOutputProven(step) && step.source === "agent") limitations.add("CONVERTER_ORPHAN_INFERENCE_UNAVAILABLE");
    if (profile.family === "codex" && step.source === "agent" && (!group || !group.single)) limitations.add("CONVERTER_INFERENCE_GROUP_UNAVAILABLE");
    if (step.source === "agent" && (profile.family !== "codex" || !group || group.anchor === index)) emit(step, pointer, pointer, "inference", "runtime", { facts: { inference: { llmCallCount: declared, nativeRequestId: unreported } }, clock: unreported });
    const issued = profile.family === "codex" && groupId !== undefined && group?.proven && group.single
      ? known({ id: `converter-api:${groupId}`, scope: "document:#", identityClass: "declared-single-inference" as const }) : unreported;
    const callIds = new Set<string>();
    for (const [callIndex, call] of calls.entries()) {
      const id = call.tool_call_id, name = call.function_name;
      if (typeof id !== "string" || !id.trim() || frequencies.get(id) !== 1) {
        gap = true; omitted = true; limitations.add("AMBIGUOUS_OPERATION_IDENTITY"); continue;
      }
      callIds.add(id);
      const argumentsValue = object(call.arguments), argumentKeys = Object.keys(argumentsValue);
      const fallbackArguments = profile.family === "hermes" && argumentKeys.length === 1 && Object.hasOwn(argumentsValue, "raw");
      if (fallbackArguments) limitations.add("CONVERTER_ARGUMENT_FALLBACK_AMBIGUITY");
      const callPointer = `${pointer}/tool_calls/${callIndex}`;
      const signature = profile.family === "codex" ? codexInput(extra, call, id, pointer, callPointer, calls.length)
        : { ...(argumentKeys.length && !fallbackArguments ? { inputDigest: digestValue(call.arguments) } : {}), contentPointer: `${callPointer}/arguments` };
      if (profile.family === "codex" && !signature.inputDigest) limitations.add("CONVERTER_ARGUMENT_PROVENANCE_INCOMPLETE");
      const nativeName = typeof name === "string" && name.trim() ? name : undefined;
      const toolName = profile.family !== "codex" && nativeName === "unknown" ? undefined : nativeName;
      if (!toolName) limitations.add(nativeName === "unknown" ? "CONVERTER_TOOL_NAME_PLACEHOLDER" : "TOOL_NAME_UNREPORTED");
      const originalCall = profile.family !== "codex" || codexOriginalCall(extra, call);
      if (!originalCall) { gap = true; limitations.add("ORIGINAL_CALL_UNAVAILABLE"); }
      const operation: OperationContribution = { nativeId: id, scope: "document:#", identityClass: "converter-assigned", canonical: true, ...(toolName ? { toolName } : {}), endpoint: "call", issuingInference: originalCall ? issued : unreported,
        ...(signature.inputDigest ? { inputDigest: signature.inputDigest } : {}) };
      if (originalCall) emit(step, pointer, callPointer, "call", "tool", { facts: {}, clock: unreported, operation }, signature.contentPointer ?? `${callPointer}/arguments`);
      const linked = results.map((result, resultIndex) => ({ result, resultIndex })).filter(({ result }) => result.source_call_id === id);
      const primary = linked.filter(({ result }) => !(profile.family === "openclaw" && object(result.extra).nested_tool !== undefined));
      // Codex function/custom entries survive only after a response, including bodyless ones.
      // A built-in web-search item has a synthetic empty result slot rather than an independent response.
      const builtinPlaceholder = profile.family === "codex" && originalCall && call.function_name === "web_search_call" && !["function_call", "custom_tool_call"].includes(String(object(object(extra.tool_call_details)[id]).item_type));
      const hasResponse = (result: Record<string, unknown>) => !builtinPlaceholder || result.content !== undefined && result.content !== null;
      if (primary.length !== 1 || !hasResponse(primary[0]!.result)) limitations.add(primary.length > 1 ? "AMBIGUOUS_RESULT_LINK" : builtinPlaceholder ? "BUILTIN_RESPONSE_UNAVAILABLE" : "PENDING_CALL");
      for (const { result, resultIndex } of linked) {
        const nested = profile.family === "openclaw" && object(result.extra).nested_tool !== undefined;
        const terminal = !nested && primary.length === 1 && hasResponse(result);
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
    const values = Object.fromEntries(Object.entries(object(step.metrics)).filter(([key, value]) => ["prompt_tokens", "completion_tokens", "cached_tokens", "cost_usd"].includes(key) && typeof value === "number" && Number.isFinite(value) && (value > 0 || profile.family === "codex" && key === "cost_usd" && value === 0)));
    const groupId = object(step.extra).api_call_id;
    const populationId = profile.family === "codex" && typeof groupId === "string" && groupId.trim()
      ? known(`converter-api:${groupId}`) : known(`#/steps/${index}`);
    if (Object.keys(values).length) emit(step, `#/steps/${index}`, `#/steps/${index}`, "usage", "runtime", { facts: { resource: { scope: "step", authority: "converter", semantics: "unknown", populationId, values: values as Record<string, number> } }, clock: unreported });
  }
  const final = Object.fromEntries(Object.entries(object(document.final_metrics)).filter(([key, value]) => ["total_prompt_tokens", "total_completion_tokens", "total_cached_tokens", "total_cost_usd"].includes(key) && typeof value === "number" && Number.isFinite(value) && (value > 0 || profile.family === "codex" && key === "total_cost_usd" && value === 0)));
  if (Object.keys(final).length) {
    const finalEvent: UniformEventV2 = { schemaVersion: "ebo.uniform-event/v2", id: "#/final_metrics/usage", runId: input.runId, attemptId: input.attemptId,
      source: { sourceId, nativeType: "atif:final-metrics", nativeReference: ref("#") }, family: "runtime", phase: "instant", nativeOrder: unreported, clock: unreported,
      actor: { kind: "harness" }, scope: { kind: "session", id: "document:#" }, relations: { parent: unreported, known: [] }, attributes: {}, content: unreported,
      facts: { resource: { scope: "session", authority: "converter", semantics: "unknown", populationId: known("source-reported-final:#"), values: final as Record<string, number> } } };
    events.push(finalEvent); projections.push({ facts: finalEvent.facts, clock: unreported });
  }
  const operations = buildOperationsV2(events, projections);
  const operationCount = operations.length;
  const sourceReason = gap || omitted ? "PRODUCER_PARTIAL_HISTORY" : profile.family === "codex" ? "CONVERTER_OMITS_PENDING_CALLS" : "CAPTURE_COMPLETENESS_UNPROVEN";
  const measurements: MeasurementV2[] = [{ id: "source-attempt-tool-operation-count", scope: { kind: "attempt", id: input.attemptId }, unit: "identified-logical-tool-operations",
    value: operationCount > 0 ? { status: "lower-bound", value: operationCount, reason: sourceReason } : { status: "unknown", reason: sourceReason }, coverage: operationCount > 0 ? "partial" : "unavailable", sourceEventIds: operations.flatMap(({ callEventIds, resultEventIds }) => [...callEventIds, ...resultEventIds]) },
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
