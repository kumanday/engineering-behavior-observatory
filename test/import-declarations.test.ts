import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { standInEmbed } from "./atlas-fixture.js";
import { main } from "../src/cli.js";
import { readCorpusIndex } from "../src/corpus.js";

test("an ATIF import records a declared task and model; the corpus, aggregation and Atlas use them and keep the route apart", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-import-declarations-"));
  try {
    const base = JSON.parse(readFileSync(new URL("../../test/fixtures/atif/core/acme.json", import.meta.url), "utf8")) as { agent: Record<string, unknown> };
    mkdirSync(join(root, "corpus"));
    const run = async (...args: string[]) => { let output = ""; const status = await main(args, (text) => { output += text; }); assert.equal(status, 0, output); return output; };
    // One model, reached through two routes that decorate its name differently.
    for (const [index, route] of ["hlb/example-org/Example-Model:example-org", "openai/example-org/Example-Model:example-org"].entries()) {
      const source = join(root, `source-${String(index)}.json`);
      writeFileSync(source, JSON.stringify({ ...base, agent: { ...base.agent, model_name: route } }));
      await run("atif", "import", source, join(root, "corpus", `attempt-${String(index)}`), "--run", `run-${String(index)}`, "--attempt", `attempt-${String(index)}`,
        "--task", "example-task", "--model", "Example-Model");
    }
    const manifest = JSON.parse(readFileSync(join(root, "corpus", "attempt-0", "manifest.json"), "utf8")) as { schemaVersion: string; task: unknown; model: unknown };
    assert.equal(manifest.schemaVersion, "ebo.import-manifest/v3");
    assert.deepEqual(manifest.task, { id: "example-task", authority: "operator-declared" });
    assert.deepEqual(manifest.model, { id: "Example-Model", authority: "operator-declared" });

    await run("corpus", "build", join(root, "corpus"), join(root, "index.jsonl"));
    const entries = readCorpusIndex(join(root, "index.jsonl"));
    assert.deepEqual(entries.map(({ taskId, modelId, modelRoute }) => [taskId, modelId, modelRoute]), [
      ["example-task", "Example-Model", "hlb/example-org/Example-Model:example-org"],
      ["example-task", "Example-Model", "openai/example-org/Example-Model:example-org"],
    ]);
    assert.match(await run("corpus", "query", join(root, "index.jsonl"), "--route", "openai/example-org/Example-Model:example-org"), /attempt-1/u);

    writeFileSync(join(root, "aggregation.json"), JSON.stringify({ schemaVersion: "ebo.aggregation-request/v2",
      sources: { corpusRoot: "corpus", corpusIndex: "index.jsonl", observationSets: [], assertions: [], calibrations: [] },
      groupBy: ["task", "model"], evidenceOrigins: "imported", selectedAttemptPolicy: "all-attempts", recurrence: { minimumOccurrences: 2 }, comparisons: [] }));
    await run("aggregate", "build", join(root, "aggregation.json"), join(root, "derived", "report.json"));
    const report = JSON.parse(readFileSync(join(root, "derived", "report.json"), "utf8")) as { groups: Array<{ dimensions: Record<string, string> }> };
    assert.deepEqual(report.groups.map(({ dimensions }) => [dimensions.task, dimensions.model]), [["example-task", "Example-Model"]], "both attempts form one task and model group");

    writeFileSync(join(root, "atlas.json"), JSON.stringify({ schemaVersion: "ebo.atlas-request/v1", title: "Declarations", aggregationRequest: "aggregation.json" }));
    const { loadAtlas, queryAtlas } = await import("../src/atlas.js");
    const source = await loadAtlas(join(root, "atlas.json"));
    const view = await queryAtlas(source);
    assert.deepEqual(view.filterOptions.model, ["Example-Model"]);
    assert.deepEqual(view.filterOptions.route, ["hlb/example-org/Example-Model:example-org", "openai/example-org/Example-Model:example-org"]);
    assert.equal((await queryAtlas(source, { route: "hlb/example-org/Example-Model:example-org" })).cases.length, 1);

    writeFileSync(join(root, "bundle.json"), JSON.stringify({ schemaVersion: "ebo.atlas-bundle-request/v2", id: "declarations", title: "Declarations", cohorts: [{ id: "all", atlasRequest: "atlas.json" }] }));
    const { buildAtlasBundle } = await import("../src/atlas-bundle.js");
    await buildAtlasBundle(join(root, "bundle.json"), join(root, "bundle"), { embed: standInEmbed() });
    const lanes = JSON.parse(readFileSync(join(root, "bundle", "lanes.json"), "utf8")) as { attempts: Array<{ condition: string; task_id: string | null }> };
    assert.deepEqual([...new Set(lanes.attempts.map(({ condition }) => condition))], ["Imported · Example-Model · acme-agent 9.9.9"], "one arm for one model, whatever the route");
    assert.ok(lanes.attempts.every(({ task_id }) => task_id === "example-task"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an ATIF import's step timestamps and metrics give Atlas lanes and cloud rows their time and declared usage", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-import-timing-"));
  try {
    const base = JSON.parse(readFileSync(new URL("../../test/fixtures/atif/core/acme.json", import.meta.url), "utf8")) as { steps: Array<Record<string, unknown>> };
    const at = (second: number) => `2026-11-01T10:00:${String(second).padStart(2, "0")}Z`;
    const steps = base.steps.map((step, index) => ({ ...step, timestamp: at(index * 10),
      ...(step.source === "agent" ? { metrics: { prompt_tokens: 1000 * index, completion_tokens: 10 * index, cached_tokens: 500, cost_usd: 0.01 } } : {}) }));
    writeFileSync(join(root, "source.json"), JSON.stringify({ ...base, steps, final_metrics: { total_prompt_tokens: 9000, total_completion_tokens: 90, total_cost_usd: 0.03 } }));
    mkdirSync(join(root, "corpus"));
    const run = async (...args: string[]) => { let output = ""; const status = await main(args, (text) => { output += text; }); assert.equal(status, 0, output); return output; };
    await run("atif", "import", join(root, "source.json"), join(root, "corpus", "attempt-0"), "--run", "run-0", "--attempt", "attempt-0", "--task", "example-task", "--model", "Example-Model");
    await run("corpus", "build", join(root, "corpus"), join(root, "index.jsonl"));
    writeFileSync(join(root, "aggregation.json"), JSON.stringify({ schemaVersion: "ebo.aggregation-request/v2",
      sources: { corpusRoot: "corpus", corpusIndex: "index.jsonl", observationSets: [], assertions: [], calibrations: [] },
      groupBy: ["task", "model"], evidenceOrigins: "imported", selectedAttemptPolicy: "all-attempts", recurrence: { minimumOccurrences: 2 }, comparisons: [] }));
    writeFileSync(join(root, "atlas.json"), JSON.stringify({ schemaVersion: "ebo.atlas-request/v1", title: "Timing", aggregationRequest: "aggregation.json" }));
    writeFileSync(join(root, "bundle.json"), JSON.stringify({ schemaVersion: "ebo.atlas-bundle-request/v2", id: "timing", title: "Timing", cohorts: [{ id: "all", atlasRequest: "atlas.json" }] }));
    const { buildAtlasBundle } = await import("../src/atlas-bundle.js");
    await buildAtlasBundle(join(root, "bundle.json"), join(root, "bundle"), { embed: standInEmbed() });
    const lanes = JSON.parse(readFileSync(join(root, "bundle", "lanes.json"), "utf8")) as { attempts: Array<Record<string, unknown>>; usage: Record<string, Array<[number, number]>>; context: Record<string, Array<[number, number]>> };
    const [lane] = lanes.attempts;
    assert.equal(lane!.t_start_ms, Date.parse(at(10)), "the lane starts at the first unit it shows (the user message)");
    assert.equal(lane!.t_end_ms, Date.parse(at(40)));
    assert.equal(lane!.usage_semantics, "per-turn");
    assert.equal(lane!.tokens_total, 9090, "the declared final totals win over the step sum");
    assert.equal(lane!.cost_usd, 0.03);
    assert.equal(lane!.context_max, 4000, "a step's prompt tokens are its context; cached tokens are part of them");
    assert.equal(lane!.errors, null, "ATIF core records no tool failures, so imported errors stay unavailable");
    assert.deepEqual(lanes.usage["attempt-0"]!.map(([t]) => t), [at(20), at(30), at(40)].map(Date.parse));
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const db = await DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false", autoload_known_extensions: "false" });
    const connection = await db.connect();
    try {
      const tools = (await connection.runAndReadAll(`SELECT t_start, duration_seconds FROM '${join(root, "bundle", "tables", "units.parquet")}' WHERE unit_kind = 'tool' ORDER BY seq`)).getRowObjectsJson();
      assert.deepEqual(tools.map(({ t_start }) => t_start), [at(20), at(30)], "a call takes its step's time");
      assert.ok(tools.every(({ duration_seconds }) => duration_seconds === null), "a folded result has no arrival time, so no duration");
    } finally { connection.closeSync(); db.closeSync(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a placeholder message on a tool-calling step is not a message unit, and a trial-named attempt keeps its whole id", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-import-placeholder-"));
  try {
    const base = JSON.parse(readFileSync(new URL("../../test/fixtures/atif/core/acme.json", import.meta.url), "utf8")) as { steps: Array<Record<string, unknown>> };
    const steps = base.steps.map((step) => (Array.isArray(step.tool_calls) ? { ...step, message: "[tool call]" } : step));
    writeFileSync(join(root, "source.json"), JSON.stringify({ ...base, steps }));
    mkdirSync(join(root, "corpus"));
    const attempt = "example-task__Abc1234";
    const run = async (...args: string[]) => { let output = ""; const status = await main(args, (text) => { output += text; }); assert.equal(status, 0, output); return output; };
    await run("atif", "import", join(root, "source.json"), join(root, "corpus", attempt), "--run", "run-0", "--attempt", attempt, "--task", "example-task", "--model", "Example-Model");
    await run("corpus", "build", join(root, "corpus"), join(root, "index.jsonl"));
    writeFileSync(join(root, "aggregation.json"), JSON.stringify({ schemaVersion: "ebo.aggregation-request/v2",
      sources: { corpusRoot: "corpus", corpusIndex: "index.jsonl", observationSets: [], assertions: [], calibrations: [] },
      groupBy: ["task", "model"], evidenceOrigins: "imported", selectedAttemptPolicy: "all-attempts", recurrence: { minimumOccurrences: 2 }, comparisons: [] }));
    writeFileSync(join(root, "atlas.json"), JSON.stringify({ schemaVersion: "ebo.atlas-request/v1", title: "Placeholder", aggregationRequest: "aggregation.json" }));
    writeFileSync(join(root, "bundle.json"), JSON.stringify({ schemaVersion: "ebo.atlas-bundle-request/v2", id: "placeholder", title: "Placeholder", cohorts: [{ id: "all", atlasRequest: "atlas.json" }] }));
    const { buildAtlasBundle } = await import("../src/atlas-bundle.js");
    await buildAtlasBundle(join(root, "bundle.json"), join(root, "bundle"), { embed: standInEmbed() });
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const db = await DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false", autoload_known_extensions: "false" });
    const connection = await db.connect();
    try {
      const units = (await connection.runAndReadAll(`SELECT unit_kind, embed_text FROM '${join(root, "bundle", "tables", "units.parquet")}' ORDER BY seq`)).getRowObjectsJson();
      assert.ok(!units.some(({ embed_text }) => String(embed_text).includes("[tool call]")), "no unit is the placeholder");
      assert.equal(units.filter(({ unit_kind }) => unit_kind === "tool").length, 2, "the placeholder turns' calls stay tool units");
      assert.ok(units.some(({ unit_kind, embed_text }) => unit_kind === "message" && embed_text === "Fixture inspection complete."), "a turn with text stays a message");
    } finally { connection.closeSync(); db.closeSync(); }
    const audit = JSON.parse(readFileSync(join(root, "bundle", "audit.json"), "utf8")) as { attempts: Record<string, { short: string }> };
    assert.equal(audit.attempts[attempt]!.short, attempt, "a trial name is shown whole, not cut to its task prefix");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an imported group's structural metrics say why they are unavailable", async () => {
  const { emptyStructuralReason } = await import("../src/aggregation.js");
  const imported = { status: "unavailable", reason: "CAPTURE_COMPLETENESS_UNPROVEN" };
  assert.match(emptyStructuralReason([imported, imported]), /does not prove the attempt was captured whole.*CAPTURE_COMPLETENESS_UNPROVEN/u);
  assert.equal(emptyStructuralReason([undefined]), "No attempt in the group has an observation set.");
  assert.equal(emptyStructuralReason([{ status: "unavailable", reason: "SOURCE_UNREPORTED" }]), "Every attempt's observation is unavailable: SOURCE_UNREPORTED");
  assert.equal(emptyStructuralReason([imported, undefined]), "The eligible denominator is empty.");
});

test("attempt ids read whole unless they are UUID or hex ids", async () => {
  const { shortAttemptId } = await import("../src/atlas-bundle.js");
  assert.equal(shortAttemptId("gcode-to-text__tC7K2Rc"), "gcode-to-text__tC7K2Rc");
  assert.equal(shortAttemptId("3f2a9c1e-7b4d-4e2a-9c1e-7b4d4e2a9c1e"), "3f2a9c1e");
  assert.equal(shortAttemptId("3f2a9c1e7b4d4e2a9c1e"), "3f2a9c1e");
});


test("imports declare a harness version and a third-party outcome; arms separate versions and the outcome keeps its provenance", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-import-outcomes-"));
  try {
    const base = JSON.parse(readFileSync(new URL("../../test/fixtures/atif/core/acme.json", import.meta.url), "utf8")) as { agent: Record<string, unknown> };
    mkdirSync(join(root, "corpus"));
    const run = async (...args: string[]) => { let output = ""; const status = await main(args, (text) => { output += text; }); return { status, output }; };
    writeFileSync(join(root, "source.json"), JSON.stringify(base));
    // Two releases of one harness write the same agent name; the batch declares each trial's version and verdict.
    const trials = [["1.19.0", "pass"], ["2.2.6", "fail"], ["2.2.6", "infra-excluded"]] as const;
    const lines = trials.map(([version, outcome], index) => JSON.stringify({ source: "source.json", destination: `corpus/trial-${String(index)}`, run: `run-${String(index)}`,
      attempt: `example-task__trial${String(index)}`, task: "example-task", model: "Example-Model", harnessVersion: version,
      outcome: { outcome, source: "Example Board", release: "v0.1.9", record: `runs/example/example-task__trial${String(index)}` } }));
    // A bad line is reported and the batch goes on.
    writeFileSync(join(root, "batch.jsonl"), `${lines[0]}\n${lines[1]}\n{"source":"missing.json","destination":"corpus/bad","run":"r","attempt":"a"}\n\n${lines[2]}\n`);
    const first = await run("atif", "import-batch", join(root, "batch.jsonl"), "--shard", "1/2");
    const second = await run("atif", "import-batch", join(root, "batch.jsonl"), "--shard", "2/2");
    const summary = (output: string) => JSON.parse(output.trim().split("\n").at(-1)!) as { lines: number; imported: number; reused: number; failed: number };
    // Shard 1/2 takes lines 1, 3 and 5 (line 3 fails); shard 2/2 takes lines 2 and 4 (4 is blank).
    assert.deepEqual([first.status, summary(first.output)].map((x) => typeof x === "number" ? x : [x.lines, x.imported, x.failed]), [1, [3, 2, 1]]);
    assert.match(first.output, /"line":3,.*"status":"failed"/u);
    assert.deepEqual([second.status, summary(second.output).imported], [0, 1]);
    // Rerunning reuses every admission.
    assert.equal(summary((await run("atif", "import-batch", join(root, "batch.jsonl"))).output).reused, 3);
    const manifest = JSON.parse(readFileSync(join(root, "corpus", "trial-1", "manifest.json"), "utf8")) as { harnessVersion: unknown; sourceOutcome: unknown };
    assert.deepEqual(manifest.harnessVersion, { id: "2.2.6", authority: "operator-declared" });
    assert.deepEqual(manifest.sourceOutcome, { outcome: "fail", source: "Example Board", release: "v0.1.9", record: "runs/example/example-task__trial1", authority: "third-party" });
    // The single-import flags record the same declaration, and an outcome needs its source.
    assert.equal((await run("atif", "import", join(root, "source.json"), join(root, "single"), "--run", "r", "--attempt", "a", "--outcome", "pass")).status, 1);
    assert.equal((await run("atif", "import", join(root, "source.json"), join(root, "single"), "--run", "r", "--attempt", "a", "--harness-version", "1.19.0",
      "--outcome", "pass", "--outcome-source", "Example Board")).status, 0);

    assert.equal((await run("corpus", "build", join(root, "corpus"), join(root, "index.jsonl"))).status, 0);
    const entries = readCorpusIndex(join(root, "index.jsonl"));
    assert.deepEqual(entries.map(({ harnessVersion, sourceOutcome, sourceOutcomeRelease }) => [harnessVersion, sourceOutcome, sourceOutcomeRelease]),
      [["1.19.0", "pass", "v0.1.9"], ["2.2.6", "fail", "v0.1.9"], ["2.2.6", "infra-excluded", "v0.1.9"]]);

    writeFileSync(join(root, "aggregation.json"), JSON.stringify({ schemaVersion: "ebo.aggregation-request/v2",
      sources: { corpusRoot: "corpus", corpusIndex: "index.jsonl", observationSets: [], assertions: [], calibrations: [] },
      groupBy: ["harness-version", "source-outcome"], evidenceOrigins: "imported", selectedAttemptPolicy: "all-attempts", recurrence: { minimumOccurrences: 2 }, comparisons: [] }));
    assert.equal((await run("aggregate", "build", join(root, "aggregation.json"), join(root, "derived", "report.json"))).status, 0);
    const report = JSON.parse(readFileSync(join(root, "derived", "report.json"), "utf8")) as { groups: Array<{ dimensions: Record<string, string> }> };
    assert.deepEqual(report.groups.map(({ dimensions }) => [dimensions["harness-version"], dimensions["source-outcome"]]).sort(),
      [["1.19.0", "pass"], ["2.2.6", "fail"], ["2.2.6", "infra-excluded"]]);

    writeFileSync(join(root, "atlas.json"), JSON.stringify({ schemaVersion: "ebo.atlas-request/v1", title: "Outcomes", aggregationRequest: "aggregation.json" }));
    writeFileSync(join(root, "bundle.json"), JSON.stringify({ schemaVersion: "ebo.atlas-bundle-request/v2", id: "outcomes", title: "Outcomes", cohorts: [{ id: "all", atlasRequest: "atlas.json" }] }));
    const { buildAtlasBundle } = await import("../src/atlas-bundle.js");
    await buildAtlasBundle(join(root, "bundle.json"), join(root, "bundle"), { embed: standInEmbed() });
    const lanes = JSON.parse(readFileSync(join(root, "bundle", "lanes.json"), "utf8")) as { attempts: Array<Record<string, string | null>> };
    assert.deepEqual([...new Set(lanes.attempts.map(({ condition }) => condition))].sort(), ["Imported · Example-Model · acme-agent 1.19.0", "Imported · Example-Model · acme-agent 2.2.6"]);
    const lane = lanes.attempts.find(({ attempt_id }) => attempt_id === "example-task__trial1")!;
    assert.deepEqual([lane.source_outcome, lane.source_outcome_source, lane.source_outcome_release, lane.source_outcome_record, lane.harness_version, lane.terminal_state],
      ["fail", "Example Board", "v0.1.9", "runs/example/example-task__trial1", "2.2.6", null], "the verdict stays apart from EBO's run status");
    const { DuckDBInstance } = await import("@duckdb/node-api");
    const db = await DuckDBInstance.create(":memory:"), c = await db.connect();
    try {
      const rows = (await c.runAndReadAll(`SELECT attempt_id, source_outcome, source_outcome_source, source_outcome_release FROM '${join(root, "bundle", "tables", "attempts.parquet")}' ORDER BY attempt_id`)).getRowObjectsJson();
      assert.deepEqual(rows.map((r) => r.source_outcome), ["pass", "fail", "infra-excluded"]);
      assert.ok(rows.every((r) => r.source_outcome_source === "Example Board" && r.source_outcome_release === "v0.1.9"));
    } finally { c.closeSync(); db.closeSync(); }

    // Every cloud row carries its attempt's verdict, in the full cloud and in the compact one, so the cloud colours and filters by it.
    const { tableFromIPC } = await import("apache-arrow");
    const verdict = new Map(lanes.attempts.map(({ attempt_id, source_outcome }) => [attempt_id, source_outcome]));
    const outcomesOf = (dir: string) => {
      const units = tableFromIPC(readFileSync(join(root, dir, "units.arrow")));
      assert.ok(units.numRows > 0);
      return Array.from({ length: units.numRows }, (_, row) => [String(units.getChild("attempt_id")!.get(row)), units.getChild("source_outcome")!.get(row) as string | null] as const);
    };
    const full = outcomesOf("bundle");
    for (const [attempt, outcome] of full) assert.equal(outcome, verdict.get(attempt), attempt);
    assert.deepEqual([...new Set(full.map(([, outcome]) => outcome))].sort(), ["fail", "infra-excluded", "pass"]);
    writeFileSync(join(root, "bundle-compact.json"), JSON.stringify({ schemaVersion: "ebo.atlas-bundle-request/v2", id: "outcomes-compact", title: "Outcomes",
      cohorts: [{ id: "all", atlasRequest: "atlas.json" }], embeddings: { provider: "hashed-tfidf", layout: "build" } }));
    const layout = async (_path: string, _dimensions: number, given: readonly string[]) => {
      const n = given.length, k = 4;
      return { xy: Float32Array.from({ length: 2 * n }, (_, i) => i % 7), neighborIds: new Int32Array(n * k).fill(-1), neighborDistances: new Float32Array(n * k), k,
        run: { backend: "stand-in", backendVersion: "0", device: "cpu", units: n, pca: 128, neighbors: k, minDist: 0.1, seed: 42, metric: "cosine", familySeconds: {}, packages: {} } };
    };
    process.env.EBO_EMBEDDINGS_PYTHON = "/unused/python";
    try {
      const manifest = await buildAtlasBundle(join(root, "bundle-compact.json"), join(root, "compact"), { layout, compactCloud: true });
      assert.equal(manifest.cloud.layout?.compact, true);
    } finally { delete process.env.EBO_EMBEDDINGS_PYTHON; }
    assert.deepEqual(outcomesOf("compact"), full);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a batch creates its destinations' parent directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-import-batch-parents-"));
  try {
    writeFileSync(join(root, "source.json"), readFileSync(new URL("../../test/fixtures/atif/core/acme.json", import.meta.url)));
    writeFileSync(join(root, "batch.jsonl"), `${JSON.stringify({ source: "source.json", destination: "corpus-a/nested/trial-0", run: "r", attempt: "a" })}\n`);
    let output = "";
    assert.equal(await main(["atif", "import-batch", join(root, "batch.jsonl")], (text) => { output += text; }), 0, output);
    assert.ok(readFileSync(join(root, "corpus-a", "nested", "trial-0", "manifest.json")).length > 0);
    let usage = "";
    assert.equal(await main(["atif", "import-batch", join(root, "batch.jsonl"), "--shard", "0/2"], (text) => { usage += text; }), 1);
    assert.match(usage, /numbered from 1/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an over-long tool name is shortened with a marker instead of refusing the import", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-import-long-name-"));
  try {
    const base = JSON.parse(readFileSync(new URL("../../test/fixtures/atif/core/acme.json", import.meta.url), "utf8")) as { steps: Array<{ tool_calls?: Array<{ function_name: string }> }> };
    const longName = `bash -lc ${"x".repeat(2000)}`;
    base.steps[2]!.tool_calls![0]!.function_name = longName;
    writeFileSync(join(root, "source.json"), JSON.stringify(base));
    let output = "";
    assert.equal(await main(["atif", "import", join(root, "source.json"), join(root, "trial"), "--run", "r", "--attempt", "a"], (text) => { output += text; }), 0, output);
    const { readImportedBehaviorEvidence } = await import("../src/atif-import.js");
    const evidence = await readImportedBehaviorEvidence(join(root, "trial"));
    const shortened = evidence.dataset.events.filter((event) => Array.isArray(event.attributes.shortenedAttributes));
    assert.ok(shortened.length > 0);
    for (const event of shortened) {
      const name = String(event.attributes.toolName);
      assert.ok(name.length <= 512 && name.startsWith("bash -lc xxx") && /more characters in the native record\]$/u.test(name), name.slice(-80));
      assert.deepEqual(event.attributes.shortenedAttributes, ["toolName"]);
    }
    // The retained document keeps the whole name.
    assert.equal((JSON.parse(readFileSync(join(root, "trial", "trajectory.json"), "utf8")) as typeof base).steps[2]!.tool_calls![0]!.function_name, longName);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
