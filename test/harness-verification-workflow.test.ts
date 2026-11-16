import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fakeSdkRuntimeOptions} from "./runtime-fixture-helper.js";
import {freezeStudyRuntimes, readStudyRuntimeLock} from "../src/study-runtimes.js";
import {prepareHarnessVerification, admitHarnessVerification, validateHarnessVerificationCandidate} from "../src/harness-verification-candidate.js";
import {evaluateVerification, runtimeVerificationSubject, runtimeExecutionVerificationSubject, verificationDigest} from "../src/harness-verification.js";
import {withStudyRuntime, runtimeExecutionSummary} from "../src/runtime-context.js";
import {createRunBundleAssembler} from "../src/run-bundles.js";
import {readRunVerification, createRunVerification} from "../src/verification-retained.js";
import {digestBytes} from "../src/artifacts.js";

test("probe admission updates new studies; old freezes and retained interpretations stay offline and immutable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-verification-workflow-"));
  try {
    const first = join(root, "first"), second = join(root, "second"), catalog = join(root, "catalog"), role = "cursor-sdk";
    const options = {...fakeSdkRuntimeOptions("9.9.9"), verificationCatalogRoot: catalog};
    await freezeStudyRuntimes(first, {studyId: "qualification", roles: [role]}, options);
    const frozenBytes = await readFile(join(first, "runtimes/lock.json"));
    const candidate = await prepareHarnessVerification({studyRoot: first, role}, options);
    assert.equal(candidate.receipt.claims["runtime-probe"], "checked");
    assert.equal(candidate.receipt.claims["module-api"], "checked");
    assert.equal(candidate.receipt.claims.readback, undefined, "A no-inference probe cannot certify native capture");
    await assert.rejects(admitHarnessVerification(catalog, structuredClone(candidate), {id: "test", reason: "unvalidated copy"}), /SOURCE_VALIDATION_REQUIRED/);
    const reloaded = await validateHarnessVerificationCandidate(structuredClone(candidate), options);
    await admitHarnessVerification(catalog, reloaded, {id: "test-only", reason: "Authored registry boundary fixture; never shipped as real verification evidence"});
    const fresh = await freezeStudyRuntimes(second, {studyId: "new-study", roles: [role]}, options);
    const snapshot = fresh.groups[0]!.verification![role]!;
    const group = fresh.groups[0]!, abiDrift = {...group, plan: {...group.plan, abi: "node-26.0.0-modules-150"}};
    assert.notEqual(verificationDigest(runtimeVerificationSubject(role, group)), verificationDigest(runtimeVerificationSubject(role, abiDrift)), "The same dependency graph at another ABI needs separate verification");
    assert.equal(runtimeExecutionVerificationSubject(role, abiDrift)!.abi, group.plan.abi, "A launch records the Node ABI actually executing, independently of the frozen declaration");
    assert.equal(evaluateVerification(snapshot).state, "probe-checked");
    assert.deepEqual(await readFile(join(first, "runtimes/lock.json")), frozenBytes);
    assert.equal(evaluateVerification((await readStudyRuntimeLock(first)).groups[0]!.verification![role]).state, "unverified");
    await withStudyRuntime({studyRoot: second, role, options}, async () => {
      const summary = runtimeExecutionSummary()!;
      assert.equal(summary.verification?.state, "probe-checked");
      assert.ok(summary.warnings.some(warning => warning.startsWith("HARNESS_CAPTURE_UNVERIFIED:")));
    });
    let retained: any;
    await withStudyRuntime({studyRoot: first, role, options}, async () => {
      const fixture = JSON.parse(await readFile("test/fixtures/run-bundles/complete/manifest.json", "utf8"));
      fixture.run.harness.id = role; delete fixture.run.native;
      const assembler = await createRunBundleAssembler({...fixture, bundleRoot: join(root, "bundle")});
      retained = assembler.currentManifest();
    });
    await rm(catalog, {recursive: true}); await rm(first, {recursive: true});
    const record = readRunVerification(join(root, "bundle"), retained)!;
    assert.equal(record.result.state, "unverified");
    const foreign = createRunVerification(snapshot.subject, snapshot, record.scope);
    const bytes = Buffer.from(JSON.stringify(foreign));
    const descriptor = retained.evidence.find((d: any) => d.id === "harness-verification");
    await writeFile(join(root, "bundle", descriptor.relativePath), bytes);
    Object.assign(descriptor, {digest: `sha256:${digestBytes(bytes).value}`, sizeBytes: bytes.length});
    assert.throws(() => readRunVerification(join(root, "bundle"), retained), /HARNESS_VERIFICATION.*(?:binding|frozen|snapshot)/i, "A self-consistent receipt from another freeze cannot promote retained confidence");
  } finally {await rm(root, {recursive: true, force: true});}
});

test("catalog confidence clears an unfamiliar runtime independently of its historical v1 annotation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-verification-v1-boundary-"));
  const options = fakeSdkRuntimeOptions("9.9.9"), install = options.run;
  options.run = async (command, args, cwd) => {
    const result = await install(command, args, cwd);
    if (args[0] === "ci") {
      const path = join(cwd, "node_modules/@anthropic-ai/claude-agent-sdk/index.js");
      await writeFile(path, (await readFile(path, "utf8")).replace("HOOK_EVENTS=[]", 'HOOK_EVENTS=["SessionStart"]'));
    }
    return result;
  };
  try {
    const qualification = join(root, "qualification"), research = join(root, "research"), catalog = join(root, "catalog"), role = "claude-agent-sdk";
    await freezeStudyRuntimes(qualification, {studyId: "qualification", roles: [role]}, options);
    const candidate = await prepareHarnessVerification({studyRoot: qualification, role}, options);
    await admitHarnessVerification(catalog, candidate, {id: "test-only", reason: "Authored SDK boundary fixture; never production verification"});
    await freezeStudyRuntimes(research, {studyId: "research", roles: [role]}, {...options, verificationCatalogRoot: catalog});
    const {mkdir} = await import("node:fs/promises"); const workspace = join(root, "workspace"); await mkdir(workspace);
    const fixture = JSON.parse(await readFile("test/fixtures/run-bundles/complete/manifest.json", "utf8"));
    delete fixture.run.native; delete fixture.run.verifier; fixture.run.assessmentMode = "observational";
    const {captureClaudeAgentSdkRun} = await import("../src/agent-sdk-run.js");
    const bundleRoot = join(root, "bundle");
    await captureClaudeAgentSdkRun({definition: {...fixture, bundleRoot}, runtime: {studyRoot: research, options}, startingWorkspacePath: workspace,
      workspace: {setup: async () => ({status: "ready", path: workspace, artifactId: "workspace", retained: true})},
      configuration: {prompt: "Fixture", model: fixture.run.model.id, tools: [], permissionMode: "dontAsk"}, expectedHooks: ["SessionStart"],
      query: input => ({close() {}, async *[Symbol.asyncIterator]() {
        await input.options?.hooks?.SessionStart?.[0]?.hooks[0]?.({hook_event_name: "SessionStart", session_id: "s", transcript_path: "/fixture/session.jsonl", cwd: workspace, source: "startup"} as any, undefined, {signal: new AbortController().signal});
        yield {type: "result", session_id: "s", uuid: "r", subtype: "success", duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, stop_reason: null, total_cost_usd: 0, usage: {input_tokens: 1, output_tokens: 1}, modelUsage: {}, permission_denials: [], result: "Fixture"} as any;
      }}),
    });
    const {createRetainedBehaviorEvidence} = await import("../src/retained-evidence.js"), legacy = await createRetainedBehaviorEvidence(bundleRoot);
    assert.ok(legacy.dataset.capabilityProfile.limitations?.includes("HARNESS_VERSION_UNVERIFIED"), "Serialized historical v1 annotation");
    assert.equal(legacy.verification?.state, "probe-checked", "Current admitted confidence is independent of historical rendering");
    const {createRetainedBehaviorEvidenceV2} = await import("../src/native-v2.js"), native = await createRetainedBehaviorEvidenceV2(bundleRoot);
    assert.ok(!native.dataset.sources[0]!.limitations?.includes("HARNESS_VERSION_UNVERIFIED"));
    assert.ok(native.dataset.sources[0]!.limitations?.includes("HARNESS_CAPTURE_UNVERIFIED"));
  } finally {await rm(root, {recursive: true, force: true});}
});

test("admission repeats live security checks rather than treating a prior probe as a security exemption", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-verification-security-")), options = fakeSdkRuntimeOptions("9.9.9");
  try {
    await freezeStudyRuntimes(root, {studyId: "qualification", roles: ["cursor-sdk"]}, options);
    const candidate = await prepareHarnessVerification({studyRoot: root, role: "cursor-sdk"}, options);
    options.query = async () => ({vulns: [{id: "MAL-fixture"}]});
    await assert.rejects(admitHarnessVerification(join(root, "catalog"), candidate, {id: "test-only", reason: "Malicious-package regression"}), /RUNTIME_MALICIOUS/);
  } finally {await rm(root, {recursive: true, force: true});}
});
