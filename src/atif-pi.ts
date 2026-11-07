import { digestMetadata } from "./artifacts.js";
import type { AtifObject, AtifReadResult } from "./atif-reader.js";
import { selectAtifProducerProfile, type AtifProducerFingerprint } from "./atif-profiles.js";
import { createPointerEvidenceResolver, readEvidencePointer } from "./evidence-pointers.js";
import { describeImportedDataset, validateNormalizedDataset } from "./normalization-integrity.js";
import type { RetainedBehaviorEvidence } from "./retained-evidence.js";
import { UNIFORM_EVENT_FAMILIES, type AdapterCapabilityProfile, type ImportedNativeEvidence, type UniformEvent } from "./uniform-events.js";

type Measure = { status: "known"; value: number } | { status: "unavailable"; reason: string };
export type PiAtifMappingReport = {
  schemaVersion: "ebo.pi-atif-mapping/v1";
  scope: "retained-selected-trajectory";
  producerStatus: "supported" | "unsupported";
  profileDigest?: `sha256:${string}`;
  limitations: string[];
  recorded: { calls: number; linkedResults: number; copiedStepsExcluded: number; contextOnlyStepsExcluded: number };
  signatures: Array<{ document: string; id: string; name: string; failed: boolean | null }>;
  measures: Record<string, Measure>;
};

const hash = (value: unknown): `sha256:${string}` => `sha256:${digestMetadata(value).value}`;
const object = (value: unknown): AtifObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as AtifObject : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const missing = (reason: string): Measure => ({ status: "unavailable", reason });
const count = (value: number): Measure => ({ status: "known", value });
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Producer semantics apply only after independent structural validation and the EBO version gate. */
export async function normalizePiAtif(input: {
  read: AtifReadResult; producer: AtifProducerFingerprint; runId: string; attemptId: string;
  manifestDigest: `sha256:${string}`; artifactId?: string;
}): Promise<RetainedBehaviorEvidence & { mapping: PiAtifMappingReport }> {
  const { inspection, document } = input.read;
  if (document === undefined || inspection.versionPolicy.status !== "supported" || inspection.structural.status !== "valid") {
    throw new Error("ATIF admission requires supported source versions and valid pinned structural validation.");
  }
  if (input.producer.formatVersion !== document.schema_version || input.producer.agent.name !== object(document.agent).name
      || input.producer.agent.version !== (object(document.agent).version ?? null)) throw new Error("Producer declaration differs from the retained trajectory.");
  const selection = selectAtifProducerProfile(input.producer);
  const artifactId = input.artifactId ?? "atif-trajectory";
  const reference = (recordLocator: string) => ({ artifactId, recordLocator });
  const records = inspection.records.map(({ pointer }) => {
    const value = readEvidencePointer(document, pointer);
    if (!value.found) throw new Error("ATIF pointer inventory does not resolve.");
    return { reference: reference(pointer), record: value.value };
  });
  const nativeTypes = new Map(records.map((record, index) => [record.record, `atif:${inspection.records[index]!.kind}`]));
  const capture: ImportedNativeEvidence<unknown> = { runId: input.runId, attemptId: input.attemptId, qualification: "imported", records };
  const resolver = createPointerEvidenceResolver(capture);
  const events: UniformEvent[] = [];
  const limitations = new Set(inspection.limitations);
  const mapping: PiAtifMappingReport = { schemaVersion: "ebo.pi-atif-mapping/v1", scope: "retained-selected-trajectory",
    producerStatus: selection.status, limitations: [], recorded: { calls: 0, linkedResults: 0, copiedStepsExcluded: 0, contextOnlyStepsExcluded: 0 },
    signatures: [], measures: {} };
  const harness = selection.status === "supported" ? selection.profile.harness : "atif.unregistered";
  const agentSteps: AtifObject[] = [];
  let gap = false;
  const emit = (step: AtifObject, stepPointer: string, pointer: string, suffix: string, family: UniformEvent["family"],
    phase: UniformEvent["phase"], attributes: UniformEvent["attributes"], contentPointer?: string, operation?: string) => {
    const documentPointer = stepPointer.slice(0, stepPointer.lastIndexOf("/steps/"));
    events.push({ schemaVersion: "ebo.uniform-event/v1", id: `${pointer}/${suffix}`, runId: input.runId, attemptId: input.attemptId,
      source: { harness, nativeType: `atif:${family}`, nativeReference: reference(pointer) },
      nativeOrder: { status: "known", value: Number(step.step_id), domain: `${artifactId}:${documentPointer}` },
      nativeTime: { status: "unknown", reason: "PER_OPERATION_CLOCK_NOT_RECORDED" },
      actor: { kind: family === "tool" && phase === "after" ? "tool" : step.source === "agent" ? "agent" : step.source === "user" ? "user" : "system" },
      scope: operation === undefined ? { kind: "session", id: `document:${documentPointer}` } : { kind: "operation", id: operation },
      relations: { parent: { status: "unknown", reason: "PARENTAGE_NOT_ESTABLISHED" }, known: [] },
      attributes: { ...attributes, documentScope: documentPointer, ...(step.llm_call_count === 1
        ? { inferenceId: `${artifactId}:${stepPointer}`, inferenceIdentitySource: "declared-single-inference-step" } : {}) },
      content: { status: "known", value: contentPointer === undefined ? [] : [{ nativeReference: reference(contentPointer), role: family === "tool" ? phase === "before" ? "tool-input" : "tool-result" : "message" }] },
    });
  };
  const visit = (trajectory: AtifObject, pointer: string, contextOnly: boolean) => {
    if (object(trajectory.extra).partial) { gap = true; limitations.add("PRODUCER_PARTIAL_HISTORY"); }
    const roles = new Map<string, Set<string>>();
    for (const value of array(trajectory.steps)) {
      const step = object(value), extra = object(step.extra);
      const context = ["compaction", "branch_summary"].includes(String(extra.pi_event_type));
      for (const result of array(object(step.observation).results)) for (const ref of array(object(result).subagent_trajectory_ref)) {
        const id = object(ref).trajectory_id;
        if (typeof id !== "string") continue;
        const role = contextOnly || step.is_copied_context === true || extra.added_by === "hlb" ? "borrowed" : context ? "summary" : "delegated";
        const values = roles.get(id) ?? new Set(); values.add(role); roles.set(id, values);
      }
    }
    for (const [index, value] of array(trajectory.steps).entries()) {
      const step = object(value), extra = object(step.extra), stepPointer = `${pointer}/steps/${index}`;
      if (step.is_copied_context === true) { mapping.recorded.copiedStepsExcluded += 1; continue; }
      if (contextOnly) { mapping.recorded.contextOnlyStepsExcluded += 1; continue; }
      if (extra.added_by === "hlb") { gap = true; limitations.add("CONVERSION_GAP"); continue; }
      if (step.source === "agent") agentSteps.push(step);
      const contextType = extra.pi_event_type;
      if (["compaction", "branch_summary"].includes(String(contextType))) {
        emit(step, stepPointer, stepPointer, "context", "context", "instant", { contextManagementType: String(contextType),
          ...(contextType === "compaction" ? { subtype: "compact_boundary" } : {}) }, typeof step.message === "string" ? `${stepPointer}/message` : undefined);
        continue;
      }
      if (typeof step.message === "string" && step.message.length > 0) emit(step, stepPointer, stepPointer, "message", "message", "after",
        { role: step.source === "agent" ? "assistant" : String(step.source) }, `${stepPointer}/message`);
      const calls = array(step.tool_calls).map(object);
      const duplicates = new Set(calls.filter((call, position) => calls.findIndex((other) => other.tool_call_id === call.tool_call_id) !== position).map((call) => call.tool_call_id));
      if (duplicates.size) { gap = true; limitations.add("DUPLICATE_OPERATION_ID"); }
      for (const [position, call] of calls.entries()) {
        const id = call.tool_call_id, name = call.function_name;
        if (typeof id !== "string" || typeof name !== "string" || duplicates.has(id)) { gap = true; continue; }
        const scoped = `${pointer}:${id}`, callPointer = `${stepPointer}/tool_calls/${position}`;
        const results = array(object(step.observation).results).map((result, resultIndex) => ({ result: object(result), resultIndex }))
          .filter(({ result }) => result.source_call_id === id);
        const statuses = results.map(({ result }) => object(result.extra).is_error);
        const failed = statuses.length === 1 && typeof statuses[0] === "boolean" ? statuses[0] : null;
        mapping.signatures.push({ document: pointer, id, name, failed }); mapping.recorded.calls += 1;
        const attrs = { toolCallId: scoped, nativeToolCallId: id, toolName: name, operationIdentitySource: "document-scoped-native-id" };
        emit(step, stepPointer, callPointer, "call", "tool", "before", { ...attrs, inputDigest: hash(call.arguments) }, `${callPointer}/arguments`, scoped);
        if (results.length !== 1) { limitations.add(results.length ? "AMBIGUOUS_RESULT_LINK" : "PENDING_CALL"); continue; }
        const { result, resultIndex } = results[0]!;
        const resultPointer = `${stepPointer}/observation/results/${resultIndex}`;
        mapping.recorded.linkedResults += 1;
        if (failed === null) limitations.add("TOOL_RESULT_STATUS_INCOMPLETE");
        emit(step, stepPointer, resultPointer, "result", "tool", "after", { ...attrs, ...(failed === null ? {} : { isError: failed }) },
          result.content === undefined ? undefined : `${resultPointer}/content`, scoped);
      }
    }
    for (const [index, value] of array(trajectory.subagent_trajectories).entries()) {
      const child = object(value), role = roles.get(String(child.trajectory_id));
      const admitted = role?.size === 1 && role.has("delegated");
      if (!admitted) limitations.add("CHILD_CONTEXT_NOT_NEW_BEHAVIOR");
      const sameProducer = child.schema_version === input.producer.formatVersion && object(child.agent).name === input.producer.agent.name
        && (object(child.agent).version ?? null) === input.producer.agent.version;
      if (!sameProducer) limitations.add("CHILD_PRODUCER_UNREGISTERED");
      visit(child, `${pointer}/subagent_trajectories/${index}`, contextOnly || !admitted || !sameProducer);
    }
  };
  if (selection.status === "supported") {
    mapping.profileDigest = selection.profileDigest;
    selection.profile.limitations.forEach((reason) => limitations.add(reason));
    visit(document, "#", false);
    const sum = (key: string, extra = false): number | undefined => {
      if (gap || !agentSteps.length) return undefined;
      const values = agentSteps.map((step) => extra ? object(object(step.metrics).extra)[key] : object(step.metrics)[key]);
      if (!values.every(integer)) return undefined;
      const total = values.reduce((left, right) => left + right, 0);
      return Number.isSafeInteger(total) ? total : undefined;
    };
    const prompt = sum("prompt_tokens"), cached = sum("cached_tokens"), writes = sum("cache_write_tokens", true), output = sum("completion_tokens");
    const final = object(document.final_metrics);
    const reconciled = (value: number | undefined, key: string): Measure => value === undefined ? missing("STEP_USAGE_INCOMPLETE")
      : final[key] !== undefined && final[key] !== value ? missing("STEP_FINAL_USAGE_CONFLICT")
        : value === 0 ? missing("CONVERTER_ZERO_FILL_POSSIBLE") : count(value);
    mapping.measures["tool-operation-count"] = gap ? missing("PRODUCER_PARTIAL_HISTORY") : count(mapping.recorded.calls);
    mapping.measures["tool-error-count"] = gap ? missing("PRODUCER_PARTIAL_HISTORY") : mapping.signatures.some(({ failed }) => failed === null)
      ? missing("TOOL_RESULT_STATUS_INCOMPLETE") : count(mapping.signatures.filter(({ failed }) => failed).length);
    mapping.measures["input-token-count"] = prompt === undefined || cached === undefined || writes === undefined ? missing("STEP_USAGE_INCOMPLETE")
      : cached + writes > prompt ? missing("PI_INCLUSIVE_PROMPT_CONFLICT")
        : final.total_prompt_tokens !== undefined && final.total_prompt_tokens !== prompt || final.total_cached_tokens !== undefined && final.total_cached_tokens !== cached
          || object(final.extra).cache_write_tokens !== undefined && object(final.extra).cache_write_tokens !== writes ? missing("STEP_FINAL_USAGE_CONFLICT")
          : prompt - cached - writes === 0 ? missing("CONVERTER_ZERO_FILL_POSSIBLE") : count(prompt - cached - writes);
    mapping.measures["output-token-count"] = reconciled(output, "total_completion_tokens");
    mapping.measures["cache-read-input-token-count"] = reconciled(cached, "total_cached_tokens");
    const inference = !gap && agentSteps.length > 0 && agentSteps.every((step) => integer(step.llm_call_count))
      ? agentSteps.reduce((sum, step) => sum + Number(step.llm_call_count), 0) : undefined;
    mapping.measures["declared-inference-count"] = inference !== undefined && Number.isSafeInteger(inference) ? count(inference) : missing("DECLARED_INFERENCE_INCOMPLETE");
  } else limitations.add("PRODUCER_PROFILE_UNREGISTERED");
  mapping.measures["model-request-count"] = missing("NATIVE_REQUEST_IDENTITIES_UNAVAILABLE");
  mapping.limitations = [...limitations].sort();
  const capabilities: AdapterCapabilityProfile = { schemaVersion: "ebo.adapter-capability-profile/v1", adapterId: "atif-pi-import", harness,
    nativeTypes: ["atif:trajectory", "atif:step", "atif:call", "atif:result"],
    families: Object.fromEntries(UNIFORM_EVENT_FAMILIES.map((family) => [family, { status: events.some((event) => event.family === family) ? "partial" : "unsupported",
      detail: "Imported selected history cannot establish complete attempt coverage." }])) as AdapterCapabilityProfile["families"],
    evidence: { nativeOrder: { status: "partial" }, nativeTime: { status: "unsupported" }, parentage: { status: "unsupported" }, content: { status: "partial" } } };
  const used = new Set(events.map((event) => event.source.nativeReference.recordLocator));
  const dataset = describeImportedDataset({ capture, normalization: { events, unmapped: records.filter(({ reference }) => !used.has(reference.recordLocator))
    .map(({ reference }) => ({ reference, reason: "RETAINED_WITHOUT_AGENT_BEHAVIOR_PROJECTION" })) }, capabilityProfile: capabilities, adapterVersion: "1.0.0",
    nativeType: (record) => nativeTypes.get(record) ?? "atif:trajectory",
    contentDigestPolicy: "canonical-json-pointers/v1", contentDigest: (reference) => resolver.read(reference)?.pointedDigest,
    origin: { kind: "imported", qualification: "imported", manifestDigest: input.manifestDigest, exactAttemptMeasures: "unavailable",
      reason: "Imported selected trajectory does not establish complete attempt coverage." } });
  const coverage = await validateNormalizedDataset(dataset, resolver);
  return { capture, dataset, coverage, resolver, mapping,
    outcomeCapture: { ...capture, records: capture.records.map(({ reference, record }) => ({ reference, record: { kind: "imported-source", document: record } })) } };
}
