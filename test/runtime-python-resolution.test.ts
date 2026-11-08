import assert from "node:assert/strict";
import test from "node:test";
import {writeFile} from "node:fs/promises";
import {resolvePythonRuntimePlan} from "../src/runtime-python.js";

const fixture = () => {
  const sha = "a".repeat(64), version = "0.25.0", filename = "harbor-0.25.0-py3-none-any.whl", url = `https://files.pythonhosted.org/${filename}`;
  const selection = {release: {version, source: "pypi" as const, publishedAt: "2026-11-05T00:00:00Z", locator: url, integrity: `sha256-${Buffer.from(sha, "hex").toString("base64")}`},
    selectedAt: "2026-11-07T12:00:00Z", cutoff: "2026-11-06T12:00:00Z", policy: {minReleaseAgeMs: 86400000, allowPrerelease: false, override: null}, excluded: [], warnings: []};
  const bootstrap = {schemaVersion: "ebo.python-bootstrap/v1", executable: "/python", version: "3.13.1", abi: "cpython-313-fixture", platform: "darwin", architecture: "arm64", binaryIntegrity: `sha256-${Buffer.alloc(32).toString("base64")}`};
  return {sha, version, bootstrap, roots: [{id: "harbor", name: "harbor", source: "pypi" as const, ecosystem: "PyPI", repository: "harbor-framework/harbor", selection}], options: {
    python: "/python", platform: "darwin-arm64", abi: bootstrap.abi, run: async (_cmd: string, args: readonly string[]) => {
      if (args.includes("-c")) return {code: 0, stdout: JSON.stringify(bootstrap), stderr: ""};
      if (args.includes("--report")) await writeFile(args[args.indexOf("--report") + 1]!, JSON.stringify({install: [{metadata: {name: "harbor", version}, download_info: {url, archive_info: {hashes: {sha256: sha}}}}]}));
      return {code: 0, stdout: "", stderr: ""};
    }, fetch: async (request: string) => new Response(JSON.stringify(request.includes("/simple/") ? {files: [{filename}]} : {releases: {[version]: [{filename, url, digests: {sha256: sha}, upload_time_iso_8601: "2026-11-05T00:00:00Z", yanked: false}]}})),
  }};
};

test("freezes the complete wheel report with exact hashes, upload times and actual interpreter identity", async () => {
  const {roots, options, sha, bootstrap} = fixture();
  const result = await resolvePythonRuntimePlan(roots, options);
  assert.deepEqual(result.plan.requirements, [`harbor==0.25.0 --hash=sha256:${sha}`]);
  assert.equal(result.components[0]!.selection.release.publishedAt, "2026-11-05T00:00:00Z");
  assert.deepEqual(Reflect.get(result.plan, "bootstrap"), bootstrap);
});

test("rejects a Python plan whose declared target differs from its actual interpreter", async () => {
  const {roots, options} = fixture();
  await assert.rejects(resolvePythonRuntimePlan(roots, {...options, platform: "linux-x64"}), /RUNTIME_PLATFORM_MISMATCH/);
});
