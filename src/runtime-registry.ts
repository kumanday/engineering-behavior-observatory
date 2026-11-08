import { fetchOciReleases } from "./runtime-oci.js";
import { RuntimePolicyError, type RuntimeRelease, type RuntimeSource } from "./runtime-resolution.js";

export type RuntimeRegistryRequest = { source: RuntimeSource; name: string; repository?: string; assetPattern?: string; platform?: string; architecture?: string; flavor?: string };
export type RuntimeFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type RuntimeRegistryOptions = { fetch?: RuntimeFetch };
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const sri = (digest: string): string => `sha256-${Buffer.from(digest.replace(/^sha256:/, ""), "hex").toString("base64")}`;

export async function runtimeJson(url: string, options: RuntimeRegistryOptions = {}, init?: RequestInit): Promise<any> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new RuntimePolicyError("RUNTIME_REGISTRY_URL", "Runtime metadata requires HTTPS without URL credentials.");
  const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(30_000), ...init });
  if (!response.ok) throw new RuntimePolicyError("RUNTIME_METADATA_UNAVAILABLE", `${parsed.origin}${parsed.pathname}: HTTP ${response.status}`);
  const chunks: Uint8Array[] = []; let size = 0;
  if (!response.body) throw new RuntimePolicyError("RUNTIME_METADATA_INVALID", "Empty registry response.");
  for await (const chunk of response.body) { size += chunk.length; if (size > 64 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new RuntimePolicyError("RUNTIME_METADATA_TOO_LARGE", "Registry response exceeds 64 MiB."); } chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RuntimePolicyError("RUNTIME_METADATA_INVALID", "Registry returned malformed JSON."); }
}

export async function fetchRuntimeReleases(request: RuntimeRegistryRequest, options: RuntimeRegistryOptions = {}): Promise<RuntimeRelease[]> {
  if (request.source === "npm") {
    const data = object(await runtimeJson(`https://registry.npmjs.org/${encodeURIComponent(request.name)}`, options));
    return Object.entries(object(data.versions)).map(([version, raw]) => {
      const metadata = object(raw), dist = object(metadata.dist);
      const proofs: NonNullable<RuntimeRelease["proofs"]> = [];
      if (dist.attestations?.url) proofs.push({ kind: "npm-attestation", locator: dist.attestations.url });
      if (Array.isArray(dist.signatures) && dist.signatures.length) proofs.push({ kind: "npm-signature", locator: "https://registry.npmjs.org/-/npm/v1/keys" });
      return { version, publishedAt: String(object(data.time)[version] ?? ""), source: "npm", locator: String(dist.tarball ?? ""),
        integrity: String(dist.integrity ?? ""), ...(metadata.deprecated ? { deprecated: String(metadata.deprecated) } : {}), proofs, metadata };
    });
  }
  if (request.source === "pypi") {
    const data = object(await runtimeJson(`https://pypi.org/pypi/${encodeURIComponent(request.name)}/json`, options));
    return Object.entries(object(data.releases)).flatMap(([version, raw]) => {
      if (!Array.isArray(raw)) throw new RuntimePolicyError("RUNTIME_METADATA_INVALID", "PyPI files must be an array.");
      // The installer resolves platform compatibility; this receipt retains every offered file.
      const files = raw.map(object).filter((file) => typeof file.filename === "string");
      const artifact = files.find((file) => file.filename.endsWith("-py3-none-any.whl")) ?? files.find((file) => file.filename.endsWith(".whl")) ?? files[0];
      if (!artifact) return [];
      const proofs = artifact.provenance ? [{ kind: "pypi-attestation", locator: String(artifact.provenance) }] : [];
      return [{ version, publishedAt: String(artifact.upload_time_iso_8601 ?? ""), source: "pypi" as const, locator: String(artifact.url ?? ""),
        integrity: sri(String(object(artifact.digests).sha256 ?? "")), yanked: files.every((file) => Boolean(file.yanked)), proofs, metadata: { files } }];
    });
  }
  if (request.source === "github" || request.source === "vendor") return githubReleases(request, options);
  return fetchOciReleases(request, options);
}

async function githubReleases(request: RuntimeRegistryRequest, options: RuntimeRegistryOptions): Promise<RuntimeRelease[]> {
  if (!request.repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(request.repository)) throw new RuntimePolicyError("RUNTIME_REPOSITORY_INVALID", "Expected owner/repository.");
  const releases: RuntimeRelease[] = [];
  for (let page = 1; ; page++) {
    const rows: unknown = await runtimeJson(`https://api.github.com/repos/${request.repository}/releases?per_page=100&page=${page}`, options);
    if (!Array.isArray(rows)) throw new RuntimePolicyError("RUNTIME_METADATA_INVALID", "GitHub releases must be an array.");
    for (const row of rows.map(object)) {
      const version = String(row.tag_name ?? "").replace(/^(?:v|rust-v)/u, "");
      if (request.source === "vendor" && request.repository === "CognitionAI/devin-cli") {
        const manifest = object(await runtimeJson(`https://static.devin.ai/cli/${encodeURIComponent(version)}/manifest.json`, options));
        const asset = object(object(manifest.platforms)[request.platform ?? ""]);
        releases.push({ source: "vendor", version, publishedAt: String(row.published_at ?? ""), locator: String(asset.url ?? ""), integrity: sri(String(asset.sha256 ?? "")),
          draft: Boolean(row.draft), prerelease: Boolean(row.prerelease), metadata: { release: row, manifest } });
      } else {
        const assets = Array.isArray(row.assets) ? row.assets.map(object) : [];
        const asset = assets.find((asset) => new RegExp(request.assetPattern ?? "^$").test(String(asset.name)));
        if (!asset) continue;
        releases.push({ source: "github", version, publishedAt: String(row.published_at ?? ""), locator: String(asset.browser_download_url ?? ""),
          integrity: /^sha256:[0-9a-f]{64}$/u.test(asset.digest ?? "") ? sri(asset.digest) : "", draft: Boolean(row.draft), prerelease: Boolean(row.prerelease), metadata: { release: row, asset } });
      }
    }
    if (rows.length < 100) break;
    if (page >= 100) throw new RuntimePolicyError("RUNTIME_METADATA_TOO_LARGE", "GitHub release pagination exceeds 100 pages.");
  }
  return releases;
}
