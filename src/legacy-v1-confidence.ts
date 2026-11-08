import {readFileSync} from "node:fs";
import type {AdapterCapabilityProfile, QualifiedNativeCapture} from "./uniform-events.js";

// Immutable serialization policy for existing v1 dataset/assertion digests.
// Current verification comes only from the frozen catalog, outside this payload.
const historical = JSON.parse(readFileSync(new URL("../../compatibility/native-v1-annotations.json", import.meta.url), "utf8")) as {versions: Record<string, string[]>};
const versions = (key: string): ReadonlySet<string> => new Set(historical.versions[key === "agent-sdk" ? "claude-agent-sdk" : key] ?? []);
export function legacyV1Profile(profile: AdapterCapabilityProfile, key: string, actual: string): AdapterCapabilityProfile {
  return versions(key).has(actual) ? profile : {...profile, limitations: [...new Set([...(profile.limitations ?? []), "HARNESS_VERSION_UNVERIFIED"])]};
}
export function markRetainedVersion<T extends QualifiedNativeCapture<unknown>>(capture: T, declared: string, key: string, observed: readonly unknown[] = []): T {
  const known = versions(key), conflict = observed.some(version => typeof version === "string" && version !== declared);
  const annotated = !known.has(declared) || observed.some(version => typeof version !== "string" || !known.has(version)) || conflict;
  return annotated ? {...capture, sourceLimitations: [...new Set([...(capture.sourceLimitations ?? []), "HARNESS_VERSION_UNVERIFIED", ...conflict ? ["HARNESS_VERSION_CONFLICT"] : []])]} : capture;
}
