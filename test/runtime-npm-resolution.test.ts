import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveNpmRuntimePlan } from "../src/runtime-npm.js";

test("freezes transitive package integrity and checks the age and security identity of the entire closure", async () => {
  const seen: string[][] = [];
  const result = await resolveNpmRuntimePlan([{ id: "sdk", source: "npm", name: "example", ecosystem: "npm", selection: {
    release: { version: "9.9.9", publishedAt: "2026-11-05T00:00:00Z", source: "npm", locator: "https://registry.npmjs.org/example.tgz", integrity: "sha512-Zml4dHVyZQ==" },
    selectedAt: "2026-11-07T12:00:00Z", cutoff: "2026-11-06T12:00:00Z", policy: { minReleaseAgeMs: 86_400_000, allowPrerelease: false, override: null }, excluded: [], warnings: [] } }], {
    platform: "darwin-arm64", abi: "node-24", run: async (_cmd, args, cwd) => {
      seen.push([...args]); await writeFile(join(cwd, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { example: "9.9.9" } },
        "node_modules/example": { version: "9.9.9", resolved: "https://registry.npmjs.org/example.tgz", integrity: "sha512-Zml4dHVyZQ==" },
        "node_modules/dependency": { version: "2.0.0", resolved: "https://registry.npmjs.org/dependency.tgz", integrity: "sha512-Zml4dHVyZQ==" } } }));
      return { code: 0, stdout: "", stderr: "" };
    }, fetch: async (url) => new Response(JSON.stringify({ time: { "9.9.9": "2026-11-05T00:00:00Z", "2.0.0": "2026-11-05T00:00:00Z" }, versions: {
      [url.endsWith("example") ? "9.9.9" : "2.0.0"]: { dist: { tarball: url + ".tgz", integrity: "sha512-Zml4dHVyZQ==" } } } })),
  });
  assert.equal(result.components.length, 2);
  assert.ok(result.components.some((c) => c.name === "dependency" && c.version === "2.0.0"));
  assert.ok(seen[0]!.includes("--ignore-scripts"));
  assert.ok(seen[0]!.some((arg) => arg.startsWith("--before=")));
  assert.equal(result.plan.packageLock.lockfileVersion, 3);
});
