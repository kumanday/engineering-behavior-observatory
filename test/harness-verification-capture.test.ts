import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createConformanceRuntimeFixture} from "./with-runtime-fixture.js";
import {captureClaudeAgentSdkRun} from "../src/agent-sdk-run.js";
import {prepareHarnessVerification, admitHarnessVerification, validateHarnessVerificationCandidate, type VerificationCase} from "../src/harness-verification-candidate.js";
import {freezeStudyRuntimes} from "../src/study-runtimes.js";
import {evaluateVerification, sealVerification} from "../src/harness-verification.js";
import {digestBytes} from "../src/artifacts.js";

// These are authored SDK I/O fixtures. They test admission mechanics and never seed a production catalog.
test("owned capture qualification checks linked tools, recovery, lifecycle and offline readback without promoting missing facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-verification-captures-")), runtime = await createConformanceRuntimeFixture("claude-agent-sdk");
  try {
    const cases: VerificationCase[] = [];
    for (const kind of ["success", "failure-recovery", "interruption"] as const) {
      const bundleRoot = join(root, kind), workspace = join(root, `workspace-${kind}`); await mkdir(workspace);
      const fixture = JSON.parse(await readFile("test/fixtures/run-bundles/complete/manifest.json", "utf8"));
      delete fixture.run.native; delete fixture.run.verifier; fixture.run.assessmentMode = "observational";
      fixture.run.id = kind; fixture.attempt.id = kind; fixture.configuration.captureProfileDigest = `sha256:${"1".repeat(64)}`;
      const controller = new AbortController();
      const messages = [
        {type: "assistant", uuid: "first", message: {id: "inference-first", role: "assistant", content: [{type: "tool_use", id: "call-1", name: "Bash", input: {command: "fixture-check"}}]}},
        {type: "user", uuid: "result-first", message: {role: "user", content: [{type: "tool_result", tool_use_id: "call-1", is_error: kind === "failure-recovery", content: "fixture result"}]}},
        ...kind === "failure-recovery" ? [
          {type: "assistant", uuid: "next", message: {id: "inference-next", role: "assistant", content: [{type: "tool_use", id: "call-2", name: "Bash", input: {command: "fixture-follow-up"}}]}},
          {type: "user", uuid: "result-next", message: {role: "user", content: [{type: "tool_result", tool_use_id: "call-2", is_error: false, content: "fixture success"}]}},
        ] : [],
      ];
      const result = await captureClaudeAgentSdkRun({definition: {...fixture, bundleRoot}, runtime, startingWorkspacePath: workspace,
        workspace: {setup: async () => ({status: "ready", path: workspace, artifactId: "workspace", retained: true}), cleanup: async () => {}},
        configuration: {prompt: "Authored verification test only", model: fixture.run.model.id, tools: ["Bash"], permissionMode: "dontAsk"},
        expectedHooks: ["SessionStart"], signal: controller.signal,
        query: input => ({close() {}, async *[Symbol.asyncIterator]() {
          await input.options?.hooks?.SessionStart?.[0]?.hooks[0]?.({hook_event_name: "SessionStart", session_id: "s", transcript_path: "/fixture/session.jsonl", cwd: workspace, source: "startup"} as any, undefined, {signal: new AbortController().signal});
          for (const message of messages) {yield {...message, session_id: "s", parent_tool_use_id: null} as any; if (kind === "interruption") {controller.abort(); return;}}
          yield {type: "result", session_id: "s", uuid: "terminal", subtype: "success", duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, stop_reason: null, total_cost_usd: 0, usage: {input_tokens: 1, output_tokens: 1}, modelUsage: {}, permission_denials: [], result: "Fixture"} as any;
        }}),
      });
      assert.equal(result.manifest.terminal.state, kind === "interruption" ? "interrupted" : "completed");
      cases.push({kind: "owned-capture", case: kind, bundleRoot});
    }
    const request = {studyRoot: runtime.studyRoot, role: "claude-agent-sdk", cases};
    const candidate = await prepareHarnessVerification(request, runtime.options);
    assert.equal(candidate.receipt.claims["tool-call-result"], "checked");
    assert.equal(candidate.receipt.claims["failure-follow-up"], "checked");
    assert.equal(candidate.receipt.claims.interruption, "checked");
    assert.equal(candidate.receipt.claims.teardown, "unavailable", "Ordinary SDK completion does not separately confirm process termination");
    const catalog = join(root, "test-only-catalog");
    await admitHarnessVerification(catalog, candidate, {id: "fixture-only", reason: "Authored SDK fixture testing mechanics; never real harness verification"});
    const lock = await freezeStudyRuntimes(join(root, "research"), {studyId: "test-only", roles: ["claude-agent-sdk"]}, {...runtime.options, verificationCatalogRoot: catalog});
    assert.equal(evaluateVerification(lock.groups[0]!.verification!["claude-agent-sdk"], candidate.receipt.scope).state, "capture-checked");
    await assert.rejects(prepareHarnessVerification({...request, cases: cases.map(item => ({...item, kind: "imported"})) as any}, runtime.options), /CAPTURE_REQUIRED/);
    const {digest: _digest, ...payload} = candidate;
    const changed = sealVerification({...payload, receipt: {...candidate.receipt, claims: {...candidate.receipt.claims, "module-api": "failed"}}});
    await assert.rejects(validateHarnessVerificationCandidate(changed, runtime.options), /HARNESS_VERIFICATION/);
    // A terminal label alone cannot verify interrupt/drain behavior.
    const interrupted = cases.find(item => item.case === "interruption")!, path = join(interrupted.bundleRoot, "manifest.json"), manifest = JSON.parse(await readFile(path, "utf8"));
    const descriptor = manifest.evidence.find((d: any) => d.id === "capture-lifecycle"), lifecyclePath = join(interrupted.bundleRoot, descriptor.relativePath);
    const lifecycle = JSON.parse(await readFile(lifecyclePath, "utf8")); lifecycle.harnessTerminationConfirmed = false;
    const bytes = Buffer.from(JSON.stringify(lifecycle)); await writeFile(lifecyclePath, bytes);
    Object.assign(descriptor, {digest: `sha256:${digestBytes(bytes).value}`, sizeBytes: bytes.length}); await writeFile(path, JSON.stringify(manifest));
    const limited = await prepareHarnessVerification(request, runtime.options);
    assert.equal(limited.receipt.claims.interruption, "unavailable");
    assert.equal(limited.receipt.claims.teardown, "unavailable");
    await assert.rejects(validateHarnessVerificationCandidate(candidate, runtime.options), /SOURCE_CHANGED/);
  } finally {await rm(root, {recursive: true, force: true}); await rm(runtime.studyRoot, {recursive: true, force: true});}
});
