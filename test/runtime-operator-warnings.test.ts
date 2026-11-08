import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConformanceRuntimeFixture } from "./with-runtime-fixture.js";
import { withStudyRuntime } from "../src/runtime-context.js";
import { captureClaudeAgentSdkRun } from "../src/agent-sdk-run.js";

test("run output exposes deprecated dependency names, versions and reasons and retains the same warnings", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-operator-warnings-")), runtime = await createConformanceRuntimeFixture("claude-agent-sdk", true);
  try {
    await withStudyRuntime({ ...runtime, role: "claude-agent-sdk" }, async () => {
      const workspace = join(root, "workspace"); await mkdir(workspace);
      const fixture = JSON.parse(await readFile("test/fixtures/run-bundles/complete/manifest.json", "utf8"));
      delete fixture.run.native; delete fixture.run.verifier; fixture.run.assessmentMode = "observational";
      const result = await captureClaudeAgentSdkRun({ definition: { ...fixture, bundleRoot: join(root, "bundle") }, startingWorkspacePath: workspace,
        workspace: { setup: async () => ({ status: "ready", path: workspace, artifactId: "workspace", retained: true }) },
        configuration: { prompt: "Fixture", model: fixture.run.model.id, tools: [], permissionMode: "dontAsk" }, expectedHooks: ["SessionStart"],
        query: (input) => ({ close() {}, async *[Symbol.asyncIterator]() {
          await input.options?.hooks?.SessionStart?.[0]?.hooks[0]?.({ hook_event_name: "SessionStart", session_id: "s", transcript_path: "/fixture/session.jsonl", cwd: workspace, source: "startup" } as any, undefined, { signal: new AbortController().signal });
          yield { type: "result", session_id: "s", uuid: "r", subtype: "success", duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, stop_reason: null, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], result: "Fixture" } as any;
        } }),
      });
      assert.match(result.runtime!.warnings.join(), /RUNTIME_DEPENDENCY_DEPRECATED.*fixture-deprecated-dependency@2.0.0.*platform API/);
      const descriptor = result.manifest.evidence.find((descriptor) => descriptor.id === result.manifest.runtimeLock!.launchArtifactId)!;
      const receipt = JSON.parse(await readFile(join(root, "bundle", descriptor.relativePath), "utf8"));
      assert.deepEqual(result.runtime!.warnings, receipt.warnings);
    });
  } finally { await rm(root, { recursive: true, force: true }); await rm(runtime.studyRoot, { recursive: true, force: true }); }
});
