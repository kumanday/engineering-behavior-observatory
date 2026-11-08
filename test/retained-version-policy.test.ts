import assert from "node:assert/strict";
import test from "node:test";
import { describeAndValidateCodexDataset } from "../src/codex.js";
import { describeAndValidateDevinDataset, qualifyRetainedDevinCapture } from "../src/devin.js";
import { openHandsCapabilityProfile } from "../src/openhands.js";
import type { NormalizationInput } from "../src/uniform-events.js";
import type { ProtocolObservation } from "../src/process-protocol.js";
const capture: NormalizationInput<ProtocolObservation> = { runId: "version-drift", attemptId: "a", qualification: "qualified-with-gaps", records: [] };
for (const [name, describe] of [["Codex", describeAndValidateCodexDataset], ["Devin", describeAndValidateDevinDataset]] as const) {
  test(`${name} retained format remains readable at an unfamiliar runtime version`, async () => {
    const result = await describe(capture, "9000.1.0");
    assert.ok((result.dataset.capabilityProfile as { limitations?: string[] }).limitations?.includes("HARNESS_VERSION_UNVERIFIED"));
    assert.equal(result.dataset.nativeRecords.length, 0);
  });
}
test("OpenHands unfamiliar versions retain the format capabilities and a confidence limitation", () => {
  const profile = openHandsCapabilityProfile("9000.1.0");
  assert.ok((profile as { limitations?: string[] }).limitations?.includes("HARNESS_VERSION_UNVERIFIED"));
  assert.equal(profile.harness, "openhands-agent-server");
});
test("Devin unfamiliar but agreeing versions do not bypass owned identity checks", () => {
  assert.doesNotThrow(() => qualifyRetainedDevinCapture(capture, { sessionId: undefined, expectsCompletion: false,
    harnessVersion: "9000.1.0", runtimeVersions: ["9000.1.0"] }));
  assert.doesNotThrow(() => qualifyRetainedDevinCapture(capture, { sessionId: undefined, expectsCompletion: false,
    harnessVersion: "9000.1.0", runtimeVersions: ["9000.2.0"] }));
});
