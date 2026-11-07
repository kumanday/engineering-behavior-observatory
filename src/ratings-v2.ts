import { ratingAnswerSchemaV2 } from "./model-contracts-v2.js";
import { validateArtifact } from "./artifacts.js";
import { analysisDigestV2, citeEventV2, operationContentV2, type EvidenceCitationV2, type HashV2 } from "./analysis-v2.js";
import { boundedEvidence } from "./evidence-projection.js";
import type { RetainedBehaviorEvidenceV2 } from "./native-v2.js";
import { datasetV2Digest } from "./normalization-v2.js";
import { validateOccurrenceLedgerV2, type OccurrenceLedgerV2, type OccurrenceTypeV2 } from "./occurrences-v2.js";
import type { EvidenceValue } from "./uniform-events.js";

export type RatingInputV2 = {
  schemaVersion: "ebo.occurrence-rating-input/v2"; version: "2.0.0"; datasetDigest: HashV2; ledgerDigest: HashV2;
  occurrenceId: string; type: OccurrenceTypeV2; question: string;
  state: { evidence: Array<{ citationId: HashV2; content: string; truncated: boolean }>; facts: OccurrenceLedgerV2["occurrences"][number]["facts"]; operations: Array<{ id: string; toolName: EvidenceValue<string>; failure: EvidenceValue<boolean>;
    input: { content: string; truncated: boolean }; output: { content: string; truncated: boolean } }> };
  citations: EvidenceCitationV2[]; citationRegistry: Array<{ id: HashV2; citation: EvidenceCitationV2 }>; modelData: Record<string, unknown>; limits: { maxFieldChars: number; maxInputChars: number };
};
export type RatingAnswerV2 = { label: "supported" | "unsupported" | "unclear"; confidence: number; rationale: string; citationIds: string[] };
export type RatingRecordV2 = { schemaVersion: "ebo.occurrence-rating/v2"; inputDigest: HashV2; input: RatingInputV2; evaluator: { id: string; version: string; configurationDigest: HashV2 };
  status: "completed" | "failed"; accepted: boolean; answer?: RatingAnswerV2; error?: string };

export function blindTextV2(text: string, aliases: readonly string[]): string {
  if (aliases.length > 256 || aliases.some((alias) => !alias.trim() || alias.length > 1024)) throw new Error("V2 model alias inventory exceeds bounds.");
  for (const alias of [...new Set(aliases)].sort((a, b) => b.length - a.length || a.localeCompare(b))) text = text.replaceAll(alias, "[EVALUATED_MODEL]");
  return text;
}
export function blindValueV2(value: unknown, aliases: readonly string[]): unknown {
  if (typeof value === "string") return blindTextV2(value, aliases);
  if (Array.isArray(value)) return value.map((entry) => blindValueV2(entry, aliases));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [blindTextV2(key, aliases), blindValueV2(entry, aliases)]));
  return value;
}
const questions: Record<OccurrenceTypeV2, string> = {
  "execution-follow-up": "Does the subsequent recorded execution address the reported failure? Judge the execution relation only; model conditioning on the failure is unavailable. Abstain when evidence is insufficient.",
  "inference-conditioned-response": "Does the source-bound subsequent inference respond to the supplied failure? Abstain when the source conditioning binding or evidence is insufficient.",
  "validation-run": "Does the visible result support completion of the checks requested by this command? An unknown failure flag supplies no successful result. Abstain when evidence is insufficient.",
  "source-change": "Does the visible result support that the requested source edit completed? A write command alone establishes an attempt. Abstain when evidence is insufficient.",
  "repeated-operation": "Does the visible evidence support that these repeated operations served a new purpose? Repetition alone establishes no quality judgment. Abstain when evidence is insufficient.",
  compaction: "Does visible evidence support a substantive behavioral consequence of this recorded compaction? Abstain when surrounding context is insufficient.",
  delegation: "Does visible evidence support that the delegated work completed? A dispatch alone establishes an attempt. Abstain when evidence is insufficient.",
};
export async function prepareOccurrenceRatingInputsV2(evidence: RetainedBehaviorEvidenceV2, ledger: OccurrenceLedgerV2,
  limits = { maxFieldChars: 6000, maxInputChars: 40000 }): Promise<RatingInputV2[]> {
  await validateOccurrenceLedgerV2(ledger, evidence.dataset, evidence.resolver);
  if (ledger.occurrences.length && !evidence.modelAliases?.length) throw new Error("V2 rating preparation requires evaluated model aliases for blinding.");
  if (!Number.isSafeInteger(limits.maxFieldChars) || limits.maxFieldChars < 256 || limits.maxFieldChars > 100000 || !Number.isSafeInteger(limits.maxInputChars)
      || limits.maxInputChars < limits.maxFieldChars || limits.maxInputChars > 1000000) throw new Error("Invalid v2 rating bounds.");
  const operations = new Map(evidence.dataset.operations.map((operation) => [operation.id, operation]));
  const events = new Map(evidence.dataset.events.map((event) => [event.id, event]));
  const datasetDigest = datasetV2Digest(evidence.dataset), ledgerDigest = analysisDigestV2(ledger);
  const result: RatingInputV2[] = [];
  for (const occurrence of ledger.occurrences) {
    const rows: RatingInputV2["state"]["operations"] = [], citations = new Map<HashV2, EvidenceCitationV2>();
    for (const citation of occurrence.citations) citations.set(analysisDigestV2(citation), citation);
    for (const id of occurrence.operationIds) {
      const operation = operations.get(id)!;
      const content = async (role: "tool-input" | "tool-result") => {
        const roles: Array<"tool-input" | "tool-result" | "tool-error"> = role === "tool-result" ? ["tool-result", "tool-error"] : [role];
        const reads = roles.map((selected) => operationContentV2(evidence.dataset, operation, evidence.resolver, selected));
        const read = { values: reads.flatMap(({ values }) => values), citations: reads.flatMap(({ citations }) => citations) };
        for (const reference of read.citations) { const citation = await citeEventV2(evidence.dataset, evidence.resolver, reference.eventId, reference.nativeReference); citations.set(analysisDigestV2(citation), citation); }
        const bounded = boundedEvidence(read.values.length ? read.values : { status: "unknown", reason: "NORMALIZED_CONTENT_UNAVAILABLE" }, limits.maxFieldChars);
        return { ...bounded, content: blindTextV2(bounded.content, evidence.modelAliases ?? []) };
      };
      rows.push({ id, toolName: operation.toolName, failure: operation.failure, input: await content("tool-input"), output: await content("tool-result") });
    }
    const quoted: RatingInputV2["state"]["evidence"] = [];
    if (!occurrence.operationIds.length || occurrence.type === "delegation") for (const id of occurrence.eventIds) {
      const event = events.get(id)!;
      const citation = await citeEventV2(evidence.dataset, evidence.resolver, id);
      const raw = evidence.resolver.read(event.source.nativeReference);
      const bounded = boundedEvidence(raw === undefined ? { status: "unknown", reason: "RETAINED_EVENT_CONTENT_UNAVAILABLE" } : raw, limits.maxFieldChars);
      quoted.push({ citationId: analysisDigestV2(citation), ...bounded, content: blindTextV2(bounded.content, evidence.modelAliases ?? []) });
    }
    const input: RatingInputV2 = { schemaVersion: "ebo.occurrence-rating-input/v2", version: "2.0.0", datasetDigest, ledgerDigest,
      occurrenceId: occurrence.id, type: occurrence.type, question: questions[occurrence.type], state: { evidence: quoted, facts: blindValueV2(occurrence.facts, evidence.modelAliases ?? []) as RatingInputV2["state"]["facts"], operations: rows },
      citations: [...citations.values()], citationRegistry: [...citations].map(([id, citation]) => ({ id, citation })), modelData: {}, limits };
    input.modelData = blindValueV2({ question: input.question, state: input.state, occurrenceId: input.occurrenceId, type: input.type,
      citationRegistry: input.citationRegistry }, evidence.modelAliases ?? []) as Record<string, unknown>;
    if (JSON.stringify(input).length > limits.maxInputChars) throw new Error("V2 rating occurrence exceeds the input limit; raise the bound without dropping ledger members.");
    result.push(input);
  }
  return result;
}

/** Backend execution is explicit. Preparation never dispatches paid inference. */
export async function rateOccurrenceV2(input: RatingInputV2, evaluator: RatingRecordV2["evaluator"], run: (modelData: Record<string, unknown>, responseSchema: Record<string, unknown>) => Promise<RatingAnswerV2>): Promise<RatingRecordV2> {
  if (validateArtifact("V2 rating input", input).length) throw new Error("Invalid v2 rating input.");
  const base = { schemaVersion: "ebo.occurrence-rating/v2" as const, inputDigest: analysisDigestV2(input), input: structuredClone(input), evaluator: structuredClone(evaluator) };
  try {
    const answer = await run(structuredClone(input.modelData), ratingAnswerSchemaV2());
    if (!answer || Object.keys(answer).sort().join(",") !== "citationIds,confidence,label,rationale") throw new Error("Invalid v2 rating answer shape.");
    if (!answer || !["supported", "unsupported", "unclear"].includes(answer.label) || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1
      || typeof answer.rationale !== "string" || !answer.rationale.trim() || answer.rationale.length > 12000 || !Array.isArray(answer.citationIds)
      || new Set(answer.citationIds).size !== answer.citationIds.length || answer.citationIds.some((id) => !input.citations.some((citation) => analysisDigestV2(citation) === id))
      || answer.label !== "unclear" && !answer.citationIds.length) throw new Error("Invalid v2 rating answer or citations.");
    return { ...base, status: "completed", accepted: answer.label !== "unclear" && answer.confidence >= 0.8, answer: structuredClone(answer) };
  } catch (error) { return { ...base, status: "failed", accepted: false, error: (error instanceof Error ? error.message.slice(0, 12000).trim() : "") || "Rating backend failed" }; }
}

export async function validateRatingRecordV2(record: RatingRecordV2, evidence: RetainedBehaviorEvidenceV2, ledger: OccurrenceLedgerV2): Promise<void> {
  await validateRatingRecordsV2([record], evidence, ledger);
}

/** Reconstruct each bounded input population once, retaining independent validation of every receipt. */
export async function validateRatingRecordsV2(records: readonly RatingRecordV2[], evidence: RetainedBehaviorEvidenceV2, ledger: OccurrenceLedgerV2): Promise<void> {
  const inputsByLimits = new Map<string, Map<string, RatingInputV2>>();
  for (const record of records) {
    if (validateArtifact("V2 rating", record).length) throw new Error("Invalid v2 rating record.");
    const key = analysisDigestV2(record.input.limits);
    let inputs = inputsByLimits.get(key);
    if (!inputs) {
      inputs = new Map((await prepareOccurrenceRatingInputsV2(evidence, ledger, record.input.limits)).map((input) => [input.occurrenceId, input]));
      inputsByLimits.set(key, inputs);
    }
    const expected = inputs.get(record.input.occurrenceId);
    if (!expected || analysisDigestV2(expected) !== record.inputDigest || analysisDigestV2(record.input) !== record.inputDigest) throw new Error("V2 rating input is stale or cross-ledger.");
    if (record.status === "failed") {
      if (record.accepted || record.answer !== undefined || typeof record.error !== "string" || !record.error) throw new Error("Invalid failed v2 rating.");
    } else {
      if (!record.answer) throw new Error("Missing v2 rating answer.");
      const verified = await rateOccurrenceV2(expected, record.evaluator, async () => record.answer!);
      if (analysisDigestV2(verified) !== analysisDigestV2(record)) throw new Error("V2 rating acceptance or answer is invalid.");
    }
  }
}
