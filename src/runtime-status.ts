import {fetchFrozenNpmRelease, fetchRuntimeReleases, runtimeJson, type RuntimeRegistryOptions, type RuntimeRegistryRequest} from "./runtime-registry.js";
import {fetchFrozenOciRelease} from "./runtime-oci.js";
import {RuntimePolicyError, type RuntimeRelease} from "./runtime-resolution.js";

/** Status and identity of the exact frozen artifact; release selection is not repeated. */
export async function refreshFrozenRuntimeRelease(request: RuntimeRegistryRequest, frozen: RuntimeRelease, options: RuntimeRegistryOptions): Promise<RuntimeRelease> {
  let current: RuntimeRelease | undefined;
  if (request.source === "npm") current = await fetchFrozenNpmRelease(request.name, frozen, options);
  else if (request.source === "oci") current = await fetchFrozenOciRelease(request, frozen, options);
  else if (request.source === "pypi") {
    let payload: any;
    try {payload = await runtimeJson(`https://pypi.org/pypi/${encodeURIComponent(request.name)}/${encodeURIComponent(frozen.version)}/json`, options);}
    catch (error) {
      if (error instanceof RuntimePolicyError && /HTTP 404\b/u.test(error.message)) throw new RuntimePolicyError("RUNTIME_RELEASE_WITHDRAWN", `${request.name}@${frozen.version} is unpublished.`);
      throw error;
    }
    const files = payload.urls ?? payload.releases?.[frozen.version];
    if (!Array.isArray(files)) throw new RuntimePolicyError("RUNTIME_METADATA_INVALID", "PyPI version metadata lacks its file list.");
    const local = frozen.metadata?.localWheel as {source: {url: string; sha256: string}; upstreamWheel?: {url: string; sha256: string}} | undefined;
    const file = files.find((file: any) => file.url === (local?.source.url ?? frozen.locator));
    if (file) {
      if (!/^[a-f0-9]{64}$/u.test(file.digests?.sha256 ?? "")) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", "Selected wheel lacks its registry hash.");
      if (local && (file.packagetype !== "sdist" || file.digests.sha256 !== local.source.sha256)) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", "Operator-built wheel source changed in PyPI.");
      if (local?.upstreamWheel) {
        const binary = files.find((entry: any) => entry.url === local.upstreamWheel!.url);
        if (!binary || binary.yanked) throw new RuntimePolicyError("RUNTIME_RELEASE_WITHDRAWN", "Repackaged upstream wheel is unavailable or yanked.");
        if (binary.packagetype !== "bdist_wheel" || binary.digests?.sha256 !== local.upstreamWheel.sha256) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", "Repackaged upstream binary changed in PyPI.");
      }
      current = {...frozen, integrity: local ? frozen.integrity : `sha256-${Buffer.from(file.digests.sha256, "hex").toString("base64")}`, yanked: Boolean(file.yanked)};
    }
  } else current = (await fetchRuntimeReleases(request, options)).find((release) => release.version === frozen.version);
  if (!current || current.yanked || current.unpublished || current.malicious || current.draft) throw new RuntimePolicyError("RUNTIME_RELEASE_WITHDRAWN", `${request.name}@${frozen.version} is unavailable, yanked, draft or malicious.`);
  if (current.integrity !== frozen.integrity || current.locator !== frozen.locator) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", `Registry changed ${request.name}@${frozen.version}.`);
  return current;
}
