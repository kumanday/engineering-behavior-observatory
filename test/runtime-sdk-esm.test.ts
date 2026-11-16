import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSdkRuntimeOptions } from "./runtime-fixture-helper.js";
import { freezeStudyRuntimes } from "../src/study-runtimes.js";
import { currentStudyRuntime, withStudyRuntime } from "../src/runtime-context.js";

test("SDK loading respects import-only conditional exports in the isolated runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-import-only-sdk-")), options = fakeSdkRuntimeOptions("9.9.9"), run = options.run;
  options.run = async (command, args, cwd) => {
    const result = await run(command, args, cwd);
    if (args[0] === "ci") {
      const path = join(cwd, "node_modules", "@cursor/sdk", "package.json"), metadata = JSON.parse(await readFile(path, "utf8"));
      metadata.exports = { ".": { import: "./index.js" } }; await writeFile(path, JSON.stringify(metadata));
    }
    return result;
  };
  try {
    await freezeStudyRuntimes(root, { studyId: "import-only", roles: ["cursor-sdk"] }, options);
    await withStudyRuntime({ studyRoot: root, role: "cursor-sdk", options }, async () => {
      assert.equal(currentStudyRuntime()!.modules.get("@cursor/sdk")!.VERSION, "9.9.9");
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
