import assert from "node:assert/strict";
import test from "node:test";
import { inspectAtifBytes } from "../src/atif-reader.js";
import { projectAtifCore } from "../src/atif-core.js";
import { projectAtifV2 } from "../src/atif-v2.js";
import { listAtifProducerProfiles } from "../src/atif-profiles.js";
const hash = `sha256:${"0".repeat(64)}` as const;
const source = () => ({ schema_version: "ATIF-v1.7", agent: { name: "pi", version: "1.2.0" }, steps: [{ step_id: 1, source: "agent", message: "Recorded action.", llm_call_count: 1,
  tool_calls: [{ tool_call_id: "c", function_name: "read", arguments: { path: "a" } }], observation: { results: [{ source_call_id: "c", content: "failure", extra: { is_error: true } }] } }] });
function input(agentVersion = "1.2.0", converterVersion = "0.24.0") {
  const doc = source(); doc.agent.version = agentVersion;
  return { read: inspectAtifBytes(Buffer.from(JSON.stringify(doc))), runId: "overlays", attemptId: "a", manifestDigest: hash,
    producer: { ...listAtifProducerProfiles()[0]!.producer, agent: doc.agent,
      converter: { id: "harbor.agents.installed.pi.Pi", packageVersion: converterVersion, sourceDigest: hash } } };
}
test("optional Pi overlay enriches explicit failure while preserving every core event and document count", async () => {
  const request = input(), core = (await projectAtifCore(request)).v2, enhanced = await projectAtifV2(request);
  assert.ok(core.dataset.events.every(({ id }) => enhanced.dataset.events.some((event) => event.id === id)));
  assert.equal(enhanced.dataset.operations.length, core.dataset.operations.length);
  assert.deepEqual(enhanced.dataset.operations[0]!.failure, { status: "known", value: true });
  assert.equal(enhanced.dataset.sources[0]!.producerProfile.status, "known");
  assert.deepEqual(enhanced.dataset.measurements.find(({ id }) => id === "source-tool-operation-count"), core.dataset.measurements.find(({ id }) => id === "source-tool-operation-count"));
});
test("unverified producer and converter versions retain core plus conservative overlay limitations", async () => {
  for (const request of [input("9.9.9"), input("1.2.0", "9.9.9")]) {
    const enhanced = await projectAtifV2(request);
    assert.equal(enhanced.dataset.operations.length, 1);
    assert.equal(enhanced.dataset.operations[0]!.failure.status, "unknown");
    assert.ok(enhanced.capture.qualification === "imported" && enhanced.capture.sourceLimitations?.includes("PRODUCER_VERSION_UNVERIFIED"));
  }
});
test("converter digests and context revisions do not select an overlay; absent converter provenance uses core", async () => {
  const first = input(); first.producer.converter.sourceDigest = `sha256:${"1".repeat(64)}`;
  first.producer.context.revision = "unseen-revision";
  assert.equal((await projectAtifV2(first)).dataset.operations[0]!.failure.status, "known");
  const { producer: _producer, ...plain } = input();
  assert.equal((await projectAtifV2(plain)).dataset.operations[0]!.failure.status, "unknown");
});

test("Codex conversion limits qualify order and original-input signatures without removing core calls", async () => {
  const { readFileSync } = await import("node:fs");
  const { listAtifOverlays } = await import("../src/atif-profiles.js");
  const source = JSON.parse(readFileSync(new URL("../../test/fixtures/atif/producers/codex.atif.json", import.meta.url), "utf8"));
  const request = { read: inspectAtifBytes(Buffer.from(JSON.stringify(source))), runId: "codex-overlay", attemptId: "a", manifestDigest: hash,
    producer: listAtifOverlays().find(({ family }) => family === "codex")!.producer };
  const core = (await projectAtifCore(request)).v2, enhanced = await projectAtifV2(request);
  assert.equal(enhanced.dataset.operations.length, core.dataset.operations.length);
  assert.ok(core.dataset.events.every(({ id }) => enhanced.dataset.events.some((event) => event.id === id)));
  assert.ok(enhanced.dataset.operations.every(({ startOrder }) => startOrder.status === "unknown"));
  assert.ok(enhanced.dataset.measurements.every(({ scope }) => scope.kind === "recorded-document"));
  assert.ok(enhanced.capture.qualification === "imported" && enhanced.capture.sourceLimitations?.includes("CONVERTER_OMITS_PENDING_CALLS"));
  assert.ok(enhanced.overlayAdjustments?.every(({ reason, pointers }) => reason.length > 0 && pointers.length > 0));
});
