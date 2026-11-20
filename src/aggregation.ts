import { join, resolve } from "node:path";

import { canonicalizeMetadata, digestBytes, digestMetadata, validateArtifact } from "./artifacts.js";
import { isDecisionModelAssertion, validateRetainedBehaviorAssertion, type BehaviorAssertion, type BehaviorProducer } from "./behavior-assertions.js";
import { BEHAVIOR_DIRECTIONS, BEHAVIOR_VERDICTS, behaviorDirection, loadDefaultBehaviorOntology, resolveBehaviorCard, type BehaviorCard, type BehaviorDecision, type BehaviorDirection, type BehaviorVerdict } from "./behavior-ontology.js";
import type { CorpusIndexEntry } from "./corpus.js";
import {
  effectiveReviewOutcome,
  isDisputedReviewOutcome,
  revalidateReviewSample,
  validateReviewHistory,
  type ReviewHistory,
  type ReviewSample,
} from "./human-calibration.js";
import { assessComparisonEligibility, type ComparisonCapability, type ComparisonReport, type ComparisonRequest } from "./normalization-integrity.js";
import { readBoundedFile } from "./scheduler.js";
import { createRetainedStructuralObservationSet, type StructuralObservationSet } from "./structural-observations.js";
import { withRetainedEvidenceReuse } from "./retained-evidence.js";

export type AggregationDimension = "task" | "model" | "harness" | "trial" | "capture-qualification" | "evidence-origin";
export type EvidenceOriginSelection = "owned" | "imported" | "separate";
export type AttemptSelectionPolicy = "all-attempts" | "latest-attempt-per-run";

export type AggregationRequest = {
  schemaVersion: "ebo.aggregation-request/v2";
  sources: {
    corpusRoot: string;
    corpusIndex: string;
    observationSets: ReadonlyArray<{ bundleRoot: string; path: string }>;
    assertions: ReadonlyArray<{ bundleRoot: string; path: string }>;
    /** JSON Lines files of behavior assertions for one bundle, one assertion per line, as decision-model judging writes them. */
    assertionSets?: ReadonlyArray<{ bundleRoot: string; path: string }>;
    calibrations: ReadonlyArray<{ selection: string; history: string }>;
  };
  groupBy: readonly AggregationDimension[];
  evidenceOrigins?: EvidenceOriginSelection;
  selectedAttemptPolicy: AttemptSelectionPolicy;
  recurrence: { minimumOccurrences: number };
  comparisons: ReadonlyArray<{
    id: string;
    measure: string;
    left: Partial<Record<AggregationDimension, string>>;
    right: Partial<Record<AggregationDimension, string>>;
    matchBy: readonly AggregationDimension[];
    eligibilityGates: ReadonlyArray<{ request: string; report: string }>;
  }>;
};

export type AggregationInput = {
  lineage?: { requestDigest?: `sha256:${string}`; corpusIndexDigest?: `sha256:${string}` };
  corpusEntries: readonly CorpusIndexEntry[];
  observationSets: ReadonlyArray<{ bundleRoot: string; document: StructuralObservationSet }>;
  assertions: ReadonlyArray<{ bundleRoot: string; document: BehaviorAssertion }>;
  calibrations: ReadonlyArray<{ selection: ReviewSample; history: ReviewHistory }>;
  comparisons: ReadonlyArray<{
    id: string;
    measure: string;
    left: Partial<Record<AggregationDimension, string>>;
    right: Partial<Record<AggregationDimension, string>>;
    matchBy: readonly AggregationDimension[];
    eligibility: ReadonlyArray<{ request: ComparisonRequest; report: ComparisonReport }>;
  }>;
};

export type AggregateMeasurement = {
  status: "available" | "unavailable";
  numerator: { value: number; unit: string };
  denominator: { value: number; unit: string };
  rate?: number;
  exclusions: ReadonlyArray<{ reason: string; count: number; unit: string }>;
  reason?: string;
};

export type AggregateMetric = {
  id: string;
  population: "run" | "attempt" | "operation" | "assertion" | "reviewed-assertion";
  claimStatus: "descriptive" | "unavailable";
  measurement: AggregateMeasurement;
};

/**
 * One card under one producer (and, for an LLM judge, one rubric). Results of an LLM judge and of a decision model are
 * never pooled: each producer has its own entries. Entries are ordered by family, then by card, as the ontology orders them.
 */
export type BehaviorAggregate = {
  behavior: BehaviorAssertion["behavior"];
  /** The card's family in the behavior ontology. */
  family: string;
  /** Who produced these results, including the mode: `llm-judge` or `decision-model`. */
  producer: BehaviorProducer;
  /** LLM-judge entries only. */
  rubric?: { id: string; version: string };
  /** Selected attempts whose judge runs for this card agree on one verdict and, where present, one value. */
  population: "judged-attempt-card";
  verdicts: ReadonlyArray<{ verdict: BehaviorVerdict; measurement: AggregateMeasurement }>;
  /** Dimension cards only: each named value's share of the attempts judged present. */
  values?: ReadonlyArray<{ value: string; measurement: AggregateMeasurement }>;
  assertions: ReadonlyArray<{
    runId: string; attemptId: string; id: string; digest: `sha256:${string}`;
    reviewOutcome: ReturnType<typeof effectiveReviewOutcome>; disputed: boolean;
    included: boolean;
  }>;
};

/**
 * How one producer's (and, for an LLM judge, one rubric's) present results divide by direction, for one family or for all cards (`family: "all"`). The
 * direction comes from the ontology. Neutral results are counted and never scored.
 */
export type DirectionAggregate = {
  /** The same producer identity as a per-card entry, configuration digest included. */
  producer: BehaviorProducer;
  /** LLM-judge entries only. */
  rubric?: { id: string; version: string };
  family: string;
  /** Of the attempt-cards judged present, the share with each direction. */
  results: ReadonlyArray<{ direction: BehaviorDirection; measurement: AggregateMeasurement }>;
  /** Of the attempts with at least one judged card, the share with at least one present result of each direction. */
  attempts: ReadonlyArray<{ direction: BehaviorDirection; measurement: AggregateMeasurement }>;
};

export type AggregationReport = {
  schemaVersion: "ebo.aggregation-report/v2";
  policy: {
    groupBy: readonly AggregationDimension[];
    evidenceOrigins?: EvidenceOriginSelection;
    selectedAttemptPolicy: AttemptSelectionPolicy;
    recurrence: { minimumOccurrences: number; establishesCausality: false; establishesStatisticalSignificance: false };
  };
  sourcePopulation: {
    uniqueRuns: number;
    uniqueAttempts: number;
    selectedAttempts: number;
    duplicateInputsIgnored: number;
  };
  sourceLineage: {
    requestDigest: `sha256:${string}`;
    corpusIndexDigest: `sha256:${string}`;
    manifests: ReadonlyArray<{ runId: string; attemptId: string; digest: `sha256:${string}` }>;
    observationSets: ReadonlyArray<{ runId: string; attemptId: string; digest: `sha256:${string}` }>;
    assertions: ReadonlyArray<{ runId: string; attemptId: string; id: string; digest: `sha256:${string}` }>;
    calibrations: ReadonlyArray<{ selectionDigest: `sha256:${string}`; historyDigest: `sha256:${string}` }>;
    comparisonGates: ReadonlyArray<{ requestDigest: `sha256:${string}`; reportDigest: `sha256:${string}` }>;
  };
  groups: ReadonlyArray<{
    dimensions: Partial<Record<AggregationDimension, string>>;
    metrics: readonly AggregateMetric[];
    behaviors?: readonly BehaviorAggregate[];
    directions?: readonly DirectionAggregate[];
    variations: ReadonlyArray<{
      measure: "terminal-state" | "verifier-status";
      distribution: readonly AggregateMetric[];
      claimStatus: "no-variation" | "case-study" | "recurring-description" | "unavailable";
    }>;
  }>;
  comparisons: ReadonlyArray<{
    id: string;
    measure: string;
    eligibility: readonly ComparisonReport[];
    matchedDifference: AggregateMeasurement;
    differingMatchedUnits: number;
    claimStatus: "no-difference" | "case-study" | "recurring-description" | "unavailable";
    limitations: readonly string[];
  }>;
  limitations: readonly string[];
};

type Attempt = CorpusIndexEntry & { runId: string; attemptId: string };
type ReviewOutcome = { outcome: ReturnType<typeof effectiveReviewOutcome>; disputed: boolean };

/**
 * The behavior assertions an aggregation request names: single assertion files and JSON Lines assertion sets, each
 * bound to its bundle. Paths resolve against `base`. Every assertion is schema-checked here; the aggregation checks it
 * against its retained bundle.
 */
export function readAggregationAssertions(base: string, sources: AggregationRequest["sources"]): Array<{ bundleRoot: string; document: BehaviorAssertion }> {
  const parse = (text: string, label: string): BehaviorAssertion => {
    const value = JSON.parse(text) as unknown;
    const errors = validateArtifact(label, value);
    if (errors.length > 0) throw new Error(`${label} ${errors[0]!.field}: ${errors[0]!.message}`);
    return value as BehaviorAssertion;
  };
  const read = (path: string, label: string) => new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(resolve(base, path), label, undefined, 64 * 1024 * 1024));
  return [
    ...sources.assertions.map(({ bundleRoot, path }) => ({ bundleRoot: resolve(base, bundleRoot), document: parse(read(path, "Behavior assertion"), "Behavior assertion") })),
    ...(sources.assertionSets ?? []).flatMap(({ bundleRoot, path }) => read(path, "Behavior assertion set").split("\n").filter((line) => line.trim() !== "")
      .map((line, index) => ({ bundleRoot: resolve(base, bundleRoot), document: parse(line, `Behavior assertion set ${path} line ${String(index + 1)}`) }))),
  ];
}

export function aggregateEvaluation(
  input: AggregationInput,
  policy: Pick<AggregationRequest, "groupBy" | "selectedAttemptPolicy" | "recurrence" | "evidenceOrigins">,
): Promise<AggregationReport> {
  return aggregateValidatedEvaluation(input, policy);
}

export function selectAggregationAttempts(entries: readonly CorpusIndexEntry[], policy: AttemptSelectionPolicy, origins: EvidenceOriginSelection = "owned"): CorpusIndexEntry[] {
  if (!["owned", "imported", "separate"].includes(origins)) throw new Error("Invalid evidence-origin selection.");
  if (!["all-attempts", "latest-attempt-per-run"].includes(policy)) throw new Error("Invalid attempt selection policy.");
  return selectAttempts(uniqueAttempts(entries, origins).attempts, policy);
}

async function aggregateValidatedEvaluation(
  input: AggregationInput,
  policy: Pick<AggregationRequest, "groupBy" | "selectedAttemptPolicy" | "recurrence" | "evidenceOrigins">,
): Promise<AggregationReport> {
  assertPolicy(policy);
  const { attempts, duplicates } = uniqueAttempts(input.corpusEntries, policy.evidenceOrigins ?? "owned");
  const selected = selectAttempts(attempts, policy.selectedAttemptPolicy);
  const includedOriginIds = new Set(attempts.map(attemptKey));
  const excludedOriginIds = new Set(input.corpusEntries.filter((entry) => ["run", "import"].includes(entry.manifestKind)
    && entry.runId !== undefined && entry.attemptId !== undefined && !includedOriginIds.has(attemptKey(entry as Attempt))).map((entry) => attemptKey(entry as Attempt)));
  // Unknown sources still reach the existing binding check; only indexed, excluded origins are omitted.
  const includedSource = ({ document }: { document: { runId: string; attemptId: string } }) => !excludedOriginIds.has(attemptKey(document));
  const observationSources = uniqueBy(input.observationSets.filter(includedSource), ({ document }) => `${document.runId}\0${document.attemptId}`, "observation set");
  const observations = new Map<string, StructuralObservationSet>();
  const assertionSources = uniqueBy(input.assertions.filter(includedSource), ({ document }) => assertionKey(document), "behavior assertion");
  const assertions = new Map<string, BehaviorAssertion>();
  // Each bundle's observation set and card results are checked together, so its retained evidence is built once.
  const byBundle = new Map<string, { observationSets: StructuralObservationSet[]; assertions: BehaviorAssertion[] }>();
  const rebuiltSets = new Map<string, StructuralObservationSet>();
  const bundleOf = (bundleRoot: string) => {
    const key = resolve(bundleRoot);
    const entry = byBundle.get(key) ?? { observationSets: [], assertions: [] };
    byBundle.set(key, entry);
    return entry;
  };
  for (const { bundleRoot, document } of observationSources.values()) bundleOf(bundleRoot).observationSets.push(document);
  for (const { bundleRoot, document } of assertionSources.values()) bundleOf(bundleRoot).assertions.push(document);
  await withRetainedEvidenceReuse(async () => {
    for (const [bundleRoot, sources] of byBundle) {
      for (const document of sources.observationSets) {
        assertIndexedBundle(bundleRoot, document.runId, document.attemptId, attempts);
        const rebuilt = await createRetainedStructuralObservationSet(bundleRoot);
        if (canonicalizeMetadata(rebuilt) !== canonicalizeMetadata(document)) throw new Error(`Structural observation set for attempt "${document.attemptId}" is stale.`);
        rebuiltSets.set(`${document.runId}\0${document.attemptId}`, rebuilt);
      }
      for (const document of sources.assertions) {
        assertIndexedBundle(bundleRoot, document.runId, document.attemptId, attempts);
        await validateRetainedBehaviorAssertion(bundleRoot, document);
      }
    }
  });
  // Reports keep the order of the request's sources.
  for (const { document } of observationSources.values()) observations.set(`${document.runId}\0${document.attemptId}`, rebuiltSets.get(`${document.runId}\0${document.attemptId}`)!);
  for (const { document } of assertionSources.values()) assertions.set(assertionKey(document), document);
  for (const { selection } of input.calibrations) await revalidateReviewSample(selection);
  const reviewOutcomes = reviewOutcomeIndex(input.calibrations);
  const selectedIds = new Set(selected.map(attemptKey));
  const groupBy = attempts.some((attempt) => evidenceOrigin(attempt) === "imported") && !policy.groupBy.includes("evidence-origin")
    ? [...policy.groupBy, "evidence-origin" as const] : [...policy.groupBy];
  const groups = groupAttempts(attempts, groupBy).map(([dimensions, allMembers]) => {
    const members = allMembers.filter((attempt) => selectedIds.has(attemptKey(attempt)));
    return {
      dimensions,
      metrics: groupMetrics(members, attempts, observations, assertions, reviewOutcomes, dimensions),
      behaviors: behaviorAggregates(members, assertions, reviewOutcomes),
      directions: directionAggregates(members, assertions),
      variations: [
        variation("terminal-state", members, policy.recurrence.minimumOccurrences),
        variation("verifier-status", members, policy.recurrence.minimumOccurrences),
      ],
    };
  });
  const report: AggregationReport = {
    schemaVersion: "ebo.aggregation-report/v2",
    policy: {
      groupBy,
      ...(policy.evidenceOrigins === undefined ? {} : { evidenceOrigins: policy.evidenceOrigins }),
      selectedAttemptPolicy: policy.selectedAttemptPolicy,
      recurrence: {
        minimumOccurrences: policy.recurrence.minimumOccurrences,
        establishesCausality: false,
        establishesStatisticalSignificance: false,
      },
    },
    sourcePopulation: {
      uniqueRuns: new Set(attempts.map(({ runId }) => runId)).size,
      uniqueAttempts: attempts.length,
      selectedAttempts: selected.length,
      duplicateInputsIgnored: duplicates,
    },
    sourceLineage: {
      requestDigest: input.lineage?.requestDigest ?? metadataDigest({ policy, comparisons: input.comparisons.map(({ eligibility: _eligibility, ...comparison }) => comparison) }),
      corpusIndexDigest: input.lineage?.corpusIndexDigest ?? metadataDigest(input.corpusEntries),
      manifests: attempts.map(({ runId, attemptId, manifestDigest: digest }) => ({ runId, attemptId, digest })),
      observationSets: [...observationSources.values()].map(({ document }) => ({ runId: document.runId, attemptId: document.attemptId, digest: metadataDigest(document) })),
      assertions: [...assertionSources.values()].map(({ document }) => ({ runId: document.runId, attemptId: document.attemptId, id: document.id, digest: metadataDigest(document) })),
      calibrations: input.calibrations.map(({ selection, history }) => ({ selectionDigest: metadataDigest(selection), historyDigest: metadataDigest(history) })),
      comparisonGates: input.comparisons.flatMap(({ eligibility }) => eligibility.map(({ request, report }) => ({
        requestDigest: metadataDigest(request),
        reportDigest: metadataDigest(report),
      }))),
    },
    groups,
    comparisons: input.comparisons.map((comparison) => compare(
      comparison,
      selected,
      observations,
      policy.recurrence.minimumOccurrences,
    )),
    limitations: [
      "All aggregates are descriptive; no causal attribution or statistical significance is claimed.",
      "Observational completion is a terminal-state measure, not task success.",
      "Verifier rates include only verified attempts with an available terminal verifier result.",
      "Human-reviewed assertion rates include only digest-bound calibration selections and validated review lineage.",
    ],
  };
  assertArtifact("aggregation report", report);
  return report;
}

function behaviorAggregates(selected: readonly Attempt[], assertions: ReadonlyMap<string, BehaviorAssertion>, reviews: ReadonlyMap<string, ReviewOutcome>): BehaviorAggregate[] {
  const selectedIds = new Set(selected.map(attemptKey));
  const partitions = new Map<string, BehaviorAssertion[]>();
  for (const assertion of assertions.values()) {
    if (!selectedIds.has(attemptKey(assertion))) continue;
    const key = canonicalizeMetadata({ behavior: assertion.behavior, producer: assertion.producer, rubric: isDecisionModelAssertion(assertion) ? null : assertion.rubric });
    const values = partitions.get(key) ?? [];
    values.push(assertion);
    partitions.set(key, values);
  }
  const ontology = loadDefaultBehaviorOntology();
  const order = new Map(ontology.cards.map(({ id }, index) => [id, index]));
  const position = (key: string) => order.get(partitions.get(key)![0]!.behavior.cardId) ?? ontology.cards.length;
  return [...partitions.entries()].sort(([a], [b]) => position(a) - position(b) || a.localeCompare(b)).map(([, values]) => {
    const first = values[0]!;
    const card = resolveBehaviorCard(first.behavior, ontology);
    const included = new Set<string>();
    const decisions: BehaviorDecision[] = [];
    const exclusions: string[] = [];
    const outcome = (assertion: BehaviorAssertion): ReviewOutcome => reviews.get(assertionBindingKey(assertion)) ?? {
      outcome: assertion.judgment.verdict === "unknown" ? "judge-abstained" : "unreviewed", disputed: false,
    };
    for (const attempt of selected) {
      const candidates = values.filter((assertion) => attemptKey(assertion) === attemptKey(attempt));
      const judged = new Map(candidates.map(({ judgment }) => {
        const decision: BehaviorDecision = { verdict: judgment.verdict, ...(judgment.verdict === "present" && judgment.value !== undefined ? { value: judgment.value } : {}) };
        return [canonicalizeMetadata(decision), decision];
      }));
      if (judged.size === 1) {
        decisions.push([...judged.values()][0]!);
        for (const assertion of candidates) included.add(assertionKey(assertion));
      } else exclusions.push(judged.size > 1 ? "conflicting-judge-reruns" : "card-assertion-missing");
    }
    const present = decisions.filter(({ verdict }) => verdict === "present");
    return {
      behavior: structuredClone(first.behavior), family: card.family, producer: structuredClone(first.producer),
      ...(isDecisionModelAssertion(first) ? {} : { rubric: structuredClone(first.rubric) }),
      population: "judged-attempt-card" as const,
      verdicts: BEHAVIOR_VERDICTS.map((verdict) => ({
        verdict,
        measurement: rateMetric(verdict, "attempt", decisions.filter((decision) => decision.verdict === verdict).length,
          decisions.length, "judged-attempt-card", exclusionCounts(exclusions, "attempt-card")).measurement,
      })),
      ...(card.values === undefined ? {} : { values: card.values.map(({ name }) => ({
        value: name,
        measurement: rateMetric(name, "attempt", present.filter(({ value }) => value === name).length,
          present.length, "present-attempt-card", exclusionCounts(decisions.flatMap(({ verdict }) => verdict === "present" ? [] : [`verdict-${verdict}`]), "attempt-card")).measurement,
      })) }),
      assertions: values.map((assertion) => ({ runId: assertion.runId, attemptId: assertion.attemptId, id: assertion.id,
        digest: metadataDigest(assertion), reviewOutcome: outcome(assertion).outcome, disputed: outcome(assertion).disputed,
        included: included.has(assertionKey(assertion)) })),
    };
  });
}

function decisionOf(assertion: BehaviorAssertion): BehaviorDecision {
  const { judgment } = assertion;
  return { verdict: judgment.verdict, ...(judgment.verdict === "present" && judgment.value !== undefined ? { value: judgment.value } : {}) };
}

function directionAggregates(selected: readonly Attempt[], assertions: ReadonlyMap<string, BehaviorAssertion>): DirectionAggregate[] {
  const selectedIds = new Set(selected.map(attemptKey));
  const ontology = loadDefaultBehaviorOntology();
  type Judged = { attempt: string; card: BehaviorCard; decisions: Map<string, BehaviorDecision> };
  type Partition = Pick<DirectionAggregate, "producer" | "rubric">;
  const producers = new Map<string, { partition: Partition; judged: Map<string, Judged> }>();
  for (const assertion of assertions.values()) {
    if (!selectedIds.has(attemptKey(assertion))) continue;
    // The partition identity of the per-card entries, so both views count the same populations.
    const partition: Partition = isDecisionModelAssertion(assertion)
      ? { producer: structuredClone(assertion.producer) }
      : { producer: structuredClone(assertion.producer), rubric: structuredClone(assertion.rubric) };
    const id = canonicalizeMetadata(partition);
    const entry = producers.get(id) ?? { partition, judged: new Map<string, Judged>() };
    producers.set(id, entry);
    const key = `${attemptKey(assertion)}\0${assertion.behavior.cardId}`;
    const judged = entry.judged.get(key) ?? { attempt: attemptKey(assertion), card: resolveBehaviorCard(assertion.behavior, ontology), decisions: new Map<string, BehaviorDecision>() };
    entry.judged.set(key, judged);
    const decision = decisionOf(assertion);
    judged.decisions.set(canonicalizeMetadata(decision), decision);
  }
  return [...producers.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, { partition, judged }]) => {
    const families = ["all", ...ontology.families.map(({ id }) => id).filter((id) => [...judged.values()].some(({ card }) => card.family === id))];
    return families.map((family) => {
      const items = [...judged.values()].filter(({ card }) => family === "all" || card.family === family);
      // Judge runs of one attempt and card that disagree are left out, as in the per-card rates.
      const agreed = items.filter(({ decisions }) => decisions.size === 1).map(({ attempt, card, decisions }) => ({ attempt, direction: behaviorDirection(card, [...decisions.values()][0]!) }));
      const exclusions = exclusionCounts(items.filter(({ decisions }) => decisions.size > 1).map(() => "conflicting-judge-reruns"), "attempt-card");
      const present = agreed.filter(({ direction }) => direction !== undefined);
      const attempts = new Set(agreed.map(({ attempt }) => attempt));
      return {
        ...structuredClone(partition), family,
        results: BEHAVIOR_DIRECTIONS.map((direction) => ({ direction,
          measurement: rateMetric(direction, "attempt", present.filter((item) => item.direction === direction).length, present.length, "present-attempt-card", exclusions).measurement })),
        attempts: BEHAVIOR_DIRECTIONS.map((direction) => ({ direction,
          measurement: rateMetric(direction, "attempt", new Set(present.filter((item) => item.direction === direction).map(({ attempt }) => attempt)).size, attempts.size, "judged-attempt", exclusions).measurement })),
      };
    });
  });
}

function groupMetrics(
  selected: readonly Attempt[],
  all: readonly Attempt[],
  observations: ReadonlyMap<string, StructuralObservationSet>,
  assertions: ReadonlyMap<string, BehaviorAssertion>,
  reviews: ReadonlyMap<string, ReviewOutcome>,
  dimensions: Partial<Record<AggregationDimension, string>>,
): AggregateMetric[] {
  const selectedIds = new Set(selected.map(attemptKey));
  const relatedAll = all.filter((attempt) => matches(attempt, dimensions));
  const selectionExclusions = exclusionCounts(relatedAll.filter((attempt) => !selectedIds.has(attemptKey(attempt))).map(() => "not-selected-by-attempt-policy"), "attempt");
  const infrastructureEligible = selected.filter((attempt) => evidenceOrigin(attempt) === "owned" || attempt.failureClass !== undefined);
  const terminalEligible = selected.filter((attempt) => evidenceOrigin(attempt) === "owned" || attempt.terminalState !== undefined);
  const metrics: AggregateMetric[] = [
    metric("attempt-count", "attempt", selected.length, relatedAll.length, "attempt", "attempt", selectionExclusions),
    rateMetric("infrastructure-failure-rate", "attempt", infrastructureEligible.filter(({ failureClass }) => failureClass === "infrastructure").length, infrastructureEligible.length, "attempt", exclusionCounts(selected.filter((attempt) => evidenceOrigin(attempt) === "imported" && attempt.failureClass === undefined).map(() => "imported-failure-class-unavailable"), "attempt")),
    rateMetric("capture-qualified-rate", "attempt",
      selected.filter(({ captureQualification }) => captureQualification === "qualified" || captureQualification === "qualified-with-gaps").length,
      selected.filter(({ captureQualification }) => captureQualification !== undefined && captureQualification !== "unavailable").length,
      "attempt", exclusionCounts(selected.flatMap(({ captureQualification }) => captureQualification === undefined || captureQualification === "unavailable" ? ["capture-qualification-unavailable"] : []), "attempt")),
    rateMetric("terminal-completed-rate", "attempt", terminalEligible.filter(({ terminalState }) => terminalState === "completed").length, terminalEligible.length, "attempt", exclusionCounts(selected.filter((attempt) => evidenceOrigin(attempt) === "imported" && attempt.terminalState === undefined).map(() => "imported-terminal-state-unavailable"), "attempt")),
  ];
  const verified = selected.filter(({ assessmentMode, verifierStatuses }) => assessmentMode === "verified"
    && verifierStatuses.length === 1 && ["passed", "failed"].includes(verifierStatuses[0]!));
  metrics.push(rateMetric(
    "verifier-pass-rate",
    "attempt",
    verified.filter(({ verifierStatuses }) => verifierStatuses[0] === "passed").length,
    verified.length,
    "verified-attempt",
    exclusionCounts(selected.flatMap((attempt) => attempt.assessmentMode !== "verified"
      ? ["observational-or-unknown-assessment-mode"]
      : attempt.verifierStatuses.length !== 1 || !["passed", "failed"].includes(attempt.verifierStatuses[0]!)
        ? ["verifier-outcome-unavailable-or-infrastructure"] : []), "attempt"),
  ));
  const selectedObservationSets = selected.flatMap((attempt) => observations.get(attemptKey(attempt)) ?? []);
  metrics.push(rateMetric("structural-observation-set-availability-rate", "attempt", selectedObservationSets.length,
    selected.length, "attempt", exclusionCounts(selected.flatMap((attempt) => observations.has(attemptKey(attempt)) ? [] : ["observation-set-missing"]), "attempt")));
  const extractorIds = [...new Set(selectedObservationSets.flatMap(({ observations: values }) => values.map(({ extractor }) => extractor.id)))].sort();
  for (const extractorId of extractorIds) {
    const values = selected.map((attempt) => observations.get(attemptKey(attempt))?.observations.find(({ extractor }) => extractor.id === extractorId)?.value);
    const known = values.flatMap((value) => value?.status === "known" ? [value] : []);
    const units = new Set(known.map(({ unit }) => unit));
    const types = new Set(known.map(({ value }) => typeof value));
    const exclusions = exclusionCounts(values.flatMap((value) => value?.status === "unavailable" ? [value.reason] : value === undefined ? ["observation-set-missing"] : []), "attempt");
    if (units.size > 1 || types.size > 1) {
      metrics.push(unavailableMetric(`structural:${extractorId}`, "attempt", "Structural observation types or units differ within the group.", selected.length, "attempt"));
    } else if (types.has("number")) {
      metrics.push(metric(`structural:${extractorId}`, "attempt", known.reduce((sum, { value }) => sum + Number(value), 0), known.length,
        known[0]?.unit ?? "observation-value", "attempt-with-known-observation", exclusions));
    } else if (types.has("boolean")) {
      metrics.push(metric(`structural:${extractorId}`, "attempt", known.filter(({ value }) => value === true).length, known.length,
        "attempt-with-true-observation", "attempt-with-known-observation", exclusions));
    } else {
      for (const value of [...new Set(known.map(({ value }) => String(value)))].sort()) {
        metrics.push(metric(`structural:${extractorId}:${value}`, "attempt", known.filter((knownValue) => knownValue.value === value).length,
          known.length, "attempt", "attempt-with-known-observation", exclusions));
      }
      if (known.length === 0) metrics.push(unavailableMetric(`structural:${extractorId}`, "attempt", emptyStructuralReason(values), 0, "attempt", exclusions));
    }
  }
  const selectedAssertions = [...assertions.values()].filter(({ runId, attemptId }) => selectedIds.has(`${runId}\0${attemptId}`));
  const modes = [...new Set(selectedAssertions.map(({ producer }) => producer.mode))].sort();
  if (modes.length > 1) {
    // Results of an LLM judge and of a decision model are never pooled: the group-wide rates are unavailable, and each
    // mode gets its own.
    for (const id of ASSERTION_METRICS) {
      metrics.push(unavailableMetric(id, id === "reviewed-assertion-confirmed-rate" ? "reviewed-assertion" : "assertion",
        "The group holds results of more than one producer mode; read the per-mode metrics.", selectedAssertions.length, "assertion"));
    }
    for (const mode of modes) metrics.push(...assertionMetrics(selectedAssertions.filter(({ producer }) => producer.mode === mode), reviews, `:${mode}`));
  } else metrics.push(...assertionMetrics(selectedAssertions, reviews, ""));
  return metrics;
}

const ASSERTION_METRICS = ["assertion-abstention-rate", "reviewed-assertion-confirmed-rate", "review-unresolved-rate", "review-disputed-rate"] as const;

function assertionMetrics(selectedAssertions: readonly BehaviorAssertion[], reviews: ReadonlyMap<string, ReviewOutcome>, suffix: string): AggregateMetric[] {
  const metrics: AggregateMetric[] = [];
  metrics.push(rateMetric(`assertion-abstention-rate${suffix}`, "assertion", selectedAssertions.filter(({ judgment }) => judgment.verdict === "unknown").length,
    selectedAssertions.length, "assertion", []));
  const reviewResults = selectedAssertions.map((assertion) => reviews.get(assertionBindingKey(assertion)) ?? {
    outcome: assertion.judgment.verdict === "unknown" ? "judge-abstained" as const : "unreviewed" as const,
    disputed: false,
  });
  const outcomes = reviewResults.map(({ outcome }) => outcome);
  const reviewed = outcomes.filter((outcome) => outcome === "confirmed" || outcome === "rejected" || outcome === "unresolved");
  metrics.push(rateMetric(`reviewed-assertion-confirmed-rate${suffix}`, "reviewed-assertion", reviewed.filter((outcome) => outcome === "confirmed").length,
    reviewed.length, "reviewed-assertion", exclusionCounts(outcomes.flatMap((outcome) => outcome === "unreviewed" || outcome === "judge-abstained" ? [outcome] : []), "assertion")));
  metrics.push(rateMetric(`review-unresolved-rate${suffix}`, "assertion", outcomes.filter((outcome) => outcome === "unresolved" || outcome === "unreviewed" || outcome === "judge-abstained").length,
    outcomes.length, "assertion", []));
  metrics.push(rateMetric(`review-disputed-rate${suffix}`, "assertion", reviewResults.filter(({ disputed }) => disputed).length,
    reviewResults.length, "assertion", []));
  return metrics;
}

function variation(
  measure: "terminal-state" | "verifier-status",
  attempts: readonly Attempt[],
  recurrenceMinimum: number,
): AggregationReport["groups"][number]["variations"][number] {
  const values = attempts.flatMap((attempt) => measure === "terminal-state"
    ? attempt.terminalState === undefined ? [] : [attempt.terminalState]
    : attempt.assessmentMode === "verified" && attempt.verifierStatuses.length === 1 ? [attempt.verifierStatuses[0]!] : []);
  const excluded = attempts.length - values.length;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const distribution = [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([value, count]) =>
    rateMetric(`${measure}:${value}`, "attempt", count, values.length, "attempt", excluded === 0 ? [] : [{ reason: `${measure}-unavailable`, count: excluded, unit: "attempt" }]));
  const secondMostFrequent = [...counts.values()].sort((left, right) => right - left)[1] ?? 0;
  return {
    measure,
    distribution,
    claimStatus: values.length === 0 ? "unavailable" : secondMostFrequent === 0 ? "no-variation"
      : secondMostFrequent >= recurrenceMinimum ? "recurring-description" : "case-study",
  };
}

function compare(
  comparison: AggregationInput["comparisons"][number],
  attempts: readonly Attempt[],
  observations: ReadonlyMap<string, StructuralObservationSet>,
  recurrenceMinimum: number,
): AggregationReport["comparisons"][number] {
  const gates = new Map<string, { request: ComparisonRequest; report: ComparisonReport }>();
  for (const { request, report } of comparison.eligibility) {
    const rebuilt = assessComparisonEligibility(request);
    if (canonicalizeMetadata(rebuilt) !== canonicalizeMetadata(report)) {
      throw new Error(`Comparison "${comparison.id}" has a stale eligibility report.`);
    }
    assertArtifact("comparison report", report);
    const key = candidatePairKey(request.left, request.right);
    const current = gates.get(key);
    if (current !== undefined && canonicalizeMetadata(current) !== canonicalizeMetadata({ request, report })) {
      throw new Error(`Comparison "${comparison.id}" has conflicting eligibility reports for one candidate pair.`);
    }
    gates.set(key, { request, report });
  }
  const left = attempts.filter((attempt) => matches(attempt, comparison.left));
  const right = attempts.filter((attempt) => matches(attempt, comparison.right));
  const exclusions: string[] = [
    ...left.filter((attempt) => hasMissingDimension(attempt, comparison.matchBy)).map(() => "match-dimension-unavailable"),
    ...right.filter((attempt) => hasMissingDimension(attempt, comparison.matchBy)).map(() => "match-dimension-unavailable"),
  ];
  const leftByMatch = indexedMatches(left.filter((attempt) => !hasMissingDimension(attempt, comparison.matchBy)), comparison.matchBy);
  const rightByMatch = indexedMatches(right.filter((attempt) => !hasMissingDimension(attempt, comparison.matchBy)), comparison.matchBy);
  const keys = [...new Set([...leftByMatch.keys(), ...rightByMatch.keys()])].sort();
  const differences: number[] = [];
  let differenceUnit: string | undefined;
  for (const key of keys) {
    const leftMatches = leftByMatch.get(key) ?? [];
    const rightMatches = rightByMatch.get(key) ?? [];
    if (leftMatches.length !== 1 || rightMatches.length !== 1) {
      exclusions.push(leftMatches.length === 0 || rightMatches.length === 0 ? "unmatched-unit" : "ambiguous-matched-unit");
      continue;
    }
    const gate = gates.get(candidatePairKey(
      { id: leftMatches[0]!.runId, manifestDigest: leftMatches[0]!.manifestDigest },
      { id: rightMatches[0]!.runId, manifestDigest: rightMatches[0]!.manifestDigest },
    ));
    if (gate === undefined) {
      exclusions.push("comparison-eligibility-missing");
      continue;
    }
    if (gate.report.status === "unsupported") {
      exclusions.push("comparison-eligibility-unsupported");
      continue;
    }
    if (gate.report.measure !== comparison.measure) {
      exclusions.push("comparison-measure-not-gated");
      continue;
    }
    if (measureCapabilities(comparison.measure, [leftMatches[0]!, rightMatches[0]!], observations)
      .some((capability) => !gate.report.policy.requiredCapabilities.includes(capability))) {
      exclusions.push("comparison-measure-capability-not-gated");
      continue;
    }
    const leftCandidate = gate.request.left.id === leftMatches[0]!.runId ? gate.request.left : gate.request.right;
    const rightCandidate = gate.request.left.id === rightMatches[0]!.runId ? gate.request.left : gate.request.right;
    if (!candidateMatchesAttempt(leftCandidate, leftMatches[0]!, observations)
        || !candidateMatchesAttempt(rightCandidate, rightMatches[0]!, observations)) {
      exclusions.push("comparison-candidate-evidence-mismatch");
      continue;
    }
    const leftValue = measureValue(leftMatches[0]!, comparison.measure, observations);
    const rightValue = measureValue(rightMatches[0]!, comparison.measure, observations);
    if (leftValue === undefined || rightValue === undefined) exclusions.push("measure-unavailable");
    else if (leftValue.unit !== rightValue.unit || differenceUnit !== undefined && differenceUnit !== leftValue.unit) exclusions.push("measure-unit-mismatch");
    else {
      differenceUnit = leftValue.unit;
      differences.push(rightValue.value - leftValue.value);
    }
  }
  const differing = differences.filter((value) => value !== 0).length;
  const measurement = differences.length === 0
    ? unavailableMeasurement("No uniquely matched units have the requested measure on both sides.", 0, "matched-unit", exclusionCounts(exclusions, "matched-unit"))
    : availableMeasurement(differences.reduce((sum, value) => sum + value, 0), differences.length,
      `right-minus-left-${differenceUnit!}`, "matched-unit", exclusionCounts(exclusions, "matched-unit"));
  return {
    id: comparison.id,
    measure: comparison.measure,
    eligibility: comparison.eligibility.map(({ report }) => structuredClone(report)),
    matchedDifference: measurement,
    differingMatchedUnits: differing,
    claimStatus: differences.length === 0 ? "unavailable" : differing === 0 ? "no-difference"
      : differing >= recurrenceMinimum ? "recurring-description" : "case-study",
    limitations: [
      ...new Set(comparison.eligibility.flatMap(({ report }) => report.reasons.map(({ detail }) => detail))),
      "Matched differences are descriptive and do not establish causality or statistical significance.",
    ],
  };
}

function candidateMatchesAttempt(
  candidate: ComparisonRequest["left"],
  attempt: Attempt,
  observations: ReadonlyMap<string, StructuralObservationSet>,
): boolean {
  const exact = (candidate.evidenceOrigin?.kind ?? (candidate.harness.id.startsWith("atif.") ? "imported" : "owned")) === evidenceOrigin(attempt)
    && candidate.id === attempt.runId
    && candidate.manifestDigest === attempt.manifestDigest
    && candidate.task.id === attempt.taskId
    && candidate.task.digest === attempt.taskDigest
    && candidate.fixture.id === attempt.fixtureId
    && candidate.fixture.digest === attempt.fixtureDigest
    && candidate.model.id === attempt.modelId
    && candidate.model.configurationDigest === attempt.modelConfigurationDigest
    && candidate.harness.id === attempt.harnessId
    && candidate.harness.version === attempt.harnessVersion
    && candidate.harness.configurationDigest === attempt.harnessConfigurationDigest
    && candidate.assessmentMode === attempt.assessmentMode
    && candidate.captureProfileDigest === attempt.captureProfileDigest
    && candidate.budgetDigest === attempt.budgetDigest
    && candidate.toolPolicyDigest === attempt.toolPolicyDigest;
  if (!exact) return false;
  const observationSet = observations.get(attemptKey(attempt));
  if (observationSet?.normalization.capabilityProfile === undefined) return false;
  return candidate.adapterVersion === observationSet.normalization.adapter.version
    && canonicalizeMetadata(candidate.capabilityProfile) === canonicalizeMetadata(observationSet.normalization.capabilityProfile);
}

function measureCapabilities(
  measure: string,
  attempts: readonly Attempt[],
  observations: ReadonlyMap<string, StructuralObservationSet>,
): readonly ComparisonCapability[] {
  if (measure === "attempt:infrastructure-failure" || measure === "attempt:terminal-completed" || measure === "verified:verifier-passed") {
    return ["family:outcome"];
  }
  if (measure.startsWith("structural:")) {
    const extractorId = measure.slice("structural:".length);
    return [...new Set(attempts.flatMap((attempt) => observations.get(attemptKey(attempt))?.observations
      .find(({ extractor }) => extractor.id === extractorId)?.extractor.requiredCapabilities ?? []))];
  }
  throw new Error(`Unsupported aggregate comparison measure "${measure}".`);
}

function candidatePairKey(
  left: Pick<ComparisonRequest["left"], "id" | "manifestDigest">,
  right: Pick<ComparisonRequest["right"], "id" | "manifestDigest">,
): string {
  return canonicalizeMetadata([[left.id, left.manifestDigest], [right.id, right.manifestDigest]]
    .sort((leftValue, rightValue) => canonicalizeMetadata(leftValue).localeCompare(canonicalizeMetadata(rightValue))));
}

function measureValue(attempt: Attempt, measure: string, observations: ReadonlyMap<string, StructuralObservationSet>): { value: number; unit: string } | undefined {
  if (measure === "attempt:infrastructure-failure" && evidenceOrigin(attempt) === "imported" && attempt.failureClass === undefined) return undefined;
  if (measure === "attempt:infrastructure-failure") return { value: attempt.failureClass === "infrastructure" ? 1 : 0, unit: "attempt" };
  if (measure === "attempt:terminal-completed") return attempt.terminalState === undefined ? undefined : { value: attempt.terminalState === "completed" ? 1 : 0, unit: "attempt" };
  if (measure === "verified:verifier-passed") return attempt.assessmentMode !== "verified" || attempt.verifierStatuses.length !== 1
    || !["passed", "failed"].includes(attempt.verifierStatuses[0]!)
    ? undefined : { value: attempt.verifierStatuses[0] === "passed" ? 1 : 0, unit: "verified-attempt" };
  if (measure.startsWith("structural:")) {
    const value = observations.get(attemptKey(attempt))?.observations.find(({ extractor }) => extractor.id === measure.slice("structural:".length))?.value;
    return value?.status === "known" && (typeof value.value === "number" || typeof value.value === "boolean")
      ? { value: typeof value.value === "boolean" ? Number(value.value) : value.value, unit: value.unit }
      : undefined;
  }
  throw new Error(`Unsupported aggregate comparison measure "${measure}".`);
}

function reviewOutcomeIndex(calibrations: AggregationInput["calibrations"]): Map<string, ReviewOutcome> {
  const outcomes = new Map<string, ReviewOutcome>();
  for (const { selection, history } of calibrations) {
    validateReviewHistory(selection, history);
    for (const candidate of selection.candidates) {
      const key = bindingKey(candidate.assertion.id, candidate.assertion.digest);
      const outcome = {
        outcome: effectiveReviewOutcome(candidate, history.decisions),
        disputed: isDisputedReviewOutcome(candidate, history.decisions),
      };
      const current = outcomes.get(key);
      if (current !== undefined && canonicalizeMetadata(current) !== canonicalizeMetadata(outcome)) throw new Error(`Calibration inputs conflict for assertion "${candidate.assertion.id}".`);
      outcomes.set(key, outcome);
    }
  }
  return outcomes;
}

function uniqueAttempts(entries: readonly CorpusIndexEntry[], origins: EvidenceOriginSelection = "owned"): { attempts: Attempt[]; duplicates: number } {
  const attempts = new Map<string, Attempt>();
  let duplicates = 0;
  for (const entry of entries) {
    if (!["run", "import"].includes(entry.manifestKind) || entry.runId === undefined || entry.attemptId === undefined) continue;
    if (origins !== "separate" && evidenceOrigin(entry) !== origins) continue;
    const key = attemptKey(entry as Attempt);
    const current = attempts.get(key);
    if (current === undefined) attempts.set(key, structuredClone(entry) as Attempt);
    else if (canonicalizeMetadata(current) === canonicalizeMetadata(entry)) duplicates += 1;
    else throw new Error(`Corpus inputs conflict for run "${entry.runId}" attempt "${entry.attemptId}".`);
  }
  return { attempts: [...attempts.values()].sort((left, right) => attemptKey(left).localeCompare(attemptKey(right))), duplicates };
}

function assertIndexedBundle(bundleRoot: string, runId: string, attemptId: string, attempts: readonly Attempt[]): void {
  const indexed = attempts.filter((attempt) => attempt.runId === runId && attempt.attemptId === attemptId);
  if (indexed.length !== 1) throw new Error(`Derived source run "${runId}" attempt "${attemptId}" has no unique corpus entry.`);
  const actual = `sha256:${digestBytes(readBoundedFile(join(resolve(bundleRoot), "manifest.json"), "Derived source manifest")).value}`;
  if (actual !== indexed[0]!.manifestDigest) {
    throw new Error(`Derived source run "${runId}" attempt "${attemptId}" does not match the indexed manifest digest.`);
  }
}

function selectAttempts(attempts: readonly Attempt[], policy: AttemptSelectionPolicy): Attempt[] {
  if (policy === "all-attempts") return [...attempts];
  const latest = new Map<string, Attempt>();
  for (const attempt of attempts) {
    const current = latest.get(attempt.runId);
    if (current === undefined || (attempt.attemptNumber ?? -1) > (current.attemptNumber ?? -1)) latest.set(attempt.runId, attempt);
    else if ((attempt.attemptNumber ?? -1) === (current.attemptNumber ?? -1) && attempt.attemptId !== current.attemptId) {
      throw new Error(`Run "${attempt.runId}" has ambiguous latest attempts.`);
    }
  }
  return [...latest.values()].sort((left, right) => attemptKey(left).localeCompare(attemptKey(right)));
}

function groupAttempts(attempts: readonly Attempt[], dimensions: readonly AggregationDimension[]): Array<[Partial<Record<AggregationDimension, string>>, Attempt[]]> {
  const groups = new Map<string, [Partial<Record<AggregationDimension, string>>, Attempt[]]>();
  for (const attempt of attempts) {
    const values = Object.fromEntries(dimensions.map((dimension) => [dimension, dimensionValue(attempt, dimension) ?? "unavailable"])) as Partial<Record<AggregationDimension, string>>;
    const key = canonicalizeMetadata(values);
    const group = groups.get(key) ?? [values, []];
    group[1].push(attempt);
    groups.set(key, group);
  }
  return [...groups.values()].sort(([left], [right]) => canonicalizeMetadata(left).localeCompare(canonicalizeMetadata(right)));
}

function dimensionValue(attempt: Attempt, dimension: AggregationDimension): string | undefined {
  return ({
    task: attempt.taskId,
    model: attempt.modelId,
    harness: attempt.harnessId,
    trial: attempt.trialId,
    "capture-qualification": attempt.captureQualification,
    "evidence-origin": evidenceOrigin(attempt),
  })[dimension];
}

function matches(attempt: Attempt, filters: Partial<Record<AggregationDimension, string>>): boolean {
  return Object.entries(filters).every(([dimension, value]) => (dimensionValue(attempt, dimension as AggregationDimension) ?? "unavailable") === value);
}

function indexedMatches(attempts: readonly Attempt[], dimensions: readonly AggregationDimension[]): Map<string, Attempt[]> {
  const result = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const key = canonicalizeMetadata(dimensions.map((dimension) => dimensionValue(attempt, dimension) ?? null));
    const values = result.get(key) ?? [];
    values.push(attempt);
    result.set(key, values);
  }
  return result;
}

function hasMissingDimension(attempt: Attempt, dimensions: readonly AggregationDimension[]): boolean {
  return dimensions.some((dimension) => dimensionValue(attempt, dimension) === undefined);
}

/**
 * Why no attempt has a known value. Imported documents do not prove that an attempt was captured whole, so their
 * attempt-level structural observations are unavailable by design; a count over a partial capture would read as the
 * attempt's own count. Their recorded-document measures stay in each import's mapping.
 */
export function emptyStructuralReason(values: ReadonlyArray<{ status: string; reason?: string } | undefined>): string {
  const reasons = new Set(values.map((value) => value === undefined ? "observation-set-missing" : value.status === "unavailable" ? value.reason ?? "unavailable" : value.status));
  if (reasons.size !== 1) return "The eligible denominator is empty.";
  const [reason] = [...reasons];
  if (reason === "CAPTURE_COMPLETENESS_UNPROVEN") {
    return "Imported evidence: the source does not prove the attempt was captured whole, so attempt-level structural counts are unavailable (CAPTURE_COMPLETENESS_UNPROVEN). Recorded-document measures are in each import's mapping.";
  }
  return reason === "observation-set-missing" ? "No attempt in the group has an observation set." : `Every attempt's observation is unavailable: ${reason}`;
}

function metric(id: string, population: AggregateMetric["population"], numerator: number, denominator: number,
  numeratorUnit: string, denominatorUnit: string, exclusions: AggregateMeasurement["exclusions"]): AggregateMetric {
  const measurement = denominator === 0
    ? unavailableMeasurement("The eligible denominator is empty.", numerator, denominatorUnit, exclusions, numeratorUnit)
    : availableMeasurement(numerator, denominator, numeratorUnit, denominatorUnit, exclusions);
  return { id, population, claimStatus: measurement.status === "available" ? "descriptive" : "unavailable", measurement };
}

function rateMetric(id: string, population: AggregateMetric["population"], numerator: number, denominator: number,
  unit: string, exclusions: AggregateMeasurement["exclusions"]): AggregateMetric {
  return metric(id, population, numerator, denominator, unit, unit, exclusions);
}

function unavailableMetric(id: string, population: AggregateMetric["population"], reason: string, denominator: number, unit: string,
  exclusions: AggregateMeasurement["exclusions"] = []): AggregateMetric {
  return { id, population, claimStatus: "unavailable", measurement: unavailableMeasurement(reason, 0, unit, exclusions, unit, denominator) };
}

function availableMeasurement(numerator: number, denominator: number, numeratorUnit: string, denominatorUnit: string,
  exclusions: AggregateMeasurement["exclusions"]): AggregateMeasurement {
  return { status: "available", numerator: { value: numerator, unit: numeratorUnit }, denominator: { value: denominator, unit: denominatorUnit }, rate: numerator / denominator, exclusions };
}

function unavailableMeasurement(reason: string, numerator: number, denominatorUnit: string,
  exclusions: AggregateMeasurement["exclusions"], numeratorUnit = denominatorUnit, denominator = 0): AggregateMeasurement {
  return { status: "unavailable", numerator: { value: numerator, unit: numeratorUnit }, denominator: { value: denominator, unit: denominatorUnit }, exclusions, reason };
}

function exclusionCounts(reasons: readonly string[], unit: string): AggregateMeasurement["exclusions"] {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([reason, count]) => ({ reason, count, unit }));
}

function uniqueBy<Value>(values: readonly Value[], key: (value: Value) => string, label: string): Map<string, Value> {
  const result = new Map<string, Value>();
  for (const value of values) {
    const identity = key(value);
    const current = result.get(identity);
    if (current === undefined) result.set(identity, structuredClone(value));
    else if (canonicalizeMetadata(current) !== canonicalizeMetadata(value)) throw new Error(`Duplicate ${label} identity has conflicting content.`);
  }
  return result;
}

function assertPolicy(policy: Pick<AggregationRequest, "groupBy" | "selectedAttemptPolicy" | "recurrence" | "evidenceOrigins">): void {
  if (policy.evidenceOrigins !== undefined && !["owned", "imported", "separate"].includes(policy.evidenceOrigins)) throw new Error("Invalid evidence-origin selection.");
  if (new Set(policy.groupBy).size !== policy.groupBy.length) throw new Error("Aggregate grouping dimensions must be unique.");
  if (!Number.isSafeInteger(policy.recurrence.minimumOccurrences) || policy.recurrence.minimumOccurrences < 2) {
    throw new Error("Aggregate recurrence minimum must be an integer of at least two.");
  }
}

function assertArtifact(label: string, value: unknown): void {
  const errors = validateArtifact(label, value);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${label} ${field}: ${message}`).join("\n"));
}

function attemptKey(attempt: Pick<Attempt, "runId" | "attemptId">): string {
  return `${attempt.runId}\0${attempt.attemptId}`;
}

function assertionKey(assertion: BehaviorAssertion): string {
  return `${assertion.runId}\0${assertion.attemptId}\0${assertion.id}`;
}

function assertionBindingKey(assertion: BehaviorAssertion): string {
  return bindingKey(assertion.id, `sha256:${digestMetadata(assertion).value}`);
}

function bindingKey(id: string, digest: string): string {
  return `${id}\0${digest}`;
}

function metadataDigest(value: unknown): `sha256:${string}` {
  return `sha256:${digestMetadata(value).value}`;
}

/** Native v1 entries omit origin; import manifests remain a distinct measurement instrument. */
export function evidenceOrigin(entry: Pick<CorpusIndexEntry, "manifestKind" | "captureQualification" | "evidenceOrigin">): "owned" | "imported" {
  return entry.manifestKind === "import" || entry.captureQualification === "imported" || entry.evidenceOrigin === "imported" ? "imported" : "owned";
}
