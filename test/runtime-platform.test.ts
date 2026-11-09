import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {freezeStudyRuntimes} from "../src/study-runtimes.js";
import {withStudyRuntime} from "../src/runtime-context.js";
import {fakeSdkRuntimeOptions} from "./runtime-fixture-helper.js";

test("a study can freeze a guest SDK target while its host uses another target", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-guest-runtime-")), options = fakeSdkRuntimeOptions("9.9.9"), run = options.run;
  const target = {platform: process.platform === "linux" ? "darwin" : "linux", architecture: process.arch};
  const commands: string[][] = [];
  options.run = async (command, args, cwd) => {commands.push([...args]); return run(command, args, cwd);};
  try {
    const request = {studyId: "host-and-guest", roles: ["pi-sdk"], roleTargets: {"pi-sdk": target}};
    const lock = await freezeStudyRuntimes(root, request, options);
    assert.equal(lock.groups[0]!.plan.platform, `${target.platform}-${target.architecture}`);
    assert.ok(commands.filter((args) => args[0] === "install" || args[0] === "ci").every((args) => args.includes(`--os=${target.platform}`) && args.includes(`--cpu=${target.architecture}`)));
    await assert.rejects(withStudyRuntime({studyRoot: root, role: "pi-sdk", options}, async () => {throw new Error("SDK must not load on the host");}), /RUNTIME_PLATFORM_MISMATCH/);
  } finally {await rm(root, {recursive: true, force: true});}
});
