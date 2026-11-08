import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {freezeStudyRuntimes} from "../src/study-runtimes.js";
import {fakeVendorRuntimeOptions} from "./runtime-vendor-fixture.js";
import {fakeOciRuntimeOptions} from "./runtime-oci-fixture.js";
import {createHash} from "node:crypto";
import {discoverArtifactProofs, verifyArtifactProofs} from "../src/runtime-proofs.js";

test("offered vendor provenance must verify against the maintained repository before extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-vendor-proof-")), options = fakeVendorRuntimeOptions(), fetcher = options.fetch!, runner = options.run!;
  let verified = false, extracted = false;
  options.fetch = async (url, init) => url.includes("/attestations/") ? Response.json({attestations: [{bundle: {mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", fixture: "invalid-signature"}}]}) : fetcher(url, init);
  options.run = async (command, args, cwd) => {
    if (command === "gh") {verified = true; assert.ok(args.includes("CognitionAI/devin-cli")); return {code: 1, stdout: "", stderr: "invalid signature"};}
    if (args.includes("-c")) extracted = true;
    return runner(command, args, cwd);
  };
  try {
    await assert.rejects(freezeStudyRuntimes(root, {studyId: "vendor-proof", roles: ["devin-cli"]}, options), /RUNTIME_.*(?:PROOF|INSTALL)/);
    assert.equal(verified, true); assert.equal(extracted, false);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("successful vendor proof verification retains the exact offered bundles and verifier result", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-vendor-proof-receipt-")), options = fakeVendorRuntimeOptions(), fetcher = options.fetch!, runner = options.run!;
  const bundle = {mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", fixture: "external-verifier-success"};
  options.fetch = async (url, init) => url.includes("/attestations/") ? Response.json({attestations: [{bundle}]}) : fetcher(url, init);
  options.run = async (command, args, cwd) => command === "gh" ? {code: 0, stdout: '[{"verified":true}]', stderr: ""} : runner(command, args, cwd);
  try {
    const lock = await freezeStudyRuntimes(root, {studyId: "vendor-proof-receipt", roles: ["devin-cli"]}, options);
    const cache = join(root, "runtimes/cache", lock.groups[0]!.installation.key);
    const proof = JSON.parse(await readFile(join(cache, "proofs/artifact-0.json"), "utf8"));
    assert.deepEqual(proof.bundles, [bundle]);
    const receipt = JSON.parse(await readFile(join(cache, ".ebo-runtime-receipt.json"), "utf8"));
    assert.ok(receipt.proofs.some((entry: any) => entry.kind === "github-attestation" && entry.result.output.includes('"verified":true')));
  } finally {await rm(root, {recursive: true, force: true});}
});

test("an offered OCI signature cannot be ignored when the image content digest matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "ebo-oci-proof-")), options = fakeOciRuntimeOptions(), fetcher = options.fetch!, runner = options.run!;
  let verified = false;
  options.fetch = async (url, init) => {
    if (url.includes("/attestations/")) return new Response("", {status: 404});
    if (url.includes("/referrers/")) return Response.json({schemaVersion: 2, manifests: [{digest: `sha256:${"e".repeat(64)}`, artifactType: "application/vnd.dev.cosign.artifact.sig.v1+json"}]});
    if (/sha256-[a-f0-9]+\.(?:sig|att)$/u.test(url)) return new Response("", {status: 404});
    return fetcher(url, init);
  };
  options.run = async (command, args, cwd) => {
    if (command === "cosign") {verified = true; assert.ok(args.includes("--certificate-oidc-issuer")); return {code: 1, stdout: "", stderr: "invalid signature"};}
    return runner(command, args, cwd);
  };
  try {
    await assert.rejects(freezeStudyRuntimes(root, {studyId: "oci-proof", roles: ["openhands-agent-server"]}, options), /RUNTIME_.*(?:PROOF|INSTALL)/);
    assert.equal(verified, true);
  } finally {await rm(root, {recursive: true, force: true});}
});

test("OCI BuildKit provenance is linked to the selected platform and preserves unsigned evidence explicitly", async () => {
  const subject = `sha256:${"a".repeat(64)}`, hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
  const request = {source: "oci" as const, name: "ghcr.io/openhands/agent-server", repository: "OpenHands/software-agent-sdk"};
  const root = await mkdtemp(join(tmpdir(), "ebo-oci-provenance-"));
  try {
    for (const correct of [true, false]) {
      const statement = JSON.stringify({_type: "https://in-toto.io/Statement/v0.1", subject: [{name: request.name, digest: {sha256: correct ? subject.slice(7) : "b".repeat(64)}}], predicateType: "https://slsa.dev/provenance/v0.2", predicate: {}});
      const manifest = JSON.stringify({schemaVersion: 2, layers: [{mediaType: "application/vnd.in-toto+json", digest: hash(statement)}]});
      const index = JSON.stringify({schemaVersion: 2, manifests: [{digest: subject, platform: {os: "linux", architecture: "arm64"}}, {digest: hash(manifest), annotations: {"vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": subject}}]});
      const release = {source: "oci" as const, version: "9.9.9", publishedAt: "2026-11-01T00:00:00Z", locator: `${request.name}@${subject}`, integrity: "unused", metadata: {indexDigest: hash(index)}};
      const fetch = async (url: string) => {
        if (url.endsWith(`/manifests/${hash(index)}`)) return new Response(index);
        if (url.endsWith(`/manifests/${hash(manifest)}`)) return new Response(manifest);
        if (url.endsWith(`/blobs/${hash(statement)}`)) return new Response(statement);
        return new Response("", {status: 404});
      };
      if (!correct) {await assert.rejects(discoverArtifactProofs(request, release, {fetch}), /RUNTIME_PROOF_INVALID/); continue;}
      const proofs = await discoverArtifactProofs(request, release, {fetch});
      const receipts = await verifyArtifactProofs(proofs, release.locator, root, async () => {throw new Error("Unsigned metadata must not claim a cryptographic verifier");});
      assert.equal((receipts[0]!.result as any).output.publisherIdentity, "unsigned");
      const changed = structuredClone(proofs);
      assert.equal(changed[0]!.kind, "oci-buildkit-provenance");
      if (changed[0]!.kind === "oci-buildkit-provenance") changed[0]!.blobs[0]!.bytesBase64 = Buffer.from("changed").toString("base64");
      await assert.rejects(verifyArtifactProofs(changed, release.locator, root, async () => {throw new Error("must not execute");}), /RUNTIME_INTEGRITY_MISMATCH/);
    }
  } finally {await rm(root, {recursive: true, force: true});}
});
