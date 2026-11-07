import { analysisDigestV2, referenceKeyV2, type ObservationSetV2 } from "./analysis-v2.js";
import { createMigrationTargetV2, type MigrationTarget, type MigrationUnit } from "./migration-accounting.js";
import type { RetainedBehaviorEvidenceV2 } from "./native-v2.js";
import type { OccurrenceLedgerV2 } from "./occurrences-v2.js";
import type { SemanticJudgeInput, SemanticJudgmentRecord } from "./semantic-judge.js";
import { prepareSemanticJudgeInputV2 } from "./semantic-judge-v2.js";

/** Explicit translation of a verified old input; selections bind retained references instead of native aliases. */
export async function prepareMigrationTargetV2(options: {
  unit: MigrationUnit; originalInput: SemanticJudgeInput; legacyEvaluator: SemanticJudgmentRecord["evaluator"];
  evidence: RetainedBehaviorEvidenceV2; observations: ObservationSetV2; ledger: OccurrenceLedgerV2;
  limits: { maxRecordChars: number; maxInputChars: number };
}): Promise<MigrationTarget> {
  const { unit, originalInput, legacyEvaluator, evidence } = options;
  if (analysisDigestV2(originalInput) !== unit.inputDigest || analysisDigestV2(legacyEvaluator) !== unit.evaluatorDigest) throw new Error("Migration preparation differs from the verified original input or evaluator.");
  const byId = new Map(evidence.dataset.events.map((event) => [event.id, event])), byReference = new Map<string, typeof evidence.dataset.events>();
  for (const event of evidence.dataset.events) {
    const key = referenceKeyV2(event.source.nativeReference); byReference.set(key, [...byReference.get(key) ?? [], event]);
  }
  const selected = new Set<string>();
  for (const item of originalInput.evidence) {
    if (item.kind !== "event") continue;
    const citation = item.citation;
    if (!citation) throw new Error("Original event evidence lacks a source citation.");
    const old = byId.get(citation.eventId), key = referenceKeyV2(citation.nativeReference);
    const candidates = byReference.get(key) ?? [];
    const chosen = old && referenceKeyV2(old.source.nativeReference) === key ? old : candidates.find((event) => event.id === item.id) ?? candidates[0];
    if (!chosen) throw new Error("Original selected source reference has no v2 projection.");
    selected.add(chosen.id);
  }
  const input = await prepareSemanticJudgeInputV2(evidence, options.observations, options.ledger, {
    schemaVersion: "ebo.semantic-judge-request/v2", behavior: structuredClone(originalInput.behavior), rubric: structuredClone(originalInput.rubric),
    evaluator: { id: `${legacyEvaluator.provider}/${legacyEvaluator.model}`, version: legacyEvaluator.backend.version,
      configuration: { retainedLegacyEvaluator: structuredClone(legacyEvaluator), originalConfigurationDigest: unit.configurationDigest,
        translation: "ebo.v1-to-typed-v2/2.0.0", ratings: "regenerate-before-use" } },
    eventIds: [...selected].sort(), limits: options.limits,
  });
  return createMigrationTargetV2(unit, input, evidence);
}
