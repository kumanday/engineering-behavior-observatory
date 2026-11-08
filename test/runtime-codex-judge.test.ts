import { validateArtifact } from "../src/artifacts.js";
import { createAtlasFixture } from "./atlas-fixture.js";
import { withRuntimeFixture } from "./with-runtime-fixture.js";
import { createRetainedStructuralObservationSet } from "../src/structural-observations.js";
import { runAgentSdkSemanticJudge } from "../src/semantic-judge.js";
import { probeClaudeAgentSdkCapabilities } from "../src/agent-sdk.js";
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

test("the judge uses its frozen executable and coordinating Node for unfamiliar matching versions", async () => {
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
  const savedPath = process.env.PATH, decoy = join(root, "decoy"); await mkdir(decoy);
  await writeFile(join(decoy, "node"), "#!/bin/sh\necho codex-cli 0.0.0\n"); await chmod(join(decoy, "node"), 0o700);
  const savedHome = process.env.CODEX_HOME; process.env.CODEX_HOME = join(root, "empty-auth");
  try {
    const lock = await freezeStudyRuntimes(root, { studyId: "judge-study", roles: ["codex-judge"] }, options);
    await withStudyRuntime({ studyRoot: root, role: "codex-judge", options }, async () => {
      assert.ok(probeClaudeAgentSdkCapabilities().sdkVersion, "A pure conformance probe does not require a different harness runtime");
      const request = { evaluator: { backend: "codex-app-server", executable: "/must-not-use-ambient-or-configured-codex", provider: "openai", model: "fixture", effort: "low" }, limits: { maxOutputChars: 16000, maxWallClockMs: 5000, maxCitations: 2 } } as SemanticJudgeRequest;
      process.env.PATH = decoy;
      const result = await runCodexSemanticJudge("success", request);
      process.env.PATH = savedPath;
      assert.equal(result.status, "completed", JSON.stringify(result));
      const captures = join(root, "captures");
      await withRuntimeFixture("claude-agent-sdk", () => createAtlasFixture(captures));
      const bundleRoot = join(captures, "corpus", "synthetic-attempt-0"), observations = await createRetainedStructuralObservationSet(bundleRoot);
      const configured: SemanticJudgeRequest = { ...request, schemaVersion: "ebo.semantic-judge-request/v1", id: "frozen-judge",
        behavior: {vocabularyVersion: "1.0.0", categoryId: "verification-completion", dimensionId: "verification-completion"},
        rubric: {id: "fixture", version: "1", instructions: "Synthetic fixture"},
        selection: {eventIds: [], structuralObservationIds: [], includeOutcomeObservations: false},
        limits: {...request.limits, maxEvidenceItems: 4, maxRecordChars: 4096, maxInputChars: 20000, maxTurns: 1}, blinding: {evaluatedModelIdentity: "redact"}};
      const first = await runAgentSdkSemanticJudge({bundleRoot, observations, request: configured, outputRoot: join(root, "judgment-a")});
      assert.equal(first.status, "proposed", JSON.stringify(first));
      assert.equal(first.evaluator.backend.version, "9.9.9");
      assert.equal(first.schemaVersion, "ebo.semantic-judgment/v3");
      assert.equal(first.runtime!.lockDigest, lock.digest);
      assert.deepEqual(validateArtifact("frozen judgment", first), []);
      assert.ok(validateArtifact("wrong runtime role", {...first, runtime: {...first.runtime, role: "claude-agent-sdk"}}).length);
      const actual = JSON.parse(await readFile(join(root, "judgment-a", first.runtime!.launch.path), "utf8"));
      assert.equal(actual.probes.at(-1).actualVersion, "9.9.9");
      const second = await runAgentSdkSemanticJudge({bundleRoot, observations, request: {...configured, evaluator: {...configured.evaluator, executable: "/another-ignored-executable"}}, outputRoot: join(root, "judgment-b")});
      const a = JSON.parse(await readFile(join(root, "judgment-a", first.assertion!.path), "utf8"));
      const b = JSON.parse(await readFile(join(root, "judgment-b", second.assertion!.path), "utf8"));
      assert.equal(a.evaluator.configurationDigest, b.evaluator.configurationDigest, "Fresh receipt IDs and unused executable declarations do not change the frozen evaluator identity");
      malicious = true;
      await assert.rejects(runCodexSemanticJudge("success", request), /RUNTIME_MALICIOUS.*MAL-2026-after-first-turn/);
    });
  } finally { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome; await rm(root, { recursive: true, force: true }); }
});

test("the structured Codex judge requires a frozen study before resolving any ambient executable", async () => {
  const { runCodexStructuredTurn } = await import("../src/codex-judge.js");
  await assert.rejects(runCodexStructuredTurn("Fixture", {} as any, {}, "Fixture"), /RUNTIME_STUDY_LOCK_REQUIRED/);
});
