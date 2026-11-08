import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRuntimeCommandLine } from "../src/runtime-cli.js";
import { fakeSdkRuntimeOptions } from "./runtime-fixture-helper.js";

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
