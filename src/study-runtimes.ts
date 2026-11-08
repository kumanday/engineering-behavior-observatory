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
  harnessPolicies?: Record<string, RuntimePolicy>; overrides?: Record<string, string>; target?: { platform: string; architecture: string } };
export type StudyRuntimeGroup = { id: string; roles: string[]; roots: SelectedRuntimeComponent[]; components: LockedRuntimeDependency[];
  plan: RuntimeInstallPlan; installation: { key: string; receiptDigest: Hash } };
export type StudyRuntimeLock = { schemaVersion: "ebo.study-runtime-lock/v1"; studyId: string; request: StudyRuntimeRequest; requestDigest: Hash;
  createdAt: string; target: { platform: string; architecture: string }; groups: StudyRuntimeGroup[]; security: RuntimeSecurityReceipt; digest: Hash };
export type StudyRuntimeOptions = RuntimeRegistryOptions & RuntimeSecurityOptions & { run?: RuntimeCommandRunner; python?: string; pythonAbi?: string; uv?: string };
export type RuntimeLaunch = { schemaVersion: "ebo.runtime-launch/v1"; lockDigest: Hash; role: string; runtimeRoot: string;
  roots: SelectedRuntimeComponent[]; security: RuntimeSecurityReceipt; warnings: string[]; receiptLocator: string };
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
  if (!request.studyId || !request.roles.length || new Set(request.roles).size !== request.roles.length) throw new RuntimePolicyError("RUNTIME_STUDY_INVALID", "A study ID and unique runtime roles are required.");
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
    const catalog = listRuntimeRecipes(target), groups: StudyRuntimeGroup[] = [], selected: { role: string; roots: SelectedRuntimeComponent[] }[] = [];
    for (const role of request.roles) {
      const recipe = catalog.find((recipe) => recipe.id === role);
      if (!recipe) throw new RuntimePolicyError("RUNTIME_ROLE_UNKNOWN", `Unknown maintained execution role ${role}.`);
      const roots: SelectedRuntimeComponent[] = [];
      for (const [index, component] of recipe.components.entries()) {
        const policy = { ...request.policy, ...request.harnessPolicies?.[recipe.harness ?? role] };
        const override = request.overrides?.[component.id] ?? (index === 0 ? request.overrides?.[role] : undefined) ?? policy.override;
        const releases = await fetchRuntimeReleases(component, options);
        roots.push({ ...component, selection: selectRuntimeRelease(releases, { ...policy, ...(override ? { override } : {}), now: createdAt }) });
      }
      selected.push({ role, roots });
    }
    // Harbor and Smol share one Python interpreter and a jointly resolved dependency graph.
    const python = selected.filter((entry) => entry.roots.every((root) => root.source === "pypi"));
    const compositions = selected.filter((entry) => !python.includes(entry)).map((entry) => ({ roles: [entry.role], roots: entry.roots }));
    if (python.length) compositions.push({ roles: python.map((entry) => entry.role), roots: python.flatMap((entry) => entry.roots) });
    for (const composition of compositions) {
      const { roots, roles } = composition;
      let plan: RuntimeInstallPlan, components: LockedRuntimeDependency[];
      const platform = `${target.platform}-${target.architecture}`;
      if (roots.every((root) => root.source === "npm")) ({ plan, components } = await resolveNpmRuntimePlan(roots, { ...options, platform, abi: `node-${process.versions.node}-modules-${process.versions.modules}` }));
      else if (roots.every((root) => root.source === "pypi")) ({ plan, components } = await resolvePythonRuntimePlan(roots, { ...options, python: options.python ?? "python3", platform, abi: options.pythonAbi ?? "python-bootstrap" }));
      else {
        if (roots.length !== 1) throw new RuntimePolicyError("RUNTIME_RECIPE_INVALID", "Artifact runtimes require one root.");
        const root = roots[0]!, release = root.selection.release;
        components = [{ id: root.id, name: root.name, version: release.version, source: root.source, location: release.locator, selection: root.selection,
          ...(root.ecosystem ? { ecosystem: root.ecosystem } : { purl: root.purl! }) }];
        if (root.source === "oci") {
          const manifest = release.metadata?.manifest as any;
          plan = { kind: "oci", recipe: "ebo-oci/v1", platform: `${root.platform}-${root.architecture}`, abi: "oci", image: release.locator, configDigest: manifest.config.digest, layerDigests: manifest.layers.map((layer: any) => layer.digest) };
        } else plan = { kind: "binary", recipe: "ebo-binary/v1", platform, abi: "native", artifact: { locator: release.locator, integrity: release.integrity, filename: "runtime.tar.gz" }, archive: "tar.gz" };
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
  } finally { await unlock(); }
}

/** Rechecks withdrawal, integrity and OSV without changing the frozen selection. */
export async function prepareRuntimeLaunch(studyRoot: string, role: string, options: StudyRuntimeOptions = {}): Promise<RuntimeLaunch> {
  const lock = await readStudyRuntimeLock(studyRoot), group = lock.groups.find((group) => group.roles.includes(role));
  if (!group) throw new RuntimePolicyError("RUNTIME_ROLE_NOT_FROZEN", `Study has no frozen ${role} runtime.`);
  const locations = paths(studyRoot), warnings: string[] = [], metadata = new Map<string, Awaited<ReturnType<typeof fetchRuntimeReleases>>>();
  for (const component of lock.groups.flatMap((group) => group.components)) {
    const recipe = lock.groups.flatMap((group) => group.roots).find((root) => root.name === component.name && root.source === component.source);
    const key = `${component.source}:${component.name}`;
    if (!metadata.has(key)) metadata.set(key, await fetchRuntimeReleases(recipe ?? { source: component.source, name: component.name }, options));
    const current = metadata.get(key)!.find((release) => release.version === component.version);
    if (!current || current.yanked || current.unpublished || current.malicious || current.draft) throw new RuntimePolicyError("RUNTIME_RELEASE_WITHDRAWN", `${component.name}@${component.version} is unavailable, yanked, draft or malicious.`);
    if (component.source === "npm" && (current.integrity !== component.selection.release.integrity || current.locator !== component.selection.release.locator)) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", `Registry changed ${component.name}@${component.version}.`);
    if (current.deprecated) warnings.push(`RUNTIME_DEPRECATED: ${component.name}@${component.version}: ${current.deprecated}`);
  }
  const security = await checkRuntimeSecurity(lock.groups.flatMap((group) => group.components), options);
  const runtimeRoot = join(locations.cache, group.installation.key), receipt = await verifyInstalledRuntime(runtimeRoot, group.plan);
  if (hash(receipt) !== group.installation.receiptDigest) throw new RuntimePolicyError("RUNTIME_CACHE_INTEGRITY", "Installation receipt differs from the study freeze.");
  const receiptLocator = `runtimes/launches/${randomUUID()}.json`;
  const launch: RuntimeLaunch = { schemaVersion: "ebo.runtime-launch/v1", lockDigest: lock.digest, role, runtimeRoot, roots: group.roots, security, warnings: [...warnings, ...security.warnings], receiptLocator };
  await mkdir(locations.receipts, { recursive: true, mode: 0o700 });
  await writeFile(join(resolve(studyRoot), receiptLocator), canonicalizeMetadata(launch), { flag: "wx", mode: 0o600 }); return launch;
}
