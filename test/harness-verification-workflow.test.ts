import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fakeSdkRuntimeOptions} from "./runtime-fixture-helper.js";
import {freezeStudyRuntimes, readStudyRuntimeLock} from "../src/study-runtimes.js";
import {prepareHarnessVerification, admitHarnessVerification, validateHarnessVerificationCandidate} from "../src/harness-verification-candidate.js";
import {evaluateVerification} from "../src/harness-verification.js";
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
