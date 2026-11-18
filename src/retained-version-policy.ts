import { currentVerificationContext, currentVerificationResult } from "./verification-context.js";
import { listRuntimeRecipes } from "./runtime-catalog.js";
import type { QualifiedNativeCapture } from "./uniform-events.js";

/** Only admitted, frozen verification evidence decides confidence. Runtime versions never gate parsing. */
export function versionConfidence(harness: string, actual: string, componentName?: string): string[] {
  harness = harness === "agent-sdk" ? "claude-agent-sdk" : harness;
  const current = currentVerificationContext(), snapshot = current?.snapshot;
  const expectedName = componentName ?? listRuntimeRecipes().find(recipe => recipe.harness === harness)?.components[0]?.name;
  const matches = snapshot?.subject.harness === harness && snapshot.subject.components.some(component => component.name === expectedName && component.version === actual);
  const result = currentVerificationResult();
  if (!matches || result.state === "unverified") return ["HARNESS_VERSION_UNVERIFIED"];
  const limitations: string[] = [];
  if (Object.entries(result.claims).some(([claim, status]) => !["installation", "runtime-probe", "module-api"].includes(claim) && status !== "checked")) limitations.push("HARNESS_CAPTURE_UNVERIFIED");
  if (Object.values(result.claims).includes("conflict")) limitations.push("HARNESS_VERIFICATION_CONFLICT");
  return limitations;
}

/**
 * Compare the harness version a bundle declares with the versions its own native records state. A record that states no
 * version leaves the declaration unverified; one that states another version is a conflict. Neither rejects reading.
 */
export function markDeclaredVersion<T extends QualifiedNativeCapture<unknown>>(capture: T, declared: string, observed: readonly unknown[] = []): T {
  const conflict = observed.some((version) => typeof version === "string" && version !== declared);
  if (!conflict && observed.every((version) => typeof version === "string")) return capture;
  return { ...capture, sourceLimitations: [...new Set([...(capture.sourceLimitations ?? []), "HARNESS_VERSION_UNVERIFIED", ...(conflict ? ["HARNESS_VERSION_CONFLICT"] : [])])] };
}
