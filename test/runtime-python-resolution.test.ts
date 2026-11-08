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

test("PyPI attestation identity follows source metadata rather than a GitHub funding link", async () => {
  const {roots, options, sha} = fixture(), originalRun = options.run, originalFetch = options.fetch;
  const name = "attrs", version = "26.2.0", filename = `attrs-${version}-py3-none-any.whl`, url = `https://files.pythonhosted.org/${filename}`;
  options.run = async (command, args) => {
    const result = await originalRun(command, args);
    if (args.includes("--report")) {
      const {readFile} = await import("node:fs/promises"); const path = args[args.indexOf("--report") + 1]!, report = JSON.parse(await readFile(path, "utf8"));
      report.install.push({metadata: {name, version}, download_info: {url, archive_info: {hashes: {sha256: sha}}}}); await writeFile(path, JSON.stringify(report));
    }
    return result;
  };
  options.fetch = async (request) => {
    if (!request.includes("/attrs/")) return originalFetch(request);
    if (request.includes("/simple/")) return Response.json({files: [{filename, provenance: "https://pypi.org/integrity/attrs/provenance"}]});
    if (request.includes(`/${version}/json`)) return Response.json({info: {project_urls: {Funding: "https://github.com/sponsors/hynek", GitHub: "https://github.com/python-attrs/attrs"}}});
    return Response.json({releases: {[version]: [{filename, url, digests: {sha256: sha}, upload_time_iso_8601: "2026-11-05T00:00:00Z", yanked: false}]}});
  };
  const result = await resolvePythonRuntimePlan(roots, options);
  assert.equal(result.plan.artifacts.find((artifact) => artifact.filename === filename)?.attestation?.repository, "https://github.com/python-attrs/attrs");
});
