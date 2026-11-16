import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createConformanceRuntimeFixture } from "./with-runtime-fixture.js";
import { currentStudyRuntime, recordRuntimeProbe, withStudyRuntime } from "../src/runtime-context.js";

test("a mismatching actual probe is retained before the launch is blocked", async () => {
  const binding = await createConformanceRuntimeFixture("claude-agent-sdk");
  try {
    await withStudyRuntime({ ...binding, role: "claude-agent-sdk" }, async () => {
      const context = currentStudyRuntime()!;
      await assert.rejects(recordRuntimeProbe("agent-sdk", "999.0.0", "executable"), /RUNTIME_PROBE_MISMATCH/);
      const receipt = JSON.parse(await readFile(join(binding.studyRoot, context.launch.receiptLocator), "utf8"));
      assert.equal(receipt.status, "probe-failed");
      assert.equal(receipt.probes.at(-1).actualVersion, "999.0.0");
    });
  } finally { await rm(binding.studyRoot, { recursive: true, force: true }); }
});
