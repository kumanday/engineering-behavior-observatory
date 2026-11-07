import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertNoDuplicateJsonKeys, digestBytes, digestMetadata, validateArtifact } from "./artifacts.js";
import { ATIF_LIMITS, ATIF_READER_VERSION, inspectAtifBytes, readAtifFile, type AtifInspection } from "./atif-reader.js";
import { selectAtifProducerProfile, type AtifProducerFingerprint } from "./atif-profiles.js";
import { normalizePiAtif } from "./atif-pi.js";
import { readBoundedFile } from "./scheduler.js";

/** Expected rejection of source structure or producer projection, distinct from store/I/O failure. */
export class AtifAdmissionError extends Error { override name = "AtifAdmissionError"; }

export const ATIF_IMPORTER_VERSION = "1.0.0";
export type AtifImportManifest = {
  schemaVersion: "ebo.import-manifest/v1";
  importer: { id: "ebo.atif"; version: string };
  identity: { runId: string; attemptId: string; authority: "operator-declared" };
  qualification: "imported";
  sharing: "restricted";
  createdAt: string;
  source: { artifactId: "atif-trajectory"; path: "trajectory.json"; digest: `sha256:${string}`; bytes: number };
  inspection: { path: "inspection.json"; digest: `sha256:${string}` };
  producer: AtifProducerFingerprint;
  producerAuthority: "operator-declared";
  blinding?: { authority: "operator-declared"; modelAliases: string[] };
  profile: { status: "supported"; id: string; digest: `sha256:${string}` } | { status: "unsupported"; reason: "PRODUCER_PROFILE_UNREGISTERED" };
};
const bytesDigest = (bytes: Uint8Array): `sha256:${string}` => `sha256:${digestBytes(bytes).value}`;
const hash = (value: unknown): `sha256:${string}` => `sha256:${digestMetadata(value).value}`;

/** Retain raw evidence first; the admission manifest is written last. No trajectory code is executed. */
export async function importAtifFile(options: {
  sourcePath: string; destination: string; runId: string; attemptId: string;
  producer: AtifProducerFingerprint; pythonExecutable?: string; modelAliases?: readonly string[];
}): Promise<{ manifest: AtifImportManifest; reused: boolean; evidence: Awaited<ReturnType<typeof normalizePiAtif>> }> {
  if (![options.runId, options.attemptId].every((value) => value.trim().length > 0 && value.length <= 1024)) throw new Error("Import requires bounded run and attempt identities.");
  const blinding = declaredBlinding(options.modelAliases);
  const destination = resolve(options.destination);
  const bytes = readBoundedFile(options.sourcePath, "ATIF source", undefined, ATIF_LIMITS.documentBytes);
  try { mkdirSync(destination, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const manifest = readImportManifest(destination);
    if (manifest.source.digest !== bytesDigest(bytes) || manifest.identity.runId !== options.runId || manifest.identity.attemptId !== options.attemptId
        || hash(manifest.producer) !== hash(options.producer) || hash(manifest.blinding ?? null) !== hash(blinding ?? null)) throw new Error("Import destination retains another capture revision or identity; use a new destination.");
    return { manifest, reused: true, evidence: await readImportedBehaviorEvidence(destination) };
  }
  writeFileSync(join(destination, "trajectory.json"), bytes, { flag: "wx", mode: 0o600 });
  writeJson(destination, "request.json", { importerVersion: ATIF_IMPORTER_VERSION, runId: options.runId, attemptId: options.attemptId, producer: options.producer });
  // Read the retained copy so validation and byte receipts bind exactly what admission will reopen.
  const read = await readAtifFile(join(destination, "trajectory.json"), { pythonExecutable: options.pythonExecutable, propagateReadErrors: true });
  const inspectionBytes = writeJson(destination, "inspection.json", read.inspection);
  if (inspectionBytes.length > 32 * 1024 * 1024) throw new Error("ATIF inspection exceeds the retained receipt byte limit; no manifest was admitted.");
  if (read.document === undefined || read.inspection.versionPolicy.status !== "supported" || read.inspection.structural.status !== "valid") {
    throw new AtifAdmissionError("ATIF admission failed; retained source and inspection remain in the destination without an admission manifest.");
  }
  const selection = selectAtifProducerProfile(options.producer);
  const manifest: AtifImportManifest = { schemaVersion: "ebo.import-manifest/v1", importer: { id: "ebo.atif", version: ATIF_IMPORTER_VERSION },
    identity: { runId: options.runId, attemptId: options.attemptId, authority: "operator-declared" }, qualification: "imported", sharing: "restricted",
    createdAt: new Date().toISOString(), source: { artifactId: "atif-trajectory", path: "trajectory.json", digest: bytesDigest(bytes), bytes: bytes.length },
    inspection: { path: "inspection.json", digest: bytesDigest(inspectionBytes) }, producer: structuredClone(options.producer), producerAuthority: "operator-declared",
    ...(blinding === undefined ? {} : { blinding }),
    profile: selection.status === "supported" ? { status: "supported", id: selection.profile.id, digest: selection.profileDigest } : selection };
  assertManifest(manifest);
  let evidence: Awaited<ReturnType<typeof normalizePiAtif>>;
  try { evidence = withDeclaredAliases(await normalizePiAtif({ read, producer: manifest.producer, ...manifest.identity, manifestDigest: hash(manifest) }), manifest); }
  catch (cause) { throw new AtifAdmissionError("ATIF producer projection rejected the source; no admission manifest was written.", { cause }); }
  const mappingErrors = validateArtifact("Pi ATIF mapping", evidence.mapping);
  if (mappingErrors.length) throw new AtifAdmissionError(`Invalid generated Pi mapping: ${mappingErrors[0]!.message}`);
  writeJson(destination, "mapping.json", evidence.mapping);
  writeJson(destination, "manifest.json", manifest);
  return { manifest, reused: false, evidence };
}

export function readImportManifest(bundleRoot: string): AtifImportManifest {
  const bytes = readBoundedFile(join(bundleRoot, "manifest.json"), "Import manifest", undefined, 1024 * 1024);
  const manifest = parseJson(bytes) as AtifImportManifest;
  assertManifest(manifest);
  if (manifest.importer.version !== ATIF_IMPORTER_VERSION) throw new Error("Unsupported retained ATIF importer version.");
  const selection = selectAtifProducerProfile(manifest.producer);
  const expected = selection.status === "supported" ? { status: "supported", id: selection.profile.id, digest: selection.profileDigest } : selection;
  if (hash(expected) !== hash(manifest.profile)) throw new Error("Retained import profile differs from its pinned registry identity.");
  return manifest;
}

/** Reopens imported evidence without a Python dependency; validates raw bytes and the pinned admission receipt. */
export async function readImportedBehaviorEvidence(bundleRoot: string) {
  const { manifest, read } = readAtifImportAdmission(bundleRoot);
  return withDeclaredAliases(await normalizePiAtif({ read, producer: manifest.producer, ...manifest.identity, manifestDigest: hash(manifest) }), manifest);
}

export function readAtifImportAdmission(bundleRoot: string) {
  const manifest = readImportManifest(bundleRoot);
  const bytes = readBoundedFile(join(bundleRoot, manifest.source.path), "Retained ATIF", undefined, ATIF_LIMITS.documentBytes);
  if (bytes.length !== manifest.source.bytes || bytesDigest(bytes) !== manifest.source.digest) throw new Error("Retained ATIF bytes differ from the admitted source.");
  const receiptBytes = readBoundedFile(join(bundleRoot, manifest.inspection.path), "ATIF inspection", undefined, 32 * 1024 * 1024);
  if (bytesDigest(receiptBytes) !== manifest.inspection.digest) throw new Error("ATIF inspection receipt is stale.");
  const receipt = parseJson(receiptBytes) as AtifInspection;
  const errors = validateArtifact("ATIF inspection", receipt);
  if (errors.length || receipt.readerVersion !== ATIF_READER_VERSION || receipt.structural.status !== "valid"
      || receipt.structural.version !== "0.24.0" || !receipt.structural.modelDigest || !receipt.structural.validationPolicyDigest) throw new Error("Import lacks a supported pinned validation receipt.");
  const read = inspectAtifBytes(bytes);
  if (hash(read.inspection.source) !== hash(receipt.source) || hash(read.inspection.records) !== hash(receipt.records)
      || hash(read.inspection.versionPolicy) !== hash(receipt.versionPolicy)) throw new Error("Retained source inventory differs from its admission receipt.");
  read.inspection.structural = receipt.structural;
  return { manifest, read };
}

function writeJson(root: string, name: string, value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(join(root, name), bytes, { flag: "wx", mode: 0o600 });
  return bytes;
}
function parseJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertNoDuplicateJsonKeys(text);
  return JSON.parse(text) as unknown;
}
function assertManifest(value: unknown): asserts value is AtifImportManifest {
  const errors = validateArtifact("Import manifest", value);
  if (errors.length) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
}


function declaredBlinding(aliases: readonly string[] | undefined): AtifImportManifest["blinding"] {
  if (aliases === undefined) return undefined;
  if (!Array.isArray(aliases) || aliases.length > 256 || aliases.some((alias) => typeof alias !== "string" || !alias.trim() || alias.length > 1024)) throw new Error("Imported model aliases exceed the blinding policy limits.");
  return { authority: "operator-declared", modelAliases: [...new Set(aliases)].sort() };
}
function withDeclaredAliases(evidence: Awaited<ReturnType<typeof normalizePiAtif>>, manifest: AtifImportManifest): Awaited<ReturnType<typeof normalizePiAtif>> {
  return manifest.blinding === undefined ? evidence : { ...evidence, modelAliases: [...new Set([...evidence.modelAliases ?? [], ...manifest.blinding.modelAliases])].sort() };
}
