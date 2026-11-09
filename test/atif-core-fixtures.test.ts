import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectAtifBytes } from "../src/atif-reader.js";
import { projectAtifV2 } from "../src/atif-v2.js";

for (const [fixture, calls] of [["acme", 2], ["hermes-legacy", 2], ["openclaw-positive", 65]] as const) {
  test(`${fixture} projects through core without producer context or overlays`, async () => {
    const source = readFileSync(new URL(`../../test/fixtures/atif/core/${fixture}.json`, import.meta.url));
    const evidence = await projectAtifV2({ read: inspectAtifBytes(source), runId: "generic-fixtures", attemptId: fixture,
      manifestDigest: `sha256:${"0".repeat(64)}` });
    assert.equal(evidence.capture.qualification, "imported");
    assert.equal(evidence.dataset.operations.length, calls);
    assert.equal(evidence.dataset.operations.reduce((n, x) => n + x.callEventIds.length, 0), calls);
    assert.equal(evidence.dataset.operations.reduce((n, x) => n + x.resultEventIds.length, 0), calls);
    assert.ok(evidence.dataset.events.some(({ family }) => family === "message"));
    assert.ok(evidence.dataset.measurements.every(({ scope }) => scope.kind === "recorded-document"));
    assert.ok(evidence.dataset.operations.every(({ failure }) => failure.status === "unknown"));
    if (fixture === "hermes-legacy") assert.equal(evidence.dataset.measurements.find(({ id }) => id === "source-declared-inference-count")?.value.status, "unknown");
  });
}

test("an unknown producer's literal history-gap text supplies no compaction or complete-attempt claim", async () => {
  const source = readFileSync(new URL("../../test/fixtures/atif/core/openclaw-partial.json", import.meta.url));
  const evidence = await projectAtifV2({ read: inspectAtifBytes(source), runId: "generic-fixtures", attemptId: "partial",
    manifestDigest: `sha256:${"0".repeat(64)}` });
  assert.equal(evidence.dataset.operations.length, 0);
  assert.equal(evidence.dataset.events.some(({ facts }) => facts.context?.type === "compaction"), false);
  assert.equal(evidence.dataset.measurements.find(({ id }) => id === "source-tool-operation-count")?.value.status, "unknown");
  assert.ok(evidence.dataset.measurements.every(({ scope }) => scope.kind === "recorded-document"));
});

test("retained real OpenClaw evidence imports at an unregistered newer version", { skip: !process.env.EBO_ATIF_PRIVATE_FIXTURES }, async () => {
  const root = process.env.EBO_ATIF_PRIVATE_FIXTURES!;
  const source = readFileSync(`${root}/openclaw-positive/agent/trajectory.json`);
  const evidence = await projectAtifV2({ read: inspectAtifBytes(source), runId: "private-fixtures", attemptId: "positive",
    manifestDigest: `sha256:${"0".repeat(64)}` });
  assert.equal(evidence.dataset.operations.length, 65);
  assert.equal(evidence.dataset.operations.reduce((n, x) => n + x.callEventIds.length, 0), 65);
  assert.equal(evidence.dataset.operations.reduce((n, x) => n + x.resultEventIds.length, 0), 65);
  assert.equal(evidence.dataset.sources[0]!.executedHarness.version.status, "known");
  assert.ok(evidence.dataset.sources.every(({ producerProfile }) => producerProfile.status === "unknown"));
});

for (const [name, calls] of [["hermes", 28], ["openclaw-partial", 0]] as const) {
  test(`retained real ${name} is readable through standard ATIF core`, { skip: !process.env.EBO_ATIF_PRIVATE_FIXTURES }, async () => {
    const root = process.env.EBO_ATIF_PRIVATE_FIXTURES!;
    const evidence = await projectAtifV2({ read: inspectAtifBytes(readFileSync(`${root}/unknown-producers/${name}.json`)),
      runId: "private-unknowns", attemptId: name, manifestDigest: `sha256:${"0".repeat(64)}` });
    assert.equal(evidence.dataset.operations.reduce((n, op) => n + op.callEventIds.length, 0), calls);
    assert.ok(evidence.dataset.sources.every(({ producerProfile }) => producerProfile.status === "unknown"));
    assert.equal(evidence.dataset.events.some(({ facts }) => facts.context?.type === "compaction"), false);
    assert.equal(evidence.dataset.measurements.find(({ id }) => id === "source-declared-inference-count")?.value.status, "unknown");
  });
}
