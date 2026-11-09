import { readFileSync } from "node:fs";
import { digestBytes } from "./artifacts.js";
import { selectAtifOverlay, type AtifProducerFingerprint } from "./atif-profiles.js";
import { atifFeaturesForVersion, atifPointerValue } from "./atif-reader.js";
import type { AtifCoreInput } from "./atif-core.js";
import type { RetainedBehaviorEvidenceV2 } from "./native-v2.js";
import { validateNormalizedDatasetV2, type MeasurementV2, type UniformEventV2 } from "./normalization-v2.js";
import { digestValue, known, object } from "./projection-v2.js";
export type AtifOverlayReceipt = { id: string; digest: `sha256:${string}` };
export type AtifInterpretationAdjustment = { overlayId: string; document: string; subject: string; reason: string;
  prior: unknown; adjusted: unknown; pointers: string[] };
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function documentProducer(document: Record<string, unknown>, operator?: AtifProducerFingerprint): AtifProducerFingerprint {
  const agent = object(document.agent);
  return { formatVersion: String(document.schema_version), agent: { name: String(agent.name), version: typeof agent.version === "string" ? agent.version : null },
    converter: operator?.converter ?? { id: "unreported", packageVersion: "unknown", sourceDigest: null },
    context: operator?.context ?? { kind: "unknown", revision: null, wrapperDigest: null } };
}
function overlayDigest(profileDigest: string): `sha256:${string}` {
  return digestValue({ profileDigest, implementation: ["atif-overlays.js", "atif-profiles.js"].map((path) => ({ path, digest: digestBytes(readFileSync(new URL(path, import.meta.url))).value })) });
}
export function atifOverlayReceipts(input: Pick<AtifCoreInput, "read" | "producer">): AtifOverlayReceipt[] {
  const receipts = new Map<string, AtifOverlayReceipt>();
  for (const record of input.read.inspection.records) if (record.kind === "trajectory") {
    const document = object(atifPointerValue(input.read.document, record.pointer));
    if (!atifFeaturesForVersion(document.schema_version)) continue;
    const selected = selectAtifOverlay(documentProducer(document, input.producer));
    if (selected.status === "supported") receipts.set(selected.profile.id, { id: selected.profile.id, digest: overlayDigest(selected.profileDigest) });
  }
  return [...receipts.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Add qualified interpretations without deleting a standard event or declaring an attempt population. */
export async function applyAtifOverlays(core: RetainedBehaviorEvidenceV2, input: AtifCoreInput): Promise<RetainedBehaviorEvidenceV2> {
  if (core.capture.qualification !== "imported" || core.outcomeCapture.qualification !== "imported") throw new Error("ATIF overlays require imported evidence.");
  const appended = new Map<string, UniformEventV2[]>();
  const dataset = structuredClone(core.dataset), adjustments: AtifInterpretationAdjustment[] = [], limits = new Set(core.capture.sourceLimitations ?? []);
  const aliases = new Set(core.modelAliases ?? []);
  for (const source of dataset.sources) {
    const pointer = source.id.slice(source.id.indexOf(":#") + 1), document = object(atifPointerValue(input.read.document, pointer));
    const selected = selectAtifOverlay(documentProducer(document, input.producer));
    if (selected.status !== "supported") continue;
    const { profile } = selected;
    source.producerProfile = known({ id: profile.id, version: profile.version, digest: overlayDigest(selected.profileDigest) });
    source.limitations = [...profile.limitations, ...selected.verified ? [] : ["PRODUCER_VERSION_UNVERIFIED"]];
    source.limitations.forEach((reason) => limits.add(reason));
    const recordAdjustment = (subject: string, reason: string, prior: unknown, adjusted: unknown, pointers: string[]) => {
      adjustments.push({ overlayId: profile.id, document: pointer, subject, reason, prior, adjusted, pointers });
    };
    const events = dataset.events.filter((event) => event.source.sourceId === source.id);
    const measurement = (id: string, value: MeasurementV2["value"], reason: string, pointers: string[]) => {
      const existing = dataset.measurements.find((m) => m.id === id && m.scope.id.endsWith(`:${pointer}`));
      const next: MeasurementV2 = { id, value, scope: { kind: "recorded-document", id: `${input.artifactId ?? "atif-trajectory"}:${pointer}` },
        unit: existing?.unit ?? (id.includes("token-count") ? "tokens" : "source-declared-units"), coverage: value.status === "known" ? "exact" : value.status === "lower-bound" ? "partial" : "unavailable", sourceEventIds: events.map(({ id }) => id) };
      recordAdjustment(id, reason, existing?.value ?? { status: "unknown", reason: "NOT_IN_CORE" }, value, pointers);
      if (existing) Object.assign(existing, next); else dataset.measurements.push(next);
    };
    if (object(document.extra).partial) limits.add("PRODUCER_PARTIAL_HISTORY");
    if (!selected.verified) continue;
    if (profile.family === "pi") {
      for (const [index, value] of array(document.steps).entries()) {
        const alias = object(object(value).extra).response_model;
        if (typeof alias !== "string" || !alias.trim()) continue;
        const prior = [...aliases].sort(); aliases.add(alias);
        recordAdjustment("modelAliases", "PI_RESPONSE_MODEL_ALIAS", prior, [...aliases].sort(), [`${pointer}/steps/${index}/extra/response_model`]);
      }
      for (const event of events) {
        const value = object(atifPointerValue(input.read.document, event.source.nativeReference.recordLocator));
        if (event.facts.operation?.endpoint === "result" && object(value.extra).is_error === true) {
          recordAdjustment(`event:${event.id}:failure`, "PI_EXPLICIT_ERROR_EXTENSION", event.facts.operation.failure, known(true), [event.source.nativeReference.recordLocator]);
          event.facts.operation.failure = known(true);
          const operation = dataset.operations.find((operation) => operation.resultEventIds.includes(event.id));
          if (operation) operation.failure = known(true);
        }
      }
      const operations = dataset.operations.filter((operation) => operation.identity.sourceId === source.id);
      const errors = operations.filter(({ failure }) => failure.status === "known" && failure.value).length;
      measurement("source-tool-error-count", errors ? { status: "lower-bound", value: errors, reason: "CONVERTER_ZERO_FILL_POSSIBLE" }
        : { status: "unknown", reason: "CONVERTER_ZERO_FILL_POSSIBLE" }, "PI_EXPLICIT_ERROR_EXTENSION", operations.flatMap(({ resultEventIds }) => resultEventIds.map((id) => dataset.events.find((e) => e.id === id)!.source.nativeReference.recordLocator)));
      const steps = array(document.steps).map(object).filter((step) => step.source === "agent" && step.is_copied_context !== true);
      const metrics = steps.map((step) => object(step.metrics)), final = object(document.final_metrics);
      const pointers = array(document.steps).map((_, i) => `${pointer}/steps/${i}/metrics`);
      const complete = steps.length > 0 && steps.every((step) => step.llm_call_count === 1);
      const sum = (key: string, extra = false): number | undefined => {
        const values = metrics.map((metric) => extra ? object(metric.extra)[key] : metric[key]);
        if (!complete || !values.every(number)) return undefined;
        const total = values.reduce((sum, value) => sum + value, 0);return Number.isSafeInteger(total) ? total : undefined;
      };
      const prompt = sum("prompt_tokens"), cached = sum("cached_tokens"), writes = sum("cache_write_tokens", true);
      const values = metrics.map((metric) => number(metric.prompt_tokens) && number(metric.cached_tokens) && number(object(metric.extra).cache_write_tokens)
        ? metric.prompt_tokens - metric.cached_tokens - Number(object(metric.extra).cache_write_tokens) : undefined);
      const conflict = prompt !== undefined && final.total_prompt_tokens != null && prompt !== final.total_prompt_tokens
        || cached !== undefined && final.total_cached_tokens != null && cached !== final.total_cached_tokens
        || writes !== undefined && object(final.extra).cache_write_tokens != null && writes !== object(final.extra).cache_write_tokens;
      const total = prompt !== undefined && cached !== undefined && writes !== undefined ? prompt - cached - writes : undefined;
      const reason = values.some((v) => v !== undefined && v < 0) ? "PI_INCLUSIVE_PROMPT_CONFLICT" : conflict ? "STEP_FINAL_USAGE_CONFLICT"
        : values.some((v) => v === 0) ? "CONVERTER_ZERO_FILL_POSSIBLE" : "PI_CACHE_COMPONENTS_UNPROVEN";
      measurement("pi-input-token-count", complete && !conflict && total !== undefined && Number.isSafeInteger(total) && values.every((v) => number(v) && v > 0)
        ? known(total) : { status: "unknown", reason }, "PI_INCLUSIVE_PROMPT_MINUS_CACHE_COMPONENTS", pointers);
      for (const [field, totalField, id] of [["completion_tokens", "total_completion_tokens", "pi-output-token-count"], ["cached_tokens", "total_cached_tokens", "pi-cache-read-input-token-count"]]) {
        const total = sum(field!);
        measurement(id!, total !== undefined && metrics.every((metric) => Number(metric[field!]) > 0) && (final[totalField!] == null || final[totalField!] === total)
          ? known(total) : { status: "unknown", reason: total === undefined ? "USAGE_COMPONENT_COMPLETENESS_UNPROVEN"
            : final[totalField!] != null && final[totalField!] !== total ? "STEP_FINAL_USAGE_CONFLICT" : "CONVERTER_ZERO_FILL_POSSIBLE" }, "PI_DECLARED_USAGE_RECONCILIATION", pointers);
      }
      for (const [index, value] of array(document.steps).entries()) {
        const step = object(value), type = object(step.extra).pi_event_type ?? object(object(step.extra).context_management).type;
        if (step.is_copied_context === true || !["compaction", "branch_summary"].includes(String(type))) continue;
        const nativePointer = `${pointer}/steps/${index}`, base = events.find((event) => event.source.nativeReference.recordLocator === nativePointer);
        if (!base) continue;
        const event = { ...structuredClone(base), id: `${nativePointer}/pi-context-overlay`, family: "context" as const,
          facts: { context: { type: type === "compaction" ? "compaction" as const : "summarization" as const, replacementBoundary: { status: "unknown" as const, reason: "SOURCE_UNREPORTED" } } } };
        appended.set(base.id, [...appended.get(base.id) ?? [], event]);
        dataset.recordCoverage.find(({ reference }) => reference.recordLocator === nativePointer)?.eventIds.push(event.id);
        recordAdjustment(`event:${event.id}`, "PI_CONTEXT_MANAGEMENT_EXTENSION", null, event.facts, [`${nativePointer}/extra`]);
      }
    } else {
      // The standard declaration remains visible. This separately qualified measure uses the converter's API grouping extension.
      const groups = new Set<string>(); let complete = true;
      for (const event of events) {
        if (event.nativeOrder.status === "known") {
          recordAdjustment(`event:${event.id}:order`, "CONVERTER_REORDERS_MODEL_OUTPUTS", event.nativeOrder,
            { status: "unknown", reason: "CONVERTER_REORDERS_MODEL_OUTPUTS" }, [event.source.nativeReference.recordLocator]);
          event.nativeOrder = { status: "unknown", reason: "CONVERTER_REORDERS_MODEL_OUTPUTS" };
        }
        if (event.clock.status === "known") {
          recordAdjustment(`event:${event.id}:clock`, "CONVERTER_GROUPED_CLOCKS", structuredClone(event.clock),
            { ...event.clock, value: { ...event.clock.value, provenance: "converter-derived" } }, [event.clock.value.source.recordLocator]);
          event.clock.value.provenance = "converter-derived";
        }
      }
      for (const operation of dataset.operations.filter((operation) => operation.identity.sourceId === source.id)) {
        operation.startOrder = { status: "unknown", reason: "CONVERTER_REORDERS_MODEL_OUTPUTS" };
        const callEvent = events.find((event) => operation.callEventIds.includes(event.id));
        if (!callEvent) continue;
        const callPointer = callEvent.source.nativeReference.recordLocator, stepPointer = callPointer.slice(0, callPointer.lastIndexOf("/tool_calls/"));
        const step = object(atifPointerValue(input.read.document, stepPointer)), call = object(atifPointerValue(input.read.document, callPointer));
        const signature = codexInput(object(step.extra), call, operation.identity.nativeId, stepPointer, callPointer, array(step.tool_calls).length);
        const adjusted = signature.inputDigest ? known(signature.inputDigest) : { status: "unknown" as const, reason: "CONVERTER_ARGUMENT_PROVENANCE_INCOMPLETE" };
        recordAdjustment(`operation:${operation.id}:inputDigest`, "CODEX_ORIGINAL_ARGUMENT_REPRESENTATION", operation.inputDigest, adjusted, [signature.contentPointer ?? callPointer]);
        operation.inputDigest = adjusted;
        if (signature.contentPointer) {
          const rawReference = { ...callEvent.source.nativeReference, recordLocator: signature.contentPointer };
          const prior = structuredClone(callEvent.content);
          // Keep the standard arguments visible alongside the qualified original representation.
          const content = callEvent.content.status === "known" ? callEvent.content.value.map((part) => part.role === "tool-input"
            ? { ...part, role: "message" as const } : part) : [];
          callEvent.content = known([...content, { nativeReference: rawReference, role: "tool-input" as const }]);
          recordAdjustment(`event:${callEvent.id}:input`, "CODEX_ORIGINAL_ARGUMENT_REPRESENTATION", prior, callEvent.content, [signature.contentPointer]);
        }
        const group = object(step.extra).api_call_id;
        const inference = typeof group === "string" && group.length && step.llm_call_count === 1 && codexOutputProven(step)
          ? known({ id: `converter-api:${group}`, scope: `document:${pointer}`, identityClass: "declared-single-inference" as const })
          : { status: "unknown" as const, reason: "CONVERTER_INFERENCE_GROUP_UNAVAILABLE" };
        recordAdjustment(`operation:${operation.id}:issuingInference`, "CODEX_CONVERTER_API_GROUPING", operation.issuingInference, inference, [`${stepPointer}/extra`]);
        operation.issuingInference = inference;
      }
      for (const step of array(document.steps).map(object)) if (step.source === "agent" && step.is_copied_context !== true) {
        const group = object(step.extra).api_call_id;
        if (typeof group === "string" && group.length && step.llm_call_count === 1) groups.add(group); else complete = false;
      }
      measurement("codex-converter-inference-group-count", complete && groups.size ? known(groups.size) : { status: "unknown", reason: "CONVERTER_INFERENCE_GROUP_UNAVAILABLE" },
        "CODEX_CONVERTER_API_GROUPING", array(document.steps).map((_, i) => `${pointer}/steps/${i}/extra`));
    }
  }
  if (core.capture.qualification !== "imported" || core.outcomeCapture.qualification !== "imported") throw new Error("ATIF overlays require imported evidence.");
  dataset.events = dataset.events.flatMap((event) => [event, ...appended.get(event.id) ?? []]);
  await validateNormalizedDatasetV2(dataset, core.resolver);
  return { ...core, dataset, modelAliases: [...aliases].sort(), capture: { ...core.capture, sourceLimitations: [...limits].sort() },
    outcomeCapture: { ...core.outcomeCapture, sourceLimitations: [...limits].sort() }, overlayAdjustments: adjustments };
}

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
