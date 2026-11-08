import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {freezeStudyRuntimes} from "../src/study-runtimes.js";
import {captureOpenHandsAgentServer} from "../src/openhands.js";
import {fakeOciRuntimeOptions} from "./runtime-oci-fixture.js";

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
