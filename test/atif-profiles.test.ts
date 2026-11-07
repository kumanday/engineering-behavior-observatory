import assert from "node:assert/strict";
import test from "node:test";
import { listAtifProducerProfiles, selectAtifProducerProfile, type AtifProducerFingerprint } from "../src/atif-profiles.js";
import { digestMetadata, validateArtifact } from "../src/artifacts.js";

test("Pi registry pins format, agent, converter source and source-context revisions", () => {
  const profiles = listAtifProducerProfiles();
  assert.equal(profiles.length, 2);
  for (const profile of profiles) {
    assert.deepEqual(validateArtifact("profile", profile), []);
    const selected = selectAtifProducerProfile(profile.producer);
    assert.equal(selected.status, "supported");
    if (selected.status !== "supported") throw new Error("Expected registered profile");
    assert.equal(selected.profileDigest, `sha256:${digestMetadata(profile).value}`);
    assert.equal(profile.rules.nativeRequests, "unavailable");
    assert.ok(profile.limitations.includes("CAPTURE_COMPLETENESS_UNPROVEN"));
  }
  assert.ok(profiles.find(({ producer }) => producer.agent.version === "unknown")!.limitations.includes("AGENT_VERSION_UNREPORTED"));
});

test("unknown source and converter conventions never receive a behavioral profile", () => {
  const base = listAtifProducerProfiles()[0]!.producer;
  const variants: AtifProducerFingerprint[] = [
    { ...base, formatVersion: "ATIF-v1.8" }, { ...base, agent: { ...base.agent, version: "1.3.0" } },
    { ...base, agent: { ...base.agent, version: null } }, { ...base, agent: { ...base.agent, name: "codex" } },
    { ...base, converter: { ...base.converter, packageVersion: "0.25.0" } }, { ...base, converter: { ...base.converter, sourceDigest: null } },
    { ...base, context: { kind: "unknown", revision: null, wrapperDigest: null } },
  ];
  for (const candidate of variants) assert.deepEqual(selectAtifProducerProfile(candidate), { status: "unsupported", reason: "PRODUCER_PROFILE_UNREGISTERED" });
  const leaderboard = listAtifProducerProfiles()[1]!.producer;
  assert.equal(selectAtifProducerProfile({ ...leaderboard, context: { ...leaderboard.context, revision: "unregistered" } }).status, "unsupported");
  assert.equal(selectAtifProducerProfile({ ...leaderboard, context: { ...leaderboard.context, wrapperDigest: null } }).status, "unsupported");
});

test("profile selections are isolated from caller mutation and preserve distinct unknown provenance", () => {
  const first = listAtifProducerProfiles()[0]!;
  const selected = selectAtifProducerProfile(first.producer);
  assert.equal(selected.status, "supported");
  if (selected.status !== "supported") throw new Error("Expected profile");
  selected.profile.producer.agent.name = "changed";
  assert.equal(selectAtifProducerProfile(first.producer).status, "supported");
  assert.equal(listAtifProducerProfiles()[0]!.producer.agent.name, "pi");
  assert.notEqual(first.producer.agent.version, null);
});
