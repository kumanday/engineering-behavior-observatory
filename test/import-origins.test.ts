import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { aggregateEvaluation, selectAggregationAttempts, type AggregationRequest } from "../src/aggregation.js";
import { assessComparisonEligibility, type ComparisonRequest } from "../src/normalization-integrity.js";
import { validateArtifact } from "../src/artifacts.js";
import { buildCorpusIndex, writeCorpusIndex, type CorpusIndexEntry } from "../src/corpus.js";
import { importAtifFile } from "../src/atif-import.js";
import { listAtifProducerProfiles } from "../src/atif-profiles.js";
import { createRetainedStructuralObservationSet } from "../src/structural-observations.js";
import { loadAtlas, queryAtlas } from "../src/atlas.js";
import { renderAtlas } from "../src/atlas-html.js";
import { buildAtlasBundle, verifyAtlasBundle } from "../src/atlas-bundle.js";
import { runAgentSdkSemanticJudge, type SemanticJudgeRequest } from "../src/semantic-judge.js";
import { probeClaudeAgentSdkCapabilities } from "../src/agent-sdk.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const python = process.env.EBO_ATIF_TEST_PYTHON;
const entry = (origin: "owned" | "imported"): CorpusIndexEntry => ({ schemaVersion: "ebo.corpus-index-entry/v1", manifestKind: origin === "owned" ? "run" : "import",
  manifestPath: `${origin}/manifest.json`, manifestDigest: digest, runId: origin, attemptId: origin, harnessId: "same-executed-agent",
  ...(origin === "owned" ? { terminalState: "completed", failureClass: "none" } : {}),
  captureQualification: origin === "owned" ? "qualified" : "imported", captureArtifactIds: [], verifierArtifactIds: [], verifierStatuses: [], exportArtifactIds: [], issues: [] });
const input = () => ({ corpusEntries: [entry("owned"), entry("imported")], observationSets: [], assertions: [], calibrations: [], comparisons: [] });
const policy = { groupBy: ["harness" as const], selectedAttemptPolicy: "all-attempts" as const, recurrence: { minimumOccurrences: 2 } };

test("legacy aggregation selects owned captures; explicit mixed-origin requests keep separate groups", async () => {
  const legacy = await aggregateEvaluation(input(), policy);
  assert.equal(legacy.sourcePopulation.selectedAttempts, 1);
  assert.equal(legacy.policy.evidenceOrigins, undefined);
  assert.deepEqual(legacy.policy.groupBy, ["harness"]);
  const mixed = await aggregateEvaluation(input(), { ...policy, evidenceOrigins: "separate" });
  assert.deepEqual(validateArtifact("aggregate", mixed), []);
  assert.equal(mixed.sourcePopulation.selectedAttempts, 2);
  assert.equal(mixed.groups.length, 2);
  assert.deepEqual(new Set(mixed.groups.map(({ dimensions }) => dimensions["evidence-origin"])), new Set(["owned", "imported"]));
  assert.ok(mixed.policy.groupBy.includes("evidence-origin"));
  assert.deepEqual(selectAggregationAttempts(input().corpusEntries, "all-attempts").map(({ attemptId }) => attemptId), ["owned"]);
  assert.deepEqual(selectAggregationAttempts(input().corpusEntries, "all-attempts", "imported").map(({ attemptId }) => attemptId), ["imported"]);
});

test("imported unknown outcomes cannot turn into zero failure or completion rates", async () => {
  const report = await aggregateEvaluation(input(), { ...policy, evidenceOrigins: "imported" });
  const metrics = report.groups[0]!.metrics;
  for (const id of ["infrastructure-failure-rate", "terminal-completed-rate"]) {
    const value = metrics.find((metric) => metric.id === id)!.measurement;
    assert.equal(value.status, "unavailable"); assert.equal(value.denominator.value, 0);
    assert.ok(value.exclusions.some(({ reason }) => reason.startsWith("imported-")));
  }
  assert.equal(metrics.find(({ id }) => id === "capture-qualified-rate")!.measurement.numerator.value, 0);
});

test("declaring a harness difference cannot waive origin, producer, fixture or budget gates", () => {
  const request = JSON.parse(readFileSync("test/fixtures/comparison/exact.json", "utf8")) as ComparisonRequest;
  request.right.harness.id = "atif.harbor.pi";
  request.right.evidenceOrigin = { kind: "imported", profileDigest: digest };
  request.policy.declaredDifferences = ["harness"];
  let report = assessComparisonEligibility(request);
  assert.equal(report.status, "unsupported");
  assert.ok(report.reasons.some(({ code }) => code === "evidence-origin-mismatch"));
  request.left.evidenceOrigin = { kind: "imported", profileDigest: `sha256:${"b".repeat(64)}` };
  report = assessComparisonEligibility(request);
  assert.ok(report.reasons.some(({ code }) => code === "producer-profile-mismatch"));
  request.left.evidenceOrigin.profileDigest = digest;
  request.right.fixture.digest = `sha256:${"c".repeat(64)}`;
  request.right.budgetDigest = `sha256:${"d".repeat(64)}`;
  report = assessComparisonEligibility(request);
  assert.ok(report.reasons.some(({ code }) => code === "fixture-mismatch"));
  assert.ok(report.reasons.some(({ dimension }) => dimension === "budget"));
  request.right.evidenceOrigin = { kind: "owned" };
  assert.ok(assessComparisonEligibility(request).reasons.some(({ code }) => code === "producer-profile-mismatch"), "an imported harness cannot bypass origin gates by omitting its profile");
});

test("imported Pi evidence flows through Atlas with origin labels, unknown outcomes and exact native pointers", { skip: !python }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-import-origins-"));
  try {
    mkdirSync(join(root, "corpus"));
    const bundleRoot = join(root, "corpus/pi");
    await importAtifFile({ sourcePath: "test/fixtures/atif/pi/parallel-failure-cache-write.atif.json", destination: bundleRoot,
      runId: "imported-run", attemptId: "imported-attempt", producer: listAtifProducerProfiles()[0]!.producer, pythonExecutable: python });
    const observations = await createRetainedStructuralObservationSet(bundleRoot);
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations));
    const index = buildCorpusIndex(join(root, "corpus"));
    assert.equal(index[0]!.evidenceOrigin, "imported");
    assert.match(index[0]!.producerProfileDigest!, /^sha256:/u);
    writeCorpusIndex(join(root, "index.jsonl"), index);
    const aggregation: AggregationRequest = { schemaVersion: "ebo.aggregation-request/v1", sources: { corpusRoot: "corpus", corpusIndex: "index.jsonl",
      observationSets: [{ bundleRoot: "corpus/pi", path: "observations.json" }], assertions: [], calibrations: [] },
      ...policy, evidenceOrigins: "imported", comparisons: [] };
    writeFileSync(join(root, "aggregation.json"), JSON.stringify(aggregation));
    writeFileSync(join(root, "atlas.json"), JSON.stringify({ schemaVersion: "ebo.atlas-request/v1", aggregationRequest: "aggregation.json", title: "Imported Pi" }));
    const source = await loadAtlas(join(root, "atlas.json")), view = await queryAtlas(source, { origin: "imported" });
    assert.equal(view.cases.length, 1); assert.equal(view.cases[0]!.origin, "imported");
    assert.equal(view.cases[0]!.outcome, "unavailable");
    assert.match(renderAtlas(view, false), /Imported evidence/u);
    writeFileSync(join(root, "bundle.json"), JSON.stringify({ schemaVersion: "ebo.atlas-bundle-request/v1", id: "imported-test", title: "Imported Pi", cohorts: [{ id: "pi", atlasRequest: "atlas.json" }] }));
    const out = join(root, "atlas-bundle");
    const manifest = await buildAtlasBundle(join(root, "bundle.json"), out);
    assert.equal(manifest.tables.attempts!.rows, 1);
    assert.ok(manifest.tables.events!.rows > 0);
    assert.equal(verifyAtlasBundle(out).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("semantic judging uses every retained model/route alias and never requires a run manifest for imports", { skip: !python }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-import-blinding-"));
  try {
    const source = JSON.parse(readFileSync("test/fixtures/atif/pi/parallel-failure-cache-write.atif.json", "utf8"));
    source.agent.model_name = "provider/Model[route]";
    source.steps[1].model_name = "Model[route]";
    source.steps[1].extra = { response_model: "served-model" };
    source.steps[1].message = "provider/Model[route] Model[route] served-model visible";
    const sourcePath = join(root, "source.json"); writeFileSync(sourcePath, JSON.stringify(source));
    const bundleRoot = join(root, "import");
    const imported = await importAtifFile({ sourcePath, destination: bundleRoot, runId: "r", attemptId: "a", producer: listAtifProducerProfiles()[0]!.producer, pythonExecutable: python });
    assert.deepEqual(new Set(imported.evidence.modelAliases), new Set(["provider/Model[route]", "Model[route]", "served-model", "synthetic-model"]));
    const observations = await createRetainedStructuralObservationSet(bundleRoot);
    const event = imported.evidence.dataset.events.find(({ family, attributes }) => family === "message" && attributes.role === "assistant")!;
    const request: SemanticJudgeRequest = { schemaVersion: "ebo.semantic-judge-request/v1", id: "test", behavior: { vocabularyVersion: "1.0.0", categoryId: "verification-completion", dimensionId: "verification-completion" },
      rubric: { id: "r", version: "1", instructions: "Inspect source behavior." }, evaluator: { provider: "anthropic", model: "judge", effort: "low" },
      selection: { eventIds: [event.id], structuralObservationIds: [], includeOutcomeObservations: false },
      limits: { maxEvidenceItems: 10, maxRecordChars: 8_000, maxInputChars: 32_000, maxOutputChars: 8_192, maxCitations: 4, maxWallClockMs: 5_000, maxTurns: 1 }, blinding: { evaluatedModelIdentity: "redact" } };
    let called = false;
    await runAgentSdkSemanticJudge({ bundleRoot, outputRoot: join(root, "judge"), observations, request,
      backend: { id: "claude-agent-sdk", version: probeClaudeAgentSdkCapabilities().sdkVersion, run: async (prompt) => {
        called = true; assert.doesNotMatch(prompt, /provider\/Model\[route\]|Model\[route\]|served-model/u); assert.match(prompt, /visible/u);
        return { status: "failed", kind: "provider", message: "Synthetic backend; no model call", raw: {} };
      } } });
    assert.equal(called, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("origin selection omits indexed excluded-origin derived sources and still rejects unindexed sources", async () => {
  for (const selected of ["owned", "imported"] as const) {
    const excluded = selected === "owned" ? "imported" : "owned";
    const excludedObservation = { bundleRoot: "/not-read", document: { runId: excluded, attemptId: excluded } } as Parameters<typeof aggregateEvaluation>[0]["observationSets"][number];
    const excludedAssertion = { bundleRoot: "/not-read", document: { runId: excluded, attemptId: excluded, id: "excluded-assertion" } } as Parameters<typeof aggregateEvaluation>[0]["assertions"][number];
    const report = await aggregateEvaluation({ ...input(), observationSets: [excludedObservation], assertions: [excludedAssertion] }, { ...policy, evidenceOrigins: selected });
    assert.equal(report.sourcePopulation.selectedAttempts, 1);
    assert.equal(report.sourceLineage.observationSets.length, 0);
    assert.equal(report.sourceLineage.assertions.length, 0);
  }
  const unknown = { bundleRoot: "/not-read", document: { runId: "unknown", attemptId: "unknown" } } as Parameters<typeof aggregateEvaluation>[0]["observationSets"][number];
  await assert.rejects(aggregateEvaluation({ ...input(), observationSets: [unknown] }, { ...policy, evidenceOrigins: "imported" }), /no unique corpus entry/u);
});
