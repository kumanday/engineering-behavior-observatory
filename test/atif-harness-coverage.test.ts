import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { coverage, coverageDirectory, coverageResults, renderCoverageMatrix } from "./atif-harness-coverage-helper.js";
import { inspectAtifBytes } from "../src/atif-reader.js";
import { projectAtifCore } from "../src/atif-core.js";

test("the eight-harness matrix is generated from native adapter membership and real core import results", async () => {
  const rows = await coverageResults();
  assert.equal(rows.length, 8);
  for (const { row, evidence, calls, results } of rows) {
    assert.ok(calls > 0 && results > 0, row.harness);
    assert.ok(evidence.dataset.events.some(({ facts }) => facts.message), row.harness);
    assert.ok(evidence.dataset.sources.every(({ producerProfile }) => producerProfile.status === "unknown"));
    assert.ok(evidence.dataset.measurements.every(({ scope }) => scope.kind === "recorded-document"));
    assert.ok(row.fixtureKind.length && row.surface.length && row.equivalence.length && row.overlay.length);
  }
  assert.equal(readFileSync(new URL("../../docs/reference/atif-harness-coverage.md", import.meta.url), "utf8"), await renderCoverageMatrix());
});
test("the researched upstream inventory distinguishes missing converters and different source surfaces", () => {
  assert.equal(coverage.upstream.version, "0.25.0");
  assert.deepEqual([...coverage.upstream.converterModules].sort(), ["claude_code", "codex", "cursor_cli", "devin", "openhands", "pi"]);
  const receipts = JSON.parse(readFileSync(new URL("generation-receipts.json", coverageDirectory), "utf8")).fixtures as Array<{ harness: string; trajectorySha256: string; captureSessionSha256?: string }>;
  for (const row of coverage.rows) {
    const receipt = receipts.find(({ harness }) => harness === row.harness)!;
    assert.equal(createHash("sha256").update(readFileSync(new URL(row.fixture, coverageDirectory))).digest("hex"), receipt.trajectorySha256);
    if (["factory-droid", "deepseek-harness"].includes(row.harness)) {
      assert.equal(row.upstream, null); assert.ok(row.captureSessionSha256); assert.equal(receipt.captureSessionSha256, row.captureSessionSha256);
      assert.ok(row.privateFixture && row.privateFixtureSha256);
    }
  }
  assert.match(coverage.rows.find(({ harness }) => harness === "claude-agent-sdk")!.surface, /Claude Code.*Agent SDK/u);
  assert.match(coverage.rows.find(({ harness }) => harness === "cursor-sdk")!.surface, /Cursor CLI.*Cursor SDK/u);
});
test("retained conversions and capture-derived authored selections pass core with their frozen digests", { skip: !process.env.EBO_ATIF_PRIVATE_FIXTURES }, async () => {
  const root = process.env.EBO_ATIF_PRIVATE_FIXTURES!;
  for (const row of coverage.rows.filter(({ privateFixture }) => privateFixture)) {
    const bytes = readFileSync(`${root}/${row.privateFixture}`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), row.privateFixtureSha256);
    const evidence = (await projectAtifCore({ read: inspectAtifBytes(bytes), runId: "private-coverage", attemptId: row.harness, manifestDigest: `sha256:${"0".repeat(64)}` })).v2;
    assert.ok(evidence.dataset.operations.some(({ callEventIds, resultEventIds }) => callEventIds.length && resultEventIds.length), row.harness);
    assert.ok(evidence.dataset.events.some(({ facts }) => facts.message), row.harness);
  }
});


test("upstream test inventory uses exact converter families, including Pi rather than Copilot CLI", () => {
  const inventory = JSON.parse(readFileSync(new URL("upstream-inventory.json", coverageDirectory), "utf8"));
  assert.equal(inventory.treeSha, "fdba28fc411e47e8765420a1a063b4918fce3def");
  const families: Record<string, RegExp> = { claude: /test_claude_code_/u, codex: /test_codex_/u, cursor: /test_cursor_cli_/u,
    devin: /test_devin\.py$/u, openhands: /test_openhands_/u, pi: /test_pi\.py$/u };
  for (const [family, paths] of Object.entries(inventory.fixtures) as Array<[string, string[]]>) {
    assert.ok(paths.length > 0);assert.ok(paths.every((path) => families[family]!.test(path)));
  }
  assert.equal(inventory.fixtures.pi.some((path: string) => path.includes("copilot")), false);
});
