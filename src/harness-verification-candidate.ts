import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { digestBytes, assertNoDuplicateJsonKeys, canonicalizeMetadata } from "./artifacts.js";
import { withStudyRuntime, currentStudyRuntime, probeLockedRuntimeExecutable, recordRuntimeProbe } from "./runtime-context.js";
import { readStudyRuntimeLock, type StudyRuntimeOptions } from "./study-runtimes.js";
import {readOpenHandsServerInfo} from "./openhands.js";
import { withLockedOpenHandsServer } from "./openhands-runtime.js";
import { createRetainedBehaviorEvidenceV2 } from "./native-v2.js";
import { datasetV2Digest, precedes } from "./normalization-v2.js";
import { readRunVerification } from "./verification-retained.js";
import { sealVerification, verificationDigest, runtimeExecutionVerificationSubject, assertVerificationReceipt, appendVerificationAdmission,
  readVerificationCatalog,
  VerificationError, type HarnessVerificationReceipt, type VerificationProof, type VerificationScope, type VerificationAdmission, type VerificationHash,
  type VerificationClaim, type VerificationClaimResult } from "./harness-verification.js";
import { readBoundedFile } from "./scheduler.js";
import type { RunManifest } from "./run-bundles.js";
import { resolveBundleArtifact } from "./contracts.js";

export type VerificationCase = {kind: "owned-capture"; case: "success" | "failure-recovery" | "interruption"; bundleRoot: string};
export type VerificationRequest = {studyRoot: string; role: string; cases?: VerificationCase[]};
export type VerificationCandidate = {schemaVersion: "ebo.harness-verification-candidate/v1"; request: VerificationRequest; receipt: HarnessVerificationReceipt; digest: VerificationHash};
const prepared = new WeakMap<object, {digest: VerificationHash; options: StudyRuntimeOptions}>();
const rawHash = (bytes: Uint8Array): VerificationHash => `sha256:${digestBytes(bytes).value}`;
const json = (path: string) => {const text = readBoundedFile(path, "Harness verification input", undefined, 4 * 1024 * 1024).toString("utf8"); assertNoDuplicateJsonKeys(text); return JSON.parse(text);};
function assertRequest(value: VerificationRequest): void {
  if (!value || typeof value !== "object" || Object.keys(value).some(key => !["studyRoot", "role", "cases"].includes(key))
      || typeof value.studyRoot !== "string" || !value.studyRoot.trim() || typeof value.role !== "string") throw new VerificationError("HARNESS_VERIFICATION_REQUEST_INVALID", "A frozen qualification study and native harness role are required.");
  if (value.cases !== undefined && (!Array.isArray(value.cases) || value.cases.length !== 3
      || value.cases.some(item => !item || typeof item !== "object" || item.kind !== "owned-capture" || !["success", "failure-recovery", "interruption"].includes(item.case) || typeof item.bundleRoot !== "string" || Object.keys(item).some(key => !["kind", "case", "bundleRoot"].includes(key)))
      || new Set(value.cases.map(item => item.case)).size !== 3 || new Set(value.cases.map(item => resolve(item.bundleRoot))).size !== 3)) throw new VerificationError("HARNESS_VERIFICATION_CAPTURE_REQUIRED", "Capture verification requires three distinct owned success, failure-recovery and interruption bundles. Authored and imported fixtures are not capture verification.");
}
async function inspectCases(request: VerificationRequest, subject: HarnessVerificationReceipt["subject"]): Promise<{scope: VerificationScope | null; claims: HarnessVerificationReceipt["claims"]; evidence: VerificationProof[]}> {
  let scope: VerificationScope | null = null;
  const claims: HarnessVerificationReceipt["claims"] = {}, evidence: VerificationProof[] = [];
  for (const item of request.cases ?? []) {
    const manifestBytes = readBoundedFile(join(item.bundleRoot, "manifest.json"), "Qualification manifest");
    const manifest = json(join(item.bundleRoot, "manifest.json")) as RunManifest;
    if (!['run-manifest/v1', 'run-manifest/v2'].includes(manifest.schemaVersion)) throw new VerificationError("HARNESS_VERIFICATION_CAPTURE_REQUIRED", "Imported trajectories cannot establish native capture verification.");
    const recorded = readRunVerification(item.bundleRoot, manifest);
    if (!recorded || !recorded.scope || verificationDigest(recorded.subject) !== verificationDigest(subject) || !manifest.runtimeLock) throw new VerificationError("HARNESS_VERIFICATION_CAPTURE_BINDING", "A capture must retain the exact runtime, platform, format contract and scope being verified.");
    if (scope && verificationDigest(scope) !== verificationDigest(recorded.scope)) throw new VerificationError("HARNESS_VERIFICATION_SCOPE_MISMATCH", "The cases differ in capture profile or model/provider route.");
    scope = recorded.scope;
    const native = await createRetainedBehaviorEvidenceV2(item.bundleRoot);
    if (native.dataset.origin.kind !== "owned" || native.dataset.events.length === 0) throw new VerificationError("HARNESS_VERIFICATION_CAPTURE_REQUIRED", "Readable owned native records are required.");
    if (item.case === "interruption" ? manifest.terminal.state !== "interrupted" : manifest.terminal.state !== "completed") throw new VerificationError("HARNESS_VERIFICATION_CASE_MISMATCH", "The recorded terminal does not match its qualification case.");
    const operations = native.dataset.operations.filter(op => op.identity.kind === "tool"), events = new Map(native.dataset.events.map(event => [event.id, event]));
    const paired = operations.filter(op => op.callEventIds.length > 0 && op.resultEventIds.length > 0);
    const checked = (claim: VerificationClaim, present: boolean): void => {
      if (["session-identity", "teardown"].includes(claim)) claims[claim] = present && claims[claim] !== "unavailable" ? "checked" : "unavailable";
      else if (present) claims[claim] = "checked"; else claims[claim] ??= "unavailable";
    };
    checked("readback", true); checked("session-identity", Boolean(manifest.run.native?.sessionId));
    checked("tool-call-result", paired.length > 0);
    checked("workspace", Boolean(manifest.terminal.workspaceArtifactId && manifest.evidence.some(d => d.id === manifest.terminal.workspaceArtifactId && d.kind === "workspace")));
    checked("usage", native.dataset.events.some(event => event.facts.resource && Object.keys(event.facts.resource.values).length > 0));
    checked("hooks", native.dataset.events.some(event => /hook/iu.test(event.source.nativeType)));
    if (item.case === "success") checked("terminal", manifest.terminal.state === "completed");
    const descriptor = manifest.evidence.find(d => d.id === "capture-lifecycle" && d.source === "ebo-runtime" && d.kind === "diagnostic" && d.sharingClass === "internal");
    const lifecycle = descriptor ? JSON.parse(resolveBundleArtifact(item.bundleRoot, {locator: descriptor.relativePath, digest: {algorithm: "sha256", value: descriptor.digest.slice(7)}}).toString("utf8")) : undefined;
    const drained = lifecycle?.schemaVersion === "ebo.capture-lifecycle/v1" && lifecycle.runId === manifest.run.id && lifecycle.attemptId === manifest.attempt.id
      && lifecycle.terminal?.state === manifest.terminal.state && lifecycle.lifecycle?.state === "terminal" && lifecycle.capture?.status === "complete"
      && lifecycle.cleanup?.status === "completed" && lifecycle.harnessTerminationConfirmed === true;
    checked("teardown", drained);
    if (item.case === "interruption") checked("interruption", drained && lifecycle.lifecycle.transitions.some((transition: any) => transition.to === "running")
      && operations.some(op => op.callEventIds.length > 0) && native.dataset.events.some(event => ["message", "tool", "inference"].includes(event.family)));
    if (item.case === "failure-recovery") checked("failure-follow-up", paired.some(failed => failed.failure.status === "known" && failed.failure.value === true
      && paired.some(next => next.failure.status === "known" && next.failure.value === false
        && failed.issuingInference.status === "known" && next.issuingInference.status === "known"
        && failed.issuingInference.value.scope === next.issuingInference.value.scope && failed.issuingInference.value.id !== next.issuingInference.value.id
        && failed.resultEventIds.some(end => next.callEventIds.some(start => precedes(events.get(end)!, events.get(start)!) === "before")))));
    const launchDescriptor = manifest.evidence.find(d => d.id === manifest.runtimeLock!.launchArtifactId)!;
    evidence.push({kind: "owned-capture", case: item.case, manifestDigest: rawHash(manifestBytes), datasetDigest: datasetV2Digest(native.dataset),
      runVerificationDigest: recorded.digest, lockDigest: manifest.runtimeLock.lockDigest, launchDigest: launchDescriptor.digest});
  }
  return {scope, claims, evidence};
}
/** This command loads/probes installed software; it never starts a model turn. */
export async function prepareHarnessVerification(request: VerificationRequest, options: StudyRuntimeOptions = {}): Promise<VerificationCandidate> {
  assertRequest(request);
  request = {...request, studyRoot: resolve(request.studyRoot), ...(request.cases ? {cases: request.cases.map(item => ({...item, bundleRoot: resolve(item.bundleRoot)}))} : {})};
  const lock = await readStudyRuntimeLock(request.studyRoot), group = lock.groups.find(g => g.roles.includes(request.role));
  const subject = group && runtimeExecutionVerificationSubject(request.role, group);
  if (!subject) throw new VerificationError("HARNESS_VERIFICATION_ROLE_INVALID", "Only the eight maintained native harnesses have capture verification records.");
  return withStudyRuntime({...request, options}, async () => {
    const context = currentStudyRuntime()!;
    for (const root of context.launch.roots) if (root.executable) await probeLockedRuntimeExecutable(root.id);
    if (request.role === "openhands-agent-server") {
      const sessionApiKey = randomUUID();
      await withLockedOpenHandsServer({sessionApiKey}, async server => {
        const info = await readOpenHandsServerInfo((url, init) => (options.fetch ?? fetch)(String(url), init), server.baseUrl, sessionApiKey, 1024 * 1024, undefined, 30_000);
        if (typeof info.version !== "string") throw new VerificationError("HARNESS_VERIFICATION_API_FAILED", "OpenHands server-info has no version.");
        await recordRuntimeProbe("openhands", info.version, "server-info"); (context.launch.contractChecks ??= []).push("openhands/server_info");
      });
    }
    const cases = await inspectCases(request, subject);
    const claims: Partial<Record<VerificationClaim, VerificationClaimResult>> = {installation: "checked",
      "runtime-probe": context.launch.roots.every(root => context.probes.some(probe => probe.componentId === root.id && probe.actualVersion === probe.expectedVersion)) ? "checked" : "unavailable",
      "module-api": (context.launch.contractChecks?.length ?? 0) > 0 ? "checked" : "unavailable", ...cases.claims};
    // recordRuntimeProbe writes executable probes; SDK-only roles retain their initial receipt.
    const receiptPath = join(request.studyRoot, context.launch.receiptLocator);
    await writeFile(receiptPath, canonicalizeMetadata({...context.launch, probes: context.probes, executions: context.executions ?? [], status: "probed"}), {mode: 0o600});
    const receipt = sealVerification({schemaVersion: "ebo.harness-verification/v1" as const, id: randomUUID(), createdAt: new Date().toISOString(), subject, scope: cases.scope, claims,
      evidence: [{kind: "probe" as const, lockDigest: lock.digest, launchDigest: rawHash(await readFile(receiptPath))}, ...cases.evidence]});
    assertVerificationReceipt(receipt);
    const candidate = sealVerification({schemaVersion: "ebo.harness-verification-candidate/v1" as const, request: structuredClone(request), receipt});
    prepared.set(candidate, {digest: candidate.digest, options}); return candidate;
  });
}
/** Reloaded candidates regain admission authority only after source validation and fresh launch security checks. */
export async function validateHarnessVerificationCandidate(value: unknown, options: StudyRuntimeOptions = {}): Promise<VerificationCandidate> {
  const candidate = value as VerificationCandidate;
  if (!candidate || candidate.schemaVersion !== "ebo.harness-verification-candidate/v1") throw new VerificationError("HARNESS_VERIFICATION_INVALID", "Unsupported candidate.");
  const {digest, ...body} = candidate;
  if (verificationDigest(body) !== digest) throw new VerificationError("HARNESS_VERIFICATION_INVALID", "Candidate bytes differ from their identity.");
  assertRequest(candidate.request); assertVerificationReceipt(candidate.receipt);
  const lock = await readStudyRuntimeLock(candidate.request.studyRoot), group = lock.groups.find(g => g.roles.includes(candidate.request.role));
  const subject = group && runtimeExecutionVerificationSubject(candidate.request.role, group);
  if (!subject || verificationDigest(subject) !== verificationDigest(candidate.receipt.subject)) throw new VerificationError("HARNESS_VERIFICATION_CAPTURE_BINDING", "Candidate runtime or current capture contract differs.");
  const probeProof = candidate.receipt.evidence.find(proof => proof.kind === "probe")!;
  const files = await import("node:fs/promises").then(fs => fs.readdir(join(candidate.request.studyRoot, "runtimes/launches")));
  let original: any;
  for (const file of files) {const bytes = readBoundedFile(join(candidate.request.studyRoot, "runtimes/launches", file), "Probe receipt"); if (rawHash(bytes) === probeProof.launchDigest) {original = JSON.parse(bytes.toString()); break;}}
  if (!original || original.status !== "probed" || original.lockDigest !== lock.digest || probeProof.lockDigest !== lock.digest || original.role !== candidate.request.role
      || verificationDigest(original.verificationSubject) !== verificationDigest(subject)) throw new VerificationError("HARNESS_VERIFICATION_PROBE_MISSING", "The original digest-bound probe receipt is missing or belongs to another runtime.");
  const cases = await inspectCases(candidate.request, subject);
  const claims = {installation: "checked", "runtime-probe": group!.roots.every(root => original.probes?.some((probe: any) => probe.componentId === root.id && probe.actualVersion === probe.expectedVersion && probe.expectedVersion === root.selection.release.version)) ? "checked" : "unavailable",
    "module-api": (original.contractChecks?.length ?? 0) > 0 ? "checked" : "unavailable", ...cases.claims};
  if (verificationDigest(claims) !== verificationDigest(candidate.receipt.claims) || verificationDigest(cases.scope) !== verificationDigest(candidate.receipt.scope)
      || verificationDigest(cases.evidence) !== verificationDigest(candidate.receipt.evidence.filter(proof => proof.kind === "owned-capture"))) throw new VerificationError("HARNESS_VERIFICATION_SOURCE_CHANGED", "Verification claims no longer reproduce from retained evidence.");
  // The fresh launch still enforces integrity, withdrawal and OSV policy; it never rewrites the candidate.
  await withStudyRuntime({...candidate.request, options}, async () => undefined);
  prepared.set(candidate, {digest: candidate.digest, options}); return candidate;
}
export async function admitHarnessVerification(root: string, candidate: VerificationCandidate, operator: VerificationAdmission["operator"], supersedes: VerificationHash[] = []): Promise<VerificationAdmission> {
  const authority = prepared.get(candidate);
  if (!authority || authority.digest !== candidate.digest || verificationDigest((({digest: _digest, ...body}) => body)(candidate)) !== authority.digest) throw new VerificationError("HARNESS_VERIFICATION_SOURCE_VALIDATION_REQUIRED", "Reloaded or changed candidates require source validation before admission.");
  await validateHarnessVerificationCandidate(candidate, authority.options);
  return appendVerificationAdmission(root, candidate.receipt, operator, supersedes);
}
export async function withdrawHarnessVerification(root: string, receiptDigests: VerificationHash[], operator: VerificationAdmission["operator"]): Promise<VerificationAdmission> {
  const catalog = await readVerificationCatalog(root), receipt = catalog.receipts.find(receipt => receipt.digest === receiptDigests[0]);
  if (!receipt || !receiptDigests.length) throw new VerificationError("HARNESS_VERIFICATION_INVALID", "Withdrawal requires explicit admitted receipt digests for one subject and scope.");
  return appendVerificationAdmission(root, receipt, operator, receiptDigests, "withdraw");
}
