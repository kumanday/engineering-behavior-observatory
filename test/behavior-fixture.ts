import {
  behaviorOntologyDigest,
  decideFromProbabilities,
  loadDefaultBehaviorOntology,
  resolveBehaviorCard,
  type BehaviorProducer,
  type DecisionModelAssertion,
  type DecisionModelEvidence,
  type DecisionModelProbabilities,
  type DecisionThresholds,
  type JudgedBehavior,
  type LlmJudgeEvidence,
} from "../src/index.js";

/** Digest of the shipped ontology: every fixture result is judged against these card texts. */
export const ONTOLOGY_DIGEST = behaviorOntologyDigest(loadDefaultBehaviorOntology());

export function judged(cardId: string): JudgedBehavior {
  return { ontologyVersion: "2.0.0", cardId, ontologyDigest: ONTOLOGY_DIGEST };
}

export function llmProducer(model = "fixture-judge", version = "1.0.0"): BehaviorProducer<"llm-judge"> {
  return { mode: "llm-judge", provider: "fixture", model, version };
}

export function llmEvidence(included = 1, total = included): LlmJudgeEvidence {
  return {
    scope: "selected-events", events: { included, total }, structuralObservations: 0, occurrenceLedgerRows: 0, omitted: 0, truncated: 0,
    limits: { maxEvidenceItems: 40, maxRecordChars: 4000, maxInputChars: 120000, maxCitations: 8 },
  };
}

export const DECISION_THRESHOLDS: DecisionThresholds = { present: 0.9, absent: 0.1 };

export function decisionModelProducer(model = "fixture-decision-model"): BehaviorProducer<"decision-model"> {
  return { mode: "decision-model", provider: "fixture", model, version: "1.0.0" };
}

export function decisionModelEvidence(steps = 1): DecisionModelEvidence {
  return { scope: "all-steps", steps: { included: steps, total: steps }, rendering: { id: "fixture-step-excerpt", version: "1.0.0" }, fieldChars: { min: 30, max: 430 }, budgetChars: 37000 };
}

/** A decision-model result whose verdict and value follow from the given probabilities. */
export function decisionModelAssertion(
  identity: Pick<DecisionModelAssertion, "id" | "runId" | "attemptId" | "dataset">,
  cardId: string,
  probabilities: DecisionModelProbabilities,
  thresholds: DecisionThresholds = DECISION_THRESHOLDS,
): DecisionModelAssertion {
  const behavior = judged(cardId);
  const decision = decideFromProbabilities(resolveBehaviorCard(behavior), probabilities, thresholds);
  return {
    schemaVersion: "ebo.behavior-assertion/v1", ...identity, behavior, producer: decisionModelProducer(), evidence: decisionModelEvidence(),
    judgment: { basis: "probabilities", ...decision, probabilities, thresholds },
  };
}
