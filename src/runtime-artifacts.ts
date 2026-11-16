import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { RuntimePolicyError } from "./runtime-resolution.js";
import {verifyOciDescriptors} from "./runtime-oci.js";
import {MAX_LOCAL_PYTHON_WHEEL_BYTES} from "./runtime-local-wheels.js";
import type { RuntimeFetch } from "./runtime-registry.js";
import type { RuntimeCommandRunner, RuntimeInstallReceipt } from "./runtime-installation.js";
import { assertPythonIdentity, probePythonBootstrap, type PythonBootstrap } from "./runtime-bootstrap.js";
import { canonicalizeMetadata, digestMetadata } from "./artifacts.js";
import {verifyArtifactProofs, type ArtifactProof} from "./runtime-proofs.js";

export type RuntimeArtifact = { locator: string; integrity: string; filename: string;
  localWheel?: import("./runtime-local-wheels.js").RetainedLocalWheel;
  attestation?: { provenanceUrl: string; repository: string; provenance?: Record<string, unknown>; provenanceDigest?: string } };
type Base = { platform: string; abi: string; publisherProofs?: ArtifactProof[] };
export type ArtifactInstallPlan = Base & (
  { kind: "binary"; recipe: "ebo-binary/v1"; artifact: RuntimeArtifact; archive: "tar.gz" | "raw" } |
  { kind: "python"; recipe: "ebo-python/v1"; artifacts: RuntimeArtifact[]; python: string; bootstrap: PythonBootstrap; requirements: string[] } |
  { kind: "oci"; recipe: "ebo-oci/v1" | "ebo-oci/v2"; image: string; configDigest: string; layerDigests: string[] });

export async function downloadRuntimeArtifact(artifact: RuntimeArtifact, destination: string, fetcher: RuntimeFetch = fetch): Promise<void> {
  if (artifact.localWheel) {
    const local = artifact.localWheel, bytes = Buffer.from(local.bytesBase64, "base64"), digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length > MAX_LOCAL_PYTHON_WHEEL_BYTES || bytes.toString("base64") !== local.bytesBase64 || artifact.locator !== `ebo-wheel:sha256:${digest}`
        || artifact.integrity !== `sha256-${Buffer.from(digest, "hex").toString("base64")}` || basename(artifact.filename) !== artifact.filename || !artifact.filename.endsWith(".whl")
        || local.provenance.wheel.filename !== artifact.filename || local.provenance.wheel.sha256 !== digest || local.provenanceDigest !== `sha256:${digestMetadata(local.provenance).value}`) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", "Retained operator-built wheel differs from admission.");
    await writeFile(destination, bytes, {flag: "wx", mode: 0o600}); return;
  }
  const url = new URL(artifact.locator), match = /^(sha512|sha256)-([A-Za-z0-9+/]+=*)$/u.exec(artifact.integrity);
  if (url.protocol !== "https:" || url.username || url.password || !match || basename(artifact.filename) !== artifact.filename || !artifact.filename) throw new RuntimePolicyError("RUNTIME_ARTIFACT_INVALID", "Expected an HTTPS artifact with SHA-256/512 integrity and a plain filename.");
  const expected = Buffer.from(match[2]!, "base64"), hash = createHash(match[1]!);
  if (expected.length !== (match[1] === "sha512" ? 64 : 32)) throw new RuntimePolicyError("RUNTIME_ARTIFACT_INVALID", "Invalid integrity digest length.");
  const response = await fetcher(url.href, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new RuntimePolicyError("RUNTIME_ARTIFACT_UNAVAILABLE", `Artifact returned HTTP ${response.status}.`);
  const file = await open(destination, "wx", 0o600); let size = 0;
  try {
    for await (const bytes of response.body) { size += bytes.length; if (size > 2 * 1024 ** 3) throw new RuntimePolicyError("RUNTIME_ARTIFACT_TOO_LARGE", "Artifact exceeds 2 GiB."); hash.update(bytes); await file.write(bytes); }
    if (!timingSafeEqual(hash.digest(), expected)) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", `Downloaded ${artifact.filename} differs from its frozen digest.`);
    await file.sync();
  } finally { await file.close(); }
}
async function command(run: RuntimeCommandRunner, executable: string, args: readonly string[], cwd: string): Promise<string> {
  const result = await run(executable, args, cwd);
  if (result.code !== 0) throw new RuntimePolicyError("RUNTIME_INSTALL_FAILED", `${executable} ${args[0]} failed (${result.code}): ${result.stderr.slice(0, 2000)}`);
  return result.stdout;
}
const extractScript = String.raw`import pathlib,sys,tarfile
archive,destination=sys.argv[1:]
with tarfile.open(archive,'r:gz') as source:
    total=0
    for item in source.getmembers():
        total+=item.size
        if total>4*1024**3: raise ValueError('Runtime archive exceeds 4 GiB extracted')
        if not (item.isfile() or item.isdir() or item.issym() or item.islnk()): raise ValueError('Unsupported runtime archive entry')
    source.extractall(destination,filter='data')
`;
export async function installArtifactRuntime(plan: ArtifactInstallPlan, staging: string, finalRoot: string, run: RuntimeCommandRunner, fetcher?: RuntimeFetch): Promise<RuntimeInstallReceipt["proofs"]> {
  const proofs: RuntimeInstallReceipt["proofs"] = [];
  if (plan.kind === "oci") {
    if (!/^[^\s]+@sha256:[a-f0-9]{64}$/u.test(plan.image)) throw new RuntimePolicyError("RUNTIME_IMAGE_INVALID", "An immutable platform manifest digest is required.");
    const publisherProofs = await verifyArtifactProofs(plan.publisherProofs ?? [], plan.image, staging, run);
    await verifyOciDescriptors(plan, {fetch: fetcher});
    await writeFile(join(staging, "image.json"), JSON.stringify({ image: plan.image, configDigest: plan.configDigest, layerDigests: plan.layerDigests }), { mode: 0o600 });
    // Layers are pulled and checked by Smol when an owned VM is created. This
    // receipt admits descriptors; it makes no claim about an external image cache.
    return [...publisherProofs, {kind: "oci-descriptor-admission", result: {image: plan.image, configDigest: plan.configDigest, layerDigests: plan.layerDigests, layers: "not-pulled"}}];
  }
  if (plan.kind === "binary") {
    const archive = join(staging, plan.artifact.filename);
    await downloadRuntimeArtifact(plan.artifact, archive, fetcher);
    const publisherProofs = await verifyArtifactProofs(plan.publisherProofs ?? [], archive, staging, run);
    if (plan.archive === "tar.gz") {
      await mkdir(join(staging, "runtime"));
      await command(run, "python3", ["-I", "-c", extractScript, archive, join(staging, "runtime")], staging);
      await rm(archive);
    } else await chmod(archive, 0o700);
    return [...publisherProofs, { kind: "vendor-checksum", result: { integrity: plan.artifact.integrity } }];
  }
  assertPythonIdentity(await probePythonBootstrap(plan.python, run, staging), plan.bootstrap);
  const wheels = join(staging, "wheels"); await mkdir(wheels);
  for (const artifact of plan.artifacts) {
    if (!artifact.filename.endsWith(".whl")) throw new RuntimePolicyError("RUNTIME_PYTHON_SOURCE_BUILD_DISABLED", "Frozen Python runtimes install wheels only; source build scripts are disabled.");
    await downloadRuntimeArtifact(artifact, join(wheels, artifact.filename), fetcher);
    if (artifact.localWheel) {
      proofs.push({kind: "operator-built-wheel", result: {filename: artifact.filename, integrity: artifact.integrity, source: artifact.localWheel.provenance.source, builtAt: artifact.localWheel.provenance.builtAt, provenanceDigest: artifact.localWheel.provenanceDigest}});
    } else if (artifact.attestation) {
      const args = ["-I", "-B", "-m", "pypi_attestations", "verify", "pypi", "--repository", artifact.attestation.repository];
      let provenancePath: string | undefined;
      if (artifact.attestation.provenance) {
        const digest = `sha256:${digestMetadata(artifact.attestation.provenance).value}`;
        if (digest !== artifact.attestation.provenanceDigest) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", "Frozen PyPI provenance differs from its digest.");
        await mkdir(join(staging, "proofs"), {recursive: true});
        provenancePath = `proofs/${artifact.filename}.provenance.json`;
        await writeFile(join(staging, provenancePath), canonicalizeMetadata(artifact.attestation.provenance), {mode: 0o600});
        args.push("--provenance-file", join(staging, provenancePath));
      }
      const output = await command(run, plan.python, [...args, join(wheels, artifact.filename)], staging);
      proofs.push({ kind: "pypi-attestation", result: { filename: artifact.filename, repository: artifact.attestation.repository,
        ...(provenancePath ? {provenancePath, provenanceDigest: artifact.attestation.provenanceDigest} : {}), output } });
    } else proofs.push({ kind: "pypi-attestation", result: { filename: artifact.filename, status: "not-offered" } });
  }
  await command(run, plan.python, ["-I", "-m", "venv", "--copies", join(staging, "venv")], staging);
  await writeFile(join(staging, "requirements.txt"), plan.requirements.join("\n") + "\n", { mode: 0o600 });
  await command(run, join(staging, "venv", "bin", "python"), ["-I", "-m", "pip", "install", "--no-index", "--no-deps", "--no-compile", "--require-hashes", "--find-links", wheels, "-r", join(staging, "requirements.txt")], staging);
  // venv entrypoint shebangs must name the atomic destination, not the temporary directory.
  for (const name of await readdir(join(staging, "venv", "bin"))) {
    const path = join(staging, "venv", "bin", name);
    if (name.startsWith("python")) continue;
    const bytes = await readFile(path);
    if (bytes.subarray(0, 2).toString() === "#!") await writeFile(path, bytes.toString().replaceAll(staging, finalRoot));
  }
  await rm(wheels, { recursive: true }); return proofs;
}
