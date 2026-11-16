import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {freezeStudyRuntimes} from "../src/study-runtimes.js";
import {withStudyRuntime} from "../src/runtime-context.js";
import {withLockedOpenHandsServer} from "../src/openhands-runtime.js";
import {fakeOciRuntimeOptions} from "./runtime-oci-fixture.js";

test("OCI admission and cache validation do not invoke a Docker daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-oci-no-docker-"));
  const options = fakeOciRuntimeOptions();
  options.run = async (command) => {throw new Error(`No process is needed for OCI descriptor admission: ${command}`);};
  try {
    const lock = await freezeStudyRuntimes(root, {studyId: "no-docker", roles: ["openhands-agent-server"]}, options);
    const {prepareRuntimeLaunch} = await import("../src/study-runtimes.js");
    await prepareRuntimeLaunch(root, "openhands-agent-server", options);
    assert.equal(lock.groups[0]!.plan.kind, "oci");
  } finally {await rm(root, {recursive: true, force: true});}
});

test("OpenHands requires a study-frozen Smol engine before starting the local VM", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-oci-smol-required-"));
  const options = fakeOciRuntimeOptions();
  try {
    await freezeStudyRuntimes(root, {studyId: "no-engine", roles: ["openhands-agent-server"]}, options);
    // Do not use the injected owned-server fixture in this production-path check.
    delete options.startOpenHandsSmol;
    await withStudyRuntime({studyRoot: root, role: "openhands-agent-server", options}, async () => {
      await assert.rejects(withLockedOpenHandsServer({}, async () => {}), /RUNTIME_SMOL_NOT_FROZEN/);
    });
  } finally {await rm(root, {recursive: true, force: true});}
});

test("identical Smol compositions share a verification subject across study installations", async () => {
  const {fakePythonRuntimeOptions} = await import("./runtime-python-fixture.js");
  const root = await mkdtemp(join(tmpdir(), "ebo-smol-subject-"));
  const oci = fakeOciRuntimeOptions(), python = fakePythonRuntimeOptions();
  const options = {...oci, run: python.run, fetch: async (url: string, init?: RequestInit) => (url.includes("/v2/") || url.includes("/repos/OpenHands/")) ? oci.fetch!(url, init) : python.fetch!(url, init)};
  try {
    const first = await freezeStudyRuntimes(join(root, "one"), {studyId: "one", roles: ["openhands-agent-server", "smol"]}, options);
    const second = await freezeStudyRuntimes(join(root, "two"), {studyId: "two", roles: ["openhands-agent-server", "smol"]}, options);
    const subject = (lock: typeof first) => lock.groups.find(group => group.roles.includes("openhands-agent-server"))!.verification!["openhands-agent-server"]!.subject;
    assert.deepEqual(subject(first), subject(second));
    assert.ok(subject(first).components.some(component => component.id === "smol-environment"));
    const {runtimeExecutionVerificationSubject} = await import("../src/harness-verification.js");
    const {withOwnedOpenHandsSmolGuest} = await import("../src/openhands-smol-guest.js");
    const group = first.groups.find(group => group.roles.includes("openhands-agent-server"))!;
    const hostSubject = runtimeExecutionVerificationSubject("openhands-agent-server", group);
    const guestSubject = await withOwnedOpenHandsSmolGuest({schemaVersion: "ebo.smol-owned-task/v1", image: "authored", imageConfigDigest: "authored", machine: "authored", bootId: "authored", engineVersion: "authored", libkrunSha256: "authored"}, async () => runtimeExecutionVerificationSubject("openhands-agent-server", group));
    assert.notDeepEqual(hostSubject, guestSubject, "host qualification must not qualify guest server containment");
    assert.notEqual(first.groups.find(group => group.roles.includes("smol"))!.installation.receiptDigest, second.groups.find(group => group.roles.includes("smol"))!.installation.receiptDigest);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("a planned x64 task-guest lock reopens with Node coordinator naming", async () => {
  const {readStudyRuntimeLock} = await import("../src/study-runtimes.js");
  const {fakePythonRuntimeOptions} = await import("./runtime-python-fixture.js");
  const root = await mkdtemp(join(tmpdir(), "ebo-smol-x64-subject-"));
  const oci = fakeOciRuntimeOptions("x64"), python = fakePythonRuntimeOptions();
  const options = {...oci, run: python.run, fetch: async (url: string, init?: RequestInit) => (url.includes("/v2/") || url.includes("/repos/OpenHands/")) ? oci.fetch!(url, init) : python.fetch!(url, init)};
  try {
    const lock = await freezeStudyRuntimes(root, {studyId: "x64-guest", roles: ["openhands-agent-server", "smol"], openhandsBoundary: "task-guest", roleTargets: {"openhands-agent-server": {platform: "linux", architecture: "x64"}}}, options);
    const read = await readStudyRuntimeLock(root); assert.equal(read.digest, lock.digest);
    const group = read.groups.find(group => group.roles.includes("openhands-agent-server"))!;
    assert.equal(group.executionEnvironment!.coordinatorPlatform, "linux-x64");
    if (process.platform === "linux" && process.arch === "x64") {
      const {runtimeExecutionVerificationSubject} = await import("../src/harness-verification.js");
      const {withOwnedOpenHandsSmolGuest} = await import("../src/openhands-smol-guest.js");
      const actual = await withOwnedOpenHandsSmolGuest({schemaVersion: "ebo.smol-owned-task/v1", image: "authored", imageConfigDigest: "authored", machine: "authored", bootId: "authored", engineVersion: "authored", libkrunSha256: "authored"}, async () => runtimeExecutionVerificationSubject("openhands-agent-server", group));
      assert.deepEqual(actual, group.verification!["openhands-agent-server"]!.subject);
    }
  } finally {await rm(root, {recursive: true, force: true});}
});
