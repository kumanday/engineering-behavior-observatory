import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalizeMetadata } from "./artifacts.js";
import { listRuntimeRecipes } from "./runtime-catalog.js";
import { currentStudyRuntime, withStudyRuntime } from "./runtime-context.js";
import { freezeStudyRuntimes, readStudyRuntimeLock, type StudyRuntimeLock, type StudyRuntimeOptions, type StudyRuntimeRequest } from "./study-runtimes.js";

function summary(lock: StudyRuntimeLock): unknown {
  return { studyId: lock.studyId, lockDigest: lock.digest, createdAt: lock.createdAt, target: lock.target,
    groups: lock.groups.map((group) => ({ id: group.id, roles: group.roles, installationKey: group.installation.key,
      components: group.roots.map((root) => ({ id: root.id, name: root.name, version: root.selection.release.version, publishedAt: root.selection.release.publishedAt, cutoff: root.selection.cutoff })),
      dependencyCount: group.components.length })), warnings: [...new Set([...lock.security.warnings, ...lock.groups.flatMap((group) => group.components.flatMap((component) => component.selection.warnings.map((warning) => warning.includes(component.name) ? warning : `${component.name}@${component.version}: ${warning}`)))])] };
}
export async function runRuntimeCommandLine(args: readonly string[], write: (text: string) => void, options: StudyRuntimeOptions = {}): Promise<number> {
  const emit = (value: unknown): void => write(`${canonicalizeMetadata(value)}\n`);
  try {
    if (args[0] === "list" && args.length === 1) { emit(listRuntimeRecipes()); return 0; }
    if (args[0] === "freeze" && args.length === 3) {
      const request = JSON.parse(await readFile(resolve(args[2]!), "utf8")) as StudyRuntimeRequest;
      emit(summary(await freezeStudyRuntimes(resolve(args[1]!), request, options))); return 0;
    }
    if (args[0] === "inspect" && args.length === 2) { emit(summary(await readStudyRuntimeLock(resolve(args[1]!)))); return 0; }
    if (args[0] === "check" && args.length === 3) {
      await withStudyRuntime({ studyRoot: resolve(args[1]!), role: args[2]!, options }, async () => {
        const context = currentStudyRuntime()!;
        emit({ status: "probed", lockDigest: context.launch.lockDigest, role: context.launch.role, probes: context.probes,
          receiptLocator: context.launch.receiptLocator, warnings: context.launch.warnings });
      }); return 0;
    }
    write("Usage: ebo runtime list | freeze <study-root> <request.json> | inspect <study-root> | check <study-root> <role>\n"); return 1;
  } catch (error) { write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}
