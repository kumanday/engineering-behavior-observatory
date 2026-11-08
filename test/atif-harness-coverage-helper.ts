import { readFileSync } from "node:fs";
import { listNativeV2Profiles } from "../src/native-v2.js";
import { inspectAtifBytes } from "../src/atif-reader.js";
import { projectAtifCore } from "../src/atif-core.js";
export type CoverageRow = { harness: string; name: string; guide: string; upstream: string | null; fixture: string; fixtureKind: string;
  privateFixture: string | null; privateFixtureSha256?: string; captureManifestSha256?: string; captureSessionSha256?: string;
  surface: string; equivalence: string; overlay: string };
export const coverageDirectory = new URL("../../test/fixtures/atif/harnesses/", import.meta.url);
export const coverage = JSON.parse(readFileSync(new URL("coverage.json", coverageDirectory), "utf8")) as {
  upstream: { version: string; source: string; wheelSha256: string; converterModules: string[] }; rows: CoverageRow[] };
export async function coverageResults() {
  const profiles = listNativeV2Profiles();
  if (coverage.rows.length !== profiles.length || new Set(coverage.rows.map(({ harness }) => harness)).size !== profiles.length
    || profiles.some(({ harness }) => !coverage.rows.some((row) => row.harness === harness))) throw new Error("ATIF matrix membership differs from the native adapter registry.");
  const results = [];
  for (const profile of profiles) {
    const row = coverage.rows.find(({ harness }) => harness === profile.harness)!;
    const source = readFileSync(new URL(row.fixture, coverageDirectory));
    const evidence = (await projectAtifCore({ read: inspectAtifBytes(source), runId: "coverage", attemptId: row.harness, manifestDigest: `sha256:${"0".repeat(64)}` })).v2;
    results.push({ profile, row, evidence, calls: evidence.dataset.operations.reduce((sum, operation) => sum + operation.callEventIds.length, 0),
      results: evidence.dataset.operations.reduce((sum, operation) => sum + operation.resultEventIds.length, 0) });
  }
  return results;
}
export async function renderCoverageMatrix(): Promise<string> {
  const rows = await coverageResults();
  return `# ATIF coverage across EBO harnesses

EBO maintains the eight native harnesses in this table. Every conforming ATIF document uses the same core reader, including documents from other producers. An upstream converter is a separate tool that writes ATIF; its availability does not determine whether EBO can read a document.

The native adapter column identifies EBO’s v2 adapter. The core result is measured on the checked-in public fixture with overlays disabled. Public fixtures use fictional content and are available in the source repository. Private retained conversions and capture-derived selections have source paths and digests in the pilot receipts; their digests bind the checked-in coverage record.

The inspected Harbor release is [${coverage.upstream.version}](${coverage.upstream.source}), wheel SHA-256 \`${coverage.upstream.wheelSha256}\`. Its installed-agent sources contain the six converter modules listed below. No Factory Droid or DeepSeek Harness converter was found in that release.

| Harness and native v2 adapter | Upstream ATIF producer | Fixture and core result | Overlay and measured limits | Same-run evidence |
| --- | --- | --- | --- | --- |
${rows.map(({ profile, row, calls, results }) => `| [${row.name}](../harnesses/${row.guide}) · \`${profile.id}\` | ${row.upstream ?? "No upstream converter found."} ${row.surface} | [${row.fixture}](https://github.com/kumanday/engineering-behavior-observatory/blob/develop/test/fixtures/atif/harnesses/${row.fixture}): ${calls} ${calls === 1 ? "call" : "calls"}, ${results} linked ${results === 1 ? "result" : "results"}; messages readable. ${row.fixtureKind} | ${row.overlay} | ${row.equivalence} |`).join("\n")}

All imported measurements describe recorded documents. They do not establish complete attempts, successful execution, native request coverage or equivalent harness behavior. Optional overlays interpret verified producer extensions and record their reasons; core counts and retained source content remain available outside an overlay’s verified version range.

[Limitation codes](atif-limitations.md) define the confidence and availability labels. [ATIF interpretation](../development/atif-producer-profiles.md) explains core projection and optional overlays.

The matrix test reads membership from the native adapter registry, imports every fixture through core, and compares this document byte for byte. Update it after building with \`node dist/test/atif-harness-coverage-write.js\`; run \`node --test dist/test/atif-harness-coverage.test.js\` to check it.
`;
}
