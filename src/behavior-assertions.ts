import type { RetainedNormalizationInput } from "./uniform-events.js";
import {
  behaviorOntologyDigest, decideFromProbabilities, loadDefaultBehaviorOntology, resolveBehaviorDecision,
  type BehaviorOntology, type BehaviorReference, type BehaviorVerdict, type DecisionModelProbabilities, type DecisionThresholds,
} from "./behavior-ontology.js";
import { createRetainedBehaviorEvidence } from "./retained-evidence.js";
import { evidenceWorkspaces } from "./evidence-projection.js";

import {
  CLAUDE_AGENT_SDK_NORMALIZATION_ADAPTER_VERSION,
  claudeAgentSdkNormalizationAdapter,
  createAgentSdkNativeEvidenceResolver,
  readQualifiedClaudeAgentSdkCapture,
  type AgentSdkNativeRecord,
} from "./agent-sdk-normalizer.js";
import { canonicalizeMetadata, digestMetadata, validateArtifact } from "./artifacts.js";
import {
  describeNormalizedDataset,
  validateNormalizedDataset,
  type AdapterCoverageReport,
  type NormalizedDataset,
} from "./normalization-integrity.js";
import type {
  NativeEvidenceReference,
  NativeEvidenceResolution,
  NativeEvidenceResolver,
  NormalizationInput,
} from "./uniform-events.js";

type DigestString = `sha256:${string}`;
type VersionedIdentity = { id: string; version: string };

export type BehaviorCitation = {
  eventId: string;
  nativeReference: NativeEvidenceReference;
  /** The occurrence this event stands for, when the judge cited it from the occurrence ledger. */
  occurrenceId?: string;
};

/** One factual claim with its own citations and, when known, the exact cited working directory it concerns. */
export type BehaviorClaim = {
  id: string;
  text: string;
  citations: readonly BehaviorCitation[];
  workspace: string | null;
};

type JudgmentEvidence = {
  /** An LLM judge's verdict rests on the events it cites and the reasons it gives. */
  basis: "cited-evidence";
  rationale: string;
  alternativeExplanation: string;
  citations: readonly BehaviorCitation[];
  claims?: readonly BehaviorClaim[];
};

/** The card's situation occurred and its evidence test passed. A dimension card names exactly one of its values. */
type PresentJudgment = JudgmentEvidence & {
  verdict: "present";
  value?: string;
  confidence: { value: number; scale: "evaluator-reported-0-to-1" };
};

/** The record shows the card's trigger or test did not occur. Citations are optional: absence may have no event to cite. */
type AbsentJudgment = JudgmentEvidence & {
  verdict: "absent";
  confidence: { value: number; scale: "evaluator-reported-0-to-1" };
};

/** The abstention: the record lacks the steps the card's test needs. */
type UnknownJudgment = JudgmentEvidence & {
  verdict: "unknown";
  reason: string;
  missingEvidenceCapability?: string;
};

export type LlmJudgment = PresentJudgment | AbsentJudgment | UnknownJudgment;

/**
 * A decision model returns probabilities and nothing else: no cited events, no rationale, no alternative explanation.
 * The verdict is those probabilities under the thresholds stated here, and `unknown` is the abstention.
 */
export type DecisionModelJudgment = {
  basis: "probabilities";
  verdict: BehaviorVerdict;
  value?: string;
  probabilities: DecisionModelProbabilities;
  thresholds: DecisionThresholds;
};

export type BehaviorJudgment = LlmJudgment | DecisionModelJudgment;

/** The two ways a card result is produced. Consumers show the mode with every result and never pool the two. */
export const BEHAVIOR_PRODUCER_MODES = ["llm-judge", "decision-model"] as const;
export type BehaviorProducerMode = (typeof BEHAVIOR_PRODUCER_MODES)[number];
export type BehaviorProducer<Mode extends BehaviorProducerMode = BehaviorProducerMode> = {
  mode: Mode;
  provider: string;
  model: string;
  version: string;
  configurationDigest?: DigestString;
};

/** The card a result is about, with the digest of the exact ontology text it was judged against. */
export type JudgedBehavior = BehaviorReference & { ontologyDigest: DigestString };

/** What an LLM judge was shown: a selection of the attempt's events under stated limits, never the whole attempt. */
export type LlmJudgeEvidence = {
  scope: "selected-events";
  events: { included: number; total: number };
  structuralObservations: number;
  occurrenceLedgerRows: number;
  omitted: number;
  truncated: number;
  limits: { maxEvidenceItems: number; maxRecordChars: number; maxInputChars: number; maxCitations: number };
};

/** What a decision model was shown: every recorded step (or a stated excerpt), with each field cut to a stated length. */
export type DecisionModelEvidence = {
  scope: "all-steps" | "step-excerpt";
  steps: { included: number; total: number };
  rendering: { id: string; version: string };
  fieldChars: { min: number; max: number };
  budgetChars: number;
};

type AssertionIdentity = {
  schemaVersion: "ebo.behavior-assertion/v2";
  id: string;
  runId: string;
  attemptId: string;
  dataset: { schemaVersion: "ebo.normalized-dataset/v1"; digest: DigestString };
  behavior: JudgedBehavior;
};

export type LlmJudgeAssertion = AssertionIdentity & {
  producer: BehaviorProducer<"llm-judge">;
  rubric: VersionedIdentity;
  evidence: LlmJudgeEvidence;
  judgment: LlmJudgment;
};

export type DecisionModelAssertion = AssertionIdentity & {
  producer: BehaviorProducer<"decision-model">;
  evidence: DecisionModelEvidence;
  judgment: DecisionModelJudgment;
};

/** One verdict on one card for one attempt, from either producer mode. */
export type BehaviorAssertion = LlmJudgeAssertion | DecisionModelAssertion;

export function isDecisionModelAssertion(assertion: BehaviorAssertion): assertion is DecisionModelAssertion {
  return assertion.producer.mode === "decision-model";
}

/** A short identity for display and grouping: mode, provider and model. */
export function producerLabel(producer: BehaviorProducer): string {
  return `${producer.mode} ${producer.provider}/${producer.model}`;
}

export type BehaviorReview = {
  schemaVersion: "ebo.behavior-review/v1";
  id: string;
  assertion: { id: string; schemaVersion: "ebo.behavior-assertion/v2"; digest: DigestString };
  state: "proposed" | "confirmed" | "disputed" | "rejected" | "insufficient-evidence";
  reviewer?: { kind: "human"; id: string };
  rationale?: string;
};

export type ResolvedBehaviorCitation = BehaviorCitation & {
  resolution: NativeEvidenceResolution;
};

export type AgentSdkBehaviorEvidence = {
  capture: NormalizationInput<AgentSdkNativeRecord>;
  dataset: NormalizedDataset;
  resolver: NativeEvidenceResolver;
  coverage: AdapterCoverageReport;
};

export async function validateBehaviorAssertion(
  assertion: BehaviorAssertion,
  dataset: NormalizedDataset,
  resolver: NativeEvidenceResolver,
  ontology: BehaviorOntology = loadDefaultBehaviorOntology(),
  capture?: RetainedNormalizationInput<unknown>,
): Promise<readonly ResolvedBehaviorCitation[]> {
  assertValid("behavior assertion", assertion);
  const card = resolveBehaviorDecision(assertion.behavior, assertion.judgment, ontology);
  if (assertion.behavior.ontologyDigest !== behaviorOntologyDigest(ontology)) throw new Error("Behavior assertion was judged against other card texts: its ontology digest does not match.");
  if (isDecisionModelAssertion(assertion)) {
    const { judgment, evidence } = assertion;
    const decided = decideFromProbabilities(card, judgment.probabilities, judgment.thresholds);
    const tied = decided.value !== undefined && judgment.value !== undefined && "applies" in judgment.probabilities
      && judgment.probabilities.values[judgment.value] === judgment.probabilities.values[decided.value];
    if (decided.verdict !== judgment.verdict || (decided.value !== judgment.value && !tied)) {
      throw new Error("Decision-model verdict or value does not follow from its probabilities and thresholds.");
    }
    if (evidence.steps.included > evidence.steps.total || (evidence.scope === "all-steps") !== (evidence.steps.included === evidence.steps.total)
        || evidence.fieldChars.min > evidence.fieldChars.max) {
      throw new Error("Decision-model evidence description is inconsistent.");
    }
  } else if (assertion.evidence.events.included > assertion.evidence.events.total) {
    throw new Error("LLM-judge evidence description is inconsistent.");
  }
  const datasetDigest = await validatedDatasetDigest(dataset, resolver);
  if (assertion.dataset.schemaVersion !== dataset.schemaVersion || assertion.dataset.digest !== datasetDigest) {
    throw new Error("Behavior assertion normalized dataset version or digest does not match.");
  }
  if (assertion.runId !== dataset.runId || assertion.attemptId !== dataset.attemptId) {
    throw new Error("Behavior assertion belongs to the wrong run or attempt.");
  }
  const eventIds = new Set<string>();
  const citations = isDecisionModelAssertion(assertion) ? [] : assertion.judgment.citations;
  // The lookups are built only for an assertion with citations; a decision-model assertion has none.
  const { events, records } = citations.length ? datasetLookups(dataset) : { events: new Map<string, never>(), records: new Map<string, never>() };
  const resolved: ResolvedBehaviorCitation[] = [];
  for (const citation of citations) {
    if (eventIds.has(citation.eventId)) throw new Error(`Behavior assertion cites event "${citation.eventId}" more than once.`);
    eventIds.add(citation.eventId);
    const event = events.get(citation.eventId);
    if (event === undefined) throw new Error(`Behavior assertion cites unknown normalized event "${citation.eventId}".`);
    if (referenceKey(citation.nativeReference) !== referenceKey(event.source.nativeReference)) {
      throw new Error(`Behavior assertion citation for event "${citation.eventId}" does not match its native source.`);
    }
    const nativeRecord = records.get(referenceKey(citation.nativeReference));
    if (nativeRecord === undefined) {
      throw new Error(`Behavior assertion citation for event "${citation.eventId}" has no captured native record.`);
    }
    const resolution = await resolver.resolve(citation.nativeReference);
    if (typeof resolution !== "object" || resolution.runId !== dataset.runId
        || resolution.attemptId !== dataset.attemptId || resolution.digest !== nativeRecord.digest) {
      throw new Error(`Behavior assertion citation for event "${citation.eventId}" is stale or belongs to another attempt.`);
    }
    resolved.push({ ...structuredClone(citation), resolution });
  }
  validateClaimCitations(assertion);
  validateClaimWorkspaces(assertion, capture);
  return resolved;
}

/** A claim's workspace must be the one working directory its cited native records state explicitly. */
export function validateClaimWorkspaces(assertion: BehaviorAssertion, capture?: RetainedNormalizationInput<unknown>): void {
  if (isDecisionModelAssertion(assertion)) return;
  for (const claim of assertion.judgment.claims ?? []) {
    if (claim.workspace === null) continue;
    if (capture === undefined) throw new Error("Validating a claim workspace needs the native capture.");
    const scopes = claim.citations.flatMap(({ nativeReference }) => {
      const native = capture.records.find(({ reference }) => reference.artifactId === nativeReference.artifactId && reference.recordLocator === nativeReference.recordLocator);
      return native === undefined ? [] : evidenceWorkspaces(native.record);
    });
    if (!scopes.includes(claim.workspace) || scopes.some((scope) => scope !== claim.workspace)) {
      throw new Error(`Claim "${claim.id}" names a workspace its cited records do not state unambiguously; use null for unknown scope.`);
    }
  }
}

/** Claim ids are unique, and each claim cites a subset of the assertion's citations without repeats. */
export function validateClaimCitations(assertion: BehaviorAssertion): void {
  if (isDecisionModelAssertion(assertion)) return;
  const seen = new Set<string>();
  const citations = new Set(assertion.judgment.citations.map((citation) => canonicalizeMetadata(citation)));
  for (const claim of assertion.judgment.claims ?? []) {
    if (seen.has(claim.id)) throw new Error("Claim ids must be unique.");
    seen.add(claim.id);
    const own = claim.citations.map((citation) => canonicalizeMetadata(citation));
    if (new Set(own).size !== own.length || own.some((citation) => !citations.has(citation))) {
      throw new Error(`Claim "${claim.id}" citations must be unique and among the assertion's citations.`);
    }
  }
}

export function validateBehaviorReview(assertion: BehaviorAssertion, review: BehaviorReview): void {
  assertValid("behavior assertion", assertion);
  assertValid("behavior review", review);
  if (review.assertion.id !== assertion.id || review.assertion.schemaVersion !== assertion.schemaVersion
      || review.assertion.digest !== digest(assertion)) {
    throw new Error("Behavior review assertion identity or digest does not match.");
  }
}

export async function isConfirmedBehaviorAssertion(
  assertion: BehaviorAssertion,
  dataset: NormalizedDataset,
  resolver: NativeEvidenceResolver,
  review?: BehaviorReview,
  ontology: BehaviorOntology = loadDefaultBehaviorOntology(),
  capture?: RetainedNormalizationInput<unknown>,
): Promise<boolean> {
  await validateBehaviorAssertion(assertion, dataset, resolver, ontology, capture);
  if (review === undefined) return false;
  validateBehaviorReview(assertion, review);
  return assertion.judgment.verdict !== "unknown" && review.state === "confirmed";
}

export async function validateAgentSdkBehaviorAssertion(
  bundleRoot: string,
  assertion: BehaviorAssertion,
  review?: BehaviorReview,
): Promise<readonly ResolvedBehaviorCitation[]> {
  const { dataset, resolver, capture } = await createAgentSdkBehaviorEvidence(bundleRoot);
  const citations = await validateBehaviorAssertion(assertion, dataset, resolver, undefined, capture);
  if (review !== undefined) validateBehaviorReview(assertion, review);
  return citations;
}

export async function createAgentSdkBehaviorEvidence(bundleRoot: string): Promise<AgentSdkBehaviorEvidence> {
  const evidence = await createRetainedBehaviorEvidence(bundleRoot);
  if (evidence.dataset.capabilityProfile.harness !== "claude-agent-sdk") throw new Error("Run bundle is not an Agent SDK capture.");
  return evidence as AgentSdkBehaviorEvidence;
}

/** Internal projection; the public reader binds the frozen verification interpretation first. */
export async function projectAgentSdkBehaviorEvidence(bundleRoot: string): Promise<AgentSdkBehaviorEvidence> {
  const capture = await readQualifiedClaudeAgentSdkCapture(bundleRoot);
  const normalization = await claudeAgentSdkNormalizationAdapter.normalize(capture);
  const dataset = describeNormalizedDataset({
    capture,
    normalization,
    capabilityProfile: normalization.capabilityProfile,
    adapterVersion: CLAUDE_AGENT_SDK_NORMALIZATION_ADAPTER_VERSION,
    nativeType: agentSdkNativeType,
    contentDigest: (reference) => agentSdkContentDigest(capture, reference),
  });
  const resolver = createAgentSdkNativeEvidenceResolver(capture);
  const coverage = await validateNormalizedDataset(dataset, resolver);
  return { capture, dataset, resolver, coverage };
}

/**
 * A dataset is validated against its resolver and digested once; every card result checked against the same retained
 * evidence reuses that result. The cache follows the objects, so it ends with the evidence.
 */
const validatedDatasets = new WeakMap<NormalizedDataset, WeakMap<NativeEvidenceResolver, Promise<DigestString>>>();
function validatedDatasetDigest(dataset: NormalizedDataset, resolver: NativeEvidenceResolver): Promise<DigestString> {
  const byResolver = validatedDatasets.get(dataset) ?? new WeakMap<NativeEvidenceResolver, Promise<DigestString>>();
  validatedDatasets.set(dataset, byResolver);
  let result = byResolver.get(resolver);
  if (result === undefined) {
    result = validateNormalizedDataset(dataset, resolver).then(() => digest(dataset));
    byResolver.set(resolver, result);
    // A failed validation is not remembered: the next check runs it again and reports the same failure.
    result.catch(() => byResolver.delete(resolver));
  }
  return result;
}

export async function validateRetainedBehaviorAssertion(bundleRoot: string, assertion: BehaviorAssertion, review?: BehaviorReview): Promise<readonly ResolvedBehaviorCitation[]> {
  const { dataset, resolver, capture } = await createRetainedBehaviorEvidence(bundleRoot);
  const citations = await validateBehaviorAssertion(assertion, dataset, resolver, undefined, capture);
  if (review !== undefined) validateBehaviorReview(assertion, review);
  return citations;
}

function digest(value: unknown): DigestString {
  return `sha256:${digestMetadata(value).value}`;
}

/** Events by id and native records by reference, once per dataset's arrays (every assertion of an attempt shares them). */
const lookups = new WeakMap<object, { events: Map<string, NormalizedDataset["events"][number]>; records: Map<string, NormalizedDataset["nativeRecords"][number]> }>();
function datasetLookups(dataset: NormalizedDataset) {
  const known = lookups.get(dataset.nativeRecords);
  if (known !== undefined && lookups.get(dataset.events) === known) return known;
  const built = { events: new Map(dataset.events.map((event) => [event.id, event])), records: new Map(dataset.nativeRecords.map((record) => [referenceKey(record.reference), record])) };
  lookups.set(dataset.nativeRecords, built); lookups.set(dataset.events, built);
  return built;
}

function referenceKey(reference: NativeEvidenceReference): string {
  return canonicalizeMetadata(reference);
}

function assertValid(label: string, value: unknown): void {
  const errors = validateArtifact(label, value);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${label} ${field}: ${message}`).join("\n"));
}

function agentSdkNativeType(record: AgentSdkNativeRecord): string {
  const document = asRecord(record.document);
  if (record.kind === "session") return text(document?.nativeType) ?? "session";
  if (record.kind === "hook") return text(document?.hook) ?? "hook";
  return ({
    telemetry: "agent-sdk-telemetry",
    workspace: "workspace-outcome",
    verifier: "verifier-result",
    "assessment-mode": "assessment-mode",
    manifest: "terminal-record",
  } as Partial<Record<AgentSdkNativeRecord["kind"], string>>)[record.kind] ?? record.kind;
}

function agentSdkContentDigest(
  capture: NormalizationInput<AgentSdkNativeRecord>,
  reference: NativeEvidenceReference,
): DigestString | undefined {
  for (const { record } of capture.records) {
    if (record.kind !== "workspace" && record.kind !== "diagnostic") continue;
    const descriptor = asRecord(record.document);
    if (descriptor?.id === reference.artifactId && typeof descriptor.digest === "string"
        && /^sha256:[a-f0-9]{64}$/u.test(descriptor.digest)) return descriptor.digest as DigestString;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
