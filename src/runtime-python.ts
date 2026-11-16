import {admitLocalPythonWheels, localWheelRelease, retainedLocalWheel} from "./runtime-local-wheels.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { basename, join } from "node:path";
import type { ArtifactInstallPlan, RuntimeArtifact } from "./runtime-artifacts.js";
import { runRuntimeCommand, type RuntimeCommandRunner } from "./runtime-installation.js";
import { fetchRuntimeReleases, runtimeJson, type RuntimeRegistryOptions } from "./runtime-registry.js";
import { RuntimePolicyError, selectRuntimeRelease } from "./runtime-resolution.js";
import type { SelectedRuntimeComponent, LockedRuntimeDependency } from "./runtime-npm.js";
import { assertPythonTarget, probePythonBootstrap } from "./runtime-bootstrap.js";
import { digestMetadata } from "./artifacts.js";

export async function resolvePythonRuntimePlan(roots: readonly SelectedRuntimeComponent[], options: RuntimeRegistryOptions & {
  python: string; uv?: string; pythonWheelhouse?: string; platform: string; abi?: string; run?: RuntimeCommandRunner;
}): Promise<{ plan: Extract<ArtifactInstallPlan, { kind: "python" }>; components: LockedRuntimeDependency[] }> {
  if (!roots.length || roots.some((root) => root.source !== "pypi")) throw new RuntimePolicyError("RUNTIME_RECIPE_INVALID", "Python resolution requires PyPI roots.");
  const staging = await mkdtemp(join(tmpdir(), "ebo-python-resolve-")), run = options.run ?? runRuntimeCommand;
  const checked = async (executable: string, args: string[]): Promise<void> => {
    const result = await run(executable, args, staging);
    if (result.code !== 0) throw new RuntimePolicyError("RUNTIME_PYTHON_RESOLUTION_FAILED", `${executable}: ${result.stderr.slice(0, 2000)}`);
  };
  try {
    const bootstrap = await probePythonBootstrap(options.python, run, staging);
    assertPythonTarget(bootstrap, options.platform, options.abi);
    const localWheels = await admitLocalPythonWheels(options.pythonWheelhouse, staging);
    const usedLocalWheels = new Set<string>();
    const input = join(staging, "requirements.in"), frozen = join(staging, "requirements.txt"), report = join(staging, "report.json");
    await writeFile(input, [...roots.map((root) => `${root.name}==${root.selection.release.version}`), ...localWheels.map(wheel => `${wheel.name} @ ${wheel.localUrl}`)].join("\n") + "\n", { mode: 0o600 });
    const cutoff = roots.map((root) => root.selection.cutoff).sort()[0]!;
    await checked(options.uv ?? join(homedir(), ".local", "bin", "uv"), ["pip", "compile", input, "--output-file", frozen, "--python", bootstrap.executable, "--no-python-downloads", "--no-config", "--no-cache", "--index-url", "https://pypi.org/simple", "--only-binary", ":all:", "--generate-hashes", "--exclude-newer", cutoff,
      ...roots.flatMap((root) => ["--exclude-newer-package", `${root.name}=${root.selection.cutoff}`]), "--prerelease", roots.some((root) => root.selection.policy.allowPrerelease) ? "allow" : "disallow"]);
    await checked(bootstrap.executable, ["-I", "-m", "pip", "install", "--dry-run", "--ignore-installed", "--only-binary=:all:", "--require-hashes", "--index-url=https://pypi.org/simple", "--report", report, "-r", frozen]);
    const data = JSON.parse(await readFile(report, "utf8"));
    if (!Array.isArray(data.install) || !data.install.length) throw new RuntimePolicyError("RUNTIME_DEPENDENCY_LOCK_INVALID", "Python resolver returned no install graph.");
    const components: LockedRuntimeDependency[] = [], artifacts: RuntimeArtifact[] = [], requirements: string[] = [];
    for (const entry of data.install) {
      const name = String(entry.metadata?.name ?? "").toLowerCase().replace(/[-_.]+/gu, "-"), version = entry.metadata?.version;
      const url = entry.download_info?.url, hash = entry.download_info?.archive_info?.hashes?.sha256;
      if (!name || typeof version !== "string" || typeof url !== "string" || !/^[a-f0-9]{64}$/u.test(hash ?? "")) throw new RuntimePolicyError("RUNTIME_DEPENDENCY_LOCK_INVALID", "Python graph lacks exact wheel identity.");
      const owner = roots.find((root) => root.name.toLowerCase().replace(/[-_.]+/gu, "-") === name);
      const releases = await fetchRuntimeReleases({ source: "pypi", name }, options), release = releases.find((release) => release.version === version);
      const admitted = localWheels.find(wheel => wheel.localUrl === url && wheel.name === name && wheel.version === version && wheel.sha256 === hash);
      if (admitted) {
        if (!["abi3", `cp${bootstrap.version.split(".").slice(0, 2).join("")}`].includes(admitted.provenance.target.abi) || admitted.provenance.target.platform !== options.platform || admitted.provenance.target.python.split(".").slice(0, 2).join(".") !== bootstrap.version.split(".").slice(0, 2).join(".")) throw new RuntimePolicyError("RUNTIME_PLATFORM_MISMATCH", "Admitted wheel build target differs from the interpreter.");
        if (!release) throw new RuntimePolicyError("RUNTIME_LOCAL_WHEEL_INVALID", "Local wheel has no upstream released version.");
        const actual = localWheelRelease(admitted, release), policy = owner?.selection ?? roots[0]!.selection;
        const selection = selectRuntimeRelease([actual], {now: policy.selectedAt, minReleaseAgeMs: owner ? policy.policy.minReleaseAgeMs : Math.max(...roots.map(root => root.selection.policy.minReleaseAgeMs)), allowPrerelease: policy.policy.allowPrerelease, override: version});
        artifacts.push({locator: actual.locator, integrity: actual.integrity, filename: admitted.filename, localWheel: retainedLocalWheel(admitted)});
        requirements.push(`${name}==${version} --hash=sha256:${hash}`);
        components.push({id: `${roots.map(root => root.id).join("+")}:${name}`, name, version, ecosystem: "PyPI", source: "pypi", location: admitted.filename, selection});
        usedLocalWheels.add(admitted.name); continue;
      }
      const file = (release?.metadata?.files as any[] | undefined)?.find((file) => file.url === url);
      if (!file || file.digests?.sha256 !== hash || !file.filename.endsWith(".whl")) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", `Python report and registry disagree for ${name}@${version}.`);
      const actual = { ...release!, locator: url, integrity: `sha256-${Buffer.from(hash, "hex").toString("base64")}`, publishedAt: String(file.upload_time_iso_8601 ?? ""), yanked: Boolean(file.yanked || entry.is_yanked) };
      const policy = owner?.selection ?? roots[0]!.selection;
      const selection = selectRuntimeRelease([actual], { now: policy.selectedAt, minReleaseAgeMs: owner ? policy.policy.minReleaseAgeMs : Math.max(...roots.map((root) => root.selection.policy.minReleaseAgeMs)), allowPrerelease: policy.policy.allowPrerelease, override: version });
      if (owner && owner.selection.release.version !== version) throw new RuntimePolicyError("RUNTIME_ROOT_VERSION_MISMATCH", `Python changed selected ${name}.`);
      const simple = await runtimeJson(`https://pypi.org/simple/${encodeURIComponent(name)}/`, options, { headers: { accept: "application/vnd.pypi.simple.v1+json" } });
      const simpleFile = Array.isArray(simple.files) ? simple.files.find((candidate: any) => candidate.filename === file.filename) : undefined;
      const artifact: RuntimeArtifact = { locator: url, integrity: actual.integrity, filename: basename(file.filename) };
      if (simpleFile?.provenance) {
        const provenanceUrl = String(simpleFile.provenance), provenance = await runtimeJson(provenanceUrl, options);
        if (!Array.isArray(provenance.attestation_bundles) || !provenance.attestation_bundles.length) throw new RuntimePolicyError("RUNTIME_ATTESTATION_INVALID", `PyPI provenance has no publisher bundles for ${name}.`);
        const repositories = new Set<string>();
        for (const bundle of provenance.attestation_bundles) {
          const publisher = bundle.publisher, host = publisher?.kind === "GitHub" ? "github.com" : publisher?.kind === "GitLab" ? "gitlab.com" : undefined;
          if (!host || typeof publisher.repository !== "string" || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u.test(publisher.repository)) throw new RuntimePolicyError("RUNTIME_ATTESTATION_IDENTITY_MISSING", `PyPI publisher identity is unsupported or malformed for ${name}.`);
          repositories.add(`https://${host}/${publisher.repository}`);
        }
        if (repositories.size !== 1) throw new RuntimePolicyError("RUNTIME_ATTESTATION_IDENTITY_AMBIGUOUS", `PyPI provenance has multiple repository identities for ${name}.`);
        const repository = [...repositories][0]!;
        if (owner?.repository && repository.toLowerCase() !== `https://github.com/${owner.repository}`.toLowerCase()) throw new RuntimePolicyError("RUNTIME_ATTESTATION_IDENTITY_MISMATCH", `PyPI publisher for ${name} differs from the maintained runtime source.`);
        artifact.attestation = { provenanceUrl, repository, provenance, provenanceDigest: `sha256:${digestMetadata(provenance).value}` };
      }
      artifacts.push(artifact); requirements.push(`${name}==${version} --hash=sha256:${hash}`);
      components.push({ id: `${roots.map((root) => root.id).join("+")}:${name}`, name, version, ecosystem: "PyPI", source: "pypi", location: file.filename, selection });
    }
    if (localWheels.some(wheel => !usedLocalWheels.has(wheel.name))) throw new RuntimePolicyError("RUNTIME_LOCAL_WHEEL_UNUSED", "An admitted local wheel was not selected in the dependency graph.");
    for (const root of roots) if (!components.some((component) => component.name === root.name.toLowerCase().replace(/[-_.]+/gu, "-") && component.version === root.selection.release.version)) throw new RuntimePolicyError("RUNTIME_ROOT_MISSING", root.name);
    return { plan: { kind: "python", recipe: "ebo-python/v1", platform: options.platform, abi: bootstrap.abi, python: bootstrap.executable, bootstrap, artifacts, requirements }, components };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
