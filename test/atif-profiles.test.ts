import assert from "node:assert/strict";
import test from "node:test";
import { listAtifOverlays, selectAtifOverlay } from "../src/atif-profiles.js";
import { validateArtifact } from "../src/artifacts.js";
test("only Pi and Codex have optional fixture-backed overlays", () => {
  const profiles = listAtifOverlays();
  assert.deepEqual(profiles.map(({ family }) => family).sort(), ["codex", "pi"]);
  for (const profile of profiles) {
    assert.deepEqual(validateArtifact("overlay", profile), []);
    const selection = selectAtifOverlay(profile.producer);
    assert.equal(selection.status, "supported");
    assert.ok(selection.status === "supported" && selection.verified);
    assert.ok(profile.limitations.includes("CAPTURE_COMPLETENESS_UNPROVEN"));
  }
});
test("range and provenance drift affect confidence rather than matching by digest", () => {
  for (const profile of listAtifOverlays()) {
    const producer = structuredClone(profile.producer); producer.converter.sourceDigest = `sha256:${"f".repeat(64)}`; producer.context.revision = "unseen";
    assert.equal(selectAtifOverlay(producer).status, "supported");
    producer.agent.version = "999.0.0";
    const selection = selectAtifOverlay(producer);
    assert.ok(selection.status === "supported" && !selection.verified);
    producer.agent.name = "acme-agent";
    assert.deepEqual(selectAtifOverlay(producer), { status: "absent", reason: "NO_MATCHING_OVERLAY" });
  }
});
test("overlay discovery returns isolated data", () => {
  const first = listAtifOverlays()[0]!;first.producer.agent.name = "changed";
  assert.equal(listAtifOverlays()[0]!.producer.agent.name, "pi");
});
