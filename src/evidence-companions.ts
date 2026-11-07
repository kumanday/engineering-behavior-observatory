import { lstatSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertNoDuplicateJsonKeys, digestBytes, digestMetadata, validateArtifact } from "./artifacts.js";
import { isSafeArtifactRelativePath } from "./contracts.js";
import { createPointerEvidenceResolver } from "./evidence-pointers.js";
import { createRetainedBehaviorEvidence } from "./retained-evidence.js";
import { readBoundedFile } from "./scheduler.js";
import type { NativeEvidenceReference, NativeEvidenceResolver, UniformAttributeValue } from "./uniform-events.js";

type Hash = `sha256:${string}`;
export const EVIDENCE_COMPANION_LIMITS = { files: 64, fileBytes: 16 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, references: 10_000, manifestBytes: 4 * 1024 * 1024 } as const;
export type CompanionRange = { reference: NativeEvidenceReference; digest: Hash };
export type EvidenceCompanion = {
  schemaVersion: "ebo.evidence-companion/v1";
  target: { manifestDigest: Hash; manifestBytesDigest: Hash; runId: string; attemptId: string };
  kind: "converted-trajectory" | "workspace-history" | "supplemental-native";
  producer: { id: string; version: string; policyDigest: Hash };
  authority: "supplemental";
  sharingClass: "restricted";
  sourceRanges: CompanionRange[];
  artifacts: Array<{ id: string; path: string; digest: Hash; bytes: number; mediaType: "application/json" | "application/x-ndjson" | "text/plain" }>;
  supplementalObservations: Array<{ kind: "context-boundary" | "workspace-change" | "coverage-gap" | "conversion-diagnostic";
    citations: CompanionRange[]; attributes: Record<string, UniformAttributeValue> }>;
  coverage: { status: "available" | "partial" | "unavailable"; reasons: string[] };
};
export type EvidenceCompanionRequest = Omit<EvidenceCompanion, "schemaVersion" | "authority" | "sharingClass" | "target" | "artifacts"> & {
  targetManifestDigest: Hash;
  artifacts: EvidenceCompanion["artifacts"];
};
const hash = (value: unknown): Hash => `sha256:${digestMetadata(value).value}`;
const rawHash = (bytes: Uint8Array): Hash => `sha256:${digestBytes(bytes).value}`;

/** Retain supplemental evidence without rewriting an attempt or admitting another trial. */
export async function writeEvidenceCompanion(baseRoot: string, destination: string, request: EvidenceCompanionRequest, files: ReadonlyMap<string, Buffer>) {
  const base = await createRetainedBehaviorEvidence(baseRoot);
  const manifestBytes = closedRead(baseRoot, "manifest.json", EVIDENCE_COMPANION_LIMITS.manifestBytes);
  const target = { manifestDigest: hash(parseJson(manifestBytes)), manifestBytesDigest: rawHash(manifestBytes), runId: base.capture.runId, attemptId: base.capture.attemptId };
  if (target.manifestDigest !== request.targetManifestDigest) throw new Error("Companion target manifest digest differs from the original attempt.");
  const companion: EvidenceCompanion = { schemaVersion: "ebo.evidence-companion/v1", target, kind: request.kind, producer: request.producer,
    authority: "supplemental", sharingClass: "restricted", sourceRanges: request.sourceRanges, artifacts: request.artifacts,
    supplementalObservations: request.supplementalObservations, coverage: request.coverage };
  assertSchema(companion);
  await verifySourceRanges(companion, base.resolver);
  const { resolver } = verifyArtifacts(companion, files);
  for (const observation of companion.supplementalObservations) await verifyRanges(observation.citations, resolver, target);
  const bytes = Buffer.from(`${JSON.stringify(companion, null, 2)}\n`);
  if (bytes.length > EVIDENCE_COMPANION_LIMITS.manifestBytes) throw new Error("Companion manifest exceeds its byte limit.");
  const output = resolve(destination), parent = dirname(output); assertNoLinks(parent, ""); mkdirSync(parent, {recursive:true,mode:0o700});
  const pending = mkdtempSync(join(parent, ".companion-pending-"));
  for (const artifact of companion.artifacts) {
    const path = join(pending, artifact.path); mkdirSync(dirname(path), {recursive:true,mode:0o700}); writeFileSync(path, files.get(artifact.id)!, {flag:"wx",mode:0o600});
  }
  writeFileSync(join(pending, "companion.json"), bytes, {flag:"wx",mode:0o600});
  // rename refuses an existing nonempty companion; source evidence is never overwritten.
  renameSync(pending, output);
  return { companion, digest: hash(companion), root: output };
}

/** Explicit opt-in readback; ordinary corpus discovery and normalization never enumerate companions. */
export async function readEvidenceCompanion(baseRoot: string, companionRoot: string) {
  const companion = parseJson(closedRead(companionRoot, "companion.json", EVIDENCE_COMPANION_LIMITS.manifestBytes)) as unknown as EvidenceCompanion;
  assertSchema(companion);
  const base = await createRetainedBehaviorEvidence(baseRoot), bytes = closedRead(baseRoot, "manifest.json", EVIDENCE_COMPANION_LIMITS.manifestBytes);
  if (companion.target.manifestDigest !== hash(parseJson(bytes)) || companion.target.manifestBytesDigest !== rawHash(bytes)
      || companion.target.runId !== base.capture.runId || companion.target.attemptId !== base.capture.attemptId) throw new Error("Companion belongs to a different original attempt or manifest revision.");
  await verifySourceRanges(companion, base.resolver);
  const files = new Map(companion.artifacts.map((artifact) => [artifact.id, closedRead(companionRoot, artifact.path, EVIDENCE_COMPANION_LIMITS.fileBytes)]));
  const { resolver, records } = verifyArtifacts(companion, files);
  for (const observation of companion.supplementalObservations) await verifyRanges(observation.citations, resolver, companion.target);
  const digest = hash(companion);
  const qualifiedRecords = records.map(({reference,record}) => ({reference: {...reference, artifactId: companionArtifactId(digest,reference.artifactId)},record}));
  const qualifiedResolver = createPointerEvidenceResolver({runId:base.capture.runId,attemptId:base.capture.attemptId,records:qualifiedRecords});
  return { companion, digest, resolver: qualifiedResolver, records: qualifiedRecords, baseQualification: base.capture.qualification };
}

/** Companion citations use their own namespace; they cannot shadow the attempt's native records. */
export function companionArtifactId(companionDigest: Hash, artifactId: string): string { return `companion:${companionDigest}/${encodeURIComponent(artifactId)}`; }

function verifyArtifacts(companion: EvidenceCompanion, files: ReadonlyMap<string, Buffer>) {
  if (files.size !== companion.artifacts.length) throw new Error("Companion file inventory differs from its manifest.");
  const ids = new Set<string>(), paths = new Set<string>(), records: Array<{reference: NativeEvidenceReference; record: unknown}> = []; let total = 0;
  for (const artifact of companion.artifacts) {
    if (ids.has(artifact.id) || paths.has(artifact.path) || artifact.path === "companion.json") throw new Error("Duplicate or reserved companion artifact identity.");
    if (!isSafeArtifactRelativePath(artifact.path)) throw new Error("Unsafe companion artifact path.");
    ids.add(artifact.id); paths.add(artifact.path);
    const bytes = files.get(artifact.id); if (!bytes || bytes.length !== artifact.bytes || rawHash(bytes) !== artifact.digest) throw new Error("Companion artifact bytes differ from their bound digest.");
    total += bytes.length; if (total > EVIDENCE_COMPANION_LIMITS.totalBytes) throw new Error("Companion exceeds its total byte limit.");
    if (artifact.mediaType === "application/x-ndjson") {
      let lineNumber = 0;
      for (const line of new TextDecoder("utf8", {fatal:true}).decode(bytes).split(/\r?\n/u)) {
        lineNumber++; if (!line.trim()) continue;
        if (records.length >= EVIDENCE_COMPANION_LIMITS.references) throw new Error("Companion record count exceeds its limit.");
        // JSONL records use a pointer array view with line numbers, preserving blanks in the source.
        records.push({reference: {artifactId: artifact.id, recordLocator: `#/lines/${lineNumber}`}, record: parseJson(Buffer.from(line))});
      }
    } else records.push({reference: {artifactId: artifact.id, recordLocator: "#"}, record: artifact.mediaType === "application/json" ? parseJson(bytes) : new TextDecoder("utf8", {fatal:true}).decode(bytes)});
  }
  return { records, resolver: createPointerEvidenceResolver({runId:companion.target.runId,attemptId:companion.target.attemptId,records}) };
}
async function verifySourceRanges(companion: EvidenceCompanion, resolver: NativeEvidenceResolver) { await verifyRanges(companion.sourceRanges, resolver, companion.target); }
async function verifyRanges(ranges: readonly CompanionRange[], resolver: NativeEvidenceResolver, target: EvidenceCompanion["target"]) {
  for (const range of ranges) {
    const resolved = await resolver.resolve(range.reference);
    if (!resolved || resolved === true || resolved.runId !== target.runId || resolved.attemptId !== target.attemptId || resolved.digest !== range.digest) throw new Error("Companion source range is unresolved, cross-attempt or stale.");
  }
}
function assertSchema(companion: EvidenceCompanion) {
  const errors = validateArtifact("Evidence companion", companion); if (errors.length) throw new Error(`Invalid evidence companion: ${errors[0]!.message}`);
}
function parseJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf8", {fatal:true}).decode(bytes); assertNoDuplicateJsonKeys(text); const value: unknown = JSON.parse(text); let nodes = 0;
  const visit = (value: unknown, depth: number) => { if (++nodes > 250_000 || depth > 64 || typeof value === "number" && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error("Unbounded companion JSON."); if (value && typeof value === "object") for (const child of Object.values(value)) visit(child,depth+1); };
  visit(value,0); return value;
}
function assertNoLinks(root: string, path: string) {
  let current=resolve(root);
  try { if (lstatSync(current).isSymbolicLink()) throw new Error("Companion paths cannot traverse links."); }
  catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
  for (const part of path.split("/").filter(Boolean)) { current=join(current,part); if (lstatSync(current).isSymbolicLink()) throw new Error("Companion paths cannot traverse links."); }
}
function closedRead(root: string, path: string, maximum: number) {
  if (!isSafeArtifactRelativePath(path)) throw new Error("Unsafe companion artifact path."); assertNoLinks(root,path);
  if (!lstatSync(join(root,path)).isFile()) throw new Error("Companion evidence must be a regular file."); return readBoundedFile(join(root,path),"Companion evidence",undefined,maximum);
}
