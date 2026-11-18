import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importAtifFile } from "../src/atif-import.js";
import { validateRetainedBehaviorAssertion, type DecisionModelAssertion } from "../src/behavior-assertions.js";
import { loadDefaultBehaviorOntology } from "../src/behavior-ontology.js";
import { main } from "../src/cli.js";
import {
  decisionModelQuestions, importDecisionModelResults, runDecisionModelJudge, systemOneDecisionModel, type DecisionModelProvider,
} from "../src/decision-model-judge.js";
import type { DecisionAnswer, DecisionQuestion } from "../src/decision-models.js";
import { excerpt, renderStepExcerpt } from "../src/step-excerpt.js";
import { createAtlasFixture } from "./atlas-fixture.js";

const ontology = loadDefaultBehaviorOntology();
const card = (id: string) => ontology.cards.find((item) => item.id === id)!;

/** Answers every question: present for presence cards, applies with the first value for dimension cards. */
function fakeProvider(options: { failFirst?: number; delayMs?: number } = {}): DecisionModelProvider & { calls: number; maxInFlight: number; states: unknown[] } {
  let failures = options.failFirst ?? 0, inFlight = 0;
  const provider = {
    producer: { provider: "fixture", model: "fixture-decision-model", version: "1.0.0" }, calls: 0, maxInFlight: 0, states: [] as unknown[],
    async ask(state: unknown, questions: Record<string, DecisionQuestion>) {
      provider.calls += 1; provider.states.push(state); inFlight += 1; provider.maxInFlight = Math.max(provider.maxInFlight, inFlight);
      await new Promise((done) => setTimeout(done, options.delayMs ?? 1));
      inFlight -= 1;
      if (failures > 0) { failures -= 1; return { error: "fixture provider unavailable" }; }
      const answers: Record<string, DecisionAnswer> = {};
      for (const [id, question] of Object.entries(questions)) {
        if (question.type === "noul") answers[id] = { type: "noul", noul: 0.95 };
        else if (question.type === "choice") {
          const names = Object.keys(question.criteria);
          const probabilities = id.endsWith("_value")
            ? Object.fromEntries(names.map((name, index) => [name, index === 0 ? 0.8 : 0.2 / (names.length - 1)]))
            : { present: 0.92, "near-miss": 0.04, absent: 0.04 };
          answers[id] = { type: "choice", choice: names[0]!, probabilities, confidence: 0.9 };
        }
      }
      return { answers };
    },
  };
  return provider;
}

function writeSpec(root: string, extra: Record<string, unknown> = {}): string {
  const path = join(root, "decision-model.json");
  writeFileSync(path, JSON.stringify({
    schemaVersion: "ebo.decision-model-run/v1", corpusRoot: "corpus", corpusIndex: "index.jsonl",
    provider: { id: "typesafe", model: "jev-1.14.0" }, thresholds: { present: 0.9, absent: 0.1 }, requestsPerSecond: 1000, output: "decision-model", ...extra,
  }));
  return path;
}

test("each card becomes typed questions: three-way presence, or applies and value for a dimension card", () => {
  const questions = decisionModelQuestions([card("VF-03"), card("TI-03")]);
  assert.equal(card("VF-03").kind, "dimension");
  assert.equal(questions["VF-03_applies"]!.type, "noul");
  assert.deepEqual(Object.keys((questions["VF-03_value"] as Extract<DecisionQuestion, { type: "choice" }>).criteria), card("VF-03").values!.map(({ name }) => name));
  assert.deepEqual(Object.keys((questions["TI-03"] as Extract<DecisionQuestion, { type: "choice" }>).criteria), ["present", "near-miss", "absent"]);
  assert.match(String(questions["TI-03"]!.instructions), new RegExp(`evidenceTest: ${card("TI-03").evidenceTest.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
});

test("the step excerpt keeps every step and cuts fields to the budget, the first and last steps wider", () => {
  const long = "x".repeat(5000);
  const steps = Array.from({ length: 200 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", copied: false, message: `step ${index} ${long}`,
    calls: index % 2 ? [{ key: `c${index}`, tool: "bash", arguments: { command: "npm test", api_key: "should-not-appear" } }] : [],
    results: index % 2 ? [{ call: `c${index}`, content: "ok" }] : [] }));
  const result = excerpt(steps, ["secret-model-7"], "ebo-step-excerpt-events");
  assert.equal(result.trace.rows.length, 200);
  assert.equal(result.trace.recordedSteps, 200);
  assert.deepEqual(result.fieldChars, { min: 61, max: 183 }, "37,000 / (200 x 3) = 61 per field; the first 10 and last 5 steps get three times that");
  assert.equal(result.trace.rows[50]!.message.length, 3 * 15 + " [excerpt gap] ".length + 15, "a cut field keeps three quarters of its limit from the start and a quarter from the end");
  assert.ok(result.trace.rows[50]!.message.includes("[excerpt gap]"));
  assert.ok(result.trace.rows[0]!.message.length > result.trace.rows[50]!.message.length);
  assert.ok(!JSON.stringify(result).includes("should-not-appear"), "secret-named fields are redacted");
  assert.equal(result.trace.rows[1]!.results[0]!.call, "s2c1", "a result names the anchor of the call it answers");
  const blinded = excerpt([{ role: "assistant", copied: false, message: "I am secret-model-7 working in /Users/alice/repo", calls: [], results: [] }], ["secret-model-7"], "ebo-step-excerpt-events");
  assert.equal(blinded.trace.rows[0]!.message, "I am [evaluated-model] working in /Users/[user]/repo");
});

test("native captures and ATIF imports both render as step excerpts", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-step-excerpt-"));
  try {
    await createAtlasFixture(root);
    const native = await renderStepExcerpt(join(root, "corpus", "synthetic-attempt-0"));
    assert.equal(native.rendering.id, "ebo-step-excerpt-events");
    assert.ok(native.trace.recordedSteps > 0);
    assert.ok(native.trace.rows.some(({ role }) => role === "assistant"));
    const source = join(root, "acme.json"), destination = join(root, "import");
    writeFileSync(source, readFileSync(new URL("../../test/fixtures/atif/core/acme.json", import.meta.url)));
    await importAtifFile({ sourcePath: source, destination, runId: "imported", attemptId: "a" });
    const imported = await renderStepExcerpt(destination);
    const document = JSON.parse(readFileSync(source, "utf8")) as { steps: unknown[] };
    assert.equal(imported.rendering.id, "ebo-step-excerpt-atif");
    assert.equal(imported.trace.recordedSteps, document.steps.length, "one row per ATIF step");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a cohort run writes one validated result per attempt and card, resumes, and judges a card subset in parts", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-decision-model-run-"));
  try {
    await createAtlasFixture(root);
    const provider = fakeProvider({ delayMs: 5 });
    const spec = writeSpec(root, { cards: ["VF-03", "TI-03", "EN-01"], batchSize: 2, concurrency: 3 });
    const first = await runDecisionModelJudge(spec, { provider });
    assert.equal(first.attempts, 7);
    assert.equal(first.batches.written, 14, "two batches per attempt");
    assert.equal(first.results, 21);
    assert.equal(provider.calls, 14);
    assert.ok(provider.maxInFlight <= 3, `at most three requests in flight (saw ${String(provider.maxInFlight)})`);
    assert.equal(first.assertionSets.length, 14);
    const line = readFileSync(join(root, first.assertionSets[0]!.path), "utf8").trim().split("\n")[0]!;
    const result = JSON.parse(line) as DecisionModelAssertion;
    assert.equal(result.schemaVersion, "ebo.behavior-assertion/v2");
    assert.equal(result.producer.mode, "decision-model");
    assert.equal(result.evidence.scope, "all-steps");
    await validateRetainedBehaviorAssertion(join(root, first.assertionSets[0]!.bundleRoot), result);

    const again = await runDecisionModelJudge(spec, { provider });
    assert.equal(provider.calls, 14, "a rerun sends no request for finished batches");
    assert.equal(again.batches.skipped, 14);

    const other = await runDecisionModelJudge(writeSpec(root, { cards: ["EX-01"] }), { provider });
    assert.equal(other.batches.written, 7, "a different card set is a separate part");
    assert.equal(provider.calls, 21);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed batch writes nothing and the next run retries it", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-decision-model-retry-"));
  try {
    await createAtlasFixture(root);
    const spec = writeSpec(root, { cards: ["TI-03"], concurrency: 1 });
    const failing = await runDecisionModelJudge(spec, { provider: fakeProvider({ failFirst: 2 }) });
    assert.equal(failing.batches.failed, 2);
    assert.equal(failing.batches.written, 5);
    let output = "";
    assert.equal(await main(["judge", "decision-model", spec], (text) => { output += text; }, { decisionModel: fakeProvider() }), 0, output);
    assert.match(output, /2 batch\(es\) written, 5 already done, 0 failed/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("aggregation reads decision-model results from assertion sets, apart from LLM-judge results", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-decision-model-aggregate-"));
  try {
    await createAtlasFixture(root);
    const run = await runDecisionModelJudge(writeSpec(root, { cards: ["VF-03"] }), { provider: fakeProvider() });
    const aggregation = JSON.parse(readFileSync(join(root, "aggregation.json"), "utf8"));
    aggregation.sources.assertionSets = run.assertionSets;
    writeFileSync(join(root, "aggregation.json"), JSON.stringify(aggregation));
    let output = "";
    assert.equal(await main(["aggregate", "build", join(root, "aggregation.json"), join(root, "derived", "report.json")], (text) => { output += text; }), 0, output);
    const report = JSON.parse(readFileSync(join(root, "derived", "report.json"), "utf8")) as { groups: Array<{ behaviors: Array<{ producer: { mode: string }; behavior: { cardId: string }; verdicts: Array<{ verdict: string; measurement: { numerator: { value: number } } }> }> }> };
    const decided = report.groups.flatMap(({ behaviors }) => behaviors.filter(({ producer, behavior }) => producer.mode === "decision-model" && behavior.cardId === "VF-03"));
    assert.ok(decided.length > 0);
    assert.equal(decided.reduce((sum, { verdicts }) => sum + verdicts.find(({ verdict }) => verdict === "present")!.measurement.numerator.value, 0), 7);
    assert.ok(report.groups.some(({ behaviors }) => behaviors.some(({ producer }) => producer.mode === "llm-judge")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("results produced elsewhere are validated against their attempt before anything is written", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-decision-model-import-"));
  try {
    await createAtlasFixture(root);
    const spec = writeSpec(root);
    const evidence = { scope: "step-excerpt", steps: { included: 3, total: 4 }, rendering: { id: "external-renderer", version: "2" }, fieldChars: { min: 50, max: 400 }, budgetChars: 40000 };
    const producer = { provider: "external", model: "external-model", version: "1" };
    const line = (cardId: string, probabilities: unknown, attemptId = "synthetic-attempt-1") => JSON.stringify({ schemaVersion: "ebo.decision-model-result/v1",
      runId: attemptId.replace("attempt", "run"), attemptId, cardId, probabilities, producer, evidence });
    const good = join(root, "results.jsonl");
    writeFileSync(good, `${line("TI-03", { present: 0.05, nearMiss: 0.05, absent: 0.9 })}\n${line("VF-03", { applies: 0.5, values: Object.fromEntries(card("VF-03").values!.map(({ name }, i) => [name, i === 0 ? 1 : 0])) })}\n`);
    const imported = await importDecisionModelResults(spec, good);
    assert.deepEqual([imported.attempts, imported.results], [1, 2]);
    const written = readFileSync(join(root, imported.assertionSets[0]!.path), "utf8").trim().split("\n").map((text) => JSON.parse(text) as DecisionModelAssertion);
    assert.deepEqual(written.map(({ judgment }) => judgment.verdict), ["absent", "unknown"]);

    const bad = join(root, "bad.jsonl");
    writeFileSync(bad, `${line("TI-03", { present: 0.9, nearMiss: 0.05, absent: 0.05 }, "synthetic-attempt-2")}\n${line("TI-03", { present: 0.9, nearMiss: 0.5, absent: 0.05 }, "synthetic-attempt-3")}\n`);
    await assert.rejects(importDecisionModelResults(spec, bad), /do not sum to 1/u);
    writeFileSync(bad, `${line("TI-03", { present: 0.9, nearMiss: 0.05, absent: 0.05 }, "no-such-attempt")}\n`);
    await assert.rejects(importDecisionModelResults(spec, bad), /does not contain/u);
    assert.equal(existsSync(join(root, "decision-model", "synthetic-run-2")), false, "an invalid file writes nothing");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the Jev adapter opts in to long context and retries rate limits and server errors", async () => {
  const seen: Array<{ headers: Record<string, string>; body: { model: string; questions: Record<string, unknown> } }> = [];
  let calls = 0;
  const fetch = (async (_url: string, init: RequestInit) => {
    calls += 1;
    seen.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    if (calls === 1) return new Response("busy", { status: 429, headers: { "retry-after": "0" } });
    if (calls === 2) return new Response("oops", { status: 500 });
    return Response.json({ model: "jev-1.14.0", answers: { "TI-03": { type: "choice", choice: "present", probabilities: { present: 0.9, "near-miss": 0.05, absent: 0.05 }, confidence: 0.9 } }, usage: { input_tokens: 10, output_tokens: 1 } });
  }) as typeof globalThis.fetch;
  const jev = systemOneDecisionModel({ provider: "typesafe", model: "jev-1.14.0" }, { fetch, env: { TYPESAFE_API_KEY: "test-key" }, sleep: async () => {} });
  const reply = await jev.ask({ trace: { rows: [] } }, decisionModelQuestions([card("TI-03")]));
  assert.ok("answers" in reply);
  assert.equal(calls, 3);
  assert.equal(seen[0]!.headers["TypeSafe-Danger-Zone-Long-Context"], "true");
  assert.equal(seen[0]!.body.model, "jev-1.14.0");
  assert.deepEqual(jev.producer, { provider: "typesafe", model: "jev-1.14.0", version: "1.0.0" });
});
