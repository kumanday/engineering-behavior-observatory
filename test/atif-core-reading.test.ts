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

test("future fields are retained with explicit unmapped pointer coverage", async () => {
  const source = { schema_version: "ATIF-v1.9", agent: { name: "acme-agent", version: "9.9.9" }, future_field: { value: 7 },
    steps: [{ step_id: 1, source: "agent", message: "Known content.", llm_call_count: 1, tool_calls: [] }] };
  const evidence = await projectAtifV2({ read: inspectAtifBytes(Buffer.from(JSON.stringify(source))), runId: "future-fields", attemptId: "a",
    manifestDigest: `sha256:${"0".repeat(64)}` });
  const coverage = evidence.dataset.recordCoverage.find(({ reference }) => reference.recordLocator === "#/future_field");
  assert.equal(coverage?.disposition, "unmapped");
  assert.deepEqual(coverage?.reason, { status: "known", value: "ATIF_FIELD_UNRECOGNIZED" });
  assert.deepEqual(evidence.resolver.read({ artifactId: "atif-trajectory", recordLocator: "#/future_field" }), { value: 7 });
});

test("a referenced unsupported major does not erase its readable parent document", async () => {
  const source = { schema_version: "ATIF-v1.7", agent: { name: "acme-agent", version: "9.9.9" },
    steps: [{ step_id: 1, source: "agent", message: "Readable parent.", llm_call_count: 1 }],
    subagent_trajectories: [{ schema_version: "ATIF-v2.0", trajectory_id: "future-child", agent: { name: "future-agent" }, events: [] }] };
  const read = inspectAtifBytes(Buffer.from(JSON.stringify(source)));
  const evidence = await projectAtifV2({ read, runId: "parent-readback", attemptId: "a", manifestDigest: `sha256:${"0".repeat(64)}` });
  assert.ok(evidence.dataset.events.some(({ family }) => family === "message"));
  assert.equal(evidence.dataset.sources.length, 1);
  assert.ok(evidence.capture.qualification === "imported" && evidence.capture.sourceLimitations?.includes("ATIF_CHILD_FORMAT_UNSUPPORTED"));
  assert.deepEqual(evidence.resolver.read({ artifactId: "atif-trajectory", recordLocator: "#/subagent_trajectories/0/events" }), []);
});

test("unknown metric fields stay unmapped instead of becoming interpreted counters", async () => {
  const source = { schema_version: "ATIF-v1.9", agent: { name: "acme-agent", version: "9.9.9" },
    final_metrics: { total_steps: 1, future_tokens: "new representation", future_counter: 12 },
    steps: [{ step_id: 1, source: "agent", message: "Known content.", llm_call_count: 1 }] };
  const evidence = await projectAtifV2({ read: inspectAtifBytes(Buffer.from(JSON.stringify(source))), runId: "future-metrics", attemptId: "a",
    manifestDigest: `sha256:${"0".repeat(64)}` });
  assert.ok(evidence.dataset.events.some(({ family }) => family === "message"));
  assert.equal(evidence.dataset.measurements.some(({ id }) => id.includes("future_")), false);
  assert.equal(evidence.dataset.recordCoverage.find(({ reference }) => reference.recordLocator === "#/final_metrics/future_tokens")?.disposition, "unmapped");
  assert.deepEqual(evidence.dataset.measurements.find(({ id }) => id === "source-final-total_steps")?.value, { status: "known", value: 1 });
});

test("standard observations without call IDs stay observations and reused IDs stay step-local", async () => {
  const source = { schema_version: "ATIF-v1.8", agent: { name: "acme-agent", version: "9.9.9" },
    steps: [1, 2].map((step_id) => ({ step_id, source: "agent", message: "Recorded action.", llm_call_count: 1,
      tool_calls: [{ tool_call_id: "reused", function_name: "read", arguments: { step_id } }],
      observation: { results: [{ source_call_id: "reused", content: "result" }, { content: "environment notice" }] } })) };
  const evidence = await projectAtifV2({ read: inspectAtifBytes(Buffer.from(JSON.stringify(source))), runId: "observations", attemptId: "a", manifestDigest: `sha256:${"0".repeat(64)}` });
  assert.equal(evidence.dataset.operations.length, 2);
  assert.ok(evidence.dataset.operations.every(({ callEventIds, resultEventIds }) => callEventIds.length === 1 && resultEventIds.length === 1));
  assert.equal(evidence.dataset.events.filter(({ attributes }) => attributes.observationOnly === true).length, 2);
  assert.equal(new Set(evidence.dataset.operations.map(({ identity }) => identity.scope)).size, 2);
});

test("standard metrics, timestamps, references and different-version children project without producer context", async () => {
  const source = { schema_version: "ATIF-v1.8", trajectory_id: "parent", agent: { name: "acme-agent", version: "9.9.9", tool_definitions: [] },
    continued_trajectory_ref: "next.json", steps: [{ step_id: 1, source: "agent", message: [{ type: "image", source: { path: "image.png", media_type: "image/png" } }],
      timestamp: "2026-11-07T03:00:00Z", llm_call_count: 1, metrics: { prompt_tokens: 5, completion_tokens: 2 },
      observation: { results: [{ content: "delegated", subagent_trajectory_ref: [{ trajectory_id: "child" }] }] } }],
    subagent_trajectories: [{ schema_version: "ATIF-v1.7", trajectory_id: "child", agent: { name: "different-agent", version: "100.0.0" },
      steps: [{ step_id: 1, source: "agent", message: "Child record.", llm_call_count: 1 }] }] };
  const evidence = await projectAtifV2({ read: inspectAtifBytes(Buffer.from(JSON.stringify(source))), runId: "standard-fields", attemptId: "a", manifestDigest: `sha256:${"0".repeat(64)}` });
  assert.equal(evidence.dataset.sources.length, 2);
  assert.ok(evidence.dataset.events.some(({ facts }) => facts.resource?.values.prompt_tokens === 5));
  assert.ok(evidence.dataset.events.some(({ clock }) => clock.status === "known" && clock.value.kind === "producer-observation"));
  for (const kind of ["media", "embedded", "continuation"]) assert.ok(evidence.dataset.events.some(({ attributes }) => attributes.referenceKind === kind), kind);
  assert.ok(evidence.dataset.measurements.every(({ scope }) => scope.kind === "recorded-document"));
});

test("typed structural measures stay document-scoped across embedded source documents", async () => {
  const { createStructuralObservationSetV2 } = await import("../src/analysis-v2.js");
  const source = { schema_version: "ATIF-v1.8", agent: { name: "acme-agent" }, steps: [{ step_id: 1, source: "agent", message: "Parent.", llm_call_count: 1 }],
    subagent_trajectories: [{ schema_version: "ATIF-v1.7", trajectory_id: "child", agent: { name: "child" }, steps: [{ step_id: 1, source: "agent", message: "Child.", llm_call_count: 1 }] }] };
  const evidence = await projectAtifV2({ read: inspectAtifBytes(Buffer.from(JSON.stringify(source))), runId: "document-measures", attemptId: "a", manifestDigest: `sha256:${"0".repeat(64)}` });
  const observations = await createStructuralObservationSetV2(evidence.dataset, evidence.resolver);
  assert.ok(observations.observations.every(({ scope }) => scope.kind === "recorded-document"));
  assert.equal(observations.observations.filter(({ measure }) => measure === "declared-inference-count").length, 2);
});

test("legacy entry points and Atlas resolve an unknown producer through the same core", async () => {
  const { normalizePiAtif } = await import("../src/atif-pi.js");
  const { projectAdditionalAtifV2 } = await import("../src/atif-additional-v2.js");
  const { buildAtlasViewV2 } = await import("../src/atlas-v2.js");
  const source = { schema_version: "ATIF-v1.7", agent: { name: "acme-agent", version: "9.9.9" }, steps: [{ step_id: 1, source: "agent", message: "Visible record.", llm_call_count: 1,
    tool_calls: [{ tool_call_id: "c", function_name: "read", arguments: {} }], observation: { results: [{ source_call_id: "c", content: "retained" }] } }] };
  const input = { read: inspectAtifBytes(Buffer.from(JSON.stringify(source))), runId: "all-entrypoints", attemptId: "a", manifestDigest: `sha256:${"0".repeat(64)}` as const };
  const legacy = await normalizePiAtif(input), typed = await projectAdditionalAtifV2(input), view = await buildAtlasViewV2(typed);
  assert.ok(legacy.dataset.events.length > 0);
  assert.equal(typed.dataset.operations.length, 1);
  assert.ok(view.units.some(({ kind }) => kind === "tool"));
  assert.ok(view.units.some(({ kind }) => kind === "message"));
});

test("blank source identifiers retain recorded content without inventing native identities", async () => {
  const source = { schema_version: "ATIF-v1.7", agent: { name: "acme-agent", version: "9.9.9" }, steps: [{ step_id: 1, source: "agent", message: "A record with an unavailable call identity.",
    tool_calls: [{ tool_call_id: "", function_name: "read", arguments: {} }], observation: { results: [{ source_call_id: "", content: "Unlinked observation." }] } }] };
  const evidence = await projectAtifV2({ read: inspectAtifBytes(Buffer.from(JSON.stringify(source))), runId: "unidentified-call", attemptId: "a", manifestDigest: `sha256:${"0".repeat(64)}` });
  assert.ok(evidence.dataset.events.some(({ family }) => family === "message"));
  assert.equal(evidence.dataset.operations.length, 1);
  assert.equal(evidence.dataset.operations[0]!.identity.identityClass, "ebo-derived");
  assert.equal(evidence.dataset.operations[0]!.scope.status, "unknown");
  assert.equal(evidence.dataset.operations[0]!.resultEventIds.length, 0);
});

test("declared final metrics cite their recorded fields with spec units", async () => {
  const source = { schema_version: "ATIF-v1.7", agent: { name: "acme-agent" }, final_metrics: { total_cost_usd: 0, total_steps: 1 },
    steps: [{ step_id: 1, source: "user", message: "Recorded task." }] };
  const evidence = await projectAtifV2({ read: inspectAtifBytes(Buffer.from(JSON.stringify(source))), runId: "declared-metrics", attemptId: "a", manifestDigest: `sha256:${"0".repeat(64)}` });
  const measure = evidence.dataset.measurements.find(({ id }) => id === "source-final-total_cost_usd")!;
  assert.deepEqual(measure.value, { status: "known", value: 0 });
  assert.equal(measure.unit, "usd");
  assert.ok(measure.sourceEventIds.some((id) => evidence.dataset.events.find((event) => event.id === id)?.source.nativeReference.recordLocator === "#/final_metrics/total_cost_usd"));
});

test("legacy v1 admission profile data never gates current core reinterpretation", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-v1-admission-"));
  try {
    const sourcePath = join(root, "source.json"), destination = join(root, "import");
    writeFileSync(sourcePath, readFileSync(new URL("../../test/fixtures/atif/core/acme.json", import.meta.url)));
    await importAtifFile({ sourcePath, destination, runId: "old", attemptId: "a" });
    const manifest = JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8"));
    manifest.schemaVersion = "ebo.import-manifest/v1"; manifest.producerAuthority = "operator-declared";
    manifest.profile = { status: "supported", id: "retired-exact-fingerprint", digest: `sha256:${"1".repeat(64)}` };
    delete manifest.overlays; delete manifest.interpretation;
    const frozen = Buffer.from(`${JSON.stringify(manifest)}\n`);writeFileSync(join(destination, "manifest.json"), frozen);
    assert.ok((await readImportedBehaviorEvidence(destination)).dataset.events.length > 0);
    const evidence = await readImportedBehaviorEvidenceV2(destination);
    assert.equal(evidence.dataset.operations.length, 2); assert.equal(evidence.interpretationRevision?.changed, true);
    assert.deepEqual(readFileSync(join(destination, "manifest.json")), frozen);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("standard semantic projection is independent of arbitrary producer names and operator fingerprints", async () => {
  const original = JSON.parse(readFileSync(new URL("../../test/fixtures/atif/core/acme.json", import.meta.url), "utf8"));
  const results = [];
  for (const name of ["acme-agent", "pi", "codex", "another-unseen-agent"]) {
    const source = structuredClone(original);source.agent.name = name;
    const evidence = await projectAtifV2({ read: inspectAtifBytes(Buffer.from(JSON.stringify(source))), runId: "independence", attemptId: "a", manifestDigest: `sha256:${"0".repeat(64)}` });
    results.push({ events: evidence.dataset.events.filter(({ attributes }) => !attributes.sourceMetadata), operations: evidence.dataset.operations, measurements: evidence.dataset.measurements });
  }
  for (const result of results.slice(1)) assert.deepEqual(result, results[0]);
});

test("duplicate IDs within one step retain call records without inventing logical association", async () => {
  const source = { schema_version: "ATIF-v1.7", agent: { name: "acme-agent", version: "9.9.9" }, steps: [{ step_id: 1, source: "agent", message: "Inspect files.", llm_call_count: 1,
    tool_calls: [{ tool_call_id: "duplicate", function_name: "read", arguments: { path: "a" } }, { tool_call_id: "duplicate", function_name: "read", arguments: { path: "b" } }],
    observation: { results: [{ source_call_id: "duplicate", content: "a" }, { source_call_id: "duplicate", content: "b" }] } }] };
  const evidence = await projectAtifV2({ read: inspectAtifBytes(Buffer.from(JSON.stringify(source))), runId: "ambiguous", attemptId: "a", manifestDigest: `sha256:${"0".repeat(64)}` });
  assert.equal(evidence.dataset.events.filter(({ family, phase }) => family === "tool" && phase === "before").length, 2);
  assert.ok(evidence.dataset.operations.every(({ scope }) => scope.status === "unknown"));
  assert.equal(evidence.dataset.operations.some(({ callEventIds, resultEventIds }) => callEventIds.length > 0 && resultEventIds.length > 0), false);
  const set = await (await import("../src/analysis-v2.js")).createStructuralObservationSetV2(evidence.dataset, evidence.resolver);
  assert.equal(set.observations.find(({ measure }) => measure === "tool-operation-count")!.value.status, "unknown");
  assert.deepEqual(set.observations.find(({ measure }) => measure === "source-tool-operation-count")!.value, { status: "known", value: 2 });
});

test("the admission interpretation binds changes to the compatibility projector independently of core", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-bridge-identity-"));
  try {
    const sourcePath = join(root, "source.json"), destination = join(root, "import");
    writeFileSync(sourcePath, readFileSync(new URL("../../test/fixtures/atif/core/acme.json", import.meta.url)));
    await importAtifFile({ sourcePath, destination, runId: "bridge", attemptId: "a" });
    const manifest = JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8")), admitted = JSON.parse(readFileSync(join(destination, "interpretation.json"), "utf8"));
    assert.equal(admitted.compatibilityReader.id, "ebo.atif-compatibility");
    admitted.compatibilityReader.digest = `sha256:${"2".repeat(64)}`;
    const bytes = Buffer.from(`${JSON.stringify(admitted)}\n`);writeFileSync(join(destination, "interpretation.json"), bytes);
    manifest.interpretation.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest));
    const revised = await readImportedBehaviorEvidenceV2(destination);
    assert.equal(revised.interpretationRevision!.changed, true);
    const current = revised.interpretationRevision!.current as typeof admitted;
    assert.deepEqual(current.core, admitted.core);assert.notEqual(current.compatibilityReader.digest, admitted.compatibilityReader.digest);
    assert.ok((await readImportedBehaviorEvidence(destination)).dataset.events.length > 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
