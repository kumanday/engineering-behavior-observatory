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
