import { applyAtifOverlays } from "./atif-overlays.js";
import { readAtifImportAdmission } from "./atif-import.js";
import { projectAtifCore, type AtifCoreInput } from "./atif-core.js";
import type { RetainedBehaviorEvidenceV2 } from "./native-v2.js";
import { digestValue } from "./projection-v2.js";

/** Every conforming ATIF producer enters the same standard projection. */
export async function projectAtifV2(input: AtifCoreInput): Promise<RetainedBehaviorEvidenceV2> {
  return applyAtifOverlays((await projectAtifCore(input)).v2, input);
}

/** Compatibility spelling; Pi is no longer the generic reader's admission key. */
export const projectPiAtifV2 = projectAtifV2;

export async function readImportedBehaviorEvidenceV2(bundleRoot: string): Promise<RetainedBehaviorEvidenceV2> {
  const { manifest, read, interpretationRevision } = readAtifImportAdmission(bundleRoot);
  const projected = await projectAtifV2({ read, producer: manifest.producer, ...manifest.identity, manifestDigest: digestValue(manifest) });
  return { ...projected, interpretationRevision, modelAliases: [...new Set([...projected.modelAliases ?? [], ...manifest.blinding?.modelAliases ?? []])].sort() };
}
