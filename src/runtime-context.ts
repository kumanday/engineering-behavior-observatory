import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalizeMetadata } from "./artifacts.js";
import { RuntimePolicyError } from "./runtime-resolution.js";
import { prepareRuntimeLaunch, type RuntimeLaunch, type StudyRuntimeOptions } from "./study-runtimes.js";
import { runRuntimeCommand } from "./runtime-installation.js";

export type RuntimeProbe = { componentId: string; package: string; expectedVersion: string; actualVersion: string; source: "package-metadata" | "executable" | "server-info" };
export type StudyRuntimeContext = { studyRoot: string; launch: RuntimeLaunch; modules: Map<string, Record<string, any>>;
  packages: Map<string, { root: string; metadata: Record<string, any> }>; options: StudyRuntimeOptions; probes: RuntimeProbe[] };
const storage = new AsyncLocalStorage<StudyRuntimeContext>();
export const currentStudyRuntime = (): StudyRuntimeContext | undefined => storage.getStore();
export function studyRuntimeModule<T>(specifier: string, developmentModule: T): T {
  const context = currentStudyRuntime();
  if (!context) return developmentModule;
  const module = context.modules.get(specifier);
  if (!module) throw new RuntimePolicyError("RUNTIME_SDK_NOT_FROZEN", `${specifier} is absent from ${context.launch.role}.`);
  return module as T;
}
export function studyRuntimeVersion(name: string, developmentVersion: string): string {
  return currentStudyRuntime()?.packages.get(name)?.metadata.version ?? developmentVersion;
}
export function assertRuntimeProbe(componentId: string, expected: string, actual: string): void {
  if (actual !== expected) throw new RuntimePolicyError("RUNTIME_PROBE_MISMATCH", `${componentId}: expected ${expected}; actual ${actual}.`);
}
const contracts: Record<string, string[]> = {
  "@anthropic-ai/claude-agent-sdk": ["query", "HOOK_EVENTS"],
  "@cursor/sdk": ["Agent.create", "Cursor.configure", "JsonlLocalAgentStore", "JSONL_LOCAL_AGENT_STORE_FILES"],
  "@earendil-works/pi-coding-agent": ["createAgentSession", "createBashToolDefinition", "DefaultResourceLoader", "ModelRuntime.create", "SessionManager.create", "SettingsManager.inMemory"],
  "@factory/droid-sdk": ["SessionNotificationSchema.parse", "FACTORY_PROTOCOL_VERSION"],
  "@factory/droid-sdk/node": ["createSession"],
  "@deepseek-ai/dsh-sdk-client": ["HarnessClient"],
};
function assertSdkRuntimeContract(specifier: string, module: Record<string, any>): void {
  for (const path of contracts[specifier] ?? []) {
    const value = path.split(".").reduce<any>((parent, key) => parent?.[key], module);
    const data = ["HOOK_EVENTS", "JSONL_LOCAL_AGENT_STORE_FILES", "FACTORY_PROTOCOL_VERSION"].includes(path);
    if (data ? value === undefined : typeof value !== "function") throw new RuntimePolicyError("RUNTIME_SDK_CONTRACT_FAILED", `${specifier} must expose ${path}${data ? "" : "()"}.`);
  }
  if (specifier === "@anthropic-ai/claude-agent-sdk" && (!Array.isArray(module.HOOK_EVENTS) || module.HOOK_EVENTS.some((value: unknown) => typeof value !== "string"))) throw new RuntimePolicyError("RUNTIME_SDK_CONTRACT_FAILED", "Agent SDK HOOK_EVENTS must be an array of strings.");
}
export async function withStudyRuntime<T>(binding: { studyRoot: string; role: string; options?: StudyRuntimeOptions }, callback: () => Promise<T>): Promise<T> {
  const launch = await prepareRuntimeLaunch(binding.studyRoot, binding.role, binding.options);
  launch.runtimeRoot = await realpath(launch.runtimeRoot);
  const context: StudyRuntimeContext = { studyRoot: binding.studyRoot, launch, modules: new Map(), packages: new Map(), options: binding.options ?? {}, probes: [] };
  try {
    if (launch.roots.some((root) => root.source === "npm") && launch.platform !== `${process.platform}-${process.arch}`) throw new RuntimePolicyError("RUNTIME_PLATFORM_MISMATCH", `This ${process.platform}-${process.arch} process cannot load the frozen ${launch.platform} runtime; execute it in its target environment.`);
    const pythonRoots = launch.roots.filter((component) => component.source === "pypi");
    if (pythonRoots.length) {
      const result = await (context.options.run ?? runRuntimeCommand)(join(launch.runtimeRoot, "venv", "bin", "python"), ["-I", "-B", "-c", "import importlib.metadata,json,sys; print(json.dumps({name:importlib.metadata.version(name) for name in sys.argv[2:]}))", "ebo-package-versions", ...pythonRoots.map((root) => root.name)], launch.runtimeRoot);
      if (result.code !== 0) throw new RuntimePolicyError("RUNTIME_PROBE_INVALID", `Python package probe failed: ${result.stderr.slice(0, 2000)}`);
      let versions: Record<string, unknown>; try { versions = JSON.parse(result.stdout); } catch { throw new RuntimePolicyError("RUNTIME_PROBE_INVALID", "Python package probe returned malformed JSON."); }
      for (const component of pythonRoots) {
        const actualVersion = versions[component.name];
        if (typeof actualVersion !== "string" || !actualVersion) throw new RuntimePolicyError("RUNTIME_PROBE_INVALID", `No installed version for ${component.name}.`);
        context.probes.push({componentId: component.id, package: component.name, expectedVersion: component.selection.release.version, actualVersion, source: "package-metadata"});
        assertRuntimeProbe(component.id, component.selection.release.version, actualVersion);
      }
    }
    for (const component of launch.roots.filter((component) => component.source === "npm")) {
      const root = join(launch.runtimeRoot, "node_modules", component.name), metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      assertRuntimeProbe(component.id, component.selection.release.version, metadata.version);
      context.packages.set(component.name, { root, metadata });
      context.probes.push({ componentId: component.id, package: component.name, expectedVersion: component.selection.release.version, actualVersion: metadata.version, source: "package-metadata" });
      if (!component.sdk) continue;
      const baseline = conformanceVersions()[component.name];
      if (baseline !== metadata.version) launch.warnings.push(`HARNESS_VERSION_UNVERIFIED: ${component.name}@${metadata.version}; capture coverage is unverified for this release.`);
      const specifiers = component.name === "@factory/droid-sdk" ? [component.name, `${component.name}/node`] : [component.name];
      for (const specifier of specifiers) {
        const entry = await resolveRuntimeImport(specifier, launch.runtimeRoot);
        const rel = relative(launch.runtimeRoot, entry);
        if (rel === ".." || rel.startsWith(`..${sep}`)) throw new RuntimePolicyError("RUNTIME_SDK_NOT_ISOLATED", specifier);
        const module = await import(pathToFileURL(entry).href) as Record<string, any>;
        assertSdkRuntimeContract(specifier, module); context.modules.set(specifier, module);
      }
    }
    await writeFile(join(binding.studyRoot, launch.receiptLocator), canonicalizeMetadata({ ...launch, probes: context.probes, status: "probed" }), { mode: 0o600 });
  } catch (error) {
    await writeFile(join(binding.studyRoot, launch.receiptLocator), canonicalizeMetadata({ ...launch, probes: context.probes, status: "probe-failed", error: error instanceof Error ? error.message : String(error) }), { mode: 0o600 });
    throw error;
  }
  return storage.run(context, callback);
}
export function lockedRuntimeExecutable(componentId: string): { path: string; version: string } {
  const context = currentStudyRuntime(), component = context?.launch.roots.find((component) => component.id === componentId);
  if (!context || !component?.executable) throw new RuntimePolicyError("RUNTIME_EXECUTABLE_NOT_FROZEN", componentId);
  const path = component.source === "npm" ? join(context.launch.runtimeRoot, "node_modules", ".bin", component.executable) : join(context.launch.runtimeRoot, "runtime", component.executable);
  return { path, version: component.selection.release.version };
}

export async function recordRuntimeProbe(componentId: string, actualVersion: string, source: RuntimeProbe["source"]): Promise<void> {
  const context = currentStudyRuntime(), component = context?.launch.roots.find((root) => root.id === componentId);
  if (!context || !component) throw new RuntimePolicyError("RUNTIME_COMPONENT_NOT_FROZEN", componentId);
  context.probes.push({ componentId, package: component.name, expectedVersion: component.selection.release.version, actualVersion, source });
  const matches = actualVersion === component.selection.release.version;
  await writeFile(join(context.studyRoot, context.launch.receiptLocator), canonicalizeMetadata({ ...context.launch, probes: context.probes, status: matches ? "probed" : "probe-failed" }), { mode: 0o600 });
  assertRuntimeProbe(componentId, component.selection.release.version, actualVersion);
}

export type StudyRuntimeBinding = { studyRoot: string; options?: StudyRuntimeOptions };
export function requireStudyRuntime(role: string): StudyRuntimeContext {
  const context = currentStudyRuntime();
  if (!context || context.launch.role !== role) throw new RuntimePolicyError("RUNTIME_STUDY_LOCK_REQUIRED", `Execute ${role} inside its frozen study runtime. Prepare it with ebo runtime freeze.`);
  return context;
}
/** One fresh check per owned launch; internal capture layers share this scope. */
export async function runInStudyRuntime<T>(role: string, binding: StudyRuntimeBinding | undefined, callback: () => Promise<T>): Promise<T> {
  const current = currentStudyRuntime();
  const selected = binding ?? (current ? { studyRoot: current.studyRoot, options: current.options } : undefined);
  if (!selected) throw new RuntimePolicyError("RUNTIME_STUDY_LOCK_REQUIRED", `Execute ${role} inside its frozen study runtime. Prepare it with ebo runtime freeze.`);
  return withStudyRuntime({ ...selected, role }, callback);
}

function conformanceVersions(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  return { ...manifest.dependencies, ...manifest.devDependencies };
}

export type RuntimeExecutionSummary = { lockDigest: RuntimeLaunch["lockDigest"]; role: string; receiptLocator: string; warnings: string[];
  versions: { componentId: string; name: string; expectedVersion: string; actualVersion: string | null; source: RuntimeProbe["source"] | null }[] };
export function runtimeExecutionSummary(): RuntimeExecutionSummary | undefined {
  const context = currentStudyRuntime();
  if (!context) return undefined;
  return { lockDigest: context.launch.lockDigest, role: context.launch.role, receiptLocator: context.launch.receiptLocator,
    warnings: [...context.launch.warnings], versions: context.launch.roots.map((root) => {
      const probe = context.probes.findLast((probe) => probe.componentId === root.id);
      return { componentId: root.id, name: root.name, expectedVersion: root.selection.release.version, actualVersion: probe?.actualVersion ?? null, source: probe?.source ?? null };
    }) };
}

const execFileAsync = promisify(execFile);
async function resolveRuntimeImport(specifier: string, root: string): Promise<string> {
  try {
    // ESM conditions must resolve from the selected study, including packages
    // that intentionally expose no CommonJS entrypoint. This evaluates no SDK code.
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", "process.stdout.write(import.meta.resolve(process.argv[1]))", specifier],
      { cwd: root, env: {}, encoding: "utf8", timeout: 5_000, maxBuffer: 65_536 });
    const url = new URL(stdout.trim());
    if (url.protocol !== "file:") throw new Error("SDK entrypoint is not a local file.");
    return realpath(fileURLToPath(url));
  } catch (error) { throw new RuntimePolicyError("RUNTIME_SDK_CONTRACT_FAILED", `${specifier}: import resolution failed: ${error instanceof Error ? error.message.slice(0, 2000) : String(error)}`); }
}

/** Probe the immutable executable before starting an owned protocol turn. */
export async function probeLockedRuntimeExecutable(componentId: string, prefix: readonly string[] = []): Promise<{path: string; version: string}> {
  const locked = lockedRuntimeExecutable(componentId);
  const { stdout } = await execFileAsync(locked.path, [...prefix, "--version"], { encoding: "utf8", timeout: 5_000, maxBuffer: 65_536,
    env: { PATH: process.env.PATH, FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" } });
  const version = /(?:^|\s)v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)(?:$|\s)/u.exec(stdout.trim())?.[1];
  if (!version) throw new RuntimePolicyError("RUNTIME_PROBE_INVALID", `${componentId}: --version did not report a version.`);
  await recordRuntimeProbe(componentId, version, "executable");
  return { path: locked.path, version };
}

export function lockedRuntimeVersion(componentId: string): string {
  const component = currentStudyRuntime()?.launch.roots.find((root) => root.id === componentId);
  if (!component) throw new RuntimePolicyError("RUNTIME_COMPONENT_NOT_FROZEN", componentId);
  return component.selection.release.version;
}

export function lockedRuntimePython(): string {
  const context = currentStudyRuntime();
  if (!context || !context.launch.roots.some((root) => root.source === "pypi")) throw new RuntimePolicyError("RUNTIME_PYTHON_NOT_FROZEN", "Select the study's Python runtime before executing Harbor.");
  return join(context.launch.runtimeRoot, "venv", "bin", "python");
}
