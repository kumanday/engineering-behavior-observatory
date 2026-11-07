import { lstatSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalizeMetadata, validateArtifact } from "./artifacts.js";
import { isSafeArtifactRelativePath } from "./contracts.js";
import { listAtifProducerProfiles } from "./atif-profiles.js";
import { readAtifImportAdmission } from "./atif-import.js";
import { inspectHarborTrial, importHarborTrial, readHarborCapture, type HarborOriginalBinding } from "./harbor-import.js";
import { buildCorpusIndex, readCorpusIndex, writeCorpusIndex } from "./corpus.js";
import { LEADERBOARD_PUBLIC_POLICY, selectPinnedLeaderboardFacts, type LeaderboardPolicyReceipt, type LeaderboardPolicyInput } from "./leaderboard-policy.js";
import { deriveLeaderboardInput, metadataHash, parseImportJson, rawHash, readClosedImportFile, readLeaderboardSource, scanImportedFiles, type Hash } from "./leaderboard-source.js";

export type LeaderboardNativeBinding = { factId: string; directory: string; profileId: string; originals?: HarborOriginalBinding[] };
export type LeaderboardCohortRequest = { schemaVersion: "ebo.leaderboard-cohort-request/v1"; policyRevision: string; snapshotRoot: string; acquisitionPath?: string;
  historyCompleteness: "complete" | "bounded-subset"; nativeBindings: LeaderboardNativeBinding[]; withdrawnFactIds?: string[]; priorCohortId?: Hash };
type CohortMember = { executionId: string; captureRevision: Hash; sourceSnapshotDigest: Hash; inspectionDigest: Hash; nativeScanDigest: Hash; assessmentId: Hash;
  importManifestDigest: Hash; factIds: string[]; groups: string[][]; sourceOutcomes: Array<{ factId: string; group: string[]; outcome: string; authority: "third-party" }>;
  assessments: Array<{ factId: string; assessmentId: Hash; sourceSnapshotDigest: Hash; inspectionDigest: Hash; nativeScanDigest: Hash }>; corpusPath: string };
type CaseResult = { factId: string; status: "imported" | "inspect-only" | "quarantined" | "missing" | "withdrawn" | "not-selected"; reason?: string; sourceSnapshotDigest?: Hash };
export type LeaderboardCohortManifest = { schemaVersion: "ebo.leaderboard-cohort/v1"; id: Hash; sharing: "restricted";
  sourceSnapshotDigest: Hash; selectionDigest: Hash; scannerDigest: Hash; scanDigest: Hash; historyCompleteness: "complete" | "bounded-subset";
  sourceAuthority: "third-party"; priorCohortId?: Hash; members: CohortMember[]; cases: CaseResult[];
  selectedSourceRecords: number; admittedExecutions: number };
const jsonBytes = (value: unknown) => {
  const bytes = Buffer.from(`${canonicalizeMetadata(value)}\n`);
  if (bytes.length > 32 * 1024 * 1024) throw new Error("Retained cohort JSON exceeds its readback byte limit.");
  parseImportJson(bytes); // The writer and reader share numeric, depth and aggregate-node limits.
  return bytes;
};
const hashId = (value: string) => { if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error("Invalid cohort content identity."); return value.slice(7); };

/** Structural cohort import only. No candidate, verifier, model judge or remote source is launched. */
export async function importLeaderboardCohort(request: LeaderboardCohortRequest, storeDirectory: string, pythonExecutable = "python3") {
  const requestErrors = validateArtifact("Leaderboard cohort request", request);
  if (requestErrors.length) throw new Error(`Invalid leaderboard cohort request: ${requestErrors[0]!.message}`);
  if (request.policyRevision !== LEADERBOARD_PUBLIC_POLICY.revision || request.schemaVersion !== "ebo.leaderboard-cohort-request/v1" || !Array.isArray(request.nativeBindings) || request.nativeBindings.length > 64
      || !["complete", "bounded-subset"].includes(request.historyCompleteness) || request.withdrawnFactIds !== undefined
      && (!Array.isArray(request.withdrawnFactIds) || request.withdrawnFactIds.length > 100_000 || !request.withdrawnFactIds.every((id) => typeof id === "string" && id.length <= 128))) throw new Error("Invalid or unbounded leaderboard cohort request.");
  const store = resolve(storeDirectory); mkdirSync(store, { recursive: true, mode: 0o700 }); noStoreLinks(store, "");
  const requestReceipt = { schemaVersion: "ebo.leaderboard-request-receipt/v1", policyRevision: request.policyRevision, historyCompleteness: request.historyCompleteness,
    factIds: request.nativeBindings.map(({ factId }) => factId).sort(), withdrawnFactIds: [...request.withdrawnFactIds ?? []].sort(), priorCohortId: request.priorCohortId ?? null };
  const acquisitionBytes = readClosedImportFile(request.snapshotRoot, request.acquisitionPath ?? "acquisition.json", 4 * 1024 * 1024);
  publishDirectory(store, `acquisitions/${rawHash(acquisitionBytes).slice(7)}`, new Map([["acquisition.json", acquisitionBytes]]));
  const source = readLeaderboardSource(request.snapshotRoot, request.acquisitionPath, request.historyCompleteness);
  const protectedFiles = new Map(source.acquisition.artifacts.map((artifact): [string, Buffer] => [`metadata/${artifact.remotePath}`, source.files.get(artifact.localPath)!]));
  protectedFiles.set("inventory.json", jsonBytes({ schemaVersion: "ebo.leaderboard-source-snapshot/v1", snapshotDigest: source.snapshotDigest,
    source: source.acquisition.source, artifacts: [...source.acquisition.artifacts].map(({ localPath: _local, ...artifact }) => artifact).sort((a, b) => a.remotePath < b.remotePath ? -1 : a.remotePath > b.remotePath ? 1 : 0) }));
  publishDirectory(store, `sources/${source.snapshotDigest.slice(7)}`, protectedFiles);
  if (source.scan.status !== "clean" || source.acquisitionScan.status !== "clean") {
    publishDirectory(store, `quarantines/${source.snapshotDigest.slice(7)}/${metadataHash({scan: source.scan, acquisitionScan: source.acquisitionScan}).slice(7)}`, new Map([["scan.json", jsonBytes(source.scan)], ["acquisition-scan.json", jsonBytes(source.acquisitionScan)]]));
    return { status: "quarantined" as const, sourceSnapshotDigest: source.snapshotDigest, findings: source.scan.findings.length + source.acquisitionScan.findings.length };
  }
  const selection = await selectPinnedLeaderboardFacts(source.input, pythonExecutable);
  publishDirectory(store, `selections/${metadataHash(selection).slice(7)}`, new Map([["selection.json", jsonBytes(selection)], ["input.json", jsonBytes(source.input)]]));
  if (selection.status !== "available") return { status: "inspect-only" as const, sourceSnapshotDigest: source.snapshotDigest, diagnostics: selection.diagnostics };
  if (request.priorCohortId !== undefined) readLeaderboardCohort(store, request.priorCohortId);
  const selectedIds = new Set(selection.rows.map(({ id }) => id));
  const withdrawn = new Set(request.withdrawnFactIds ?? []), seen = new Set<string>(), members = new Map<string, CohortMember>(), cases: CaseResult[] = [];
  for (const binding of [...request.nativeBindings].sort((a, b) => a.factId < b.factId ? -1 : a.factId > b.factId ? 1 : 0)) {
    if (!binding || typeof binding.factId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(binding.factId)
        || typeof binding.directory !== "string" || typeof binding.profileId !== "string" || seen.has(binding.factId)) throw new Error("Native source bindings require unique bounded trial identities.");
    seen.add(binding.factId);
    if (withdrawn.has(binding.factId)) { cases.push({ factId: binding.factId, status: "withdrawn", reason: "OPERATOR_WITHDRAWAL" }); continue; }
    if (!selectedIds.has(binding.factId)) { cases.push({ factId: binding.factId, status: "not-selected", reason: "OUTSIDE_PINNED_SOURCE_SELECTION" }); continue; }
    let inspected: Awaited<ReturnType<typeof inspectHarborTrial>>;
    try { inspected = await inspectHarborTrial({ directory: binding.directory, namespace: "huggingface-bucket:joelniklaus/harness-leaderboard", originals: binding.originals, pythonExecutable }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { cases.push({ factId: binding.factId, status: "missing", reason: "TRIAL_SOURCE_MISSING_OR_MOVED" }); continue; }
      throw error;
    }
    const scanFiles = new Map<string, Buffer>([...inspected.files].map(([path, bytes]) => [`trial/${path}`, bytes]));
    for (const original of inspected.lineage) for (const [path, bytes] of original.files) scanFiles.set(`lineage/${original.inspection.snapshotDigest.slice(7)}/${path}`, bytes);
    const scan = scanImportedFiles(scanFiles);
    for (const retained of [...inspected.lineage, inspected]) {
      publishDirectory(store, `native-sources/${retained.inspection.snapshotDigest.slice(7)}`, retained.files);
      publishDirectory(store, `native-inspections/${metadataHash(retained.inspection).slice(7)}`, new Map([["inspection.json", jsonBytes(retained.inspection)]]));
    }
    publishDirectory(store, `native-scans/${metadataHash(scan).slice(7)}`, new Map([["scan.json", jsonBytes(scan)]]));
    if (scan.status !== "clean") {
      publishDirectory(store, `quarantines/${inspected.inspection.snapshotDigest.slice(7)}/${metadataHash(scan).slice(7)}`, new Map([["scan.json", jsonBytes(scan)]]));
      cases.push({ factId: binding.factId, status: "quarantined", reason: "SOURCE_SCAN_QUARANTINED", sourceSnapshotDigest: inspected.inspection.snapshotDigest }); continue;
    }
    const facts = selection.rows.filter(({ id }) => id === binding.factId).map(({ sourceIndex }) => source.input.facts[sourceIndex]!);
    const result = inspected.result, info = result?.agent_info as Record<string, unknown> | undefined;
    const taskPath = (result?.task_id as Record<string, unknown> | undefined)?.path;
    const assessment = inspected.inspection.assessment;
    const profile = listAtifProducerProfiles().find(({ id }) => id === binding.profileId);
    if (inspected.inspection.status !== "eligible" || profile === undefined || inspected.inspection.trialId !== binding.factId.toLowerCase()
        || facts.some((fact) => fact.harness !== info?.name || fact.harness_version !== info?.version
          || fact.task !== String(taskPath ?? "").replace(/\/+$/u, "").split("/").at(-1)
          || fact.reward !== (assessment?.rewards?.reward ?? null) || fact.exception !== assessment?.exceptionType)) {
      cases.push({ factId: binding.factId, status: "inspect-only", reason: "SOURCE_FACT_OR_PRODUCER_CONTEXT_UNRESOLVED", sourceSnapshotDigest: inspected.inspection.snapshotDigest }); continue;
    }
    const aliases = protectedModelAliases(source.input as LeaderboardPolicyInput, selection, [binding.factId]);
    if (aliases === undefined || new Set([...inspected.inspection.execution!.modelAliases, ...aliases]).size > 256) {
      cases.push({factId:binding.factId,status:"inspect-only",reason:"MODEL_ALIAS_CONTEXT_UNRESOLVED",sourceSnapshotDigest:inspected.inspection.snapshotDigest}); continue;
    }
    // Admission reads the exact immutable bytes covered by the scan, including every bound original.
    const originalSnapshots = new Map<string, string>();
    for (const retained of [...inspected.lineage, inspected]) for (const original of retained.inspection.originalBindings) {
      const directory = join(store, "native-sources", original.snapshotDigest.slice(7));
      if (originalSnapshots.has(original.sourceReference) && originalSnapshots.get(original.sourceReference) !== directory) throw new Error("Original source binding is ambiguous.");
      originalSnapshots.set(original.sourceReference, directory);
    }
    const imported = await importHarborTrial({ directory: join(store, "native-sources", inspected.inspection.snapshotDigest.slice(7)), store: join(store, "harbor"), namespace: "huggingface-bucket:joelniklaus/harness-leaderboard", producer: profile.producer, additionalModelAliases: aliases, originals: [...originalSnapshots].map(([sourceReference, directory]) => ({ sourceReference, directory })), pythonExecutable });
    if (imported.status !== "imported") { cases.push({ factId: binding.factId, status: "inspect-only", reason: "HARBOR_ADMISSION_UNAVAILABLE" }); continue; }
    readHarborCapture(join(store, "harbor"), imported.binding.captureRevision, imported.inspection.snapshotDigest, imported.inspectionDigest);
    const executionId = imported.binding.execution.id;
    const member: CohortMember = { executionId, captureRevision: imported.binding.captureRevision, sourceSnapshotDigest: imported.inspection.snapshotDigest,
      inspectionDigest: imported.inspectionDigest, nativeScanDigest: metadataHash(scan), assessmentId: imported.inspection.assessment!.id as Hash, importManifestDigest: imported.binding.importManifestDigest,
      factIds: [binding.factId], groups: selection.rows.filter(({ id }) => id === binding.factId).map(({ group }) => group),
      sourceOutcomes: selection.rows.filter(({ id }) => id === binding.factId).map(({ outcome, group }) => ({ factId: binding.factId, group, outcome, authority: "third-party" })),
      assessments: [{ factId: binding.factId, assessmentId: imported.inspection.assessment!.id as Hash, sourceSnapshotDigest: imported.inspection.snapshotDigest, inspectionDigest: imported.inspectionDigest, nativeScanDigest: metadataHash(scan) }],
      corpusPath: `corpus/${executionId.slice(7)}` };
    const prior = members.get(executionId);
    if (prior && prior.captureRevision !== member.captureRevision) throw new Error("A selected execution has multiple capture revisions; select one revision explicitly.");
    if (prior) { prior.factIds.push(binding.factId); prior.groups.push(...member.groups); prior.sourceOutcomes.push(...member.sourceOutcomes); prior.assessments.push(...member.assessments); }
    else members.set(executionId, member);
    cases.push({ factId: binding.factId, status: "imported", sourceSnapshotDigest: imported.inspection.snapshotDigest });
  }
  const orderedMembers = [...members.values()].sort((a, b) => a.executionId.localeCompare(b.executionId));
  const body = { schemaVersion: "ebo.leaderboard-cohort/v1" as const, sharing: "restricted" as const, sourceSnapshotDigest: source.snapshotDigest,
    selectionDigest: metadataHash(selection), scanDigest: metadataHash(source.scan), scannerDigest: source.scan.scannerDigest, historyCompleteness: request.historyCompleteness,
    sourceAuthority: "third-party" as const, ...(request.priorCohortId === undefined ? {} : { priorCohortId: request.priorCohortId }),
    members: orderedMembers, cases, selectedSourceRecords: selection.rows.length, admittedExecutions: orderedMembers.length };
  const manifest: LeaderboardCohortManifest = { ...body, id: metadataHash(body) };
  const errors = validateArtifact("Leaderboard cohort", manifest);
  if (errors.length) throw new Error(`Invalid generated leaderboard cohort: ${errors[0]!.message}`);
  const files = new Map<string, Buffer>([["cohort.json", jsonBytes(manifest)], ["selection.json", jsonBytes(selection)], ["input.json", jsonBytes(source.input)], ["scan.json", jsonBytes(source.scan)]]);
  for (const member of orderedMembers) for (const path of ["manifest.json", "trajectory.json", "inspection.json"]) {
    files.set(`${member.corpusPath}/${path}`, readClosedImportFile(join(store, "harbor", "captures", member.captureRevision.slice(7)), path, path === "trajectory.json" ? 64 * 1024 * 1024 : 32 * 1024 * 1024));
  }
  const relative = `cohorts/${manifest.id.slice(7)}`;
  const reused = publishDirectory(store, relative, files, (pending) => {
    mkdirSync(join(pending, "corpus"), { recursive: true, mode: 0o700 });
    writeCorpusIndex(join(pending, "corpus-index.jsonl"), buildCorpusIndex(join(pending, "corpus")));
  });
  const root = join(store, relative);
  publishDirectory(store, `contexts/${manifest.id.slice(7)}/${source.receiptDigest.slice(7)}/${metadataHash(requestReceipt).slice(7)}`, new Map([["source.json", source.receiptBytes], ["request.json", jsonBytes(requestReceipt)], ["acquisition-scan.json", jsonBytes(source.acquisitionScan)]]));
  readLeaderboardCohort(store, manifest.id);
  return { status: "imported" as const, reused, cohortId: manifest.id, cohortRoot: root, selectedSourceRecords: manifest.selectedSourceRecords, admittedExecutions: manifest.admittedExecutions, cases };
}

/** Reopens the selected corpus and source bindings without executing policy code or requiring Python. */
export function readLeaderboardCohort(store: string, id: Hash) {
  const root = join(store, "cohorts", hashId(id)); noStoreLinks(store, `cohorts/${hashId(id)}`);
  const manifest = parseImportJson(readClosedImportFile(root, "cohort.json", 32 * 1024 * 1024)) as unknown as LeaderboardCohortManifest;
  const schemaErrors = validateArtifact("Retained leaderboard cohort", manifest);
  if (schemaErrors.length) throw new Error(`Invalid retained cohort: ${schemaErrors[0]!.message}`);
  const { id: recorded, ...body } = manifest;
  if (manifest.schemaVersion !== "ebo.leaderboard-cohort/v1" || recorded !== id || metadataHash(body) !== id || manifest.sharing !== "restricted"
      || manifest.sourceAuthority !== "third-party" || !Array.isArray(manifest.members) || manifest.members.length > 64 || manifest.members.length !== manifest.admittedExecutions || !Array.isArray(manifest.cases) || manifest.cases.length > 64) throw new Error("Invalid or stale leaderboard cohort.");
  const selection = parseImportJson(readClosedImportFile(root, "selection.json", 32 * 1024 * 1024));
  const input = parseImportJson(readClosedImportFile(root, "input.json", 32 * 1024 * 1024));
  const scan = parseImportJson(readClosedImportFile(root, "scan.json", 32 * 1024 * 1024));
  for (const [kind, value] of [["Leaderboard policy receipt", selection], ["Leaderboard policy input", input], ["Import scan", scan]] as const) {
    const errors = validateArtifact(kind, value); if (errors.length) throw new Error(`Invalid retained cohort derivation: ${errors[0]!.message}`);
  }
  if (metadataHash(selection) !== manifest.selectionDigest || selection.inputDigest !== metadataHash(input) || selection.status !== "available"
      || metadataHash(scan) !== manifest.scanDigest || scan.scannerDigest !== manifest.scannerDigest || scan.status !== "clean" || selection.policyDigest !== metadataHash(LEADERBOARD_PUBLIC_POLICY)
      || metadataHash(selection.policy) !== selection.policyDigest || input.policyRevision !== LEADERBOARD_PUBLIC_POLICY.revision || input.historyCompleteness !== manifest.historyCompleteness) throw new Error("Cohort derivation receipts are stale.");
  if (metadataHash(readCorpusIndex(join(root, "corpus-index.jsonl"))) !== metadataHash(buildCorpusIndex(join(root, "corpus")))) throw new Error("Cohort corpus index is stale.");
  noStoreLinks(store, `sources/${hashId(manifest.sourceSnapshotDigest)}`);
  const inventory = parseImportJson(readClosedImportFile(join(store, "sources", hashId(manifest.sourceSnapshotDigest)), "inventory.json", 4 * 1024 * 1024));
  if (metadataHash({ source: inventory.source, artifacts: inventory.artifacts }) !== manifest.sourceSnapshotDigest || !Array.isArray(inventory.artifacts) || inventory.artifacts.length > 4096) throw new Error("Cohort protected source inventory is stale.");
  const protectedFiles = new Map<string, Buffer>(); let metadataBytes = 0;
  for (const descriptor of inventory.artifacts as Array<{ remotePath: string; sha256: string; bytes: number }>) {
    if (!Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 0 || descriptor.bytes > 4 * 1024 * 1024 || !/^[a-f0-9]{64}$/u.test(descriptor.sha256)) throw new Error("Invalid protected metadata descriptor.");
    metadataBytes += descriptor.bytes; if (metadataBytes > 32 * 1024 * 1024) throw new Error("Cohort metadata exceeds its readback limit.");
    const bytes = readClosedImportFile(join(store, "sources", hashId(manifest.sourceSnapshotDigest)), `metadata/${descriptor.remotePath}`, 4 * 1024 * 1024);
    if (bytes.length !== descriptor.bytes || rawHash(bytes) !== `sha256:${descriptor.sha256}` || protectedFiles.has(descriptor.remotePath)) throw new Error("Cohort protected metadata is stale.");
    protectedFiles.set(descriptor.remotePath, bytes);
  }
  const derived = deriveLeaderboardInput(protectedFiles);
  if (metadataHash({ schemaVersion: input.schemaVersion, policyRevision: input.policyRevision, historyCompleteness: input.historyCompleteness, ...derived }) !== metadataHash(input)) throw new Error("Cohort policy input differs from protected source records.");
  const expectedScanInput = [...protectedFiles].map(([path, bytes]) => ({ path, digest: rawHash(bytes), bytes: bytes.length })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (scan.inputDigest !== metadataHash(expectedScanInput)) throw new Error("Cohort protected source scan is stale.");
  const policy = selection as unknown as LeaderboardPolicyReceipt, policyInput = input as unknown as LeaderboardPolicyInput;
  if (manifest.selectedSourceRecords !== policy.rows.length) throw new Error("Cohort selected-record count is stale.");
  for (const row of policy.rows) {
    const fact = policyInput.facts[row.sourceIndex];
    if (!fact || row.id !== fact.id || row.runId !== fact.run_id || row.sourceRunId !== (fact.reused_from || fact.run_id)) throw new Error("Cohort selection source membership is stale.");
  }
  const cases = new Map(manifest.cases.map((item) => [item.factId, item]));
  if (cases.size !== manifest.cases.length) throw new Error("Duplicate cohort case membership.");
  const importedFacts = new Set<string>(), executions = new Set<string>();
  const ordered = (values: unknown[]) => values.map((value) => canonicalizeMetadata(value)).sort();
  for (const member of manifest.members) {
    if (!/^harbor:[a-f0-9]{64}$/u.test(member.executionId) || executions.has(member.executionId) || member.corpusPath !== `corpus/${member.executionId.slice(7)}`) throw new Error("Cohort execution membership is ambiguous.");
    executions.add(member.executionId);
    const ids = new Set(member.factIds);
    if (!ids.size || ids.size !== member.factIds.length || member.assessments.length !== ids.size
        || new Set(member.assessments.map(({factId}) => factId)).size !== ids.size
        || member.assessments.some(({factId}) => !ids.has(factId))) throw new Error("Cohort fact/assessment membership is ambiguous.");
    for (const factId of ids) {
      if (importedFacts.has(factId) || cases.get(factId)?.status !== "imported") throw new Error("Cohort imported case membership is stale.");
      importedFacts.add(factId);
    }
    const rows = policy.rows.filter(({id}) => ids.has(id));
    if (!rows.length || [...ids].some((id) => !rows.some((row) => row.id === id))
        || JSON.stringify(ordered(member.groups)) !== JSON.stringify(ordered(rows.map(({group}) => group)))
        || JSON.stringify(ordered(member.sourceOutcomes)) !== JSON.stringify(ordered(rows.map(({id,group,outcome}) => ({factId:id,group,outcome,authority:"third-party"}))))) throw new Error("Cohort source outcome membership is stale.");
    noStoreLinks(store, "harbor");
    const retained = readHarborCapture(join(store, "harbor"), member.captureRevision, member.sourceSnapshotDigest, member.inspectionDigest);
    verifyNativeScan(store, retained, member.nativeScanDigest, manifest.scannerDigest);
    for (const assessment of member.assessments) {
      const context = readHarborCapture(join(store, "harbor"), member.captureRevision, assessment.sourceSnapshotDigest, assessment.inspectionDigest);
      verifyNativeScan(store, context, assessment.nativeScanDigest, manifest.scannerDigest);
      if (context.assessment.id !== assessment.assessmentId || context.inspection.trialId !== assessment.factId.toLowerCase()) throw new Error("Cohort assessment membership is stale.");
    }
    const admission = readAtifImportAdmission(join(root, member.corpusPath));
    const requiredAliases = protectedModelAliases(policyInput, policy, member.factIds);
    if (requiredAliases === undefined || requiredAliases.some((alias) => !admission.manifest.blinding?.modelAliases.includes(alias))) throw new Error("Cohort protected model blinding context is stale.");
    if (metadataHash(admission.manifest) !== member.importManifestDigest || retained.binding.importManifestDigest !== member.importManifestDigest
        || retained.inspection.execution!.id !== member.executionId || retained.inspection.assessment!.id !== member.assessmentId) throw new Error("Cohort capture membership is stale.");
  }
  if (manifest.cases.some((item) => item.status === "imported" && !importedFacts.has(item.factId))) throw new Error("Cohort imported case has no execution.");
  return { manifest, root };
}

function protectedModelAliases(input: LeaderboardPolicyInput, policy: LeaderboardPolicyReceipt, factIds: readonly string[]): string[] | undefined {
  const ids = new Set(factIds), models = new Set(policy.rows.filter((row) => ids.has(row.id)).map((row) => row.group[0])), aliases = new Set<string>();
  const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  for (const row of policy.rows) if (models.has(row.group[0])) {
    const fact = input.facts[row.sourceIndex]!;
    for (const id of [fact.run_id, fact.reused_from]) {
      if (typeof id !== "string" || !Object.hasOwn(input.runs, id)) continue;
      const run = object(input.runs[id]);
      for (const value of [run.model, object(run.route).model]) if (typeof value === "string" && value.trim()) {
        if (value.length > 1024) return undefined; aliases.add(value);
        if (aliases.size > 256) return undefined;
      }
    }
  }
  return [...aliases].sort();
}

function verifyNativeScan(store: string, retained: ReturnType<typeof readHarborCapture>, scanDigest: Hash, scannerDigest: Hash) {
  noStoreLinks(store, `native-scans/${hashId(scanDigest)}`);
    const nativeScan = parseImportJson(readClosedImportFile(join(store, "native-scans", hashId(scanDigest)), "scan.json", 32 * 1024 * 1024));
    if (metadataHash(nativeScan) !== scanDigest || nativeScan.status !== "clean" || nativeScan.scannerDigest !== scannerDigest) throw new Error("Cohort native source scan is stale.");
    const nativeInventory = new Map<string, { path: string; digest: string; bytes: number }>();
    for (const file of retained.inspection.files) nativeInventory.set(`trial/${file.path}`, { path: `trial/${file.path}`, digest: file.digest, bytes: file.bytes });
    const lineage = [...retained.inspection.originalBindings], visited = new Set<string>();
    while (lineage.length) {
      const original = lineage.shift()!;
      if (visited.has(original.inspectionDigest)) continue; visited.add(original.inspectionDigest);
      if (visited.size > 8) throw new Error("Cohort native scan lineage exceeds its limit.");
      const record = parseImportJson(readClosedImportFile(join(store, "harbor"), `inspections/${hashId(original.inspectionDigest)}.json`, 32 * 1024 * 1024)) as unknown as typeof retained.inspection;
      if (metadataHash(record) !== original.inspectionDigest) throw new Error("Cohort native scan lineage is stale.");
      for (const file of record.files) {
        const path = `lineage/${original.snapshotDigest.slice(7)}/${file.path}`;
        nativeInventory.set(path, { path, digest: file.digest, bytes: file.bytes });
      }
      lineage.push(...record.originalBindings);
    }
    if (nativeScan.inputDigest !== metadataHash([...nativeInventory.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) throw new Error("Cohort native scan input is stale.");
}

function noStoreLinks(root: string, path: string) {
  let current = resolve(root); if (lstatSync(current).isSymbolicLink()) throw new Error("Import store links are not admitted.");
  for (const part of path.split("/").filter(Boolean)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("Import store links are not admitted."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; break; }
  }
}
function publishDirectory(store: string, path: string, files: ReadonlyMap<string, Buffer>, prepare?: (pending: string) => void): boolean {
  if (!isSafeArtifactRelativePath(path)) throw new Error("Unsafe immutable import destination."); noStoreLinks(store, path);
  const destination = join(store, path);
  try {
    if (lstatSync(destination).isDirectory()) {
      for (const [path, bytes] of files) if (!readClosedImportFile(destination, path, bytes.length).equals(bytes)) throw new Error("Immutable cohort identity conflicts with retained bytes.");
      return true;
    }
    throw new Error("Immutable import destination is not a directory.");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  noStoreLinks(store, "pending"); mkdirSync(join(store, "pending"), { recursive: true, mode: 0o700 });
  const pending = mkdtempSync(join(store, "pending", "cohort-"));
  for (const [path, bytes] of files) {
    if (!isSafeArtifactRelativePath(path)) throw new Error("Unsafe immutable import file path.");
    mkdirSync(dirname(join(pending, path)), { recursive: true, mode: 0o700 }); writeFileSync(join(pending, path), bytes, { flag: "wx", mode: 0o600 });
  }
  prepare?.(pending);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 }); renameSync(pending, destination); return false;
}
