import { digestBytes, assertNoDuplicateJsonKeys } from "./artifacts.js";
import { resolveBundleArtifact } from "./contracts.js";
import { evaluateVerification, assertVerificationSnapshot, canonicalVerificationSubject, assertVerificationScope, sealVerification, verificationDigest, runtimeVerificationSubject,
  type VerificationSubject, type VerificationScope, type VerificationSnapshot, type VerificationResult, type VerificationHash } from "./harness-verification.js";
import type { RunManifest } from "./run-bundles.js";

export type RunVerification = {schemaVersion: "ebo.run-verification/v1"; subject: VerificationSubject; scope: VerificationScope | null;
  snapshot: VerificationSnapshot | null; result: VerificationResult; digest: VerificationHash};
export function createRunVerification(subject: VerificationSubject, snapshot: VerificationSnapshot | undefined, scope: VerificationScope | null): RunVerification {
  const matches = snapshot && verificationDigest(snapshot.subject) === verificationDigest(subject);
  return sealVerification({schemaVersion: "ebo.run-verification/v1" as const, subject, scope, snapshot: snapshot ?? null, result: evaluateVerification(matches ? snapshot : undefined, scope)});
}
export function assertRunVerification(value: unknown): asserts value is RunVerification {
  const record = value as RunVerification;
  if (!record || record.schemaVersion !== "ebo.run-verification/v1" || !record.digest) throw new Error("HARNESS_VERIFICATION_INVALID: run verification has an unsupported contract.");
  const {digest, ...body} = record;
  if (verificationDigest(body) !== digest) throw new Error("HARNESS_VERIFICATION_INVALID: run verification digest differs.");
  canonicalVerificationSubject(record.subject); assertVerificationScope(record.scope);
  if (record.snapshot !== null) assertVerificationSnapshot(record.snapshot);
  const expected = createRunVerification(record.subject, record.snapshot ?? undefined, record.scope);
  if (verificationDigest(expected) !== verificationDigest(record)) throw new Error("HARNESS_VERIFICATION_INVALID: run verification does not reproduce.");
}
export function readRunVerification(bundleRoot: string, manifest: RunManifest): RunVerification | undefined {
  const descriptor = manifest.evidence.find(item => item.id === "harness-verification");
  if (!descriptor) return undefined;
  if (descriptor.source !== "ebo-runtime" || descriptor.kind !== "diagnostic" || descriptor.sharingClass !== "internal") throw new Error("HARNESS_VERIFICATION_INVALID: run verification requires internal runtime evidence.");
  const bytes = resolveBundleArtifact(bundleRoot, {locator: descriptor.relativePath, digest: {algorithm: "sha256", value: descriptor.digest.slice(7)}});
  if (bytes.length !== descriptor.sizeBytes || `sha256:${digestBytes(bytes).value}` !== descriptor.digest) throw new Error("HARNESS_VERIFICATION_INVALID: retained verification bytes changed.");
  const parse = (bytes: Buffer): any => {const text = new TextDecoder("utf8", {fatal: true}).decode(bytes); assertNoDuplicateJsonKeys(text); return JSON.parse(text);};
  const record: unknown = parse(bytes); assertRunVerification(record);
  const binding = manifest.runtimeLock;
  if (!binding) throw new Error("HARNESS_VERIFICATION_INVALID: retained verification has no frozen runtime binding.");
  const readDiagnostic = (id: string): any => {
    const descriptor = manifest.evidence.find(item => item.id === id);
    if (!descriptor || descriptor.source !== "ebo-runtime" || descriptor.kind !== "diagnostic" || descriptor.sharingClass !== "internal") throw new Error("HARNESS_VERIFICATION_INVALID: missing frozen runtime diagnostic.");
    const bytes = resolveBundleArtifact(bundleRoot, {locator: descriptor.relativePath, digest: {algorithm: "sha256", value: descriptor.digest.slice(7)}});
    if (bytes.length !== descriptor.sizeBytes) throw new Error("HARNESS_VERIFICATION_INVALID: frozen runtime diagnostic size differs.");
    return parse(bytes);
  };
  const lock = readDiagnostic(binding.lockArtifactId), launch = readDiagnostic(binding.launchArtifactId);
  const {digest, ...body} = lock;
  const group = lock.groups?.find((group: any) => group.roles?.includes(binding.role));
  if (!["ebo.study-runtime-lock/v1", "ebo.study-runtime-lock/v2"].includes(lock.schemaVersion) || digest !== binding.lockDigest || verificationDigest(body) !== digest
      || !group || launch.lockDigest !== digest || launch.role !== binding.role
      || verificationDigest(record.snapshot) !== verificationDigest(group.verification?.[binding.role] ?? null)
      || verificationDigest(record.subject) !== verificationDigest(launch.verificationSubject)
      || verificationDigest(record.subject) !== verificationDigest(runtimeVerificationSubject(binding.role, group, record.subject.contractDigest, record.subject.abi))) throw new Error("HARNESS_VERIFICATION_INVALID: verification snapshot differs from its frozen runtime binding.");
  return record;
}
