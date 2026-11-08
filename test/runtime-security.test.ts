import assert from "node:assert/strict";
import test from "node:test";
import { checkRuntimeSecurity } from "../src/runtime-security.js";

const components = [{ id: "sdk", name: "@example/sdk", ecosystem: "npm", version: "9.9.9" },
  { id: "harbor", name: "harbor", ecosystem: "PyPI", version: "0.25.0" }];
test("records OSV results and query time for every component, including paginated advisories", async () => {
  const calls: unknown[] = [];
  const receipt = await checkRuntimeSecurity(components, { now: () => "2026-11-07T12:00:00Z", query: async (body) => {
    calls.push(body); return "name" in body.package && body.package.name === "harbor" ? { vulns: [{ id: "GHSA-fixture", summary: "warning" }] } : {};
  } });
  assert.equal(calls.length, 2);
  assert.equal(receipt.components.length, 2);
  assert.equal(receipt.components[0]!.queriedAt, "2026-11-07T12:00:00Z");
  assert.match(receipt.warnings.join(), /GHSA-fixture/);
});
test("blocks a MAL entry discovered before launch even when resolution was clean", async () => {
  await checkRuntimeSecurity(components, { query: async () => ({}) });
  await assert.rejects(checkRuntimeSecurity(components, { query: async () => ({ vulns: [{ id: "MAL-2026-fixture" }] }) }), /RUNTIME_MALICIOUS.*MAL-2026-fixture/);
});

test("a blocked malicious-package decision retains the complete timed query receipt", async () => {
  try {
    await checkRuntimeSecurity(components, { now: () => "2026-11-07T12:00:00Z", query: async () => ({ vulns: [{ id: "MAL-2026-fixture", withdrawn: "2026-11-06T00:00:00Z" }] }) });
    assert.fail("MAL entries must block");
  } catch (error) {
    assert.match(String(error), /RUNTIME_MALICIOUS/);
    assert.equal((error as { receipt?: { components: unknown[] } }).receipt?.components.length, 2);
  }
});

test("batches the full component population and retains paginated follow-up results", async () => {
  const batches: unknown[] = [];
  const receipt = await checkRuntimeSecurity(components, { queryBatch: async (queries) => {
    batches.push(queries); return [{ vulns: [{ id: "GHSA-page-1" }], next_page_token: "next" }, {}];
  }, query: async (query) => { assert.equal(query.page_token, "next"); return { vulns: [{ id: "GHSA-page-2" }] }; } });
  assert.equal(batches.length, 1);
  assert.equal((batches[0] as unknown[]).length, components.length);
  assert.deepEqual(receipt.components[0]!.results.map((result) => result.id), ["GHSA-page-1", "GHSA-page-2"]);
});
