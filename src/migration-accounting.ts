import { validateSemanticJudgeInputV2, type JudgeInputV2 } from "./semantic-judge-v2.js";
import type { RetainedBehaviorEvidenceV2 } from "./native-v2.js";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertNoDuplicateJsonKeys, digestMetadata, validateArtifact } from "./artifacts.js";
import { isSafeArtifactRelativePath } from "./contracts.js";
import { listAnalysisRuntimes } from "./analysis-runtime.js";
import type { SemanticJudgeInput, SemanticJudgmentRecord } from "./semantic-judge.js";
import type { BehaviorAssertion } from "./behavior-assertions.js";

type Hash = `sha256:${string}`;
type ReferenceStatus = "verified" | "missing" | "absent" | "invalid";
type ReceiptProfile = "codex-relay-0.162.1-no-wall-limit/v1";
export type MigrationStudy = {
  id: string;
  root: string;
  analysisRuntime: { id: string; manifestDigest: Hash };
  /** Explicit supported-study census. Paths are relative to root; archives require separate admission. */
  artifacts: readonly string[];
  receiptProfiles?: readonly ReceiptProfile[];
};
export type MigrationDependencies = {
  inputDigest: Hash;
  datasetDigest: Hash;
  selectionDigest: Hash;
  selectedEvidenceDigest: Hash;
  rubricDigest: Hash;
  behaviorDigest: Hash;
  rubricIdentityDigest: Hash;
  promptVersion: string;
  ratingsDigest: Hash | null;
  observationSetDigest?: Hash;
  ledgerDigest?: Hash;
  requestDigest?: Hash;
};
export type MigrationAssertion = { digest: Hash; runId: string; attemptId: string; datasetDigest: Hash;
  behaviorDigest: Hash; rubricIdentityDigest: Hash; configurationDigest: Hash | null; paths: string[] };
export type MigrationUnit = {
  id: Hash;
  runId: string;
  attemptId: string;
  inputDigest: Hash;
  evaluatorDigest: Hash;
  configurationDigest: Hash | null;
  judgmentDigests: Hash[];
  assertionDigests: Hash[];
  paths: string[];
  inputStatuses: ReferenceStatus[];
  assertionStatuses: ReferenceStatus[];
  dependencies: MigrationDependencies | null;
  behavior: SemanticJudgeInput["behavior"] | null;
  costSamples: Array<{ judgmentDigest: Hash; totalCostUsd: number }>;
};
export type MigrationInventory = {
  schemaVersion: "ebo.migration-inventory/v1";
  studyId: string;
  analysisRuntime: MigrationStudy["analysisRuntime"];
  selection: { artifacts: readonly string[]; completeWithinSelection: boolean };
  records: Array<{ path: string; schemaVersion: string; digest: Hash; validationProfile: "current-schema" | ReceiptProfile }>;
  units: MigrationUnit[];
  assertions: MigrationAssertion[];
  failures: Array<{ path: string; reason: string }>;
  summary: { artifactFiles: number; distinctAssertionContents: number; judgmentUnits: number;
    verifiedInputUnits: number; missingInputUnits: number; invalidInputUnits: number;
    measuredCostUsd: number | null };
};
export type MigrationTarget = { unitId: Hash; input: SemanticJudgeInput | JudgeInputV2; evaluatorDigest: Hash; configurationDigest: Hash };
export type MigrationReconciliation = {
  schemaVersion: "ebo.migration-reconciliation/v1";
  studyId: string;
  inventoryDigest: Hash;
  units: Array<{ id: Hash; disposition: "preserve-frozen-missing-evidence" | "pending-target" | "reuse" | "rejudge";
    changedDependencies: string[]; target: { inputDigest: Hash; evaluatorDigest: Hash; configurationDigest: Hash } | null }>;
  unboundAssertions: Array<{ digest: Hash; disposition: "preserve-frozen-missing-evidence" }>;
  summary: { reusableUnits: number; affectedUnits: number; pendingUnits: number; preservedMissingUnits: number;
    preservedAssertionUnits: number; measuredForecastUsd: number | null; unpricedAffectedUnits: number; authorizedPaidBudgetUsd: 0 };
};
const hash = (value: unknown): Hash => `sha256:${digestMetadata(value).value}`;
const schemas = new Set(["ebo.behavior-assertion/v1", "ebo.semantic-judgment/v1", "ebo.semantic-judge-input/v1",
  "ebo.structural-observation-set/v1", "ebo.occurrence-ratings/v1"]);
const limits = { files: 100_000, fileBytes: 64 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024 };

export function migrationDependencies(input: SemanticJudgeInput | JudgeInputV2): MigrationDependencies {
  if (input.schemaVersion === "ebo.semantic-judge-input/v2") {
    if (validateArtifact("V2 migration input", input).length) throw new Error("Invalid v2 migration input.");
    if (input.dependencies.observations !== hash(input.observations) || input.dependencies.ledger !== hash(input.ledger)
        || input.dependencies.request !== hash(input.request) || input.dependencies.evaluatorConfiguration !== hash(input.request.evaluator)
        || input.dependencies.ratings !== (input.ratings.length ? hash(input.ratings) : null)
        || input.observations.dataset.digest !== input.dependencies.dataset || input.ledger.datasetDigest !== input.dependencies.dataset
        || input.observations.runId !== input.runId || input.observations.attemptId !== input.attemptId || input.ledger.runId !== input.runId || input.ledger.attemptId !== input.attemptId) throw new Error("V2 migration input has stale or cross-attempt dependencies.");
    return { inputDigest: hash(input), datasetDigest: input.dependencies.dataset, selectionDigest: hash(input.request.eventIds),
      selectedEvidenceDigest: hash(input.evidence), rubricDigest: hash({ behavior: input.request.behavior, rubric: input.request.rubric }),
      behaviorDigest: hash(input.request.behavior), rubricIdentityDigest: hash({ id: input.request.rubric.id, version: input.request.rubric.version }),
      promptVersion: input.promptVersion, ratingsDigest: input.dependencies.ratings, observationSetDigest: input.dependencies.observations,
      ledgerDigest: input.dependencies.ledger, requestDigest: input.dependencies.request };
  }
  assertArtifact(input);
  if (input.schemaVersion !== "ebo.semantic-judge-input/v1") throw new Error("Unsupported migration input schema.");
  return { inputDigest: hash(input), datasetDigest: input.dataset.digest, selectionDigest: hash(input.selection),
    selectedEvidenceDigest: hash(input.evidence), rubricDigest: hash({ behavior: input.behavior, rubric: input.rubric }),
    behaviorDigest: hash(input.behavior), rubricIdentityDigest: hash({ id: input.rubric.id, version: input.rubric.version }),
    promptVersion: input.promptVersion, ratingsDigest: input.selection.ratingsDigest ?? null };
}

/** Read a named, bounded census without changing its artifacts or loading packet-supplied code. */
export function inventoryMigrationStudy(study: MigrationStudy): MigrationInventory {
  const runtime = listAnalysisRuntimes().find(({ id }) => id === study.analysisRuntime.id);
  if (!runtime || runtime.manifestDigest !== study.analysisRuntime.manifestDigest) throw new Error("Migration study requires a supported pinned analysis runtime.");
  if (!study.id.trim() || study.artifacts.length > limits.files || new Set(study.artifacts).size !== study.artifacts.length
      || study.receiptProfiles?.some((profile) => profile !== "codex-relay-0.162.1-no-wall-limit/v1")) throw new Error("Invalid migration study selection.");
  const root = resolve(study.root);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Migration study root must be a regular directory.");
  let bytes = 0;
  const cache = new Map<string, unknown>();
  const validationProfiles = new Map<string, "current-schema" | ReceiptProfile>();
  const read = (path: string): unknown => {
    if (!isSafeArtifactRelativePath(path)) throw new Error("UNSAFE_ARTIFACT_PATH");
    if (cache.has(path)) return cache.get(path);
    let current = root;
    for (const part of path.split("/")) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new Error("LINKED_ARTIFACT");
    }
    const stat = lstatSync(current);
    if (!stat.isFile() || stat.size > limits.fileBytes || bytes + stat.size > limits.totalBytes || cache.size >= limits.files) throw new Error("ARTIFACT_LIMIT");
    bytes += stat.size;
    const text = new TextDecoder("utf8", { fatal: true }).decode(readFileSync(current));
    const value: unknown = JSON.parse(text); assertNoDuplicateJsonKeys(text);
    const profile = assertArtifact(value, study.receiptProfiles);
    validationProfiles.set(path, profile);
    cache.set(path, value); return value;
  };
  const reference = <T>(parent: string, ref: { path: string; digest: Hash } | undefined): { status: ReferenceStatus; value?: T; digest?: Hash } => {
    if (!ref) return { status: "absent" };
    if (!isSafeArtifactRelativePath(ref.path)) return { status: "invalid" };
    const path = dirname(parent) === "." ? ref.path : `${dirname(parent)}/${ref.path}`;
    try {
      const value = read(path) as T, digest = hash(value);
      return digest === ref.digest ? { status: "verified", value, digest } : { status: "invalid" };
    } catch (error) { return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid" }; }
  };
  const records: MigrationInventory["records"] = [], failures: MigrationInventory["failures"] = [];
  const units = new Map<Hash, MigrationUnit>(), assertions = new Map<Hash, MigrationAssertion>();
  const noteAssertion = (assertion: BehaviorAssertion, path: string) => {
    const digest = hash(assertion), existing = assertions.get(digest);
    if (existing) { if (!existing.paths.includes(path)) existing.paths.push(path); return; }
    assertions.set(digest, { digest, runId: assertion.runId, attemptId: assertion.attemptId, datasetDigest: assertion.dataset.digest,
      behaviorDigest: hash(assertion.behavior), rubricIdentityDigest: hash(assertion.rubric),
      configurationDigest: assertion.evaluator.configurationDigest ?? null, paths: [path] });
  };
  for (const path of [...study.artifacts].sort()) {
    try {
      const value = read(path) as { schemaVersion: string }, digest = hash(value);
      if (!schemas.has(value.schemaVersion)) throw new Error("UNSUPPORTED_MIGRATION_ARTIFACT");
      records.push({ path, schemaVersion: value.schemaVersion, digest, validationProfile: validationProfiles.get(path)! });
      if (value.schemaVersion === "ebo.behavior-assertion/v1") noteAssertion(value as BehaviorAssertion, path);
      if (value.schemaVersion !== "ebo.semantic-judgment/v1") continue;
      const judgment = value as SemanticJudgmentRecord;
      const input = reference<SemanticJudgeInput>(path, judgment.input), assertion = reference<BehaviorAssertion>(path, judgment.assertion);
      if (input.status === "verified" && (input.value!.schemaVersion !== "ebo.semantic-judge-input/v1" || input.value!.runId !== judgment.runId || input.value!.attemptId !== judgment.attemptId)) input.status = "invalid";
      if (assertion.status === "verified" && (assertion.value!.schemaVersion !== "ebo.behavior-assertion/v1" || assertion.value!.id !== judgment.assertion!.id
          || assertion.value!.runId !== judgment.runId || assertion.value!.attemptId !== judgment.attemptId
          || input.status === "verified" && (assertion.value!.dataset.digest !== input.value!.dataset.digest
            || hash(assertion.value!.behavior) !== hash(input.value!.behavior)
            || assertion.value!.rubric.id !== input.value!.rubric.id || assertion.value!.rubric.version !== input.value!.rubric.version))) assertion.status = "invalid";
      if (assertion.status === "verified" && (assertion.value!.evaluator.id !== `${judgment.evaluator.provider}/${judgment.evaluator.model}`
          || assertion.value!.evaluator.version !== judgment.evaluator.backend.version)) assertion.status = "invalid";
      const configurationDigest = assertion.status === "verified" ? assertion.value!.evaluator.configurationDigest ?? null : null;
      // An unavailable configuration cannot establish that two separate judgments used the same configuration.
      const id = hash({ inputDigest: judgment.input.digest, evaluator: judgment.evaluator, configurationDigest,
        ...(configurationDigest === null ? { unverifiedConfigurationJudgment: digest } : {}) });
      const unit = units.get(id) ?? { id, runId: judgment.runId, attemptId: judgment.attemptId, inputDigest: judgment.input.digest,
        evaluatorDigest: hash(judgment.evaluator), configurationDigest, judgmentDigests: [], assertionDigests: [], paths: [],
        inputStatuses: [], assertionStatuses: [], dependencies: null, behavior: null, costSamples: [] };
      if (unit.runId !== judgment.runId || unit.attemptId !== judgment.attemptId) throw new Error("UNIT_IDENTITY_CONFLICT");
      unit.paths.push(path); unit.judgmentDigests.push(digest); unit.inputStatuses.push(input.status); unit.assertionStatuses.push(assertion.status);
      if (assertion.status === "verified") {
        unit.assertionDigests.push(assertion.digest!);
        noteAssertion(assertion.value!, dirname(path) === "." ? judgment.assertion!.path : `${dirname(path)}/${judgment.assertion!.path}`);
      }
      if (input.status === "verified") { unit.dependencies = migrationDependencies(input.value!); unit.behavior = input.value!.behavior; }
      if (judgment.usage.status === "available") unit.costSamples.push({ judgmentDigest: digest, totalCostUsd: judgment.usage.value.totalCostUsd });
      units.set(id, unit);
    } catch { failures.push({ path, reason: "INVALID_OR_UNREADABLE_MIGRATION_ARTIFACT" }); }
  }
  const verifiedCopies = new Map<Hash, MigrationUnit>();
  for (const unit of units.values()) if (unit.configurationDigest) for (const digest of unit.judgmentDigests) verifiedCopies.set(digest, unit);
  for (const unit of units.values()) if (!unit.configurationDigest) {
    const complete = verifiedCopies.get(unit.judgmentDigests[0]!);
    if (!complete) continue;
    complete.paths.push(...unit.paths); complete.judgmentDigests.push(...unit.judgmentDigests);
    complete.assertionDigests.push(...unit.assertionDigests); complete.inputStatuses.push(...unit.inputStatuses);
    complete.assertionStatuses.push(...unit.assertionStatuses); complete.costSamples.push(...unit.costSamples);
    if (!complete.dependencies && unit.dependencies) { complete.dependencies = unit.dependencies; complete.behavior = unit.behavior; }
    units.delete(unit.id);
  }
  const retained = [...units.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const unit of retained) {
    // Copies can supply complementary files; their assembled bindings need the same checks as colocated files.
    if (unit.dependencies && unit.assertionDigests.some((digest) => !assertionMatchesUnit(assertions.get(digest)!, unit))) unit.assertionStatuses.push("invalid");
    unit.judgmentDigests = [...new Set(unit.judgmentDigests)].sort(); unit.assertionDigests = [...new Set(unit.assertionDigests)].sort();
    unit.inputStatuses = [...new Set(unit.inputStatuses)].sort(); unit.assertionStatuses = [...new Set(unit.assertionStatuses)].sort();
    unit.costSamples = [...new Map(unit.costSamples.map((sample) => [sample.judgmentDigest, sample])).values()];
  }
  const samples = [...new Map(retained.flatMap((unit) => unit.costSamples).map((sample) => [sample.judgmentDigest, sample])).values()];
  return { schemaVersion: "ebo.migration-inventory/v1", studyId: study.id, analysisRuntime: structuredClone(study.analysisRuntime),
    selection: { artifacts: [...study.artifacts].sort(), completeWithinSelection: failures.length === 0 }, records, units: retained,
    assertions: [...assertions.values()].sort((a, b) => a.digest.localeCompare(b.digest)).map((assertion) => ({ ...assertion, paths: assertion.paths.sort() })), failures,
    summary: { artifactFiles: records.length, distinctAssertionContents: assertions.size, judgmentUnits: retained.length,
      verifiedInputUnits: retained.filter((unit) => unit.dependencies !== null).length,
      missingInputUnits: retained.filter((unit) => unit.inputStatuses.every((status) => status === "missing")).length,
      invalidInputUnits: retained.filter((unit) => unit.inputStatuses.includes("invalid")).length,
      measuredCostUsd: samples.length ? samples.reduce((sum, sample) => sum + sample.totalCostUsd, 0) : null } };
}

/** Reconcile actual regenerated inputs. Dataset, selection, ledger and evidence changes remain separately visible. */
export function reconcileMigration(inventory: MigrationInventory, targets: readonly MigrationTarget[] = []): MigrationReconciliation {
  if (validateArtifact("Migration inventory", inventory).length) throw new Error("Invalid migration inventory schema.");
  if (!inventory.selection.completeWithinSelection || inventory.failures.length || inventory.summary.invalidInputUnits
      || inventory.units.some((unit) => unit.assertionStatuses.includes("invalid"))) throw new Error("Migration inventory contains integrity failures.");
  const assertions = new Map(inventory.assertions.map((assertion) => [assertion.digest, assertion]));
  if (assertions.size !== inventory.assertions.length || inventory.units.some((unit) => unit.assertionDigests.some((digest) => {
    const assertion = assertions.get(digest); return !assertion || unit.dependencies && !assertionMatchesUnit(assertion, unit);
  }))) throw new Error("Migration inventory assertion bindings are inconsistent.");
  const targetMap = new Map(targets.map((target) => [target.unitId, target]));
  const unitMap = new Map(inventory.units.map((unit) => [unit.id, unit]));
  if (targetMap.size !== targets.length || targets.some((target) => !unitMap.has(target.unitId))) throw new Error("Duplicate or unknown migration target unit.");
  const costs = new Map<Hash, Map<Hash, number>>();
  for (const unit of inventory.units) {
    const group = costs.get(unit.evaluatorDigest) ?? new Map<Hash, number>();
    for (const sample of unit.costSamples) group.set(sample.judgmentDigest, sample.totalCostUsd);
    costs.set(unit.evaluatorDigest, group);
  }
  let forecast = 0, unpriced = 0;
  const units = inventory.units.map((unit): MigrationReconciliation["units"][number] => {
    const target = targetMap.get(unit.id);
    if (!unit.dependencies || !unit.configurationDigest || !unit.assertionDigests.length) {
      if (target) throw new Error("A migration target needs verified original input and assertion configuration.");
      return { id: unit.id, disposition: "preserve-frozen-missing-evidence", changedDependencies: [], target: null };
    }
    if (!target) return { id: unit.id, disposition: "pending-target", changedDependencies: [], target: null };
    if (target.input.runId !== unit.runId || target.input.attemptId !== unit.attemptId || hash(target.input.schemaVersion === "ebo.semantic-judge-input/v2" ? target.input.request.behavior : target.input.behavior) !== hash(unit.behavior)) throw new Error("Migration target belongs to another attempt or behavior dimension.");
    if (![target.evaluatorDigest, target.configurationDigest].every((digest) => /^sha256:[a-f0-9]{64}$/u.test(digest))) throw new Error("Invalid target evaluator identity.");
    const dependencies = migrationDependencies(target.input);
    if (target.input.schemaVersion === "ebo.semantic-judge-input/v2" && target.configurationDigest !== target.input.dependencies.evaluatorConfiguration) throw new Error("V2 migration target configuration differs from its input.");
    const changed: string[] = (Object.keys(dependencies) as Array<keyof MigrationDependencies>).filter((key) => dependencies[key] !== unit.dependencies![key]);
    if (target.evaluatorDigest !== unit.evaluatorDigest) changed.push("evaluatorDigest");
    if (target.configurationDigest !== unit.configurationDigest) changed.push("configurationDigest");
    if (changed.length) {
      const samples = [...(costs.get(target.evaluatorDigest)?.values() ?? [])];
      if (!samples.length) unpriced++; else forecast += samples.reduce((sum, cost) => sum + cost, 0) / samples.length;
    }
    return { id: unit.id, disposition: changed.length ? "rejudge" : "reuse", changedDependencies: changed,
      target: { inputDigest: dependencies.inputDigest, evaluatorDigest: target.evaluatorDigest, configurationDigest: target.configurationDigest } };
  });
  const boundAssertions = new Set(inventory.units.flatMap((unit) => unit.assertionDigests));
  const unboundAssertions = inventory.assertions.filter((assertion) => !boundAssertions.has(assertion.digest))
    .map(({ digest }) => ({ digest, disposition: "preserve-frozen-missing-evidence" as const }));
  return { schemaVersion: "ebo.migration-reconciliation/v1", studyId: inventory.studyId, inventoryDigest: hash(inventory), units, unboundAssertions,
    summary: { reusableUnits: units.filter((unit) => unit.disposition === "reuse").length,
      affectedUnits: units.filter((unit) => unit.disposition === "rejudge").length,
      pendingUnits: units.filter((unit) => unit.disposition === "pending-target").length,
      preservedMissingUnits: units.filter((unit) => unit.disposition === "preserve-frozen-missing-evidence").length,
      preservedAssertionUnits: unboundAssertions.length,
      measuredForecastUsd: unpriced ? null : forecast, unpricedAffectedUnits: unpriced, authorizedPaidBudgetUsd: 0 } };
}

function assertionMatchesUnit(assertion: MigrationAssertion, unit: MigrationUnit): boolean {
  return assertion.runId === unit.runId && assertion.attemptId === unit.attemptId
    && assertion.datasetDigest === unit.dependencies!.datasetDigest && assertion.behaviorDigest === unit.dependencies!.behaviorDigest
    && assertion.rubricIdentityDigest === unit.dependencies!.rubricIdentityDigest;
}

function assertArtifact(value: unknown, profiles: readonly ReceiptProfile[] = []): "current-schema" | ReceiptProfile {
  if (!value || typeof value !== "object" || !schemas.has((value as { schemaVersion?: string }).schemaVersion ?? "")) throw new Error("INVALID_MIGRATION_ARTIFACT");
  const errors = validateArtifact("Migration artifact", value);
  if (!errors.length) return "current-schema";
  const judgment = value as SemanticJudgmentRecord;
  if (profiles.includes("codex-relay-0.162.1-no-wall-limit/v1") && judgment.schemaVersion === "ebo.semantic-judgment/v1"
      && judgment.evaluator?.backend?.id === "codex-app-server" && judgment.evaluator.backend.version === "0.162.1"
      && judgment.evaluator.limits?.maxWallClockMs === undefined && errors.length === 1
      && errors[0]!.field === "/evaluator/limits/maxWallClockMs" && errors[0]!.message === "must have required property 'maxWallClockMs'") return "codex-relay-0.162.1-no-wall-limit/v1";
  throw new Error("INVALID_MIGRATION_ARTIFACT");
}

/** Source readback is mandatory before packaging a v2 migration target. This function dispatches no inference. */
export async function createMigrationTargetV2(unit: MigrationUnit, input: JudgeInputV2, evidence: RetainedBehaviorEvidenceV2): Promise<MigrationTarget> {
  if (!unit.dependencies || !unit.configurationDigest || !unit.assertionDigests.length) throw new Error("V2 migration target requires verified original dependencies and assertion configuration.");
  await validateSemanticJudgeInputV2(input, evidence);
  if (input.runId !== unit.runId || input.attemptId !== unit.attemptId || hash(input.request.behavior) !== hash(unit.behavior)) throw new Error("V2 migration target belongs to a different original judgment unit.");
  return { unitId: unit.id, input, evaluatorDigest: hash({ id: input.request.evaluator.id, version: input.request.evaluator.version }), configurationDigest: input.dependencies.evaluatorConfiguration };
}
