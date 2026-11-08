import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runRuntimeCommand } from "../src/runtime-installation.js";
import { resolveNpmRuntimePlan } from "../src/runtime-npm.js";
import {selectRuntimeRelease} from "../src/runtime-resolution.js";

test("npm aliases keep their real package and OSV identity while stable native build variants retain exact integrity", async () => {
  const name = "@example/runtime", variant = "9.9.9-darwin-arm64", requested: string[] = [];
  const releases = ["9.9.9", variant].map(version => ({version, source: "npm" as const, publishedAt: "2026-11-05T00:00:00Z", locator: `https://registry.npmjs.org/runtime-${version}.tgz`, integrity: "sha512-Zml4dHVyZQ=="}));
  const result = await resolveNpmRuntimePlan([{id: "runtime", name, source: "npm", ecosystem: "npm", selection: selectRuntimeRelease(releases, {now: "2026-11-07T12:00:00Z"})}], {
    platform: "darwin-arm64", abi: "node-24", run: async (_cmd, _args, cwd) => {
      await writeFile(join(cwd, "package-lock.json"), JSON.stringify({lockfileVersion: 3, packages: {"": {dependencies: {[name]: "9.9.9"}},
        [`node_modules/${name}`]: {version: "9.9.9", resolved: releases[0]!.locator, integrity: releases[0]!.integrity},
        "node_modules/@example/runtime-darwin-arm64": {name, version: variant, os: ["darwin"], cpu: ["arm64"], optional: true, resolved: releases[1]!.locator, integrity: releases[1]!.integrity}}}));
      return {code: 0, stdout: "", stderr: ""};
    }, fetch: async url => {
      requested.push(decodeURIComponent(url));
      assert.equal(decodeURIComponent(new URL(url).pathname).slice(1), name);
      return Response.json({time: Object.fromEntries(releases.map(release => [release.version, release.publishedAt])), versions: Object.fromEntries(releases.map(release => [release.version, {dist: {tarball: release.locator, integrity: release.integrity}}]))});
    },
  });
  assert.equal(requested.length, 1);
  assert.ok(result.components.every(component => component.name === name && component.ecosystem === "npm"));
  const binary = result.components.find(component => component.version === variant)!;
  assert.equal(binary.location, "node_modules/@example/runtime-darwin-arm64");
  assert.equal(binary.selection.release.integrity, releases[1]!.integrity);
  assert.equal(result.components.find(component => component.version === "9.9.9")!.selection.policy.allowPrerelease, false);
});

test("freezes transitive package integrity and checks the age and security identity of the entire closure", async () => {
  const seen: string[][] = [];
  const result = await resolveNpmRuntimePlan([{ id: "sdk", source: "npm", name: "example", ecosystem: "npm", selection: {
    release: { version: "9.9.9", publishedAt: "2026-11-05T00:00:00Z", source: "npm", locator: "https://registry.npmjs.org/example.tgz", integrity: "sha512-Zml4dHVyZQ==" },
    selectedAt: "2026-11-07T12:00:00Z", cutoff: "2026-11-06T12:00:00Z", policy: { minReleaseAgeMs: 86_400_000, allowPrerelease: false, override: null }, excluded: [], warnings: [] } }], {
    platform: "darwin-arm64", abi: "node-24", run: async (_cmd, args, cwd) => {
      const configuration = await runRuntimeCommand(_cmd, ["config", "get", "registry", ...args.filter((arg) => /^--(?:userconfig|globalconfig|registry)=/u.test(arg))], cwd);
      assert.equal(configuration.code, 0, configuration.stderr);
      assert.equal(new URL(configuration.stdout.trim()).href, "https://registry.npmjs.org/");
      seen.push([...args]); await writeFile(join(cwd, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { example: "9.9.9" } },
        "node_modules/example": { version: "9.9.9", resolved: "https://registry.npmjs.org/example.tgz", integrity: "sha512-Zml4dHVyZQ==" },
        "node_modules/dependency": { version: "2.0.0", resolved: "https://registry.npmjs.org/dependency.tgz", integrity: "sha512-Zml4dHVyZQ==" } } }));
      return { code: 0, stdout: "", stderr: "" };
    }, fetch: async (url) => new Response(JSON.stringify({ time: { "9.9.9": "2026-11-05T00:00:00Z", "2.0.0": "2026-11-05T00:00:00Z" }, versions: {
      [url.endsWith("example") ? "9.9.9" : "2.0.0"]: { ...(url.endsWith("dependency") ? { deprecated: "Use the platform API" } : {}), dist: { tarball: url + ".tgz", integrity: "sha512-Zml4dHVyZQ==" } } } })),
  });
  assert.equal(result.components.length, 2);
  assert.ok(result.components.some((c) => c.name === "dependency" && c.version === "2.0.0"));
  assert.ok(seen[0]!.includes("--ignore-scripts"));
  assert.ok(seen[0]!.some((arg) => arg.startsWith("--before=")));
  assert.equal(result.plan.packageLock.lockfileVersion, 3);
  assert.match(result.components.find((c) => c.name === "dependency")!.selection.warnings.join(), /RUNTIME_DEPENDENCY_DEPRECATED.*dependency@2.0.0/);
});

test("each selected root keeps its own release-age policy when roots share an npm graph", async () => {
  const { selectRuntimeRelease } = await import("../src/runtime-resolution.js");
  const { fakeSdkRuntimeOptions } = await import("./runtime-fixture-helper.js");
  const network = fakeSdkRuntimeOptions({older: "1.0.0", recent: "2.0.0"});
  const fetch = async (url: string) => {
    const payload = await (await network.fetch(url)).json() as any;
    if (url.endsWith("recent")) payload.time["2.0.0"] = "2026-11-07T11:00:00Z";
    return new Response(JSON.stringify(payload));
  };
  const roots = ["older", "recent"].map((name) => {
    const version = name === "older" ? "1.0.0" : "2.0.0";
    return {id: name, name, source: "npm" as const, ecosystem: "npm", selection: selectRuntimeRelease([{version, source: "npm", publishedAt: name === "older" ? "2026-11-05T00:00:00Z" : "2026-11-07T11:00:00Z", locator: `https://registry.npmjs.org/${name}.tgz`, integrity: "sha512-Zml4dHVyZQ=="}], {now: "2026-11-07T12:00:00Z", minReleaseAgeMs: name === "older" ? 86400000 : 0})};
  });
  const result = await resolveNpmRuntimePlan(roots, {platform: `${process.platform}-${process.arch}`, abi: "fixture", run: network.run, fetch});
  assert.equal(result.components.find((component) => component.name === "recent")!.selection.policy.minReleaseAgeMs, 0);
});

test("OS and CPU metadata cannot opt a stable runtime into a release candidate dependency", async () => {
  const name = "@example/runtime", version = "9.9.9", candidate = `${version}-rc.1`, integrity = "sha512-Zml4dHVyZQ==";
  const releases = [version, candidate].map(version => ({version, source: "npm" as const, publishedAt: "2026-11-05T00:00:00Z", locator: `https://registry.npmjs.org/${version}.tgz`, integrity}));
  await assert.rejects(resolveNpmRuntimePlan([{id: "runtime", name, source: "npm", selection: selectRuntimeRelease(releases, {now: "2026-11-07T12:00:00Z"})}], {
    platform: "darwin-arm64", abi: "node-24", run: async (_cmd, _args, cwd) => {
      await writeFile(join(cwd, "package-lock.json"), JSON.stringify({lockfileVersion: 3, packages: {"": {dependencies: {[name]: version}},
        [`node_modules/${name}`]: {version, resolved: releases[0]!.locator, integrity},
        "node_modules/@example/runtime-candidate": {name, version: candidate, os: ["darwin"], cpu: ["arm64"], resolved: releases[1]!.locator, integrity}}}));
      return {code: 0, stdout: "", stderr: ""};
    }, fetch: async () => Response.json({time: Object.fromEntries(releases.map(release => [release.version, release.publishedAt])), versions: Object.fromEntries(releases.map(release => [release.version, {dist: {tarball: release.locator, integrity}}]))}),
  }), /RUNTIME_NO_ELIGIBLE_RELEASE.*prerelease/);
});
