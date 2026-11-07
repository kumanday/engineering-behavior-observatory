import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectAtifBytes, type AtifObject } from "../src/atif-reader.js";
import { listAdditionalAtifProfilesV2, listAtifProfilesV2, selectAdditionalAtifProfileV2 } from "../src/atif-producers-v2.js";
import { listAtifProducerProfiles } from "../src/atif-profiles.js";
import { projectAtifV2, readImportedBehaviorEvidenceV2 } from "../src/atif-v2.js";
import { createStructuralObservationSetV2, analysisDigestV2 } from "../src/analysis-v2.js";
import { createOccurrenceLedgerV2 } from "../src/occurrences-v2.js";
import { buildAtlasViewV2 } from "../src/atlas-v2.js";
import { executionDurationMs, precedes, validateNormalizedDatasetV2 } from "../src/normalization-v2.js";
import { importAtifFile, readImportedBehaviorEvidence } from "../src/atif-import.js";
const profiles = listAdditionalAtifProfilesV2();
const fixtureRoot = new URL("../../test/fixtures/atif/producers/", import.meta.url);
const fixture = (family: string): AtifObject => JSON.parse(readFileSync(new URL(`${family}.atif.json`, fixtureRoot), "utf8"));
const steps = (source: AtifObject) => source.steps as AtifObject[];
async function project(family: string, edit?: (source: AtifObject) => void, fixtureName = family) {
  const source = fixture(fixtureName); edit?.(source);
  const read = inspectAtifBytes(Buffer.from(JSON.stringify(source)));
  assert.equal(read.inspection.versionPolicy.status, "supported");
  read.inspection.structural = { status: "valid", validator: "harbor", version: "0.24.0", diagnostics: [] };
  return projectAtifV2({ read, producer: profiles.find((p) => p.family === family)!.producer, runId: "r", attemptId: "a", manifestDigest: analysisDigestV2("authored-projection-fixture") });
}
async function measures(evidence: Awaited<ReturnType<typeof project>>) {
  return Object.fromEntries((await createStructuralObservationSetV2(evidence.dataset, evidence.resolver)).observations.map((o) => [o.measure, o.value]));
}

test("v2 provenance selection is closed and preserves the original Pi registry", async () => {
  assert.equal(listAtifProducerProfiles().length, 2); assert.equal(listAtifProfilesV2().length, 5);
  for (const profile of profiles) {
    assert.equal(selectAdditionalAtifProfileV2(profile.producer)!.profile.id, profile.id);
    for (const field of ["agent", "converter", "context"] as const) {
      const altered = structuredClone(profile.producer);
      if (field === "agent") altered.agent.version = "next";
      if (field === "converter") altered.converter.sourceDigest = analysisDigestV2("next");
      if (field === "context") altered.context.wrapperDigest = analysisDigestV2("next");
      assert.equal(selectAdditionalAtifProfileV2(altered), undefined);
    }
    assert.match(profile.nativeAuthority, /session|rollout/u);
    const evidence = await project(profile.family); await validateNormalizedDatasetV2(evidence.dataset, evidence.resolver);
    assert.equal(evidence.capture.qualification, "imported"); assert.equal(evidence.outcomeCapture.qualification, "imported");
    assert.equal(evidence.dataset.origin.kind, "imported"); assert.equal(evidence.dataset.sources[0]!.authority, "third-party");
    assert.equal(evidence.dataset.sources[0]!.producerProfile.status, "known");
  }
});

test("Codex preserves grouped inference and reports conversion loss for the native pending call", async () => {
  const evidence = await project("codex"), observed = await measures(evidence);
  const native = readFileSync(new URL("codex.native.jsonl", fixtureRoot), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(native.filter(({ payload }) => payload.type === "function_call").length, 3);
  assert.equal(evidence.dataset.operations.length, 2);
  assert.deepEqual(observed["source-attempt-tool-operation-count"], { status: "lower-bound", value: 2, reason: "CONVERTER_OMITS_PENDING_CALLS" });
  assert.ok(evidence.capture.qualification === "imported" && evidence.capture.sourceLimitations?.includes("CONVERTER_OMITS_PENDING_CALLS"));
  const [first, second] = evidence.dataset.operations;
  assert.deepEqual(first!.issuingInference, second!.issuingInference); assert.equal(first!.issuingInference.status, "known");
  assert.deepEqual(first!.startOrder, second!.startOrder);
  assert.equal(observed["declared-inference-count"]!.status, "known"); assert.equal(observed["native-request-count"]!.status, "unknown");
  assert.ok(evidence.dataset.events.some(({ clock }) => clock.status === "known" && clock.value.kind === "producer-observation" && clock.value.provenance === "converter-derived"));
  const event = evidence.dataset.events.find(({ clock }) => clock.status === "known")!;
  assert.equal(executionDurationMs(event, event).status, "unknown");
  assert.ok(evidence.dataset.operations.every(({ failure }) => failure.status === "unknown"));
});

test("Hermes keeps untracked inference and tool status unknown, including JSON-looking outputs", async () => {
  const evidence = await project("hermes"), observed = await measures(evidence);
  assert.equal(evidence.dataset.operations.length, 2); assert.equal(observed["declared-inference-count"]!.status, "unknown");
  assert.ok(evidence.dataset.operations.every(({ failure, issuingInference }) => failure.status === "unknown" && issuingInference.status === "unknown"));
  assert.ok(evidence.dataset.operations.every(({ identity }) => identity.identityClass === "converter-assigned"));
  assert.ok(evidence.dataset.events.every(({ clock }) => clock.status === "unknown"));
  assert.equal(evidence.dataset.events.some(({ content }) => content.status === "known" && content.value.some(({ nativeReference }) => evidence.resolver.read(nativeReference) === "[tool call]")), false);
});

test("OpenClaw distinguishes real compaction and nested-result failure from parent completion", async () => {
  const evidence = await project("openclaw"), observed = await measures(evidence);
  assert.deepEqual(observed["context-compaction-record-count"], { status: "known", value: 1 });
  assert.equal(observed["context-conversion-gap-record-count"]!.status, "unknown");
  const a = evidence.dataset.operations.find(({ identity }) => identity.nativeId === "call-a")!, b = evidence.dataset.operations.find(({ identity }) => identity.nativeId === "call-b")!;
  assert.deepEqual(a.failure, { status: "known", value: true }); assert.equal(b.failure.status, "unknown");
  assert.equal(b.resultEventIds.length, 1); assert.equal(b.observationEventIds!.length, 1);
  assert.deepEqual(observed["tool-error-count"], { status: "lower-bound", value: 1, reason: "OPERATION_FAILURE_UNREPORTED" });
  assert.equal(observed["declared-inference-count"]!.status, "unknown");
  const context = evidence.dataset.events.find(({ facts }) => facts.context)!;
  assert.equal(context.facts.context!.replacementBoundary.status, "unknown");
  assert.deepEqual(observed["source-context-reconstruction"], { status: "unsupported", reason: "CONTEXT_REPLACEMENT_BOUNDARIES_UNAVAILABLE" });
});

test("a producer-inserted OpenClaw gap never becomes a compaction or exact zero tools", async () => {
  const evidence = await project("openclaw", (source) => {
    source.extra = { partial: { source: "openclaw.txt", missing: ["tool_calls", "tool_results"] } };
    source.steps = [{ step_id: 1, source: "user", message: "Run checks." }, { step_id: 2, source: "system", message: "[COMPACTED HISTORY] Not recorded", extra: { added_by: "hlb", reason: "session not exported" } }];
  });
  const observed = await measures(evidence);
  assert.equal(evidence.dataset.operations.length, 0); assert.equal(observed["tool-operation-count"]!.status, "unknown");
  assert.equal(observed["source-attempt-tool-operation-count"]!.status, "unknown");
  assert.equal(observed["context-compaction-record-count"]!.status, "unknown");
  assert.deepEqual(observed["context-conversion-gap-record-count"], { status: "known", value: 1 });
});

test("pending, shared, unlinked, copied and duplicate identities never invent completed operations", async () => {
  for (const variant of ["pending", "shared", "unlinked", "copied", "duplicate"]) {
    const evidence = await project("codex", (source) => {
      const step = steps(source).find((s) => s.tool_calls)!;
      const observation = step.observation as { results: AtifObject[] };
      if (variant === "pending") observation.results[0]!.content = null;
      if (variant === "shared") observation.results.push(structuredClone(observation.results[0]!));
      if (variant === "unlinked") observation.results[0]!.source_call_id = "unknown";
      if (variant === "copied") step.is_copied_context = true;
      if (variant === "duplicate") steps(source).push({ ...structuredClone(step), step_id: 100 });
    });
    const first = evidence.dataset.operations.find(({ identity }) => identity.nativeId === "call-a");
    assert.equal(first?.resultEventIds.length ?? 0, 0, variant);
    if (first) assert.equal(first.failure.status, "unknown");
    assert.ok(evidence.dataset.recordCoverage.some(({ disposition }) => disposition === "retained-only"));
  }
});

test("unqualified child histories remain retained and usage populations stay separate", async () => {
  const evidence = await project("openclaw", (source) => {
    source.subagent_trajectories = [{ ...structuredClone(source), trajectory_id: "child" }];
  });
  assert.equal(evidence.dataset.operations.length, 2);
  assert.equal(evidence.dataset.events.some(({ source }) => source.nativeReference.recordLocator.startsWith("#/subagent_trajectories")), false);
  assert.ok(evidence.capture.qualification === "imported" && evidence.capture.sourceLimitations?.includes("CHILD_SCOPE_UNQUALIFIED"));
  const resources = evidence.dataset.events.flatMap(({ facts }) => facts.resource ? [facts.resource] : []);
  assert.ok(resources.some(({ scope }) => scope === "step")); assert.ok(resources.some(({ scope }) => scope === "session"));
  assert.ok(resources.every(({ authority, semantics }) => authority === "converter" && semantics === "unknown"));
  const view = await buildAtlasViewV2(evidence); assert.ok(view.units.length > 0);
  const ledger = await createOccurrenceLedgerV2(evidence.dataset, evidence.resolver); assert.ok(ledger.occurrences.length > 0);
});

test("malformed ordinals and inference counts are rejected instead of establishing order", async () => {
  for (const edit of [(source: AtifObject) => { steps(source)[1]!.step_id = steps(source)[0]!.step_id; },
    (source: AtifObject) => { steps(source).find((s) => s.source === "agent")!.llm_call_count = -1; }]) {
    await assert.rejects(project("codex", edit), /ordinals|inference/u);
  }
});

test("additional producer admission reopens offline with v1 retention and v2 typed dispatch", { skip: process.env.EBO_ATIF_TEST_PYTHON ? false : "Set EBO_ATIF_TEST_PYTHON for pinned Harbor admission" }, async () => {
  const { main } = await import("../src/cli.js");
  let listing = ""; assert.equal(await main(["atif", "profiles", "--v2"], (value) => { listing += value; }), 0);
  assert.equal(JSON.parse(listing).length, 5);
  const root = mkdtempSync(join(tmpdir(), "ebo-additional-producers-"));
  try {
    for (const profile of profiles) {
      const file = join(root, `${profile.family}.json`), bundle = join(root, profile.family);
      writeFileSync(file, JSON.stringify(fixture(profile.family)));
      const imported = await importAtifFile({ sourcePath: file, destination: bundle, runId: "r", attemptId: "a", producer: profile.producer, pythonExecutable: process.env.EBO_ATIF_TEST_PYTHON, modelAliases: ["synthetic-model"] });
      if (profile.family === "codex") {
        let output = ""; const cliBundle = join(root, "cli-import");
        assert.equal(await main(["atif", "import", file, cliBundle, "--run", "r", "--attempt", "a", "--profile", profile.id, "--python", process.env.EBO_ATIF_TEST_PYTHON!], (value) => { output += value; }), 0, output);
        assert.equal(await main(["v2", "inspect", cliBundle, join(root, "cli-view")], (value) => { output += value; }), 0, output);
      }
      assert.equal(imported.manifest.qualification, "imported"); assert.equal(imported.manifest.profile.status, "unsupported");
      const old = await readImportedBehaviorEvidence(bundle); assert.equal(old.dataset.events.length, 0);
      const v2 = await readImportedBehaviorEvidenceV2(bundle); assert.equal(v2.dataset.sources[0]!.executedHarness.id, profile.family);
      assert.ok(v2.modelAliases?.includes("synthetic-model")); assert.equal(v2.capture.qualification, "imported");
      assert.equal((await importAtifFile({ sourcePath: file, destination: bundle, runId: "r", attemptId: "a", producer: profile.producer, pythonExecutable: process.env.EBO_ATIF_TEST_PYTHON, modelAliases: ["synthetic-model"] })).reused, true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("folded results never invent a follow-up before the native failure arrived", async () => {
  // Independent conversion of call-a, call-b, failed-result-a, result-b folds results into issuing steps.
  const evidence = await project("openclaw", undefined, "openclaw-late-results");
  assert.ok(evidence.dataset.operations.every(({ endOrder }) => endOrder.status === "unknown"));
  const ledger = await createOccurrenceLedgerV2(evidence.dataset, evidence.resolver);
  assert.equal(ledger.occurrences.filter(({ type }) => type === "execution-follow-up").length, 0);
});

test("empty primary OpenClaw and Hermes responses retain completion and positive error evidence", async () => {
  for (const family of ["openclaw", "hermes"]) {
    const evidence = await project(family, undefined, `${family}-empty`);
    const call = evidence.dataset.operations.find(({ identity }) => identity.nativeId === "call-a")!;
    assert.equal(call.resultEventIds.length, 1, family);
    assert.equal(call.endOrder.status, "unknown", family);
    assert.equal(evidence.dataset.events.find(({ id }) => id === call.resultEventIds[0])!.content.status, "unknown", family);
    if (family === "openclaw") {
      assert.deepEqual(call.failure, { status: "known", value: true });
      assert.deepEqual((await measures(evidence))["tool-error-count"], { status: "lower-bound", value: 1, reason: "OPERATION_FAILURE_UNREPORTED" });
    } else assert.equal(call.failure.status, "unknown");
  }
});


test("Codex converted step order never reverses native calls and intervening user messages", async () => {
  const source = fixture("codex-interleaved"), sourceSteps = steps(source);
  assert.equal(sourceSteps[1]!.source, "user"); assert.ok(sourceSteps[2]!.tool_calls);
  const evidence = await project("codex", undefined, "codex-interleaved");
  const call = evidence.dataset.events.find(({ family, phase }) => family === "tool" && phase === "before")!;
  const message = evidence.dataset.events.find(({ source, family }) => family === "message" && source.nativeReference.recordLocator === "#/steps/1")!;
  assert.equal(precedes(call, message), "unknown");
  assert.ok(evidence.dataset.events.every(({ nativeOrder }) => nativeOrder.status === "unknown"));
  assert.equal(call.attributes.convertedStepId, 3);
});

test("Hermes missing-argument placeholders cannot establish identical native inputs", async () => {
  const evidence = await project("hermes", undefined, "hermes-missing-arguments");
  assert.ok(evidence.dataset.operations.every(({ inputDigest }) => inputDigest.status === "unknown"));
  assert.equal((await measures(evidence))["repeated-tool-operation-count"]!.status, "unknown");
  const ledger = await createOccurrenceLedgerV2(evidence.dataset, evidence.resolver);
  assert.equal(ledger.occurrences.filter(({ type }) => type === "repeated-operation").length, 0);
});


test("Codex raw custom and function inputs preserve distinctions lost from converted arguments", async () => {
  const source = fixture("codex-input-distinction");
  const calls = steps(source).flatMap((step) => (step.tool_calls as AtifObject[] | undefined) ?? []);
  assert.equal(new Set(calls.map((call) => JSON.stringify(call.arguments))).size, 1);
  const evidence = await project("codex", undefined, "codex-input-distinction");
  assert.ok(evidence.dataset.operations.every(({ inputDigest }) => inputDigest.status === "known"));
  assert.equal(new Set(evidence.dataset.operations.map(({ inputDigest }) => inputDigest.status === "known" ? inputDigest.value : null)).size, 4);
  assert.deepEqual((await measures(evidence))["repeated-tool-operation-count"], { status: "known", value: 0 });
  const inputs = evidence.dataset.events.flatMap(({ content }) => content.status === "known" ? content.value.filter(({ role }) => role === "tool-input").map(({ nativeReference }) => evidence.resolver.read(nativeReference)) : []);
  assert.ok(inputs.includes("echo hello")); assert.ok(inputs.includes('{"input":"echo hello"}'));
  const same = await project("codex", undefined, "codex-identical-input");
  assert.deepEqual((await measures(same))["repeated-tool-operation-count"], { status: "known", value: 1 });
});

test("missing Codex input provenance leaves signatures unknown", async () => {
  const evidence = await project("codex", (source) => {
    for (const step of steps(source)) if (step.tool_calls) delete step.extra;
  });
  assert.ok(evidence.dataset.operations.every(({ inputDigest }) => inputDigest.status === "unknown"));
  assert.equal((await measures(evidence))["repeated-tool-operation-count"]!.status, "unknown");
});

test("converter-assigned unknown tool names cannot establish equal tool signatures", async () => {
  for (const family of ["hermes", "openclaw"]) {
    const evidence = await project(family, undefined, `${family}-missing-names`);
    assert.equal(evidence.dataset.operations.length, 2);
    assert.ok(evidence.dataset.operations.every(({ toolName }) => toolName.status === "unknown"));
    assert.equal((await measures(evidence))["repeated-tool-operation-count"]!.status, "unknown");
    const ledger = await createOccurrenceLedgerV2(evidence.dataset, evidence.resolver);
    assert.equal(ledger.occurrences.filter(({ type }) => type === "repeated-operation").length, 0);
  }
});


test("blank tool names retain identified calls and linked result endpoints", async () => {
  const evidence = await project("hermes", undefined, "hermes-blank-names");
  assert.deepEqual(evidence.dataset.operations.map(({ identity }) => identity.nativeId).sort(), ["call-a", "call-b"]);
  assert.ok(evidence.dataset.operations.every(({ toolName, callEventIds, resultEventIds }) => toolName.status === "unknown" && callEventIds.length === 1 && resultEventIds.length === 1));
  const view = await buildAtlasViewV2(evidence);
  assert.equal(view.units.filter(({ kind }) => kind === "tool").length, 2);
  assert.equal((await measures(evidence))["repeated-tool-operation-count"]!.status, "unknown");
});
