import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalizeMetadata } from "../src/artifacts.js";
import { loadAtlas } from "../src/atlas.js";
import { createRetainedBehaviorEvidence, withRetainedEvidenceReuse } from "../src/retained-evidence.js";
import { createAtlasFixture } from "./atlas-fixture.js";

test("scoped evidence reuse returns the validated evidence, rebuilds on changed bytes and ends with its scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-evidence-reuse-"));
  try {
    await createAtlasFixture(root);
    const bundle = join(root, "corpus/synthetic-attempt-0");
    const other = join(root, "corpus/synthetic-attempt-1");
    const projection = ({ dataset, coverage, capture }: Awaited<ReturnType<typeof createRetainedBehaviorEvidence>>) =>
      canonicalizeMetadata({ dataset, coverage, qualification: capture.qualification });

    // Outside a scope every call rebuilds: nothing is retained process-wide.
    const unscoped = await createRetainedBehaviorEvidence(bundle);
    assert.notStrictEqual(await createRetainedBehaviorEvidence(bundle), unscoped);

    const stats = { hits: 0, misses: 0 };
    await withRetainedEvidenceReuse(async () => {
      const first = await createRetainedBehaviorEvidence(bundle);
      assert.equal(projection(first), projection(unscoped));
      assert.strictEqual(await createRetainedBehaviorEvidence(bundle), first);
      assert.deepEqual(stats, { hits: 1, misses: 1 });

      // A scope run inside another shares the enclosing scope, so evidence validated outside is not rebuilt.
      const inner = { hits: 0, misses: 0 };
      await withRetainedEvidenceReuse(async () => {
        assert.strictEqual(await createRetainedBehaviorEvidence(bundle), first);
      }, inner);
      assert.deepEqual(inner, { hits: 0, misses: 0 });
      assert.deepEqual(stats, { hits: 2, misses: 1 });

      // One attempt at a time: another bundle replaces the retained evidence.
      await createRetainedBehaviorEvidence(other);
      const again = await createRetainedBehaviorEvidence(bundle);
      assert.notStrictEqual(again, first);
      assert.equal(projection(again), projection(first));
      assert.deepEqual(stats, { hits: 2, misses: 3 });

      // Changed native bytes are hashed on lookup, so the retained evidence is not returned.
      const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")) as { evidence: Array<{ relativePath: string }> };
      const artifact = manifest.evidence.find(({ relativePath }) => relativePath.endsWith(".jsonl"))!;
      appendFileSync(join(bundle, artifact.relativePath), "\n");
      await assert.rejects(createRetainedBehaviorEvidence(bundle));
      assert.equal(stats.hits, 2);
    }, stats);
    await assert.rejects(createRetainedBehaviorEvidence(bundle));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a same-size rewrite of a bound artifact is hashed again, so its evidence is not reused", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-evidence-reuse-rewrite-"));
  try {
    await createAtlasFixture(root);
    const bundle = join(root, "corpus/synthetic-attempt-0");
    const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")) as { evidence: Array<{ relativePath: string }> };
    const path = join(bundle, manifest.evidence.find(({ relativePath }) => relativePath.endsWith(".jsonl"))!.relativePath);
    const stats = { hits: 0, misses: 0 };
    await withRetainedEvidenceReuse(async () => {
      await createRetainedBehaviorEvidence(bundle);
      await createRetainedBehaviorEvidence(bundle);
      assert.deepEqual(stats, { hits: 1, misses: 1 });
      // Same length, one byte different: only the content digest can tell.
      const bytes = readFileSync(path), at = bytes.indexOf("\"");
      bytes[at + 1] = bytes[at + 1] === 0x61 ? 0x62 : 0x61;
      writeFileSync(path, bytes);
      await assert.rejects(createRetainedBehaviorEvidence(bundle));
      assert.equal(stats.hits, 1);
    }, stats);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a bundle whose listed bytes cannot be hashed is rebuilt and reports its own failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-evidence-reuse-missing-"));
  try {
    await createAtlasFixture(root);
    const bundle = join(root, "corpus/synthetic-attempt-0");
    const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8")) as { evidence: Array<{ relativePath: string }> };
    rmSync(join(bundle, manifest.evidence.find(({ relativePath }) => relativePath.endsWith(".jsonl"))!.relativePath));
    const unscoped = await createRetainedBehaviorEvidence(bundle).then(() => undefined, (error: Error) => error.message);
    assert.equal(typeof unscoped, "string");
    const stats = { hits: 0, misses: 0 };
    await withRetainedEvidenceReuse(async () => {
      for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(createRetainedBehaviorEvidence(bundle), { message: unscoped });
    }, stats);
    assert.deepEqual(stats, { hits: 0, misses: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an attempt's further assertions reuse its evidence while an Atlas source loads, with the same result", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-evidence-reuse-atlas-"));
  try {
    const atlasRequest = await createAtlasFixture(root);
    // A second assertion on the first attempt, adjacent to the first in the aggregation request.
    const second = JSON.parse(readFileSync(join(root, "assertion-0.json"), "utf8")) as { id: string };
    second.id = "synthetic-assertion-0-second";
    writeFileSync(join(root, "assertion-0-second.json"), JSON.stringify(second));
    const aggregationPath = join(root, "aggregation.json");
    const aggregation = JSON.parse(readFileSync(aggregationPath, "utf8")) as { sources: { assertions: Array<{ bundleRoot: string; path: string }> } };
    aggregation.sources.assertions.splice(1, 0, { bundleRoot: aggregation.sources.assertions[0]!.bundleRoot, path: join(root, "assertion-0-second.json") });
    writeFileSync(aggregationPath, JSON.stringify(aggregation));

    const unscoped = await loadAtlas(atlasRequest);
    const stats = { hits: 0, misses: 0 };
    const scoped = await withRetainedEvidenceReuse(() => loadAtlas(atlasRequest), stats);
    // An attempt is built at most once in each pass that reads it: the aggregation's checks of its observation set and
    // assertions, the revalidation of a review sample that includes it, and the building of its cases.
    const attempts = new Set((JSON.parse(readFileSync(aggregationPath, "utf8")) as { sources: { assertions: Array<{ bundleRoot: string }>; observationSets: Array<{ bundleRoot: string }> } })
      .sources.observationSets.map(({ bundleRoot }) => bundleRoot)).size;
    assert.ok(stats.misses <= 3 * (attempts + 1), JSON.stringify({ stats, attempts }));
    assert.ok(stats.hits >= 2, JSON.stringify(stats));
    assert.equal(canonicalizeMetadata({ cases: scoped.cases, sourceDigest: scoped.sourceDigest }),
      canonicalizeMetadata({ cases: unscoped.cases, sourceDigest: unscoped.sourceDigest }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
