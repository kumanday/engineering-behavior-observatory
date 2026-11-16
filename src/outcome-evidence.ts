import type { AgentSdkNativeRecord } from "./agent-sdk-normalizer.js";
import type { ImportedNativeEvidence, NormalizationInput } from "./uniform-events.js";

/** Imported records retain third-party authority and cannot assert an EBO-owned terminal. */
export type ImportedOutcomeRecord = {
  schemaVersion: "ebo.imported-outcome-record/v1";
  kind: "imported-source";
  authority: "third-party";
  document: unknown;
};
export type OutcomeEvidenceInput = NormalizationInput<AgentSdkNativeRecord> | ImportedNativeEvidence<ImportedOutcomeRecord>;
