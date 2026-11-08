/** Compare frozen independent conversions against native readback. Reports include private source identities. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRetainedBehaviorEvidence } from "../dist/src/retained-evidence.js";
import { toolOperations } from "../dist/src/structural-observations.js";
import { digestMetadata } from "../dist/src/artifacts.js";
import { compareFixtureMeasurement, compareFixtureSignatures } from "../dist/test/atif-fixture-gate.js";
import { piFixtureSourceMeasures } from "./atif-fixture-summary.mjs";

const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath) throw new Error("Usage: node scripts/check-pi-fixture-pairs.mjs <frozen-pair-manifest.json> <new-report.json>");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = readFileSync(manifestPath);
const manifest = JSON.parse(source);

const report = { schemaVersion: "ebo.pi-fixture-comparison/v1", sourceManifestSha256: hash(source), harborVersion: manifest.harborVersion,
  sourceAuditorSha256: hash(readFileSync(new URL("./atif-fixture-summary.mjs", import.meta.url))),
  gateSha256: hash(readFileSync(new URL("../dist/test/atif-fixture-gate.js", import.meta.url))),
  status: "incomplete", fixtures: [] };
writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const losses = ["STEP_USAGE_INCOMPLETE", "STEP_FINAL_USAGE_CONFLICT", "PI_INCLUSIVE_PROMPT_CONFLICT", "PRODUCER_PARTIAL_HISTORY", "TOOL_RESULT_STATUS_INCOMPLETE"];
for (const fixture of manifest.fixtures) {
  const bytes = readFileSync(fixture.trajectory);
  if (hash(bytes) !== fixture.trajectorySha256) throw new Error("Frozen trajectory changed");
  for (const artifact of fixture.artifacts ?? []) if (hash(readFileSync(join(dirname(fixture.trajectory), artifact.relativePath))) !== artifact.sha256) throw new Error("Frozen sidecar changed");
  if (hash(readFileSync(join(fixture.sourceRoot, "manifest.json"))) !== fixture.nativeManifestSha256
    || hash(readFileSync(join(fixture.sourceRoot, "pi-session.jsonl"))) !== fixture.nativeSessionSha256) throw new Error("Frozen native source bytes changed");
  const evidence = await createRetainedBehaviorEvidence(fixture.sourceRoot);
  if (`sha256:${digestMetadata(evidence.dataset).value}` !== fixture.nativeDatasetDigest) throw new Error("Frozen native dataset changed");
  const projected = piFixtureSourceMeasures(JSON.parse(bytes));
  const nativeSignatures = toolOperations(evidence.dataset.events).map((operation) => ({ id: operation.events.map((event) => event.attributes.toolCallId ?? event.attributes.toolUseId)
    .find((value) => typeof value === "string") ?? operation.events.find((event) => event.scope.kind === "operation")?.scope.id,
    name: operation.toolName, failed: operation.failed })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const comparisons = Object.entries(projected.measures).map(([measure, imported]) => ({ measure, native: fixture.nativeMeasures[measure], imported,
    gate: compareFixtureMeasurement(fixture.nativeMeasures[measure], imported, { allowedLossReasons: losses }) }));
  // A native lifecycle record count is not interchangeable with the converter's retained boundary count.
  const boundary = fixture.nativeMeasures["compaction-boundary-record-count"];
  const convertedBoundary = { status: "unavailable", reason: "SOURCE_RECORD_CARDINALITY_NOT_PRESERVED" };
  comparisons.push({ measure: "compaction-boundary-record-count", native: boundary, imported: convertedBoundary,
    gate: compareFixtureMeasurement(boundary, convertedBoundary, { allowedLossReasons: [convertedBoundary.reason] }),
    recordedConvertedBoundaries: projected.summary.compactions });
  report.fixtures.push({ id: fixture.id, comparisons, nativeSignatures, importedSignatures: projected.signatures,
    signatureGate: compareFixtureSignatures(nativeSignatures, projected.signatures, losses),
    operationSignatureAgreement: JSON.stringify(nativeSignatures) === JSON.stringify(projected.signatures) });
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}
const failures = report.fixtures.filter((row) => row.signatureGate.gate.status === "fail" || row.comparisons.some(({ gate }) => gate.status === "fail"));
report.status = failures.length ? "failed" : "passed";
report.failureCount = failures.length;
writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ fixtures: report.fixtures.length, status: report.status, failures: failures.length }));
if (failures.length) process.exitCode = 1;
