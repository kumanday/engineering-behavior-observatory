import { atifCompatibilityIdentity, normalizeAtif } from "./atif-normalizer.js";
import { atifOverlayReceipts } from "./atif-overlays.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertNoDuplicateJsonKeys, digestBytes, digestMetadata, validateArtifact } from "./artifacts.js";
import { ATIF_LIMITS, inspectAtifBytes, readAtifFile, atifPointerValue, type AtifInspection } from "./atif-reader.js";
import type { AtifProducerFingerprint } from "./atif-profiles.js";
import { atifCoreIdentity } from "./atif-core.js";
import { object } from "./projection-v2.js";
import { readBoundedFile } from "./scheduler.js";

export class AtifAdmissionError extends Error { override name = "AtifAdmissionError"; }
export const ATIF_IMPORTER_VERSION = "2.0.0";
export type LegacyAtifImportManifest = {
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

export type AtifOverlayReference = { id: string; digest: `sha256:${string}` };
export type AtifImportManifestV2 = Omit<LegacyAtifImportManifest, "schemaVersion" | "profile" | "producerAuthority"> & {
  schemaVersion: "ebo.import-manifest/v2"; producerAuthority: "document-and-operator";
  overlays: AtifOverlayReference[]; interpretation: { path: "interpretation.json"; digest: `sha256:${string}` };
};
export type AtifImportManifest = LegacyAtifImportManifest | AtifImportManifestV2;
const bytesDigest = (bytes: Uint8Array): `sha256:${string}` => `sha256:${digestBytes(bytes).value}`;
const hash = (value: unknown): `sha256:${string}` => `sha256:${digestMetadata(value).value}`;
const coreIdentity = () => { const { id, version, implementationDigest } = atifCoreIdentity(); return { id, version, digest: implementationDigest }; };
export type AtifImportOptions = { sourcePath: string; destination: string; runId: string; attemptId: string;
  producer?: AtifProducerFingerprint; converter?: Partial<AtifProducerFingerprint["converter"]>;
  context?: Partial<AtifProducerFingerprint["context"]>; pythonExecutable?: string; modelAliases?: readonly string[] };

/** Retain bytes first. No trajectory-supplied code is executed. */
export async function importAtifFile(options: AtifImportOptions) {
  if (![options.runId, options.attemptId].every((value) => value.trim().length > 0 && value.length <= 1024)) throw new Error("Import requires bounded run and attempt identities.");
  const blinding = declaredBlinding(options.modelAliases);
  const destination = resolve(options.destination);
  const bytes = readBoundedFile(options.sourcePath, "ATIF source", undefined, ATIF_LIMITS.documentBytes);
  try { mkdirSync(destination, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const manifest = readImportManifest(destination);
    if (manifest.source.digest !== bytesDigest(bytes) || manifest.identity.runId !== options.runId || manifest.identity.attemptId !== options.attemptId
        || hash(manifest.blinding ?? null) !== hash(blinding ?? null)) throw new Error("Import destination retains another source or identity; use a new destination.");
    return { manifest, reused: true, evidence: await readImportedBehaviorEvidence(destination) };
  }
  writeFileSync(join(destination, "trajectory.json"), bytes, { flag: "wx", mode: 0o600 });
  writeJson(destination, "request.json", { importerVersion: ATIF_IMPORTER_VERSION, runId: options.runId, attemptId: options.attemptId,
    converter: options.converter ?? options.producer?.converter ?? null, context: options.context ?? options.producer?.context ?? null });
  const read = await readAtifFile(join(destination, "trajectory.json"), { pythonExecutable: options.pythonExecutable, propagateReadErrors: true });
  const inspectionBytes = writeJson(destination, "inspection.json", read.inspection);
  if (inspectionBytes.length > 32 * 1024 * 1024) throw new AtifAdmissionError("ATIF inspection exceeds the receipt byte limit.");
  if (!read.document || read.inspection.versionPolicy.status === "unsupported" || read.inspection.versionPolicy.status === "unavailable" || read.inspection.structural.status !== "valid") {
    const reason = read.inspection.versionPolicy.diagnostics[0] ?? read.inspection.structural.diagnostics[0];
    throw new AtifAdmissionError(`ATIF admission failed: ${reason?.code ?? "INVALID_FORMAT"} at ${reason?.pointer ?? "#"}; source and inspection retained.`);
  }
  const agent = object(read.document.agent), converter = options.converter ?? options.producer?.converter, context = options.context ?? options.producer?.context;
  const producer: AtifProducerFingerprint = { formatVersion: String(read.document.schema_version),
    agent: { name: String(agent.name), version: typeof agent.version === "string" ? agent.version : null },
    converter: { id: converter?.id ?? "unreported", packageVersion: converter?.packageVersion ?? "unknown", sourceDigest: converter?.sourceDigest ?? null },
    context: { kind: context?.kind ?? "unknown", revision: context?.revision ?? null, wrapperDigest: context?.wrapperDigest ?? null } };
  const interpretation = { schemaVersion: "ebo.atif-interpretation/v1", sourceDigest: bytesDigest(bytes), core: coreIdentity(), compatibilityReader: atifCompatibilityIdentity(), overlays: atifOverlayReceipts({ read, producer }) };
  const interpretationBytes = writeJson(destination, "interpretation.json", interpretation);
  const manifest: AtifImportManifestV2 = { schemaVersion: "ebo.import-manifest/v2", importer: { id: "ebo.atif", version: ATIF_IMPORTER_VERSION },
    identity: { runId: options.runId, attemptId: options.attemptId, authority: "operator-declared" }, qualification: "imported", sharing: "restricted", createdAt: new Date().toISOString(),
    source: { artifactId: "atif-trajectory", path: "trajectory.json", digest: bytesDigest(bytes), bytes: bytes.length },
    inspection: { path: "inspection.json", digest: bytesDigest(inspectionBytes) }, producer, producerAuthority: "document-and-operator", overlays: interpretation.overlays,
    interpretation: { path: "interpretation.json", digest: bytesDigest(interpretationBytes) }, ...(blinding ? { blinding } : {}) };
  assertManifest(manifest);
  const projected = await normalizeAtif({ read, producer: manifest.producer, ...manifest.identity, manifestDigest: hash(manifest) });
  const mappingErrors = validateArtifact("ATIF mapping", projected.mapping);
  if (mappingErrors.length) throw new AtifAdmissionError(`ATIF mapping failed its contract: ${mappingErrors[0]!.field}: ${mappingErrors[0]!.message}`);
  writeJson(destination, "mapping.json", projected.mapping);
  writeJson(destination, "manifest.json", manifest);
  return { manifest: manifest as AtifImportManifest, reused: false, evidence: withDeclaredAliases({ ...projected,
    mapping: projected.mapping, interpretationRevision: { changed: false, admitted: interpretation, current: interpretation } }, manifest) };
}

export function readImportManifest(bundleRoot: string): AtifImportManifest {
  const bytes = readBoundedFile(join(bundleRoot, "manifest.json"), "Import manifest", undefined, 1024 * 1024);
  const manifest = parseJson(bytes) as AtifImportManifest;
  assertManifest(manifest);
  // The admission's interpretation is evidence, not a lookup in today's registry.
  return manifest;
}

export async function readImportedBehaviorEvidence(bundleRoot: string) {
  const { manifest, read, interpretationRevision } = readAtifImportAdmission(bundleRoot);
  const projected = await normalizeAtif({ read, producer: manifest.producer, ...manifest.identity, manifestDigest: hash(manifest) });
  return withDeclaredAliases({ ...projected, mapping: projected.mapping, interpretationRevision }, manifest);
}

export function readAtifImportAdmission(bundleRoot: string) {
  const manifest = readImportManifest(bundleRoot);
  const bytes = readBoundedFile(join(bundleRoot, manifest.source.path), "Retained ATIF", undefined, ATIF_LIMITS.documentBytes);
  if (bytes.length !== manifest.source.bytes || bytesDigest(bytes) !== manifest.source.digest) throw new Error("Retained ATIF bytes differ from admitted source.");
  const receiptBytes = readBoundedFile(join(bundleRoot, manifest.inspection.path), "ATIF inspection", undefined, 32 * 1024 * 1024);
  if (bytesDigest(receiptBytes) !== manifest.inspection.digest) throw new Error("ATIF inspection receipt differs from its admitted digest.");
  const receipt = parseJson(receiptBytes) as AtifInspection;
  const errors = validateArtifact("ATIF inspection", receipt);
  if (errors.length || receipt.source.digest !== manifest.source.digest || receipt.source.bytes !== bytes.length) throw new Error("Invalid source-bound ATIF inspection receipt.");
  const read = inspectAtifBytes(bytes);
  if (!read.document || read.inspection.structural.status !== "valid" || read.inspection.versionPolicy.status === "unsupported" || read.inspection.versionPolicy.status === "unavailable") throw new Error("Retained ATIF fails the current format contract.");
  for (const record of receipt.records) {
    const value = atifPointerValue(read.document, record.pointer);
    if (value === undefined || record.sourceDigest !== manifest.source.digest || hash(value) !== record.digest) throw new Error("Retained ATIF record differs from its admitted pointer digest.");
  }
  let admitted: unknown;
  if (manifest.schemaVersion === "ebo.import-manifest/v2") {
    const bytes = readBoundedFile(join(bundleRoot, manifest.interpretation.path), "ATIF interpretation", undefined, 1024 * 1024);
    if (bytesDigest(bytes) !== manifest.interpretation.digest) throw new Error("Admitted interpretation receipt differs from its digest.");
    admitted = parseJson(bytes);
    const receipt = object(admitted);
    if (receipt.schemaVersion !== "ebo.atif-interpretation/v1" || receipt.sourceDigest !== manifest.source.digest
        || hash(receipt.overlays) !== hash(manifest.overlays)) throw new Error("Interpretation receipt differs from its admission binding.");
  } else admitted = { core: { id: "ebo.legacy-atif", version: manifest.importer.version }, profile: manifest.profile };
  const current = { schemaVersion: "ebo.atif-interpretation/v1", sourceDigest: manifest.source.digest, core: coreIdentity(), compatibilityReader: atifCompatibilityIdentity(), overlays: atifOverlayReceipts({ read, producer: manifest.producer }) };
  return { manifest, read, interpretationRevision: { changed: hash(admitted) !== hash(current), admitted, current } };
}

function withDeclaredAliases<T extends { modelAliases?: readonly string[] }>(evidence: T, manifest: AtifImportManifest): T {
  return manifest.blinding === undefined ? evidence : { ...evidence, modelAliases: [...new Set([...evidence.modelAliases ?? [], ...manifest.blinding.modelAliases])].sort() };
}
function writeJson(root: string, name: string, value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(join(root, name), bytes, { flag: "wx", mode: 0o600 }); return bytes;
}
function parseJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); assertNoDuplicateJsonKeys(text); return JSON.parse(text) as unknown;
}
function assertManifest(value: unknown): asserts value is AtifImportManifest {
  const errors = validateArtifact("Import manifest", value);
  if (errors.length) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
}
function declaredBlinding(aliases: readonly string[] | undefined): AtifImportManifest["blinding"] {
  if (aliases === undefined) return undefined;
  if (!Array.isArray(aliases) || aliases.length > 256 || aliases.some((alias) => typeof alias !== "string" || !alias.trim() || alias.length > 1024)) throw new Error("Imported model aliases exceed blinding policy limits.");
  return { authority: "operator-declared", modelAliases: [...new Set(aliases)].sort() };
}

export function isAtifImportSchema(schemaVersion: unknown): boolean {
  return schemaVersion === "ebo.import-manifest/v1" || schemaVersion === "ebo.import-manifest/v2";
}
