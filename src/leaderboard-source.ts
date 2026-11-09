import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoDuplicateJsonKeys, digestBytes, digestMetadata, validateArtifact } from "./artifacts.js";
import { isSafeArtifactRelativePath } from "./contracts.js";
import { containsPortableSecretPattern } from "./exports.js";
import { readBoundedFile } from "./scheduler.js";
import { LEADERBOARD_PUBLIC_POLICY, type LeaderboardPolicyInput } from "./leaderboard-policy.js";
export type Hash = `sha256:${string}`;
export const rawHash = (bytes: Uint8Array): Hash => `sha256:${digestBytes(bytes).value}`;
export const metadataHash = (value: unknown): Hash => `sha256:${digestMetadata(value).value}`;
export const LEADERBOARD_BUCKET = "https://huggingface.co/buckets/joelniklaus/harness-leaderboard";
export type LeaderboardSourceArtifact = { remotePath: string; localPath: string; sha256: string; bytes: number;
  listedXetHash: string | null; observedXetHash?: string | null; authority: "protected-leaderboard-record" };
export type LeaderboardAcquisition = { schemaVersion: "ebo.leaderboard-acquisition/v1"; source: typeof LEADERBOARD_BUCKET;
  retrievedAt: string; sharing: "restricted"; terms: "unstated" | "recorded"; attribution: string;
  artifacts: LeaderboardSourceArtifact[] };

export function readClosedImportFile(root: string, path: string, maximum: number): Buffer {
  if (!isSafeArtifactRelativePath(path)) throw new Error("Unsafe retained import path.");
  let current = resolve(root); const rootStat = lstatSync(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Import root must be a regular directory.");
  for (const part of path.split("/")) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw new Error("Import paths cannot traverse links."); }
  return readBoundedFile(current, "Retained leaderboard source", undefined, maximum);
}
export function parseImportJson(bytes: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder("utf8", { fatal: true }).decode(bytes); assertNoDuplicateJsonKeys(text);
  const value: unknown = JSON.parse(text); let nodes = 0;
  const visit = (value: unknown, depth: number) => {
    if (++nodes > 1_000_000 || depth > 64 || typeof value === "number" && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error("Unbounded import JSON.");
    if (value && typeof value === "object") for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(value, 0);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a retained source object.");
  return value as Record<string, unknown>;
}
export function scanImportedFiles(files: ReadonlyMap<string, Buffer>) {
  const moduleDigests = Object.fromEntries(["exports.js", "redaction.js", "leaderboard-source.js"].map((name) => [name,
    rawHash(readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url))))]));
  const scanner = { id: "ebo.import-secret-patterns", version: "1.0.0", moduleDigests };
  const findings: Array<{ path: string; digest: Hash; reason: "SECRET_PATTERN" | "SCAN_UNAVAILABLE" }> = [];
  for (const [path, bytes] of files) {
    try {
      const type = path.endsWith(".json") ? "application/json" : path.endsWith(".jsonl") ? "application/x-ndjson" : "text/plain";
      if (containsPortableSecretPattern(path, "text/plain") || containsPortableSecretPattern(bytes.toString("utf8"), type)) findings.push({ path, digest: rawHash(bytes), reason: "SECRET_PATTERN" });
    } catch { findings.push({ path, digest: rawHash(bytes), reason: "SCAN_UNAVAILABLE" }); }
  }
  return { schemaVersion: "ebo.import-scan/v1", scanner, scannerDigest: metadataHash(scanner), inputDigest: metadataHash([...files].map(([path, bytes]) => ({ path, digest: rawHash(bytes), bytes: bytes.length })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), status: findings.length ? "quarantined" : "clean", findings };
}

/** Reads only enumerated protected metadata. Agent-writable usage logs cannot become board facts. */
export function readLeaderboardSource(root: string, acquisitionPath = "acquisition.json", historyCompleteness: "complete" | "bounded-subset" = "bounded-subset") {
  const receiptBytes = readClosedImportFile(root, acquisitionPath, 4 * 1024 * 1024);
  const acquisition = parseImportJson(receiptBytes) as unknown as LeaderboardAcquisition;
  const errors = validateArtifact("Leaderboard acquisition", acquisition);
  if (errors.length) throw new Error(`Invalid leaderboard acquisition: ${errors[0]!.message}`);
  if (acquisition.schemaVersion !== "ebo.leaderboard-acquisition/v1" || acquisition.source !== LEADERBOARD_BUCKET || acquisition.sharing !== "restricted"
      || !["unstated", "recorded"].includes(acquisition.terms) || typeof acquisition.attribution !== "string" || !acquisition.attribution.trim() || acquisition.attribution.length > 4096
      || !Number.isFinite(Date.parse(acquisition.retrievedAt)) || !Array.isArray(acquisition.artifacts) || acquisition.artifacts.length > 4096) throw new Error("Unsupported leaderboard acquisition receipt.");
  const files = new Map<string, Buffer>();
  const remote = new Set<string>(); let total = 0;
  for (const artifact of [...acquisition.artifacts].sort((a, b) => a.remotePath < b.remotePath ? -1 : a.remotePath > b.remotePath ? 1 : 0)) {
    if (!artifact || artifact.authority !== "protected-leaderboard-record" || !isSafeArtifactRelativePath(artifact.localPath)
        || !isSafeArtifactRelativePath(artifact.remotePath) || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
        || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > 4 * 1024 * 1024
        || artifact.listedXetHash !== null && (typeof artifact.listedXetHash !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.listedXetHash))
        || artifact.observedXetHash !== undefined && artifact.observedXetHash !== null && artifact.observedXetHash !== artifact.listedXetHash
        || remote.has(artifact.remotePath) || files.has(artifact.localPath)) throw new Error("Invalid or duplicate protected source descriptor.");
    const match = /^runs\/([^/]+)\/(?:(run|invalid)\.json|([^/]+)\/(trials-(?:[0-9]+|reused)\.jsonl|plan\.json))$/u.exec(artifact.remotePath);
    if (!match) throw new Error("Protected leaderboard sources must be named run records or benchmark facts.");
    const bytes = readClosedImportFile(root, artifact.localPath, 4 * 1024 * 1024); total += bytes.length;
    if (total > 32 * 1024 * 1024 || bytes.length !== artifact.bytes || rawHash(bytes) !== `sha256:${artifact.sha256}`) throw new Error("Retained leaderboard source bytes differ from acquisition.");
    files.set(artifact.localPath, bytes); remote.add(artifact.remotePath);
  }
  const protectedFiles = new Map(acquisition.artifacts.map((artifact): [string, Buffer] => [artifact.remotePath, files.get(artifact.localPath)!]));
  const derived = deriveLeaderboardInput(protectedFiles);
  const input: LeaderboardPolicyInput = { schemaVersion: "ebo.leaderboard-policy-input/v1", policyRevision: LEADERBOARD_PUBLIC_POLICY.revision,
    historyCompleteness, ...derived };
  return { acquisition, receiptBytes, receiptDigest: rawHash(receiptBytes), files, input,
    snapshotDigest: metadataHash({ source: acquisition.source, artifacts: [...acquisition.artifacts].map(({ localPath: _local, ...artifact }) => artifact).sort((a, b) => a.remotePath < b.remotePath ? -1 : a.remotePath > b.remotePath ? 1 : 0) }),
    scan: scanImportedFiles(new Map(acquisition.artifacts.map((artifact) => [artifact.remotePath, files.get(artifact.localPath)!]))),
    acquisitionScan: scanImportedFiles(new Map([["acquisition.json", receiptBytes]])) };
}


export function deriveLeaderboardInput(files: ReadonlyMap<string, Buffer>) {
  const facts: Record<string, unknown>[] = [], runs: Record<string, unknown> = {}, invalid: Record<string, unknown> = {};
  for (const [path, bytes] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const match = /^runs\/([^/]+)\/(?:(run|invalid)\.json|([^/]+)\/(trials-(?:[0-9]+|reused)\.jsonl|plan\.json))$/u.exec(path);
    if (!match) throw new Error("Unsupported protected source path.");
    if (match[2]) {
      const record = parseImportJson(bytes);
      if (match[2] === "run" && record.run_id !== match[1]) throw new Error("Run source identity conflicts with its retained path.");
      const target = match[2] === "run" ? runs : invalid;
      if (Object.hasOwn(target, match[1]!)) throw new Error("Duplicate run metadata.");
      Object.defineProperty(target, match[1]!, { value: record, enumerable: true });
    } else if (match[4]!.endsWith(".jsonl")) {
      for (const line of new TextDecoder("utf8", { fatal: true }).decode(bytes).split(/\r?\n/u).filter(Boolean)) {
        if (Buffer.byteLength(line) > 256 * 1024 || facts.length >= 100_000) throw new Error("Leaderboard fact population exceeds its limits.");
        const fact = parseImportJson(Buffer.from(line));
        if (fact.run_id !== match[1] || fact.benchmark !== match[3]) throw new Error("Fact source identity conflicts with its protected path.");
        facts.push(fact);
      }
    }
  }
  return { facts, runs, invalid };
}
