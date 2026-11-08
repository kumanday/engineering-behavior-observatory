import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectAtifBytes, readAtifFile } from "../src/atif-reader.js";
import { projectAtifV2 } from "../src/atif-v2.js";
import { listAtifProducerProfiles } from "../src/atif-profiles.js";
import { importAtifFile, readImportedBehaviorEvidence } from "../src/atif-import.js";
import { readImportedBehaviorEvidenceV2 } from "../src/atif-v2.js";
import { createHash } from "node:crypto";
import { main } from "../src/cli.js";
import { loadRetainedAnalysisV2 } from "../src/analysis-v2-cli.js";
import { createRetainedBehaviorEvidence } from "../src/retained-evidence.js";

test("EBO validates a conforming unknown producer without a Harbor installation", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-core-reader-"));
  try {
    const path = join(root, "trajectory.json");
    writeFileSync(path, JSON.stringify({ schema_version: "ATIF-v1.7", agent: { name: "acme-agent", version: "9.9.9" },
      steps: [{ step_id: 1, source: "agent", message: "Inspecting the retained file.", llm_call_count: 1,
        tool_calls: [{ tool_call_id: "c1", function_name: "read", arguments: { path: "input.txt" } }],
        observation: { results: [{ source_call_id: "c1", content: "retained content" }] } }] }));
    const read = await readAtifFile(path, { pythonExecutable: join(root, "no-python") });
    assert.equal(read.inspection.structural.status, "valid");
    assert.equal(read.inspection.structural.validator, "ebo");
    assert.ok(read.inspection.records.some(({ kind }) => kind === "call"));
    assert.ok(read.inspection.records.some(({ kind }) => kind === "result"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the public CLI and retained loaders accept an unknown producer without a profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-core-cli-"));
  try {
    const source = join(root, "source.json"), destination = join(root, "import");
    writeFileSync(source, JSON.stringify({ schema_version: "ATIF-v1.7", agent: { name: "acme-agent", version: "9.9.9" },
      steps: [{ step_id: 1, source: "agent", message: "Recorded message.", llm_call_count: 1, tool_calls: [] }] }));
    let output = "";
    const status = await main(["atif", "import", source, destination, "--run", "cli", "--attempt", "a"], (text) => { output += text; });
    assert.equal(status, 0, output);
    assert.ok((await createRetainedBehaviorEvidence(destination)).dataset.events.length > 0);
    assert.ok((await loadRetainedAnalysisV2(destination)).dataset.events.length > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("minimal ATIF admission derives the producer and reopens through both shared readers", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-core-admission-"));
  try {
    const sourcePath = join(root, "source.json"), destination = join(root, "import");
    writeFileSync(sourcePath, JSON.stringify({ schema_version: "ATIF-v1.7", agent: { name: "acme-agent", version: "9.9.9" },
      steps: [{ step_id: 1, source: "agent", message: "Read the source.", llm_call_count: 1,
        tool_calls: [{ tool_call_id: "c1", function_name: "read", arguments: {} }],
        observation: { results: [{ source_call_id: "c1", content: "source" }] } }] }));
    const options = { sourcePath, destination, runId: "core-admission", attemptId: "a" } as Parameters<typeof importAtifFile>[0];
    const imported = await importAtifFile(options);
    assert.equal(imported.manifest.schemaVersion, "ebo.import-manifest/v2");
    assert.equal(imported.manifest.producer.agent.name, "acme-agent");
    const manifest = JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.overlays, []);
    assert.ok((await readImportedBehaviorEvidence(destination)).dataset.events.length > 0);
    assert.equal((await readImportedBehaviorEvidenceV2(destination)).dataset.operations.length, 1);
    assert.equal((await importAtifFile(options)).reused, true);
    const admitted = JSON.parse(readFileSync(join(destination, "interpretation.json"), "utf8"));
    admitted.overlays = [{ id: "removed-overlay", digest: `sha256:${"1".repeat(64)}` }];
    const bytes = Buffer.from(`${JSON.stringify(admitted)}\n`);
    writeFileSync(join(destination, "interpretation.json"), bytes);
    manifest.overlays = admitted.overlays;
    manifest.interpretation.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest));
    const revised = await readImportedBehaviorEvidenceV2(destination);
    assert.ok("interpretationRevision" in revised);
    assert.equal((revised.interpretationRevision as { changed: boolean }).changed, true);
    assert.equal(revised.dataset.operations.length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an unknown producer projects messages, linked tool results and document counts", async () => {
  const source = { schema_version: "ATIF-v1.7", agent: { name: "acme-agent", version: "9.9.9" },
    steps: [{ step_id: 1, source: "agent", message: "Read the file.", llm_call_count: 1,
      tool_calls: [{ tool_call_id: "c1", function_name: "read", arguments: { path: "a.txt" } }],
      observation: { results: [{ source_call_id: "c1", content: "file body", extra: { is_error: true } }] } }] };
  const evidence = await projectAtifV2({ read: inspectAtifBytes(Buffer.from(JSON.stringify(source))),
    producer: { ...listAtifProducerProfiles()[0]!.producer, agent: source.agent }, runId: "core-test", attemptId: "a",
    manifestDigest: `sha256:${"0".repeat(64)}` });
  assert.ok(evidence.dataset.events.some(({ family }) => family === "message"));
  assert.equal(evidence.dataset.operations.length, 1);
  assert.equal(evidence.dataset.operations[0]!.callEventIds.length, 1);
  assert.equal(evidence.dataset.operations[0]!.resultEventIds.length, 1);
  assert.equal(evidence.dataset.operations[0]!.failure.status, "unknown");
  const count = evidence.dataset.measurements.find(({ id }) => id === "source-tool-operation-count");
  assert.deepEqual(count?.value, { status: "known", value: 1 });
  assert.equal(count?.scope.kind, "recorded-document");
  assert.ok(evidence.dataset.measurements.every(({ scope }) => scope.kind === "recorded-document"));
});

test("a future ATIF v1 minor projects known fields while a future major is diagnosed", () => {
  const source = { schema_version: "ATIF-v1.9", agent: { name: "acme-agent", version: "9.9.9" },
    future_field: { retained: true }, steps: [{ step_id: 1, source: "agent", message: "Recorded message." }] };
  const read = inspectAtifBytes(Buffer.from(JSON.stringify(source)));
  assert.equal(read.inspection.versionPolicy.status, "supported");
  assert.ok(read.inspection.limitations.includes("ATIF_MINOR_VERSION_UNVERIFIED"));
  assert.equal(read.inspection.structural.status, "valid");
  assert.deepEqual(read.document?.future_field, { retained: true });
  const major = inspectAtifBytes(Buffer.from(JSON.stringify({ ...source, schema_version: "ATIF-v2.0" })));
  assert.equal(major.inspection.versionPolicy.status, "unsupported");
  assert.ok(major.inspection.versionPolicy.diagnostics.some(({ code }) => code === "ATIF_MAJOR_VERSION_UNSUPPORTED"));
});

test("minor-version field mismatches preserve readable core content with unverified fields", async () => {
  const source = { schema_version: "ATIF-v1.2", session_id: "legacy", agent: { name: "acme-agent", version: "9.9.9" },
    steps: [{ step_id: 1, source: "agent", message: "Readable content.", llm_call_count: 1, tool_calls: [] }] };
  const read = inspectAtifBytes(Buffer.from(JSON.stringify(source)));
  const evidence = await projectAtifV2({ read, runId: "minor-field-drift", attemptId: "a", manifestDigest: `sha256:${"0".repeat(64)}` });
  assert.ok(evidence.dataset.events.some(({ family }) => family === "message"));
  assert.ok(evidence.capture.qualification === "imported" && evidence.capture.sourceLimitations?.includes("ATIF_VERSION_FIELD_UNVERIFIED"));
  assert.equal(evidence.dataset.measurements.find(({ id }) => id === "source-declared-inference-count")?.value.status, "unknown");
});
