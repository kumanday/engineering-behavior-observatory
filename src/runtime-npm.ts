import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalizeMetadata } from "./artifacts.js";
import type { RuntimeComponentRecipe } from "./runtime-catalog.js";
import { npmRuntimeTargetArguments, runtimeNpmConfiguration, runRuntimeCommand, type RuntimeCommandRunner, type NpmRuntimeInstallPlan } from "./runtime-installation.js";
import { fetchRuntimeReleases, type RuntimeRegistryOptions } from "./runtime-registry.js";
import { RuntimePolicyError, selectRuntimeRelease, type RuntimeSelection } from "./runtime-resolution.js";
import type { RuntimeSecurityComponent } from "./runtime-security.js";

export type SelectedRuntimeComponent = RuntimeComponentRecipe & { selection: RuntimeSelection };
export type LockedRuntimeDependency = RuntimeSecurityComponent & { source: "npm" | "pypi" | "github" | "vendor" | "oci";
  location: string; selection: RuntimeSelection };
export async function resolveNpmRuntimePlan(roots: readonly SelectedRuntimeComponent[], options: RuntimeRegistryOptions & {
  platform: string; abi: string; run?: RuntimeCommandRunner;
}): Promise<{ plan: NpmRuntimeInstallPlan; components: LockedRuntimeDependency[] }> {
  if (!roots.length || roots.some((root) => root.source !== "npm")) throw new RuntimePolicyError("RUNTIME_RECIPE_INVALID", "npm resolution requires npm roots.");
  const dependencies: Record<string, string> = {};
  for (const root of roots) {
    if (dependencies[root.name] && dependencies[root.name] !== root.selection.release.version) throw new RuntimePolicyError("RUNTIME_RECIPE_CONFLICT", `Different versions of ${root.name} require separate runtime groups.`);
    dependencies[root.name] = root.selection.release.version;
  }
  const packageJson = { name: "ebo-study-runtime", version: "1.0.0", private: true, dependencies };
  const staging = await mkdtemp(join(tmpdir(), "ebo-runtime-resolve-"));
  try {
    // The global cutoff constrains dependency resolution. Each already-selected
    // root has its own cutoff, so fetch that exact tarball without filtering it
    // through another root's policy. The returned install plan uses exact versions.
    const rootTarballs = Object.fromEntries(roots.map((root) => {
      const url = new URL(root.selection.release.locator);
      if (url.protocol !== "https:" || url.username || url.password) throw new RuntimePolicyError("RUNTIME_ARTIFACT_INVALID", "npm root tarballs require HTTPS without URL credentials.");
      return [root.name, url.href];
    }));
    await writeFile(join(staging, "package.json"), canonicalizeMetadata({...packageJson, dependencies: rootTarballs}), { mode: 0o600 });
    const cutoff = roots.map((root) => root.selection.cutoff).sort()[0]!;
    // npm 12 requires an explicit opt-in for the selected HTTPS tarball roots.
    // Resolution runs no scripts; every resulting URL/hash is checked below.
    const result = await (options.run ?? runRuntimeCommand)(join(dirname(process.execPath), "npm"), ["install", "--package-lock-only", "--allow-remote", "--ignore-scripts", "--no-audit", "--no-fund", `--before=${cutoff}`,
      ...npmRuntimeTargetArguments(options.platform), ...await runtimeNpmConfiguration(staging)], staging);
    if (result.code !== 0) throw new RuntimePolicyError("RUNTIME_DEPENDENCY_RESOLUTION_FAILED", result.stderr.slice(0, 2000));
    const packageLock = JSON.parse(await readFile(join(staging, "package-lock.json"), "utf8")) as { lockfileVersion: unknown; packages?: Record<string, any> };
    if (packageLock.lockfileVersion !== 3 || !packageLock.packages) throw new RuntimePolicyError("RUNTIME_DEPENDENCY_LOCK_INVALID", "npm did not produce a v3 exact dependency lock.");
    if (!packageLock.packages[""]) throw new RuntimePolicyError("RUNTIME_DEPENDENCY_LOCK_INVALID", "npm lock lacks its root manifest.");
    packageLock.packages[""].dependencies = {...dependencies};
    const components: LockedRuntimeDependency[] = [], metadata = new Map<string, Awaited<ReturnType<typeof fetchRuntimeReleases>>>();
    for (const [location, entry] of Object.entries(packageLock.packages)) {
      if (!location) continue;
      if (!entry || typeof entry.version !== "string" || entry.link || !location.startsWith("node_modules/") || location.includes("..")) throw new RuntimePolicyError("RUNTIME_DEPENDENCY_LOCK_INVALID", `Non-registry package ${location}.`);
      // npm aliases retain the install key in location and the registry identity in name.
      const name = typeof entry.name === "string" ? entry.name : location.split("node_modules/").at(-1)!;
      if (!metadata.has(name)) metadata.set(name, await fetchRuntimeReleases({ source: "npm", name }, options));
      const owner = roots.find((root) => location === `node_modules/${root.name}`);
      if (owner && owner.name !== name) throw new RuntimePolicyError("RUNTIME_ROOT_VERSION_MISMATCH", `npm changed selected package identity ${owner.name}.`);
      const variant = !owner && Array.isArray(entry.os) && entry.os.length > 0 && Array.isArray(entry.cpu) && entry.cpu.length > 0
        ? roots.find(root => root.name === name && entry.os.some((os: unknown) => typeof os === "string" && entry.cpu.some((cpu: unknown) => typeof cpu === "string" && entry.version === `${root.selection.release.version}-${os}-${cpu}`))) : undefined;
      const policy = owner?.selection ?? roots[0]!.selection;
      const selection = selectRuntimeRelease(metadata.get(name)!, { now: policy.selectedAt, minReleaseAgeMs: owner ? policy.policy.minReleaseAgeMs : Math.max(...roots.map((root) => root.selection.policy.minReleaseAgeMs)),
        allowPrerelease: owner?.selection.policy.allowPrerelease ?? (Boolean(variant) || roots.some((root) => root.selection.policy.allowPrerelease)), override: entry.version });
      if (variant) selection.release.metadata = {...selection.release.metadata, nativeBuildVariantOf: {name: variant.name, version: variant.selection.release.version}};
      if (selection.release.integrity !== entry.integrity || selection.release.locator !== entry.resolved) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", `npm lock and registry disagree for ${name}@${entry.version}.`);
      if (!owner && selection.release.deprecated) selection.warnings = [`RUNTIME_DEPENDENCY_DEPRECATED: ${name}@${entry.version}: ${selection.release.deprecated}`];
      if (owner && owner.selection.release.version !== entry.version) throw new RuntimePolicyError("RUNTIME_ROOT_VERSION_MISMATCH", `npm changed selected ${name}.`);
      components.push({ id: `${roots.map((root) => root.id).join("+")}:${location}`, source: "npm", name, ecosystem: "npm", version: entry.version, location, selection });
    }
    for (const root of roots) if (!components.some((component) => component.location === `node_modules/${root.name}` && component.version === root.selection.release.version)) throw new RuntimePolicyError("RUNTIME_ROOT_MISSING", root.name);
    return { plan: { kind: "npm", platform: options.platform, abi: options.abi, recipe: "ebo-npm/v1", packageJson, packageLock,
      verifyRegistryProofs: components.some((component) => (component.selection.release.proofs?.length ?? 0) > 0) }, components };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
