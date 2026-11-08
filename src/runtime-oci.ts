import { createHash } from "node:crypto";
import { RuntimePolicyError, type RuntimeRelease } from "./runtime-resolution.js";
import type { RuntimeRegistryOptions, RuntimeRegistryRequest } from "./runtime-registry.js";
import type {ArtifactProof} from "./runtime-proofs.js";
import {digestMetadata} from "./artifacts.js";

const digest = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const verify = (bytes: Uint8Array, expected: string): void => { if (!/^sha256:[a-f0-9]{64}$/u.test(expected) || digest(bytes) !== expected) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", "OCI descriptor digest differs from downloaded bytes."); };
function ociRegistryClient(request: RuntimeRegistryRequest, options: RuntimeRegistryOptions) {
  const split = request.name.indexOf("/"), registry = request.name.slice(0, split), repository = request.name.slice(split + 1);
  if (split < 1 || !/^[a-z0-9.-]+(?::[0-9]+)?$/u.test(registry) || !/^[a-z0-9._/-]+$/u.test(repository)) throw new RuntimePolicyError("RUNTIME_IMAGE_INVALID", "Use an explicit registry/repository image name.");
  const base = `https://${registry}/v2/${repository}`, accept = "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json";
  let token: string | undefined;
  const get = async (url: string): Promise<{ response: Response; bytes: Buffer; json: any }> => {
    const fetcher = options.fetch ?? fetch;
    let response = await fetcher(url, { headers: { accept, ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(30_000) });
    if (response.status === 401) {
      const challenge = response.headers.get("www-authenticate") ?? "";
      const realm = /realm="([^"]+)"/u.exec(challenge)?.[1], service = /service="([^"]+)"/u.exec(challenge)?.[1];
      if (!challenge.startsWith("Bearer ") || !realm || new URL(realm).protocol !== "https:") throw new RuntimePolicyError("RUNTIME_REGISTRY_AUTH", "Unsupported OCI authentication challenge.");
      const auth = new URL(realm); auth.searchParams.set("scope", `repository:${repository}:pull`); if (service) auth.searchParams.set("service", service);
      const authResponse = await fetcher(auth.href, { signal: AbortSignal.timeout(30_000) });
      if (!authResponse.ok) throw new RuntimePolicyError("RUNTIME_REGISTRY_AUTH", `OCI token returned HTTP ${authResponse.status}.`);
      const body = await authResponse.json() as any; token = body.token ?? body.access_token;
      if (typeof token !== "string") throw new RuntimePolicyError("RUNTIME_REGISTRY_AUTH", "OCI token response is invalid.");
      response = await fetcher(url, { headers: { accept, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    }
    if (!response.ok) throw new RuntimePolicyError("RUNTIME_METADATA_UNAVAILABLE", `OCI metadata returned HTTP ${response.status}.`);
    const chunks: Uint8Array[] = []; let size = 0;
    if (!response.body) throw new RuntimePolicyError("RUNTIME_METADATA_INVALID", "OCI metadata is empty.");
    for await (const chunk of response.body) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new RuntimePolicyError("RUNTIME_METADATA_TOO_LARGE", "OCI metadata exceeds 32 MiB."); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    try { return { response, bytes, json: JSON.parse(bytes.toString("utf8")) }; }
    catch { throw new RuntimePolicyError("RUNTIME_METADATA_INVALID", "OCI metadata is malformed."); }
  };
  return {base, get};
}

export async function fetchOciReleases(request: RuntimeRegistryRequest, options: RuntimeRegistryOptions): Promise<RuntimeRelease[]> {
  const {base, get} = ociRegistryClient(request, options);
  const tags: string[] = []; let next: string | undefined = `${base}/tags/list`; const seen = new Set<string>();
  while (next) {
    if (seen.has(next) || seen.size > 100 || !next.startsWith(`${base}/tags/list`)) throw new RuntimePolicyError("RUNTIME_METADATA_INVALID", "Invalid OCI tag pagination.");
    seen.add(next); const page = await get(next);
    if (!Array.isArray(page.json.tags)) throw new RuntimePolicyError("RUNTIME_METADATA_INVALID", "OCI tags must be an array.");
    tags.push(...page.json.tags.filter((tag: unknown): tag is string => typeof tag === "string"));
    const link = /<([^>]+)>;\s*rel="?next"?/u.exec(page.response.headers.get("link") ?? "")?.[1];
    next = link ? new URL(link, next).href : undefined;
  }
  const releases: RuntimeRelease[] = [];
  const flavor = request.flavor ? `-${request.flavor}` : "";
  for (const tag of tags) {
    if (flavor && !tag.endsWith(flavor)) continue;
    const version = (flavor ? tag.slice(0, -flavor.length) : tag).replace(/^(?:rel-|v)/u, "");
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) continue;
    let image = await get(`${base}/manifests/${encodeURIComponent(tag)}`), indexDigest: string | undefined;
    if (Array.isArray(image.json.manifests)) {
      indexDigest = digest(image.bytes);
      const target = image.json.manifests.find((entry: any) => entry.platform?.os === (request.platform ?? "linux") && entry.platform?.architecture === (request.architecture ?? "amd64"));
      if (!target) continue;
      image = await get(`${base}/manifests/${target.digest}`); verify(image.bytes, target.digest);
    }
    const manifestDigest = digest(image.bytes);
    if (image.json.schemaVersion !== 2 || !image.json.config?.digest || !Array.isArray(image.json.layers)) throw new RuntimePolicyError("RUNTIME_METADATA_INVALID", "OCI image lacks a v2 config/layer manifest.");
    const config = await get(`${base}/blobs/${image.json.config.digest}`); verify(config.bytes, image.json.config.digest);
    if (config.json.os !== (request.platform ?? "linux") || config.json.architecture !== (request.architecture ?? "amd64")) throw new RuntimePolicyError("RUNTIME_IMAGE_PLATFORM_MISMATCH", "OCI config and requested platform disagree.");
    releases.push({ source: "oci", version, flavor: request.flavor, publishedAt: String(config.json.created ?? ""), locator: `${request.name}@${manifestDigest}`,
      integrity: `sha256-${Buffer.from(manifestDigest.slice(7), "hex").toString("base64")}`, metadata: { tag, manifestDigest, indexDigest: indexDigest ?? null, manifest: image.json, config: config.json } });
  }
  return releases;
}

/** Check standard referrers, Cosign tags and the selected platform's BuildKit provenance. */
export async function discoverOciProofs(request: RuntimeRegistryRequest, release: RuntimeRelease, options: RuntimeRegistryOptions): Promise<ArtifactProof[]> {
  const {base, get} = ociRegistryClient(request, options), subject = release.locator.split("@")[1]!;
  const proofs: ArtifactProof[] = [];
  const optional = async (url: string) => {
    try {return await get(url);}
    catch (error) {if (error instanceof RuntimePolicyError && /HTTP 404\b/u.test(error.message)) return undefined; throw error;}
  };
  const references = await optional(`${base}/referrers/${subject}`);
  if (references && !Array.isArray(references.json.manifests)) throw new RuntimePolicyError("RUNTIME_PROOF_INVALID", "OCI referrers response lacks its descriptor list.");
  const descriptors = references?.json.manifests ?? [];
  for (const mode of ["signature", "attestation"] as const) {
    const suffix = mode === "signature" ? "sig" : "att";
    const tagged = await optional(`${base}/manifests/${subject.replace(":", "-")}.${suffix}`);
    const offered = descriptors.filter((entry: any) => String(entry.artifactType ?? "").includes(mode === "signature" ? "cosign.artifact.sig" : "cosign.artifact.att"));
    if (tagged || offered.length) proofs.push({kind: "oci-cosign", repository: request.repository!, image: release.locator, mode, manifests: [...offered, ...(tagged ? [tagged.json] : [])]});
  }
  const provenance: {digest: string; bytesBase64: string}[] = [];
  const retain = (value: {bytes: Buffer}, expected: string) => {verify(value.bytes, expected); provenance.push({digest: expected, bytesBase64: value.bytes.toString("base64")});};
  const indexDigest = release.metadata?.indexDigest;
  if (typeof indexDigest === "string") {
    const index = await get(`${base}/manifests/${indexDigest}`); retain(index, indexDigest);
    if (!index.json.manifests?.some((entry: any) => entry.digest === subject)) throw new RuntimePolicyError("RUNTIME_PROOF_INVALID", "Frozen OCI index no longer references its selected platform.");
    descriptors.push(...index.json.manifests.filter((entry: any) => entry.annotations?.["vnd.docker.reference.type"] === "attestation-manifest" && entry.annotations?.["vnd.docker.reference.digest"] === subject));
  }
  for (const descriptor of descriptors) {
    if (String(descriptor.artifactType ?? "").includes("cosign.artifact.")) continue;
    const manifest = await get(`${base}/manifests/${descriptor.digest}`); retain(manifest, descriptor.digest);
    for (const layer of manifest.json.layers ?? manifest.json.blobs ?? []) {
      if (!String(layer.mediaType).includes("in-toto") && !String(layer.mediaType).includes("sigstore.bundle")) continue;
      const blob = await get(`${base}/blobs/${layer.digest}`); retain(blob, layer.digest);
      if (String(layer.mediaType).includes("sigstore.bundle")) {
        const bundles = [blob.json];
        proofs.push({kind: "github-attestation", repository: request.repository!, subject: `oci://${release.locator}`, bundles, digest: `sha256:${digestMetadata(bundles).value}`});
      } else if (!Array.isArray(blob.json.subject) || !blob.json.subject.some((entry: any) => entry.digest?.sha256 === subject.slice(7))) throw new RuntimePolicyError("RUNTIME_PROOF_INVALID", "OCI provenance does not name the selected image digest.");
    }
  }
  if (provenance.length) proofs.push({kind: "oci-buildkit-provenance", subject, blobs: provenance});
  return proofs;
}

/** Frozen launches read the immutable manifest even if its tag has moved. */
export async function fetchFrozenOciRelease(request: RuntimeRegistryRequest, frozen: RuntimeRelease, options: RuntimeRegistryOptions): Promise<RuntimeRelease> {
  const reference = frozen.locator.slice(request.name.length + 1);
  if (!frozen.locator.startsWith(`${request.name}@`) || !/^sha256:[a-f0-9]{64}$/u.test(reference)) throw new RuntimePolicyError("RUNTIME_IMAGE_INVALID", "Frozen image requires its platform manifest digest.");
  const {base, get} = ociRegistryClient(request, options);
  try {
    const manifest = await get(`${base}/manifests/${reference}`); verify(manifest.bytes, reference);
    if (manifest.json.schemaVersion !== 2 || !manifest.json.config?.digest || !Array.isArray(manifest.json.layers)) throw new RuntimePolicyError("RUNTIME_METADATA_INVALID", "Frozen OCI image lacks its config/layers.");
    const config = await get(`${base}/blobs/${manifest.json.config.digest}`); verify(config.bytes, manifest.json.config.digest);
    if (config.json.os !== request.platform || config.json.architecture !== request.architecture) throw new RuntimePolicyError("RUNTIME_IMAGE_PLATFORM_MISMATCH", "Frozen image platform differs from the study.");
    return {...frozen, metadata: {...frozen.metadata, manifest: manifest.json, config: config.json}};
  } catch (error) {
    if (error instanceof RuntimePolicyError && /HTTP 404\b/u.test(error.message)) throw new RuntimePolicyError("RUNTIME_RELEASE_WITHDRAWN", `${request.name}@${reference} is unavailable.`);
    throw error;
  }
}
