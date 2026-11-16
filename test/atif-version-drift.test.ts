import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectAtifBytes } from "../src/atif-reader.js";
import { projectAtifV2 } from "../src/atif-v2.js";
import { listAtifOverlays } from "../src/atif-profiles.js";
const hash = `sha256:${"0".repeat(64)}` as const;
const fixture = (name: string) => inspectAtifBytes(readFileSync(new URL(`../../test/fixtures/atif/version-drift/${name}.json`, import.meta.url)));
const binding = { runId: "version-drift", attemptId: "a", manifestDigest: hash };
test("unseen Codex agent and newer Pi converter versions retain core calls and linked results", async () => {
  for (const [name, family, version] of [["codex-unseen-agent", "codex", "0.25.0"], ["pi-new-converter", "pi", "0.25.0"], ["pi-new-converter", "pi", "9.9.9"]]) {
    const read = fixture(name!), profile = listAtifOverlays().find((p) => p.family === family)!;
    const producer = { ...profile.producer, converter: { ...profile.producer.converter, packageVersion: version! } };
    const plain = await projectAtifV2({ read, ...binding }), overlaid = await projectAtifV2({ read, ...binding, producer });
    assert.ok(plain.dataset.operations.length > 0);
    assert.equal(overlaid.dataset.operations.length, plain.dataset.operations.length);
    assert.equal(overlaid.dataset.operations.reduce((sum, op) => sum + op.resultEventIds.length, 0), plain.dataset.operations.reduce((sum, op) => sum + op.resultEventIds.length, 0));
    assert.ok(plain.dataset.events.every(({ id }) => overlaid.dataset.events.some((event) => event.id === id)));
    if (family === "codex" || version === "9.9.9") assert.ok(overlaid.capture.qualification === "imported" && overlaid.capture.sourceLimitations?.includes("PRODUCER_VERSION_UNVERIFIED"));
  }
});
test("future ATIF minor reads latest known semantics and retains unknown fields as unmapped", async () => {
  const read = fixture("atif-v1.9"), evidence = await projectAtifV2({ read, ...binding });
  assert.ok(evidence.dataset.operations.length > 0);
  assert.ok(read.inspection.limitations.includes("ATIF_MINOR_VERSION_UNVERIFIED"));
  assert.ok(read.inspection.unmappedFields?.some(({ pointer }) => pointer === "#/future_field"));
});
test("future ATIF major reports a specific unsupported-format error", async () => {
  const read = fixture("atif-v2.0");
  assert.ok(read.document);
  await assert.rejects(projectAtifV2({ read, ...binding }), /ATIF_MAJOR_VERSION_UNSUPPORTED/u);
});
