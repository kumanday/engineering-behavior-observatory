import {createHash} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {canonicalizeMetadata, digestMetadata} from "./artifacts.js";
import {discoverOciProofs} from "./runtime-oci.js";
import {runtimeJson, runtimeJsonResponse, type RuntimeRegistryOptions, type RuntimeRegistryRequest} from "./runtime-registry.js";
import {RuntimePolicyError, type RuntimeRelease} from "./runtime-resolution.js";
import type {RuntimeCommandRunner, RuntimeInstallReceipt} from "./runtime-installation.js";

export type ArtifactProof =
  | {kind: "github-attestation"; repository: string; subject: string; bundles: unknown[]; digest: string}
  | {kind: "oci-cosign"; repository: string; image: string; mode: "signature" | "attestation"; manifests: unknown[]}
  | {kind: "oci-buildkit-provenance" | "oci-index-binding"; subject: string; blobs: {digest: string; bytesBase64: string}[]};

/** Discover proofs only for selected artifacts; a missing proof is distinct from a failed lookup. */
export async function discoverArtifactProofs(request: RuntimeRegistryRequest, release: RuntimeRelease, options: RuntimeRegistryOptions): Promise<ArtifactProof[]> {
  const proofs: ArtifactProof[] = [];
  if (!request.repository || !/^[\w.-]+\/[\w.-]+$/u.test(request.repository)) throw new RuntimePolicyError("RUNTIME_PROOF_IDENTITY_REQUIRED", "Artifact runtimes need their maintained publisher repository.");
  const subject = release.source === "oci" ? release.locator.slice(release.locator.lastIndexOf("@") + 1) : `sha256:${Buffer.from(release.integrity.slice("sha256-".length), "base64").toString("hex")}`;
  if (!/^sha256:[a-f0-9]{64}$/u.test(subject)) throw new RuntimePolicyError("RUNTIME_PROOF_INVALID", "Publisher attestations require a SHA-256 artifact identity.");
  const subjects = [...new Set([subject, ...(typeof release.metadata?.indexDigest === "string" ? [release.metadata.indexDigest] : [])])];
  for (const digest of subjects) {
    const bundles: unknown[] = [];
    const base = `https://api.github.com/repos/${request.repository}/attestations/${digest}`, visited = new Set<string>();
    let next: string | undefined = `${base}?per_page=100`;
    while (next) {
      if (visited.has(next) || visited.size >= 100 || new URL(next).origin !== "https://api.github.com" || new URL(next).pathname !== new URL(base).pathname) throw new RuntimePolicyError("RUNTIME_PROOF_INVALID", "Invalid GitHub attestation pagination.");
      visited.add(next);
      let data: any, response: Response;
      try {({data, response} = await runtimeJsonResponse(next, options));}
      catch (error) {if (error instanceof RuntimePolicyError && /HTTP 404\b/u.test(error.message)) break; throw error;}
      if (!Array.isArray(data.attestations)) throw new RuntimePolicyError("RUNTIME_PROOF_INVALID", "GitHub attestations response lacks its bundle list.");
      for (const entry of data.attestations) {
        const bundle = entry.bundle ?? (typeof entry.bundle_url === "string" ? await runtimeJson(entry.bundle_url, options) : undefined);
        if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new RuntimePolicyError("RUNTIME_PROOF_INVALID", "An offered GitHub attestation lacks its bundle.");
        bundles.push(bundle);
      }
      const link = /<([^>]+)>;\s*rel="?next"?/u.exec(response.headers.get("link") ?? "")?.[1];
      next = link ? new URL(link, next).href : undefined;
    }
    if (bundles.length) proofs.push({kind: "github-attestation", repository: request.repository, subject: release.source === "oci" ? `oci://${request.name}@${digest}` : subject, bundles, digest: `sha256:${digestMetadata(bundles).value}`});
  }
  if (release.source === "oci") proofs.push(...await discoverOciProofs(request, release, options));
  return proofs;
}

export async function verifyArtifactProofs(proofs: readonly ArtifactProof[], artifact: string, staging: string, run: RuntimeCommandRunner): Promise<RuntimeInstallReceipt["proofs"]> {
  const receipts: RuntimeInstallReceipt["proofs"] = [];
  const execute = async (command: string, args: string[]): Promise<string> => {
    const result = await run(command, args, staging);
    if (result.code !== 0) throw new RuntimePolicyError("RUNTIME_PROOF_VERIFICATION_FAILED", `${command} rejected offered provenance: ${result.stderr.slice(0, 2000)}`);
    return result.stdout;
  };
  for (const [index, proof] of proofs.entries()) {
    await mkdir(join(staging, "proofs"), {recursive: true});
    const path = `proofs/artifact-${index}.json`;
    await writeFile(join(staging, path), canonicalizeMetadata(proof), {mode: 0o600});
    let output: unknown;
    if (proof.kind === "github-attestation") {
      if (`sha256:${digestMetadata(proof.bundles).value}` !== proof.digest) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", "Frozen publisher bundles changed.");
      const bundlePath = join(staging, "proofs", `github-${index}.jsonl`);
      await writeFile(bundlePath, proof.bundles.map(canonicalizeMetadata).join("\n") + "\n", {mode: 0o600});
      output = await execute("gh", ["attestation", "verify", proof.subject.startsWith("oci://") ? proof.subject : artifact, "--repo", proof.repository, "--bundle", bundlePath, "--format", "json"]);
    } else if (proof.kind === "oci-cosign") {
      const repository = proof.repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      output = await execute("cosign", [proof.mode === "signature" ? "verify" : "verify-attestation", "--certificate-identity-regexp", `^https://github\\.com/${repository}/`, "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com", "--output", "json", proof.image]);
    } else {
      // BuildKit provenance is content-linked metadata, not a signed publisher identity.
      for (const blob of proof.blobs) {
        const bytes = Buffer.from(blob.bytesBase64, "base64");
        if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== blob.digest) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", "Frozen OCI provenance changed.");
      }
      output = {status: "content-linked", publisherIdentity: proof.kind === "oci-index-binding" ? "not-applicable" : "unsigned", subject: proof.subject};
    }
    receipts.push({kind: proof.kind, result: {proofPath: path, proofDigest: `sha256:${digestMetadata(proof).value}`, output}});
  }
  return receipts.length ? receipts : [{kind: "publisher-provenance", result: {status: "not-offered"}}];
}
