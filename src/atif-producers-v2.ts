import { canonicalizeMetadata } from "./artifacts.js";
import { digestValue } from "./projection-v2.js";
import { HLB_PI_PILOT_REVISION, HLB_PI_WRAPPER_DIGEST, listAtifProducerProfiles, type AtifProducerFingerprint } from "./atif-profiles.js";

export type AdditionalAtifProfileV2 = {
  id: string; version: "2.0.0"; family: "codex" | "hermes" | "openclaw";
  producer: AtifProducerFingerprint;
  limitations: readonly string[];
  nativeAuthority: string;
  sources: readonly string[];
};
export const HLB_TRAJECTORIES_REVISION = "c4a8c4cb468aa1b1e8f3e31c002d2272cc090236";
const base = "https://huggingface.co/spaces/joelniklaus/harness-leaderboard/blob/";
const common = ["THIRD_PARTY_SOURCE", "CAPTURE_COMPLETENESS_UNPROVEN", "NATIVE_REQUEST_IDENTITIES_UNAVAILABLE", "CONTEXT_REPLACEMENT_BOUNDARIES_UNAVAILABLE"];
const harbor = (family: "codex" | "hermes", formatVersion: string, agentVersion: string, sourceDigest: `sha256:${string}`): AdditionalAtifProfileV2 => ({
  id: `${family}/harbor-0.24.0/${formatVersion}/agent-${agentVersion}/hlb-${HLB_PI_PILOT_REVISION}`, version: "2.0.0", family,
  producer: { formatVersion, agent: { name: family, version: agentVersion },
    converter: { id: `harbor.agents.installed.${family}.${family === "codex" ? "Codex" : "Hermes"}`, packageVersion: "0.24.0", sourceDigest },
    context: { kind: "harness-leaderboard", revision: HLB_PI_PILOT_REVISION, wrapperDigest: HLB_PI_WRAPPER_DIGEST } },
  limitations: [...common, ...(family === "codex" ? ["CONVERTER_OMITS_PENDING_CALLS", "CONVERTER_GROUPED_CLOCKS", "TOOL_FAILURE_NOT_PROJECTED"]
    : ["INFERENCE_COUNT_UNTRACKED", "CONVERTER_MAY_ASSIGN_TOOL_IDS", "TOOL_FAILURE_NOT_PROJECTED", "USAGE_COMPONENT_COMPLETENESS_UNPROVEN"])],
  nativeAuthority: family === "codex" ? "Codex rollout response_item records, including unanswered function_call/custom_tool_call records"
    : "Hermes session export messages, including assistant tool_calls and adjacent tool messages",
  sources: ["https://pypi.org/project/harbor/0.24.0/", `${base}${HLB_PI_PILOT_REVISION}/hlb/harbor_ext/agents.py`],
});
const additional: AdditionalAtifProfileV2[] = [
  harbor("codex", "ATIF-v1.7", "0.162.1", "sha256:1fbd52746468b9734cc3af963c9398a21f6fda6f7173b84fa0ac3ae0fe623c66"),
  harbor("hermes", "ATIF-v1.2", "v0.22.1", "sha256:561549f4c3449e3c4a7cbc3e6929c8b1b02b754567a551feec02df6b7196087e"),
  { id: `openclaw/hlb-${HLB_TRAJECTORIES_REVISION}/ATIF-v1.8/agent-2026.10.4`, version: "2.0.0", family: "openclaw",
    producer: { formatVersion: "ATIF-v1.8", agent: { name: "openclaw", version: "2026.10.4" },
      converter: { id: "hlb.harbor_ext.trajectories.openclaw", packageVersion: "0.1.1", sourceDigest: "sha256:c64c9a8e47c731d4f18337d3e05469044c470d73a57e8e10333c1c8bf004f894" },
      context: { kind: "harness-leaderboard", revision: HLB_TRAJECTORIES_REVISION, wrapperDigest: "sha256:f2170b3c69d6251bf2de44220c1ca7f59bc4d3db2c788d394cdad95ef3a9768b" } },
    limitations: [...common, "INFERENCE_COUNT_UNTRACKED", "CONVERTER_ZERO_FILL_POSSIBLE", "NESTED_RESULTS_ARE_NOT_PARENT_COMPLETION"],
    nativeAuthority: "OpenClaw session transcript entries; fallback openclaw.txt/instruction.txt preserve only partial history",
    sources: [`${base}${HLB_TRAJECTORIES_REVISION}/hlb/harbor_ext/trajectories.py`, `${base}${HLB_TRAJECTORIES_REVISION}/hlb/harbor_ext/agents.py`,
      `${base}${HLB_TRAJECTORIES_REVISION}/scripts/atif_backfill_trajectories.py`] },
];
const registry = new Map(additional.map((profile) => [canonicalizeMetadata(profile.producer), profile]));
export function listAdditionalAtifProfilesV2(): readonly AdditionalAtifProfileV2[] { return structuredClone(additional); }
export function selectAdditionalAtifProfileV2(producer: AtifProducerFingerprint): { profile: AdditionalAtifProfileV2; digest: `sha256:${string}` } | undefined {
  let selected: AdditionalAtifProfileV2 | undefined;
  try { selected = registry.get(canonicalizeMetadata(producer)); } catch { return undefined; }
  return selected ? { profile: structuredClone(selected), digest: digestValue(selected) } : undefined;
}
/** v1 admission and v2 interpretation have separate closed registries; no existing Pi profile is mutated. */
export function listAtifProfilesV2(): readonly { id: string; version: string; producer: AtifProducerFingerprint }[] {
  return [...listAtifProducerProfiles(), ...listAdditionalAtifProfilesV2()].map(({ id, version, producer }) => ({ id, version, producer }));
}
