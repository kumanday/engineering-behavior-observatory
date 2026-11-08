import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectAtifBytes, type AtifObject } from "../src/atif-reader.js";
import { listAtifProfilesV2 } from "../src/atif-producers-v2.js";
import { projectAtifV2, readImportedBehaviorEvidenceV2 } from "../src/atif-v2.js";
import { createStructuralObservationSetV2, analysisDigestV2 } from "../src/analysis-v2.js";
import { createOccurrenceLedgerV2 } from "../src/occurrences-v2.js";
import { buildAtlasViewV2 } from "../src/atlas-v2.js";
import { executionDurationMs, precedes, validateNormalizedDatasetV2 } from "../src/normalization-v2.js";
import { importAtifFile, readImportedBehaviorEvidence } from "../src/atif-import.js";
const fixtureRoot = new URL("../../test/fixtures/atif/producers/", import.meta.url);
const fixture = (name: string): AtifObject => JSON.parse(readFileSync(new URL(`${name}.atif.json`, fixtureRoot), "utf8"));
const steps = (source: AtifObject) => source.steps as AtifObject[];
async function project(family: string, edit?: (source: AtifObject) => void, name = family) {
  const source = fixture(name); edit?.(source);
  const read = inspectAtifBytes(Buffer.from(JSON.stringify(source)));
  return projectAtifV2({ read, ...(family === "codex" ? { producer: listAtifProfilesV2().find((p) => p.family === family)!.producer } : {}),
    runId: "r", attemptId: "a", manifestDigest: analysisDigestV2("authored-projection-fixture") });
}
async function measures(evidence: Awaited<ReturnType<typeof project>>) {
  return Object.fromEntries((await createStructuralObservationSetV2(evidence.dataset, evidence.resolver)).observations.map((o) => [o.measure, o.value]));
}

test("only Pi and Codex have optional overlays; other producer fixtures use core in both readers", async () => {
  assert.deepEqual(listAtifProfilesV2().map(({ family }) => family).sort(), ["codex", "pi"]);
  const root = mkdtempSync(join(tmpdir(), "ebo-generic-producers-"));
  try {
    for (const family of ["codex", "hermes", "openclaw"]) {
      const sourcePath = join(root, `${family}.json`), destination = join(root, family);
      writeFileSync(sourcePath, JSON.stringify(fixture(family)));
      const admitted = await importAtifFile({ sourcePath, destination, runId: "r", attemptId: family });
      assert.equal(admitted.manifest.schemaVersion, "ebo.import-manifest/v2");
      assert.equal(admitted.manifest.qualification, "imported");
      const old = await readImportedBehaviorEvidence(destination), evidence = await readImportedBehaviorEvidenceV2(destination);
      assert.ok(old.dataset.events.length > 0); assert.ok(evidence.dataset.operations.length > 0);
      assert.equal(evidence.dataset.sources[0]!.producerProfile.status, "unknown");
      assert.equal(evidence.dataset.sources[0]!.authority, "third-party");
      await validateNormalizedDatasetV2(evidence.dataset, evidence.resolver);
      assert.ok((await buildAtlasViewV2(evidence)).units.length > 0);
      assert.ok((await measures(evidence))["source-tool-operation-count"]);
      assert.equal((await importAtifFile({ sourcePath, destination, runId: "r", attemptId: family })).reused, true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex conversion limits preserve recorded counts without claiming the omitted native pending call", async () => {
  const evidence = await project("codex"), observed = await measures(evidence);
  const native = readFileSync(new URL("codex.native.jsonl", fixtureRoot), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(native.filter(({ payload }) => payload.type === "function_call").length, 3);
  assert.equal(evidence.dataset.operations.length, 2);
  assert.deepEqual(observed["source-tool-operation-count"], { status: "known", value: 2 });
  assert.equal(observed["source-attempt-tool-operation-count"], undefined);
  assert.ok(evidence.capture.qualification === "imported" && evidence.capture.sourceLimitations?.includes("CONVERTER_OMITS_PENDING_CALLS"));
  assert.deepEqual(evidence.dataset.operations[0]!.issuingInference, evidence.dataset.operations[1]!.issuingInference);
  assert.equal(evidence.dataset.operations[0]!.issuingInference.status, "known");
  assert.equal(observed["native-request-count"]!.status, "unknown");
  const event = evidence.dataset.events.find(({ clock }) => clock.status === "known")!;
  assert.ok(event.clock.status === "known" && event.clock.value.provenance === "converter-derived");
  assert.equal(executionDurationMs(event, event).status, "unknown");
});

test("generic Hermes semantics retain source-declared identities and unknown inference and failure", async () => {
  const evidence = await project("hermes"), observed = await measures(evidence);
  assert.equal(evidence.dataset.operations.length, 2); assert.equal(observed["declared-inference-count"]!.status, "unknown");
  assert.ok(evidence.dataset.operations.every(({ failure, identity }) => failure.status === "unknown" && identity.identityClass === "source-declared"));
});

test("generic OpenClaw extensions and literal history markers do not establish failures or compaction", async () => {
  for (const edit of [undefined, (source: AtifObject) => {
    source.extra = { partial: { missing: ["tool_calls", "tool_results"] } };
    source.steps = [{ step_id: 1, source: "user", message: "Run checks." }, { step_id: 2, source: "system", message: "[COMPACTED HISTORY] Not recorded", extra: { added_by: "hlb" } }];
  }]) {
    const evidence = await project("openclaw", edit), observed = await measures(evidence);
    assert.ok(evidence.dataset.operations.every(({ failure }) => failure.status === "unknown"));
    assert.equal(observed["context-compaction-record-count"]!.status, "unknown");
    assert.equal(observed["context-conversion-gap-record-count"]!.status, "unknown");
    assert.ok(evidence.dataset.measurements.every(({ scope }) => scope.kind === "recorded-document"));
    if (edit) assert.equal(observed["source-tool-operation-count"]!.status, "unknown");
  }
});

test("pending, unlinked, copied and duplicate result records preserve their actual endpoint populations", async () => {
  const pending = await project("codex", (source) => { ((steps(source)[1]!.observation as AtifObject).results as unknown[]).splice(0, 1); });
  assert.equal(pending.dataset.operations.find(({ identity }) => identity.nativeId === "call-a")!.resultEventIds.length, 0);
  const unlinked = await project("codex", (source) => { ((steps(source)[1]!.observation as AtifObject).results as AtifObject[])[0]!.source_call_id = "orphan"; });
  assert.ok(unlinked.dataset.operations.some(({ callEventIds, resultEventIds }) => callEventIds.length === 0 && resultEventIds.length === 1));
  const copied = await project("codex", (source) => { steps(source)[1]!.is_copied_context = true; });
  assert.equal(copied.dataset.operations.length, 0);
  const shared = await project("codex", (source) => { const results = (steps(source)[1]!.observation as AtifObject).results as AtifObject[]; results.push(structuredClone(results[0]!)); });
  assert.equal(shared.dataset.operations.find(({ identity }) => identity.nativeId === "call-a")!.resultEventIds.length, 2);
});

test("embedded histories project independently with no attempt-level sum", async () => {
  const evidence = await project("openclaw", (source) => { source.subagent_trajectories = [{ ...structuredClone(source), session_id: "child", agent: { name: "acme-agent", version: "9.9.9" } }]; });
  assert.equal(evidence.dataset.sources.length, 2); assert.equal(evidence.dataset.operations.length, 4);
  assert.ok(evidence.dataset.events.some(({ source }) => source.nativeReference.recordLocator.startsWith("#/subagent_trajectories")));
  const counts = (await createStructuralObservationSetV2(evidence.dataset, evidence.resolver)).observations.filter(({ measure }) => measure === "source-tool-operation-count");
  assert.equal(counts.length, 2); assert.ok(counts.every(({ scope, value }) => scope.kind === "recorded-document" && value.status === "known" && value.value === 2));
});

test("malformed ordinals and inference counts produce structural diagnostics", async () => {
  for (const edit of [(source: AtifObject) => { steps(source)[1]!.step_id = 1; }, (source: AtifObject) => { steps(source)[1]!.llm_call_count = -1; }])
    await assert.rejects(project("codex", edit), /ATIF_STEP_ID_INVALID|ATIF_FIELD_TYPE/u);
});

test("folded results do not establish execution follow-up order", async () => {
  const evidence = await project("openclaw", undefined, "openclaw-late-results");
  assert.ok(evidence.dataset.operations.every(({ endOrder }) => endOrder.status === "unknown"));
  assert.equal((await createOccurrenceLedgerV2(evidence.dataset, evidence.resolver)).occurrences.some(({ type }) => type === "execution-follow-up"), false);
});

test("empty responses retain result endpoints without inventing successful or failed status", async () => {
  for (const family of ["openclaw", "hermes", "codex"]) {
    const evidence = await project(family, undefined, `${family}-${family === "codex" ? "empty-response" : "empty"}`);
    assert.ok(evidence.dataset.operations.every(({ resultEventIds, endOrder, failure }) => resultEventIds.length >= 1 && endOrder.status === "unknown" && failure.status === "unknown"));
  }
});

test("Codex converted order cannot establish native call versus intervening user order", async () => {
  const evidence = await project("codex", undefined, "codex-interleaved");
  const call = evidence.dataset.events.find(({ family, phase }) => family === "tool" && phase === "before")!;
  const message = evidence.dataset.events.find(({ source, family }) => family === "message" && source.nativeReference.recordLocator === "#/steps/1")!;
  assert.equal(precedes(call, message), "unknown");
  assert.ok(evidence.dataset.events.every(({ nativeOrder }) => nativeOrder.status === "unknown"));
});

test("Codex raw custom and function inputs preserve distinctions lost from converted arguments", async () => {
  const evidence = await project("codex", undefined, "codex-input-distinction");
  assert.ok(evidence.dataset.operations.every(({ inputDigest }) => inputDigest.status === "known"));
  assert.equal(new Set(evidence.dataset.operations.map(({ inputDigest }) => inputDigest.status === "known" ? inputDigest.value : null)).size, 4);
  assert.deepEqual((await measures(evidence))["repeated-tool-operation-count"], { status: "known", value: 0 });
  const inputs = evidence.dataset.events.flatMap(({ content }) => content.status === "known" ? content.value.filter(({ role }) => role === "tool-input").map(({ nativeReference }) => evidence.resolver.read(nativeReference)) : []);
  assert.ok(inputs.includes("echo hello")); assert.ok(inputs.includes('{"input":"echo hello"}'));
  assert.deepEqual((await measures(await project("codex", undefined, "codex-identical-input")))["repeated-tool-operation-count"], { status: "known", value: 1 });
});

test("missing Codex original input provenance qualifies signatures without erasing calls", async () => {
  const evidence = await project("codex", (source) => { for (const step of steps(source)) if (step.tool_calls) delete step.extra; });
  assert.equal(evidence.dataset.operations.length, 2);
  assert.ok(evidence.dataset.operations.every(({ inputDigest }) => inputDigest.status === "unknown"));
  assert.equal((await measures(evidence))["repeated-tool-operation-count"]!.status, "unknown");
});

test("generic blank tool names retain linked endpoints and unknown signatures", async () => {
  const evidence = await project("hermes", undefined, "hermes-blank-names");
  assert.deepEqual(evidence.dataset.operations.map(({ identity }) => identity.nativeId).sort(), ["call-a", "call-b"]);
  assert.ok(evidence.dataset.operations.every(({ toolName, callEventIds, resultEventIds }) => toolName.status === "unknown" && callEventIds.length === 1 && resultEventIds.length === 1));
  assert.equal((await measures(evidence))["repeated-tool-operation-count"]!.status, "unknown");
});

test("Codex split groups preserve standard declared counts and separately qualify converter group count", async () => {
  const evidence = await project("codex", undefined, "codex-split-inference"), observed = await measures(evidence);
  assert.deepEqual(observed["declared-inference-count"], { status: "known", value: 2 });
  assert.deepEqual(observed["codex-converter-inference-group-count"], { status: "known", value: 1 });
  assert.deepEqual(evidence.dataset.operations[0]!.issuingInference, evidence.dataset.operations[1]!.issuingInference);
  const conflict = await project("codex", (source) => { steps(source).filter((step) => step.source === "agent")[1]!.llm_call_count = 2; }, "codex-split-inference");
  assert.equal((await measures(conflict))["codex-converter-inference-group-count"]!.status, "unknown");
});

test("explicit zero-dollar source cost is retained without zero-filling token fields", async () => {
  const evidence = await project("codex", undefined, "codex-zero-cost"), observed = await measures(evidence);
  assert.deepEqual(observed["source-final-total_cost_usd"], { status: "known", value: 0 });
  assert.equal(evidence.dataset.events.some(({ facts }) => facts.resource?.values.cached_tokens === 0 || facts.resource?.values.total_cached_tokens === 0), false);
});

test("the compatibility view uses the same qualified Codex order and original input references", async () => {
  const { normalizeAtif } = await import("../src/atif-normalizer.js");
  const source = fixture("codex-input-distinction"), read = inspectAtifBytes(Buffer.from(JSON.stringify(source)));
  const evidence = await normalizeAtif({ read, producer: listAtifProfilesV2().find(({ family }) => family === "codex")!.producer,
    runId: "r", attemptId: "a", manifestDigest: analysisDigestV2("legacy-bridge") });
  assert.ok(evidence.dataset.events.every(({ nativeOrder }) => nativeOrder.status === "unknown"));
  const resolve = (await import("../src/structural-observations.js")).nativeContentResolver(evidence.outcomeCapture);
  const inputs = evidence.dataset.events.flatMap(({ content }) => content.status === "known" ? content.value.filter(({ role }) => role === "tool-input").map(({ nativeReference }) => resolve(nativeReference)) : []);
  assert.ok(inputs.includes("echo hello"));
});
