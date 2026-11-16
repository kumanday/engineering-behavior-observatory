import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { compareFixtureMeasurement, compareFixtureSignatures } from "./atif-fixture-gate.js";
import { describeAndValidatePiDataset, qualifyRetainedPiCapture, type PiNativeRecord } from "../src/pi.js";
import { createStructuralObservationSet, toolOperations } from "../src/structural-observations.js";

async function nativeFixture(name: string) {
  const records = readFileSync(resolve(`test/fixtures/atif/pi/${name}.native.jsonl`), "utf8").trim().split("\n")
    .map((line, index) => ({ reference: { artifactId: "pi-session", recordLocator: `line:${index + 1}` }, record: JSON.parse(line) as PiNativeRecord }));
  let sequence = 0;
  const stream = (nativeType: string, payload: Record<string, unknown>, receivedAt: string) => {
    sequence += 1;
    records.push({ reference: { artifactId: "pi-events", recordLocator: `line:${sequence}` }, record: {
      schemaVersion: "ebo.pi-native-record/v1", channel: "stream", nativeType, sequence, receivedAt,
      sessionId: "synthetic-pi-fixture", payload,
    } });
  };
  for (const { record } of [...records]) {
    const message = record.message as { role?: string; content?: Array<Record<string, unknown>>; toolCallId?: string; toolName?: string; isError?: boolean } | undefined;
    if (message?.role === "assistant") for (const call of message.content ?? []) if (call.type === "toolCall") {
      stream("tool_execution_start", { toolCallId: call.id, toolName: call.name, args: call.arguments }, String(record.timestamp));
    }
    if (message?.role === "toolResult") stream("tool_execution_end", { toolCallId: message.toolCallId, toolName: message.toolName,
      isError: message.isError, result: { content: message.content } }, String(record.timestamp));
  }
  // A test envelope exercises adapter semantics; it is not retained-bundle admission or an imported qualification.
  const capture = qualifyRetainedPiCapture({ runId: "fixture", attemptId: name, qualification: "qualified", records }, "synthetic-pi-fixture", false);
  const { dataset, coverage } = await describeAndValidatePiDataset(capture);
  return { measures: Object.fromEntries(createStructuralObservationSet(dataset, coverage).observations.map((value) => [value.extractor.id, value.value])),
    signatures: toolOperations(dataset.events).map((operation) => ({ id: String(operation.events.map(({ attributes }) => attributes.toolCallId)
      .find((value) => typeof value === "string")), name: operation.toolName!, failed: operation.failed })).sort((a, b) => a.id.localeCompare(b.id)) };
}

test("independent branch conversion declares loss of historical operations from the active path", async () => {
  const { piFixtureSourceMeasures } = await import(pathToFileURL(resolve("scripts/atif-fixture-summary.mjs")).href);
  const native = await nativeFixture("branched-active-selection");
  const converted = piFixtureSourceMeasures(JSON.parse(readFileSync(resolve("test/fixtures/atif/pi/branched-active-selection.atif.json"), "utf8")));
  assert.deepEqual(native.signatures.map(({ id }) => id), ["call-a", "call-b"]);
  assert.deepEqual(converted.signatures, []);
  assert.equal(compareFixtureMeasurement(native.measures["tool-operation-count"]!, converted.measures["tool-operation-count"]).reason, "KNOWN_DIFFERENT");
  assert.equal(compareFixtureSignatures(native.signatures, converted.signatures).gate.reason, "OPERATION_IDENTITY_DIFFERENT");
  const fullAttempt = { status: "unavailable" as const, reason: "SELECTED_BRANCH_ONLY" };
  assert.equal(compareFixtureMeasurement(native.measures["tool-operation-count"]!, fullAttempt, { allowedLossReasons: [fullAttempt.reason] }).reason, "DECLARED_SOURCE_LOSS");
});

test("timeout-interrupted Pi history keeps a pending status unavailable and retains its call identity", async () => {
  const { piFixtureSourceMeasures } = await import(pathToFileURL(resolve("scripts/atif-fixture-summary.mjs")).href);
  const native = await nativeFixture("interrupted-pending");
  const converted = piFixtureSourceMeasures(JSON.parse(readFileSync(resolve("test/fixtures/atif/pi/interrupted-pending.atif.json"), "utf8")));
  const context = JSON.parse(readFileSync(resolve("test/fixtures/atif/pi/interrupted-pending.context.json"), "utf8"));
  assert.equal(context.termination, "timeout");
  assert.equal(context.history, "partial");
  assert.equal(converted.signatures.find((value: { id: string }) => value.id === "call-b").failed, null);
  assert.equal(compareFixtureSignatures(native.signatures, converted.signatures, ["TOOL_RESULT_STATUS_INCOMPLETE"]).gate.reason, "OPERATION_STATUS_DECLARED_LOSS");
  assert.equal(converted.measures["tool-error-count"].status, "unavailable");
  assert.equal(converted.summary.complete, false);
});

test("linked continuation fixtures count new calls once and preserve missing segment coverage", async () => {
  const { summarizeFixtureSequence } = await import(pathToFileURL(resolve("scripts/atif-fixture-summary.mjs")).href);
  const segments = ["segment-1.json", "segment-2.json"].map((path) => ({ path,
    document: JSON.parse(readFileSync(resolve("test/fixtures/atif/continuation", path), "utf8")) }));
  const complete = summarizeFixtureSequence(segments, segments[0]!.path);
  assert.equal(complete.retainedSegments, 2);
  assert.equal(complete.recordedNewCalls, 2);
  assert.deepEqual(complete.signatures.map(({ id }: { id: string }) => id), ["first", "second"]);
  assert.deepEqual(complete.limitations, []);
  const missing = summarizeFixtureSequence(segments.slice(0, 1), segments[0]!.path);
  assert.equal(missing.recordedNewCalls, 1);
  assert.equal(missing.fullAttemptToolCount, null);
  assert.deepEqual(missing.limitations, ["CONTINUATION_REFERENCE_UNAVAILABLE"]);
});

test("ATIF-only conformance fixtures assert copied, partial, summarizer and delegated-child summaries", async () => {
  const { summarizeAtifFixture } = await import(pathToFileURL(resolve("scripts/atif-fixture-summary.mjs")).href);
  const cases = JSON.parse(readFileSync(resolve("test/fixtures/atif/conformance-cases.json"), "utf8"));
  assert.equal(cases.length, 10);
  for (const fixture of cases) {
    const { summary } = summarizeAtifFixture(fixture.trajectory);
    for (const [key, expected] of Object.entries(fixture.expected)) assert.deepEqual(summary[key], expected, `${fixture.id}: ${key}`);
  }
});

test("equivalence gates distinguish equality, explained loss and unsupported availability upgrades", () => {
  const known = { status: "known" as const, value: 3, unit: "operations" };
  const missing = { status: "unavailable" as const, reason: "PENDING_CALL_NOT_EXPORTED" };
  assert.deepEqual(compareFixtureMeasurement(known, { ...known }), { status: "pass", reason: "KNOWN_EQUAL" });
  assert.equal(compareFixtureMeasurement(known, { ...known, value: 2 }).status, "fail");
  assert.equal(compareFixtureMeasurement(known, { ...known, unit: "requests" }).status, "fail");
  assert.equal(compareFixtureMeasurement(known, missing).reason, "UNDECLARED_SOURCE_LOSS");
  assert.equal(compareFixtureMeasurement(known, missing, { allowedLossReasons: [missing.reason] }).status, "pass");
  assert.equal(compareFixtureMeasurement(missing, known).reason, "UNSUPPORTED_AVAILABILITY_UPGRADE");
  assert.equal(compareFixtureMeasurement(missing, known, { extraEvidenceReason: "BOUND_NATIVE_COMPANION" }).status, "pass");
  assert.equal(compareFixtureMeasurement(missing, missing).reason, "BOTH_UNAVAILABLE");
});

test("signature gates retain strict identity while declaring missing result status separately", () => {
  const native = [{ id: "a", name: "bash", failed: false }];
  const pending = [{ id: "a", name: "bash", failed: null }];
  assert.equal(compareFixtureSignatures(native, pending).gate.status, "fail");
  assert.equal(compareFixtureSignatures(native, pending, ["TOOL_RESULT_STATUS_INCOMPLETE"]).gate.status, "pass");
  assert.equal(compareFixtureSignatures(native, [{ ...pending[0]!, id: "b" }], ["TOOL_RESULT_STATUS_INCOMPLETE"]).gate.status, "fail");
  assert.equal(compareFixtureSignatures(native, [{ ...pending[0]!, name: "other" }], ["TOOL_RESULT_STATUS_INCOMPLETE"]).gate.status, "fail");
  assert.equal(compareFixtureSignatures(native, [{ ...native[0]!, failed: true }]).gate.status, "fail");
  assert.equal(pending[0]!.failed, null);
});

test("source audit withholds copied-only partial histories and contradictory cache-write totals", async () => {
  const { piFixtureSourceMeasures } = await import(pathToFileURL(resolve("scripts/atif-fixture-summary.mjs")).href);
  const source = JSON.parse(readFileSync(resolve("test/fixtures/atif/pi/parallel-failure-cache-write.atif.json"), "utf8"));
  source.final_metrics.extra.cache_write_tokens += 10;
  assert.deepEqual(piFixtureSourceMeasures(source).measures["input-token-count"], { status: "unavailable", reason: "STEP_FINAL_USAGE_CONFLICT" });
  source.extra = { partial: { missing: ["tool_calls"] } };
  for (const step of source.steps) step.is_copied_context = true;
  const projected = piFixtureSourceMeasures(source);
  assert.equal(projected.gap, true);
  assert.equal(projected.measures["tool-operation-count"].status, "unavailable");
  assert.equal(projected.measures["tool-error-count"].status, "unavailable");
});

test("public Pi fixture bytes are pinned to their independent deterministic converter inputs", () => {
  const root = resolve("test/fixtures/atif/pi");
  const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
  assert.equal(manifest.harborVersion, "0.24.0");
  assert.equal(manifest.fixtures.length, 4);
  for (const fixture of manifest.fixtures) {
    const hash = (name: string) => createHash("sha256").update(readFileSync(resolve(root, name))).digest("hex");
    assert.equal(hash(fixture.native), fixture.nativeSha256);
    assert.equal(hash(fixture.trajectory), fixture.trajectorySha256);
  }
});

test("independent Pi conversion preserves grouped-call inference and inclusive cache accounting", () => {
  const fixture = JSON.parse(readFileSync(resolve("test/fixtures/atif/pi/parallel-failure-cache-write.atif.json"), "utf8"));
  const step = fixture.steps.find((value: { tool_calls?: unknown[] }) => value.tool_calls?.length === 2);
  assert.equal(step.llm_call_count, 1);
  assert.deepEqual(step.tool_calls.map((call: { tool_call_id: string }) => call.tool_call_id), ["call-a", "call-b"]);
  assert.deepEqual(step.observation.results.map((result: { extra: { is_error: boolean } }) => result.extra.is_error), [true, false]);
  assert.equal(fixture.final_metrics.total_prompt_tokens, 51);
  assert.equal(fixture.final_metrics.total_cached_tokens, 30);
  assert.equal(fixture.final_metrics.extra.cache_write_tokens, 3);
  assert.equal(fixture.final_metrics.total_prompt_tokens - fixture.final_metrics.total_cached_tokens - fixture.final_metrics.extra.cache_write_tokens, 18);
});
