import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { tableFromIPC } from "apache-arrow";

import { ATLAS_TABLES, buildAtlasBundle, flattenText, verifyAtlasBundle, type AtlasBundleRequest } from "../src/atlas-bundle.js";
import { loadAtlas } from "../src/atlas.js";
import { laneData } from "../src/atlas-lanes.js";
import { deriveUnits } from "../src/atlas-units.js";
import { NativeLines, nativeRecordDigest } from "../src/atlas-evidence.js";
import { validateClaims } from "../src/atlas-claims.js";
import { createHash } from "node:crypto";
import { main } from "../src/cli.js";
import { createAtlasFixture, standInEmbed } from "./atlas-fixture.js";

test("flattened event text keeps string leaves, labels short ones and skips identifiers", () => {
  assert.deepEqual(flattenText({ id: "x1", role: "user", content: [{ type: "text", text: "line one\nline two" }], input: '{"command":"ls"}', isError: false, exitCode: 0 }),
    ["role: user", "type: text", "line one\nline two", "command: ls", "isError: false", "exitCode: 0"]);
});

test("an Atlas bundle holds Atlas tables v1 built from the validated cohort, and verification detects changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-atlas-bundle-"));
  try {
    const atlasRequest = await createAtlasFixture(join(root, "study"));
    const source = await loadAtlas(atlasRequest);
    const requestPath = join(root, "bundle-request.json");
    const request: AtlasBundleRequest = { schemaVersion: "ebo.atlas-bundle-request/v2", id: "synthetic-study", title: "Synthetic study",
      cohorts: [{ id: "all", atlasRequest: "study/atlas.json" }], condition: { pattern: "^synthetic-(?<condition>attempt)-\\d+$" } };
    writeFileSync(requestPath, JSON.stringify(request));
    const out = join(root, "bundle");
    // Deterministic stand-in embeddings: one dimension per character code bucket, no provider call.
    const embed = standInEmbed((text, dimensions) => {
      const out = new Float32Array(dimensions);
      for (const ch of text) out[ch.charCodeAt(0) % dimensions]! += 1;
      return out;
    });
    const evidenceReuse = { hits: 0, misses: 0 };
    const manifest = await buildAtlasBundle(requestPath, out, { now: () => new Date("2026-10-07T00:00:00.000Z"), embed, evidenceReuse });
    // The build runs inside a reuse scope. This fixture has one assertion per attempt, so every lookup changes attempt.
    // Each attempt is built once while a cohort is validated and reused for its cases; the bundle pass builds it again.
    assert.ok(evidenceReuse.misses > 0 && evidenceReuse.hits > 0, JSON.stringify(evidenceReuse));

    assert.deepEqual(Object.keys(manifest.tables).sort(), Object.keys(ATLAS_TABLES).sort());
    const runs = source.input.corpusEntries.filter(({ manifestKind }) => manifestKind === "run");
    assert.equal(manifest.tables.attempts!.rows, runs.length);
    assert.equal(manifest.tables.assessments!.rows, source.input.assertions.length);
    assert.equal(manifest.cohorts[0]!.report, "reports/all.json");

    const db = await DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false", autoload_known_extensions: "false" });
    const c = await db.connect();
    const rows = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjectsJson();
    const table = (name: string) => `'${join(out, "tables", `${name}.parquet`)}'`;
    try {
      const columns = await rows(`DESCRIBE SELECT * FROM ${table("events")}`);
      assert.deepEqual(columns.map(({ column_name }) => column_name), ATLAS_TABLES.events!.map(([name]) => name), "column order is part of the contract");
      const events = source.input.assertions.length ? await rows(`SELECT count(*) AS n FROM ${table("events")}`) : [];
      assert.ok(Number(events[0]!.n) > 0);
      assert.deepEqual(await rows(`SELECT DISTINCT condition FROM ${table("attempts")}`), [{ condition: "attempt" }], "arms come from the condition pattern");
      const unresolved = await rows(`SELECT count(*) AS n FROM ${table("citations")} WHERE NOT resolved`);
      assert.equal(Number(unresolved[0]!.n), 0, "every citation resolves to a bundled event");
      const orphans = await rows(`SELECT count(*) AS n FROM ${table("observation_sources")} s ANTI JOIN ${table("events")} e USING (event_key)`);
      assert.equal(Number(orphans[0]!.n), 0);
      const local = await rows(`SELECT bundle_root FROM ${table("attempts")} LIMIT 1`);
      assert.match(String(local[0]!.bundle_root), /^study\//u, "paths are relative to the request, not local absolute paths");
    } finally {
      c.closeSync();
      db.closeSync();
    }

    // Viewer documents: the cloud in Arrow IPC with one embedding per row, swimlanes, audits, native records, assessments.
    const units = tableFromIPC(readFileSync(join(out, "units.arrow")));
    assert.equal(units.numRows, manifest.cloud.units);
    assert.equal(readFileSync(join(out, "embeddings.f32")).byteLength, manifest.cloud.units * manifest.cloud.embeddings.dimensions * 4);
    const lanes = JSON.parse(readFileSync(join(out, "lanes.json"), "utf8")) as { attempts: unknown[] };
    assert.equal(lanes.attempts.length, runs.length);
    const assessments = JSON.parse(readFileSync(join(out, "assessments.json"), "utf8")) as { assessments: Array<{ citations: Array<{ native: { resolved: boolean } }> }> };
    assert.equal(assessments.assessments.length, source.input.assertions.length);
    assert.ok(assessments.assessments.every(({ citations }) => citations.every(({ native }) => native.resolved)), "every citation resolves to a native line");
    // The fixture judges VF-03 (a dimension card) on five attempts and abstains on EN-04 for one.
    const cards = JSON.parse(readFileSync(join(out, "assessments.json"), "utf8")) as { outcomes: string[]; ontology: string; cards: Array<{ id: string; family: string; title: string }>; families: Array<{ id: string; name: string }>;
      assessments: Array<{ card: string; family: string; title: string; outcome: string; value: string | null; confidence: number | null }>;
      certified: Record<string, { cells: Array<{ card: string; family: string; counts: Record<string, number>; values?: Record<string, number>; denominator: number }> }> };
    assert.deepEqual(cards.outcomes, ["present", "absent", "unknown"]);
    assert.equal(cards.ontology, "2.0.0");
    assert.deepEqual(cards.cards.map(({ id, family }) => [id, family]), [["EN-04", "EN"], ["VF-03", "VF"]], "judged cards are listed in ontology order");
    assert.deepEqual(cards.families.map(({ id }) => id), ["EN", "VF"]);
    assert.ok(cards.cards.every((card) => { const { directions } = card as { directions?: string[] }; return Array.isArray(directions) && directions.length > 0
      && directions.every((d) => ["favourable", "unfavourable", "neutral"].includes(d)); }), "each card lists the directions a present result can have");
    assert.deepEqual(cards.assessments.map(({ card, outcome, value }) => [card, outcome, value]).sort(), [
      ["EN-04", "unknown", null], ["VF-03", "absent", null], ["VF-03", "present", "check after the last edit"], ["VF-03", "present", "check after the last edit"],
      ["VF-03", "present", "last edit after the last check"], ["VF-03", "present", "no check recorded"]]);
    assert.ok(cards.assessments.every(({ outcome, confidence }) => (outcome === "unknown") === (confidence === null)));
    const cells = Object.values(cards.certified).flatMap(({ cells }) => cells);
    assert.ok(cells.length > 0 && cells.every(({ card, counts }) => /^[A-Z]{2}-\d{2}$/u.test(card) && Object.keys(counts).join() === "present,absent,unknown"));
    assert.ok(cells.filter(({ card }) => card === "VF-03").every(({ values, counts }) => values !== undefined && Object.values(values).reduce((sum, count) => sum + count, 0) === counts.present));
    assert.ok(cells.filter(({ card }) => card === "EN-04").every(({ values }) => values === undefined));
    assert.deepEqual(verifyAtlasBundle(out), { ok: true, changed: [], missing: [], unlisted: [] });
    appendFileSync(join(out, "reports", "all.json"), " ");
    writeFileSync(join(out, "extra.txt"), "not listed");
    const tampered = verifyAtlasBundle(out);
    assert.deepEqual([tampered.ok, tampered.changed, tampered.unlisted], [false, ["reports/all.json"], ["extra.txt"]]);
    assert.equal(await main(["atlas", "bundle", "verify", out], () => undefined), 1);

    await assert.rejects(buildAtlasBundle(requestPath, out, { embed }), /not empty/u, "a bundle is never overwritten");
    // A failed build (here the embedding provider) leaves nothing at the destination and no partial directory.
    const failed = join(root, "bundle-failed");
    await assert.rejects(buildAtlasBundle(requestPath, failed, { embed: async () => { throw new Error("provider unavailable"); } }), /provider unavailable/u);
    assert.equal(existsSync(failed), false);
    assert.deepEqual(readdirSync(root).filter((f) => f.includes(".partial-")), []);
    // EmbeddingGemma 2 is the default and needs its runtime; the build says so before reading any attempt.
    await assert.rejects(buildAtlasBundle(requestPath, join(root, "bundle-no-runtime"), { embedding: {} }), /EBO_EMBEDDINGS_PYTHON/u);
    // Hashed TF-IDF is the explicit offline option: no runtime, deterministic.
    writeFileSync(requestPath, JSON.stringify({ ...request, embeddings: { provider: "hashed-tfidf" } }));
    const local = join(root, "bundle-local");
    const localManifest = await buildAtlasBundle(requestPath, local);
    assert.equal(localManifest.cloud.embeddings.provider, "hashed-tfidf");
    assert.deepEqual(readFileSync(join(local, "embeddings.f32")), readFileSync(join(local, "embeddings.f32")));
    writeFileSync(requestPath, JSON.stringify({ ...request, cohorts: [...request.cohorts, request.cohorts[0]] }));
    await assert.rejects(buildAtlasBundle(requestPath, join(root, "bundle-2"), { embed }), /unique/u);
    writeFileSync(requestPath, JSON.stringify({ ...request, condition: { pattern: "^(?<arm>.+)$" } }));
    await assert.rejects(buildAtlasBundle(requestPath, join(root, "bundle-3"), { embed }), /named group "condition"/u);
    writeFileSync(requestPath, JSON.stringify({ ...request, condition: { pattern: "^nothing-(?<condition>matches)$" } }));
    const staging = () => readdirSync(tmpdir()).filter((f) => f.startsWith(`ebo-atlas-tables-${process.pid}-`)).sort();
    const stagingBefore = staging();
    await assert.rejects(buildAtlasBundle(requestPath, join(root, "bundle-4"), { embed }), /does not match the condition pattern/u, "a naming mistake is an error, not a synthesized arm");
    assert.deepEqual(staging(), stagingBefore, "a failed build removes its streamed table staging (resolved native content)");
    assert.ok(readFileSync(join(out, "manifest.json"), "utf8").includes('"schemaVersion": "ebo.atlas-bundle/v2"'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an Atlas bundle labels every result with its producer mode and direction and certifies each mode on its own", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-atlas-bundle-modes-"));
  try {
    await createAtlasFixture(join(root, "study"), { decisionModel: true });
    const requestPath = join(root, "bundle-request.json");
    writeFileSync(requestPath, JSON.stringify({ schemaVersion: "ebo.atlas-bundle-request/v2", id: "synthetic-modes", title: "Synthetic modes",
      cohorts: [{ id: "all", atlasRequest: "study/atlas.json" }], condition: { pattern: "^synthetic-(?<condition>attempt)-\\d+$" } } satisfies AtlasBundleRequest));
    const out = join(root, "bundle");
    const embed = standInEmbed();
    await buildAtlasBundle(requestPath, out, { now: () => new Date("2026-10-07T00:00:00.000Z"), embed });
    assert.equal(verifyAtlasBundle(out).ok, true);

    type Doc = { id: string; card: string; outcome: string; value: string | null; mode: string; producer: string; direction: string | null; probability: number | null;
      probabilities: unknown; thresholds: unknown; rubric: unknown; shown: { scope: string }; citations: unknown[] };
    const document = JSON.parse(readFileSync(join(out, "assessments.json"), "utf8")) as { modes: string[]; directions: string[]; assessments: Doc[];
      certified: Record<string, { cells: Array<{ card: string; mode: string; producer: string; counts: Record<string, number>; denominator: number; group: Record<string, string> }> }> };
    assert.deepEqual(document.modes, ["llm-judge", "decision-model"]);
    assert.deepEqual(document.directions, ["favourable", "unfavourable", "neutral"]);
    const decided = document.assessments.filter(({ mode }) => mode === "decision-model");
    assert.equal(decided.length, 9);
    assert.equal(document.assessments.length, 15);
    for (const doc of decided) {
      assert.deepEqual([doc.citations, doc.rubric, doc.shown.scope], [[], null, "all-steps"], doc.id);
      assert.ok(doc.probabilities && doc.thresholds && typeof doc.probability === "number", doc.id);
      assert.equal(doc.direction !== null, doc.outcome === "present", "only a present result has a direction");
    }
    for (const doc of document.assessments.filter(({ mode }) => mode === "llm-judge")) assert.deepEqual([doc.probabilities, doc.thresholds, doc.shown.scope], [null, null, "selected-events"], doc.id);
    assert.equal(decided.find(({ card, outcome }) => card === "TI-03" && outcome === "present")!.direction, "unfavourable");
    assert.equal(decided.find(({ value }) => value === "no check recorded")!.direction, "unfavourable");
    // One certified cell per group, card and producer: the same card has an LLM-judge cell and a decision-model cell with their own counts.
    const cells = document.certified.all!.cells.filter(({ card, group }) => card === "VF-03" && group.model === "synthetic-model-a");
    assert.deepEqual(cells.map(({ mode, counts, denominator }) => [mode, counts.present, denominator]).sort(), [["decision-model", 2, 2], ["llm-judge", 3, 3]]);
    assert.ok(document.certified.all!.cells.every(({ mode, producer }) => producer.startsWith(`${mode} `)));

    const db = await DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false", autoload_known_extensions: "false" });
    const connection = await db.connect();
    try {
      const rows = (await connection.runAndReadAll(`SELECT producer_mode, direction, count(*) AS n, count(probability) AS p FROM '${join(out, "tables", "assessments.parquet")}' GROUP BY ALL ORDER BY ALL`)).getRowObjectsJson();
      assert.deepEqual(rows.map(({ producer_mode, direction, n, p }) => [producer_mode, direction, Number(n), Number(p)]), [
        ["decision-model", "favourable", 3, 3], ["decision-model", "neutral", 1, 1], ["decision-model", "unfavourable", 2, 2], ["decision-model", null, 3, 3],
        ["llm-judge", "favourable", 2, 0], ["llm-judge", "unfavourable", 2, 0], ["llm-judge", null, 2, 0]]);
    } finally { connection.closeSync(); db.closeSync(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("lane usage: final records without token dimensions are not usage, and their cost still counts", () => {
  const event = (attributes: Record<string, unknown>) => ({ nativeTime: { status: "known", value: "2026-10-07T00:00:00.000Z" }, attributes }) as never;
  const attempt = { attempt_id: "a", task_id: null, condition: null, trial_id: null, harness_id: null, model_id: null, terminal_state: null, failure_class: null, capture_qualification: null };
  const durationOnly = laneData(attempt, [], [event({ resourceSemantics: "cumulative-final", durationMs: 1200 })]);
  assert.deepEqual([durationOnly.lane.usage_semantics, durationOnly.lane.tokens_total], ["none", null], "no token evidence is unavailable, not zero");
  const withIncrements = laneData(attempt, [], [event({ resourceSemantics: "increment", inputTokens: 10, outputTokens: 5 }), event({ resourceSemantics: "cumulative-final", totalCostUsd: 0.5 })]);
  assert.deepEqual([withIncrements.lane.usage_semantics, withIncrements.lane.tokens_total, withIncrements.lane.cost_usd], ["per-turn", 15, 0.5]);
});

test("native record digests: a line record hashes its line, any other locator the whole file's bytes", () => {
  const file = Buffer.from('{"a":1}\n{"b":2}\n');
  assert.deepEqual(nativeRecordDigest(file, "line:2"), { sha256: createHash("sha256").update('{"b":2}').digest("hex"), text: '{"b":2}', chars: 7 });
  assert.equal(nativeRecordDigest(file, "line:9"), undefined);
  assert.equal(nativeRecordDigest(file, "")!.sha256, createHash("sha256").update(file).digest("hex"));
  assert.equal(nativeRecordDigest(Buffer.from([0x1f, 0x8b, 0, 1]), "#/workspace")!.binary, true, "binary files keep their digest, not their text");
  assert.equal(nativeRecordDigest(null, "line:1"), undefined);
});

test("native physical lines retain blank lines, CRLF and UTF-8 across read chunks", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-atlas-native-lines-"));
  try {
    writeFileSync(join(root, "manifest.json"), JSON.stringify({ evidence: [{ id: "session", relativePath: "session.jsonl" }] }));
    // The two-byte and four-byte characters straddle 64 KiB read boundaries.
    const text = `${"x".repeat(65535)}é\r\n\n${"🙂".repeat(20000)}\n`;
    writeFileSync(join(root, "session.jsonl"), text);
    const native = new NativeLines(root, "display");
    for (const [index, line] of text.split("\n").entries()) {
      const record = native.record("session", `line:${index + 1}`);
      assert.equal(record.resolved, true);
      assert.equal(record.text, line);
      assert.equal(record.sha256, createHash("sha256").update(line).digest("hex"));
      assert.equal(record.chars, line.length);
    }
    assert.equal(native.record("session", "line:5").resolved, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("claims: a certified filter on a dimension the report does not group by fails instead of widening the population", async () => {
  const db = await DuckDBInstance.create(":memory:", { autoinstall_known_extensions: "false", autoload_known_extensions: "false" });
  const connection = await db.connect();
  try {
    await connection.run("CREATE TABLE assessments (assertion_id VARCHAR)");
    const cells = [{ group: { model: "m", task: "t" }, card: "VF-01", counts: { present: 2 }, denominator: 3 }];
    const claim = (where: Record<string, string>) => ({ study: "s", source: { file: "f", title: "t" }, number_kinds: {},
      claims: [{ id: "C1", type: "descriptive", text: "x", source_section: "s", support: [], numbers: [{ id: "n", label: "n", value: 2, kind: "certified" as const, expr: { cohort: "c", where, outcome: "present" } }] }] });
    const context = { connection, certified: { c: { cells } }, reports: {}, assessments: [], audits: {}, attempts: {}, viewIds: new Set<string>(), recordSha256: () => undefined };
    assert.equal((await validateClaims(claim({ model: "m" }), context)).validated, true);
    const bad = await validateClaims(claim({ model: "m", trial: "1" }), context);
    assert.equal(bad.validated, false);
    assert.match(bad.failures[0]!, /not grouped by trial/u);
    const noCell = await validateClaims({ ...claim({ model: "other" }), claims: [{ ...claim({}).claims[0]!, numbers: [{ ...claim({}).claims[0]!.numbers[0]!, value: 0, expr: { cohort: "c", where: { model: "other" }, outcome: "present" } }] }] }, context);
    assert.equal(noCell.validated, false, "a selector matching no cell is unavailable, not a certified zero");
    const noOutcome = await validateClaims({ ...claim({}), claims: [{ ...claim({}).claims[0]!, numbers: [{ ...claim({}).claims[0]!.numbers[0]!, value: 0, expr: { cohort: "c", outcome: "presnt" } }] }] }, context);
    assert.match(noOutcome.failures.join(" "), /reports no outcome presnt/u);
    // A cohort holding both producer modes for a card: a number names one mode and never adds the two.
    const mixed = { ...context, certified: { c: { cells: [{ ...cells[0]!, mode: "llm-judge" }, { ...cells[0]!, mode: "decision-model", counts: { present: 1 }, denominator: 2 }] } } };
    const pooled = await validateClaims(claim({ model: "m" }), mixed);
    assert.equal(pooled.validated, false);
    assert.match(pooled.failures.join(" "), /llm-judge and decision-model.*name one with where\.mode/u);
    assert.equal((await validateClaims(claim({ model: "m", mode: "llm-judge" }), mixed)).validated, true);
    assert.equal((await validateClaims(claim({ model: "m", mode: "decision-model" }), mixed)).validated, false, "the decision-model cell holds 1, not the claimed 2");
    const twice = claim({ model: "m" });
    const duplicated = await validateClaims({ ...twice, claims: [twice.claims[0]!, twice.claims[0]!] }, context);
    assert.match(duplicated.failures.join(" "), /claim ids must be unique/u);
  } finally { connection.closeSync(); db.closeSync(); }
});

test("lane usage: a final with one token dimension is not a token total", () => {
  const event = (attributes: Record<string, unknown>) => ({ nativeTime: { status: "known", value: "2026-10-07T00:00:00.000Z" }, attributes }) as never;
  const attempt = { attempt_id: "a", task_id: null, condition: null, trial_id: null, harness_id: null, model_id: null, terminal_state: null, failure_class: null, capture_qualification: null };
  const lane = laneData(attempt, [], [event({ resourceSemantics: "increment", inputTokens: 10 }), event({ resourceSemantics: "cumulative-final", outputTokens: 4 })]).lane;
  assert.deepEqual([lane.usage_semantics, lane.tokens_total], ["per-turn", null], "input-only increments and an output-only final are no token total");
  const complete = laneData(attempt, [], [event({ resourceSemantics: "increment", inputTokens: 10, outputTokens: 2 })]).lane;
  assert.equal(complete.tokens_total, 12);
});

test("lane usage: untimed increments count toward the total without a place on the timeline", () => {
  const untimed = (attributes: Record<string, unknown>) => ({ nativeTime: { status: "unknown" }, attributes }) as never;
  const attempt = { attempt_id: "a", task_id: null, condition: null, trial_id: null, harness_id: null, model_id: null, terminal_state: null, failure_class: null, capture_qualification: null };
  const lanes = laneData(attempt, [], [untimed({ resourceSemantics: "increment", inputTokens: 7, outputTokens: 3 })]);
  assert.deepEqual([lanes.lane.usage_semantics, lanes.lane.tokens_total, lanes.usage], ["per-turn", 10, undefined]);
});

test("lane cost: per-request cost adds up when no final cost is reported", () => {
  const event = (attributes: Record<string, unknown>) => ({ nativeTime: { status: "known", value: "2026-10-07T00:00:00.000Z" }, attributes }) as never;
  const attempt = { attempt_id: "a", task_id: null, condition: null, trial_id: null, harness_id: null, model_id: null, terminal_state: null, failure_class: null, capture_qualification: null };
  const lane = laneData(attempt, [], [event({ resourceSemantics: "increment", totalTokens: 5, totalCostUsd: 0.25 }), event({ resourceSemantics: "increment", totalTokens: 5, totalCostUsd: 0.5 })]).lane;
  assert.equal(lane.cost_usd, 0.75);
});

test("devin usage: identical consecutive context snapshots are one report; used of size is the context series", () => {
  const event = (attributes: Record<string, unknown>, at = "2026-10-08T00:00:00.000Z") => ({ nativeTime: { status: "known", value: at }, attributes }) as never;
  const attempt = { attempt_id: "a", task_id: null, condition: null, trial_id: null, harness_id: null, model_id: null, terminal_state: null, failure_class: null, capture_qualification: null };
  const snapshot = (used: number, inputTokens: number, outputTokens: number, at: string) =>
    event({ usageSemantics: "request-context-snapshot", used, size: 262000, inputTokens, outputTokens }, at);
  const events = [
    snapshot(1000, 900, 100, "2026-10-08T00:00:01.000Z"), snapshot(1000, 900, 100, "2026-10-08T00:00:01.100Z"),
    snapshot(2000, 1800, 200, "2026-10-08T00:00:02.000Z"), snapshot(2000, 1800, 200, "2026-10-08T00:00:02.100Z"),
    event({ resourceSemantics: "cumulative-final", inputTokens: 50, outputTokens: 20, cachedInputTokens: 2630 }, "2026-10-08T00:00:03.000Z"),
  ];
  const lanes = laneData(attempt, [], events);
  assert.deepEqual(lanes.context, [[Date.parse("2026-10-08T00:00:01.000Z"), 1000], [Date.parse("2026-10-08T00:00:02.000Z"), 2000]], "each report's context fill, deduplicated");
  assert.equal(lanes.usage!.at(-1)![1], 3000, "per-request input plus output sums the two deduplicated reports");
  assert.deepEqual([lanes.lane.usage_semantics, lanes.lane.tokens_total, lanes.lane.context_max, lanes.lane.output_tokens],
    ["per-turn", 2700, 2000, "per-request"], "the cumulative final (input + output + cached input) wins the total");
  const interrupted = laneData(attempt, [], events.slice(0, 4));
  assert.equal(interrupted.lane.tokens_total, 3000, "without a final, the deduplicated request sum is the total");
});

test("devin messages: consecutive same-update chunks merge into one message unit, thoughts stay hidden", () => {
  const chunk = (id: string, order: number, update: string, family: string, actor: string) => ({
    id, runId: "r", attemptId: "a",
    source: { harness: "devin-cli", nativeType: `session/update:${update}`, nativeReference: { artifactId: "session", recordLocator: `line:${order}` } },
    nativeOrder: { status: "known", value: order, domain: "devin-acp-stdio" },
    nativeTime: { status: "known", value: `2026-10-08T00:00:0${order}.000Z` },
    actor: { kind: actor }, family, phase: "instant",
    scope: { kind: "session", id: "s" },
    relations: { parent: { status: "unknown" }, known: [] },
    attributes: { method: "session/update", sessionUpdate: update },
    content: { status: "known", value: [{ nativeReference: { artifactId: "session", recordLocator: `line:${order}#/text` }, mediaType: "application/json" }] },
  }) as never;
  const events = [
    chunk("u1", 1, "user_message_chunk", "message", "user"),
    chunk("m1", 2, "agent_message_chunk", "message", "agent"), chunk("m2", 3, "agent_message_chunk", "message", "agent"),
    chunk("th", 4, "agent_thought_chunk", "reasoning", "agent"),
    chunk("m3", 5, "agent_message_chunk", "message", "agent"),
  ];
  const texts = new Map([[1, "do it"], [2, "Hello "], [3, "world"], [4, "secret reasoning"], [5, "done"]]);
  const resolve = (reference: { recordLocator: string }) => ({ status: "resolved" as const,
    value: { type: "text", text: texts.get(Number(reference.recordLocator.match(/line:(\d+)/u)![1])) } });
  const { units, links } = deriveUnits({ attemptId: "a", events, occurrences: [], resolveContent: resolve });
  const messages = units.filter((u) => u.unit_kind === "message");
  assert.equal(messages.length, 3, "two merged runs plus the user message; the thought chunk is not a message");
  assert.equal(messages[1]!.embed_text, "Hello world");
  assert.equal(messages[1]!.event_count, 2);
  assert.equal(messages[1]!.role, "assistant");
  assert.ok(links.some((l) => l.event_key === "a/m2"), "every merged chunk is a linked event part");
});
