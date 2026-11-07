import { analysisDigestV2, citeEventV2, operationContentV2, operationEventsV2, operationScopeV2, type EvidenceCitationV2, type HashV2 } from "./analysis-v2.js";
import { datasetV2Digest, precedes, validateNormalizedDatasetV2, type NormalizedDatasetV2, type Operation } from "./normalization-v2.js";
import type { SourceEvidenceResolverV2 } from "./native-v2.js";
import { checkKindsOf, findCommand, shellWrites } from "./occurrences.js";
import { known, unreported } from "./projection-v2.js";
import type { EvidenceValue } from "./uniform-events.js";

export const OCCURRENCE_V2_TYPES = ["execution-follow-up", "inference-conditioned-response", "validation-run", "source-change", "repeated-operation", "compaction", "delegation"] as const;
export type OccurrenceTypeV2 = typeof OCCURRENCE_V2_TYPES[number];
export type OccurrenceV2 = {
  schemaVersion: "ebo.occurrence/v2"; id: string; type: OccurrenceTypeV2;
  rule: { version: "2.0.0"; heuristic: boolean }; operationIds: string[]; eventIds: string[];
  citations: EvidenceCitationV2[]; facts: Record<string, EvidenceValue<string | boolean | number | string[]>>;
};
export type OccurrenceLedgerV2 = {
  schemaVersion: "ebo.occurrence-ledger/v2"; runId: string; attemptId: string; datasetDigest: HashV2;
  occurrences: OccurrenceV2[]; coverage: Array<{ type: OccurrenceTypeV2; count: number; limitation: EvidenceValue<string> }>;
};
function sameOutput(a: Operation, b: Operation): boolean {
  return a.issuingInference.status === "known" && b.issuingInference.status === "known"
    && a.identity.sourceId === b.identity.sourceId && analysisDigestV2(a.issuingInference.value) === analysisDigestV2(b.issuingInference.value);
}
function compatible(a: Operation, b: Operation): boolean {
  const scope = operationScopeV2(a);
  return !!scope && a.identity.sourceId === b.identity.sourceId && scope === operationScopeV2(b);
}
function position(dataset: NormalizedDatasetV2, nativeOrder: Operation["startOrder"]) { return { runId: dataset.runId, attemptId: dataset.attemptId, nativeOrder }; }

/** Command semantics are shared text heuristics. Native fields never enter the consumer. */
export function operationCommandV2(dataset: NormalizedDatasetV2, operation: Operation, resolver: SourceEvidenceResolverV2): string | undefined {
  const commands = new Set<string>();
  for (let value of operationContentV2(dataset, operation, resolver, "tool-input").values) {
    if (typeof value === "string") {
      try { value = JSON.parse(value) as unknown; } catch { /* A shell's canonical input can be a scalar command. */ }
    }
    const command = typeof value === "string" && operation.toolName.status === "known" && /^(?:bash|shell|terminal|commandExecution)$/iu.test(operation.toolName.value)
      ? value : findCommand(value);
    if (command) commands.add(command);
  }
  return commands.size === 1 ? [...commands][0] : undefined;
}

export async function createOccurrenceLedgerV2(dataset: NormalizedDatasetV2, resolver: SourceEvidenceResolverV2): Promise<OccurrenceLedgerV2> {
  await validateNormalizedDatasetV2(dataset, resolver);
  const boundDigest = datasetV2Digest(dataset);
  const occurrences: OccurrenceV2[] = [], events = new Map(dataset.events.map((event) => [event.id, event]));
  const limitations = new Map<OccurrenceTypeV2, string>();
  const add = async (type: OccurrenceTypeV2, operations: Operation[], ids: string[], facts: OccurrenceV2["facts"], heuristic = false) => {
    const eventIds = [...new Set(ids)].sort(), operationIds = operations.map(({ id }) => id).sort();
    const identity = { dataset: boundDigest, type, operationIds, eventIds, facts };
    occurrences.push({ schemaVersion: "ebo.occurrence/v2", id: `occurrence:${analysisDigestV2(identity).slice(7)}`, type,
      rule: { version: "2.0.0", heuristic }, operationIds, eventIds, facts,
      citations: await Promise.all(eventIds.map((id) => citeEventV2(dataset, resolver, id))) });
  };
  const tools = dataset.operations.filter(({ identity }) => identity.kind === "tool");
  for (const operation of tools) {
    const command = operationCommandV2(dataset, operation, resolver), ids = operationEventsV2(dataset, operation).map(({ id }) => id);
    if (command) {
      const kinds = checkKindsOf(command);
      if (kinds.length) await add("validation-run", [operation], ids, { kinds: known(kinds), outcomeFailure: operation.failure }, true);
      const writes = shellWrites(command);
      if (writes.length) await add("source-change", [operation], ids, { paths: known(writes), stateChanged: unreported, outcomeFailure: operation.failure }, true);
    } else limitations.set("validation-run", "SOME_NORMALIZED_COMMAND_INPUTS_UNAVAILABLE");
    if (operation.toolName.status === "known" && /^(?:edit|write|create|notebookedit|multiedit|apply_patch|str_replace|str_replace_editor|write_file|edit_file|patch|filechange)$/iu.test(operation.toolName.value) && !command) {
      await add("source-change", [operation], ids, { stateChanged: unreported, outcomeFailure: operation.failure }, true);
    }
  }
  // Choose only a uniquely earliest, comparable call after an explicit failed endpoint.
  for (const failed of tools.filter(({ failure }) => failure.status === "known" && failure.value)) {
    const endpoints = failed.resultEventIds.map((id) => events.get(id)!).filter((event) => event.facts.operation?.endpoint === "result" && event.facts.operation.failure.status === "known" && event.facts.operation.failure.value);
    const end = endpoints.find((event) => event.nativeOrder.status === "known" && failed.endOrder.status === "known"
      && event.nativeOrder.domain === failed.endOrder.domain && event.nativeOrder.value === failed.endOrder.value);
    if (!end || !operationScopeV2(failed)) { limitations.set("execution-follow-up", "FAILURE_ENDPOINT_ORDER_OR_SCOPE_UNAVAILABLE"); continue; }
    const population = tools.filter((candidate) => candidate.id !== failed.id && compatible(failed, candidate) && !sameOutput(failed, candidate));
    if (population.some((candidate) => candidate.startOrder.status !== "known" || precedes(end, position(dataset, candidate.startOrder)) === "unknown")) {
      limitations.set("execution-follow-up", "INCOMPARABLE_FOLLOW_UP_POPULATION"); continue;
    }
    const later = population.filter((candidate) => precedes(end, position(dataset, candidate.startOrder)) === "before");
    const next = later.filter((candidate) => later.every((other) => candidate.id === other.id || precedes(position(dataset, candidate.startOrder), position(dataset, other.startOrder)) === "before"));
    if (next.length !== 1) { limitations.set("execution-follow-up", "NO_UNIQUE_RECORDED_FOLLOW_UP"); continue; }
    const following = next[0]!;
    await add("execution-follow-up", [failed, following], [end.id, ...following.callEventIds], { failedOperation: known(failed.id), followingOperation: known(following.id), modelConditionedOnFailure: unreported });
  }
  // A chronological relation cannot establish that an inference received the failure as input.
  limitations.set("inference-conditioned-response", "SOURCE_CONDITIONING_BINDING_UNAVAILABLE");
  const signatures = new Map<string, Operation[]>();
  for (const operation of tools) {
    const scope = operationScopeV2(operation);
    if (!scope || operation.identity.identityClass === "ebo-derived" || operation.toolName.status !== "known" || operation.inputDigest.status !== "known") {
      limitations.set("repeated-operation", "SOME_OPERATION_SIGNATURES_UNAVAILABLE"); continue;
    }
    const key = JSON.stringify([operation.identity.sourceId, scope, operation.toolName.value, operation.inputDigest.value]);
    signatures.set(key, [...signatures.get(key) ?? [], operation]);
  }
  for (const group of signatures.values()) if (group.length > 1) await add("repeated-operation", group,
    group.flatMap((operation) => operationEventsV2(dataset, operation).map(({ id }) => id)), { repetitions: known(group.length - 1), chronologicalFirst: unreported });
  for (const event of dataset.events) if (event.facts.context?.type === "compaction") await add("compaction", [], [event.id], { replacementBoundaryKnown: known(event.facts.context.replacementBoundary.status === "known") });
  for (const operation of dataset.operations.filter(({ identity }) => identity.kind === "delegation")) await add("delegation", [operation], operationEventsV2(dataset, operation).map(({ id }) => id), { outcomeFailure: operation.failure });
  for (const type of OCCURRENCE_V2_TYPES) if (!occurrences.some((row) => row.type === type) && !limitations.has(type)) limitations.set(type, "RECORDED_POPULATION_COMPLETENESS_UNREPORTED");
  return { schemaVersion: "ebo.occurrence-ledger/v2", runId: dataset.runId, attemptId: dataset.attemptId, datasetDigest: boundDigest,
    occurrences: occurrences.sort((a, b) => a.id.localeCompare(b.id)), coverage: OCCURRENCE_V2_TYPES.map((type) => ({ type, count: occurrences.filter((row) => row.type === type).length,
      limitation: limitations.has(type) ? known(limitations.get(type)!) : unreported })) };
}

export async function validateOccurrenceLedgerV2(ledger: OccurrenceLedgerV2, dataset: NormalizedDatasetV2, resolver: SourceEvidenceResolverV2): Promise<void> {
  if (analysisDigestV2(ledger) !== analysisDigestV2(await createOccurrenceLedgerV2(dataset, resolver))) throw new Error("V2 occurrence ledger differs from its bound dataset and extractor.");
}
