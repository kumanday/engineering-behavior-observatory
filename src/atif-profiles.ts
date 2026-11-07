import { canonicalizeMetadata, digestMetadata } from "./artifacts.js";

export type AtifProducerFingerprint = {
  formatVersion: string;
  agent: { name: string; version: string | null };
  converter: { id: string; packageVersion: string; sourceDigest: `sha256:${string}` | null };
  context: { kind: "harbor" | "harness-leaderboard" | "unknown"; revision: string | null; wrapperDigest: `sha256:${string}` | null };
};
export type AtifProducerProfile = {
  schemaVersion: "ebo.atif-producer-profile/v1";
  id: string;
  version: string;
  harness: string;
  producer: AtifProducerFingerprint;
  rules: {
    operationIdentity: "document-scoped-native-tool-call-id";
    resultFailure: "pi-result-extra-is-error";
    inputTokens: "inclusive-prompt-minus-cache-read-and-write";
    usageAuthority: "step-metrics-reconciled-with-root-final";
    inferenceCount: "declared-llm-call-count";
    nativeRequests: "unavailable";
    copiedContext: "exclude-new-behavior";
    gaps: "withhold-exact-attempt-measures";
    context: "pi-event-type-and-explicit-transformations";
    branchSelection: "active-root-to-leaf";
    termination: "source-declared-not-owned";
  };
  limitations: readonly string[];
  sources: readonly string[];
};
export type AtifProfileSelection = { status: "supported"; profile: AtifProducerProfile; profileDigest: `sha256:${string}` }
  | { status: "unsupported"; reason: "PRODUCER_PROFILE_UNREGISTERED" };

export const HARBOR_PI_CONVERTER_DIGEST = "sha256:5d51eddbbbf8f5bcab2263fe3ada99bd9611add2e857c4b7d4f4c2eb3a2a5487" as const;
export const HLB_PI_WRAPPER_DIGEST = "sha256:e98d1ab28990388683c46652223de9338b55d0aedca756190932bfd6e25593a6" as const;
export const HLB_PI_PILOT_REVISION = "0583ba55ac8ddaea3464c85b54828baeaa8d834a";

const commonRules: AtifProducerProfile["rules"] = {
  operationIdentity: "document-scoped-native-tool-call-id", resultFailure: "pi-result-extra-is-error",
  inputTokens: "inclusive-prompt-minus-cache-read-and-write", usageAuthority: "step-metrics-reconciled-with-root-final",
  inferenceCount: "declared-llm-call-count", nativeRequests: "unavailable", copiedContext: "exclude-new-behavior",
  gaps: "withhold-exact-attempt-measures", context: "pi-event-type-and-explicit-transformations",
  branchSelection: "active-root-to-leaf", termination: "source-declared-not-owned",
};
const limitations = ["THIRD_PARTY_SOURCE", "CAPTURE_COMPLETENESS_UNPROVEN", "BRANCH_HISTORY_MAY_BE_OMITTED",
  "CONVERTER_ZERO_FILL_POSSIBLE", "NATIVE_REQUEST_IDENTITIES_UNAVAILABLE"];
const converter = { id: "harbor.agents.installed.pi.Pi", packageVersion: "0.24.0", sourceDigest: HARBOR_PI_CONVERTER_DIGEST };
const profile = (agentVersion: string, context: AtifProducerFingerprint["context"]): AtifProducerProfile => ({
  schemaVersion: "ebo.atif-producer-profile/v1",
  id: `pi/harbor-0.24.0/atif-1.7/agent-${agentVersion}/${context.kind}${context.revision === null ? "" : `-${context.revision}`}`,
  version: "1.0.0", harness: context.kind === "harbor" ? "atif.harbor.pi" : "atif.harness-leaderboard.pi",
  producer: { formatVersion: "ATIF-v1.7", agent: { name: "pi", version: agentVersion }, converter: { ...converter }, context: { ...context } },
  rules: { ...commonRules }, limitations: [...limitations, ...(agentVersion === "unknown" ? ["AGENT_VERSION_UNREPORTED"] : [])],
  sources: ["https://pypi.org/project/harbor/0.24.0/", ...(context.kind === "harness-leaderboard"
    ? [`https://huggingface.co/spaces/joelniklaus/harness-leaderboard/blob/${HLB_PI_PILOT_REVISION}/hlb/harbor_ext/agents.py`,
      `https://huggingface.co/spaces/joelniklaus/harness-leaderboard/blob/${HLB_PI_PILOT_REVISION}/uv.lock`] : [])],
});
const profiles = [
  profile("unknown", { kind: "harbor", revision: null, wrapperDigest: null }),
  profile("1.2.0", { kind: "harness-leaderboard", revision: HLB_PI_PILOT_REVISION, wrapperDigest: HLB_PI_WRAPPER_DIGEST }),
];
const registry = new Map(profiles.map((value) => [canonicalizeMetadata(value.producer), value]));

/** Closed registry: matching agent names never infer converter provenance or unknown version conventions. */
export function selectAtifProducerProfile(producer: AtifProducerFingerprint): AtifProfileSelection {
  let selected: AtifProducerProfile | undefined;
  try { selected = registry.get(canonicalizeMetadata(producer)); } catch { /* Unsupported provenance remains unavailable. */ }
  return selected === undefined ? { status: "unsupported", reason: "PRODUCER_PROFILE_UNREGISTERED" }
    : { status: "supported", profile: structuredClone(selected), profileDigest: `sha256:${digestMetadata(selected).value}` };
}

export function listAtifProducerProfiles(): readonly AtifProducerProfile[] { return structuredClone(profiles); }
