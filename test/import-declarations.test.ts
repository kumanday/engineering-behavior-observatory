import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
    await buildAtlasBundle(join(root, "bundle.json"), join(root, "bundle"), { embed: async (texts: readonly string[], config: { dimensions: number }) => new Float32Array(texts.length * config.dimensions).fill(1) });
    const lanes = JSON.parse(readFileSync(join(root, "bundle", "lanes.json"), "utf8")) as { attempts: Array<{ condition: string; task_id: string | null }> };
    assert.deepEqual([...new Set(lanes.attempts.map(({ condition }) => condition))], ["Imported · Example-Model · acme-agent"], "one arm for one model, whatever the route");
    assert.ok(lanes.attempts.every(({ task_id }) => task_id === "example-task"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
