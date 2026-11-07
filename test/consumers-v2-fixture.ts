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

export async function nativeFixtureV2(name: string) {
  const { qualifyRetainedPiCapture, describeAndValidatePiDataset } = await import("../src/pi.js");
  const { projectNativeEvidenceV2 } = await import("../src/native-v2.js");
  const records = readFileSync(new URL(`../../test/fixtures/atif/pi/${name}.native.jsonl`, import.meta.url), "utf8").trim().split("\n")
    .map((line, index) => ({ reference: { artifactId: "pi-session", recordLocator: `line:${index + 1}` }, record: JSON.parse(line) }));
  const capture = qualifyRetainedPiCapture({ runId: "run", attemptId: "attempt", qualification: "qualified-with-gaps", records }, "synthetic-pi-fixture", false);
  const read = await describeAndValidatePiDataset(capture);
  const evidence = { capture, ...read, outcomeCapture: { ...capture, records: [] } };
  return projectNativeEvidenceV2(evidence, { manifestDigest: analysisDigestV2("synthetic-native-manifest"), harnessVersion: "fixture-only" });
}
