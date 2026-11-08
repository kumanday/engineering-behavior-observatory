import { occurrenceRequest, occurrenceState } from "../src/occurrence-ratings.js";
import { prepareJudgeRequest } from "../src/judge-prepare.js";
import { runAgentSdkSemanticJudge, type SemanticJudgeRequest } from "../src/semantic-judge.js";
import { probeClaudeAgentSdkCapabilities } from "../src/agent-sdk.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
// Qualified overlay cases are authored documents with an explicit agent version. Frozen source fixtures stay unchanged.
const fixture = (name = "parallel-failure-cache-write"): AtifObject => {
  const source = JSON.parse(readFileSync(join(root, `test/fixtures/atif/pi/${name}.atif.json`), "utf8")) as AtifObject;
  (source.agent as AtifObject).version = "1.2.0";return source;
};
const hash = (value: unknown): `sha256:${string}` => `sha256:${digestMetadata(value).value}`;
const python = process.env.EBO_ATIF_TEST_PYTHON;
// Both projection and admission use EBO structural validation. Harbor is an optional cross-check.
async function project(document = fixture(), declaration = producer) {
  const read = inspectAtifBytes(Buffer.from(JSON.stringify(document)));
  return normalizePiAtif({ read, producer: declaration, runId: "import-test", attemptId: "a", manifestDigest: hash({ synthetic: true }) });
}
const steps = (document: AtifObject) => document.steps as AtifObject[];


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
    await assert.rejects(importAtifFile({ ...options, attemptId: "different" }), /another source or identity/u);
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

test("ATIF CLI lists optional overlays and requires an import identity", async () => {
  const output: string[] = [];
  assert.equal(await main(["atif", "profiles"], (value) => output.push(value)), 0);
  assert.equal(JSON.parse(output.join(""))[0].producer.converter.packageVersion, "0.24.0");
  assert.equal(await main(["atif", "import", "x", "y"], () => {}), 1);
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
    const imported = await importAtifFile({ sourcePath, destination: bundleRoot, runId: "r", attemptId: "a", producer: listAtifProducerProfiles()[0]!.producer, pythonExecutable: python, modelAliases: ["served-model"] });
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


test("core and optional Pi interpretation retain source pointers and sibling inference identity", async () => {
  const evidence = await project();
  assert.equal(evidence.capture.qualification, "imported");
  assert.equal(evidence.dataset.adapter.harness, "atif.generic");
  assert.deepEqual(validateArtifact("mapping", evidence.mapping), []);
  const calls = evidence.dataset.events.filter(({ family, phase }) => family === "tool" && phase === "before");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.nativeOrder, calls[1]!.nativeOrder);
  assert.equal(calls[0]!.attributes.inferenceId, calls[1]!.attributes.inferenceId);
  assert.equal(calls[0]!.attributes.isError, undefined, "failure cannot move onto an earlier call endpoint");
  assert.equal(calls[0]!.attributes.nativeToolCallId, "call-a");
  assert.equal(evidence.dataset.events.some(({ family }) => family === "model-request"), false);
});
test("unknown converter versions preserve generic content and document counts", async () => {
  const declaration = structuredClone(producer);declaration.converter.packageVersion = "9.9.9";
  const evidence = await project(fixture(), declaration);
  assert.ok(evidence.dataset.events.length > 0);
  assert.equal(evidence.mapping.recorded.calls, 2);
  assert.ok(evidence.mapping.limitations.includes("PRODUCER_VERSION_UNVERIFIED"));
  assert.equal(evidence.mapping.measures["tool-error-count"]!.status, "unavailable");
});
test("document metadata determines agent and schema identity instead of the operator example", async () => {
  const source = fixture();(source.agent as AtifObject).version = "9.9.9";
  const evidence = await project(source);
  assert.ok(evidence.dataset.events.some(({ family }) => family === "message"));
  assert.ok(evidence.mapping.limitations.includes("PRODUCER_VERSION_UNVERIFIED"));
});
test("copied context is retained without adding new operations, while partial markers keep recorded counts", async () => {
  const source = fixture();steps(source)[1]!.is_copied_context = true;
  const copied = await project(source);
  assert.equal(toolOperations(copied.dataset.events).length, 0);
  assert.equal(copied.mapping.recorded.copiedStepsExcluded, 1);
  delete steps(source)[1]!.is_copied_context;source.extra = { partial: { missing: ["tool"] } };
  const partial = await project(source);
  assert.equal(partial.mapping.recorded.calls, 2);
  assert.ok(partial.mapping.limitations.includes("PRODUCER_PARTIAL_HISTORY"));
});
test("reused call IDs in different steps retain separate operation scopes", async () => {
  const source = fixture();steps(source).push({ ...structuredClone(steps(source)[1]!), step_id: 4 });
  const evidence = await project(source), operations = toolOperations(evidence.dataset.events);
  assert.equal(operations.length, 4);
  assert.equal(new Set(operations.map(({ id }) => id)).size, 4);
  assert.equal(evidence.mapping.recorded.calls, 4);
});
test("Pi cache interpretation requires components, reconciled totals and nonnegative per-step input", async () => {
  assert.deepEqual((await project()).mapping.measures["input-token-count"], { status: "known", value: 18, unit: "tokens" });
  for (const variant of ["missing-write", "final-write-conflict", "final-prompt-conflict", "negative-input"]) {
    const source = fixture(), metrics = steps(source)[1]!.metrics as AtifObject;
    if (variant === "missing-write") delete (metrics.extra as AtifObject).cache_write_tokens;
    if (variant === "final-write-conflict") ((source.final_metrics as AtifObject).extra as AtifObject).cache_write_tokens = 999;
    if (variant === "final-prompt-conflict") (source.final_metrics as AtifObject).total_prompt_tokens = 999;
    if (variant === "negative-input") metrics.cached_tokens = 999;
    assert.equal((await project(source)).mapping.measures["input-token-count"]!.status, "unavailable", variant);
  }
});
test("zero-filled and aggregated usage cannot establish Pi component totals", async () => {
  for (const variant of ["zero-output", "zero-cache", "aggregated", "unknown-inference"]) {
    const source = fixture(), step = steps(source)[1]!;
    if (variant === "zero-output") (step.metrics as AtifObject).completion_tokens = 0;
    if (variant === "zero-cache") (step.metrics as AtifObject).cached_tokens = 0;
    if (variant === "aggregated") step.llm_call_count = 2;
    if (variant === "unknown-inference") step.llm_call_count = null;
    const evidence = await project(source);
    const id = variant === "zero-cache" ? "cache-read-input-token-count" : "output-token-count";
    assert.equal(evidence.mapping.measures[id]!.status, "unavailable", variant);
  }
});
test("Pi context extensions add interpretation while preserving the standard message", async () => {
  const evidence = await project(fixture("compaction"));
  assert.ok(evidence.dataset.events.some(({ family }) => family === "context"));
  assert.ok(evidence.dataset.events.some(({ family, source }) => family === "message" && source.nativeReference.recordLocator === "#/steps/2"));
});
test("embedded documents with different producers retain independent core events and measures", async () => {
  const source = fixture(), child = fixture();child.trajectory_id = "child";(child.agent as AtifObject).version = "9.9.9";
  source.subagent_trajectories = [child];
  const evidence = await project(source);
  assert.ok(evidence.dataset.events.some(({ source }) => source.nativeReference.recordLocator.startsWith("#/subagent_trajectories")));
  assert.equal(evidence.mapping.recorded.calls, 2, "the compatibility summary describes the root document");
  assert.ok(evidence.mapping.measurements.some(({ scope, id, value }) => scope.id.includes("/subagent_trajectories/0") && id === "source-tool-operation-count" && value.status === "known" && value.value === 2));
});
test("malformed flags and ordinals receive a format diagnostic without any producer lookup", async () => {
  for (const field of ["is_copied_context", "step_id", "llm_call_count"]) {
    const source = fixture();steps(source)[1]![field] = "not-a-native-number-or-boolean";
    await assert.rejects(project(source), /malformed or unsupported format/u, field);
  }
});
test("imported document measurements do not become complete-attempt structural results", async () => {
  const evidence = await project(), observations = createStructuralObservationSet(evidence.dataset, evidence.coverage, evidence.outcomeCapture);
  assert.ok(observations.observations.filter(({ extractor }) => !extractor.id.startsWith("outcome-")).every(({ value }) => value.status === "unavailable"));
  assert.ok(evidence.mapping.measurements.every(({ scope }) => scope.kind === "recorded-document"));
});

test("mapping diagnostics represent unknown identities and fractional declared cost without fabricated values", async () => {
  const source = fixture();
  const step = (source.steps as AtifObject[])[1]!;
  (step.tool_calls as AtifObject[])[0]!.function_name = "";
  (step.tool_calls as AtifObject[])[1]!.tool_call_id = "";
  source.final_metrics = { total_cost_usd: 0.125 };
  const evidence = await normalizePiAtif({ read: inspectAtifBytes(Buffer.from(JSON.stringify(source))), runId: "r", attemptId: "a", manifestDigest: hash("mapping") });
  assert.deepEqual(validateArtifact("mapping", evidence.mapping), []);
  assert.ok(evidence.mapping.signatures.some(({ name }) => name === null));
  assert.ok(evidence.mapping.signatures.some(({ id, identityClass }) => id === null && identityClass === "ebo-derived"));
});
