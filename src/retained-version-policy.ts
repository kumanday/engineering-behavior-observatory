import { currentVerificationContext, currentVerificationResult } from "./verification-context.js";
import { listRuntimeRecipes } from "./runtime-catalog.js";

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
