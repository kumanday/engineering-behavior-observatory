import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalizeMetadata, assertNoDuplicateJsonKeys, writeMetadataAtomicallyIfAbsentSync } from "./artifacts.js";
import { bindStudyRuntimeQueue, queueRunId } from "./study-runtime-bindings.js";
import { listRuntimeRecipes } from "./runtime-catalog.js";
import { currentStudyRuntime, runtimeExecutionSummary, withStudyRuntime } from "./runtime-context.js";
import { freezeStudyRuntimes, readStudyRuntimeLock, type StudyRuntimeLock, type StudyRuntimeOptions, type StudyRuntimeRequest } from "./study-runtimes.js";
import {prepareHarnessVerification, validateHarnessVerificationCandidate, admitHarnessVerification, withdrawHarnessVerification, type VerificationRequest} from "./harness-verification-candidate.js";
import {readVerificationCatalog, evaluateVerification, type VerificationHash} from "./harness-verification.js";
import {readBoundedFile} from "./scheduler.js";
import {dirname, basename} from "node:path";

function json(path: string): any {
  const text = new TextDecoder("utf8", {fatal: true}).decode(readBoundedFile(resolve(path), "Runtime command input", undefined, 4 * 1024 * 1024));
  assertNoDuplicateJsonKeys(text); return JSON.parse(text);
}

function summary(lock: StudyRuntimeLock): unknown {
  return { studyId: lock.studyId, lockDigest: lock.digest, createdAt: lock.createdAt, target: lock.target,
    groups: lock.groups.map((group) => ({ id: group.id, roles: group.roles, installationKey: group.installation.key, platform: group.plan.platform, abi: group.plan.abi,
      components: group.roots.map((root) => ({ id: root.id, name: root.name, version: root.selection.release.version, publishedAt: root.selection.release.publishedAt, cutoff: root.selection.cutoff })),
      dependencyCount: group.components.length, verification: Object.fromEntries(Object.entries(group.verification ?? {}).map(([role, snapshot]) => [role, {
        ...evaluateVerification(snapshot), scopedReceipts: snapshot.receipts.map(receipt => ({digest: receipt.digest, scope: receipt.scope, claims: receipt.claims})),
      }])) })), warnings: [...new Set([...lock.security.warnings, ...lock.groups.flatMap((group) => group.components.flatMap((component) => component.selection.warnings.map((warning) => warning.includes(component.name) ? warning : `${component.name}@${component.version}: ${warning}`)))])] };
}
export async function runRuntimeCommandLine(args: readonly string[], write: (text: string) => void, options: StudyRuntimeOptions = {}): Promise<number> {
  const emit = (value: unknown): void => write(`${canonicalizeMetadata(value)}\n`);
  try {
    if (args[0] === "list" && args.length === 1) { emit(listRuntimeRecipes()); return 0; }
    if (args[0] === "freeze" && (args.length === 3 || args.length === 5 && args[3] === "--verification-catalog" && args[4])) {
      const request = json(args[2]!) as StudyRuntimeRequest;
      emit(summary(await freezeStudyRuntimes(resolve(args[1]!), request, {...options, ...(args[4] ? {verificationCatalogRoot: resolve(args[4])} : {})}))); return 0;
    }
    if (args[0] === "verify" && args.length === 3) {
      const candidate = await prepareHarnessVerification(json(args[1]!) as VerificationRequest, options), destination = resolve(args[2]!);
      writeMetadataAtomicallyIfAbsentSync(dirname(destination), basename(destination), candidate);
      if (canonicalizeMetadata(json(destination)) !== canonicalizeMetadata(candidate)) throw new Error("HARNESS_VERIFICATION_DESTINATION_EXISTS: candidate destination contains different evidence.");
      emit({candidatePath: destination, receiptDigest: candidate.receipt.digest, claims: candidate.receipt.claims, scope: candidate.receipt.scope}); return 0;
    }
    if (args[0] === "verification" && args[1] === "inspect" && args.length === 3) {
      emit(await readVerificationCatalog(resolve(args[2]!))); return 0;
    }
    if (args[0] === "verification" && args[1] === "admit" && args.length === 5) {
      const operator = json(args[4]!);
      if (!operator || typeof operator !== "object" || Object.keys(operator).some(key => !["id", "reason", "supersedes"].includes(key))) throw new Error("HARNESS_VERIFICATION_INVALID: admission requires operator id, reason and optional superseded receipt digests.");
      const candidate = await validateHarnessVerificationCandidate(json(args[3]!), options);
      emit(await admitHarnessVerification(resolve(args[2]!), candidate, {id: operator.id, reason: operator.reason}, operator.supersedes ?? [])); return 0;
    }
    if (args[0] === "verification" && args[1] === "withdraw" && args.length === 4) {
      const operator = json(args[3]!);
      if (!operator || typeof operator !== "object" || Object.keys(operator).some(key => !["id", "reason", "receiptDigests"].includes(key)) || !Array.isArray(operator.receiptDigests)) throw new Error("HARNESS_VERIFICATION_INVALID: withdrawal requires explicit receipt digests, operator id and reason.");
      emit(await withdrawHarnessVerification(resolve(args[2]!), operator.receiptDigests as VerificationHash[], {id: operator.id, reason: operator.reason})); return 0;
    }
    if (args[0] === "inspect" && args.length === 2) { emit(summary(await readStudyRuntimeLock(resolve(args[1]!)))); return 0; }
    if (args[0] === "bind-queue" && (args.length === 4 || args.length === 6 && args[4] === "--configuration-root" && args[5] && !args[5].startsWith("--"))) {
      const {readRunQueueVersioned} = await import("./harbor/queue.js");
      const studyRoot = resolve(args[1]!), configurationRoot = args[5] ? resolve(args[5]) : studyRoot;
      const queue = await readRunQueueVersioned(resolve(args[2]!), {bundleRoot: configurationRoot, studyRoot: configurationRoot});
      const bound = await bindStudyRuntimeQueue(studyRoot, queue, {configurationRoot});
      const {dirname, basename} = await import("node:path");
      const destination = resolve(args[3]!);
      writeMetadataAtomicallyIfAbsentSync(dirname(destination), basename(destination), bound);
      const retained = JSON.parse(await readFile(destination, "utf8"));
      if (canonicalizeMetadata(retained) !== canonicalizeMetadata(bound)) throw new Error("RUNTIME_QUEUE_DESTINATION_EXISTS: destination contains a different queue binding.");
      emit({queuePath: destination, studyFreezeDigest: bound.studyFreeze.digest, runtimeLockDigest: bound.studyFreeze.runtimeLockDigest, runs: bound.queue.entries.map((entry) => ({sourceRunId: entry.runId, runId: queueRunId(bound.queue, entry.runId)}))}); return 0;
    }
    if (args[0] === "check" && args.length === 3) {
      await withStudyRuntime({ studyRoot: resolve(args[1]!), role: args[2]!, options }, async () => {
        const context = currentStudyRuntime()!;
        emit({ status: "probed", lockDigest: context.launch.lockDigest, role: context.launch.role, probes: context.probes,
          receiptLocator: context.launch.receiptLocator, warnings: context.launch.warnings, verification: runtimeExecutionSummary()?.verification });
      }); return 0;
    }
    write("Usage: ebo runtime list | freeze <study-root> <request.json> [--verification-catalog <path>] | inspect <study-root> | check <study-root> <role> | verify <request.json> <candidate.json> | verification inspect <catalog> | verification admit <catalog> <candidate.json> <operator.json> | verification withdraw <catalog> <withdrawal.json> | bind-queue <study-root> <queue.json> <output.json> [--configuration-root <path>]\n"); return 1;
  } catch (error) { write(`${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}
