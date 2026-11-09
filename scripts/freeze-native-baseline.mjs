/** Freeze/check existing native fixture readability. Output can contain private source paths. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const implementationRoot = process.env.EBO_BASELINE_ROOT ?? resolve(import.meta.dirname, "..");
const load = (name) => import(pathToFileURL(join(implementationRoot, "dist/src", name)).href);
const { createRetainedBehaviorEvidence } = await load("retained-evidence.js");
const { createStructuralObservationSet } = await load("structural-observations.js");
const { digestMetadata } = await load("artifacts.js");

const [pathsFile, outputFile, expectedFile] = process.argv.slice(2);
if (!pathsFile || !outputFile) throw new Error("Usage: node scripts/freeze-native-baseline.mjs <bundle-roots.json> <output.json> [expected.json]");
const roots = [...new Set(JSON.parse(readFileSync(pathsFile, "utf8")).map((root) => resolve(root)))].sort();
const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const results = Array(roots.length);
let next = 0, completed = 0;
async function worker() {
  while (next < roots.length) {
    const index = next++, root = roots[index];
    const row = { root };
    try {
      Object.assign(row, { manifestSha256: hashFile(join(root, "manifest.json")), sessionSha256: hashFile(join(root, "pi-session.jsonl")) });
      const evidence = await createRetainedBehaviorEvidence(root);
      const observations = createStructuralObservationSet(evidence.dataset, evidence.coverage, evidence.outcomeCapture);
      const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
      Object.assign(row, { status: "accepted", runId: evidence.dataset.runId, attemptId: evidence.dataset.attemptId,
        harness: manifest.run.harness, datasetDigest: `sha256:${digestMetadata(evidence.dataset).value}`,
        observationDigest: `sha256:${digestMetadata(observations).value}`,
        measures: Object.fromEntries(observations.observations.map((observation) => [observation.extractor.id, observation.value])) });
    } catch (error) {
      Object.assign(row, { status: "rejected", reason: String(error.message) });
    }
    results[index] = row;
    completed += 1;
    if (completed % 10 === 0 || completed === roots.length) process.stderr.write(`Native baseline ${completed}/${roots.length}\n`);
  }
}
await Promise.all(Array.from({ length: 3 }, worker));
const baseline = { schemaVersion: "ebo.native-fixture-baseline/v1", implementationRoot, nodeVersion: process.versions.node, results,
  counts: { total: results.length, accepted: results.filter((row) => row.status === "accepted").length,
    rejected: results.filter((row) => row.status === "rejected").length } };
if (expectedFile) {
  const expected = JSON.parse(readFileSync(expectedFile, "utf8"));
  const actualByRoot = new Map(results.map((row) => [row.root, row]));
  const failures = expected.results.flatMap((row) => {
    const actual = actualByRoot.get(row.root);
    if (!actual) return [{ root: row.root, reason: "BASELINE_BUNDLE_MISSING" }];
    if (actual.manifestSha256 !== row.manifestSha256 || actual.sessionSha256 !== row.sessionSha256) return [{ root: row.root, reason: "BASELINE_SOURCE_MUTATED" }];
    if (actual.status !== row.status) return [{ root: row.root, reason: row.status === "accepted" ? "BASE_LOADABLE_BUNDLE_REJECTED" : "BASE_REJECTED_BUNDLE_ADMITTED" }];
    if (process.env.EBO_BASELINE_REQUIRE_DATASET_DIGESTS === "1" && actual.datasetDigest !== row.datasetDigest) return [{ root: row.root, reason: "BASELINE_DATASET_CHANGED" }];
    return [];
  });
  baseline.compatibility = { status: failures.length ? "failed" : "passed", failures };
  if (failures.length) process.exitCode = 1;
}
mkdirSync(dirname(resolve(outputFile)), { recursive: true });
writeFileSync(outputFile, JSON.stringify(baseline, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ ...baseline.counts, compatibility: baseline.compatibility?.status }));
