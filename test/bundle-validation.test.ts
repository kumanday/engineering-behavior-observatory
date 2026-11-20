import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { readAggregationAssertions, type AggregationRequest } from "../src/aggregation.js";
import { validateBundles, validationWorkers, type BundleValidationJob } from "../src/bundle-validation.js";
import type { StructuralObservationSet } from "../src/structural-observations.js";
import { createAtlasFixture } from "./atlas-fixture.js";

test("bundles validate in worker processes with the result and first error a serial pass gives", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-bundle-validation-"));
  try {
    const atlasRequest = await createAtlasFixture(root);
    const aggregationPath = resolve(dirname(atlasRequest), (JSON.parse(readFileSync(atlasRequest, "utf8")) as { aggregationRequest: string }).aggregationRequest);
    const aggregation = JSON.parse(readFileSync(aggregationPath, "utf8")) as AggregationRequest, base = dirname(aggregationPath);
    const jobs = new Map<string, BundleValidationJob>();
    const job = (bundleRoot: string) => jobs.get(resolve(base, bundleRoot)) ?? jobs.set(resolve(base, bundleRoot), { bundleRoot: resolve(base, bundleRoot), observationSets: [], assertions: [] }).get(resolve(base, bundleRoot))!;
    for (const { bundleRoot, path } of aggregation.sources.observationSets) job(bundleRoot).observationSets.push(JSON.parse(readFileSync(resolve(base, path), "utf8")) as StructuralObservationSet);
    for (const { bundleRoot, document } of readAggregationAssertions(base, aggregation.sources)) job(resolve(base, bundleRoot)).assertions.push(document);
    const all = [...jobs.values()];
    assert.ok(all.length >= 3);
    await validateBundles(all, 2, 1);
    // Two stale sets: the reported one is the first in input order, whichever worker finishes first.
    const stale = all.map((item, index) => index === 1 || index === all.length - 1
      ? { ...item, observationSets: item.observationSets.map((set) => ({ ...set, observations: [] })) } : item);
    const serial = await validateBundles(stale, 1).then(() => "", (error: Error) => error.message);
    assert.match(serial, /is stale/u);
    assert.equal(await validateBundles(stale, 3, 1).then(() => "", (error: Error) => error.message), serial);
    assert.equal(validationWorkers({ EBO_WORKERS: "3" }), 3);
    assert.ok(validationWorkers({}) >= 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
