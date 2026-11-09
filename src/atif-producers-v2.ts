import { listAtifOverlays, selectAtifOverlay, type AtifProducerFingerprint, type AtifProducerProfile } from "./atif-profiles.js";
export type AdditionalAtifProfileV2 = AtifProducerProfile;
export function listAdditionalAtifProfilesV2(): readonly AdditionalAtifProfileV2[] { return listAtifOverlays().filter(({ family }) => family === "codex"); }
export function selectAdditionalAtifProfileV2(producer: AtifProducerFingerprint) {
  const selected = selectAtifOverlay(producer);
  return selected.status === "supported" && selected.profile.family === "codex" ? { profile: selected.profile, digest: selected.profileDigest, verified: selected.verified } : undefined;
}
export const listAtifProfilesV2 = listAtifOverlays;
