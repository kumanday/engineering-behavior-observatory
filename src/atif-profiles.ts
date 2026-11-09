import { digestMetadata } from "./artifacts.js";

export type AtifProducerFingerprint = {
  formatVersion: string;
  agent: { name: string; version: string | null };
  converter: { id: string; packageVersion: string; sourceDigest: `sha256:${string}` | null };
  context: { kind: "harbor" | "harness-leaderboard" | "unknown"; revision: string | null; wrapperDigest: `sha256:${string}` | null };
};
export type AtifVersionRange = { minimum: string; before: string };
export type AtifProducerProfile = {
  schemaVersion: "ebo.atif-overlay/v1";
  id: string; version: string; family: "pi" | "codex"; harness: string;
  match: { agentNames: readonly string[]; agentVersion: AtifVersionRange; converterIds: readonly string[]; converterVersion: AtifVersionRange };
  /** Example operator context for CLI discovery; these values are not an admission key. */
  producer: AtifProducerFingerprint;
  rules: { nativeRequests: "unavailable" };
  limitations: readonly string[]; sources: readonly string[]; nativeAuthority: string;
};
export type AtifProfileSelection = { status: "supported"; profile: AtifProducerProfile; profileDigest: `sha256:${string}`; verified: boolean }
  | { status: "absent"; reason: "NO_MATCHING_OVERLAY" };
export const HLB_PI_PILOT_REVISION = "0583ba55ac8ddaea3464c85b54828baeaa8d834a";
export const HLB_PI_WRAPPER_DIGEST = "sha256:e98d1ab28990388683c46652223de9338b55d0aedca756190932bfd6e25593a6" as const;
const example = (family: "pi" | "codex", agentVersion: string): AtifProducerFingerprint => ({ formatVersion: "ATIF-v1.7", agent: { name: family, version: agentVersion },
  converter: { id: `harbor.agents.installed.${family}.${family === "pi" ? "Pi" : "Codex"}`, packageVersion: "0.24.0", sourceDigest: null },
  context: { kind: "unknown", revision: null, wrapperDigest: null } });
const overlays: readonly AtifProducerProfile[] = [
  { schemaVersion: "ebo.atif-overlay/v1", id: "ebo.pi-harbor", version: "2.0.0", family: "pi", harness: "atif.generic",
    match: { agentNames: ["pi"], agentVersion: { minimum: "0.85.0", before: "2.0.0" }, converterIds: ["harbor.agents.installed.pi.Pi"], converterVersion: { minimum: "0.24.0", before: "0.26.0" } },
    producer: example("pi", "1.2.0"), rules: { nativeRequests: "unavailable" },
    limitations: ["CAPTURE_COMPLETENESS_UNPROVEN", "BRANCH_HISTORY_MAY_BE_OMITTED", "CONVERTER_ZERO_FILL_POSSIBLE", "NATIVE_REQUEST_IDENTITIES_UNAVAILABLE"],
    nativeAuthority: "Pi native session messages and tool-result isError fields",
    sources: ["https://github.com/harbor-framework/harbor/blob/v0.25.0/src/harbor/agents/installed/pi.py"] },
  { schemaVersion: "ebo.atif-overlay/v1", id: "ebo.codex-harbor", version: "2.0.0", family: "codex", harness: "atif.generic",
    match: { agentNames: ["codex"], agentVersion: { minimum: "0.162.0", before: "0.163.0" }, converterIds: ["harbor.agents.installed.codex.Codex"], converterVersion: { minimum: "0.24.0", before: "0.26.0" } },
    producer: example("codex", "0.162.1"), rules: { nativeRequests: "unavailable" },
    limitations: ["CAPTURE_COMPLETENESS_UNPROVEN", "CONVERTER_OMITS_PENDING_CALLS", "CONVERTER_REORDERS_MODEL_OUTPUTS", "CONVERTER_MAY_SPLIT_INFERENCE_GROUPS", "CONVERTER_ARGUMENT_NORMALIZATION_MAY_BE_LOSSY", "CONVERTER_MAY_FABRICATE_CALLS_FOR_ORPHAN_RESULTS", "BUILTIN_RESULT_SLOTS_MAY_BE_SYNTHETIC", "CONVERTER_GROUPED_CLOCKS", "TOOL_FAILURE_NOT_PROJECTED"],
    nativeAuthority: "Codex rollout response_item records, including unanswered function_call/custom_tool_call records",
    sources: ["https://github.com/harbor-framework/harbor/blob/v0.25.0/src/harbor/agents/installed/codex.py"] },
];
function inRange(value: string | null, range: AtifVersionRange): boolean {
  if (value === null || !/^v?\d+\.\d+\.\d+$/u.test(value)) return false;
  const parse = (v: string) => v.replace(/^v/u, "").split(".").map(Number);
  const compare = (a: number[], b: number[]) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!; return 0; };
  const version = parse(value); return compare(version, parse(range.minimum)) >= 0 && compare(version, parse(range.before)) < 0;
}
/** Name + converter identify optional conventions; versions qualify confidence, never core eligibility. */
export function selectAtifOverlay(producer: AtifProducerFingerprint): AtifProfileSelection {
  const profile = overlays.find(({ match }) => match.agentNames.includes(producer.agent.name.toLowerCase()) && match.converterIds.includes(producer.converter.id));
  return profile ? { status: "supported", profile: structuredClone(profile), profileDigest: `sha256:${digestMetadata(profile).value}`,
    verified: inRange(producer.agent.version, profile.match.agentVersion) && inRange(producer.converter.packageVersion, profile.match.converterVersion) }
    : { status: "absent", reason: "NO_MATCHING_OVERLAY" };
}
/** Compatibility discovery API; only Pi conventions are returned here. */
export function listAtifProducerProfiles(): readonly AtifProducerProfile[] { return structuredClone(overlays.filter(({ family }) => family === "pi")); }
export function listAtifOverlays(): readonly AtifProducerProfile[] { return structuredClone(overlays); }
export const selectAtifProducerProfile = selectAtifOverlay;
