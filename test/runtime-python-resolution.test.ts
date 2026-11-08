import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { resolvePythonRuntimePlan } from "../src/runtime-python.js";

test("freezes the complete wheel report with exact hashes and artifact upload times", async () => {
  const sha = "a".repeat(64), version = "0.25.0", filename = "harbor-0.25.0-py3-none-any.whl", url = `https://files.pythonhosted.org/${filename}`;
  const selection = { release: { version, source: "pypi" as const, publishedAt: "2026-11-05T00:00:00Z", locator: url, integrity: `sha256-${Buffer.from(sha, "hex").toString("base64")}` },
    selectedAt: "2026-11-07T12:00:00Z", cutoff: "2026-11-06T12:00:00Z", policy: { minReleaseAgeMs: 86400000, allowPrerelease: false, override: null }, excluded: [], warnings: [] };
  const result = await resolvePythonRuntimePlan([{ id: "harbor", name: "harbor", source: "pypi", ecosystem: "PyPI", repository: "harbor-framework/harbor", selection }], {
    python: "/python", platform: "darwin-arm64", abi: "python-3.12", run: async (_cmd, args) => {
      if (args.includes("--report")) await writeFile(args[args.indexOf("--report") + 1]!, JSON.stringify({ install: [{ metadata: { name: "harbor", version }, download_info: { url, archive_info: { hashes: { sha256: sha } } } }] }));
      return { code: 0, stdout: "", stderr: "" };
    }, fetch: async (request) => new Response(JSON.stringify(request.includes("/simple/") ? { files: [{ filename }] } : { releases: { [version]: [{ filename, url, digests: { sha256: sha }, upload_time_iso_8601: "2026-11-05T00:00:00Z", yanked: false }] } })),
  });
  assert.equal(result.plan.kind, "python");
  assert.deepEqual(result.plan.requirements, [`harbor==0.25.0 --hash=sha256:${sha}`]);
  assert.equal(result.components[0]!.selection.release.publishedAt, "2026-11-05T00:00:00Z");
});
