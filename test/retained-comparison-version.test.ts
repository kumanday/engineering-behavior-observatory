import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assessComparisonEligibility, type ComparisonRequest } from "../src/normalization-integrity.js";
test("mixed retained harness versions are labelled while exact replication still retains version data", () => {
  const request = JSON.parse(readFileSync("test/fixtures/comparison/exact.json", "utf8")) as ComparisonRequest;
  request.right.harness.version = "9000.1.0";
  const report = assessComparisonEligibility(request);
  assert.equal(report.status, "qualified-with-caveats");
  assert.ok(report.reasons.some(({ dimension }) => dimension === "harness version"));
  assert.notEqual(request.left.harness.version, request.right.harness.version);
});
