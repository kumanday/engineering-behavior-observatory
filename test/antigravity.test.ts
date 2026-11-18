import { exportAntigravityAtif } from "../src/antigravity-atif.js";
import { createRetainedBehaviorEvidenceV2 } from "../src/native-v2.js";
import { inspectAtifBytes } from "../src/atif-reader.js";
import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runtimeTest, liveRuntimeTest } from "./with-runtime-fixture.js";
const test = runtimeTest("antigravity-cli");
import { captureAntigravityCli, ANTIGRAVITY_CLI_VERSION, ANTIGRAVITY_CONTRACT_DIGEST, describeAndValidateAntigravityDataset, normalizeAntigravityCapture, probeAntigravityRuntime, qualifyRetainedAntigravityCapture, type AntigravityCliConfiguration } from "../src/antigravity.js";
import { captureAntigravityCliRun, resolveAntigravityConfigurationRecord, runAntigravityQueueEntry } from "../src/antigravity-run.js";
import { createPortableRunBundleExport, createRetainedBehaviorEvidence, createRetainedStructuralObservationSet, digestBytes, main, readPortableRunBundleExport, type RunBundleDefinition } from "../src/index.js";
import { sanitizeDerivedExport } from "../src/exports.js";
import { createRunMonitor } from "../src/run-monitor.js";
import { deriveUnits } from "../src/atlas-units.js";
import { runHarborWorker, type HarborWorkerInput } from "../src/harbor/worker.js";
import { createQueueFixture } from "./antigravity-fixture.js";

const fixture = resolve("test/fixtures/antigravity/fake-agy.mjs");
const model = "gemini-4-argon-high";
const temporaryRoot = () => mkdtemp(join(tmpdir(), "ebo-agy-test-"));
function configuration(root: string, scenario = "success"): AntigravityCliConfiguration {
  return { executable: process.execPath, executableArgs: [fixture, `--scenario=${scenario}`], version: ANTIGRAVITY_CLI_VERSION,
    model, permissionMode: "always-proceed", sandbox: false, accountHome: root };
}
async function capture(root: string, scenario = "success", extra: Partial<Parameters<typeof captureAntigravityCli>[0]> = {}) {
  const workspace = join(root, "workspace"); await mkdir(workspace, { recursive: true });
  return captureAntigravityCli({ runId: "run-agy", attemptId: "attempt-agy", workspacePath: workspace, prompt: "Create capture-proof.txt.",
    evidencePath: join(root, "session.jsonl"), configuration: configuration(root, scenario), shutdownGraceMs: 100, ...extra });
}
const definition = (root: string): RunBundleDefinition => ({
  bundleRoot: root, bundleId: "bundle-agy", run: { id: "run-agy", assessmentMode: "observational", task: { id: "task" },
    fixture: { id: "fixture", digest: `sha256:${"1".repeat(64)}` }, model: { provider: "google", id: model }, harness: { id: "antigravity-cli", version: ANTIGRAVITY_CLI_VERSION }, runtime: [] },
  attempt: { id: "attempt-agy", number: 1 }, configuration: { digest: `sha256:${"2".repeat(64)}`, budgetDigest: `sha256:${"3".repeat(64)}`, toolPolicyDigest: `sha256:${"4".repeat(64)}` },
});

test("Antigravity captures one stream-json turn, deduplicates tool transitions, and keeps native usage", async () => {
  const root = await temporaryRoot();
  try {
    const native = await capture(root);
    assert.equal(native.terminalStatus, "completed", JSON.stringify(native.gaps));
    assert.deepEqual(native.gaps, []);
    assert.equal(native.sessionId, "fixture-agy-conversation");
    assert.equal(native.telemetry.usage.final?.input_tokens, 100);
    assert.equal(native.telemetry.usage.chargedUsd, null);
    assert.equal(native.telemetry.telemetry.status, "unsupported");
    assert.equal(native.telemetry.effectiveConfiguration.environmentKeys.includes("GEMINI_API_KEY"), false);
    assert.equal(await readFile(join(root, "workspace/capture-proof.txt"), "utf8"), "done\n");
    const { dataset, coverage } = await describeAndValidateAntigravityDataset(native);
    assert.ok(coverage.records.mapped > 0);
    const tools = dataset.events.filter(e => e.family === "tool");
    assert.equal(tools.length, 2);
    assert.equal(tools[1]!.relations.parent.status, "known");
    assert.equal(dataset.events.filter(e => e.family === "delegation").length, 1);
    assert.equal(dataset.events.filter(e => e.family === "message").length, 3);
    assert.equal(dataset.events.filter(e => e.family === "outcome").length, 1);
    assert.equal(dataset.events.at(-1)?.attributes.inputTokens, 100);
    assert.equal(dataset.events.at(-1)?.attributes.resourceSemantics, "cumulative-final");
    assert.equal(JSON.stringify(dataset.events).includes("PRIVATE-AGY"), false);
    assert.ok(dataset.unmapped.length > 0);
    const content = new Map(native.records.map(r => [r.reference.recordLocator, r.record]));
    const resolveContent = (ref: { recordLocator: string }) => {
      const [line, path] = ref.recordLocator.split("#");
      let value: unknown = content.get(line!);
      for (const key of path?.split("/").slice(1) ?? []) value = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
      return value;
    };
    const units = deriveUnits({ attemptId: native.attemptId, events: dataset.events, occurrences: [], resolveContent }).units;
    assert.equal(units.filter(u => u.unit_kind === "message").length, 2, "one user input and one concatenated assistant response");
    assert.ok(units.some(u => u.tool_kind === "shell" && u.command === "npm test"));
    const records = native.records.map(r => r.record);
    assert.ok(records.findIndex(r => r.kind === "completion") < records.findIndex(r => r.kind === "process"));
    assert.ok(records.some(r => r.raw?.includes("PRIVATE-AGY-REASONING-SENTINEL")), "hidden reasoning is retained only in native evidence");
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const scenario of ["foreign-result", "multi-turn", "duplicate-result", "foreign-step", "wrong-model", "exit-only", "error", "malformed", "oversized", "startup-error"]) {
  test(`Antigravity preserves partial evidence and refuses completion for ${scenario}`, async () => {
    const root = await temporaryRoot();
    try {
      const native = await capture(root, scenario, { maxLineBytes: 8192 });
      assert.equal(native.terminalStatus, "failed");
      assert.ok(native.records.length > 0);
      assert.ok((await readFile(join(root, "session.jsonl"), "utf8")).length > 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("Antigravity bounds shutdown after a result and interrupts an active child", async () => {
  const root = await temporaryRoot();
  try {
    const linger = await capture(join(root, "linger"), "linger");
    assert.equal(linger.terminalStatus, "completed");
    const native = await capture(join(root, "interrupt"), "hang", { signal: AbortSignal.timeout(300) });
    assert.equal(native.terminalStatus, "interrupted");
    assert.equal(native.terminal?.status, "ERROR");
    assert.equal(native.terminal?.finished_reason, "interrupted");
    assert.equal((await capture(join(root, "native-interrupt"), "native-interrupted")).terminalStatus, "interrupted");
    const hard = await capture(join(root, "hard"), "ignore-interrupt", { signal: AbortSignal.timeout(300) });
    assert.equal(hard.terminalStatus, "interrupted");
    assert.ok(hard.gaps.some(g => g.kind === "terminal-missing"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Antigravity keeps tool failures and unknown native events without inventing model-request telemetry", async () => {
  const root = await temporaryRoot();
  try {
    const native = await capture(join(root, "failure"), "tool-error");
    assert.equal(native.terminalStatus, "completed", "a tool error does not determine the turn outcome");
    assert.equal((await normalizeAntigravityCapture(native)).events.find(e => e.family === "tool" && e.phase === "after")?.attributes.status, "failed");
    const future = await capture(join(root, "future"), "future");
    assert.equal(future.terminalStatus, "completed");
    assert.ok(future.gaps.some(g => g.kind === "unknown-event"));
    assert.ok((await normalizeAntigravityCapture(future)).unmapped.length);
    const missing = await capture(join(root, "missing"), "missing-tool-result");
    assert.equal((await normalizeAntigravityCapture(missing)).events.find(e => e.family === "tool" && e.phase === "after")?.attributes.status, undefined);
    const subagent = await capture(join(root, "subagent"), "subagent-start");
    const events = (await normalizeAntigravityCapture(subagent)).events;
    assert.equal(events.filter(e => e.family === "tool").length, 2);
    assert.equal(events.filter(e => e.family === "delegation").length, 2);
    const repeat = await capture(join(root, "repeat"), "message-repeat");
    assert.equal((await normalizeAntigravityCapture(repeat)).events.filter(e => e.family === "message").length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Antigravity typed projection retains tool error diagnostics with and without output", async () => {
  const root = await temporaryRoot();
  try {
    for (const scenario of ["tool-error", "tool-error-no-output"]) {
      const directory = join(root, scenario), workspace = join(directory, "workspace"), baseline = join(directory, "baseline"), bundle = join(directory, "bundle");
      await mkdir(workspace, { recursive: true }); await mkdir(baseline);
      const result = await captureAntigravityCliRun({ definition: definition(bundle), startingWorkspacePath: baseline,
        workspace: { setup: () => ({ status: "ready", path: workspace, artifactId: "workspace", retained: true }) },
        configuration: configuration(directory, scenario), prompt: "Run npm test.", maxWallClockMs: 5000 });
      assert.equal(result.manifest.terminal.state, "completed");
      const retained = await createRetainedBehaviorEvidenceV2(bundle);
      const operation = retained.dataset.operations.find(op => op.identity.kind === "tool")!;
      assert.deepEqual(operation.failure, { status: "known", value: true });
      // The typed projection keeps the native error record as evidence of the failed operation.
      const scoped = retained.dataset.events.filter(event => event.scope.kind === "operation" && event.scope.id === operation.id);
      assert.ok(scoped.some(event => event.content.status === "known" && event.content.value.some(({ role, nativeReference }) => role === "tool-error" && nativeReference.recordLocator.endsWith("/tool_info/error"))));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Antigravity failed native attempts remain readable bundles with workspace outcomes", async () => {
  const root = await temporaryRoot();
  try {
    const workspace = join(root, "workspace"), baseline = join(root, "baseline"), bundle = join(root, "bundle");
    await mkdir(workspace); await mkdir(baseline);
    const result = await captureAntigravityCliRun({ definition: definition(bundle), startingWorkspacePath: baseline,
      workspace: { setup: () => ({ status: "ready", path: workspace, artifactId: "workspace", retained: true }) },
      configuration: configuration(root, "exit-only"), prompt: "Create capture-proof.txt.", maxWallClockMs: 5000 });
    assert.equal(result.manifest.terminal.state, "failed");
    assert.ok(result.manifest.evidence.some(e => e.kind === "workspace"));
    const retained = await createRetainedBehaviorEvidence(bundle);
    assert.ok(retained.dataset.events.some(e => e.family === "tool"));
    assert.equal(retained.dataset.events.some(e => e.source.nativeType === "result"), false);
    const startup = await captureAntigravityCliRun({ definition: definition(join(root, "startup-bundle")), startingWorkspacePath: baseline,
      workspace: { setup: () => ({ status: "ready", path: workspace, artifactId: "workspace", retained: true }) },
      configuration: configuration(root, "startup-error"), prompt: "Create capture-proof.txt.", maxWallClockMs: 5000 });
    assert.equal(startup.manifest.terminal.state, "failed");
    assert.equal(startup.capture?.sessionId, undefined);
    assert.ok(startup.capture?.gaps.some(g => g.kind === "startup-error"));
    assert.ok(startup.manifest.evidence.some(e => e.kind === "session"));
    assert.equal(startup.qualification.status, "unqualified");
    await assert.rejects(createRetainedBehaviorEvidence(join(root, "startup-bundle")), /unqualified structural capture/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Antigravity refuses API-key routing and preserves native account credit policy", async () => {
  const root = await temporaryRoot();
  try {
    await mkdir(join(root, ".gemini/antigravity-cli"), { recursive: true });
    const path = join(root, ".gemini/antigravity-cli/settings.json");
    await writeFile(path, JSON.stringify({ modelProvider: "gemini" }));
    await assert.rejects(capture(root), /Google-account/u);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { modelProvider: "gemini" });
    await writeFile(path, JSON.stringify({ useG1Credits: true }));
    const native = await capture(root);
    assert.equal(native.terminalStatus, "completed");
    assert.equal(native.telemetry.effectiveConfiguration.useG1Credits, true);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { useG1Credits: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Antigravity detects IDE launchers and checks the standalone CLI pin", async () => {
  const root = await temporaryRoot();
  try {
    const script = join(root, "agy");
    await writeFile(script, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.107.0; else echo "Antigravity IDE --new-window"; fi\n'); await chmod(script, 0o700);
    await assert.rejects(probeAntigravityRuntime(script), /IDE launcher/u);
    await writeFile(script, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.5.9; else echo "--input-format --output-format --print-timeout"; fi\n');
    assert.equal((await probeAntigravityRuntime(script)).version, ANTIGRAVITY_CLI_VERSION);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Antigravity retained qualification rejects changed composition, model, turn counters, and terminal evidence", async () => {
  const root = await temporaryRoot();
  try {
    const native = await capture(root);
    const options = { sessionId: native.sessionId, expectsCompletion: true, harnessVersion: ANTIGRAVITY_CLI_VERSION, runtimeVersions: [ANTIGRAVITY_CLI_VERSION] };
    assert.equal(qualifyRetainedAntigravityCapture(native, options).sessionId, native.sessionId);
    const mutate = [
      (c: typeof native) => { (c.records.find(r => r.record.capability === "runtime-composition")!.record.evidence as any).adapterVersion = "999"; },
      (c: typeof native) => { (c.records.find(r => (r.record.payload as any)?.event === "init")!.record.payload as any).init.model = "other"; },
      (c: typeof native) => { (c.records.find(r => (r.record.payload as any)?.event === "result")!.record.payload as any).result.num_turns = 2; },
      (c: typeof native) => { c.records.find(r => r.record.kind === "completion")!.record.status = "ERROR"; },
    ];
    for (const change of mutate) { const changed = structuredClone(native); change(changed); assert.throws(() => qualifyRetainedAntigravityCapture(changed, options)); }
    assert.ok(qualifyRetainedAntigravityCapture(native, { ...options, runtimeVersions: ["0.0.0"] }).sourceLimitations?.includes("HARNESS_VERSION_CONFLICT"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Antigravity guest-runtime contract and bundled examples agree with the adapter pin", () => {
  const contract = JSON.parse(readFileSync("contracts/antigravity-cli-1.5.9/manifest.json", "utf8"));
  assert.equal(contract.runtimeVersion, ANTIGRAVITY_CLI_VERSION); assert.equal(contract.contractDigest, ANTIGRAVITY_CONTRACT_DIGEST);
  assert.match(contract.linuxArm64.sha512, /^[a-f0-9]{128}$/u);
  for (const [name, kind] of Object.entries({ model: "model", harness: "harness", limits: "native-limits", tools: "native-tool-policy", capture: "capture-profile" })) {
    const locator = `examples/antigravity/${name}.json`, bytes = readFileSync(locator);
    assert.doesNotThrow(() => resolveAntigravityConfigurationRecord(process.cwd(), { locator, digest: digestBytes(bytes) }, kind as "model"));
  }
});

test("Antigravity frozen queue captures, reopens, extracts observations, and exports sanitized native evidence", async () => {
  const root = await temporaryRoot();
  try {
    const queue = createQueueFixture(root);
    const summary = await runAntigravityQueueEntry({ ...queue, outputRoot: join(root, "runs"), workspaceRoot: join(root, "workspaces"),
      probeRuntime: async path => ({ path, version: ANTIGRAVITY_CLI_VERSION }), executableArgs: [fixture], attemptId: "a" });
    assert.equal(summary.terminal.state, "completed", JSON.stringify(summary));
    assert.equal(summary.sessionId, "fixture-agy-conversation");
    assert.equal(summary.captureQualification, "qualified-with-gaps");
    assert.ok(summary.normalizedEvents > 0);
    const lifecycle = JSON.parse(await readFile(join(summary.bundlePath, "runtime/capture-lifecycle.json"), "utf8"));
    assert.equal(lifecycle.capture.status, "complete");
    assert.equal(lifecycle.harnessTerminationConfirmed, true);

    const retained = await createRetainedBehaviorEvidence(summary.bundlePath);
    const typed = await createRetainedBehaviorEvidenceV2(summary.bundlePath);
    assert.equal(typed.dataset.operations.filter(op => op.identity.kind === "tool").length, 1);
    assert.ok(typed.dataset.operations.some(op => op.callEventIds.length && op.resultEventIds.length));
    assert.ok(typed.dataset.operations.every(op => op.issuingInference.status === "unknown"));
    const atif = await exportAntigravityAtif(summary.bundlePath, {sharingClass: "public", maxArtifactBytes: 8 * 1024 * 1024, maxStringBytes: 64 * 1024});
    assert.equal(inspectAtifBytes(Buffer.from(JSON.stringify(atif))).inspection.structural.status, "valid");
    assert.equal(JSON.stringify(atif).includes("PRIVATE-AGY"), false);

    assert.ok(retained.coverage.records.mapped > 0);
    const observations = await createRetainedStructuralObservationSet(summary.bundlePath);
    assert.ok(observations.occurrences?.some(o => o.type === "validation-run"));
    assert.deepEqual(observations.observations.find(o => o.extractor.id === "input-token-count")?.value, { status: "known", value: 100, unit: "tokens" });
    assert.deepEqual(observations.observations.find(o => o.extractor.id === "tool-operation-count")?.value, { status: "known", value: 1, unit: "identified-logical-tool-operations" });
    const policy = { sharingClass: "partner" as const, maxArtifactBytes: 8 * 1024 * 1024, maxStringBytes: 64 * 1024 };
    const exported = join(root, "export");
    const exportManifest = await createPortableRunBundleExport({ sourceRoot: summary.bundlePath, destinationRoot: exported, policy });
    await readPortableRunBundleExport(exported, policy);
    const exportedSession = await readFile(join(exported, exportManifest.artifacts.find(a => a.kind === "session")!.relativePath), "utf8");
    assert.equal(exportedSession.includes("PRIVATE-AGY-REASONING-SENTINEL"), false);
    assert.equal(exportedSession.includes("fixture-agy-conversation"), false);
    assert.equal(exportedSession.includes("fixture-child"), false);
    assert.equal(exportedSession.includes('"raw"'), false);
    assert.ok(exportedSession.includes("1 test passed"));
    const sanitized = sanitizeDerivedExport({ source: "antigravity-cli", payload: { step_type: "future_private_step", text_delta: "PRIVATE-SENTINEL", usage: { thinking_tokens: 7 } } }, policy);
    assert.equal(JSON.stringify(sanitized).includes("PRIVATE-SENTINEL"), false);
    const future = sanitizeDerivedExport({ source: "antigravity-cli", kind: "frame", payload: { event: "future_private_event", text: "PRIVATE-EVENT-SENTINEL" } }, policy);
    assert.equal(JSON.stringify(future).includes("PRIVATE-EVENT-SENTINEL"), false);
    assert.deepEqual(sanitizeDerivedExport({source: "other-harness", conversation_id: "other-id", payload: {step_type: "custom", text_delta: "visible"}}, policy),
      {source: "other-harness", conversation_id: "other-id", payload: {step_type: "custom", text_delta: "visible"}});

    const tampered = structuredClone(retained.capture) as Parameters<typeof qualifyRetainedAntigravityCapture>[0];
    const result = tampered.records.find(r => r.record.kind === "frame" && (r.record.payload as any)?.event === "result");
    (result!.record.payload as any).result.conversation_id = "foreign";
    assert.throws(() => qualifyRetainedAntigravityCapture(tampered, { sessionId: summary.sessionId, expectsCompletion: true, harnessVersion: ANTIGRAVITY_CLI_VERSION, runtimeVersions: [ANTIGRAVITY_CLI_VERSION] }), /foreign/u);
    await assert.rejects(runAntigravityQueueEntry({ ...queue, outputRoot: join(root, "runs"), attemptId: "a", probeRuntime: async path => ({ path, version: ANTIGRAVITY_CLI_VERSION }) }), /never replaced/u);
    await assert.rejects(runAntigravityQueueEntry({ ...queue, outputRoot: join(root, "other"), probeRuntime: async path => ({ path, version: "0.0.0" }) }), /RUNTIME_PROBE_MISMATCH/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Antigravity config validation pins its contract and CLI exposes both command names", async () => {
  const root = await temporaryRoot();
  try {
    for (const invalid of [{ ...configuration(root), kind: "harness" }, { schemaVersion: "ebo.antigravity-config/v1", kind: "harness", adapter: "antigravity-cli", executable: process.execPath, version: ANTIGRAVITY_CLI_VERSION, contractDigest: "sha256:" + "0".repeat(64) }]) {
      const bytes = Buffer.from(JSON.stringify(invalid)); await writeFile(join(root, "config.json"), bytes);
      assert.throws(() => resolveAntigravityConfigurationRecord(root, { locator: "config.json", digest: digestBytes(bytes) }, "harness"));
    }
    assert.ok(ANTIGRAVITY_CONTRACT_DIGEST.startsWith("sha256:"));
    for (const name of ["antigravity", "agy"]) {
      let output = ""; assert.equal(await main([name, "run"], text => { output += text; }), 1);
      assert.ok(output.includes("ebo antigravity run"));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Antigravity monitor uses final cumulative usage once and counts each native tool step once", async () => {
  const root = await temporaryRoot();
  try {
    const native = await capture(root);
    const bundle = join(root, "bundle"); await mkdir(bundle);
    await cp(join(root, "session.jsonl"), join(bundle, "session.jsonl"));
    await writeFile(join(bundle, "manifest.json"), JSON.stringify({ run: { harness: { version: ANTIGRAVITY_CLI_VERSION } }, terminal: { state: "completed" } }));
    const status = join(root, "status.json");
    await writeFile(status, JSON.stringify({ format: "ebo.campaign-status/v1", attempts: [{ id: "a", harness: "antigravity-cli", model, state: "finished", runBundles: "bundle" }] }));
    const monitor = createRunMonitor(status);
    const first = monitor.snapshot().attempts[0]!;
    assert.deepEqual(first.tokens, { prompt: 100, completion: 20, cached: 60, reasoning: 7 });
    assert.equal(first.native.toolCalls, 2, "one command and one subagent step despite repeated ACTIVE and DONE records");
    assert.equal(first.spend, null); assert.equal(first.requests.length, 0);
    assert.deepEqual(monitor.snapshot().attempts[0]!.tokens, first.tokens);
    assert.equal(JSON.stringify(first).includes("npm test"), false);
    assert.equal(native.terminalStatus, "completed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Antigravity Harbor worker executes in the real step workspace and keeps independent task assessment", async () => {
  const root = await temporaryRoot();
  try {
    const executable = join(root, "agy");
    // Exercise the production worker dispatch and runtime probe, without a test-only executor injection.
    await writeFile(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.5.9; elif [ "$1" = "--help" ]; then echo '--input-format --output-format --print-timeout'; else exec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' "$@"; fi\n`);
    await chmod(executable, 0o700);
    const { bundleRoot } = createQueueFixture(root, executable);
    const workspace = join(root, "harbor-workspace"); await mkdir(workspace); await writeFile(join(workspace, "seed.txt"), "seed\n");
    const instruction = "Create capture-proof.txt.", digest = digestBytes(Buffer.from(instruction));
    const config = Object.fromEntries(Object.entries({ model: "model", harness: "harness", nativeLimits: "limits", nativeToolPolicy: "tools", captureProfile: "capture" }).map(([key, file]) => {
      const locator = `configs/${file}.json`; return [key, { locator, digest: digestBytes(readFileSync(join(bundleRoot, locator))) }];
    })) as HarborWorkerInput["configuration"];
    const input: HarborWorkerInput = {
      prepared: { run: { id: "run-agy-harbor", attemptId: "attempt-agy-harbor", taskId: "task", modelId: model, harnessId: "antigravity-cli", trialIndex: 1 },
        task: { taskSourceId: "harbor-agy", harborDigest: digest.value, assessmentMode: "observational", snapshotDirectory: "", resolutionDigest: digest },
        steps: [{ index: 1, name: null, effectiveInstruction: instruction, instructionDigest: digest, minReward: null, verifierTimeoutSec: 10 }],
        environment: { profile: "local-fs-test", provider: "test", containerized: false, enforcement: "none", dockerImage: null, networkMode: "public" },
        verifier: { requested: false, environmentMode: null, timeoutSec: 10, multiStepRewardStrategy: "mean" }, budget: { coordinatorWallClockMs: 10000 },
        evidence: { attemptRoot: root, harborDir: root, stepsDir: root, workspaceDir: workspace, eboDir: root } },
      configuration: config, configurationRoot: bundleRoot, instruction, stepIndex: 1, workspacePath: workspace, outputRoot: join(root, "worker"), maxWallClockMs: 10000,
    };
    const result = await runHarborWorker(input);
    assert.equal(result.terminal.state, "completed", JSON.stringify(result));
    assert.equal(result.nativeSessionId, "fixture-agy-conversation");
    assert.equal(await readFile(join(workspace, "capture-proof.txt"), "utf8"), "done\n");
    const retained = await createRetainedBehaviorEvidence(join(root, "worker/bundle"));
    assert.ok(retained.coverage.records.mapped > 0);
    const manifest = JSON.parse(await readFile(join(root, "worker/bundle/manifest.json"), "utf8"));
    assert.equal(manifest.run.assessmentMode, "observational");
    assert.ok(manifest.run.runtime.some((r: any) => r.source === "Google" && r.name === "antigravity-cli"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

liveRuntimeTest("antigravity-cli")("opt-in Google-account Antigravity live capture", { skip: process.env.EBO_LIVE_ANTIGRAVITY_SMOKE !== "1" }, async () => {
  const root = await temporaryRoot();
  try {
    const runtime = await probeAntigravityRuntime(process.env.EBO_LIVE_ANTIGRAVITY_EXECUTABLE!);
    assert.equal(runtime.version, ANTIGRAVITY_CLI_VERSION);
    const result = await capture(root, "success", { configuration: { executable: runtime.path, version: ANTIGRAVITY_CLI_VERSION, model: process.env.EBO_LIVE_ANTIGRAVITY_MODEL ?? model, permissionMode: "always-proceed", sandbox: false, accountHome: process.env.EBO_LIVE_ANTIGRAVITY_ACCOUNT_HOME },
      prompt: "Synthetic test. Create capture-proof.txt with exactly done followed by a newline in the current directory, then reply DONE. Do nothing else.", signal: AbortSignal.timeout(120000), shutdownGraceMs: 3000 });
    assert.equal(result.terminalStatus, "completed", JSON.stringify(result.gaps));
    assert.equal(await readFile(join(root, "workspace/capture-proof.txt"), "utf8"), "done\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
