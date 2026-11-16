import assert from "node:assert/strict";
import test from "node:test";
import { selectRuntimeRelease, type RuntimeRelease } from "../src/runtime-resolution.js";

const now = "2026-11-07T12:00:00.000Z";
const release = (version: string, publishedAt = "2026-11-05T12:00:00Z", extra: Partial<RuntimeRelease> = {}): RuntimeRelease => ({
  version, publishedAt, source: "npm", locator: `https://registry.npmjs.org/example/-/example-${version}.tgz`,
  integrity: "sha512-Zml4dHVyZQ==", ...extra,
});
test("chooses the newest stable age-eligible release, independent of input order and dist-tags", () => {
  const result = selectRuntimeRelease([release("9.1.0"), release("10.0.0", "2026-11-07T00:00:01Z"), release("9.3.0-rc.1"), release("9.2.0", "2026-11-06T12:00:00Z")], { now });
  assert.equal(result.release.version, "9.2.0");
  assert.equal(result.policy.minReleaseAgeMs, 86_400_000);
  assert.equal(result.cutoff, "2026-11-06T12:00:00.000Z");
  assert.equal(result.excluded.length, 2);
});

test("uses PyPI release ordering for stable and opted-in release candidates", () => {
  const versions = [release("1.10", undefined, { source: "pypi" }), release("1.11rc2", undefined, { source: "pypi" }), release("1.9.post2", undefined, { source: "pypi" })];
  assert.equal(selectRuntimeRelease(versions, { now }).release.version, "1.10");
  assert.equal(selectRuntimeRelease(versions, { now, allowPrerelease: true }).release.version, "1.11rc2");
});
test("an exact reproduction override permits deprecation but never withdrawal or a too-new release", () => {
  const versions = [release("4.0.0", undefined, { deprecated: "use 5" }), release("5.0.0", undefined, { yanked: true }), release("6.0.0", "2026-11-07T11:00:00Z")];
  const exact = selectRuntimeRelease(versions, { now, override: "4.0.0" });
  assert.equal(exact.release.version, "4.0.0");
  assert.match(exact.warnings.join(), /DEPRECATED/);
  for (const override of ["5.0.0", "6.0.0", "latest"]) assert.throws(() => selectRuntimeRelease(versions, { now, override }), /RUNTIME_NO_ELIGIBLE_RELEASE/);
});

test("the runtime catalog covers the native harness registry, the judge, Harbor and Smol without version pins", async () => {
  const { listRuntimeRecipes } = await import("../src/runtime-catalog.js");
  const { listNativeV2Profiles } = await import("../src/native-v2.js");
  const recipes = listRuntimeRecipes({ platform: "darwin", architecture: "arm64" });
  assert.deepEqual(recipes.filter((recipe) => recipe.harness).map((recipe) => recipe.harness).sort(), listNativeV2Profiles().map((p) => p.harness).sort());
  for (const role of ["codex-judge", "harbor", "smol"]) assert.ok(recipes.some((recipe) => recipe.id === role));
  assert.ok(recipes.flatMap((r) => r.components).some((c) => c.source === "vendor"));
  assert.ok(recipes.flatMap((r) => r.components).some((c) => c.source === "oci"));
  assert.ok(recipes.flatMap((r) => r.components).every((c) => !("version" in c)));
});

test("a prerelease opt-in must be a boolean rather than a truthy configuration value", () => {
  assert.throws(() => selectRuntimeRelease([release("2.0.0-rc.1")], {now: "2026-11-07T12:00:00Z", allowPrerelease: "false" as any}), /RUNTIME_POLICY_INVALID/);
});
