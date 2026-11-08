import { refreshFrozenRuntimeRelease } from "./runtime-status.js";
import {assertStudyRuntimeRequest} from "./runtime-request.js";
import {discoverArtifactProofs} from "./runtime-proofs.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { canonicalizeMetadata, digestMetadata } from "./artifacts.js";
import { listRuntimeRecipes } from "./runtime-catalog.js";
import { installRuntime, verifyInstalledRuntime, type RuntimeCommandRunner, type RuntimeInstallPlan } from "./runtime-installation.js";
import { resolveNpmRuntimePlan, type SelectedRuntimeComponent, type LockedRuntimeDependency } from "./runtime-npm.js";
import { resolvePythonRuntimePlan } from "./runtime-python.js";
import { fetchRuntimeReleases, type RuntimeRegistryOptions } from "./runtime-registry.js";
import { RuntimePolicyError, selectRuntimeRelease, type RuntimePolicy } from "./runtime-resolution.js";
import { checkRuntimeSecurity, type RuntimeSecurityOptions, type RuntimeSecurityReceipt } from "./runtime-security.js";

type Hash = `sha256:${string}`;
export type StudyRuntimeRequest = { studyId: string; roles: string[]; policy?: RuntimePolicy;
  harnessPolicies?: Record<string, RuntimePolicy>; overrides?: Record<string, string>; roleTargets?: Record<string, {platform: string; architecture: string}>; target?: { platform: string; architecture: string } };
export type StudyRuntimeGroup = { id: string; roles: string[]; roots: SelectedRuntimeComponent[]; components: LockedRuntimeDependency[];
  plan: RuntimeInstallPlan; installation: { key: string; receiptDigest: Hash } };
export type StudyRuntimeLock = { schemaVersion: "ebo.study-runtime-lock/v1"; studyId: string; request: StudyRuntimeRequest; requestDigest: Hash;
  createdAt: string; target: { platform: string; architecture: string }; groups: StudyRuntimeGroup[]; security: RuntimeSecurityReceipt; digest: Hash };
export type StudyRuntimeOptions = RuntimeRegistryOptions & RuntimeSecurityOptions & { run?: RuntimeCommandRunner; python?: string; pythonAbi?: string; uv?: string };
export type RuntimeLaunch = { schemaVersion: "ebo.runtime-launch/v1"; lockDigest: Hash; role: string; runtimeRoot: string;
  roots: SelectedRuntimeComponent[]; platform: string; abi: string; security: RuntimeSecurityReceipt; warnings: string[]; receiptLocator: string };
const hash = (value: unknown): Hash => `sha256:${digestMetadata(value).value}`;
const paths = (root: string) => ({ lock: join(resolve(root), "runtimes", "lock.json"), cache: join(resolve(root), "runtimes", "cache"), receipts: join(resolve(root), "runtimes", "launches") });
const withoutDigest = (lock: StudyRuntimeLock): Omit<StudyRuntimeLock, "digest"> => { const { digest: _digest, ...value } = lock; return value; };
export async function readStudyRuntimeLock(studyRoot: string): Promise<StudyRuntimeLock> {
  const lock = JSON.parse(await readFile(paths(studyRoot).lock, "utf8")) as StudyRuntimeLock;
  if (lock.schemaVersion !== "ebo.study-runtime-lock/v1" || !Array.isArray(lock.groups) || hash(withoutDigest(lock)) !== lock.digest || hash(lock.request) !== lock.requestDigest) throw new RuntimePolicyError("RUNTIME_LOCK_INTEGRITY", "Study runtime lock is malformed or changed.");
  return lock;
}
/** Idempotent freeze. A different policy or composition requires a new study revision. */
export async function freezeStudyRuntimes(studyRoot: string, request: StudyRuntimeRequest, options: StudyRuntimeOptions = {}): Promise<StudyRuntimeLock> {
  assertStudyRuntimeRequest(request);
  const locations = paths(studyRoot); await mkdir(join(resolve(studyRoot), "runtimes"), { recursive: true, mode: 0o700 });
  const unlock = await lockfile.lock(locations.lock, { realpath: false, stale: 120_000, update: 30_000, retries: { retries: 300, factor: 1, minTimeout: 100, maxTimeout: 1000 } });
  try {
    try {
      const retained = await readStudyRuntimeLock(studyRoot);
      if (retained.requestDigest !== hash(request)) throw new RuntimePolicyError("RUNTIME_STUDY_FROZEN", "Runtime policy/composition differs from the frozen study; create a new study revision.");
      return retained;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const createdAt = (options.now ?? (() => new Date().toISOString()))();
    const target = request.target ?? { platform: process.platform, architecture: process.arch };
    const groups: StudyRuntimeGroup[] = [], selected: { role: string; roots: SelectedRuntimeComponent[]; target: typeof target }[] = [];
    for (const role of request.roles) {
      const roleTarget = request.roleTargets?.[role] ?? target;
      const recipe = listRuntimeRecipes(roleTarget).find((recipe) => recipe.id === role);
      if (!recipe) throw new RuntimePolicyError("RUNTIME_ROLE_UNKNOWN", `Unknown maintained execution role ${role}.`);
      const roots: SelectedRuntimeComponent[] = [];
      for (const [index, component] of recipe.components.entries()) {
        const policy = { ...request.policy, ...request.harnessPolicies?.[recipe.harness ?? role] };
        const override = request.overrides?.[component.id] ?? (index === 0 ? request.overrides?.[role] ?? policy.override : undefined);
        const releases = await fetchRuntimeReleases(component, options);
        roots.push({ ...component, selection: selectRuntimeRelease(releases, { ...policy, override, now: createdAt }) });
      }
      selected.push({ role, roots, target: roleTarget });
    }
    // Harbor and Smol share one Python interpreter and a jointly resolved dependency graph.
    const python = selected.filter((entry) => entry.roots.every((root) => root.source === "pypi"));
    const compositions = selected.filter((entry) => !python.includes(entry)).map((entry) => ({ roles: [entry.role], roots: entry.roots, target: entry.target }));
    const pythonTargets = new Map<string, typeof python>();
    for (const entry of python) {
      const key = `${entry.target.platform}-${entry.target.architecture}`;
      if (!pythonTargets.has(key)) pythonTargets.set(key, []);
      pythonTargets.get(key)!.push(entry);
    }
    for (const entries of pythonTargets.values()) compositions.push({ roles: entries.map((entry) => entry.role), roots: entries.flatMap((entry) => entry.roots), target: entries[0]!.target });
    for (const composition of compositions) {
      const { roots, roles } = composition;
      let plan: RuntimeInstallPlan, components: LockedRuntimeDependency[];
      const platform = `${composition.target.platform}-${composition.target.architecture}`;
      if (roots.every((root) => root.source === "npm")) ({ plan, components } = await resolveNpmRuntimePlan(roots, { ...options, platform, abi: `node-${process.versions.node}-modules-${process.versions.modules}` }));
      else if (roots.every((root) => root.source === "pypi")) ({ plan, components } = await resolvePythonRuntimePlan(roots, { ...options, python: options.python ?? process.env.EBO_RUNTIME_PYTHON ?? "python3", platform, ...(options.pythonAbi ? {abi: options.pythonAbi} : {}) }));
      else {
        if (roots.length !== 1) throw new RuntimePolicyError("RUNTIME_RECIPE_INVALID", "Artifact runtimes require one root.");
        const root = roots[0]!, release = root.selection.release;
        const publisherProofs = await discoverArtifactProofs(root, release, options);
        components = [{ id: root.id, name: root.name, version: release.version, source: root.source, location: release.locator, selection: root.selection,
          ...(root.ecosystem ? { ecosystem: root.ecosystem } : { purl: root.purl! }) }];
        if (root.source === "oci") {
          const manifest = release.metadata?.manifest as any;
          plan = { kind: "oci", recipe: "ebo-oci/v1", platform: `${root.platform}-${root.architecture}`, abi: "oci", image: release.locator, configDigest: manifest.config.digest, layerDigests: manifest.layers.map((layer: any) => layer.digest), publisherProofs };
        } else plan = { kind: "binary", recipe: "ebo-binary/v1", platform, abi: "native", artifact: { locator: release.locator, integrity: release.integrity, filename: "runtime.tar.gz" }, archive: "tar.gz", publisherProofs };
      }
      // Check the whole graph before any package can be loaded or executed.
      await checkRuntimeSecurity(components, options);
      const installed = await installRuntime(plan, { ...options, cacheRoot: locations.cache });
      groups.push({ id: roles.join("+"), roles, roots, components, plan, installation: { key: installed.key, receiptDigest: hash(installed.receipt) } });
    }
    const security = await checkRuntimeSecurity(groups.flatMap((group) => group.components), options);
    const value: Omit<StudyRuntimeLock, "digest"> = { schemaVersion: "ebo.study-runtime-lock/v1", studyId: request.studyId, request: structuredClone(request), requestDigest: hash(request), createdAt, target, groups, security };
    const lock = { ...value, digest: hash(value) };
    await writeFile(locations.lock, canonicalizeMetadata(lock), { flag: "wx", mode: 0o600 }); return lock;
  } catch (error) {
    if (error instanceof RuntimePolicyError && error.receipt) {
      const failures = join(resolve(studyRoot), "runtimes", "resolution-failures"); await mkdir(failures, { recursive: true, mode: 0o700 });
      await writeFile(join(failures, `${randomUUID()}.json`), canonicalizeMetadata({ schemaVersion: "ebo.runtime-resolution-failure/v1", requestDigest: hash(request), code: error.code, security: error.receipt }), { flag: "wx", mode: 0o600 });
    }
    throw error;
  } finally { await unlock(); }
}

/** Rechecks withdrawal, integrity and OSV without changing the frozen selection. */
export async function prepareRuntimeLaunch(studyRoot: string, role: string, options: StudyRuntimeOptions = {}): Promise<RuntimeLaunch> {
  const lock = await readStudyRuntimeLock(studyRoot), group = lock.groups.find((group) => group.roles.includes(role));
  if (!group) throw new RuntimePolicyError("RUNTIME_ROLE_NOT_FROZEN", `Study has no frozen ${role} runtime.`);
  const locations = paths(studyRoot), warnings: string[] = [];
  const receiptLocator = `runtimes/launches/${randomUUID()}.json`;
  await mkdir(locations.receipts, { recursive: true, mode: 0o700 });
  try {
  const components = lock.groups.flatMap((owner) => owner.components.map((component) => ({owner, component})));
  const checked = new Map<string, Awaited<ReturnType<typeof refreshFrozenRuntimeRelease>>>();
  for (let offset = 0; offset < components.length; offset += 16) {
    const results = await Promise.allSettled(components.slice(offset, offset + 16).map(async ({owner, component}) => {
      const recipe = owner.roots.find((root) => root.name === component.name && root.source === component.source);
      const key = `${component.source}:${component.name}:${component.version}:${component.selection.release.locator}`;
      const current = checked.get(key) ?? await refreshFrozenRuntimeRelease(recipe ?? {source: component.source, name: component.name}, component.selection.release, options);
      checked.set(key, current);
      const isRoot = recipe?.selection.release.version === component.version && (component.source !== "npm" || component.location === `node_modules/${component.name}`);
      return current.deprecated ? `${isRoot ? "RUNTIME_DEPRECATED" : "RUNTIME_DEPENDENCY_DEPRECATED"}: ${component.name}@${component.version}: ${current.deprecated}` : undefined;
    }));
    for (const result of results) {if (result.status === "rejected") throw result.reason; if (result.value) warnings.push(result.value);}
  }
  const security = await checkRuntimeSecurity(lock.groups.flatMap((group) => group.components), options);
  const runtimeRoot = join(locations.cache, group.installation.key), receipt = await verifyInstalledRuntime(runtimeRoot, group.plan, options);
  if (hash(receipt) !== group.installation.receiptDigest) throw new RuntimePolicyError("RUNTIME_CACHE_INTEGRITY", "Installation receipt differs from the study freeze.");
  const launch: RuntimeLaunch = { schemaVersion: "ebo.runtime-launch/v1", lockDigest: lock.digest, role, runtimeRoot, roots: group.roots, platform: group.plan.platform, abi: group.plan.abi, security, warnings: [...warnings, ...security.warnings], receiptLocator };
  await mkdir(locations.receipts, { recursive: true, mode: 0o700 });
  await writeFile(join(resolve(studyRoot), receiptLocator), canonicalizeMetadata(launch), { flag: "wx", mode: 0o600 }); return launch;
  } catch (error) {
    await writeFile(join(resolve(studyRoot), receiptLocator), canonicalizeMetadata({ schemaVersion: "ebo.runtime-launch/v1", status: "blocked", lockDigest: lock.digest, role,
      checkedAt: (options.now ?? (() => new Date().toISOString()))(), code: error instanceof RuntimePolicyError ? error.code : "RUNTIME_LAUNCH_FAILED",
      security: error instanceof RuntimePolicyError ? error.receipt ?? null : null, error: error instanceof Error ? error.message : String(error) }), { flag: "wx", mode: 0o600 });
    throw error;
  }
}
