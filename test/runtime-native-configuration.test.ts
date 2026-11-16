import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestBytes } from "../src/artifacts.js";
import { validateFactoryConfiguration } from "../src/factory-droid.js";
import { resolveCodexConfigurationRecord, CODEX_CONTRACT_DIGEST } from "../src/codex-run.js";
import { resolveDevinConfigurationRecord, DEVIN_CONTRACT_DIGEST } from "../src/devin-run.js";
import { resolveCursorSdkConfigurationRecord } from "../src/cursor-sdk-runner.js";
import {resolveHarnessRuntimeRole} from "../src/study-runtime-bindings.js";
import {createDeepSeekRuntimeComposition} from "../src/deepseek-adapter.js";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";

test("a DeepSeek alias selects its native composition without adding an invalid adapter field", async () => {
  const baseDir = resolve("test/fixtures/deepseek/compositions/minimal"), input = JSON.parse(await readFile(join(baseDir, "composition.json"), "utf8"));
  const composition = createDeepSeekRuntimeComposition({...input, baseDir});
  const root = await mkdtemp(join(tmpdir(), "ebo-deepseek-arm-"));
  try {
    const bytes = Buffer.from(JSON.stringify(composition)); await writeFile(join(root, "harness.json"), bytes);
    assert.equal(resolveHarnessRuntimeRole(root, "deepseek-arm-a", {locator: "harness.json", digest: digestBytes(bytes)}), "deepseek-harness");
  } finally {await rm(root, {recursive: true, force: true});}
});

test("native configuration accepts exact unfamiliar release versions for subsequent study-lock verification", async () => {
  assert.doesNotThrow(() => validateFactoryConfiguration({ executable: "/frozen/droid", version: "9.9.9", sdkVersion: "10.0.0", model: "fixture", autonomyLevel: "off", reasoningEffort: "low", permissionDecision: "cancel" } as any));
  const root = await mkdtemp(join(tmpdir(), "ebo-runtime-config-"));
  try {
    for (const [id, body, read] of [
      ["codex", { schemaVersion: "ebo.codex-config/v1", kind: "harness", adapter: "codex-app-server", executable: "/frozen/codex", version: "9.9.9", contractDigest: CODEX_CONTRACT_DIGEST }, resolveCodexConfigurationRecord],
      ["devin", { schemaVersion: "ebo.devin-config/v1", kind: "harness", adapter: "devin-cli", executable: "/frozen/devin", version: "9.9.9", contractDigest: DEVIN_CONTRACT_DIGEST }, resolveDevinConfigurationRecord],
      ["cursor", { schemaVersion: "ebo.cursor-sdk-config/v1", kind: "harness", adapter: "cursor-sdk", sdkVersion: "9.9.9" }, resolveCursorSdkConfigurationRecord],
    ] as const) {
      const bytes = Buffer.from(JSON.stringify(body)), locator = `${id}.json`; await writeFile(join(root, locator), bytes);
      assert.doesNotThrow(() => read(root, { locator, digest: digestBytes(bytes) }, "harness"));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
