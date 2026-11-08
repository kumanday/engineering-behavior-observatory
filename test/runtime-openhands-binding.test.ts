import assert from "node:assert/strict";
import test from "node:test";
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {freezeStudyRuntimes} from "../src/study-runtimes.js";
import {captureOpenHandsAgentServer} from "../src/openhands.js";
import {fakeOciRuntimeOptions} from "./runtime-oci-fixture.js";

test("an owned OpenHands server can write its Linux bind mount as the workspace owner", async () => {
  const {withStudyRuntime} = await import("../src/runtime-context.js");
  const {withLockedOpenHandsServer} = await import("../src/openhands-runtime.js");
  const {stat} = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "ebo-openhands-user-")), workspace = join(root, "workspace"), options = fakeOciRuntimeOptions(), original = options.run!;
  await mkdir(workspace, {mode: 0o700});
  const owner = await stat(workspace); let launchArgs: readonly string[] = [];
  options.run = async (command, args, cwd) => {if (args[0] === "run") launchArgs = args; return original(command, args, cwd);};
  try {
    await freezeStudyRuntimes(root, {studyId: "workspace-owner", roles: ["openhands-agent-server"]}, options);
    await withStudyRuntime({studyRoot: root, role: "openhands-agent-server", options}, async () => withLockedOpenHandsServer({workspacePath: workspace}, async () => {
      assert.equal(launchArgs[launchArgs.indexOf("--user") + 1], `${owner.uid}:${owner.gid}`);
      assert.ok(launchArgs.includes("HOME=/tmp"));
    }));
  } finally {await rm(root, {recursive: true, force: true});}
});

test("OpenHands rejects an actual container image that differs from the frozen image before contacting a server", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-openhands-binding-")), options = fakeOciRuntimeOptions(), original = options.run!;
  let contacted = false, stopped = false;
  options.run = async (command, args, cwd) => {
    if (args[0] === "run") return {code: 0, stdout: "a".repeat(64), stderr: ""};
    if (args[0] === "container" && args[1] === "inspect") return {code: 0, stdout: JSON.stringify([{Image: `sha256:${"b".repeat(64)}`}]), stderr: ""};
    if (args[0] === "rm") stopped = true;
    return original(command, args, cwd);
  };
  try {
    await freezeStudyRuntimes(root, {studyId: "image-binding", roles: ["openhands-agent-server"]}, options);
    await assert.rejects(captureOpenHandsAgentServer({runtime: {studyRoot: root, options}, runId: "run", attemptId: "attempt", baseUrl: "http://unrelated-server:8000", startConversation: {}, message: {}, fetch: async () => {contacted = true; throw new Error("must not contact");}}), /RUNTIME_INTEGRITY_MISMATCH/);
    assert.equal(contacted, false); assert.equal(stopped, true);
    const launches = join(root, "runtimes", "launches");
    const receipts = await Promise.all((await readdir(launches)).map(async (name) => JSON.parse(await readFile(join(launches, name), "utf8"))));
    assert.ok(receipts.some((receipt) => receipt.executions?.some((execution: any) => execution.actualConfigDigest === `sha256:${"b".repeat(64)}`)));
  } finally {await rm(root, {recursive: true, force: true});}
});

test("OpenHands uses the verified loopback endpoint and retries an unready owned server without submitting a turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-openhands-owned-")), options = fakeOciRuntimeOptions(), original = options.run!;
  let image = "", stopped = false, identityReads = 0;
  options.run = async (command, args, cwd) => {
    if (args[0] === "run") image = args[args.indexOf("--host") - 1]!;
    if (args[0] === "rm") stopped = true;
    return original(command, args, cwd);
  };
  try {
    const lock = await freezeStudyRuntimes(root, {studyId: "image-owned", roles: ["openhands-agent-server"]}, options);
    const capture = await captureOpenHandsAgentServer({runtime: {studyRoot: root, options}, runId: "run", attemptId: "attempt", baseUrl: "http://unrelated-server:8000", startConversation: {}, message: {}, timeoutMs: 1000, fetch: async (input) => {
      assert.ok(String(input).startsWith("http://127.0.0.1:8000/"));
      if (String(input).endsWith("/server_info")) {
        identityReads++;
        if (identityReads === 1) throw new TypeError("fetch failed", {cause: Object.assign(new Error("not ready"), {code: "ECONNREFUSED"})});
        return Response.json({version: "1.54.0"});
      }
      return new Response("", {status: 503});
    }});
    assert.equal(capture.serverInfo.version, "1.54.0");
    assert.equal(identityReads, 2); assert.equal(stopped, true);
    assert.equal(image, lock.groups[0]!.roots[0]!.selection.release.locator);
  } finally {await rm(root, {recursive: true, force: true});}
});


test("OpenHands failure shutdown preserves workspace evidence after the owned container has stopped", async () => {
  const {captureOpenHandsAgentServerRun} = await import("../src/openhands-run.js");
  const root = await mkdtemp(join(tmpdir(), "ebo-openhands-failure-")), options = fakeOciRuntimeOptions(), original = options.run!;
  let running = false, cleanupRan = false;
  options.run = async (command, args, cwd) => {
    if (args[0] === "run") running = true;
    if (args[0] === "rm") running = false;
    return original(command, args, cwd);
  };
  try {
    await freezeStudyRuntimes(root, {studyId: "image-failure", roles: ["openhands-agent-server"]}, options);
    const start = join(root, "start"), workspace = join(root, "workspace");
    await mkdir(start); await mkdir(workspace); await writeFile(join(start, "f"), "before"); await writeFile(join(workspace, "f"), "after");
    const definition = JSON.parse(await readFile("test/fixtures/run-bundles/complete/manifest.json", "utf8"));
    definition.bundleRoot = join(root, "bundle"); definition.run.harness.id = "openhands-agent-server";
    definition.run.assessmentMode = "observational"; definition.run.runtime = []; delete definition.run.verifier; delete definition.run.native;
    const result = await captureOpenHandsAgentServerRun({runtime: {studyRoot: root, options}, definition, startingWorkspacePath: start,
      workspace: {setup: async () => ({status: "ready", path: workspace, artifactId: "workspace", retained: true}), cleanup: async () => {cleanupRan = true;}},
      configuration: {model: definition.run.model.id, baseUrl: "http://unused.example", startConversation: {agent: {llm: {model: definition.run.model.id}}}, message: {},
        webSocket: () => {throw new Error("inert WebSocket startup failure");}, fetch: async (input, init) => {
          assert.equal(running, true, "No requests may target an already removed server");
          const url = String(input);
          if (url.endsWith("/server_info")) return Response.json({version: "1.54.0"});
          if (url.endsWith("/api/conversations")) return Response.json({id: "conversation"});
          if (url.includes("/events/search")) return Response.json({items: [], next_page_id: null});
          if (init?.method === "DELETE") return Response.json({success: true});
          throw new Error("Unexpected inert HTTP route");
        }}});
    assert.equal(result.attempt.record.harnessTerminationConfirmed, true);
    assert.equal(cleanupRan, true);
    assert.ok(result.manifest.evidence.some((entry) => entry.kind === "workspace"));
  } finally {await rm(root, {recursive: true, force: true});}
});
