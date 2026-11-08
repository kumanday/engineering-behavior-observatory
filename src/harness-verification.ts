import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { digestMetadata, assertNoDuplicateJsonKeys, writeMetadataAtomicallyIfAbsentSync } from "./artifacts.js";
import { readBoundedFile } from "./scheduler.js";
import { listRuntimeRecipes } from "./runtime-catalog.js";

export type VerificationHash = `sha256:${string}`;
export const VERIFICATION_CLAIMS = ["installation", "runtime-probe", "module-api", "readback", "session-identity", "tool-call-result", "workspace", "usage", "failure-follow-up", "interruption", "hooks", "terminal", "teardown"] as const;
export type VerificationClaim = typeof VERIFICATION_CLAIMS[number];
export type VerificationClaimResult = "checked" | "failed" | "unavailable";
export type VerificationSubject = { harness: string; platform: string; contractDigest: VerificationHash;
  components: Array<{ id: string; name: string; version: string; integrity: string }> };
export type VerificationScope = { captureProfileDigest: VerificationHash; routeDigest: VerificationHash };
export type VerificationProof = { kind: "probe" | "owned-capture"; lockDigest: VerificationHash; launchDigest: VerificationHash;
  case?: "success" | "failure-recovery" | "interruption"; manifestDigest?: VerificationHash; datasetDigest?: VerificationHash; runVerificationDigest?: VerificationHash };
export type HarnessVerificationReceipt = { schemaVersion: "ebo.harness-verification/v1"; id: string; createdAt: string;
  subject: VerificationSubject; scope: VerificationScope | null; claims: Partial<Record<VerificationClaim, VerificationClaimResult>>;
  evidence: VerificationProof[]; digest: VerificationHash };
export type VerificationAdmission = { schemaVersion: "ebo.harness-verification-admission/v1"; id: string; action: "admit" | "withdraw";
  receiptDigest: VerificationHash; subjectDigest: VerificationHash; supersedes: VerificationHash[];
  operator: { id: string; reason: string }; createdAt: string; digest: VerificationHash };
export type VerificationCatalog = { receipts: HarnessVerificationReceipt[]; admissions: VerificationAdmission[] };
export type VerificationSnapshot = { schemaVersion: "ebo.harness-verification-snapshot/v1"; subject: VerificationSubject;
  catalogDigest: VerificationHash; receipts: HarnessVerificationReceipt[]; admissions: VerificationAdmission[]; digest: VerificationHash };
export type VerificationResult = { state: "unverified" | "probe-checked" | "capture-checked";
  claims: Record<VerificationClaim, "checked" | "unverified" | "conflict">; receiptDigests: VerificationHash[];
  admissionDigests: VerificationHash[]; limitations: string[]; snapshotDigest: VerificationHash | null };
export class VerificationError extends Error { constructor(public code: string, message: string) { super(`${code}: ${message}`); } }
export const verificationDigest = (value: unknown): VerificationHash => `sha256:${digestMetadata(value).value}`;
export function sealVerification<T extends object>(value: T): T & {digest: VerificationHash} { return {...value, digest: verificationDigest(value)}; }
const hashPattern = /^sha256:[a-f0-9]{64}$/u;
const probeClaims = new Set<VerificationClaim>(["installation", "runtime-probe", "module-api"]);
const fail = (message: string): never => { throw new VerificationError("HARNESS_VERIFICATION_INVALID", message); };
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : fail("Expected an object.");
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 2048;
function keys(value: Record<string, any>, allowed: readonly string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) fail("Unexpected verification field."); }
function sealed(value: unknown, schema: string, allowed: string[]): Record<string, any> {
  const document = object(value); keys(document, ["schemaVersion", "digest", ...allowed]);
  const {digest, ...payload} = document;
  if (document.schemaVersion !== schema || !hashPattern.test(digest) || digest !== verificationDigest(payload)) fail(`Invalid ${schema} identity.`);
  return document;
}
export function canonicalVerificationSubject(value: unknown): VerificationSubject {
  const subject = object(value); keys(subject, ["harness", "platform", "contractDigest", "components"]);
  if (!listRuntimeRecipes().some(recipe => recipe.harness === subject.harness) || !text(subject.platform) || !hashPattern.test(subject.contractDigest)
      || !Array.isArray(subject.components) || !subject.components.length || subject.components.length > 10000) fail("Invalid maintained harness subject.");
  const components: VerificationSubject["components"] = (subject.components as unknown[]).map(value => {
    const component = object(value); keys(component, ["id", "name", "version", "integrity"]);
    if (![component.id, component.name, component.version, component.integrity].every(text)) fail("Runtime component identity is incomplete.");
    return {id: component.id as string, name: component.name as string, version: component.version as string, integrity: component.integrity as string};
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(components.map(c => c.id)).size !== components.length) fail("Runtime component IDs must be unique.");
  return {harness: subject.harness, platform: subject.platform, contractDigest: subject.contractDigest, components};
}
export function assertVerificationScope(value: unknown): asserts value is VerificationScope | null {
  if (value === null) return;
  const scope = object(value); keys(scope, ["captureProfileDigest", "routeDigest"]);
  if (!hashPattern.test(scope.captureProfileDigest) || !hashPattern.test(scope.routeDigest)) fail("A capture scope requires profile and route digests.");
}
export function assertVerificationReceipt(value: unknown): asserts value is HarnessVerificationReceipt {
  const receipt = sealed(value, "ebo.harness-verification/v1", ["id", "createdAt", "subject", "scope", "claims", "evidence"]);
  canonicalVerificationSubject(receipt.subject); assertVerificationScope(receipt.scope);
  if (!text(receipt.id) || !Number.isFinite(Date.parse(receipt.createdAt))) fail("Receipt identity and time are required.");
  const claims = object(receipt.claims); keys(claims, VERIFICATION_CLAIMS);
  if (!Object.keys(claims).length || Object.values(claims).some(result => !["checked", "failed", "unavailable"].includes(result as string))) fail("Invalid capability results.");
  if (!Array.isArray(receipt.evidence) || !receipt.evidence.length || receipt.evidence.length > 100) fail("Verification evidence is required.");
  const cases = new Set<string>();
  for (const value of receipt.evidence) {
    const proof = object(value); keys(proof, ["kind", "lockDigest", "launchDigest", "case", "manifestDigest", "datasetDigest", "runVerificationDigest"]);
    if (!["probe", "owned-capture"].includes(proof.kind) || !hashPattern.test(proof.lockDigest) || !hashPattern.test(proof.launchDigest)) fail("Only probes and owned capture evidence can verify a harness.");
    if (proof.kind === "owned-capture") {
      if (!["success", "failure-recovery", "interruption"].includes(proof.case) || ![proof.manifestDigest, proof.datasetDigest, proof.runVerificationDigest].every(v => hashPattern.test(v))) fail("Owned capture proof is incomplete.");
      cases.add(proof.case);
    } else if (proof.case !== undefined || proof.manifestDigest !== undefined || proof.datasetDigest !== undefined || proof.runVerificationDigest !== undefined) fail("Probe evidence cannot assert a capture.");
  }
  if (Object.keys(claims).some(claim => !probeClaims.has(claim as VerificationClaim))
      && (receipt.scope === null || cases.size !== 3)) fail("Capture claims require a scoped success, failure and interruption set.");
}
function subjectKey(receipt: HarnessVerificationReceipt): VerificationHash {
  return verificationDigest({subject: canonicalVerificationSubject(receipt.subject), scope: receipt.scope});
}
function assertAdmission(value: unknown): asserts value is VerificationAdmission {
  const admission = sealed(value, "ebo.harness-verification-admission/v1", ["id", "action", "receiptDigest", "subjectDigest", "supersedes", "operator", "createdAt"]);
  if (!text(admission.id) || !["admit", "withdraw"].includes(admission.action) || !hashPattern.test(admission.receiptDigest) || !hashPattern.test(admission.subjectDigest)
      || !Number.isFinite(Date.parse(admission.createdAt)) || !Array.isArray(admission.supersedes) || admission.supersedes.some(v => !hashPattern.test(v))
      || new Set(admission.supersedes).size !== admission.supersedes.length || admission.action === "admit" && admission.supersedes.includes(admission.receiptDigest)) fail("Invalid admission.");
  const operator = object(admission.operator); keys(operator, ["id", "reason"]);
  if (!text(operator.id) || !text(operator.reason) || admission.action === "withdraw" && !admission.supersedes.length) fail("Admission requires an explicit operator and reason.");
}
function validateCatalog(catalog: VerificationCatalog): void {
  catalog.receipts.forEach(assertVerificationReceipt); catalog.admissions.forEach(assertAdmission);
  const receipts = new Map(catalog.receipts.map(r => [r.digest, r]));
  const done = new Set<string>(), visiting = new Set<string>();
  const visit = (admission: VerificationAdmission): void => {
    if (done.has(admission.digest)) return;
    if (visiting.has(admission.digest)) fail("Admission supersession contains a cycle.");
    visiting.add(admission.digest);
    const receipt = receipts.get(admission.receiptDigest);
    if (!receipt || subjectKey(receipt) !== admission.subjectDigest) fail("Admission differs from its receipt subject.");
    for (const digest of admission.supersedes) {
      const targets = catalog.admissions.filter(target => target.action === "admit" && target.receiptDigest === digest);
      if (!targets.length || targets.some(target => target.subjectDigest !== admission.subjectDigest)) fail("Supersession must name admitted receipt digests for the same subject and scope.");
      if (admission.action === "admit") for (const target of targets) visit(target);
    }
    visiting.delete(admission.digest); done.add(admission.digest);
  };
  catalog.admissions.forEach(visit);
}
const shippedRoot = fileURLToPath(new URL("../../verification/catalog/", import.meta.url));
function readCatalogJson(path: string): unknown {
  const text = new TextDecoder("utf8", {fatal: true}).decode(readBoundedFile(path, "Verification catalog", undefined, 1024 * 1024));
  assertNoDuplicateJsonKeys(text); return JSON.parse(text);
}
/** Catalog files are data. No imported code or native trajectory can register a verifier. */
export async function readVerificationCatalog(root = shippedRoot): Promise<VerificationCatalog> {
  const admissions = new Map<VerificationHash, VerificationAdmission>(), receipts = new Map<VerificationHash, HarnessVerificationReceipt>();
  for (const directory of new Set([shippedRoot, root])) {
    let files: string[]; try {files = await readdir(join(directory, "admissions"));} catch (error) {if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error;}
    if (files.length > 10000) fail("Catalog exceeds the admission bound.");
    for (const name of files.sort()) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) fail("Catalog admission filenames must be content digests.");
      const admission = readCatalogJson(join(directory, "admissions", name));
      assertAdmission(admission); if (`${admission.digest.slice(7)}.json` !== name) fail("Admission filename differs from content.");
      admissions.set(admission.digest, admission);
      const path = join(directory, "receipts", `${admission.receiptDigest.slice(7)}.json`);
      const receipt = readCatalogJson(path); assertVerificationReceipt(receipt);
      if (receipt.digest !== admission.receiptDigest) fail("Receipt filename differs from content."); receipts.set(receipt.digest, receipt);
    }
  }
  const catalog = {receipts: [...receipts.values()].sort((a,b) => a.digest.localeCompare(b.digest)), admissions: [...admissions.values()].sort((a,b) => a.digest.localeCompare(b.digest))};
  validateCatalog(catalog); return catalog;
}
export function snapshotVerification(subject: unknown, catalog: VerificationCatalog): VerificationSnapshot {
  const canonical = canonicalVerificationSubject(subject); validateCatalog(catalog);
  const superseded = new Set(catalog.admissions.flatMap(a => a.supersedes));
  const receipts = new Map(catalog.receipts.map(r => [r.digest, r]));
  const admissions = catalog.admissions.filter(a => a.action === "admit" && !superseded.has(a.receiptDigest)
    && verificationDigest(canonicalVerificationSubject(receipts.get(a.receiptDigest)!.subject)) === verificationDigest(canonical)).sort((a,b) => a.digest.localeCompare(b.digest));
  return sealVerification({schemaVersion: "ebo.harness-verification-snapshot/v1" as const, subject: canonical,
    catalogDigest: verificationDigest(catalog.admissions.map(a => a.digest).sort()), admissions: structuredClone(admissions),
    receipts: structuredClone([...new Set(admissions.map(a => a.receiptDigest))].sort().map(d => receipts.get(d)!))});
}
export function assertVerificationSnapshot(value: unknown): asserts value is VerificationSnapshot {
  const snapshot = sealed(value, "ebo.harness-verification-snapshot/v1", ["subject", "catalogDigest", "receipts", "admissions"]);
  const subject = canonicalVerificationSubject(snapshot.subject);
  if (!hashPattern.test(snapshot.catalogDigest) || !Array.isArray(snapshot.receipts) || !Array.isArray(snapshot.admissions)) fail("Invalid verification snapshot.");
  snapshot.receipts.forEach(assertVerificationReceipt); snapshot.admissions.forEach(assertAdmission);
  const receipts = new Map<VerificationHash, HarnessVerificationReceipt>(snapshot.receipts.map((r: HarnessVerificationReceipt) => [r.digest, r]));
  if (receipts.size !== snapshot.receipts.length || new Set(snapshot.admissions.map((a: VerificationAdmission) => a.digest)).size !== snapshot.admissions.length) fail("Duplicate snapshot evidence.");
  for (const admission of snapshot.admissions as VerificationAdmission[]) {
    const receipt = receipts.get(admission.receiptDigest);
    if (admission.action !== "admit" || !receipt || subjectKey(receipt) !== admission.subjectDigest
        || verificationDigest(canonicalVerificationSubject(receipt.subject)) !== verificationDigest(subject)) fail("Snapshot admission or runtime subject differs.");
  }
  if ([...receipts.keys()].some(d => !snapshot.admissions.some((a: VerificationAdmission) => a.receiptDigest === d))) fail("Snapshot has unadmitted receipts.");
}
export function evaluateVerification(snapshot?: VerificationSnapshot, scope: VerificationScope | null = null): VerificationResult {
  if (snapshot) assertVerificationSnapshot(snapshot); assertVerificationScope(scope);
  const claims = Object.fromEntries(VERIFICATION_CLAIMS.map(claim => [claim, "unverified"])) as VerificationResult["claims"];
  for (const claim of VERIFICATION_CLAIMS) {
    const results = new Set(snapshot?.receipts.filter(receipt => probeClaims.has(claim) || scope !== null && verificationDigest(scope) === verificationDigest(receipt.scope))
      .map(receipt => receipt.claims[claim]).filter(result => result === "checked" || result === "failed") ?? []);
    claims[claim] = results.size > 1 ? "conflict" : results.has("checked") ? "checked" : "unverified";
  }
  const state = claims["runtime-probe"] !== "checked" ? "unverified" : VERIFICATION_CLAIMS.some(claim => !probeClaims.has(claim) && claims[claim] === "checked") ? "capture-checked" : "probe-checked";
  const limitations: string[] = state === "unverified" ? ["HARNESS_VERSION_UNVERIFIED"] : [];
  if (VERIFICATION_CLAIMS.some(claim => !probeClaims.has(claim) && claims[claim] !== "checked")) limitations.push("HARNESS_CAPTURE_UNVERIFIED");
  if (Object.values(claims).includes("conflict")) limitations.push("HARNESS_VERIFICATION_CONFLICT");
  return {state, limitations,
    claims, receiptDigests: snapshot?.receipts.map(r => r.digest) ?? [], admissionDigests: snapshot?.admissions.map(a => a.digest) ?? [], snapshotDigest: snapshot?.digest ?? null};
}
/** Trusted operator admission is the only write path. Callers must validate private source evidence first. */
export async function appendVerificationAdmission(root: string, receipt: HarnessVerificationReceipt, operator: VerificationAdmission["operator"], supersedes: VerificationHash[] = [], action: "admit" | "withdraw" = "admit"): Promise<VerificationAdmission> {
  assertVerificationReceipt(receipt); await mkdir(root, {recursive: true, mode: 0o700});
  const unlock = await lockfile.lock(join(root, "catalog"), {realpath: false, retries: 20});
  try {
    const catalog = await readVerificationCatalog(root);
    const admission = sealVerification({schemaVersion: "ebo.harness-verification-admission/v1" as const, id: randomUUID(), action,
      receiptDigest: receipt.digest, subjectDigest: subjectKey(receipt), supersedes: [...supersedes].sort(), operator: structuredClone(operator), createdAt: new Date().toISOString()});
    validateCatalog({receipts: [...catalog.receipts, receipt], admissions: [...catalog.admissions, admission]});
    writeMetadataAtomicallyIfAbsentSync(root, `receipts/${receipt.digest.slice(7)}.json`, receipt);
    writeMetadataAtomicallyIfAbsentSync(root, `admissions/${admission.digest.slice(7)}.json`, admission);
    return admission;
  } finally {await unlock();}
}

const contractModules: Record<string, string[]> = {
  "claude-agent-sdk": ["agent-sdk.js", "agent-sdk-run.js", "agent-sdk-runner.js", "agent-sdk-normalizer.js", "v2-profiles/claude.js"],
  "codex-app-server": ["codex.js", "codex-run.js", "v2-profiles/codex.js"],
  "devin-cli": ["devin.js", "devin-run.js", "v2-profiles/devin.js"],
  "cursor-sdk": ["cursor-sdk.js", "cursor-sdk-runner.js", "v2-profiles/cursor.js"],
  "pi-sdk": ["pi.js", "v2-profiles/pi.js"],
  "factory-droid": ["factory-droid.js", "factory-run.js", "v2-profiles/factory.js"],
  "openhands-agent-server": ["openhands.js", "openhands-run.js", "openhands-runtime.js", "v2-profiles/openhands.js"],
  "deepseek-harness": ["deepseek-adapter.js", "harbor/other-harnesses.js", "v2-profiles/deepseek.js"],
};
/** Runtime releases and format contracts are independent dimensions. */
export function harnessCaptureContract(harness: string): VerificationHash {
  const modules = contractModules[harness]; if (!modules) fail("No maintained native capture contract.");
  return verificationDigest([...modules, "run-bundles.js", "native-v2.js", "projection-v2.js", "normalization-v2.js", "retained-evidence.js", "retained-version-policy.js", "verification-context.js", "verification-retained.js", "runtime-context.js", "harness-verification-candidate.js", "harness-verification.js", "normalization-integrity.js", "process-protocol.js", "lifecycle.js", "../../schemas/run-bundles/v2.json"].map(path =>
    ({path, digest: verificationDigest(readFileSync(new URL(path, import.meta.url)).toString("utf8"))})));
}
export function runtimeVerificationSubject(role: string, group: Pick<import("./study-runtimes.js").StudyRuntimeGroup, "components" | "plan" | "roots">, contractDigest?: VerificationHash): VerificationSubject | undefined {
  const harness = listRuntimeRecipes().find(recipe => recipe.id === role)?.harness;
  if (!harness) return undefined;
  return canonicalVerificationSubject({harness, platform: group.plan.platform, contractDigest: contractDigest ?? harnessCaptureContract(harness),
    components: group.components.map(component => ({id: component.id, name: component.name, version: component.version, integrity: component.selection.release.integrity}))});
}
export function verificationScopeForRun(run: {model: {provider: string; id: string; configurationDigest?: string}}, configuration: {captureProfileDigest?: VerificationHash}): VerificationScope | null {
  if (!configuration.captureProfileDigest) return null;
  return {captureProfileDigest: configuration.captureProfileDigest,
    routeDigest: verificationDigest({provider: run.model.provider, model: run.model.id, configurationDigest: run.model.configurationDigest ?? null})};
}
