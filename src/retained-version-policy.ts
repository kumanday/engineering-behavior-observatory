import type { AdapterCapabilityProfile } from "./uniform-events.js";

/** Verified versions affect confidence in the format interpretation, never admission. */
export function retainedVersionProfile(profile: AdapterCapabilityProfile, versions: readonly string[], actual: string): AdapterCapabilityProfile {
  return versions.includes(actual) ? profile : { ...profile, limitations: [...new Set([...(profile.limitations ?? []), "HARNESS_VERSION_UNVERIFIED"])] };
}

/** Retained declarations may disagree; preserve the evidence and mark version confidence. */
export function markRetainedVersion<T extends import("./uniform-events.js").QualifiedNativeCapture<unknown>>(
  capture: T, declared: string, verified: readonly string[], observed: readonly unknown[] = [],
): T {
  const conflict = observed.some((version) => typeof version === "string" && version !== declared);
  const unverified = !verified.includes(declared) || observed.some((version) => typeof version !== "string" || !verified.includes(version)) || conflict;
  return unverified ? { ...capture, sourceLimitations: [...new Set([...(capture.sourceLimitations ?? []), "HARNESS_VERSION_UNVERIFIED", ...conflict ? ["HARNESS_VERSION_CONFLICT"] : []])] } : capture;
}
