import { occurrenceRequest, occurrenceState } from "../src/occurrence-ratings.js";
import { prepareJudgeRequest } from "../src/judge-prepare.js";
import { compareFixtureMeasurement } from "./atif-fixture-gate.js";
import { runAgentSdkSemanticJudge, type SemanticJudgeRequest } from "../src/semantic-judge.js";
import { probeClaudeAgentSdkCapabilities } from "../src/agent-sdk.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { digestMetadata, validateArtifact } from "../src/artifacts.js";
import { importAtifFile, readImportedBehaviorEvidence } from "../src/atif-import.js";
import { normalizePiAtif } from "../src/atif-pi.js";
import { inspectAtifBytes, type AtifObject } from "../src/atif-reader.js";
import { listAtifProducerProfiles } from "../src/atif-profiles.js";
import { createRetainedBehaviorEvidence } from "../src/retained-evidence.js";
import { createRetainedStructuralObservationSet, createStructuralObservationSet, toolOperations, nativeContentResolver } from "../src/structural-observations.js";
import { readCorpusIndex, writeCorpusIndex, buildCorpusIndex } from "../src/corpus.js";
import { validateBehaviorAssertion, type BehaviorAssertion } from "../src/behavior-assertions.js";
import { boundedEvidence } from "../src/evidence-projection.js";
import { main } from "../src/cli.js";
import { assertAdapterContract, type HarnessAdapter } from "../src/uniform-events.js";
import { NativeLines, nativeRecordDigest } from "../src/atlas-evidence.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const producer = listAtifProducerProfiles()[0]!.producer;
const fixture = (name = "parallel-failure-cache-write") => JSON.parse(readFileSync(join(root, `test/fixtures/atif/pi/${name}.atif.json`), "utf8")) as AtifObject;
const hash = (value: unknown): `sha256:${string}` => `sha256:${digestMetadata(value).value}`;
const python = process.env.EBO_ATIF_TEST_PYTHON;
// Pure projection fixtures use a declared synthetic validation receipt. Admission tests invoke Harbor below.
async function project(document = fixture(), declaration = producer) {
  const read = inspectAtifBytes(Buffer.from(JSON.stringify(document)));
  read.inspection.structural = { status: "valid", validator: "harbor", version: "0.24.0", diagnostics: [] };
  return normalizePiAtif({ read, producer: declaration, runId: "import-test", attemptId: "a", manifestDigest: hash({ synthetic: true }) });
}
const steps = (document: AtifObject) => document.steps as AtifObject[];

test("Pi projection retains imported authority, exact pointers, native call IDs and shared inference order", async () => {
  const source = fixture(), evidence = await project(source);
  assert.equal(evidence.capture.qualification, "imported");
  assert.equal(evidence.dataset.origin?.qualification, "imported");
  assert.equal(evidence.dataset.adapter.harness, "atif.harbor.pi");
  assert.deepEqual(validateArtifact("dataset", evidence.dataset), []);
  assert.deepEqual(validateArtifact("mapping", evidence.mapping), []);
  const calls = evidence.dataset.events.filter((event) => event.family === "tool" && event.phase === "before");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.nativeOrder, calls[1]!.nativeOrder);
  assert.equal(calls[0]!.attributes.inferenceId, calls[1]!.attributes.inferenceId);
  assert.equal(calls[0]!.attributes.nativeToolCallId, "call-a");
  assert.match(calls[0]!.source.nativeReference.recordLocator, /\/tool_calls\/0$/u);
  assert.equal(calls[0]!.nativeTime.status, "unsupported");
  assert.equal(evidence.dataset.events.some(({ family }) => family === "model-request"), false);
  assert.equal(evidence.mapping.measures["model-request-count"]!.status, "unavailable");
  const content = calls[0]!.content;
  assert.equal(content.status, "known");
  if (content.status === "known") assert.deepEqual(nativeContentResolver(evidence.outcomeCapture)(content.value[0]!.nativeReference), { command: "synthetic-test" });
});

test("production Pi mapping agrees with the independently authored fixture auditor", async () => {
  const auditor = await import(pathToFileURL(join(root, "scripts/atif-fixture-summary.mjs")).href);
  for (const name of ["parallel-failure-cache-write", "compaction", "branched-active-selection", "interrupted-pending"]) {
    const source = fixture(name), expected = auditor.piFixtureSourceMeasures(source), actual = (await project(source)).mapping;
    assert.equal(actual.recorded.calls, expected.calls.length, name);
    assert.deepEqual(actual.signatures.map(({ document, id, name, failed }) => ({ id: document === "#" ? id : `${document}:${id}`, name, failed })).sort((a, b) => a.id.localeCompare(b.id)), expected.signatures, name);
    for (const id of ["tool-operation-count", "tool-error-count", "input-token-count", "output-token-count", "cache-read-input-token-count"]) {
      const value = expected.measures[id];
      assert.equal(compareFixtureMeasurement(value, actual.measures[id]!, { allowedLossReasons: ["CONVERTER_ZERO_FILL_POSSIBLE", "USAGE_COMPONENT_COMPLETENESS_UNPROVEN"] }).status, "pass", `${name}:${id}`);
    }
  }
});

test("imported selected-history diagnostics never become exact attempt observations", async () => {
  const evidence = await project();
  assert.deepEqual(evidence.mapping.measures["tool-operation-count"], { status: "known", value: 2, unit: "identified-logical-tool-operations" });
  const observations = createStructuralObservationSet(evidence.dataset, evidence.coverage, evidence.outcomeCapture);
  assert.deepEqual(observations.observations.find(({ extractor }) => extractor.id === "outcome-capture-qualification")!.value,
    { status: "known", value: "imported", unit: "qualification" });
  assert.ok(observations.observations.filter(({ extractor }) => !extractor.id.startsWith("outcome-")).every(({ value }) => value.status === "unavailable"));
});

test("unknown producer conventions remain structurally inspectable without behavioral events or counts", async () => {
  const declaration = structuredClone(producer); declaration.converter.packageVersion = "unregistered";
  const evidence = await project(fixture(), declaration);
  assert.equal(evidence.dataset.events.length, 0);
  assert.equal(evidence.mapping.producerStatus, "unsupported");
  assert.ok(Object.values(evidence.mapping.recorded).every((value) => value === null));
  assert.equal(Object.values(evidence.mapping.measures).some(({ status }) => status === "known"), false);
  assert.equal(evidence.dataset.unmapped.length, evidence.dataset.nativeRecords.length);
});

test("producer declaration and source metadata must agree", async () => {
  const source = fixture(); (source.agent as AtifObject).version = "another-agent-version";
  await assert.rejects(project(source), /Producer declaration differs/u);
});

test("copied context and partial-history gaps preserve raw records and withhold exact recorded-history diagnostics", async () => {
  const source = fixture(); steps(source)[1]!.is_copied_context = true;
  const copied = await project(source);
  assert.equal(copied.mapping.recorded.calls, 0);
  assert.equal(copied.mapping.recorded.copiedStepsExcluded, 1);
  assert.ok(copied.dataset.unmapped.some(({ reference }) => reference.recordLocator === "#/steps/1"));
  delete steps(source)[1]!.is_copied_context;
  source.extra = { partial: { missing: ["tool"] } };
  const partial = await project(source);
  assert.equal(partial.mapping.recorded.calls, 2);
  assert.equal(partial.mapping.measures["tool-operation-count"]!.status, "unavailable");
  steps(source)[1]!.extra = { added_by: "hlb" };
  assert.equal((await project(source)).mapping.recorded.calls, 0);
});

test("pending, missing-status and duplicate-result calls retain unknown failure", async () => {
  for (const variant of ["pending", "missing", "duplicate"]) {
    const source = fixture(), observation = steps(source)[1]!.observation as { results: AtifObject[] };
    if (variant === "pending") observation.results.splice(0, 1);
    if (variant === "missing") delete observation.results[0]!.extra;
    if (variant === "duplicate") observation.results.push(structuredClone(observation.results[0]!));
    const evidence = await project(source);
    assert.equal(evidence.mapping.signatures[0]!.failed, null, variant);
    assert.equal(evidence.mapping.measures["tool-error-count"]!.status, "unavailable", variant);
    if (variant !== "missing") assert.equal(evidence.dataset.events.some((event) => event.family === "tool" && event.phase === "after" && event.attributes.nativeToolCallId === "call-a"), false);
  }
});

test("duplicate call identities across steps are excluded instead of merging separate operations", async () => {
  const source = fixture(); steps(source).push({ ...structuredClone(steps(source)[1]!), step_id: 3 });
  const evidence = await project(source);
  assert.equal(evidence.mapping.recorded.calls, 4);
  assert.equal(evidence.mapping.signatures.length, 0);
  assert.ok(evidence.mapping.limitations.includes("DUPLICATE_OPERATION_ID"));
  assert.equal(evidence.mapping.measures["tool-operation-count"]!.status, "unavailable");
});

test("usage inversion needs cache-write evidence and reconciles final totals", async () => {
  const baseline = await project();
  assert.deepEqual(baseline.mapping.measures["input-token-count"], { status: "known", value: 18, unit: "tokens" });
  for (const variant of ["missing-write", "final-write-conflict", "final-prompt-conflict", "negative-input"]) {
    const source = fixture(), step = steps(source)[1]!, metrics = step.metrics as AtifObject;
    if (variant === "missing-write") delete (metrics.extra as AtifObject).cache_write_tokens;
    if (variant === "final-write-conflict") ((source.final_metrics as AtifObject).extra as AtifObject).cache_write_tokens = 999;
    if (variant === "final-prompt-conflict") (source.final_metrics as AtifObject).total_prompt_tokens = 999;
    if (variant === "negative-input") metrics.cached_tokens = 999;
    assert.equal((await project(source)).mapping.measures["input-token-count"]!.status, "unavailable", variant);
  }
});

test("zero-filled usage and null inference counts remain unavailable", async () => {
  const source = fixture();
  for (const step of steps(source)) if (step.source === "agent") {
    (step.metrics as AtifObject).completion_tokens = 0;
  }
  (source.final_metrics as AtifObject).total_completion_tokens = 0;
  const result = (await project(source)).mapping;
  assert.deepEqual(result.measures["output-token-count"], { status: "unavailable", reason: "CONVERTER_ZERO_FILL_POSSIBLE" });
  steps(source).find((step) => step.source === "agent")!.llm_call_count = null;
  const unknownInference = (await project(source)).mapping;
  assert.equal(unknownInference.measures["declared-inference-count"]!.status, "unavailable");
  assert.deepEqual(unknownInference.measures["output-token-count"], { status: "unavailable", reason: "USAGE_COMPONENT_COMPLETENESS_UNPROVEN" });
});

test("compaction summaries and unbound embedded children do not become assistant behavior", async () => {
  const source = fixture("compaction"), result = await project(source);
  assert.ok(result.dataset.events.some(({ family }) => family === "context"));
  assert.equal(result.dataset.events.some((event) => event.family === "message" && event.source.nativeReference.recordLocator === "#/steps/2"), false);
  const parent = fixture(), child = fixture(); child.trajectory_id = "orphan";
  parent.subagent_trajectories = [child];
  const orphan = await project(parent);
  assert.equal(orphan.mapping.recorded.calls, 2);
  assert.ok((orphan.mapping.recorded.contextOnlyStepsExcluded ?? 0) > 0);
  assert.equal(orphan.dataset.events.some(({ source }) => source.nativeReference.recordLocator.startsWith("#/subagent_trajectories")), false);
});

test("hidden reasoning and reversible token arrays stay out of semantic evidence projections", () => {
  const record = { message: "visible", reasoning_content: "PRIVATE_REASONING", metrics: { prompt_token_ids: [8123, 8124], completion_token_ids: [9123] } };
  const projected = boundedEvidence(record, 10_000).content;
  assert.match(projected, /visible/u);
  assert.doesNotMatch(projected, /PRIVATE_REASONING|8123|9123/u);
});

test("exact call/result pointers validate behavior assertions with canonical value digests", async () => {
  const evidence = await project();
  const assertion = JSON.parse(readFileSync(join(root, "test/fixtures/behavior-assertions/positive.json"), "utf8")) as BehaviorAssertion;
  const event = evidence.dataset.events.find((event) => event.family === "tool")!;
  assertion.runId = evidence.dataset.runId; assertion.attemptId = evidence.dataset.attemptId;
  assertion.dataset.digest = hash(evidence.dataset);
  assertion.judgment.citations = [{ eventId: event.id, nativeReference: event.source.nativeReference }];
  assert.equal((await validateBehaviorAssertion(assertion, evidence.dataset, evidence.resolver)).length, 1);
  const wrong = structuredClone(assertion); wrong.judgment.citations[0]!.nativeReference.recordLocator += "/arguments";
  await assert.rejects(validateBehaviorAssertion(wrong, evidence.dataset, evidence.resolver), /does not match its native source/u);
});

test("actual admission is repeatable, restricted and dispatched through retained evidence and corpus", { skip: !python }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ebo-atif-admission-"));
  try {
    const options = { sourcePath: join(root, "test/fixtures/atif/pi/parallel-failure-cache-write.atif.json"), destination: join(directory, "import"), runId: "imported-run", attemptId: "one", producer, pythonExecutable: python };
    const imported = await importAtifFile(options);
    assert.equal(imported.reused, false);
    assert.deepEqual(validateArtifact("manifest", imported.manifest), []);
    assert.equal("run" in imported.manifest, false);
    assert.equal(imported.manifest.qualification, "imported");
    assert.equal((await importAtifFile(options)).reused, true);
    assert.deepEqual((await createRetainedBehaviorEvidence(options.destination)).dataset, imported.evidence.dataset);
    const index = buildCorpusIndex(directory);
    assert.equal(index[0]!.manifestKind, "import"); assert.equal(index[0]!.captureQualification, "imported");
    assert.deepEqual(index[0]!.issues, []);
    writeCorpusIndex(join(directory, "index.jsonl"), index);
    assert.deepEqual(readCorpusIndex(join(directory, "index.jsonl")), index);
    await assert.rejects(importAtifFile({ ...options, attemptId: "different" }), /another capture revision/u);
    writeFileSync(join(options.destination, "trajectory.json"), "{}");
    await assert.rejects(readImportedBehaviorEvidence(options.destination), /bytes differ/u);
    assert.ok(buildCorpusIndex(directory)[0]!.issues.length > 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("failed admission retains partial evidence without a manifest or upgraded capture", { skip: !python }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ebo-atif-rejected-"));
  try {
    const sourcePath = join(directory, "invalid.json"); writeFileSync(sourcePath, JSON.stringify({ schema_version: "ATIF-v1.7", steps: [] }));
    const destination = join(directory, "partial");
    await assert.rejects(importAtifFile({ sourcePath, destination, runId: "r", attemptId: "a", producer, pythonExecutable: python }), /admission failed/u);
    assert.equal(existsSync(join(destination, "trajectory.json")), true);
    assert.equal(existsSync(join(destination, "inspection.json")), true);
    assert.equal(existsSync(join(destination, "manifest.json")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("ATIF CLI lists profiles and requires explicit import identity and profile", async () => {
  const output: string[] = [];
  assert.equal(await main(["atif", "profiles"], (value) => output.push(value)), 0);
  assert.equal(JSON.parse(output.join(""))[0].producer.converter.packageVersion, "0.24.0");
  assert.equal(await main(["atif", "import", "x", "y"], () => {}), 1);
});


test("Pi zero-fill conventions cannot invent successful mutations or repeated empty inputs", async () => {
  const source = fixture();
  const calls = steps(source)[1]!.tool_calls as AtifObject[];
  calls[1]!.function_name = "edit"; calls[1]!.arguments = {};
  const evidence = await project(source);
  const result = evidence.dataset.events.find((event) => event.phase === "after" && event.attributes.nativeToolCallId === "call-b")!;
  assert.equal(result.attributes.producerIsError, false);
  assert.equal(result.attributes.isError, undefined);
  assert.equal(evidence.dataset.events.find((event) => event.phase === "before" && event.attributes.nativeToolCallId === "call-b")!.attributes.inputDigest, undefined);
  const observations = createStructuralObservationSet(evidence.dataset, evidence.coverage, evidence.outcomeCapture);
  assert.equal(observations.occurrences?.some(({ type }) => type === "source-change"), false);
});

test("Atlas pointer readback uses the same canonical value digest and preserves raw source identity", () => {
  const source = fixture(), bytes = Buffer.from(JSON.stringify(source, null, 2));
  const call = (steps(source)[1]!.tool_calls as AtifObject[])[0]!;
  const digest = nativeRecordDigest(bytes, "#/steps/1/tool_calls/0", "canonical-json-pointers/v1")!;
  assert.equal(`sha256:${digest.sha256}`, hash(call));
  assert.notEqual(digest.sha256, digest.source_sha256);
  assert.equal(nativeRecordDigest(bytes, "#/steps/01", "canonical-json-pointers/v1"), undefined);
  assert.equal(nativeRecordDigest(bytes, "#")!.source_sha256, undefined, "legacy whole-file digest semantics remain intact");
});

test("imported Atlas native records retain exact pointers and reject stale source bytes", { skip: !python }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ebo-atif-atlas-"));
  try {
    const destination = join(directory, "import");
    await importAtifFile({ sourcePath: join(root, "test/fixtures/atif/pi/parallel-failure-cache-write.atif.json"), destination,
      runId: "r", attemptId: "a", producer, pythonExecutable: python });
    const native = new NativeLines(destination, "restricted");
    const locator = "#/steps/1/tool_calls/0";
    assert.equal(native.locator(locator), locator);
    assert.equal(native.record("atif-trajectory", locator).resolved, true);
    assert.equal(`sha256:${native.record("atif-trajectory", locator).sha256}`, hash((steps(fixture())[1]!.tool_calls as AtifObject[])[0]));
    assert.equal(native.record("atif-trajectory", "#/steps/01").resolved, false);
    writeFileSync(join(destination, "trajectory.json"), "{}");
    assert.throws(() => new NativeLines(destination, "restricted").record("atif-trajectory", locator), /bytes differ/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("the Pi projection satisfies the adapter event contract under a synthetic test envelope", async () => {
  const evidence = await project(), profile = evidence.dataset.capabilityProfile;
  // This envelope exercises the existing contract checker only. Production admission stays imported.
  const synthetic = { ...evidence.capture, qualification: "qualified" as const };
  const adapter: HarnessAdapter<undefined, unknown> = {
    capture: { id: profile.adapterId, harness: profile.harness, capture: async () => synthetic },
    normalization: { id: profile.adapterId, harness: profile.harness, capabilityProfile: profile,
      normalize: async () => ({ events: evidence.dataset.events, unmapped: evidence.dataset.unmapped }) },
  };
  await assertAdapterContract(adapter, undefined, evidence.resolver);
  assert.equal(evidence.capture.qualification, "imported");
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
        called = true; assert.match(prompt, /third-party imported evidence with unproven capture completeness/u); assert.match(prompt, /CONVERTER_ZERO_FILL_POSSIBLE/u); assert.doesNotMatch(prompt, /provider\/Model\[route\]|Model\[route\]|served-model/u); assert.match(prompt, /visible/u);
        return { status: "failed", kind: "provider", message: "Synthetic backend; no model call", raw: {} };
      } } });
    assert.equal(called, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("multimodal messages retain text and references without fetching media", async () => {
  const source = fixture();
  steps(source)[0]!.message = [{ type: "text", text: "Visible multimodal instruction" },
    { type: "image", source: { media_type: "image/png", path: "not-admitted.png" } }];
  const evidence = await project(source);
  const user = evidence.dataset.events.find(({ family, attributes }) => family === "message" && attributes.role === "user")!;
  assert.ok(user);
  assert.equal(user.content.status, "known");
  if (user.content.status === "known") assert.deepEqual(nativeContentResolver(evidence.outcomeCapture)(user.content.value[0]!.nativeReference), steps(source)[0]!.message);
});

test("a positive sibling step cannot hide zero-filled output or cache usage", async () => {
  for (const field of ["completion_tokens", "cached_tokens"]) {
    const source = fixture();
    const agent = steps(source).filter((step) => step.source === "agent");
    (agent[1]!.metrics as AtifObject)[field] = 0;
    const total = agent.reduce((sum, step) => sum + Number((step.metrics as AtifObject)[field]), 0);
    (source.final_metrics as AtifObject)[field === "completion_tokens" ? "total_completion_tokens" : "total_cached_tokens"] = total;
    const evidence = await project(source);
    const measure = field === "completion_tokens" ? "output-token-count" : "cache-read-input-token-count";
    assert.deepEqual(evidence.mapping.measures[measure], { status: "unavailable", reason: "CONVERTER_ZERO_FILL_POSSIBLE" });
  }
});


test("occurrence rating state preserves pointed string output and non-shell argument objects", async () => {
  const source = fixture(), agent = steps(source)[1]!;
  const calls = agent.tool_calls as AtifObject[];
  calls[0]!.arguments = { command: "npm test" };
  calls[1]!.function_name = "read"; calls[1]!.arguments = { path: "src/example.ts" };
  ((agent.observation as AtifObject).results as AtifObject[])[0]!.content = "FAILURE_DIAGNOSTIC";
  steps(source).push({ step_id: 4, source: "agent", message: "Read again", llm_call_count: 1,
    tool_calls: [{ tool_call_id: "call-c", function_name: "read", arguments: { path: "src/example.ts" } }],
    observation: { results: [{ source_call_id: "call-c", content: "RETAINED_CONTENT", extra: { is_error: false } }] } });
  const evidence = await project(source), observations = createStructuralObservationSet(evidence.dataset, evidence.coverage, evidence.outcomeCapture);
  const map = new Map(evidence.dataset.events.map((event) => [event.id, event]));
  const resolve = nativeContentResolver(evidence.outcomeCapture);
  const validation = observations.occurrences!.find(({ type }) => type === "validation-run")!;
  const request = occurrenceRequest(validation, observations.occurrences!, map, resolve);
  assert.match(JSON.stringify(request.state), /FAILURE_DIAGNOSTIC/u);
  const repetition = observations.occurrences!.find(({ type }) => type === "repeated-operation")!;
  const rendered = occurrenceState(repetition, map, resolve).state;
  assert.match(JSON.stringify(rendered), /src\/example.ts/u);
  assert.match(JSON.stringify(rendered), /RETAINED_CONTENT/u);
});

test("assistant reports remain selected by the existing judge preparation policy", async () => {
  const evidence = await project(), observations = createStructuralObservationSet(evidence.dataset, evidence.coverage, evidence.outcomeCapture);
  const request = prepareJudgeRequest(observations, evidence.dataset.events, { schemaVersion: "ebo.judge-prepare-spec/v1", id: "p", behavior: { vocabularyVersion: "1.0.0", categoryId: "verification-completion", dimensionId: "verification-completion" },
    rubric: { id: "r", version: "1", instructions: "Inspect source behavior." }, evaluator: { provider: "anthropic", model: "synthetic-judge", effort: "low" },
    occurrenceTypes: ["validation-run", "failure-response"], blinding: { evaluatedModelIdentity: "redact" },
    limits: { maxEvidenceItems: 64, maxRecordChars: 8_000, maxInputChars: 200_000, maxOutputChars: 8_192, maxCitations: 8, maxWallClockMs: 5_000, maxTurns: 1 } });
  const reports = evidence.dataset.events.filter(({ family, actor }) => family === "message" && actor.kind === "model");
  assert.equal(reports.length, 2);
  assert.ok(reports.every(({ id }) => request.selection.eventIds.includes(id)));
});

test("per-step negative uncached input cannot be hidden by a positive sibling step", async () => {
  const source = fixture(), agents = steps(source).filter((step) => step.source === "agent");
  const tuples = [[22, 20, 3], [18, 10, 0]];
  agents.forEach((step, index) => { const [prompt, cache, write] = tuples[index]!;
    const metrics = step.metrics as AtifObject; metrics.prompt_tokens = prompt; metrics.cached_tokens = cache; (metrics.extra as AtifObject).cache_write_tokens = write; });
  const final = source.final_metrics as AtifObject; final.total_prompt_tokens = 40; final.total_cached_tokens = 30; (final.extra as AtifObject).cache_write_tokens = 3;
  assert.deepEqual((await project(source)).mapping.measures["input-token-count"], { status: "unavailable", reason: "PI_INCLUSIVE_PROMPT_CONFLICT" });
});

test("embedded child operations preserve declared session and trajectory scopes", async () => {
  const source = fixture(), child = fixture(); child.trajectory_id = "native-child-id";
  ((steps(source)[1]!.observation as AtifObject).results as AtifObject[])[0]!.subagent_trajectory_ref = [{ trajectory_id: "native-child-id" }];
  source.subagent_trajectories = [child];
  const evidence = await project(source), operations = toolOperations(evidence.dataset.events);
  assert.equal(operations.length, 4);
  assert.equal(new Set(operations.map(({ scope }) => scope)).size, 2);
  const childEvents = evidence.dataset.events.filter(({ source }) => source.nativeReference.recordLocator.startsWith("#/subagent_trajectories"));
  assert.ok(childEvents.every(({ attributes }) => attributes.agentId === "native-child-id" && attributes.sessionId === "synthetic-pi-fixture"));
  source.subagent_trajectories = [child, structuredClone(child)];
  const ambiguous = await project(source);
  assert.ok(ambiguous.mapping.limitations.includes("DUPLICATE_CHILD_TRAJECTORY_ID"));
  assert.equal(ambiguous.dataset.events.some(({ source }) => source.nativeReference.recordLocator.startsWith("#/subagent_trajectories")), false);
});


test("aggregated step usage cannot prove component completeness even when every total is positive", async () => {
  const source = fixture(); steps(source)[1]!.llm_call_count = 2;
  const evidence = await project(source);
  for (const id of ["input-token-count", "output-token-count", "cache-read-input-token-count"]) {
    assert.deepEqual(evidence.mapping.measures[id], { status: "unavailable", reason: "USAGE_COMPONENT_COMPLETENESS_UNPROVEN" });
  }
  assert.ok(evidence.mapping.limitations.includes("USAGE_COMPONENT_COMPLETENESS_UNPROVEN"));
});

test("coerced copied flags and ordinal fields are rejected before a Pi behavior projection", async () => {
  for (const value of ["true", 1, "false", 0]) {
    const source = fixture(); steps(source)[1]!.is_copied_context = value;
    await assert.rejects(project(source), /canonical flag and ordinal/u);
  }
  const source = fixture(); steps(source)[1]!.step_id = "2";
  await assert.rejects(project(source), /canonical flag and ordinal/u);
});

test("imported occurrence ratings preserve unknown repair history and never infer absent follow-ups", async () => {
  const source = fixture(), first = structuredClone(steps(source)[1]!);
  const call = structuredClone((first.tool_calls as AtifObject[])[0]!);
  call.function_name = "bash"; call.arguments = { command: "npm test" }; first.tool_calls = [call];
  const result = structuredClone(((first.observation as AtifObject).results as AtifObject[])[0]!);
  result.extra = { is_error: true }; first.observation = { results: [result] };
  const edit = structuredClone(first); edit.step_id = 3;
  edit.tool_calls = [{ ...call, tool_call_id: "edit-1", function_name: "edit", arguments: { path: "src/test.ts", content: "repair" } }];
  edit.observation = { results: [{ ...result, source_call_id: "edit-1", extra: { is_error: false } }] };
  const retry = structuredClone(first); retry.step_id = 4;
  retry.tool_calls = [{ ...call, tool_call_id: "retry-1" }];
  retry.observation = { results: [{ ...result, source_call_id: "retry-1", extra: { is_error: false } }] };
  source.steps = [steps(source)[0]!, first, edit, retry];
  const evidence = await project(source), observations = createStructuralObservationSet(evidence.dataset, evidence.coverage, evidence.outcomeCapture);
  assert.ok(observations.occurrenceCoverage!.every(({ status }) => status === "unavailable"));
  const response = observations.occurrences!.find(({ type }) => type === "failure-response")!;
  assert.ok(response);
  const request = occurrenceRequest(response, observations.occurrences!, new Map(evidence.dataset.events.map((event) => [event.id, event])), nativeContentResolver(evidence.outcomeCapture));
  assert.equal((request.state!.facts as AtifObject).sourceChangesBetween, "unknown");
  assert.deepEqual(request.rules, []); assert.equal((request.state!.sourceEvidence as AtifObject).completeness, "unproven");
  source.steps = [steps(source)[0]!, first];
  const partial = await project(source), partialObs = createStructuralObservationSet(partial.dataset, partial.coverage, partial.outcomeCapture);
  assert.equal(partialObs.occurrences!.some(({ type }) => type === "failure-response"), false);
});

test("parent and child may share declared IDs without sharing a document-local operation scope", async () => {
  const source = fixture(), child = fixture(); source.trajectory_id = "local-1"; child.trajectory_id = "local-1";
  ((steps(source)[1]!.observation as AtifObject).results as AtifObject[])[0]!.subagent_trajectory_ref = [{ trajectory_id: child.trajectory_id }];
  source.subagent_trajectories = [child];
  const evidence = await project(source);
  assert.equal(new Set(toolOperations(evidence.dataset.events).map(({ scope }) => scope)).size, 2);
  assert.ok(evidence.dataset.events.every(({ attributes }) => attributes.agentId === source.trajectory_id));
});

test("malformed empty native operation identities stay retained without invalid mapping signatures", async () => {
  for (const field of ["function_name", "tool_call_id"]) {
    const source = fixture(); (steps(source)[1]!.tool_calls as AtifObject[])[0]![field] = "";
    const evidence = await project(source);
    assert.ok(evidence.mapping.limitations.includes("MALFORMED_OPERATION_IDENTITY"));
    assert.deepEqual(validateArtifact("mapping", evidence.mapping), []);
    assert.equal(evidence.mapping.signatures.length, 1);
    assert.ok(evidence.dataset.unmapped.some(({ reference }) => reference.recordLocator === "#/steps/1/tool_calls/0"));
  }
});

test("embedded documents reconcile their own usage and preserve the root final report", async () => {
  const source = fixture(), child = fixture(); source.trajectory_id = "root"; child.trajectory_id = "child";
  const baseline = await project();
  ((steps(source)[1]!.observation as AtifObject).results as AtifObject[])[0]!.subagent_trajectory_ref = [{ trajectory_id: "child" }];
  source.subagent_trajectories = [child];
  const evidence = await project(source), observations = createStructuralObservationSet(evidence.dataset, evidence.coverage, evidence.outcomeCapture);
  for (const id of ["input-token-count", "output-token-count", "cache-read-input-token-count"]) {
    const expected = baseline.mapping.measures[id]!; assert.equal(expected.status, "known");
    if (expected.status === "known") assert.deepEqual(evidence.mapping.measures[id], { ...expected, value: expected.value * 2 });
  }
  const request = prepareJudgeRequest(observations, evidence.dataset.events, { schemaVersion: "ebo.judge-prepare-spec/v1", id: "p", behavior: { vocabularyVersion: "1.0.0", categoryId: "verification-completion", dimensionId: "verification-completion" },
    rubric: { id: "r", version: "1", instructions: "Inspect source behavior." }, evaluator: { provider: "anthropic", model: "synthetic-judge", effort: "low" }, occurrenceTypes: ["validation-run", "failure-response"], blinding: { evaluatedModelIdentity: "redact" },
    limits: { maxEvidenceItems: 64, maxRecordChars: 8_000, maxInputChars: 200_000, maxOutputChars: 8_192, maxCitations: 8, maxWallClockMs: 5_000, maxTurns: 1 } });
  const rootReports = evidence.dataset.events.filter(({ family, actor, attributes }) => family === "message" && actor.kind === "model" && attributes.documentScope === "#");
  assert.ok(rootReports.every(({ id }) => request.selection.eventIds.includes(id)));
  (child.final_metrics as AtifObject).total_completion_tokens = 999;
  assert.deepEqual((await project(source)).mapping.measures["output-token-count"], { status: "unavailable", reason: "STEP_FINAL_USAGE_CONFLICT" });
});


test("unregistered child conventions remain retained without applying Pi canonical coercion rules", async () => {
  const source = fixture(), child = fixture(); child.trajectory_id = "other-child";
  (child.agent as AtifObject).name = "unregistered-agent"; steps(child)[0]!.is_copied_context = null;
  ((steps(source)[1]!.observation as AtifObject).results as AtifObject[])[0]!.subagent_trajectory_ref = [{ trajectory_id: "other-child" }];
  source.subagent_trajectories = [child];
  const evidence = await project(source);
  assert.ok(evidence.mapping.limitations.includes("CHILD_PRODUCER_UNREGISTERED"));
  assert.ok(evidence.dataset.events.length > 0);
  assert.equal(evidence.dataset.events.some(({ attributes }) => String(attributes.documentScope).includes("subagent_trajectories")), false);
  assert.ok(evidence.dataset.unmapped.some(({ reference }) => reference.recordLocator === "#/subagent_trajectories/0"));
  (child.agent as AtifObject).name = "pi";
  await assert.rejects(project(source), /canonical flag/u);
});
