import {readFileSync} from "node:fs";
import {join} from "node:path";
import {digestMetadata, validateArtifact, writeMetadataAtomicallyIfAbsentSync} from "./artifacts.js";
import {RuntimePolicyError} from "./runtime-resolution.js";
import {readStudyRuntimeLock} from "./study-runtimes.js";
import type {RunQueue} from "./scheduler.js";
import type {RunQueueV2} from "./harbor/queue.js";
import {resolveBundleConfiguration} from "./contracts.js";
import {studyRunId} from "./runtime-run-id.js";

type Hash = `sha256:${string}`;
export type StudyFreeze = {schemaVersion: "ebo.study-freeze/v1"; studyId: string; runtimeLockDigest: Hash;
  queueDigest: Hash; queueSchemaVersion: "ebo.run-queue/v1" | "ebo.run-queue/v2"; frozenAt: string; digest: Hash};
export type RuntimeBoundQueue = {schemaVersion: "ebo.run-queue/v3"; studyFreeze: StudyFreeze; queue: RunQueue | RunQueueV2};
const bindings = new WeakMap<object, StudyFreeze>();
const hash = (value: unknown): Hash => `sha256:${digestMetadata(value).value}`;
export const queueStudyFreeze = (queue: object): StudyFreeze | undefined => bindings.get(queue);
export function queueRunId(queue: object, sourceRunId: string): string {
  const freeze = bindings.get(queue); return freeze ? studyRunId(freeze.digest, sourceRunId) : sourceRunId;
}
export function assertStudyFreeze(document: unknown): asserts document is StudyFreeze {
  const errors = validateArtifact("study freeze", document);
  if (errors.length) throw new RuntimePolicyError("RUNTIME_QUEUE_INVALID", errors.map((error) => `${error.field}: ${error.message}`).join("; "));
  const {digest, ...value} = document as StudyFreeze;
  if (hash(value) !== digest) throw new RuntimePolicyError("RUNTIME_QUEUE_INTEGRITY", "Study freeze differs from its digest.");
}

/** Pure retained reader. Runtime identity is checked separately when executing a queue. */
export function unwrapRuntimeBoundQueue(document: unknown): unknown {
  if (!document || typeof document !== "object" || Reflect.get(document, "schemaVersion") !== "ebo.run-queue/v3") return document;
  const errors = validateArtifact("runtime-bound queue", document);
  if (errors.length) throw new RuntimePolicyError("RUNTIME_QUEUE_INVALID", errors.map((error) => `${error.field}: ${error.message}`).join("; "));
  const value = document as RuntimeBoundQueue, {digest, ...freeze} = value.studyFreeze;
  if (hash(freeze) !== digest || hash(value.queue) !== freeze.queueDigest || value.queue.schemaVersion !== freeze.queueSchemaVersion) throw new RuntimePolicyError("RUNTIME_QUEUE_INTEGRITY", "Queue content or study freeze differs from its digest.");
  bindings.set(value.queue, value.studyFreeze); return value.queue;
}
export function assertQueueRuntimeBinding(queue: object, lockDigest: string): void {
  const freeze = bindings.get(queue);
  if (freeze && freeze.runtimeLockDigest !== lockDigest) throw new RuntimePolicyError("RUNTIME_QUEUE_LOCK_MISMATCH", "The queue belongs to a different runtime freeze; select its study or bind a new study revision.");
}

/** Bind a validated queue to the study's immutable runtime selection, idempotently. */
export async function bindStudyRuntimeQueue(studyRoot: string, queue: RunQueue | RunQueueV2, options: {configurationRoot?: string} = {}): Promise<RuntimeBoundQueue> {
  const {validateRunQueue} = await import("./scheduler.js");
  const {validateHarborRunQueue} = await import("./harbor/queue.js");
  const errors = queue.schemaVersion === "ebo.run-queue/v2" ? await validateHarborRunQueue(queue) : validateRunQueue(queue);
  if (errors.length) throw new RuntimePolicyError("RUNTIME_QUEUE_INVALID", errors.map((error) => `${error.field}: ${error.message}`).join("; "));
  const lock = await readStudyRuntimeLock(studyRoot);
  for (const arm of queue.matrix.harnessIds) {
    if (lock.groups.some((group) => group.roles.includes(arm))) continue;
    const entry = queue.entries.find((entry) => entry.harness.id === arm)!;
    const configuration = JSON.parse(resolveBundleConfiguration(options.configurationRoot ?? studyRoot, entry.harness.configurationRef).toString("utf8"));
    if (typeof configuration.adapter !== "string" || !lock.groups.some((group) => group.roles.includes(configuration.adapter))) throw new RuntimePolicyError("RUNTIME_ROLE_NOT_FROZEN", `Queue arm ${arm} has no frozen native adapter runtime.`);
  }
  const queueDigest = hash(queue), frozen = {schemaVersion: "ebo.study-freeze/v1" as const, studyId: lock.studyId, runtimeLockDigest: lock.digest,
    queueDigest, queueSchemaVersion: queue.schemaVersion, frozenAt: new Date().toISOString()};
  const relativePath = `runtimes/study-freezes/${queueDigest.slice(7)}.json`;
  writeMetadataAtomicallyIfAbsentSync(studyRoot, relativePath, {...frozen, digest: hash(frozen)});
  const studyFreeze = JSON.parse(readFileSync(join(studyRoot, relativePath), "utf8")) as StudyFreeze;
  const document: RuntimeBoundQueue = {schemaVersion: "ebo.run-queue/v3", studyFreeze, queue};
  unwrapRuntimeBoundQueue(document);
  if (studyFreeze.runtimeLockDigest !== lock.digest || studyFreeze.studyId !== lock.studyId) throw new RuntimePolicyError("RUNTIME_STUDY_FREEZE_MISMATCH", "The queue's persisted study freeze differs from this runtime lock.");
  return document;
}
