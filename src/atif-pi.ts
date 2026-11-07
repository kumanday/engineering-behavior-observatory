import { digestMetadata, validateArtifact } from "./artifacts.js";
import type { AtifObject, AtifReadResult } from "./atif-reader.js";
import { selectAtifProducerProfile, type AtifProducerFingerprint } from "./atif-profiles.js";
import { createPointerEvidenceResolver, readEvidencePointer } from "./evidence-pointers.js";
import { describeImportedDataset, validateNormalizedDataset } from "./normalization-integrity.js";
import type { RetainedBehaviorEvidence } from "./retained-evidence.js";
import { UNIFORM_EVENT_FAMILIES, type AdapterCapabilityProfile, type ImportedNativeEvidence, type UniformEvent } from "./uniform-events.js";

type Measure = { status: "known"; value: number; unit: string } | { status: "unavailable"; reason: string };
export type PiAtifMappingReport = {
  schemaVersion: "ebo.pi-atif-mapping/v1";
  scope: "retained-selected-trajectory";
  producerStatus: "supported" | "unsupported";
  profileDigest?: `sha256:${string}`;
  limitations: string[];
  recorded: { calls: number | null; linkedResults: number | null; copiedStepsExcluded: number | null; contextOnlyStepsExcluded: number | null };
  signatures: Array<{ document: string; id: string; name: string; failed: boolean | null }>;
  measures: Record<string, Measure>;
};

const hash = (value: unknown): `sha256:${string}` => `sha256:${digestMetadata(value).value}`;
const object = (value: unknown): AtifObject => value !== null && typeof value === "object" && !Array.isArray(value) ? value as AtifObject : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const missing = (reason: string): Measure => ({ status: "unavailable", reason });
const count = (value: number, unit: string): Measure => ({ status: "known", value, unit });
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Producer semantics apply only after independent structural validation and the EBO version gate. */
export async function normalizePiAtif(input: {
  read: AtifReadResult; producer: AtifProducerFingerprint; runId: string; attemptId: string;
  manifestDigest: `sha256:${string}`; artifactId?: string;
}): Promise<RetainedBehaviorEvidence & { mapping: PiAtifMappingReport; projection: { agentSteps: Array<{ pointer: string; llmCallCount: number | null }> } }> {
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
  const pointerTypes = new Map(inspection.records.map(({ pointer, kind }) => [pointer, `atif:${kind}`]));
  const nativeTypes = new Map(records.map((record, index) => [record.record, `atif:${inspection.records[index]!.kind}`]));
  const capture: ImportedNativeEvidence<unknown> = { runId: input.runId, attemptId: input.attemptId, qualification: "imported", records };
  const resolver = createPointerEvidenceResolver(capture);
  const events: UniformEvent[] = [];
  const limitations = new Set(inspection.limitations);
  const mapping: PiAtifMappingReport = { schemaVersion: "ebo.pi-atif-mapping/v1", scope: "retained-selected-trajectory",
    producerStatus: selection.status, limitations: [], recorded: { calls: null, linkedResults: null, copiedStepsExcluded: null, contextOnlyStepsExcluded: null },
    signatures: [], measures: {} };
  const harness = selection.status === "supported" ? selection.profile.harness : "atif.unregistered";
  const agentSteps: AtifObject[] = [];
  const projection: { agentSteps: Array<{ pointer: string; llmCallCount: number | null }> } = { agentSteps: [] };
  const usageDocuments: Array<{ trajectory: AtifObject; steps: AtifObject[] }> = [];
  let gap = false;
  const emit = (step: AtifObject, stepPointer: string, pointer: string, suffix: string, family: UniformEvent["family"],
    phase: UniformEvent["phase"], attributes: UniformEvent["attributes"], contentPointer?: string, operation?: string) => {
    const documentPointer = stepPointer.slice(0, stepPointer.lastIndexOf("/steps/"));
    const pointedDocument = readEvidencePointer(document, documentPointer);
    const sourceDocument = object(pointedDocument.found ? pointedDocument.value : undefined);
    events.push({ schemaVersion: "ebo.uniform-event/v1", id: `${pointer}/${suffix}`, runId: input.runId, attemptId: input.attemptId,
      family, phase,
      source: { harness, nativeType: pointerTypes.get(pointer) ?? "atif:step", nativeReference: reference(pointer) },
      nativeOrder: { status: "known", value: Number(step.step_id), domain: `${artifactId}:${documentPointer}` },
      nativeTime: { status: "unsupported", reason: "PER_OPERATION_CLOCK_NOT_RECORDED" },
      actor: { kind: family === "tool" && phase === "after" ? "tool" : step.source === "agent" ? family === "message" ? "model" : "agent" : step.source === "user" ? "user" : "system" },
      scope: operation === undefined ? { kind: "session", id: `document:${documentPointer}` } : { kind: "operation", id: operation },
      relations: { parent: { status: "unsupported", reason: "PARENTAGE_NOT_ESTABLISHED" }, known: [] },
      attributes: { ...attributes, documentScope: documentPointer,
        ...(typeof sourceDocument.session_id === "string" ? { sessionId: sourceDocument.session_id } : {}),
        ...(typeof sourceDocument.trajectory_id === "string" ? { agentId: sourceDocument.trajectory_id } : {}), ...(step.llm_call_count === 1
        ? { inferenceId: `${artifactId}:${stepPointer}`, inferenceIdentitySource: "declared-single-inference-step" } : {}) },
      content: { status: "known", value: contentPointer === undefined ? [] : [{ nativeReference: reference(contentPointer), role: family === "tool" ? phase === "before" ? "tool-input" : "tool-result" : "message" }] },
    });
  };
  const visit = (trajectory: AtifObject, pointer: string, contextOnly: boolean) => {
    if (!contextOnly) {
      for (const [index, value] of array(trajectory.steps).entries()) {
        const step = object(value), location = `${pointer}/steps/${index}`;
        if (Object.hasOwn(step, "is_copied_context") && typeof step.is_copied_context !== "boolean"
            || !integer(step.step_id) || Number(step.step_id) < 1
            || step.llm_call_count !== undefined && step.llm_call_count !== null && !integer(step.llm_call_count)) {
          throw new Error(`Pi projection requires canonical flag and ordinal fields at ${location}.`);
        }
      }
    }
    const documentSteps: AtifObject[] = [];
    if (!contextOnly) usageDocuments.push({ trajectory, steps: documentSteps });
    if (object(trajectory.extra).partial) { gap = true; limitations.add("PRODUCER_PARTIAL_HISTORY"); }
    const roles = new Map<string, Set<string>>();
    const childIds = new Map<unknown, number>();
    for (const child of array(trajectory.subagent_trajectories)) {
      const id = object(child).trajectory_id;
      childIds.set(id, (childIds.get(id) ?? 0) + 1);
    }
    const callFrequency = new Map<unknown, number>();
    for (const value of array(trajectory.steps)) {
      const step = object(value);
      if (step.is_copied_context === true || object(step.extra).added_by === "hlb") continue;
      for (const value of array(step.tool_calls)) {
        const id = object(value).tool_call_id;
        callFrequency.set(id, (callFrequency.get(id) ?? 0) + 1);
      }
    }
    for (const value of array(trajectory.steps)) {
      const step = object(value), extra = object(step.extra);
      const context = ["compaction", "branch_summary"].includes(String(extra.pi_event_type ?? object(extra.context_management).type));
      for (const result of array(object(step.observation).results)) for (const ref of array(object(result).subagent_trajectory_ref)) {
        const id = object(ref).trajectory_id;
        if (typeof id !== "string") continue;
        const role = contextOnly || step.is_copied_context === true || extra.added_by === "hlb" ? "borrowed" : context ? "summary" : "delegated";
        const values = roles.get(id) ?? new Set(); values.add(role); roles.set(id, values);
      }
    }
    for (const [index, value] of array(trajectory.steps).entries()) {
      const step = object(value), extra = object(step.extra), stepPointer = `${pointer}/steps/${index}`;
      if (step.is_copied_context === true) { mapping.recorded.copiedStepsExcluded = (mapping.recorded.copiedStepsExcluded ?? 0) + 1; continue; }
      if (contextOnly) { mapping.recorded.contextOnlyStepsExcluded = (mapping.recorded.contextOnlyStepsExcluded ?? 0) + 1; continue; }
      if (extra.added_by === "hlb") { gap = true; limitations.add("CONVERSION_GAP"); continue; }
      if (step.source === "agent") { agentSteps.push(step); documentSteps.push(step); projection.agentSteps.push({ pointer: stepPointer, llmCallCount: integer(step.llm_call_count) ? step.llm_call_count : null }); }
      const contextType = extra.pi_event_type ?? object(extra.context_management).type;
      if (["compaction", "branch_summary"].includes(String(contextType))) {
        emit(step, stepPointer, stepPointer, "context", "context", "instant", { contextManagementType: String(contextType),
          ...(contextType === "compaction" ? { subtype: "compact_boundary" } : {}) }, typeof step.message === "string" || Array.isArray(step.message) ? `${stepPointer}/message` : undefined);
        continue;
      }
      if ((typeof step.message === "string" || Array.isArray(step.message)) && step.message.length > 0) emit(step, stepPointer, stepPointer, "message", "message", "after",
        { role: step.source === "agent" ? "assistant" : String(step.source) }, `${stepPointer}/message`);
      const calls = array(step.tool_calls).map(object);
      mapping.recorded.calls = (mapping.recorded.calls ?? 0) + calls.length;
      const duplicates = new Set(calls.filter((call) => (callFrequency.get(call.tool_call_id) ?? 0) > 1).map((call) => call.tool_call_id));
      const resultsById = new Map<unknown, Array<{ result: AtifObject; resultIndex: number }>>();
      for (const [resultIndex, value] of array(object(step.observation).results).entries()) {
        const result = object(value), values = resultsById.get(result.source_call_id) ?? [];
        values.push({ result, resultIndex }); resultsById.set(result.source_call_id, values);
      }
      if (duplicates.size) { gap = true; limitations.add("DUPLICATE_OPERATION_ID"); }
      for (const [position, call] of calls.entries()) {
        const id = call.tool_call_id, name = call.function_name;
        if (typeof id !== "string" || !id.trim() || typeof name !== "string" || !name.trim() || duplicates.has(id)) { gap = true; limitations.add("MALFORMED_OPERATION_IDENTITY"); continue; }
        const scoped = `${pointer}:${id}`, callPointer = `${stepPointer}/tool_calls/${position}`;
        const results = resultsById.get(id) ?? [];
        const statuses = results.map(({ result }) => object(result.extra).is_error);
        const failed = statuses.length === 1 && typeof statuses[0] === "boolean" ? statuses[0] : null;
        mapping.signatures.push({ document: pointer, id, name, failed });
        const attrs = { toolCallId: scoped, nativeToolCallId: id, toolName: name, operationIdentitySource: "document-scoped-native-id" };
        emit(step, stepPointer, callPointer, "call", "tool", "before", { ...attrs,
          ...(Object.keys(object(call.arguments)).length === 0 ? { inputMayBeZeroFilled: true } : { inputDigest: hash(call.arguments) }) }, `${callPointer}/arguments`, scoped);
        if (results.length !== 1) { limitations.add(results.length ? "AMBIGUOUS_RESULT_LINK" : "PENDING_CALL"); continue; }
        const { result, resultIndex } = results[0]!;
        const resultPointer = `${stepPointer}/observation/results/${resultIndex}`;
        mapping.recorded.linkedResults = (mapping.recorded.linkedResults ?? 0) + 1;
        if (failed === null) limitations.add("TOOL_RESULT_STATUS_INCOMPLETE");
        emit(step, stepPointer, resultPointer, "result", "tool", "after", { ...attrs, ...(failed === null ? {} : { producerIsError: failed }),
            ...(failed === true ? { isError: true } : failed === false ? { successStatusUnavailable: "CONVERTER_ZERO_FILL_POSSIBLE" } : {}) },
          result.content === undefined ? undefined : `${resultPointer}/content`, scoped);
      }
    }
    for (const [index, value] of array(trajectory.subagent_trajectories).entries()) {
      const child = object(value), role = roles.get(String(child.trajectory_id));
      const duplicateId = (childIds.get(child.trajectory_id) ?? 0) > 1;
      const admitted = !duplicateId && role?.size === 1 && role.has("delegated");
      if (duplicateId) { gap = true; limitations.add("DUPLICATE_CHILD_TRAJECTORY_ID"); }
      if (!admitted) limitations.add("CHILD_CONTEXT_NOT_NEW_BEHAVIOR");
      const sameProducer = child.schema_version === input.producer.formatVersion && object(child.agent).name === input.producer.agent.name
        && (object(child.agent).version ?? null) === input.producer.agent.version;
      if (!sameProducer) { limitations.add("CHILD_PRODUCER_UNREGISTERED"); gap = true; }
      if (role === undefined || role.size > 1) { limitations.add("CHILD_ROLE_UNRESOLVED"); gap = true; }
      visit(child, `${pointer}/subagent_trajectories/${index}`, contextOnly || !admitted || !sameProducer);
    }
  };
  if (selection.status === "supported") {
    mapping.recorded = { calls: 0, linkedResults: 0, copiedStepsExcluded: 0, contextOnlyStepsExcluded: 0 };
    mapping.profileDigest = selection.profileDigest;
    selection.profile.limitations.forEach((reason) => limitations.add(reason));
    visit(document, "#", false);
    mapping.measures["tool-operation-count"] = gap ? missing("PRODUCER_PARTIAL_HISTORY") : count(mapping.recorded.calls ?? 0, "identified-logical-tool-operations");
    mapping.measures["tool-error-count"] = gap ? missing("PRODUCER_PARTIAL_HISTORY") : mapping.signatures.some(({ failed }) => failed === null)
      ? missing("TOOL_RESULT_STATUS_INCOMPLETE") : count(mapping.signatures.filter(({ failed }) => failed).length, "logical-tool-operations");
    const documentUsage = usageDocuments.map(({ trajectory, steps: agentSteps }) => {
    const componentsComplete = agentSteps.every((step) => step.llm_call_count === 1);
    const usageMissingReason = !componentsComplete ? "USAGE_COMPONENT_COMPLETENESS_UNPROVEN" : "STEP_USAGE_INCOMPLETE";
    if (!componentsComplete) limitations.add("USAGE_COMPONENT_COMPLETENESS_UNPROVEN");
    const sum = (key: string, extra = false): number | undefined => {
      if (gap || !agentSteps.length || !componentsComplete) return undefined;
      const values = agentSteps.map((step) => extra ? object(object(step.metrics).extra)[key] : object(step.metrics)[key]);
      if (!values.every(integer)) return undefined;
      const total = values.reduce((left, right) => left + right, 0);
      return Number.isSafeInteger(total) ? total : undefined;
    };
    const prompt = sum("prompt_tokens"), cached = sum("cached_tokens"), writes = sum("cache_write_tokens", true), output = sum("completion_tokens");
    const final = object(trajectory.final_metrics);
    const stepZero = (key: string) => agentSteps.some((step) => object(step.metrics)[key] === 0);
    const reconciled = (value: number | undefined, key: string, stepKey: string): Measure => value === undefined ? missing(usageMissingReason)
      : final[key] !== undefined && final[key] !== value ? missing("STEP_FINAL_USAGE_CONFLICT")
        : stepZero(stepKey) ? missing("CONVERTER_ZERO_FILL_POSSIBLE") : count(value, "tokens");
    const negativeStepInput = agentSteps.some((step) => {
      const metrics = object(step.metrics), extra = object(metrics.extra);
      return integer(metrics.prompt_tokens) && integer(metrics.cached_tokens) && integer(extra.cache_write_tokens)
        && metrics.prompt_tokens - metrics.cached_tokens - extra.cache_write_tokens < 0;
    });
    const inputTokens: Measure = prompt === undefined || cached === undefined || writes === undefined ? missing(usageMissingReason)
      : negativeStepInput || cached + writes > prompt ? missing("PI_INCLUSIVE_PROMPT_CONFLICT")
        : final.total_prompt_tokens !== undefined && final.total_prompt_tokens !== prompt || final.total_cached_tokens !== undefined && final.total_cached_tokens !== cached
          || object(final.extra).cache_write_tokens !== undefined && object(final.extra).cache_write_tokens !== writes ? missing("STEP_FINAL_USAGE_CONFLICT")
           : agentSteps.some((step) => {
            const metrics = object(step.metrics);
            return Number(metrics.prompt_tokens) - Number(metrics.cached_tokens) - Number(object(metrics.extra).cache_write_tokens) === 0;
          }) ? missing("CONVERTER_ZERO_FILL_POSSIBLE") : count(prompt - cached - writes, "tokens");
    return { "input-token-count": inputTokens,
      "output-token-count": reconciled(output, "total_completion_tokens", "completion_tokens"),
      "cache-read-input-token-count": reconciled(cached, "total_cached_tokens", "cached_tokens") };

    });
    for (const id of ["input-token-count", "output-token-count", "cache-read-input-token-count"] as const) {
      const values = documentUsage.map((usage) => usage[id]);
      const unavailable = values.find((value) => value.status === "unavailable");
      const total = values.reduce((sum, value) => sum + (value.status === "known" ? value.value : 0), 0);
      mapping.measures[id] = unavailable ?? (Number.isSafeInteger(total) ? count(total, "tokens") : missing("USAGE_SUM_OVERFLOW"));
    }
    const inference = !gap && agentSteps.length > 0 && agentSteps.every((step) => integer(step.llm_call_count))
      ? agentSteps.reduce((sum, step) => sum + Number(step.llm_call_count), 0) : undefined;
    mapping.measures["declared-inference-count"] = inference !== undefined && Number.isSafeInteger(inference) ? count(inference, "declared-inferences") : missing("DECLARED_INFERENCE_INCOMPLETE");
  } else limitations.add("PRODUCER_PROFILE_UNREGISTERED");
  mapping.measures["model-request-count"] = missing("NATIVE_REQUEST_IDENTITIES_UNAVAILABLE");
  mapping.limitations = [...limitations].sort();
  const mappingErrors = validateArtifact("Pi ATIF mapping", mapping);
  if (mappingErrors.length) throw new Error(`Invalid generated Pi mapping: ${mappingErrors[0]!.message}`);
  capture.sourceLimitations = mapping.limitations;
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
  const aliases = new Set<string>();
  const alias = (value: unknown) => { if (typeof value === "string" && value.trim()) aliases.add(value); };
  const collectAliases = (trajectory: AtifObject) => {
    alias(object(trajectory.agent).model_name);
    for (const value of array(trajectory.steps)) {
      const step = object(value); alias(step.model_name); alias(object(step.extra).response_model);
    }
    for (const child of array(trajectory.subagent_trajectories)) collectAliases(object(child));
  };
  collectAliases(document);
  return { capture, dataset, coverage, resolver, mapping, projection, modelAliases: [...aliases].sort(),
    outcomeCapture: { ...capture, records: capture.records.map(({ reference, record }) => ({ reference, record: { schemaVersion: "ebo.imported-outcome-record/v1" as const, kind: "imported-source" as const, authority: "third-party" as const, document: record } })) } };
}
