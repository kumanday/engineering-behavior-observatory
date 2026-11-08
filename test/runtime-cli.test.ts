import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRuntimeCommandLine } from "../src/runtime-cli.js";
import { fakeSdkRuntimeOptions } from "./runtime-fixture-helper.js";
import {freezeStudyRuntimes} from "../src/study-runtimes.js";
import {main} from "../src/cli.js";

test("native CLI commands honor an explicit runtime study independently of the configuration bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-native-runtime-cli-"));
  try {
    await freezeStudyRuntimes(root, {studyId: "separate-runtime", roles: ["codex-judge"]}, fakeSdkRuntimeOptions("9.9.9"));
    for (const command of ["agent-sdk", "codex", "devin", "cursor", "pi", "factory"]) {
      let output = "";
      assert.equal(await main([command, "run", join(root, "bundle"), join(root, "missing-queue.json"), "run", join(root, "output"), "--runtime-study", root], text => {output += text;}), 1);
      assert.match(output, /RUNTIME_ROLE_NOT_FROZEN/, command);
    }
  } finally {await rm(root, {recursive: true, force: true});}
});

test("runtime CLI freezes an exact SDK graph, inspects the freeze and checks it without inference", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-runtime-cli-")); const output: string[] = [];
  try {
    const request = join(root, "request.json"); await writeFile(request, JSON.stringify({ studyId: "cli-study", roles: ["cursor-sdk"] }));
    for (const args of [["freeze", root, request], ["inspect", root], ["check", root, "cursor-sdk"]]) {
      assert.equal(await runRuntimeCommandLine(args, (text) => output.push(text), fakeSdkRuntimeOptions("9.9.9", true)), 0, output.join(""));
    }
    const documents = output.map((text) => JSON.parse(text));
    assert.equal(documents[0].lockDigest, documents[1].lockDigest);
    assert.equal(documents[2].lockDigest, documents[0].lockDigest);
    assert.equal(documents[0].groups[0].components[0].version, "9.9.9");
    assert.equal(documents[2].status, "probed");
    for (const document of documents) assert.ok(document.warnings.some((warning: string) => /RUNTIME_DEPENDENCY_DEPRECATED.*fixture-deprecated-dependency@2.0.0.*platform API/u.test(warning)), JSON.stringify(document));
  } finally { await rm(root, { recursive: true, force: true }); }
});
