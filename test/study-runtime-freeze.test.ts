import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeStudyRuntimes, prepareRuntimeLaunch } from "../src/study-runtimes.js";

test("a frozen study reuses exact runtime identities while prelaunch checks detect newly malicious components", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-study-runtime-"));
  let reads = 0, malware = false; const urls: string[] = [];
  const options = { now: () => "2026-11-07T12:00:00Z", query: async () => malware ? { vulns: [{ id: "MAL-2026-fixture" }] } : {},
    fetch: async (url: string) => { reads++; urls.push(url); return new Response(JSON.stringify({ time: { "9.9.9": "2026-11-05T00:00:00Z" }, versions: { "9.9.9": { dist: { tarball: "https://registry.npmjs.org/cursor.tgz", integrity: "sha512-Zml4dHVyZQ==" } } } })); },
    run: async (_cmd: string, args: readonly string[], cwd: string) => {
      if (args.includes("--package-lock-only")) await writeFile(join(cwd, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { "@cursor/sdk": "9.9.9" } }, "node_modules/@cursor/sdk": { version: "9.9.9", resolved: "https://registry.npmjs.org/cursor.tgz", integrity: "sha512-Zml4dHVyZQ==" } } }));
      if (args[0] === "ci") { await mkdir(join(cwd, "node_modules", "@cursor", "sdk"), { recursive: true }); await writeFile(join(cwd, "node_modules", "@cursor", "sdk", "package.json"), JSON.stringify({ name: "@cursor/sdk", version: "9.9.9" })); }
      return { code: 0, stdout: "{}", stderr: "" };
    } };
  try {
    const request = { studyId: "study-fixture", roles: ["cursor-sdk"] };
    const first = await freezeStudyRuntimes(root, request, options), before = reads;
    const second = await freezeStudyRuntimes(root, request, options);
    assert.equal(first.digest, second.digest);
    assert.equal(reads, before);
    const launch = await prepareRuntimeLaunch(root, "cursor-sdk", options);
    assert.equal(launch.lockDigest, first.digest);
    assert.ok(urls.some((url) => url.endsWith("%40cursor%2Fsdk/9.9.9")), "Launch checks the frozen npm version directly instead of fetching version history");
    assert.equal(launch.roots[0]!.selection.release.version, "9.9.9");
    malware = true;
    await assert.rejects(prepareRuntimeLaunch(root, "cursor-sdk", options), /RUNTIME_MALICIOUS/);
    const receipts = await Promise.all((await readdir(join(root, "runtimes", "launches"))).map(async (file) => JSON.parse(await readFile(join(root, "runtimes", "launches", file), "utf8"))));
    assert.ok(receipts.some((receipt) => receipt.status === "blocked" && receipt.security.components.some((component: any) => component.results.some((result: any) => result.id === "MAL-2026-fixture"))));
  } finally { await rm(root, { recursive: true, force: true }); }
});
