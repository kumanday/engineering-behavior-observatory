import { validateHarborTrialBytes, type HarborTrialValidation } from "./harbor-record-reader.js";
import { linkSync, lstatSync, mkdirSync, mkdtempSync, opendirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { assertNoDuplicateJsonKeys, digestBytes, digestMetadata, validateArtifact } from "./artifacts.js";
import { isSafeArtifactRelativePath } from "./contracts.js";
import { importAtifFile, readImportManifest, readAtifImportAdmission } from "./atif-import.js";
import type { AtifProducerFingerprint } from "./atif-profiles.js";
import { readBoundedFile } from "./scheduler.js";

export const HARBOR_IMPORT_LIMITS = { files: 4096, fileBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, depth: 32, lineageDepth: 8, contextBytes: 32 * 1024 * 1024 } as const;
type ObjectValue = Record<string, unknown>;
type Hash = `sha256:${string}`;
type SourceFile = { path: string; digest: Hash; bytes: number; authority: "third-party-trial-record" | "third-party-agent-log" | "third-party-verifier-record" };
export type HarborTrialInspection = {
  schemaVersion: "ebo.harbor-trial-inspection/v1";
  sourceAuthority: "third-party";
  status: "eligible" | "inspect-only";
  diagnostics: string[];
  structural?: HarborTrialValidation;
  namespace: string;
  trialId?: string;
  execution?: { schemaVersion: "ebo.harbor-execution/v1"; id: string; originalTrialId: string; runId: string; attemptId: string; identityDigest: Hash; taskName: string; taskChecksum: string; modelAliases: string[] };
  captureRevision?: Hash;
  assessment?: { id: string; trialId: string; originalTrialId: string; kind: "original" | "regrade"; resultDigest: Hash;
    taskChecksum: string; rewards: Record<string, number> | null; exceptionType: string | null; startedAt: string | null; finishedAt: string | null };
  snapshotDigest: Hash;
  files: SourceFile[];
  modelAliases: string[];
  originalBindings: Array<{ sourceReference: string; snapshotDigest: Hash; trialId: string; inspectionDigest: Hash }>;
};
export type HarborOriginalBinding = { sourceReference: string; directory: string };
export type HarborTrialRead = { inspection: HarborTrialInspection; files: Map<string, Buffer>; result?: ObjectValue; lineage: HarborTrialRead[] };
const hash = (value: unknown): Hash => `sha256:${digestMetadata(value).value}`;
const rawHash = (value: Uint8Array): Hash => `sha256:${digestBytes(value).value}`;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value);

/** Bounded local source-context inspection. Source references never cause filesystem traversal or network fetches. */
export async function inspectHarborTrial(options: { directory: string; namespace: string; originals?: readonly HarborOriginalBinding[]; pythonExecutable?: string }): Promise<HarborTrialRead> {
  if (!options.namespace.trim() || options.namespace.length > 1024) throw new Error("Harbor imports require a bounded source namespace.");
  const bindings = new Map((options.originals ?? []).map((binding) => [uuid(binding.sourceReference) ? binding.sourceReference.toLowerCase() : binding.sourceReference, binding.directory]));
  if (bindings.size !== (options.originals ?? []).length) throw new Error("Original-trial source bindings must be unique.");
  const seen = new Set<string>();
  const sourceBudget = { bytes: 0, entries: 0 };
  const inspect = async (directory: string, depth: number): Promise<HarborTrialRead> => {
    const files = collectTrialFiles(directory, sourceBudget);
    const descriptors = [...files].map(([path, bytes]): SourceFile => ({ path, digest: rawHash(bytes), bytes: bytes.length,
      authority: path.startsWith("agent/") ? "third-party-agent-log" : path.startsWith("verifier/") ? "third-party-verifier-record" : "third-party-trial-record" }));
    const inspection: HarborTrialInspection = { schemaVersion: "ebo.harbor-trial-inspection/v1", sourceAuthority: "third-party", status: "inspect-only",
      namespace: options.namespace, diagnostics: [], snapshotDigest: hash({ namespace: options.namespace, files: descriptors }), files: descriptors, modelAliases: [], originalBindings: [] };
    const lineage: HarborTrialRead[] = [];
    let retainedResult: ObjectValue | undefined;
    const stop = (reason: string): HarborTrialRead => { inspection.diagnostics.push(reason); return { inspection, files, lineage, ...(retainedResult === undefined ? {} : { result: retainedResult }) }; };
    if (!files.has("result.json")) return stop("TRIAL_RESULT_MISSING");
    let result: ObjectValue, config: ObjectValue;
    try {
      result = parseObject(files.get("result.json")!);
      config = object(result.config);
      if (!uuid(result.id) || !text(result.task_name) || String(result.task_name).length > 4096 || !/^[a-f0-9]{64}$/iu.test(String(result.task_checksum)) || !text(object(result.agent_info).name)
          || !text(object(result.agent_info).version) || !Object.keys(config).length) return stop("TRIAL_IDENTITY_INCOMPLETE");
      if (files.has("config.json")) {
        const standalone = parseObject(files.get("config.json")!);
        // Harbor serializes defaults only in result.config; compare explicitly retained configuration fields.
        if (!declaredSubset(standalone, config)) return stop("TRIAL_CONFIGURATION_CONFLICT");
      }
    } catch { return stop("TRIAL_RECORD_INVALID"); }
    const trialId = String(result.id).toLowerCase();
    inspection.trialId = trialId;
    inspection.structural = await validateHarborTrialBytes(files.get("result.json")!, options.pythonExecutable);
    if (inspection.structural.status !== "valid") return stop("TRIAL_STRUCTURAL_VALIDATION_UNAVAILABLE_OR_INVALID");
    retainedResult = result;
    if (seen.has(trialId)) return stop("ORIGINAL_TRIAL_CYCLE");
    if (depth > HARBOR_IMPORT_LIMITS.lineageDepth) return stop("ORIGINAL_TRIAL_DEPTH_LIMIT");
    seen.add(trialId);
    const agent = object(config.agent), info = object(result.agent_info);
    if (/(^|[.:/])ebo(?:[-_.]|$)/iu.test(String(agent.import_path ?? "")) || [agent.name, info.name].some((name) => /^ebo(?:[-_.]|$)/iu.test(String(name)))) return stop("OWNED_TRIAL_BINDING_REQUIRED");
    const aliases = new Set<string>();
    for (const value of [agent.model_name, object(info.model_info).name, object(object(result.config).agent).model_name]) if (text(value)) aliases.add(String(value));
    inspection.modelAliases = [...aliases].filter((value) => value.length <= 1024).sort();
    if (aliases.size > 256 || inspection.modelAliases.length !== aliases.size) return stop("MODEL_ALIAS_LIMIT");
    let original = result, originalTrialId = trialId, originalFiles = files;
    const derivation = config.source_trial;
    if (!Object.hasOwn(config, "source_trial")) return stop("ORIGINAL_EXECUTOR_UNREPORTED");
    if (derivation !== null) {
      const source = object(derivation);
      if (source.action !== "regrade" || !["hub", "local"].includes(String(source.type))) return stop("SOURCE_DERIVATION_UNSUPPORTED");
      if (source.trial_id !== undefined && source.trial_id !== null && !uuid(source.trial_id)) return stop("SOURCE_TRIAL_ID_INVALID");
      const sourceReference = source.type === "hub" ? text(source.trial_id)?.toLowerCase() : text(source.path);
      if (sourceReference === undefined || !bindings.has(sourceReference)) return stop("ORIGINAL_TRIAL_NOT_BOUND");
      const retained = await inspect(bindings.get(sourceReference)!, depth + 1);
      lineage.push(...retained.lineage, retained);
      if (retained.inspection.trialId) inspection.originalBindings.push({ sourceReference, snapshotDigest: retained.inspection.snapshotDigest, trialId: retained.inspection.trialId, inspectionDigest: hash(retained.inspection) });
      if (retained.inspection.structural?.status !== "valid" || retained.result === undefined || retained.inspection.execution === undefined) return stop("ORIGINAL_EXECUTOR_UNRESOLVED");
      if (source.trial_id && String(source.trial_id).toLowerCase() !== retained.inspection.trialId) return stop("SOURCE_TRIAL_BINDING_CONFLICT");
      if (retained.result.task_name !== result.task_name || hash(retained.result.agent_info) !== hash(result.agent_info)
          || hash(agentFiles(files)) !== hash(agentFiles(retained.files)) || agentFiles(files).length === 0) return stop("REGRADE_EXECUTION_EVIDENCE_CONFLICT");
      original = retained.result;
      originalTrialId = retained.inspection.execution.originalTrialId;
      originalFiles = retained.files;
      retained.inspection.modelAliases.forEach((alias) => aliases.add(alias));
      inspection.modelAliases = [...aliases].sort();
      // The execution identity comes from the original executor; regrade task/config describe an assessment.
      inspection.execution = retained.inspection.execution;
    }
    if (inspection.execution === undefined) {
      const id = `harbor:${hash({ namespace: options.namespace, originalTrialId }).slice(7)}`;
      inspection.execution = { schemaVersion: "ebo.harbor-execution/v1", id, originalTrialId, runId: `imported-${id}`, attemptId: `harbor-trial-${id.slice("harbor:".length)}`,
        identityDigest: hash({ namespace: options.namespace, originalTrialId, taskName: original.task_name, taskChecksum: original.task_checksum,
          startedAt: original.started_at ?? null, agent: original.agent_info, configuration: object(original.config).agent }),
        taskName: String(original.task_name), taskChecksum: String(original.task_checksum), modelAliases: [...aliases].sort() };
    }
    if (!files.has("agent/trajectory.json")) return stop("ATIF_SOURCE_MISSING");
    try {
      const trajectory = parseObject(files.get("agent/trajectory.json")!);
      const sourceAgent = object(trajectory.agent);
      if (sourceAgent.name !== info.name || text(sourceAgent.version) === undefined
          || sourceAgent.version !== "unknown" && info.version !== "unknown" && sourceAgent.version !== info.version) return stop("ATIF_TRIAL_AGENT_CONFLICT");
    } catch { return stop("ATIF_HEADER_INVALID"); }
    inspection.captureRevision = hash({ execution: inspection.execution.id, agentFiles: agentFiles(files), trajectory: rawHash(files.get("agent/trajectory.json")!) });
    const rewards = object(object(result.verifier_result).rewards);
    const usableRewards = Object.keys(rewards).length > 0 && Object.values(rewards).every((value) => typeof value === "number" && Number.isFinite(value));
    const assessment = { trialId, originalTrialId, kind: derivation === null ? "original" as const : "regrade" as const,
      resultDigest: rawHash(files.get("result.json")!), taskChecksum: String(result.task_checksum),
      rewards: usableRewards ? rewards as Record<string, number> : null, exceptionType: text(object(result.exception_info).exception_type) ?? null,
      startedAt: text(result.started_at) ?? null, finishedAt: text(result.finished_at) ?? null };
    inspection.assessment = { ...assessment, id: hash({ executionId: inspection.execution.id, ...assessment,
      verifier: descriptors.filter(({ authority }) => authority === "third-party-verifier-record") }) };
    if (originalFiles.size === 0) return stop("ORIGINAL_SOURCE_EMPTY");
    inspection.status = "eligible";
    return { inspection, files, result, lineage };
  };
  return inspect(resolve(options.directory), 0);
}

/** Immutable source snapshots, execution identities, capture revisions and assessments occupy separate records. */
export async function importHarborTrial(options: { directory: string; store: string; namespace: string; producer: AtifProducerFingerprint;
  originals?: readonly HarborOriginalBinding[]; pythonExecutable?: string }) {
  const source = await inspectHarborTrial(options);
  const store = resolve(options.store);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  assertNoStoreLinks(store, "");
  const keepJson = (root: string, path: string, value: unknown) => retainJson(root, path, value, store);
  const snapshot = join(store, "sources", source.inspection.snapshotDigest.slice(7));
  assertNoStoreLinks(store, relative(store, snapshot));
  mkdirSync(snapshot, { recursive: true, mode: 0o700 });
  for (const retained of [...source.lineage, source]) {
    const root = join(store, "sources", retained.inspection.snapshotDigest.slice(7));
    for (const [path, bytes] of retained.files) retainExact(root, path, bytes, store);
    keepJson(root, "inventory.json", { schemaVersion: "ebo.harbor-source-snapshot/v1", namespace: retained.inspection.namespace,
      snapshotDigest: retained.inspection.snapshotDigest, files: retained.inspection.files });
    keepJson(join(store, "inspections"), `${hash(retained.inspection).slice(7)}.json`, retained.inspection);
  }
  if (source.inspection.status !== "eligible" || source.inspection.execution === undefined || source.inspection.captureRevision === undefined || source.inspection.assessment === undefined) {
    return { status: "inspect-only" as const, inspection: source.inspection, snapshot };
  }
  const execution = source.inspection.execution;
  keepJson(join(store, "executions"), `${execution.id.slice("harbor:".length)}.json`, execution);
  const revision = hash({ source: source.inspection.captureRevision, producer: options.producer });
  const destination = join(store, "captures", revision.slice(7));
  assertNoStoreLinks(store, `captures/${revision.slice(7)}`);
  mkdirSync(join(store, "captures"), { recursive: true, mode: 0o700 });
  let destinationExists = false;
  try { destinationExists = lstatSync(destination).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let pending: string | undefined;
  if (!destinationExists) {
    assertNoStoreLinks(store, "pending");
    mkdirSync(join(store, "pending"), { recursive: true, mode: 0o700 });
    pending = mkdtempSync(join(store, "pending", `${revision.slice(7, 19)}-`));
  }
  let imported;
  try {
    imported = await importAtifFile({ sourcePath: join(snapshot, "agent/trajectory.json"), destination: pending === undefined ? destination : join(pending, "bundle"),
      runId: execution.runId, attemptId: execution.attemptId, producer: options.producer, pythonExecutable: options.pythonExecutable, modelAliases: execution.modelAliases });
    if (pending !== undefined) { renameSync(join(pending, "bundle"), destination); rmdirSync(pending); }
  } catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}${pending === undefined ? "" : ` Partial admission remains at ${pending}.`}`); }
  const manifest = readImportManifest(destination);
  const binding = { schemaVersion: "ebo.harbor-capture-binding/v1", execution, captureRevision: revision,
    sourceCaptureDigest: source.inspection.captureRevision, importManifestDigest: hash(manifest),
    nativeArtifacts: agentFiles(source.files), modelAliases: execution.modelAliases };
  keepJson(join(store, "bindings"), `${revision.slice(7)}.json`, binding);
  const inspectionDigest = hash(source.inspection);
  keepJson(join(store, "memberships", revision.slice(7), source.inspection.snapshotDigest.slice(7)), `${inspectionDigest.slice(7)}.json`, {
    schemaVersion: "ebo.harbor-capture-membership/v1", captureRevision: revision, sourceSnapshotDigest: source.inspection.snapshotDigest,
    assessmentId: source.inspection.assessment.id, inspectionDigest, bindingDigest: hash(binding), modelAliases: source.inspection.modelAliases,
  });
  keepJson(join(store, "assessments"), `${source.inspection.assessment.id.slice(7)}.json`, {
    schemaVersion: "ebo.harbor-assessment/v1", authority: "third-party", executionId: execution.id, ...source.inspection.assessment,
  });
  return { status: "imported" as const, reused: imported.reused, inspection: source.inspection, snapshot, bundleRoot: destination, binding, inspectionDigest };
}

/** Reopens an explicitly selected revision and snapshot; source metadata cannot select another execution. */
export function readHarborCapture(store: string, captureRevision: Hash, sourceSnapshotDigest: Hash, inspectionDigest?: Hash) {
  const identifier = (value: string) => { if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error("Invalid Harbor content identity."); return value.slice(7); };
  const revision = identifier(captureRevision), snapshotId = identifier(sourceSnapshotDigest);
  const read = (path: string): ObjectValue => {
    const full = join(store, path); assertNoStoreLinks(store, path);
    const value = parseObject(readBoundedFile(full, "Retained Harbor context", undefined, HARBOR_IMPORT_LIMITS.contextBytes));
    const errors = validateArtifact(path, value);
    if (errors.length) throw new Error(`Invalid retained Harbor context: ${errors[0]!.message}`);
    return value;
  };
  const binding = read(`bindings/${revision}.json`);
  const contexts = `memberships/${revision}/${snapshotId}`;
  if (inspectionDigest === undefined) {
    assertNoStoreLinks(store, contexts);
    const directory = opendirSync(join(store, contexts)); const candidates: string[] = [];
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        if (!/^[a-f0-9]{64}\.json$/u.test(entry.name)) throw new Error("Invalid retained Harbor context record.");
        candidates.push(entry.name.slice(0, -5));
        if (candidates.length > 1) throw new Error("Multiple Harbor context receipts; select an inspection digest.");
      }
    } finally { directory.closeSync(); }
    if (candidates.length !== 1) throw new Error("Harbor context receipt is missing.");
    inspectionDigest = `sha256:${candidates[0]!}`;
  }
  const membership = read(`${contexts}/${identifier(inspectionDigest)}.json`);
  if (membership.inspectionDigest !== inspectionDigest) throw new Error("Harbor context identity is stale.");
  if (binding.captureRevision !== captureRevision || membership.captureRevision !== captureRevision
      || membership.sourceSnapshotDigest !== sourceSnapshotDigest || membership.bindingDigest !== hash(binding)) throw new Error("Harbor revision membership is stale.");
  const inspection = read(`inspections/${identifier(String(membership.inspectionDigest))}.json`) as unknown as HarborTrialInspection;
  if (hash(inspection) !== membership.inspectionDigest || inspection.status !== "eligible" || inspection.snapshotDigest !== sourceSnapshotDigest
      || hash(inspection.execution) !== hash(binding.execution) || inspection.assessment?.id !== membership.assessmentId) throw new Error("Harbor inspection binding is stale.");
  const execution = object(binding.execution);
  if (!/^harbor:[a-f0-9]{64}$/u.test(String(execution.id)) || hash(read(`executions/${String(execution.id).slice(7)}.json`)) !== hash(execution)) throw new Error("Harbor execution binding is stale.");
  const retainedBudget = { bytes: 0, entries: 0 };
  const verifySnapshot = (digest: Hash) => {
    const id = identifier(digest), snapshot = read(`sources/${id}/inventory.json`);
    const files = collectTrialFiles(join(store, "sources", id), retainedBudget);
    const descriptors = [...files].map(([path, bytes]): SourceFile => ({ path, bytes: bytes.length, digest: rawHash(bytes),
      authority: path.startsWith("agent/") ? "third-party-agent-log" : path.startsWith("verifier/") ? "third-party-verifier-record" : "third-party-trial-record" }));
    if (snapshot.snapshotDigest !== digest || hash({ namespace: snapshot.namespace, files: descriptors }) !== digest
        || hash(descriptors) !== hash(snapshot.files) || snapshot.namespace !== inspection.namespace) throw new Error("Retained Harbor source snapshot is stale.");
    return files;
  };
  const files = verifySnapshot(sourceSnapshotDigest);
  const queue = [...inspection.originalBindings]; const visited = new Set<string>();
  while (queue.length) {
    const original = queue.shift()!;
    if (visited.has(original.inspectionDigest)) throw new Error("Retained Harbor lineage is cyclic.");
    visited.add(original.inspectionDigest);
    if (visited.size > HARBOR_IMPORT_LIMITS.lineageDepth) throw new Error("Retained Harbor lineage exceeds its limit.");
    verifySnapshot(original.snapshotDigest);
    const receipt = read(`inspections/${identifier(original.inspectionDigest)}.json`) as unknown as HarborTrialInspection;
    if (hash(receipt) !== original.inspectionDigest || receipt.snapshotDigest !== original.snapshotDigest || receipt.trialId !== original.trialId
        || receipt.execution === undefined || receipt.structural?.status !== "valid" || hash(receipt.execution) !== hash(execution)) throw new Error("Retained Harbor lineage is stale.");
    queue.push(...receipt.originalBindings);
  }
  const sourceCaptureDigest = hash({ execution: execution.id, agentFiles: agentFiles(files), trajectory: rawHash(files.get("agent/trajectory.json")!) });
  const bundleRoot = join(store, "captures", revision);
  assertNoStoreLinks(store, `captures/${revision}/manifest.json`);
  const { manifest } = readAtifImportAdmission(bundleRoot);
  if (sourceCaptureDigest !== binding.sourceCaptureDigest || hash({ source: sourceCaptureDigest, producer: manifest.producer }) !== captureRevision
      || hash(manifest) !== binding.importManifestDigest || manifest.identity.runId !== execution.runId || manifest.identity.attemptId !== execution.attemptId
      || manifest.source.digest !== rawHash(files.get("agent/trajectory.json")!) || hash(binding.nativeArtifacts) !== hash(agentFiles(files))) throw new Error("Harbor capture binding is stale.");
  const assessment = read(`assessments/${identifier(String(membership.assessmentId))}.json`);
  const expectedAssessment = { schemaVersion: "ebo.harbor-assessment/v1", authority: "third-party", executionId: execution.id, ...inspection.assessment };
  if (hash(assessment) !== hash(expectedAssessment)) throw new Error("Harbor assessment binding is stale.");
  return { binding, membership, inspection, assessment, bundleRoot };
}

function assertNoStoreLinks(root: string, path: string) {
  let current = resolve(root);
  if (lstatSync(current).isSymbolicLink()) throw new Error("Retained Harbor store links are not admitted.");
  for (const component of path.split("/")) {
    current = join(current, component);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("Retained Harbor store links are not admitted."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; break; }
  }
}

function collectTrialFiles(directory: string, budget = { bytes: 0, entries: 0 }): Map<string, Buffer> {
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Harbor trial root must be a regular directory.");
  const files = new Map<string, Buffer>(); let total = 0, entries = 0;
  const read = (path: string, depth: number) => {
    entries += 1; budget.entries += 1;
    if (budget.entries > HARBOR_IMPORT_LIMITS.files || entries > HARBOR_IMPORT_LIMITS.files) throw new Error("Harbor source inventory exceeds its entry limit.");
    if (!isSafeArtifactRelativePath(path) || depth > HARBOR_IMPORT_LIMITS.depth) throw new Error("Harbor source path exceeds its policy.");
    const full = join(directory, path), stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error("Harbor source links are not admitted.");
    if (stat.isDirectory()) {
      const directory = opendirSync(full);
      try { for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) read(`${path}/${entry.name}`, depth + 1); }
      finally { directory.closeSync(); }
      return;
    }
    if (!stat.isFile()) throw new Error("Harbor sources require regular files.");
    if (files.size >= HARBOR_IMPORT_LIMITS.files || stat.size > HARBOR_IMPORT_LIMITS.fileBytes || total + stat.size > HARBOR_IMPORT_LIMITS.totalBytes || budget.bytes + stat.size > HARBOR_IMPORT_LIMITS.totalBytes) throw new Error("Harbor source inventory exceeds its byte/file limits.");
    const bytes = readBoundedFile(full, "Harbor trial source", undefined, HARBOR_IMPORT_LIMITS.fileBytes);
    total += bytes.length; budget.bytes += bytes.length; if (budget.bytes > HARBOR_IMPORT_LIMITS.totalBytes || total > HARBOR_IMPORT_LIMITS.totalBytes) throw new Error("Harbor source inventory exceeds its byte limit.");
    files.set(path, bytes);
  };
  for (const path of ["agent", "config.json", "lock.json", "result.json", "run.json", "trial.log", "exception.txt", "verifier"]) {
    try { lstatSync(join(directory, path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    read(path, 0);
  }
  return new Map([...files].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}
function parseObject(bytes: Buffer): ObjectValue {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); assertNoDuplicateJsonKeys(text);
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a source object.");
  let nodes = 0;
  const bounded = (entry: unknown, depth: number) => {
    nodes += 1;
    if (nodes > 250_000 || depth > 64 || typeof entry === "number" && (!Number.isFinite(entry) || Number.isInteger(entry) && !Number.isSafeInteger(entry))) throw new Error("Unbounded source JSON.");
    if (entry !== null && typeof entry === "object") for (const key in entry) if (Object.hasOwn(entry, key)) bounded((entry as ObjectValue)[key], depth + 1);
  };
  bounded(value, 0);
  digestMetadata(value);
  return value as ObjectValue;
}
function declaredSubset(source: unknown, target: unknown): boolean {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return hash(source) === hash(target ?? null);
  const candidate = object(target);
  return Object.entries(source).every(([key, value]) => Object.hasOwn(candidate, key) && declaredSubset(value, candidate[key]));
}
function agentFiles(files: Map<string, Buffer>) {
  return [...files].filter(([path]) => path.startsWith("agent/") && path !== "agent/trajectory.json")
    .map(([path, bytes]) => ({ path, digest: rawHash(bytes) }));
}
function retainExact(root: string, path: string, bytes: Buffer, store = root) {
  if (!isSafeArtifactRelativePath(path)) throw new Error("Unsafe retained source path.");
  const storePath = relative(store, join(root, path));
  if (!isSafeArtifactRelativePath(storePath)) throw new Error("Unsafe retained store path.");
  assertNoStoreLinks(store, storePath);
  mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  assertNoStoreLinks(store, "pending-writes");
  mkdirSync(join(store, "pending-writes"), { recursive: true, mode: 0o700 });
  const pending = mkdtempSync(join(store, "pending-writes", "record-")), staged = join(pending, "bytes");
  writeFileSync(staged, bytes, { flag: "wx", mode: 0o600 });
  try { linkSync(staged, join(root, path)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (lstatSync(join(root, path)).size !== bytes.length || !readFileSync(join(root, path)).equals(bytes)) throw new Error("Retained Harbor identity or source bytes conflict; existing evidence and staged bytes are preserved.");
  }
  unlinkSync(staged); rmdirSync(pending);
}
function retainJson(root: string, path: string, value: unknown, store = root) {
  const errors = validateArtifact(path, value);
  if (errors.length) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > HARBOR_IMPORT_LIMITS.contextBytes) throw new Error("Harbor context exceeds the retained metadata byte limit.");
  retainExact(root, path, bytes, store);
}
