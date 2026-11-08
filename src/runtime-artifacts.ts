import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { RuntimePolicyError } from "./runtime-resolution.js";
import type { RuntimeFetch } from "./runtime-registry.js";
import type { RuntimeCommandRunner, RuntimeInstallReceipt } from "./runtime-installation.js";
import { assertPythonIdentity, probePythonBootstrap, type PythonBootstrap } from "./runtime-bootstrap.js";

export type RuntimeArtifact = { locator: string; integrity: string; filename: string;
  attestation?: { provenanceUrl: string; repository: string } };
type Base = { platform: string; abi: string };
export type ArtifactInstallPlan = Base & (
  { kind: "binary"; recipe: "ebo-binary/v1"; artifact: RuntimeArtifact; archive: "tar.gz" | "raw" } |
  { kind: "python"; recipe: "ebo-python/v1"; artifacts: RuntimeArtifact[]; python: string; bootstrap: PythonBootstrap; requirements: string[] } |
  { kind: "oci"; recipe: "ebo-oci/v1"; image: string; configDigest: string; layerDigests: string[] });

export async function downloadRuntimeArtifact(artifact: RuntimeArtifact, destination: string, fetcher: RuntimeFetch = fetch): Promise<void> {
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
    await command(run, "docker", ["pull", "--platform", plan.platform.replace(/-/, "/"), plan.image], staging);
    const inspected = JSON.parse(await command(run, "docker", ["image", "inspect", plan.image], staging));
    if (inspected[0]?.Id !== plan.configDigest) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", "Docker config differs from the frozen OCI manifest.");
    await writeFile(join(staging, "image.json"), JSON.stringify({ image: plan.image, configDigest: plan.configDigest, layerDigests: plan.layerDigests }), { mode: 0o600 });
    return [{ kind: "oci-content-digests", result: { configDigest: plan.configDigest, layerDigests: plan.layerDigests } }];
  }
  if (plan.kind === "binary") {
    const archive = join(staging, plan.artifact.filename);
    await downloadRuntimeArtifact(plan.artifact, archive, fetcher);
    if (plan.archive === "tar.gz") {
      await mkdir(join(staging, "runtime"));
      await command(run, "python3", ["-I", "-c", extractScript, archive, join(staging, "runtime")], staging);
      await rm(archive);
    } else await chmod(archive, 0o700);
    return [{ kind: "vendor-checksum", result: { integrity: plan.artifact.integrity } }];
  }
  assertPythonIdentity(await probePythonBootstrap(plan.python, run, staging), plan.bootstrap);
  const wheels = join(staging, "wheels"); await mkdir(wheels);
  for (const artifact of plan.artifacts) {
    if (!artifact.filename.endsWith(".whl")) throw new RuntimePolicyError("RUNTIME_PYTHON_SOURCE_BUILD_DISABLED", "Frozen Python runtimes install wheels only; source build scripts are disabled.");
    await downloadRuntimeArtifact(artifact, join(wheels, artifact.filename), fetcher);
    if (artifact.attestation) {
      const output = await command(run, plan.python, ["-I", "-m", "pypi_attestations", "verify", "pypi", "--repository", artifact.attestation.repository, join(wheels, artifact.filename)], staging);
      proofs.push({ kind: "pypi-attestation", result: { filename: artifact.filename, repository: artifact.attestation.repository, output } });
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
