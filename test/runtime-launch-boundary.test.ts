import { executeDeepSeekHarness } from "../src/deepseek-adapter.js";
import { captureOpenHandsAgentServerRun } from "../src/openhands-run.js";
import { captureOpenHandsAgentServer } from "../src/openhands.js";
import { captureDevinCliRun } from "../src/devin-run.js";
import { captureDevinCli } from "../src/devin.js";
import { captureCodexAppServerRun } from "../src/codex-run.js";
import { captureCodexAppServer } from "../src/codex.js";
import { captureFactoryDroidRun } from "../src/factory-run.js";
import { captureFactoryDroid } from "../src/factory-droid.js";
import { capturePiSdkRun } from "../src/pi.js";
import { captureCursorSdkRun } from "../src/cursor-sdk.js";
import assert from "node:assert/strict";
import test from "node:test";
import { captureClaudeAgentSdkRun } from "../src/agent-sdk-run.js";
import { executeClaudeAgentSdk } from "../src/agent-sdk.js";

test("owned Agent SDK launch APIs require a study runtime before inspecting or executing capture inputs", async () => {
  await assert.rejects(captureClaudeAgentSdkRun({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
  await assert.rejects(executeClaudeAgentSdk({} as any, {} as any, {} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
});

test("owned Cursor launch requires the frozen study before inspecting capture inputs", async () => {
  await assert.rejects(captureCursorSdkRun({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
});

test("owned Pi launch requires the frozen study before inspecting capture inputs", async () => {
  await assert.rejects(capturePiSdkRun({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
});

test("owned Factory launch APIs require a study runtime before inspecting capture inputs", async () => {
  await assert.rejects(captureFactoryDroidRun({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
  await assert.rejects(captureFactoryDroid({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
});

test("owned Codex launch APIs require a study runtime before inspecting capture inputs", async () => {
  await assert.rejects(captureCodexAppServerRun({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
  await assert.rejects(captureCodexAppServer({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
});

test("owned Devin launch APIs require a study runtime before inspecting capture inputs", async () => {
  await assert.rejects(captureDevinCliRun({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
  await assert.rejects(captureDevinCli({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
});

test("owned OpenHands launch APIs require a study runtime before inspecting capture inputs", async () => {
  await assert.rejects(captureOpenHandsAgentServerRun({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
  await assert.rejects(captureOpenHandsAgentServer({} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
});

test("owned DeepSeek launch requires a study runtime before inspecting capture inputs", async () => {
  await assert.rejects(executeDeepSeekHarness({} as any, {} as any, {} as any), /RUNTIME_STUDY_LOCK_REQUIRED/);
});
