import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeStudyRuntimes } from "../src/study-runtimes.js";
import { withStudyRuntime } from "../src/runtime-context.js";
import { runCodexSemanticJudge } from "../src/codex-judge.js";
import type { SemanticJudgeRequest } from "../src/semantic-judge.js";
import { fakeSdkRuntimeOptions } from "./runtime-fixture-helper.js";

test("the judge uses its frozen executable and accepts an unfamiliar matching actual version", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-locked-judge-")), options = fakeSdkRuntimeOptions("9.9.9"), run = options.run;
  options.run = async (command, args, cwd) => {
    const result = await run(command, args, cwd);
    if (args[0] === "ci") {
      const bin = join(cwd, "node_modules", ".bin"); await mkdir(bin);
      await writeFile(join(bin, "codex"), (await readFile("test/fixtures/codex/fake-judge.mjs", "utf8")).replaceAll("__CODEX_VERSION__", "9.9.9"));
      await chmod(join(bin, "codex"), 0o700);
    }
    return result;
  };
  let malicious = false;
  options.query = async () => malicious ? { vulns: [{ id: "MAL-2026-after-first-turn" }] } : {};
  const savedHome = process.env.CODEX_HOME; process.env.CODEX_HOME = join(root, "empty-auth");
  try {
    await freezeStudyRuntimes(root, { studyId: "judge-study", roles: ["codex-judge"] }, options);
    await withStudyRuntime({ studyRoot: root, role: "codex-judge", options }, async () => {
      const request = { evaluator: { backend: "codex-app-server", executable: "/must-not-use-ambient-or-configured-codex", provider: "openai", model: "fixture", effort: "low" }, limits: { maxOutputChars: 16000, maxWallClockMs: 5000, maxCitations: 2 } } as SemanticJudgeRequest;
      const result = await runCodexSemanticJudge("success", request);
      assert.equal(result.status, "completed", JSON.stringify(result));
      malicious = true;
      await assert.rejects(runCodexSemanticJudge("success", request), /RUNTIME_MALICIOUS.*MAL-2026-after-first-turn/);
    });
  } finally { if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome; await rm(root, { recursive: true, force: true }); }
});
