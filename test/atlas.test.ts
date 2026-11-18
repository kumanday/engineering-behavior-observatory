import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import test from "node:test";
import { aggregateEvaluation } from "../src/aggregation.js";
import { atlasBehaviorRows, atlasDirectionRows, loadAtlas, queryAtlas, serveAtlas, shareAtlas, writeAtlas, type AtlasRequest } from "../src/atlas.js";
import { renderAtlas } from "../src/atlas-html.js";
import { atlasDashboards } from "../src/atlas-grafana.js";
import { createPortableRunBundleExport, sanitizeDerivedExport } from "../src/exports.js";
import { digestMetadata } from "../src/artifacts.js";
import { importReviewDecision, type ReviewHistory } from "../src/human-calibration.js";
import { main } from "../src/cli.js";
import { createAtlasFixture } from "./atlas-fixture.js";
import type { BehaviorAssertion } from "../src/behavior-assertions.js";

test("Atlas mixed fixture preserves exact cohort populations, decisions and native drilldown", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-atlas-test-"));
  try {
    const requestPath = await createAtlasFixture(root);
    const source = await loadAtlas(requestPath);
    const view = await queryAtlas(source);
    assert.equal(view.report.sourcePopulation.uniqueRuns, 6);
    assert.equal(view.report.sourcePopulation.selectedAttempts, 7);
    assert.deepEqual(new Set(view.cases.map(({ review }) => review)), new Set(["confirmed", "disputed", "rejected", "proposed", "abstained", "unavailable"]));
    assert.equal(view.report.comparisons[0]!.claimStatus, "unavailable");
    assert.equal(view.cases.filter(({ review }) => review === "confirmed").length, 2);
    assert.equal(view.cases[0]!.harnessVersion, source.input.corpusEntries[0]!.harnessVersion);
    const rows = atlasBehaviorRows(view);
    assert.ok(rows.some(({ card, verdict, value, numerator, denominator }) => card === "VF-03" && verdict === "present" && value === null && numerator === 3 && denominator === 3));
    assert.ok(rows.some(({ verdict, value, numerator, denominator, unit }) => verdict === "present" && value === "check after the last edit" && numerator === 2 && denominator === 3 && unit === "present-attempt-card"));
    assert.ok(rows.some(({ family, verdict, value, numerator, denominator }) => family === "VF" && verdict === "absent" && value === null && numerator === 1 && denominator === 2));
    assert.ok(rows.some(({ card, verdict, numerator, denominator }) => card === "EN-04" && verdict === "unknown" && numerator === 1 && denominator === 1), "an abstention counts as unknown in its card's distribution");
    assert.ok(rows.filter(({ card }) => card === "EN-04").every(({ value }) => value === null), "only dimension cards report values");
    assert.deepEqual([...new Set(rows.filter(({ group }) => group === "synthetic-model-b").map(({ card }) => card))], ["EN-04", "VF-03"], "cards follow ontology order within a group");
    for (const item of view.cases) {
      for (const citation of item.citations) {
        assert.equal((citation.normalizedEvent as { id: string }).id, citation.eventId);
        assert.ok(citation.nativeRecord);
      }
    }
    const filtered = await queryAtlas(source, { model: "synthetic-model-b", review: "confirmed" });
    assert.equal(filtered.report.sourcePopulation.selectedAttempts, 1);
    assert.equal(filtered.filteredOutAttempts, 6);
    assert.equal(filtered.cases[0]!.verdict, "absent");
    const selectedIds = new Set(filtered.cases.map(({ attemptId }) => attemptId));
    const exact = await aggregateEvaluation({ ...source.input, corpusEntries: source.input.corpusEntries.filter(({ attemptId }) => selectedIds.has(attemptId!)), assertions: source.input.assertions.filter(({ document }) => selectedIds.has(document.attemptId)), observationSets: source.input.observationSets.filter(({ document }) => selectedIds.has(document.attemptId)) }, source.aggregation);
    assert.deepEqual(filtered.report.groups, exact.groups);
    assert.notEqual(filtered.cohortDigest, view.cohortDigest);
    assert.equal((await queryAtlas(source, { q: "not in fixture" })).report.sourcePopulation.selectedAttempts, 0);
    const proposed = await queryAtlas(source, { review: "proposed" });
    assert.equal(proposed.cases[0]!.decisions.length, 0);
    const modelRows = atlasBehaviorRows(proposed);
    assert.ok(modelRows.some(({ numerator, denominator }) => numerator === 1 && denominator === 1));
    assert.ok(modelRows.every(({ unit }) => unit === "judged-attempt-card" || unit === "present-attempt-card"));
    for (const review of ["disputed", "rejected"]) {
      const reviewed = await queryAtlas(source, { review });
      assert.ok(atlasBehaviorRows(reviewed).some(({ numerator, denominator }) => numerator === 1 && denominator === 1));
      assert.equal(reviewed.cases[0]!.review, review, "model distribution must not rewrite human review");
    }
    assert.deepEqual(atlasBehaviorRows(await queryAtlas(source, { review: "abstained" })).map(({ verdict, numerator, denominator }) => [verdict, numerator, denominator]), [["present", 0, 1], ["absent", 0, 1], ["unknown", 1, 1]]);
    assert.equal((await queryAtlas(source, { trial: "3" })).report.sourcePopulation.selectedAttempts, 2);
    source.aggregation.selectedAttemptPolicy = "latest-attempt-per-run";
    const latest = await queryAtlas(source, { review: "abstained" });
    assert.equal(latest.policyExcludedAttempts, 1);
    assert.equal(latest.report.sourcePopulation.selectedAttempts, 0, "an older matching assertion must not substitute for the latest retry");
    source.aggregation.selectedAttemptPolicy = "all-attempts";
    await assert.rejects(queryAtlas(source, { surprise: "value" } as never), /Unknown/u);
    const html = renderAtlas(view, false);
    assert.match(html, /&lt;script&gt;window.fixtureXss=1&lt;\/script&gt;/u);
    assert.doesNotMatch(html, /<script>window.fixtureXss|ghp_abcdefghijklmnopqrstuvwxyz123456|SYNTHETIC_HIDDEN_REASONING|1200\.0%/u);
    assert.doesNotMatch(`${html}${JSON.stringify(view)}`, /sk-ant-EBO-SENTINEL|fw_SyntheticPlantedKey/u);
    const scan = view.secretScan!;
    const cited = view.cases.filter(({ citations }) => citations.length > 0);
    const named = (disposition: string) => scan.findings.filter((finding) => "name" in finding && finding.name === "sessionApiKey" && finding.disposition === disposition).length;
    assert.equal(named("not-secret"), cited.length, "`sessionApiKey = /const` is a short path, not a credential");
    assert.equal(named("redacted"), cited.length, "`sessionApiKey: sessionAuth` is a bare word and is redacted");
    for (const kind of ["github-token", "anthropic-api-key", "fireworks-api-key"]) {
      assert.equal(scan.findings.filter((finding) => finding.kind === kind).length, cited.length, kind);
    }
    assert.equal(scan.redacted + scan.notSecret, scan.findings.length);
    const pointer = (document: unknown, location: string) => location.split("/").slice(1).reduce<unknown>((value, segment) => {
      const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      return Array.isArray(value) ? value[Number(key)] : (value as Record<string, unknown> | undefined)?.[key];
    }, document);
    for (const finding of scan.findings) {
      const index = view.cases.findIndex(({ key }) => key === finding.caseKey);
      assert.ok(finding.location.startsWith(`/cases/${String(index)}/citations/0/nativeRecord/`), finding.location);
      assert.equal(typeof pointer(view, finding.location), "string", `${finding.location} resolves in the view`);
    }
    const narrowed = await queryAtlas(source, { review: "confirmed" });
    for (const finding of narrowed.secretScan!.findings) {
      assert.equal(narrowed.cases[Number(finding.location.split("/")[2])]!.key, finding.caseKey, "pointers follow the filtered case order");
      assert.equal(typeof pointer(narrowed, finding.location), "string");
    }
    assert.equal(JSON.stringify(scan).includes("SENTINEL"), false);
    assert.match(html, /Print \/ save PDF/u);
    assert.match(html, /Frozen cohort/u);
    assert.match(html, /No human decision supplied/u);
    assert.match(html, /Operator-authored narrative/u);
    assert.deepEqual(atlasDashboards(view).map(({ uid }) => uid), ["ebo-atlas-overview", "ebo-atlas-behavior"]);
    const chart = atlasDashboards(view)[1]!.panels.find(({ id }) => id === 4)!;
    assert.equal(chart.targets?.[0]?.columns.find(({ selector }) => selector === "count")?.type, "number");
    assert.match(JSON.stringify(atlasDashboards(view)), /\$\{model:percentencode\}/u);
    const report = await writeAtlas(requestPath, join(root, "report"), { review: "confirmed" });
    assert.equal(report.matchingCases, 2);
    assert.equal(JSON.parse(readFileSync(join(root, "report/report.json"), "utf8")).cohortDigest, report.cohortDigest);
    await assert.rejects(writeAtlas(requestPath, join(root, "corpus/forbidden")), /outside immutable/u);
    await assert.rejects(shareAtlas(source, view), /Sharing unavailable/u);
    assert.equal(await main(["atlas", "build", requestPath, join(root, "bad"), "--unknown"], () => undefined), 1);

    const server = await serveAtlas(requestPath, 0);
    try {
      const address = server.address(); assert.ok(address && typeof address === "object");
      const base = `http://127.0.0.1:${address.port}`;
      const originalRequest = readFileSync(requestPath, "utf8");
      writeFileSync(requestPath, JSON.stringify({ ...JSON.parse(originalRequest), atlasUrl: `${base}/` }));
      const normalizedView = await queryAtlas(await loadAtlas(requestPath));
      assert.equal(normalizedView.atlasUrl, base, "configured origins normalize before Grafana URLs are assembled");
      const targets = atlasDashboards(normalizedView).flatMap(({ panels }) => panels.flatMap(({ targets }) => targets ?? []));
      for (const target of targets) {
        const url = new URL(target.url); url.search = "";
        assert.match(url.pathname, /^\/api\//u);
        assert.equal((await fetch(url)).status, 200, "generated Grafana targets resolve to live Atlas routes");
      }
      writeFileSync(requestPath, originalRequest);
      const response = await fetch(`${base}/api/view?verdict=absent`);
      assert.equal(response.status, 200);
      assert.equal((await response.json() as typeof view).report.sourcePopulation.selectedAttempts, 1);
      assert.equal((await (await fetch(`${base}/api/view?q=%24__all`)).json() as typeof view).report.sourcePopulation.selectedAttempts, 0, "text search does not interpret the Grafana all-variable sentinel");
      assert.equal((await fetch(`${base}/api/view`, { headers: { Origin: "https://foreign.example" } })).status, 403);
      assert.equal(await new Promise<number | undefined>((accept) => { get(`${base}/api/view`, { headers: { Host: "foreign.example" } }, (response) => { response.resume(); accept(response.statusCode); }); }), 403);
      assert.equal((await fetch(`${base}/api/view?path=/etc/passwd`)).status, 400);
      assert.equal((await fetch(`${base}/corpus/manifest.json`)).status, 404);
      assert.equal((await fetch(`${base}/report.html?share=true`)).status, 400);
      const rows = await (await fetch(`${base}/api/cases?review=disputed`)).json() as Array<{ review: string; href: string }>;
      assert.equal(rows.length, 1); assert.equal(rows[0]!.review, "disputed"); assert.match(rows[0]!.href, /#case-[a-f0-9]{64}$/u);
      const comparisons = await (await fetch(`${base}/api/comparisons`)).json() as Array<{ status: string; numerator: number | null }>;
      assert.equal(comparisons[0]!.status, "unavailable"); assert.equal(comparisons[0]!.numerator, null);
    } finally { await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept())); }

    const request = JSON.parse(readFileSync(requestPath, "utf8")) as AtlasRequest;
    const aggregationPath = join(root, "aggregation.json");
    const aggregation = JSON.parse(readFileSync(aggregationPath, "utf8"));
    const secondHistoryPath = join(root, "second-history.json");
    let secondHistory: ReviewHistory | undefined;
    for (const decision of source.input.calibrations[0]!.history.decisions) {
      secondHistory = (await importReviewDecision(source.input.calibrations[0]!.selection, secondHistoryPath, { ...decision, id: `${decision.id}-second`, reviewer: { ...decision.reviewer, id: "synthetic-second-reviewer" }, previousHistory: secondHistory ? { schemaVersion: secondHistory.schemaVersion, digest: `sha256:${digestMetadata(secondHistory).value}` } : null })).history;
    }
    writeFileSync(aggregationPath, JSON.stringify({ ...aggregation, sources: { ...aggregation.sources, assertions: [...aggregation.sources.assertions, aggregation.sources.assertions[0]], calibrations: [...aggregation.sources.calibrations, { selection: join(root, "selection.json"), history: secondHistoryPath }] } }));
    const repeated = await queryAtlas(await loadAtlas(requestPath));
    assert.equal(repeated.cases.length, view.cases.length, "identical repeated assertion sources count once and produce unique anchors");
    assert.equal(repeated.cases[0]!.decisions.length, 2, "independent compatible review histories remain inspectable");
    writeFileSync(aggregationPath, JSON.stringify(aggregation));
    const traced = { ...request, tempoDatasourceUid: "synthetic-tempo", traces: [{ runId: "synthetic-run-0", attemptId: "synthetic-attempt-0", traceId: "a".repeat(32), originalStart: "2026-09-07T12:00:00Z", replayStart: "2026-09-08T01:00:00Z" }] };
    writeFileSync(requestPath, JSON.stringify(traced));
    const traceView = await queryAtlas(await loadAtlas(requestPath), { review: "confirmed" });
    assert.equal(traceView.cases[0]!.trace?.originalStart, traced.traces[0]!.originalStart);
    assert.equal(traceView.cases[0]!.trace?.replayStart, traced.traces[0]!.replayStart);
    assert.match(traceView.cases[0]!.trace!.href, /^http:\/\/127\.0\.0\.1:13010\/explore\?/u);
    assert.match(renderAtlas(traceView, false), /Replay-shifted: 2026-09-08T01:00:00Z/u);
    writeFileSync(requestPath, JSON.stringify({ ...traced, traces: [...traced.traces, { ...traced.traces[0], traceId: "b".repeat(32) }] }));
    await assert.rejects(loadAtlas(requestPath), /trace attempt keys must be unique/u);
    writeFileSync(requestPath, JSON.stringify({ ...traced, traces: [{ ...traced.traces[0], traceId: "not-a-trace" }] }));
    await assert.rejects(loadAtlas(requestPath), /Invalid trace identity/u);
    writeFileSync(requestPath, JSON.stringify({ ...request, reviewPackets: ["missing.html"] }));
    await assert.rejects(loadAtlas(requestPath), /review packet is unavailable/u);
    writeFileSync(requestPath, JSON.stringify({ ...request, grafanaUrl: "javascript:alert(1)" }));
    await assert.rejects(loadAtlas(requestPath), /local HTTP origin/u);
    writeFileSync(requestPath, JSON.stringify({ ...request, schemaVersion: "ebo.atlas-request/v2" }));
    await assert.rejects(loadAtlas(requestPath), /incompatible/u);
    writeFileSync(requestPath, JSON.stringify(request));
    const assertionPath = source.aggregation.sources.assertions[0]!.path;
    const assertion = JSON.parse(readFileSync(assertionPath, "utf8")); assertion.judgment.citations[0].eventId = "missing-event";
    writeFileSync(assertionPath, JSON.stringify(assertion));
    await assert.rejects(loadAtlas(requestPath), /unknown normalized event/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Atlas and aggregation keep the two producer modes apart and summarise direction for each", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-atlas-modes-"));
  try {
    const source = await loadAtlas(await createAtlasFixture(root, { decisionModel: true }));
    const view = await queryAtlas(source);
    assert.deepEqual(view.filterOptions.mode, ["decision-model", "llm-judge", "unavailable"]);
    assert.deepEqual(view.filterOptions.direction, ["favourable", "neutral", "none", "unavailable", "unfavourable"]);

    // Every LLM-judge number is what it is without the decision-model results: nothing is pooled.
    const llmOnly = await aggregateEvaluation({ ...source.input, assertions: source.input.assertions.filter(({ document }) => document.producer.mode === "llm-judge") }, source.aggregation);
    for (const [index, group] of view.report.groups.entries()) {
      assert.deepEqual(group.behaviors!.filter(({ producer }) => producer.mode === "llm-judge"), llmOnly.groups[index]!.behaviors);
      assert.deepEqual(group.directions!.filter(({ producer }) => producer.mode === "llm-judge"), llmOnly.groups[index]!.directions);
      assert.ok(group.behaviors!.every(({ producer, rubric }) => (producer.mode === "llm-judge") === (rubric !== undefined)), "only the LLM judge has a rubric");
      assert.ok(group.directions!.every(({ producer, rubric }) => (producer.mode === "llm-judge") === (rubric !== undefined)), "direction entries carry the rubric too");
      // Group-wide assertion rates are unavailable when both modes are present; each mode has its own.
      for (const id of ["assertion-abstention-rate", "reviewed-assertion-confirmed-rate", "review-unresolved-rate", "review-disputed-rate"]) {
        const pooled = group.metrics.find((item) => item.id === id)!;
        assert.equal(pooled.measurement.status, "unavailable", id);
        assert.match(pooled.measurement.reason!, /more than one producer mode/u);
        assert.deepEqual({ ...group.metrics.find((item) => item.id === `${id}:llm-judge`)!, id }, llmOnly.groups[index]!.metrics.find((item) => item.id === id), `${id} for the LLM judge alone`);
        assert.ok(group.metrics.some((item) => item.id === `${id}:decision-model`), `${id} for the decision model`);
      }
      assert.ok(llmOnly.groups[index]!.metrics.every(({ id }) => !id.endsWith(":llm-judge")), "a single-mode group keeps the plain metric ids");
    }

    // A producer that differs only by configuration digest is its own direction entry, as it is its own per-card entry.
    const reconfigured = source.input.assertions.filter(({ document }) => document.producer.mode === "decision-model").map(({ bundleRoot, document }) => ({
      bundleRoot, document: { ...document, id: `${document.id}-reconfigured`, producer: { ...document.producer, configurationDigest: `sha256:${"c".repeat(64)}` as const } } as BehaviorAssertion,
    }));
    const split = await aggregateEvaluation({ ...source.input, assertions: [...source.input.assertions, ...reconfigured] }, source.aggregation);
    for (const [index, group] of split.groups.entries()) {
      const original = view.report.groups[index]!.directions!.filter(({ producer }) => producer.mode === "decision-model");
      const decisionModel = group.directions!.filter(({ producer }) => producer.mode === "decision-model");
      assert.equal(decisionModel.length, original.length * 2);
      for (const entry of original) {
        assert.deepEqual(decisionModel.find((item) => item.family === entry.family && item.producer.configurationDigest === undefined), entry);
        const { producer: _producer, ...counts } = decisionModel.find((item) => item.family === entry.family && item.producer.configurationDigest !== undefined)!;
        const { producer: _original, ...expected } = entry;
        assert.deepEqual(counts, expected, "the reconfigured producer's results are neither merged nor excluded as conflicting");
      }
    }

    const rows = atlasBehaviorRows(view);
    const count = (mode: string, group: string, card: string, verdict: string, value: string | null = null) => {
      const row = rows.find((item) => item.mode === mode && item.group === group && item.card === card && item.verdict === verdict && item.value === value);
      return row === undefined ? undefined : [row.numerator, row.denominator];
    };
    // The same card and cohort member, two modes, two sets of counts.
    assert.deepEqual(count("llm-judge", "synthetic-model-a", "VF-03", "present"), [3, 3]);
    assert.deepEqual(count("decision-model", "synthetic-model-a", "VF-03", "present"), [2, 2]);
    assert.deepEqual(count("decision-model", "synthetic-model-a", "VF-03", "present", "no check recorded"), [1, 2]);
    assert.deepEqual(count("llm-judge", "synthetic-model-b", "VF-03", "absent"), [1, 2]);
    assert.deepEqual(count("decision-model", "synthetic-model-b", "VF-03", "absent"), [1, 2]);
    assert.deepEqual(count("decision-model", "synthetic-model-b", "VF-03", "unknown"), [1, 2], "a probability between the thresholds counts as unknown");
    assert.deepEqual(count("decision-model", "synthetic-model-a", "TI-03", "present"), [1, 1]);
    assert.equal(count("llm-judge", "synthetic-model-a", "TI-03", "present"), undefined, "the LLM judge did not judge this card");
    assert.ok(rows.every(({ mode, producer, label }) => producer.startsWith(`${mode} `) && label.includes(` · ${mode} · `)), "every row names its mode");
    assert.equal(rows.find(({ card, verdict, value }) => card === "TI-03" && verdict === "present" && value === null)!.direction, "unfavourable");
    assert.equal(rows.find(({ card, verdict, value }) => card === "VF-03" && verdict === "present" && value === null)!.direction, null, "a dimension card has a direction per value only");
    assert.equal(rows.find(({ value }) => value === "check after the last edit")!.direction, "favourable");

    // Direction summary per cohort member, producer and family: present results by direction, and attempts with at least one such result.
    const directions = atlasDirectionRows(view);
    const share = (mode: string, group: string, family: string, measure: string) => Object.fromEntries(directions
      .filter((item) => item.mode === mode && item.group === group && item.family === family && item.measure === measure).map(({ direction, numerator, denominator }) => [direction, [numerator, denominator]]));
    assert.deepEqual(share("decision-model", "synthetic-model-a", "all", "results"), { favourable: [2, 5], unfavourable: [2, 5], neutral: [1, 5] });
    assert.deepEqual(share("decision-model", "synthetic-model-a", "all", "attempts"), { favourable: [1, 2], unfavourable: [2, 2], neutral: [1, 2] });
    assert.deepEqual(share("decision-model", "synthetic-model-a", "VF", "results"), { favourable: [2, 3], unfavourable: [1, 3], neutral: [0, 3] });
    assert.deepEqual(share("decision-model", "synthetic-model-a", "EN", "results"), { favourable: [0, 1], unfavourable: [0, 1], neutral: [1, 1] }, "a neutral result is counted");
    assert.deepEqual(share("decision-model", "synthetic-model-b", "all", "results"), { favourable: [1, 1], unfavourable: [0, 1], neutral: [0, 1] });
    assert.deepEqual(share("decision-model", "synthetic-model-b", "all", "attempts"), { favourable: [1, 2], unfavourable: [0, 2], neutral: [0, 2] });
    assert.deepEqual(share("llm-judge", "synthetic-model-a", "all", "results"), { favourable: [2, 3], unfavourable: [1, 3], neutral: [0, 3] });
    assert.deepEqual(share("llm-judge", "synthetic-model-b", "all", "attempts"), { favourable: [0, 3], unfavourable: [1, 3], neutral: [0, 3] });

    // Each case shows its mode and direction, and both are filters.
    const decided = view.cases.filter(({ mode }) => mode === "decision-model");
    assert.equal(decided.length, 9);
    assert.ok(decided.every(({ citations, assertion }) => citations.length === 0 && assertion!.judgment.basis === "probabilities"));
    assert.deepEqual(decided.filter(({ card }) => card === "VF-03").map(({ verdict, direction }) => [verdict, direction]), [["present", "favourable"], ["unknown", "none"], ["present", "unfavourable"], ["absent", "none"]]);
    const unfavourable = await queryAtlas(source, { mode: "decision-model", direction: "unfavourable" });
    assert.deepEqual(unfavourable.cases.map(({ attemptId, card }) => [attemptId, card]).sort(), [["synthetic-attempt-0", "TI-03"], ["synthetic-attempt-2", "VF-03"]]);
    assert.equal(unfavourable.report.sourcePopulation.selectedAttempts, 2);

    const html = renderAtlas(view, true);
    assert.match(html, /decision-model fixture\/fixture-decision-model/u);
    assert.match(html, /llm-judge fixture\/synthetic-judge/u);
    assert.match(html, /Direction/u);
    const panels = JSON.stringify(atlasDashboards(view));
    for (const column of ["mode", "producer", "direction"]) assert.match(panels, new RegExp(`"${column}"`, "u"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shareable Atlas requires source export readback and fails closed on unsupported report fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-atlas-share-"));
  try {
    const requestPath = await createAtlasFixture(root);
    const source = await loadAtlas(requestPath);
    const view = await queryAtlas(source, { task: "synthetic-validation-task", trial: "1", model: "synthetic-model-a" });
    const policy = { sharingClass: "public" as const, maxArtifactBytes: 16 * 1024 * 1024, maxStringBytes: 8192 };
    const nativeDisplay = sanitizeDerivedExport({ method: "item/reasoning/textDelta", payload: { delta: "synthetic-hidden-content" }, raw: JSON.stringify({ method: "item/reasoning/textDelta", params: { delta: "synthetic-hidden-content" } }) }, policy);
    assert.doesNotMatch(JSON.stringify(nativeDisplay), /synthetic-hidden-content/u, "derived displays reuse native reasoning omission before the final scan");
    assert.equal((nativeDisplay as { method: string }).method, "item/reasoning/textDelta");
    const approvedRoot = join(root, "approved");
    await createPortableRunBundleExport({ sourceRoot: source.input.assertions[0]!.bundleRoot, destinationRoot: approvedRoot, policy });
    source.request.sharing = { policy, approvedExports: [approvedRoot], fields: ["cohort", "aggregate-metrics", "source-digests"] };
    for (const filters of [{ review: "confirmed" }, { family: "VF" }, { card: "VF-03" }, { verdict: "absent" }, { q: "Synthetic" }]) {
      await assert.rejects(shareAtlas(source, await queryAtlas(source, filters)), /cannot use semantic, human-review, or free-text/u);
    }
    const shared = await shareAtlas(source, view);
    assert.equal(shared.mode, "public"); assert.equal(shared.cases.length, 0); assert.equal(shared.reviewPackets.length, 0);
    assert.equal(shared.matchingCases, null, "omitted case populations are unavailable, not an observed zero");
    assert.equal(shared.operatorNarrative, undefined);
    assert.equal(shared.secretScan, undefined, "secret-scan findings name native identifiers and stay local");
    const output = JSON.stringify(shared);
    assert.doesNotMatch(output, /window.fixtureXss|ghp_|SYNTHETIC_HIDDEN_REASONING|file:\/\/|\/Users\/|\/private\/|synthetic-fixture-reviewer/u);
    assert.equal(shared.report.groups.some(({ metrics }) => metrics.some(({ population }) => population === "assertion")), false);
    await assert.rejects(shareAtlas(source, await queryAtlas(source)), /Every selected source manifest/u);
    source.request.sharing.fields = [...source.request.sharing.fields, "native-records"];
    await assert.rejects(shareAtlas(source, view), /Unsupported report-field/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
