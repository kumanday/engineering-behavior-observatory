import assert from "node:assert/strict";
import test from "node:test";
import { fetchRuntimeReleases } from "../src/runtime-registry.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
test("uses npm version publish times and integrity rather than dist-tags", async () => {
  const releases = await fetchRuntimeReleases({ source: "npm", name: "@example/sdk" }, { fetch: async () => json({ time: { "9.9.9": "2026-11-05T12:00:00Z" }, "dist-tags": { latest: "0.0.0" }, versions: {
    "9.9.9": { dist: { tarball: "https://registry.npmjs.org/sdk.tgz", integrity: "sha512-Zml4dHVyZQ==", attestations: { url: "https://registry.npmjs.org/proof" } } },
  } }) });
  assert.equal(releases[0]!.version, "9.9.9");
  assert.equal(releases[0]!.publishedAt, "2026-11-05T12:00:00Z");
  assert.equal(releases[0]!.proofs?.[0]?.kind, "npm-attestation");
});
test("uses the selected PyPI artifact upload time and marks withdrawn releases", async () => {
  const releases = await fetchRuntimeReleases({ source: "pypi", name: "harbor" }, { fetch: async () => json({ releases: {
    "0.25.0": [{ filename: "harbor-0.25.0-py3-none-any.whl", url: "https://files.pythonhosted.org/harbor.whl", upload_time_iso_8601: "2026-11-05T00:00:00Z", digests: { sha256: "a".repeat(64) }, yanked: true }],
  } }) });
  assert.equal(releases[0]!.publishedAt, "2026-11-05T00:00:00Z");
  assert.equal(releases[0]!.yanked, true);
  assert.equal(releases[0]!.integrity, `sha256-${Buffer.from("a".repeat(64), "hex").toString("base64")}`);
});

test("resolves OCI stable flavors using image creation time and platform digests", async () => {
  const { createHash } = await import("node:crypto");
  const config = JSON.stringify({ created: "2026-11-05T00:00:00Z", architecture: "arm64", os: "linux" });
  const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
  const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: hash(config) }, layers: [{ digest: `sha256:${"b".repeat(64)}`, size: 42 }] });
  const releases = await fetchRuntimeReleases({ source: "oci", name: "ghcr.io/openhands/agent-server", platform: "linux", architecture: "arm64", flavor: "python" }, { fetch: async (url) => {
    if (url.endsWith("/tags/list")) return json({ tags: ["latest", "1.54.0-python"] });
    if (url.includes("/manifests/")) return new Response(manifest);
    if (url.endsWith(`/blobs/${hash(config)}`)) return new Response(config);
    throw new Error(`Unexpected URL ${url}`);
  } });
  assert.equal(releases.length, 1);
  assert.equal(releases[0]!.version, "1.54.0");
  assert.equal(releases[0]!.publishedAt, "2026-11-05T00:00:00Z");
  assert.equal(releases[0]!.flavor, "python");
  assert.match(releases[0]!.locator, /@sha256:/);
});
