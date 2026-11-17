import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertNoDuplicateJsonKeys, digestMetadata } from "../artifacts.js";
import { resolveBundleConfiguration, type ArtifactReference } from "../contracts.js";
import { createHarborAdapter } from "./adapter.js";
import { harborStudyPaths } from "./study.js";
import { readHarborRunQueue, type RunQueueV2 } from "./queue.js";
import { HARBOR_TRIAL_SCRIPT } from "./trial-script.js";
import { assertWorkerStudyRuntime, resolveHarborWorkerRuntime } from "./official-trial.js";
import { currentStudyRuntime, lockedRuntimePython, withStudyRuntime } from "../runtime-context.js";
import type { StudyRuntimeOptions } from "../study-runtimes.js";
import { frozenPythonEnvironment } from "../runtime-bootstrap.js";

export function smolCondition(studyRoot: string, queue: RunQueueV2) {
  if (queue.execution.environmentProfile !== "smol" || !queue.execution.environmentRef || !queue.execution.workerRef) {
    throw new Error("Smol execution requires digest-pinned execution.environmentRef and execution.workerRef.");
  }
  const text = resolveBundleConfiguration(studyRoot, queue.execution.environmentRef).toString("utf8");
  assertNoDuplicateJsonKeys(text);
  const manifest = JSON.parse(text) as Record<string, unknown>;
  const runtime = resolveHarborWorkerRuntime(studyRoot, queue.execution.workerRef);
  validateSmolProfile(manifest, runtime.environmentKeys);
  if (manifest.runtimeArchiveDigest !== runtime.archive.digest.value) {
    throw new Error("Smol environment manifest must bind the selected runtime archive.");
  }
  const queueDigest = digestMetadata(queue).value;
  return { environmentManifest: manifest, queueDigest,
    ownerRoot: join(resolve(studyRoot), "runtime", "smol", queueDigest) };
}

/** Connection metadata is frozen; credentials are resolved only by the coordinator. */
export function validateSmolProfile(manifest: Record<string, unknown>, workerKeys: string[] = []): void {
  const local = manifest.schemaVersion === "ebo.smol-environments/v1" || manifest.target === "local";
  if (!["ebo.smol-environments/v1", "ebo.smol-environments/v2", "ebo.smol-environments/v3"].includes(String(manifest.schemaVersion))
    || (local ? manifest.platform !== "linux/arm64" : !["linux/arm64", "linux/amd64"].includes(String(manifest.platform)))
    || (!local && manifest.target !== "cloud")) throw new Error("Invalid Smol target or platform.");
  if (manifest.schemaVersion === "ebo.smol-environments/v1" && manifest.target !== undefined && manifest.target !== "local") throw new Error("Cloud requires Smol manifest v2.");
  if (!local) {
    const cloud = manifest.cloud as { baseUrl?: string; tokenEnv?: string; auth?: string } | undefined;
    if (!cloud || Object.keys(cloud).some(key => !["baseUrl", "tokenEnv", "auth"].includes(key))) throw new Error("Cloud connection metadata accepts only baseUrl, tokenEnv and auth.");
    const url = new URL(cloud?.baseUrl ?? "invalid");
    const cli = manifest.schemaVersion === "ebo.smol-environments/v3" && cloud.auth === "cli" && cloud.tokenEnv === undefined;
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || !(cli || cloud.auth === undefined && /^[A-Z][A-Z0-9_]*$/.test(cloud.tokenEnv ?? ""))) throw new Error("Cloud requires an HTTPS origin and explicit tokenEnv or v3 auth=cli.");
    if (workerKeys.includes(cloud!.tokenEnv!)) throw new Error("Cloud control credentials cannot be passed to the candidate worker.");
    if (cli && workerKeys.includes("SMOL_CLOUD_TOKEN")) throw new Error("Cloud control credentials cannot be passed to the candidate worker.");
  }
  if (manifest.schemaVersion === "ebo.smol-environments/v3") validateSmolHierarchy(manifest);
}

export function validateSmolHierarchy(manifest: Record<string, unknown>): void {
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hierarchy object.");
    return value as Record<string, unknown>;
  };
  const families = record(manifest.families), harnesses = record(manifest.harnesses), tasks = record(manifest.tasks);
  if (!Object.keys(families).length || !Object.keys(harnesses).length || !Object.keys(tasks).length) throw new Error("Hierarchy needs families, harnesses and task bindings.");
  for (const [id, value] of Object.entries(families)) {
    const family = record(value);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id) || Object.keys(family).sort().join() !== "baseImageDigest,image,recipeDigest"
      || !/^\S+@sha256:[a-f0-9]{64}$/.test(String(family.image))
      || ![family.recipeDigest, family.baseImageDigest].every(d => /^[a-f0-9]{64}$/.test(String(d)))) throw new Error("Family must pin exactly one image, recipeDigest and baseImageDigest.");
  }
  for (const value of Object.values(harnesses)) {
    const harness = record(value);
    if (Object.keys(harness).some(key => !["families", "setupRef"].includes(key)) || !Array.isArray(harness.families) || !harness.families.length
      || harness.families.some(id => typeof id !== "string" || !Object.hasOwn(families, id))) throw new Error("Harness must select compatible families.");
    if (harness.setupRef !== undefined) {
      const ref = record(harness.setupRef), digest = record(ref.digest);
      if (typeof ref.locator !== "string" || digest.algorithm !== "sha256" || !/^[a-f0-9]{64}$/.test(String(digest.value))) throw new Error("Harness setupRef requires a SHA-256 artifact reference.");
    }
  }
  for (const value of Object.values(tasks)) {
    const task = record(value);
    for (const value of [task.agent, ...Object.values(task.graders === undefined ? {} : record(task.graders))]) {
      const binding = record(value);
      if (Object.keys(binding).some(key => !["family", "localSetup"].includes(key)) || typeof binding.family !== "string"
        || !Object.hasOwn(families, binding.family)) throw new Error("Task must select a family without overriding its image.");
    }
  }
}

async function preparationScripts(studyRoot: string, manifest: Record<string, unknown>, root: string): Promise<Record<string, string>> {
  if (manifest.schemaVersion !== "ebo.smol-environments/v3") return {};
  const files: Record<string, string> = {};
  for (const harness of Object.values(manifest.harnesses as Record<string, { setupRef?: ArtifactReference }>)) {
    if (!harness.setupRef) continue;
    const ref = harness.setupRef, content = resolveBundleConfiguration(studyRoot, ref);
    const path = join(root, `setup-${ref.digest.value}.sh`);
    await writeFile(path, content, { mode: 0o600 });
    files[ref.digest.value] = path;
  }
  return files;
}

function frozenPythonVersions(): Record<string, string> {
  return Object.fromEntries(currentStudyRuntime()!.probes.filter((probe) => probe.source === "package-metadata").map((probe) => [probe.package, probe.actualVersion]));
}

/** Reattach to an owned job; this never schedules or launches an attempt. */
export async function recoverSmolJob(studyRoot: string, receipt: string, options: StudyRuntimeOptions & { cancel?: boolean; delete?: boolean } = {}): Promise<number> {
  const { cancel, delete: remove, ...runtime } = options;
  const path = resolve(receipt);
  const text = await readFile(path, "utf8");
  assertNoDuplicateJsonKeys(text);
  const owner = (JSON.parse(text) as { ownerRoot?: unknown }).ownerRoot;
  // The receipt selects the machine and credentials route; it must belong to the study whose runtime recovers it.
  if (typeof owner !== "string" || dirname(resolve(owner)) !== join(resolve(studyRoot), "runtime", "smol")) throw new Error("Job receipt does not belong to this study's Smol preparation.");
  return withStudyRuntime({studyRoot, role: "smol", options: runtime}, async () => {
    if (!currentStudyRuntime()!.launch.roots.some((root) => root.id === "harbor")) throw new Error("RUNTIME_ROLE_NOT_FROZEN: Smol job recovery requires harbor and smol in the same frozen Python group.");
    const root = await mkdtemp(join(tmpdir(), "ebo-smol-recover-"));
    try {
      const script = join(root, "ebo_recover.py"), request = join(root, "request.json");
      await writeFile(script, HARBOR_TRIAL_SCRIPT, { mode: 0o600 });
      await writeFile(request, JSON.stringify({ operation: "recover-job", receipt: path, frozenPythonVersions: frozenPythonVersions(), cancel: cancel === true, delete: remove === true }), { mode: 0o600 });
      return await new Promise<number>((done, fail) => {
        const child = spawn(lockedRuntimePython(), [script, request], { stdio: "inherit", env: frozenPythonEnvironment() });
        child.once("error", fail); child.once("close", code => done(code ?? 1));
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

/** Foreground owner only; no task scheduling or detached daemon. */
export async function serveSmolEnvironments(studyRoot: string, queuePath: string, options: StudyRuntimeOptions & { resume?: boolean } = {}): Promise<number> {
  const { resume, ...runtime } = options;
  return withStudyRuntime({studyRoot, role: "smol", options: runtime}, () => serveSmolEnvironmentsOwned(studyRoot, queuePath, resume === true));
}
async function serveSmolEnvironmentsOwned(studyRoot: string, queuePath: string, resume: boolean): Promise<number> {
  const context = currentStudyRuntime()!;
  if (!context.launch.roots.some((root) => root.id === "harbor")) throw new Error("RUNTIME_ROLE_NOT_FROZEN: Smol preparation requires harbor and smol in the same frozen Python group.");
  const adapter = await createHarborAdapter();
  const queue = await readHarborRunQueue(queuePath, { studyRoot, adapter });
  if (!queue.execution.workerRef) throw new Error("RUNTIME_WORKER_MIGRATION_REQUIRED: select a frozen worker pack.");
  assertWorkerStudyRuntime(resolveHarborWorkerRuntime(studyRoot, queue.execution.workerRef), context.launch.lockDigest);
  const condition = smolCondition(studyRoot, queue);
  const tasks = new Map<string, { id: string; path: string; verified: boolean; harnessId?: string }>();
  for (const entry of queue.entries) {
    if (entry.task.kind !== "harbor-task") throw new Error("Smol preparation requires Harbor task entries.");
    const hierarchy = condition.environmentManifest.schemaVersion === "ebo.smol-environments/v3";
    if (hierarchy && !Object.hasOwn(condition.environmentManifest.harnesses as object, entry.harnessId)) throw new Error("Queue harness has no hierarchy preparation binding.");
    tasks.set(hierarchy ? `${entry.task.taskSourceId}:${entry.harnessId}` : entry.task.taskSourceId, { id: entry.task.taskSourceId,
      ...(hierarchy ? { harnessId: entry.harnessId } : {}),
      path: join(harborStudyPaths(studyRoot).snapshotsRoot, entry.task.snapshotLocator), verified: entry.task.assessmentMode === "verified" });
  }
  await mkdir(condition.ownerRoot, { recursive: true, mode: 0o700 });
  const scripts = await preparationScripts(studyRoot, condition.environmentManifest, condition.ownerRoot);
  const script = join(condition.ownerRoot, `ebo_smol_${digestMetadata(HARBOR_TRIAL_SCRIPT).value.slice(0, 16)}.py`);
  await writeFile(script, HARBOR_TRIAL_SCRIPT, { mode: 0o600 });
  const request = join(condition.ownerRoot, `request-${randomUUID()}.json`);
  await writeFile(request, JSON.stringify({ ...condition, frozenPythonVersions: frozenPythonVersions(), operation: "serve", resume, tasks: [...tasks.values()], preparationScripts: scripts,
    budgetMs: queue.coordinatorBudget.maxWallClockMs, build: "ebo-harbor-smol-v1", model: "preparation-only" }), { flag: "wx", mode: 0o600 });
  const python = lockedRuntimePython();
  return new Promise((done, fail) => {
    const child = spawn(python, [script, request], { stdio: "inherit", env: frozenPythonEnvironment() });
    const stop = () => { child.kill("SIGTERM"); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    const cleanup = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); };
    child.once("error", error => { cleanup(); fail(error); });
    child.once("close", code => { cleanup(); done(code ?? 1); });
  });
}
