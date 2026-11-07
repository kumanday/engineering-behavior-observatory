import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digestMetadata, validateArtifact } from "../src/artifacts.js";
import { listAnalysisRuntimes } from "../src/analysis-runtime.js";
import { inventoryMigrationStudy, migrationDependencies, reconcileMigration, type MigrationStudy } from "../src/migration-accounting.js";
import type { BehaviorAssertion } from "../src/behavior-assertions.js";
import type { SemanticJudgeInput, SemanticJudgmentRecord } from "../src/semantic-judge.js";
const hash = (v: unknown): `sha256:${string}` => `sha256:${digestMetadata(v).value}`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ebo-migration-"));
  const assertion = JSON.parse(readFileSync("test/fixtures/behavior-assertions/abstained.json", "utf8")) as BehaviorAssertion;
  assertion.evaluator.configurationDigest = hash("configuration");
  assertion.evaluator.id = "anthropic/fixture-model"; assertion.evaluator.version = "fixture";
  const input: SemanticJudgeInput = { schemaVersion: "ebo.semantic-judge-input/v1", promptVersion: "1.2.0", runId: assertion.runId,
    attemptId: assertion.attemptId, dataset: assertion.dataset, behavior: assertion.behavior,
    rubric: { ...assertion.rubric, instructions: "Read the cited evidence." },
    selection: { requestedEventIds: [], requestedStructuralObservationIds: [], includedEventIds: [], includedStructuralObservationIds: [], omitted: [], truncated: [] },
    blinding: { evaluatedModelIdentity: "redacted", redactionCount: 0, sourceIdentityPreserved: true, residualClues: [] },
    limits: { maxEvidenceItems: 8, maxRecordChars: 1024, maxInputChars: 10000, maxCitations: 8 }, evidence: [] };
  const judgment: SemanticJudgmentRecord = { schemaVersion: "ebo.semantic-judgment/v1", id: "judgment", runId: input.runId, attemptId: input.attemptId,
    createdAt: "2026-11-07T00:00:00Z", status: "proposed", input: { path: "input.json", digest: hash(input), sharingClass: "restricted" },
    assertion: { path: "assertion.json", digest: hash(assertion), sharingClass: "restricted", id: assertion.id },
    evaluator: { provider: "anthropic", model: "fixture-model", effort: "low", backend: { id: "claude-agent-sdk", version: "fixture" },
      environment: { parentPreserved: true, modelEffortOverrides: "removed", ambientTelemetry: "removed", removedKeys: [] },
      limits: { ...input.limits, maxOutputChars: 1024, maxWallClockMs: 1000, maxTurns: 1 } },
    parse: { status: "valid" }, timing: { status: "unavailable", reason: "UNRECORDED" }, usage: { status: "unavailable", reason: "UNRECORDED" } };
  const runtime = listAnalysisRuntimes().find(({ id }) => id === "ebo-v1.4.0-86a6010")!;
  const study: MigrationStudy = { id: "study", root, analysisRuntime: { id: runtime.id, manifestDigest: runtime.manifestDigest },
    artifacts: ["judgment.json", "assertion.json", "input.json"] };
  const write = () => { for (const [path, value] of [["judgment.json", judgment], ["assertion.json", assertion], ["input.json", input]] as const) {
    assert.deepEqual(validateArtifact(path, value), []); writeFileSync(join(root, path), JSON.stringify(value));
  } };
  write(); return { root, assertion, input, judgment, study, write, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("migration inventories deduplicate copies and preserve immutable source bytes", () => {
  const f = fixture(); try {
    mkdirSync(join(f.root, "copy")); for (const p of f.study.artifacts) writeFileSync(join(f.root, "copy", p), readFileSync(join(f.root, p)));
    const before = readFileSync(join(f.root, "judgment.json"));
    const inventory = inventoryMigrationStudy({ ...f.study, artifacts: [...f.study.artifacts, "copy/judgment.json", "copy/assertion.json"] });
    assert.deepEqual(validateArtifact("inventory", inventory), []);
    assert.deepEqual(inventory.summary, { artifactFiles: 5, distinctAssertionContents: 1, judgmentUnits: 1, verifiedInputUnits: 1, missingInputUnits: 0, invalidInputUnits: 0, measuredCostUsd: null });
    assert.deepEqual(readFileSync(join(f.root, "judgment.json")), before);
    assert.equal(inventory.units[0]!.paths.length, 2);
    const reversed = inventoryMigrationStudy({ ...f.study, artifacts: [...f.study.artifacts, "copy/assertion.json", "copy/judgment.json"].reverse() });
    assert.deepEqual(reversed, inventory);
  } finally { f.close(); }
});
test("unchanged packaged inputs reuse while dataset and ledger changes identify affected units", () => {
  const f = fixture(); try {
    const inventory = inventoryMigrationStudy(f.study), unit = inventory.units[0]!;
    const target = { unitId: unit.id, input: structuredClone(f.input), evaluatorDigest: unit.evaluatorDigest, configurationDigest: unit.configurationDigest! };
    assert.equal(reconcileMigration(inventory, [target]).summary.reusableUnits, 1);
    target.input.dataset.digest = hash("v2-dataset"); target.input.selection.ratingsDigest = hash("new-ratings");
    const report = reconcileMigration(inventory, [target]);
    assert.deepEqual(validateArtifact("reconciliation", report), []);
    assert.equal(report.summary.affectedUnits, 1); assert.equal(report.summary.unpricedAffectedUnits, 1);
    assert.equal(report.summary.measuredForecastUsd, null); assert.equal(report.summary.authorizedPaidBudgetUsd, 0);
    assert.deepEqual(report.units[0]!.changedDependencies, ["inputDigest", "datasetDigest", "selectionDigest", "ratingsDigest"]);
  } finally { f.close(); }
});
test("missing inputs have a frozen disposition and cannot receive a fabricated migration target", () => {
  const f = fixture(); try {
    rmSync(join(f.root, "input.json")); f.study.artifacts = ["judgment.json", "assertion.json"];
    const inventory = inventoryMigrationStudy(f.study); assert.equal(inventory.summary.missingInputUnits, 1);
    assert.equal(reconcileMigration(inventory).summary.preservedMissingUnits, 1);
    const unit = inventory.units[0]!;
    assert.throws(() => reconcileMigration(inventory, [{ unitId: unit.id, input: f.input, evaluatorDigest: unit.evaluatorDigest, configurationDigest: unit.configurationDigest! }]), /verified original/u);
  } finally { f.close(); }
});
test("cost forecasting uses unique measured judgments with matching evaluator identity", () => {
  const f = fixture(); try {
    f.judgment.usage = { status: "available", value: { totalCostUsd: 0.2, numTurns: 1, mainLoop: null, byModel: null } }; f.write();
    mkdirSync(join(f.root, "copy")); for (const p of f.study.artifacts) writeFileSync(join(f.root, "copy", p), readFileSync(join(f.root, p)));
    const inventory = inventoryMigrationStudy({ ...f.study, artifacts: [...f.study.artifacts, "copy/judgment.json"] }), unit = inventory.units[0]!;
    assert.equal(inventory.summary.measuredCostUsd, 0.2);
    const input = structuredClone(f.input); input.evidence = [...input.evidence, { kind: "event", id: "new", content: "new source", truncated: false }];
    const target = { unitId: unit.id, input, evaluatorDigest: unit.evaluatorDigest, configurationDigest: unit.configurationDigest! };
    assert.equal(reconcileMigration(inventory, [target]).summary.measuredForecastUsd, 0.2);
    target.evaluatorDigest = hash("another-evaluator"); assert.equal(reconcileMigration(inventory, [target]).summary.measuredForecastUsd, null);
  } finally { f.close(); }
});
test("stale, cross-attempt and dimension-mismatched references block reconciliation", () => {
  for (const change of ["digest", "identity", "dimension"] as const) {
    const f = fixture(); try {
      if (change === "digest") f.judgment.input.digest = hash("stale");
      if (change === "identity") { f.input.attemptId = "another-attempt"; f.judgment.input.digest = hash(f.input); }
      if (change === "dimension") { f.assertion.behavior = { ...f.assertion.behavior, dimensionId: "another-dimension" }; f.judgment.assertion!.digest = hash(f.assertion); }
      f.write(); const inventory = inventoryMigrationStudy(f.study);
      assert.throws(() => reconcileMigration(inventory), /integrity failures/u);
    } finally { f.close(); }
  }
});
test("unknown configuration does not merge separately recorded judgments", () => {
  const f = fixture(); try {
    delete f.assertion.evaluator.configurationDigest; f.judgment.assertion!.digest = hash(f.assertion); f.write();
    const second = structuredClone(f.judgment); second.id = "second"; writeFileSync(join(f.root, "second.json"), JSON.stringify(second));
    const inventory = inventoryMigrationStudy({ ...f.study, artifacts: [...f.study.artifacts, "second.json"] });
    assert.equal(inventory.units.length, 2); assert.equal(reconcileMigration(inventory).summary.preservedMissingUnits, 2);
  } finally { f.close(); }
});
test("failed judgments without assertions preserve missing evidence without blocking complete units", () => {
  const f = fixture(); try {
    const failed = structuredClone(f.judgment); failed.id = "failed"; failed.status = "failed"; delete failed.assertion;
    failed.parse = { status: "failed", kind: "provider", message: "Retained provider failure" };
    assert.deepEqual(validateArtifact("failure", failed), []);
    writeFileSync(join(f.root, "failure.json"), JSON.stringify(failed));
    const report = reconcileMigration(inventoryMigrationStudy({ ...f.study, artifacts: [...f.study.artifacts, "failure.json"] }));
    assert.equal(report.summary.pendingUnits, 1); assert.equal(report.summary.preservedMissingUnits, 1);
  } finally { f.close(); }
});
test("byte-identical judgment copies share configuration evidence from any complete copy", () => {
  const f = fixture(); try {
    mkdirSync(join(f.root, "partial")); writeFileSync(join(f.root, "partial/judgment.json"), readFileSync(join(f.root, "judgment.json")));
    const inventory = inventoryMigrationStudy({ ...f.study, artifacts: [...f.study.artifacts, "partial/judgment.json"] });
    assert.equal(inventory.units.length, 1); assert.equal(inventory.units[0]!.judgmentDigests.length, 1);
    assert.equal(reconcileMigration(inventory).summary.preservedMissingUnits, 0);
    assert.equal(reconcileMigration(inventory).summary.pendingUnits, 1);
  } finally { f.close(); }
});
test("reconciliation receipts bind differing target evaluator configurations", () => {
  const f = fixture(); try {
    const inventory = inventoryMigrationStudy(f.study), unit = inventory.units[0]!;
    const target = { unitId: unit.id, input: f.input, evaluatorDigest: unit.evaluatorDigest, configurationDigest: hash("new-config") };
    const first = reconcileMigration(inventory, [target]), second = reconcileMigration(inventory, [{ ...target, configurationDigest: hash("other-config") }]);
    assert.notEqual(hash(first), hash(second)); assert.equal(first.units[0]!.target!.configurationDigest, target.configurationDigest);
  } finally { f.close(); }
});
test("complementary copies cannot join an assertion to mismatched input dependencies", () => {
  for (const field of ["dataset", "behavior", "rubric"] as const) {
    const f = fixture(); try {
      if (field === "dataset") f.assertion.dataset = { ...f.assertion.dataset, digest: hash("different-dataset") };
      if (field === "behavior") f.assertion.behavior = { ...f.assertion.behavior, dimensionId: "different-dimension" };
      if (field === "rubric") f.assertion.rubric = { ...f.assertion.rubric, version: "different-version" };
      f.judgment.assertion!.digest = hash(f.assertion); f.write();
      mkdirSync(join(f.root, "partial"));
      writeFileSync(join(f.root, "partial/judgment.json"), readFileSync(join(f.root, "judgment.json")));
      writeFileSync(join(f.root, "partial/input.json"), readFileSync(join(f.root, "input.json")));
      rmSync(join(f.root, "input.json"));
      const inventory = inventoryMigrationStudy({ ...f.study, artifacts: ["judgment.json", "partial/judgment.json"] });
      assert.equal(inventory.units.length, 1); assert.throws(() => reconcileMigration(inventory), /integrity failures/u);
    } finally { f.close(); }
  }
});
test("assertions without retained judgment receipts receive explicit preservation dispositions", () => {
  const f = fixture(); try {
    const inventory = inventoryMigrationStudy({ ...f.study, artifacts: ["assertion.json"] });
    const report = reconcileMigration(inventory);
    assert.equal(report.summary.preservedAssertionUnits, 1);
    assert.deepEqual(report.unboundAssertions, [{ digest: hash(f.assertion), disposition: "preserve-frozen-missing-evidence" }]);
    assert.deepEqual(validateArtifact("report", report), []);
  } finally { f.close(); }
});
test("historical relay receipt profile preserves an omitted limit only with explicit pinned admission", () => {
  const f = fixture(); try {
    f.judgment.evaluator = { ...f.judgment.evaluator, provider: "openai", backend: { id: "codex-app-server", version: "0.162.1" },
      environment: { parentPreserved: false, mode: "replace", allowedKeys: ["HOME", "CODEX_HOME", "PATH", "LANG", "LC_ALL", "TMPDIR"], authentication: "existing-auth-json-only", modelEffortOverrides: "removed", ambientTelemetry: "removed", removedKeys: ["*"] } };
    delete (f.judgment.evaluator.limits as Partial<typeof f.judgment.evaluator.limits>).maxWallClockMs;
    f.assertion.evaluator.id = "openai/fixture-model"; f.assertion.evaluator.version = "0.162.1";
    f.judgment.assertion!.digest = hash(f.assertion);
    writeFileSync(join(f.root, "judgment.json"), JSON.stringify(f.judgment)); writeFileSync(join(f.root, "assertion.json"), JSON.stringify(f.assertion));
    assert.equal(inventoryMigrationStudy(f.study).failures.length, 1);
    const study = { ...f.study, receiptProfiles: ["codex-relay-0.162.1-no-wall-limit/v1" as const] };
    const inventory = inventoryMigrationStudy(study); assert.equal(inventory.failures.length, 0);
    assert.equal(inventory.records.find(({ path }) => path === "judgment.json")!.validationProfile, study.receiptProfiles[0]);
    assert.equal(reconcileMigration(inventory).summary.pendingUnits, 1);
    f.judgment.evaluator.backend.version = "unqualified"; writeFileSync(join(f.root, "judgment.json"), JSON.stringify(f.judgment));
    assert.equal(inventoryMigrationStudy(study).failures.length, 1);
  } finally { f.close(); }
});
test("migration reads reject unsafe paths, links, duplicate JSON and unsupported runtime pins", () => {
  const f = fixture(); try {
    assert.throws(() => inventoryMigrationStudy({ ...f.study, analysisRuntime: { ...f.study.analysisRuntime, manifestDigest: hash("wrong") } }), /pinned/u);
    for (const path of ["../input.json", "/input.json"]) assert.equal(inventoryMigrationStudy({ ...f.study, artifacts: [path] }).failures.length, 1);
    symlinkSync(join(f.root, "input.json"), join(f.root, "linked.json"));
    assert.equal(inventoryMigrationStudy({ ...f.study, artifacts: ["linked.json"] }).failures.length, 1);
    writeFileSync(join(f.root, "duplicate.json"), '{"schemaVersion":"ebo.semantic-judge-input/v1","schemaVersion":"ebo.behavior-assertion/v1"}');
    assert.equal(inventoryMigrationStudy({ ...f.study, artifacts: ["duplicate.json"] }).failures.length, 1);
    assert.throws(() => inventoryMigrationStudy({ ...f.study, artifacts: ["input.json", "input.json"] }), /selection/u);
  } finally { f.close(); }
});
test("targets require exact original unit and behavior bindings", () => {
  const f = fixture(); try {
    const inventory = inventoryMigrationStudy(f.study), unit = inventory.units[0]!;
    const target = { unitId: unit.id, input: structuredClone(f.input), evaluatorDigest: unit.evaluatorDigest, configurationDigest: unit.configurationDigest! };
    assert.equal(reconcileMigration(inventory).summary.pendingUnits, 1);
    assert.throws(() => reconcileMigration(inventory, [target, target]), /Duplicate/u);
    assert.throws(() => reconcileMigration(inventory, [{ ...target, unitId: hash("unrelated") }]), /unknown/u);
    target.input.behavior.dimensionId = "different"; assert.throws(() => reconcileMigration(inventory, [target]), /another attempt or behavior/u);
    assert.throws(() => migrationDependencies({ ...f.input, dataset: { ...f.input.dataset, digest: "invalid" } } as unknown as SemanticJudgeInput), /INVALID/u);
  } finally { f.close(); }
});

test("v2 migration targets bind source readback, observations, ledger and evaluator configuration", async () => {
  const { atifFixtureV2 } = await import("./consumers-v2-fixture.js"), { createStructuralObservationSetV2 } = await import("../src/analysis-v2.js");
  const { createOccurrenceLedgerV2 } = await import("../src/occurrences-v2.js"), { prepareSemanticJudgeInputV2 } = await import("../src/semantic-judge-v2.js");
  const { createMigrationTargetV2 } = await import("../src/migration-accounting.js");
  const f = fixture(); try {
    const evidence = await atifFixtureV2();
    for (const artifact of [f.input, f.assertion, f.judgment]) { artifact.runId = evidence.dataset.runId; artifact.attemptId = evidence.dataset.attemptId; }
    f.judgment.input.digest = hash(f.input); f.judgment.assertion!.digest = hash(f.assertion); f.write();
    const inventory = inventoryMigrationStudy(f.study), unit = inventory.units[0]!;
    const observations = await createStructuralObservationSetV2(evidence.dataset, evidence.resolver), ledger = await createOccurrenceLedgerV2(evidence.dataset, evidence.resolver);
    const input = await prepareSemanticJudgeInputV2(evidence, observations, ledger, { schemaVersion: "ebo.semantic-judge-request/v2", behavior: f.input.behavior,
      rubric: f.input.rubric, evaluator: { id: f.assertion.evaluator.id, version: f.assertion.evaluator.version, configuration: { legacy: f.judgment.evaluator } }, eventIds: [], limits: { maxRecordChars: 6000, maxInputChars: 1000000 } });
    const target = await createMigrationTargetV2(unit, input, evidence), report = reconcileMigration(inventory, [target]);
    assert.equal(report.summary.affectedUnits, 1); assert.equal(report.summary.authorizedPaidBudgetUsd, 0);
    for (const key of ["datasetDigest", "observationSetDigest", "ledgerDigest", "requestDigest", "promptVersion", "configurationDigest"]) assert.ok(report.units[0]!.changedDependencies.includes(key), key);
    assert.deepEqual(validateArtifact("report", report), []);
    const changed = structuredClone(input); changed.ledger.coverage[0]!.count += 1;
    assert.throws(() => migrationDependencies(changed), /stale/u);
    await assert.rejects(createMigrationTargetV2(unit, { ...input, attemptId: "foreign" }, evidence), /source evidence|dependencies/u);
    assert.throws(() => reconcileMigration(inventory, [{ ...target, configurationDigest: hash("unbound") }]), /configuration differs/u);
  } finally { f.close(); }
});

test("migration preparation preserves the rubric and requires the verified original evaluator", async () => {
  const { atifFixtureV2 } = await import("./consumers-v2-fixture.js"), { createStructuralObservationSetV2 } = await import("../src/analysis-v2.js");
  const { createOccurrenceLedgerV2 } = await import("../src/occurrences-v2.js"), { prepareMigrationTargetV2 } = await import("../src/migration-targets-v2.js");
  const f = fixture(); try {
    const evidence = await atifFixtureV2();
    for (const artifact of [f.input, f.assertion, f.judgment]) { artifact.runId = evidence.dataset.runId; artifact.attemptId = evidence.dataset.attemptId; }
    f.judgment.input.digest = hash(f.input); f.judgment.assertion!.digest = hash(f.assertion); f.write();
    const unit = inventoryMigrationStudy(f.study).units[0]!, observations = await createStructuralObservationSetV2(evidence.dataset, evidence.resolver), ledger = await createOccurrenceLedgerV2(evidence.dataset, evidence.resolver);
    const options = { unit, originalInput: f.input, legacyEvaluator: f.judgment.evaluator, evidence, observations, ledger, limits: { maxRecordChars: 6000, maxInputChars: 1000000 } };
    const target = await prepareMigrationTargetV2(options); assert.equal(target.input.schemaVersion, "ebo.semantic-judge-input/v2");
    if (target.input.schemaVersion !== "ebo.semantic-judge-input/v2") return;
    assert.deepEqual(target.input.request.rubric, f.input.rubric); assert.deepEqual(target.input.request.behavior, f.input.behavior);
    assert.equal(target.input.ratings.length, 0); assert.notEqual(target.configurationDigest, unit.configurationDigest);
    await assert.rejects(prepareMigrationTargetV2({ ...options, legacyEvaluator: { ...f.judgment.evaluator, model: "foreign" } }), /verified original/u);
    const missing = structuredClone(f.input); missing.evidence = [{ kind: "event", id: "missing", citation: { eventId: "missing", nativeReference: { artifactId: "missing", recordLocator: "#" } }, content: "{}", truncated: false }];
    await assert.rejects(prepareMigrationTargetV2({ ...options, originalInput: missing, unit: { ...unit, inputDigest: hash(missing) } }), /no v2 projection/u);
  } finally { f.close(); }
});
