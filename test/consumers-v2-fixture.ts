import type { AgentSdkNativeRecord } from "../src/agent-sdk-normalizer.js";
import type { NormalizationInput } from "../src/uniform-events.js";
import { readFileSync } from "node:fs";
import { inspectAtifBytes, type AtifObject } from "../src/atif-reader.js";
import { listAtifProducerProfiles } from "../src/atif-profiles.js";
import { projectPiAtifV2 } from "../src/atif-v2.js";
import { analysisDigestV2 } from "../src/analysis-v2.js";
export async function atifFixtureV2(name = "parallel-failure-cache-write", edit?: (source: AtifObject) => void) {
  const source = JSON.parse(readFileSync(new URL(`../../test/fixtures/atif/pi/${name}.atif.json`, import.meta.url), "utf8")) as AtifObject;
  edit?.(source);
  const read = inspectAtifBytes(Buffer.from(JSON.stringify(source)));
  // Projection-only authored fixture; retained admission tests exercise the pinned validator receipt.
  read.inspection.structural = { status: "valid", validator: "harbor", version: "0.24.0", diagnostics: [] };
  const evidence = await projectPiAtifV2({ read, producer: listAtifProducerProfiles()[0]!.producer, runId: "run", attemptId: "attempt", manifestDigest: analysisDigestV2("fixture") });
  return { ...evidence, modelAliases: ["synthetic-model"] };
}

export async function nativeFixtureV2(name: string, edit?: (records: Array<Record<string, unknown>>) => void) {
  const { qualifyRetainedPiCapture, describeAndValidatePiDataset } = await import("../src/pi.js");
  const { projectNativeEvidenceV2 } = await import("../src/native-v2.js");
  const records = readFileSync(new URL(`../../test/fixtures/atif/pi/${name}.native.jsonl`, import.meta.url), "utf8").trim().split("\n")
    .map((line, index) => ({ reference: { artifactId: "pi-session", recordLocator: `line:${index + 1}` }, record: JSON.parse(line) }));
  edit?.(records.map(({ record }) => record));
  const capture = qualifyRetainedPiCapture({ runId: "run", attemptId: "attempt", qualification: "qualified-with-gaps", records }, "synthetic-pi-fixture", false);
  const read = await describeAndValidatePiDataset(capture);
  const evidence = { capture, ...read, outcomeCapture: { ...capture, records: [] } };
  return projectNativeEvidenceV2(evidence, { manifestDigest: analysisDigestV2("synthetic-native-manifest"), harnessVersion: "fixture-only" });
}

export async function claudeBlockFixtureV2() {
  const { claudeAgentSdkNormalizationAdapter, createAgentSdkNativeEvidenceResolver } = await import("../src/agent-sdk-normalizer.js");
  const { describeNormalizedDataset, validateNormalizedDataset } = await import("../src/normalization-integrity.js");
  const { projectNativeEvidenceV2 } = await import("../src/native-v2.js");
  const capture: NormalizationInput<AgentSdkNativeRecord> = { runId: "run", attemptId: "attempt", qualification: "qualified-with-gaps", records: ["first block", "second block"].map((text, index) => ({
    reference: { artifactId: "session", recordLocator: `line:${index + 1}` }, record: { kind: "session" as const, document: { sequence: index + 1, nativeType: "assistant", sessionId: "s",
      message: { type: "assistant", uuid: `block-${index}`, session_id: "s", message: { id: "shared-output", role: "assistant", stop_reason: null, model: "synthetic-model", content: [{ type: "text", text }] } } } }
  })) };
  capture.records = [...capture.records,
    { reference: { artifactId: "hooks", recordLocator: "line:1" }, record: { kind: "hook", document: { hook: "SessionStart", sessionId: "s", nativePayload: { session_id: "s", cwd: "/synthetic" } } } },
    { reference: { artifactId: "manifest", recordLocator: "#" }, record: { kind: "manifest", document: { run: { id: "run", assessmentMode: "observational" }, attempt: { id: "attempt" } } } },
    { reference: { artifactId: "manifest", recordLocator: "#/run/assessmentMode" }, record: { kind: "assessment-mode", document: "observational" } },
  ];
  const normalization = await claudeAgentSdkNormalizationAdapter.normalize(capture), resolver = createAgentSdkNativeEvidenceResolver(capture);
  const refs = new Map(capture.records.map(({ record, reference }) => [record, JSON.stringify(reference)]));
  const nativeTypes = new Map(normalization.events.map(({ source }) => [JSON.stringify(source.nativeReference), source.nativeType]));
  const dataset = describeNormalizedDataset({ capture, normalization, capabilityProfile: normalization.capabilityProfile, adapterVersion: "fixture", nativeType: (record) => nativeTypes.get(refs.get(record)!) ?? record.kind });
  const coverage = await validateNormalizedDataset(dataset, resolver);
  return projectNativeEvidenceV2({ capture, dataset, resolver, coverage, outcomeCapture: { ...capture, records: [] } }, { manifestDigest: analysisDigestV2("fixture"), harnessVersion: "fixture" });
}
