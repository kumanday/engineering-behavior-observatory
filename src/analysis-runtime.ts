import { createRequire } from "node:module";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digestBytes, assertNoDuplicateJsonKeys, validateArtifact } from "./artifacts.js";
import { isSafeArtifactRelativePath } from "./contracts.js";
import { readBoundedFile } from "./scheduler.js";
import type { createRetainedBehaviorEvidence } from "./retained-evidence.js";
import type { createRetainedStructuralObservationSet, validateStructuralObservationSet } from "./structural-observations.js";
import type { validateRetainedBehaviorAssertion } from "./behavior-assertions.js";
import type { verifyPacket, roCrate } from "./atlas-packet.js";
import type { loadAtlas, queryAtlas } from "./atlas.js";

type Hash = `sha256:${string}`;
export type AnalysisRuntimeIdentity = { id: string; sourceCommit: string; manifestDigest: Hash; nodeVersion: string };
export type FrozenAnalysisRuntime = {
  identity: AnalysisRuntimeIdentity;
  createRetainedBehaviorEvidence: typeof createRetainedBehaviorEvidence;
  createRetainedStructuralObservationSet: typeof createRetainedStructuralObservationSet;
  validateStructuralObservationSet: typeof validateStructuralObservationSet;
  validateRetainedBehaviorAssertion: typeof validateRetainedBehaviorAssertion;
  verifyPacket: typeof verifyPacket;
  roCrate: typeof roCrate;
  loadAtlas: typeof loadAtlas;
  queryAtlas: typeof queryAtlas;
};
export type AnalysisRuntimeSnapshot = {
  schemaVersion: "ebo.analysis-runtime-snapshot/v1";
  id: string;
  source: { repository: string; commit: string };
  nodeVersion: string;
  builder: { id: string; version: string };
  entry: string;
  exports: string[];
  dependencies: Record<string, string>;
  files: Array<{ path: string; bytes: number; digest: Hash }>;
};
const registered: readonly AnalysisRuntimeIdentity[] = [{ id: "ebo-v1.4-atif-20261107", sourceCommit: "fb1dfd7397836de1eab370090534433f0383f45f",
  manifestDigest: "sha256:16c2da39f03f44e33eaccd8ddc9f72de6b73e3a5cf25152ae292f8e7295548c5", nodeVersion: "24.19.0" }];
const expectedExports = ["createRetainedBehaviorEvidence", "createRetainedStructuralObservationSet", "loadAtlas", "queryAtlas", "roCrate", "validateRetainedBehaviorAssertion", "validateStructuralObservationSet", "verifyPacket"].sort();
const rawHash = (bytes: Uint8Array): Hash => `sha256:${digestBytes(bytes).value}`;

export function listAnalysisRuntimes(): readonly AnalysisRuntimeIdentity[] { return structuredClone(registered); }

/** Select only shipped, digest-pinned implementation. A packet cannot provide a path, module or registry entry. */
export async function loadAnalysisRuntime(id: string): Promise<FrozenAnalysisRuntime> {
  const identity = registered.find((runtime) => runtime.id === id);
  if (!identity) throw new Error("Unsupported analysis runtime identity; imported reader code is never loaded.");
  if (process.versions.node !== identity.nodeVersion) throw new Error(`Analysis runtime requires Node ${identity.nodeVersion}.`);
  const root = fileURLToPath(new URL(`../../compatibility/${identity.id}/`, import.meta.url));
  const manifest = validateRuntimeSnapshot(root, identity.manifestDigest);
  if (manifest.id !== identity.id || manifest.source.commit !== identity.sourceCommit || manifest.nodeVersion !== identity.nodeVersion
      || manifest.entry !== "dist/src/reader.mjs" || JSON.stringify(manifest.exports) !== JSON.stringify(expectedExports)) throw new Error("Registered analysis runtime identity differs from its snapshot.");
  const require = createRequire(join(root, manifest.entry));
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    if (installedVersion(name, require) !== version) throw new Error(`Analysis runtime dependency ${name} differs from its pinned version.`);
  }
  const implementation = await import(pathToFileURL(join(root, manifest.entry)).href) as Omit<FrozenAnalysisRuntime, "identity">;
  if (JSON.stringify(Object.keys(implementation).sort()) !== JSON.stringify(expectedExports)
      || expectedExports.some((name) => typeof implementation[name as keyof typeof implementation] !== "function")) throw new Error("Analysis runtime exports differ from the shipped interface.");
  return Object.freeze({ ...implementation, identity: Object.freeze({ ...identity }) });
}

/** Integrity inspection only. Verification of another directory never registers or executes it. */
export function validateRuntimeSnapshot(root: string, expectedManifestDigest: Hash): AnalysisRuntimeSnapshot {
  const stat = lstatSync(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Analysis runtime snapshot must be a regular directory.");
  const bytes = readBoundedFile(join(root, "runtime-manifest.json"), "Analysis runtime manifest", undefined, 1024 * 1024);
  if (rawHash(bytes) !== expectedManifestDigest) throw new Error("Analysis runtime manifest digest differs from its registered identity.");
  const text = new TextDecoder("utf8", { fatal: true }).decode(bytes); assertNoDuplicateJsonKeys(text);
  const manifest = JSON.parse(text) as AnalysisRuntimeSnapshot;
  const errors = validateArtifact("Analysis runtime snapshot", manifest);
  if (errors.length) throw new Error(`Invalid analysis runtime snapshot: ${errors[0]!.message}`);
  if (manifest.schemaVersion !== "ebo.analysis-runtime-snapshot/v1" || !Array.isArray(manifest.files) || manifest.files.length > 512
      || !manifest.dependencies || typeof manifest.dependencies !== "object" || Array.isArray(manifest.dependencies) || Object.keys(manifest.dependencies).length > 128
      || Object.entries(manifest.dependencies).some(([name, version]) => !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/u.test(name) || typeof version !== "string" || version.length > 128)) throw new Error("Invalid analysis runtime snapshot manifest.");
  const listed = new Set<string>(); let total = 0;
  for (const file of manifest.files) {
    if (!isSafeArtifactRelativePath(file.path) || file.path === "runtime-manifest.json" || listed.has(file.path) || !Number.isSafeInteger(file.bytes)
        || file.bytes < 0 || file.bytes > 16 * 1024 * 1024 || !/^sha256:[a-f0-9]{64}$/u.test(file.digest)) throw new Error("Invalid analysis runtime file descriptor.");
    listed.add(file.path); total += file.bytes; if (total > 32 * 1024 * 1024) throw new Error("Analysis runtime exceeds its aggregate byte limit.");
  }
  for (const file of manifest.files) {
    let path = root;
    for (const component of file.path.split("/")) { path = join(path, component); if (lstatSync(path).isSymbolicLink()) throw new Error("Analysis runtime paths cannot traverse links."); }
    const retained = readBoundedFile(path, "Analysis runtime asset", undefined, file.bytes);
    if (retained.length !== file.bytes || rawHash(retained) !== file.digest) throw new Error("Analysis runtime asset differs from its frozen digest.");
  }
  const present: string[] = [];
  const walk = (directory: string, prefix: string, depth: number) => {
    if (depth > 16) throw new Error("Analysis runtime directory depth exceeds its limit.");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Analysis runtime paths cannot contain links.");
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), path, depth + 1);
      else { present.push(path); if (present.length > 513) throw new Error("Analysis runtime inventory exceeds its limit."); }
    }
  };
  walk(root, "", 0);
  if (present.some((path) => path !== "runtime-manifest.json" && !listed.has(path)) || present.length !== listed.size + 1) throw new Error("Analysis runtime contains missing or unlisted assets.");
  return manifest;
}
function installedVersion(name: string, require: NodeJS.Require): string | undefined {
  const paths = require.resolve.paths(name) ?? [];
  for (const root of paths) {
    const file = join(root, name, "package.json");
    try {
      const record = JSON.parse(readBoundedFile(file, "Analysis runtime dependency", undefined, 1024 * 1024).toString("utf8")) as { name?: string; version?: string };
      if (record.name === name) return record.version;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error; }
  }
  return undefined;
}
