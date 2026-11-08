import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalizeMetadata } from "./artifacts.js";
import type { RuntimeComponentRecipe } from "./runtime-catalog.js";
import { runRuntimeCommand, type RuntimeCommandRunner, type NpmRuntimeInstallPlan } from "./runtime-installation.js";
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
    await writeFile(join(staging, "package.json"), canonicalizeMetadata(packageJson), { mode: 0o600 });
    const cutoff = roots.map((root) => root.selection.cutoff).sort()[0]!;
    const result = await (options.run ?? runRuntimeCommand)(join(dirname(process.execPath), "npm"), ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", `--before=${cutoff}`,
      "--userconfig=/dev/null", "--globalconfig=/dev/null", "--registry=https://registry.npmjs.org"], staging);
    if (result.code !== 0) throw new RuntimePolicyError("RUNTIME_DEPENDENCY_RESOLUTION_FAILED", result.stderr.slice(0, 2000));
    const packageLock = JSON.parse(await readFile(join(staging, "package-lock.json"), "utf8")) as { lockfileVersion: unknown; packages?: Record<string, any> };
    if (packageLock.lockfileVersion !== 3 || !packageLock.packages) throw new RuntimePolicyError("RUNTIME_DEPENDENCY_LOCK_INVALID", "npm did not produce a v3 exact dependency lock.");
    const components: LockedRuntimeDependency[] = [], metadata = new Map<string, Awaited<ReturnType<typeof fetchRuntimeReleases>>>();
    for (const [location, entry] of Object.entries(packageLock.packages)) {
      if (!location) continue;
      const name = location.split("node_modules/").at(-1)!;
      if (!entry || typeof entry.version !== "string" || entry.link || !location.startsWith("node_modules/") || location.includes("..")) throw new RuntimePolicyError("RUNTIME_DEPENDENCY_LOCK_INVALID", `Non-registry package ${location}.`);
      if (!metadata.has(name)) metadata.set(name, await fetchRuntimeReleases({ source: "npm", name }, options));
      const owner = roots.find((root) => root.name === name);
      const policy = owner?.selection ?? roots[0]!.selection;
      const selection = selectRuntimeRelease(metadata.get(name)!, { now: policy.selectedAt, minReleaseAgeMs: Math.max(...roots.map((root) => root.selection.policy.minReleaseAgeMs)),
        allowPrerelease: owner?.selection.policy.allowPrerelease ?? roots.some((root) => root.selection.policy.allowPrerelease), override: entry.version });
      if (selection.release.integrity !== entry.integrity || selection.release.locator !== entry.resolved) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", `npm lock and registry disagree for ${name}@${entry.version}.`);
      if (!owner && selection.release.deprecated) throw new RuntimePolicyError("RUNTIME_DEPENDENCY_DEPRECATED", `Dependency ${name}@${entry.version} is deprecated; resolve a compatible closure before freezing.`);
      if (owner && owner.selection.release.version !== entry.version) throw new RuntimePolicyError("RUNTIME_ROOT_VERSION_MISMATCH", `npm changed selected ${name}.`);
      components.push({ id: `${roots.map((root) => root.id).join("+")}:${location}`, source: "npm", name, ecosystem: "npm", version: entry.version, location, selection });
    }
    for (const root of roots) if (!components.some((component) => component.location === `node_modules/${root.name}` && component.version === root.selection.release.version)) throw new RuntimePolicyError("RUNTIME_ROOT_MISSING", root.name);
    return { plan: { kind: "npm", platform: options.platform, abi: options.abi, recipe: "ebo-npm/v1", packageJson, packageLock,
      verifyRegistryProofs: components.some((component) => (component.selection.release.proofs?.length ?? 0) > 0) }, components };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
