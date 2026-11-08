import assert from "node:assert/strict";
import test from "node:test";
import { captureClaudeAgentSdkRun } from "../src/agent-sdk-run.js";
import { executeClaudeAgentSdk } from "../src/agent-sdk.js";

test("owned Agent SDK launch APIs require a study runtime before inspecting or executing capture inputs", async () => {
  await assert.rejects(captureClaudeAgentSdkRun({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
  await assert.rejects(executeClaudeAgentSdk({} as any, {} as any, {} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
});
