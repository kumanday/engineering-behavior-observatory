import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConformanceRuntimeFixture } from "./with-runtime-fixture.js";
import { createAtlasFixture } from "./atlas-fixture.js";
import { currentStudyRuntime, withStudyRuntime } from "../src/runtime-context.js";
import { createRetainedBehaviorEvidence } from "../src/retained-evidence.js";

test("retained v2 bundles reopen without the study runtime installations or a launch context", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-offline-runtime-"));
  const runtime = await createConformanceRuntimeFixture("claude-agent-sdk");
  try {
    await withStudyRuntime({ ...runtime, role: "claude-agent-sdk" }, async () => createAtlasFixture(root));
    assert.equal(currentStudyRuntime(), undefined);
    await rm(runtime.studyRoot, { recursive: true });
    const evidence = await createRetainedBehaviorEvidence(join(root, "corpus", "synthetic-attempt-0"));
    assert.ok(evidence.dataset.events.length > 0);
    assert.ok(["qualified", "qualified-with-gaps"].includes(evidence.capture.qualification));
    const manifestPath = join(root, "corpus", "synthetic-attempt-0", "manifest.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.run.harness.version = "999.0.0";
    manifest.run.runtime = manifest.run.runtime.map((component: any) => ({...component, version: "999.0.0"}));
    await writeFile(manifestPath, JSON.stringify(manifest));
    const drifted = await createRetainedBehaviorEvidence(join(root, "corpus", "synthetic-attempt-0"));
    assert.equal(drifted.dataset.events.length, evidence.dataset.events.length);
    assert.equal(drifted.capture.qualification, evidence.capture.qualification);
    assert.ok(drifted.dataset.capabilityProfile.limitations?.includes("HARNESS_VERSION_CONFLICT"), "Retained actual probes expose the contradiction without rejecting evidence");
  } finally { await rm(root, { recursive: true, force: true }); await rm(runtime.studyRoot, { recursive: true, force: true }); }
});
