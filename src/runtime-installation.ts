import { installArtifactRuntime, type ArtifactInstallPlan } from "./runtime-artifacts.js";
import type { RuntimeFetch } from "./runtime-registry.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { canonicalizeMetadata, digestMetadata } from "./artifacts.js";
import { RuntimePolicyError } from "./runtime-resolution.js";

export type RuntimeCommandResult = { stdout: string; stderr: string; code: number | null };
export type RuntimeCommandRunner = (command: string, args: readonly string[], cwd: string) => Promise<RuntimeCommandResult>;
export type NpmRuntimeInstallPlan = { kind: "npm"; platform: string; abi: string; recipe: "ebo-npm/v1";
  packageJson: Record<string, unknown>; packageLock: Record<string, unknown>; verifyRegistryProofs?: boolean };
export type RuntimeInstallPlan = NpmRuntimeInstallPlan | ArtifactInstallPlan;
export type RuntimeInstallReceipt = { schemaVersion: "ebo.runtime-installation/v1"; planDigest: string; installedAt: string;
  inventory: { path: string; kind: "file" | "symlink"; digest: string; executable: boolean }[];
  proofs: { kind: string; result: unknown }[]; scripts: "disabled" };
export type InstalledRuntime = { root: string; key: string; receipt: RuntimeInstallReceipt };
const receiptName = ".ebo-runtime-receipt.json";
export const runtimePlanKey = (plan: RuntimeInstallPlan): string => digestMetadata(plan).value;
const execFileAsync = promisify(execFile);
export const runRuntimeCommand: RuntimeCommandRunner = async (command, args, cwd) => {
  const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: cwd, TMPDIR: cwd,
    LANG: "C.UTF-8", npm_config_ignore_scripts: "true", npm_config_update_notifier: "false", PIP_DISABLE_PIP_VERSION_CHECK: "1", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PIP_CONFIG_FILE: "/dev/null" };
  try { const result = await execFileAsync(command, [...args], { cwd, env, encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024 }); return { ...result, code: 0 }; }
  catch (error) { const result = error as { stdout?: string; stderr?: string; code?: unknown }; return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: typeof result.code === "number" ? result.code : -1 }; }
};
async function checkedCommand(run: RuntimeCommandRunner, command: string, args: readonly string[], cwd: string): Promise<RuntimeCommandResult> {
  const result = await run(command, args, cwd);
  if (result.code !== 0) throw new RuntimePolicyError("RUNTIME_INSTALL_FAILED", `${command} ${args[0]} failed (${result.code}): ${result.stderr.slice(0, 2000)}`);
  return result;
}
async function inventory(root: string): Promise<RuntimeInstallReceipt["inventory"]> {
  root = await realpath(root);
  const entries: RuntimeInstallReceipt["inventory"] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), locator = relative(root, path).split(sep).join("/");
      if (locator === receiptName) continue;
      const info = await lstat(path);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) entries.push({ path: locator, kind: "file", digest: createHash("sha256").update(await readFile(path)).digest("hex"), executable: Boolean(info.mode & 0o111) });
      else if (info.isSymbolicLink()) {
        const target = await readlink(path), resolved = await realpath(path), rel = relative(root, resolved);
        if (isAbsolute(target) || rel === ".." || rel.startsWith(`..${sep}`)) throw new RuntimePolicyError("RUNTIME_CACHE_INTEGRITY", `External runtime symlink: ${locator}.`);
        entries.push({ path: locator, kind: "symlink", digest: createHash("sha256").update(target).digest("hex"), executable: false });
      } else throw new RuntimePolicyError("RUNTIME_CACHE_INTEGRITY", `Unsupported installed file: ${locator}.`);
    }
  };
  await walk(root); return entries;
}
function validateNpmPlan(plan: NpmRuntimeInstallPlan): void {
  const lock = plan.packageLock as { lockfileVersion?: unknown; packages?: Record<string, any> };
  if (plan.recipe !== "ebo-npm/v1" || lock.lockfileVersion !== 3 || !lock.packages) throw new RuntimePolicyError("RUNTIME_INSTALL_PLAN_INVALID", "Expected an npm v3 dependency lock.");
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (!path.startsWith("node_modules/") || path.includes("..") || !pkg.version || !/^https:\/\//u.test(pkg.resolved ?? "") || !/^(?:sha512|sha256)-[A-Za-z0-9+/]+=*$/u.test(pkg.integrity ?? "") || pkg.link) throw new RuntimePolicyError("RUNTIME_INSTALL_PLAN_INVALID", `Package lacks exact registry integrity: ${path}.`);
  }
}
export async function verifyInstalledRuntime(root: string, plan: RuntimeInstallPlan, options: {run?: RuntimeCommandRunner} = {}): Promise<RuntimeInstallReceipt> {
  const receipt = JSON.parse(await readFile(join(root, receiptName), "utf8")) as RuntimeInstallReceipt;
  if (receipt.schemaVersion !== "ebo.runtime-installation/v1" || receipt.planDigest !== runtimePlanKey(plan) || canonicalizeMetadata(receipt.inventory) !== canonicalizeMetadata(await inventory(root))) throw new RuntimePolicyError("RUNTIME_CACHE_INTEGRITY", "Installed runtime differs from its frozen plan or inventory.");
  if (plan.kind === "oci") {
    const result = await (options.run ?? runRuntimeCommand)("docker", ["image", "inspect", plan.image], root);
    if (result.code !== 0) throw new RuntimePolicyError("RUNTIME_IMAGE_UNAVAILABLE", "The frozen image is absent from Docker; prepare that exact digest again.");
    let actual: any; try {actual = JSON.parse(result.stdout);} catch {throw new RuntimePolicyError("RUNTIME_PROBE_INVALID", "Docker image inspect returned malformed JSON.");}
    if (actual[0]?.Id !== plan.configDigest) throw new RuntimePolicyError("RUNTIME_INTEGRITY_MISMATCH", "Docker's actual image config differs from the frozen manifest.");
  }
  return receipt;
}
export async function installRuntime(plan: RuntimeInstallPlan, options: { cacheRoot: string; run?: RuntimeCommandRunner; fetch?: RuntimeFetch }): Promise<InstalledRuntime> {
  if (plan.kind === "npm") validateNpmPlan(plan);
  const cache = resolve(options.cacheRoot), key = runtimePlanKey(plan), root = join(cache, key);
  await mkdir(cache, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(root, { realpath: false, stale: 120_000, update: 30_000, retries: { retries: 300, factor: 1, minTimeout: 100, maxTimeout: 1000 } });
  let staging: string | undefined;
  try {
    try { await lstat(root); return { root, key, receipt: await verifyInstalledRuntime(root, plan, options) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    staging = await mkdtemp(join(cache, ".runtime-partial-"));
    const run = options.run ?? runRuntimeCommand;
    let proofs: RuntimeInstallReceipt["proofs"];
    if (plan.kind === "npm") {
    await writeFile(join(staging, "package.json"), canonicalizeMetadata(plan.packageJson), { mode: 0o600 });
    await writeFile(join(staging, "package-lock.json"), canonicalizeMetadata(plan.packageLock), { mode: 0o600 });
    const npm = join(dirname(process.execPath), "npm");
    const config = await runtimeNpmConfiguration(staging);
    await checkedCommand(run, npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund", ...config], staging);
    proofs = [];
    if (plan.verifyRegistryProofs) {
      const result = await checkedCommand(run, npm, ["audit", "signatures", "--json", "--ignore-scripts", ...config], staging);
      proofs.push({ kind: "npm-signatures-and-attestations", result: JSON.parse(result.stdout) });
    } else proofs.push({ kind: "registry-proofs", result: { status: "not-offered" } });
    await rm(join(staging, ".npm"), { recursive: true, force: true });
    } else proofs = await installArtifactRuntime(plan, staging, root, run, options.fetch);
    const receipt: RuntimeInstallReceipt = { schemaVersion: "ebo.runtime-installation/v1", planDigest: key, installedAt: new Date().toISOString(),
      inventory: await inventory(staging), proofs, scripts: "disabled" };
    await writeFile(join(staging, receiptName), canonicalizeMetadata(receipt), { mode: 0o600 });
    await rename(staging, root); staging = undefined;
    return { root, key, receipt };
  } finally { if (staging) await rm(staging, { recursive: true, force: true }); await release(); }
}

export async function runtimeNpmConfiguration(directory: string): Promise<string[]> {
  const user = join(directory, ".ebo-npm-user.rc"), global = join(directory, ".ebo-npm-global.rc");
  await writeFile(user, "", { mode: 0o600 }); await writeFile(global, "", { mode: 0o600 });
  return [`--userconfig=${user}`, `--globalconfig=${global}`, "--registry=https://registry.npmjs.org"];
}
