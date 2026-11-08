import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVerificationCatalog, snapshotVerification, evaluateVerification, verificationDigest } from "../src/harness-verification.js";

const digest = `sha256:${"1".repeat(64)}` as const;
const subject = { harness: "cursor-sdk", platform: "linux-x64", abi: "test-node-24", contractDigest: digest,
  components: [{ id: "cursor-sdk", name: "@cursor/sdk", version: "9.9.9", integrity: "sha512-Zml4dHVyZQ==" }] };

test("an admitted receipt refreshes a new snapshot without changing an existing freeze", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-verification-"));
  try {
    const before = snapshotVerification(subject, await readVerificationCatalog(root));
    assert.equal(evaluateVerification(before).state, "unverified");
    const payload = { schemaVersion: "ebo.harness-verification/v1", id: "authored-test-probe", createdAt: "2026-11-08T00:00:00Z", subject,
      scope: null, claims: { "runtime-probe": "checked", "module-api": "checked" },
      evidence: [{ kind: "probe", lockDigest: digest, launchDigest: digest }] };
    const receipt = { ...payload, digest: verificationDigest(payload) };
    const admissionPayload = { schemaVersion: "ebo.harness-verification-admission/v1", id: "test-admission", action: "admit",
      receiptDigest: receipt.digest, subjectDigest: verificationDigest({ subject, scope: null }), supersedes: [],
      operator: { id: "fixture-only", reason: "Authored catalog input for this deterministic test; never shipped as verification evidence." }, createdAt: "2026-11-08T00:00:00Z" };
    const admission = { ...admissionPayload, digest: verificationDigest(admissionPayload) };
    for (const directory of ["receipts", "admissions"]) await mkdir(join(root, directory));
    await writeFile(join(root, "receipts", `${receipt.digest.slice(7)}.json`), JSON.stringify(receipt));
    await writeFile(join(root, "admissions", `${admission.digest.slice(7)}.json`), JSON.stringify(admission));
    const after = snapshotVerification(subject, await readVerificationCatalog(root));
    assert.equal(evaluateVerification(after).state, "probe-checked");
    assert.equal(evaluateVerification(before).state, "unverified");
    assert.notEqual(after.digest, before.digest);
    const drift = snapshotVerification({ ...subject, components: [{ ...subject.components[0]!, version: "10.0.0" }] }, await readVerificationCatalog(root));
    assert.equal(evaluateVerification(drift).state, "unverified");
  } finally { await rm(root, { recursive: true, force: true }); }
});

import {appendVerificationAdmission, sealVerification, type HarnessVerificationReceipt, type VerificationHash} from "../src/harness-verification.js";
const operator = {id: "test-only", reason: "Authored catalog semantics fixture, not real verification evidence"};
const receipt = (id: string, result: "checked" | "failed"): HarnessVerificationReceipt => sealVerification({schemaVersion: "ebo.harness-verification/v1", id,
  createdAt: "2026-11-08T00:00:00Z", subject, scope: null, claims: {"runtime-probe": result}, evidence: [{kind: "probe", lockDigest: digest, launchDigest: digest}]});
test("conflicts abstain; explicit receipt supersession resolves them, and withdrawal never resurrects old evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-verification-history-"));
  try {
    const first = receipt("first", "checked"), conflict = receipt("conflict", "failed"), resolution = receipt("resolution", "checked");
    await appendVerificationAdmission(root, first, operator);
    const original = snapshotVerification(subject, await readVerificationCatalog(root));
    await appendVerificationAdmission(root, conflict, operator);
    let snapshot = snapshotVerification(subject, await readVerificationCatalog(root));
    assert.equal(evaluateVerification(snapshot).claims["runtime-probe"], "conflict");
    assert.equal(evaluateVerification(snapshot).state, "unverified");
    await appendVerificationAdmission(root, resolution, operator, [first.digest, conflict.digest]);
    snapshot = snapshotVerification(subject, await readVerificationCatalog(root));
    assert.deepEqual(snapshot.receipts.map(r => r.digest), [resolution.digest]);
    assert.equal(evaluateVerification(snapshot).state, "probe-checked");
    await appendVerificationAdmission(root, resolution, operator, [resolution.digest], "withdraw");
    snapshot = snapshotVerification(subject, await readVerificationCatalog(root));
    assert.equal(snapshot.receipts.length, 0);
    assert.equal(evaluateVerification(snapshot).state, "unverified");
    assert.equal(evaluateVerification(original).state, "probe-checked", "Historic snapshots remain immutable");
    await assert.rejects(appendVerificationAdmission(root, receipt("bogus-target", "checked"), operator, [`sha256:${"f".repeat(64)}` as VerificationHash]), /admitted receipt digests/);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("capture verification is capability-scoped and cannot be asserted by a probe or imported fixture", () => {
  assert.throws(() => {
    const {digest: _digest, ...payload} = receipt("fake-capture", "checked");
    const authored = sealVerification({...payload, claims: {readback: "checked"}});
    verificationApi.assertVerificationReceipt(authored);
  }, /Capture claims require/);
});
import * as verificationApi from "../src/harness-verification.js";

import {withVerificationContext} from "../src/verification-context.js";
import {versionConfidence} from "../src/retained-version-policy.js";
test("named capture claims are scoped; disagreements retain limitations even when another capability is checked", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-verification-scopes-"));
  try {
    const scope = {captureProfileDigest: digest, routeDigest: digest};
    const capture = (id: string, outcome: "checked" | "failed"): HarnessVerificationReceipt => {
      const {digest: _digest, ...payload} = receipt(id, "checked");
      return sealVerification({...payload, scope, claims: {...payload.claims, readback: "checked", "tool-call-result": outcome}, evidence: [...payload.evidence,
        ...(["success", "failure-recovery", "interruption"] as const).map(item => ({kind: "owned-capture" as const, case: item, lockDigest: digest, launchDigest: digest, manifestDigest: digest, datasetDigest: digest, runVerificationDigest: digest}))]});
    };
    await appendVerificationAdmission(root, capture("capture-positive", "checked"), operator);
    let snapshot = snapshotVerification(subject, await readVerificationCatalog(root));
    assert.equal(evaluateVerification(snapshot, scope).claims.readback, "checked");
    assert.equal(evaluateVerification(snapshot, {...scope, routeDigest: `sha256:${"2".repeat(64)}`}).claims.readback, "unverified");
    assert.equal(evaluateVerification(snapshot, {...scope, captureProfileDigest: `sha256:${"2".repeat(64)}`}).claims.readback, "unverified");
    await appendVerificationAdmission(root, capture("capture-negative", "failed"), operator);
    snapshot = snapshotVerification(subject, await readVerificationCatalog(root));
    withVerificationContext(snapshot, () => {
      assert.ok(versionConfidence("cursor-sdk", "9.9.9").includes("HARNESS_VERIFICATION_CONFLICT"));
      assert.ok(versionConfidence("cursor-sdk", "9.9.9").includes("HARNESS_CAPTURE_UNVERIFIED"));
      assert.ok(evaluateVerification(snapshot, scope).limitations.includes("HARNESS_VERIFICATION_CONFLICT"));
    }, scope, subject);
    for (const drift of [{...subject, abi: "other-abi"}, {...subject, platform: "other-platform"}, {...subject, contractDigest: `sha256:${"2".repeat(64)}`}, {...subject, components: [{...subject.components[0]!, integrity: "sha512-other"}]}]) {
      assert.equal(evaluateVerification(snapshotVerification(drift, await readVerificationCatalog(root)), scope).state, "unverified");
    }
  } finally {await rm(root, {recursive: true, force: true});}
});

import {cp, readFile} from "node:fs/promises";
import {createRetainedBehaviorEvidence} from "../src/retained-evidence.js";
import {validateBehaviorAssertion} from "../src/behavior-assertions.js";
import {digestBytes, digestMetadata} from "../src/artifacts.js";
test("unfamiliar native v1 projections keep the base dataset digest and retained assertions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-legacy-v1-annotations-"));
  try {
    await cp("test/fixtures/codex/legacy-0.150.1", root, {recursive: true});
    const path = join(root, "manifest.json"), manifest = JSON.parse(await readFile(path, "utf8"));
    for (const descriptor of manifest.evidence) if (/json/u.test(descriptor.mediaType)) {
      const target = join(root, descriptor.relativePath), bytes = Buffer.from((await readFile(target, "utf8")).replaceAll("0.150.1", "9000.1.0"));
      await writeFile(target, bytes); descriptor.digest = `sha256:${digestBytes(bytes).value}`; descriptor.sizeBytes = bytes.length;
    }
    await writeFile(path, JSON.stringify(manifest).replaceAll("0.150.1", "9000.1.0"));
    const evidence = await createRetainedBehaviorEvidence(root);
    const datasetDigest = `sha256:${digestMetadata(evidence.dataset).value}` as const;
    assert.equal(datasetDigest, "sha256:09326dff2707f2f5f015a4d7ec8287a2afebd96a38b0dbee8479d683a4b68afa", "Offline 55b187c interpretation of these exact public native records");
    assert.equal(evidence.verification?.state, "unverified");
    const assertion = {schemaVersion: "ebo.behavior-assertion/v1", id: "prior-annotation", runId: evidence.dataset.runId, attemptId: evidence.dataset.attemptId,
      dataset: {schemaVersion: evidence.dataset.schemaVersion, digest: datasetDigest}, behavior: {vocabularyVersion: "1.0.0", categoryId: "verification-completion", dimensionId: "verification-completion"},
      rubric: {id: "fixture", version: "1"}, evaluator: {id: "fixture", version: "1"},
      judgment: {disposition: "abstained", reason: "Fixture", rationale: "No semantic claim", alternativeExplanation: "Insufficient evidence", citations: []}} as const;
    await validateBehaviorAssertion(assertion, evidence.dataset, evidence.resolver, undefined, evidence.capture);
  } finally {await rm(root, {recursive: true, force: true});}
});
