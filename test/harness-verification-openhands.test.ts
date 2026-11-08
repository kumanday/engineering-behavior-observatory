import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {fakeOciRuntimeOptions} from "./runtime-oci-fixture.js";
import {freezeStudyRuntimes} from "../src/study-runtimes.js";
import {prepareHarnessVerification} from "../src/harness-verification-candidate.js";

test("OpenHands probe waits for its owned listener and retains actual image execution evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-openhands-verification-")), options = fakeOciRuntimeOptions(), fetch = options.fetch!, start = options.startOpenHandsSmol!;
  let calls = 0, stops = 0;
  options.fetch = async (url, init) => {
    if (!url.startsWith("http://127.0.0.1:")) return fetch(url, init);
    calls += 1;
    if (calls === 1) throw new TypeError("Listener is starting", {cause: {code: "ECONNREFUSED"}});
    return new Response(JSON.stringify({version: "1.54.0"}));
  };
  options.startOpenHandsSmol = async request => {const server = await start(request); return {...server, stop: async () => {stops += 1; await server.stop();}};};
  try {
    await freezeStudyRuntimes(root, {studyId: "probe-only", roles: ["openhands-agent-server"]}, options);
    const candidate = await prepareHarnessVerification({studyRoot: root, role: "openhands-agent-server"}, options);
    assert.equal(candidate.receipt.claims["runtime-probe"], "checked"); assert.equal(candidate.receipt.claims["module-api"], "checked");
    assert.equal(candidate.receipt.claims.interruption, undefined);
    assert.equal(calls, 2); assert.equal(stops, 1);
    const {readdir} = await import("node:fs/promises");
    const receipt = JSON.parse(await readFile(join(root, "runtimes/launches", (await readdir(join(root, "runtimes/launches")))[0]!), "utf8"));
    assert.ok(receipt.executions.some((execution: any) => execution.image === execution.expectedImage));
    assert.ok(receipt.executions.some((execution: any) => execution.imageConfigDigest === execution.expectedConfigDigest && execution.kind === "smol-local-vm"));
  } finally {await rm(root, {recursive: true, force: true});}
});
