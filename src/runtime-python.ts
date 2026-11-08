import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { basename, join } from "node:path";
import type { ArtifactInstallPlan, RuntimeArtifact } from "./runtime-artifacts.js";
import { runRuntimeCommand, type RuntimeCommandRunner } from "./runtime-installation.js";
import { fetchRuntimeReleases, runtimeJson, type RuntimeRegistryOptions } from "./runtime-registry.js";
import { RuntimePolicyError, selectRuntimeRelease } from "./runtime-resolution.js";
import type { SelectedRuntimeComponent, LockedRuntimeDependency } from "./runtime-npm.js";
import { assertPythonTarget, probePythonBootstrap } from "./runtime-bootstrap.js";

export async function resolvePythonRuntimePlan(roots: readonly SelectedRuntimeComponent[], options: RuntimeRegistryOptions & {
  python: string; uv?: string; platform: string; abi?: string; run?: RuntimeCommandRunner;
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
    const input = join(staging, "requirements.in"), frozen = join(staging, "requirements.txt"), report = join(staging, "report.json");
    await writeFile(input, roots.map((root) => `${root.name}==${root.selection.release.version}`).join("\n") + "\n", { mode: 0o600 });
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
        let repository = owner?.repository;
        if (!repository) {
          const detail = await runtimeJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`, options);
          const source = Object.entries(detail.info?.project_urls ?? {})
            .filter(([label]) => /^(?:source(?:[ _-]?(?:code|repository))?|repository|code|home[ _-]?page)$/iu.test(label))
            .sort(([a], [b]) => Number(/^home/iu.test(a)) - Number(/^home/iu.test(b)))
            .map(([, value]) => value)
            .find((value) => typeof value === "string" && /^https:\/\/github.com\/(?!sponsors\/|orgs\/)[^/?#]+\/[^/?#]+\/?$/u.test(value));
          repository = typeof source === "string" ? new URL(source).pathname.replace(/^\/|\/$/gu, "") : undefined;
        }
        if (!repository) throw new RuntimePolicyError("RUNTIME_ATTESTATION_IDENTITY_MISSING", `Offered PyPI attestation lacks a repository identity for ${name}.`);
        artifact.attestation = { provenanceUrl: String(simpleFile.provenance), repository: `https://github.com/${repository}` };
      }
      artifacts.push(artifact); requirements.push(`${name}==${version} --hash=sha256:${hash}`);
      components.push({ id: `${roots.map((root) => root.id).join("+")}:${name}`, name, version, ecosystem: "PyPI", source: "pypi", location: file.filename, selection });
    }
    for (const root of roots) if (!components.some((component) => component.name === root.name.toLowerCase().replace(/[-_.]+/gu, "-") && component.version === root.selection.release.version)) throw new RuntimePolicyError("RUNTIME_ROOT_MISSING", root.name);
    return { plan: { kind: "python", recipe: "ebo-python/v1", platform: options.platform, abi: bootstrap.abi, python: bootstrap.executable, bootstrap, artifacts, requirements }, components };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
