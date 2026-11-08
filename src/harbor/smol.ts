import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { assertNoDuplicateJsonKeys, digestMetadata } from "../artifacts.js";
import { resolveBundleConfiguration } from "../contracts.js";
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
  if (manifest.schemaVersion !== "ebo.smol-environments/v1" || manifest.platform !== "linux/arm64"
    || manifest.runtimeArchiveDigest !== runtime.archive.digest.value) {
    throw new Error("Smol environment manifest must bind the selected runtime archive and linux/arm64 platform.");
  }
  const queueDigest = digestMetadata(queue).value;
  return { environmentManifest: manifest, queueDigest,
    ownerRoot: join(resolve(studyRoot), "runtime", "smol", queueDigest) };
}

/** Foreground owner only; no task scheduling or detached daemon. */
export async function serveSmolEnvironments(studyRoot: string, queuePath: string, options: StudyRuntimeOptions = {}): Promise<number> {
  return withStudyRuntime({studyRoot, role: "smol", options}, () => serveSmolEnvironmentsOwned(studyRoot, queuePath));
}
async function serveSmolEnvironmentsOwned(studyRoot: string, queuePath: string): Promise<number> {
  const context = currentStudyRuntime()!;
  if (!context.launch.roots.some((root) => root.id === "harbor")) throw new Error("RUNTIME_ROLE_NOT_FROZEN: Smol preparation requires harbor and smol in the same frozen Python group.");
  const adapter = await createHarborAdapter();
  const queue = await readHarborRunQueue(queuePath, { studyRoot, adapter });
  if (!queue.execution.workerRef) throw new Error("RUNTIME_WORKER_MIGRATION_REQUIRED: select a frozen worker pack.");
  assertWorkerStudyRuntime(resolveHarborWorkerRuntime(studyRoot, queue.execution.workerRef), context.launch.lockDigest);
  const condition = smolCondition(studyRoot, queue);
  const tasks = new Map<string, { id: string; path: string; verified: boolean }>();
  for (const entry of queue.entries) {
    if (entry.task.kind !== "harbor-task") throw new Error("Smol preparation requires Harbor task entries.");
    tasks.set(entry.task.taskSourceId, { id: entry.task.taskSourceId,
      path: join(harborStudyPaths(studyRoot).snapshotsRoot, entry.task.snapshotLocator), verified: entry.task.assessmentMode === "verified" });
  }
  await mkdir(condition.ownerRoot, { recursive: true, mode: 0o700 });
  const script = join(condition.ownerRoot, `ebo_smol_${digestMetadata(HARBOR_TRIAL_SCRIPT).value.slice(0, 16)}.py`);
  await writeFile(script, HARBOR_TRIAL_SCRIPT, { mode: 0o600 });
  const request = join(condition.ownerRoot, `request-${randomUUID()}.json`);
  await writeFile(request, JSON.stringify({ ...condition, frozenPythonVersions: Object.fromEntries(context.probes.filter((probe) => probe.source === "package-metadata").map((probe) => [probe.package, probe.actualVersion])), operation: "serve", tasks: [...tasks.values()],
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
