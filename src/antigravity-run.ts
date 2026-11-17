import { bindActiveQueueEntry, queueEntryMatches, assertActiveRuntimeQueue, currentStudyRuntime, requireStudyRuntime, runInStudyRuntime, runtimeExecutionSummary, lockedRuntimeExecutable, recordRuntimeProbe, type RuntimeExecutionSummary, type StudyRuntimeBinding } from "./runtime-context.js";
import { isExactRuntimeVersion } from "./runtime-resolution.js";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { assertNoDuplicateJsonKeys, digestMetadata, validateArtifact, validateRunManifestEvidence } from "./artifacts.js";
import { isSafeArtifactRelativePath, resolveBundleConfiguration, type ArtifactReference } from "./contracts.js";
import {
  captureAntigravityCli,
  captureAntigravityCliOwned,
  bindAntigravityRuntime,
  ANTIGRAVITY_ADAPTER_VERSION,
  ANTIGRAVITY_DEFAULT_SHUTDOWN_GRACE_MS,
  ANTIGRAVITY_HARNESS,
  describeAndValidateAntigravityDataset,
  type AntigravityCliCapture,
  type AntigravityCliConfiguration,
  ANTIGRAVITY_CONTRACT_DIGEST,
  probeAntigravityRuntime,
} from "./antigravity.js";
import {
  createAttemptIdentity,
  createRunIdentity,
  executeRunAttempt,
  type RunAttemptResult,
  type TerminalRecord,
  type VerifierExecutionContext,
  type WorkspaceCoordinator,
  type WorkspaceExecutionResult,
} from "./lifecycle.js";
import type { AdapterCoverageReport, NormalizedDataset } from "./normalization-integrity.js";
import {
  createRunBundleAssembler,
  qualifyRunBundle,
  type CaptureMissingEvidence,
  type CaptureQualificationReport,
  type CaptureQualificationStatus,
  type CapturedWorkspaceOutcome,
  type RunBundleDefinition,
  type RunManifest,
} from "./run-bundles.js";
import { readBoundedFile, readRunQueue, type RunQueueEntry } from "./scheduler.js";
import { assertTaskPacketAdmitted, formatErrors, type TaskPacket } from "./task-packets.js";
import { executeVerifier, type VerifierResult } from "./verifiers.js";
import { cleanupWorkspace, materializeWorkspace } from "./workspaces.js";

export const ANTIGRAVITY_CONFIG_SCHEMA_VERSION = "ebo.antigravity-config/v1";
export { ANTIGRAVITY_CONTRACT_DIGEST, probeAntigravityRuntime } from "./antigravity.js";
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type AntigravityModelConfiguration = {
  schemaVersion: typeof ANTIGRAVITY_CONFIG_SCHEMA_VERSION;
  kind: "model";
  provider: "google";
  model: string;
  effort?: AntigravityCliConfiguration["effort"];
};

export type AntigravityHarnessConfiguration = {
  schemaVersion: typeof ANTIGRAVITY_CONFIG_SCHEMA_VERSION;
  kind: "harness";
  adapter: typeof ANTIGRAVITY_HARNESS;
  executable: string;
  version: string;
  contractDigest: `sha256:${string}`;
  /** Native Google-account home in the execution environment; credentials stay with agy. */
  accountHome?: string;
};

export type AntigravityNativeLimitsConfiguration = {
  schemaVersion: typeof ANTIGRAVITY_CONFIG_SCHEMA_VERSION;
  kind: "native-limits";
  shutdownGraceMs?: number;
};

export type AntigravityNativeToolPolicyConfiguration = {
  schemaVersion: typeof ANTIGRAVITY_CONFIG_SCHEMA_VERSION;
  kind: "native-tool-policy";
  permissionMode: AntigravityCliConfiguration["permissionMode"];
  sandbox: boolean;
};

export type AntigravityCaptureProfileConfiguration = {
  schemaVersion: typeof ANTIGRAVITY_CONFIG_SCHEMA_VERSION;
  kind: "capture-profile";
  workspaceOutcome?: {
    excludeDirectoryNames: string[];
    respectGitignore?: boolean;
    omitEmptyDirectories?: boolean;
  };
};

export type AntigravityConfigurationRecord = AntigravityModelConfiguration | AntigravityHarnessConfiguration
  | AntigravityNativeLimitsConfiguration | AntigravityNativeToolPolicyConfiguration | AntigravityCaptureProfileConfiguration;
export type AntigravityConfigurationKind = AntigravityConfigurationRecord["kind"];

export type CaptureAntigravityCliVerifier = (
  context: VerifierExecutionContext,
  workspace: CapturedWorkspaceOutcome,
  workspacePath: string,
) => VerifierResult | Promise<VerifierResult>;

export type CaptureAntigravityCliRunOptions = {
  runtime?: StudyRuntimeBinding;
  definition: RunBundleDefinition;
  startingWorkspacePath: string;
  workspace: WorkspaceCoordinator;
  configuration: AntigravityCliConfiguration;
  prompt: string;
  verifier?: CaptureAntigravityCliVerifier;
  workspaceOutcomeExcludedDirectoryNames?: readonly string[];
  workspaceOutcomeRespectsGitignore?: boolean;
  workspaceOutcomeOmitsEmptyDirectories?: boolean;
  signal?: AbortSignal;
  maxWallClockMs?: number;
  shutdownGraceMs?: number;
  capture?: typeof captureAntigravityCli;
};

export type CaptureAntigravityCliRunResult = {
  runtime?: RuntimeExecutionSummary;
  attempt: RunAttemptResult;
  manifest: RunManifest;
  qualification: CaptureQualificationReport;
  capture?: AntigravityCliCapture;
  normalized?: NormalizedDataset;
  coverage?: AdapterCoverageReport;
};

/** Execute and retain one caller-configured Antigravity CLI attempt without scheduling or retrying it. */
export async function captureAntigravityCliRun(options: CaptureAntigravityCliRunOptions): Promise<CaptureAntigravityCliRunResult> {
  return runInStudyRuntime(ANTIGRAVITY_HARNESS, options.runtime, () => captureAntigravityCliRunOwned(options));
}

export async function captureAntigravityCliRunOwned(options: CaptureAntigravityCliRunOptions): Promise<CaptureAntigravityCliRunResult> {
  requireStudyRuntime(ANTIGRAVITY_HARNESS);
  options = { ...options, configuration: await bindAntigravityRuntime(options.configuration) };
  if (options.definition.run.harness.id !== ANTIGRAVITY_HARNESS) throw new Error(`Antigravity run harness must be ${ANTIGRAVITY_HARNESS}.`);
  if (options.definition.run.model.id !== options.configuration.model || options.definition.run.model.provider !== "google") {
    throw new Error("The declared model must match the Antigravity CLI configuration.");
  }
  const shutdownGraceMs = options.shutdownGraceMs ?? ANTIGRAVITY_DEFAULT_SHUTDOWN_GRACE_MS;
  const assembler = await createRunBundleAssembler(withPinnedRuntime(options.definition));
  let workspace: WorkspaceExecutionResult | undefined;
  let workspaceOutcome: CapturedWorkspaceOutcome | undefined;
  let workspaceOutcomePromise: Promise<CapturedWorkspaceOutcome> | undefined;
  let verifierResult: VerifierResult | undefined;
  let capture: AntigravityCliCapture | undefined;
  let nativeEvidenceRegistered = false;

  const captureWorkspace = async (context?: VerifierExecutionContext): Promise<CapturedWorkspaceOutcome> => {
    if (workspaceOutcome !== undefined) return workspaceOutcome;
    if (workspace?.status !== "ready" || workspace.path === undefined || workspace.artifactId === undefined) {
      throw new Error("Antigravity capture requires a ready retained workspace before outcome packaging.");
    }
    workspaceOutcomePromise ??= assembler.captureWorkspaceOutcome({
      startPath: options.startingWorkspacePath,
      finalPath: workspace.path,
      id: workspace.artifactId,
      source: "antigravity-workspace-outcome",
      ...(options.workspaceOutcomeExcludedDirectoryNames === undefined ? {} : {
        excludeDirectoryNames: options.workspaceOutcomeExcludedDirectoryNames,
      }),
      ...(options.workspaceOutcomeRespectsGitignore === undefined ? {} : {
        respectGitignore: options.workspaceOutcomeRespectsGitignore,
      }),
      ...(options.workspaceOutcomeOmitsEmptyDirectories === undefined ? {} : {
        omitEmptyDirectories: options.workspaceOutcomeOmitsEmptyDirectories,
      }),
    }, context === undefined || options.verifier === undefined ? undefined : async (path, outcome) => {
      verifierResult = await options.verifier!(context, outcome, path);
    });
    workspaceOutcome = await workspaceOutcomePromise;
    return workspaceOutcome;
  };

  const registerNativeEvidence = async (): Promise<void> => {
    if (nativeEvidenceRegistered || capture === undefined) return;
    if (await nonempty(`${assembler.bundleRoot}/session.jsonl`)) {
      await assembler.registerArtifact({
        id: "session",
        source: ANTIGRAVITY_HARNESS,
        kind: "session",
        mediaType: "application/x-ndjson",
        sharingClass: "restricted",
        relativePath: "session.jsonl",
        ...(capture.sessionId === undefined ? {} : { nativeReference: { type: "session", id: capture.sessionId } }),
      });
    }
    await assembler.writeJsonArtifact({
      id: "telemetry",
      source: ANTIGRAVITY_HARNESS,
      kind: "telemetry",
      mediaType: "application/json",
      sharingClass: "restricted",
      relativePath: "telemetry/antigravity.json",
    }, capture.telemetry);
    nativeEvidenceRegistered = true;
  };

  const coordinatedWorkspace: WorkspaceCoordinator = {
    setup: async (context) => {
      workspace = await options.workspace.setup(context);
      return workspace;
    },
    cleanup: async (context) => {
      // Packaging gaps must not rewrite native completion or delete recoverable work.
      if (workspace?.status === "ready") {
        try { await captureWorkspace(); } catch { return; }
      }
      await options.workspace.cleanup?.(context);
    },
  };
  const run = createRunIdentity({
    id: options.definition.run.id,
    taskId: options.definition.run.task.id,
    modelId: options.definition.run.model.id,
    harnessId: options.definition.run.harness.id,
  });
  const attemptIdentity = createAttemptIdentity(
    options.definition.run.id,
    options.definition.attempt.number,
    options.definition.attempt.id,
    options.definition.attempt.retryOf,
  );
  const performCapture = options.capture ?? captureAntigravityCliOwned;
  const attempt = await executeRunAttempt({
    run,
    assessmentMode: options.definition.run.assessmentMode,
    attempt: attemptIdentity,
    workspace: coordinatedWorkspace,
    harness: async ({ signal, registerShutdown }) => {
      if (workspace?.status !== "ready" || workspace.path === undefined) throw new Error("Antigravity run requires a ready workspace.");
      capture = await performCapture({
        runId: options.definition.run.id,
        attemptId: options.definition.attempt.id,
        workspacePath: workspace.path,
        prompt: options.prompt,
        configuration: options.configuration,
        evidencePath: `${assembler.bundleRoot}/session.jsonl`,
        signal,
        registerShutdown,
        shutdownGraceMs,
      });
      if (capture.terminalStatus === "completed") {
        return { status: "completed", completionEvidence: capture.terminal, evidence: durableCaptureEvidence(capture) };
      }
      if (capture.terminalStatus === "interrupted") {
        return { status: "interrupted", reason: "Antigravity turn was interrupted.", evidence: durableCaptureEvidence(capture) };
      }
      return {
        status: "failed",
        failureClass: "infrastructure",
        reason: capture.gaps.find(({ kind }) => kind === "capture-error")?.detail ?? `Antigravity turn ended as ${String(capture.terminalStatus)}.`,
        evidence: durableCaptureEvidence(capture),
      };
    },
    ...(options.verifier === undefined ? {} : {
      verifier: async (context) => {
        await captureWorkspace(context);
        if (verifierResult === undefined) throw new Error("Antigravity verifier did not return a result.");
        await assembler.writeJsonArtifact({
          id: "verifier",
          source: "ebo-verifier",
          kind: "verifier",
          mediaType: "application/json",
          sharingClass: "restricted",
          relativePath: "verifier.json",
        }, verifierResult);
        return { status: verifierResult.status, ...(verifierResult.error === undefined ? {} : { error: verifierResult.error }), evidence: verifierResult };
      },
    }),
    evidence: { flush: registerNativeEvidence },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxWallClockMs === undefined ? {} : { maxWallClockMs: options.maxWallClockMs }),
    shutdownGraceMs,
  });
  if (workspace?.status === "ready") await captureWorkspace().catch(() => undefined);
  await registerNativeEvidence();

  const missingEvidence: CaptureMissingEvidence[] = [];
  if (capture?.sessionId === undefined) missingEvidence.push({
    kind: "session-identity", reason: "not-collected", affects: ["semantic"], detail: "Antigravity did not return an owned conversation identity.",
  });
  for (const gap of capture?.gaps ?? []) missingEvidence.push({
    kind: gap.kind,
    reason: gap.kind === "interrupt-acknowledgement" ? "process-interrupted" : "not-collected",
    affects: [gap.kind.includes("telemetry") ? "timing-resource" : "semantic"],
    detail: gap.detail,
  });
  missingEvidence.push({ kind: "telemetry-receipt", reason: "unsupported", affects: ["timing-resource"], detail: "Native OTLP receipt is unqualified; native step and result usage stay in session evidence." });
  missingEvidence.push({ kind: "child-history", reason: "not-checked", affects: ["semantic"], detail: "Subagent metadata stays native; complete child histories are unavailable through stream-json." });
  const qualificationOptions = {
    startingWorkspacePath: options.startingWorkspacePath,
    semanticEvidenceKinds: ["session"] as const,
    relatedSessionIds: [] as const,
    ...(options.workspaceOutcomeExcludedDirectoryNames === undefined ? {} : {
      workspaceOutcomeExcludedDirectoryNames: options.workspaceOutcomeExcludedDirectoryNames,
    }),
    ...(options.workspaceOutcomeRespectsGitignore === undefined ? {} : {
      workspaceOutcomeRespectsGitignore: options.workspaceOutcomeRespectsGitignore,
    }),
    ...(options.workspaceOutcomeOmitsEmptyDirectories === undefined ? {} : {
      workspaceOutcomeOmitsEmptyDirectories: options.workspaceOutcomeOmitsEmptyDirectories,
    }),
  };
  const terminal = structuredClone(attempt.terminal);
  if (workspaceOutcome === undefined) delete terminal.workspaceArtifactId;
  // ProtocolProcess.wait() has drained the owned child and observed its exit.
  // Record that source-specific confirmation without changing the shared lifecycle policy.
  const processEnded = capture !== undefined && (capture.process.launch.exitCode !== null || capture.process.launch.signal !== null);
  const attemptRecord = { ...attempt.record,
    ...(processEnded ? { harnessTerminationConfirmed: true } : {}),
  };
  const manifest = await assembler.finalize({ terminal, attemptRecord, missingEvidence, qualification: qualificationOptions });
  const qualification = await qualifyRunBundle(assembler.bundleRoot, qualificationOptions);
  if (capture === undefined || capture.sessionId === undefined) return { runtime: runtimeExecutionSummary(), attempt, manifest, qualification, capture };
  const { dataset, coverage } = await describeAndValidateAntigravityDataset(capture);
  return { runtime: runtimeExecutionSummary(), attempt, manifest, qualification, capture, normalized: dataset, coverage };
}

export type RunAntigravityQueueEntryOptions = {
  runtime?: StudyRuntimeBinding;
  bundleRoot: string;
  queuePath: string;
  runId: string;
  outputRoot: string;
  workspaceRoot?: string;
  attemptId?: string;
  signal?: AbortSignal;
  probeRuntime?: (executable: string) => Promise<{ path: string; version: string }>;
  /** Test-only executable prefix; never serialized or exposed as a CLI flag. */
  executableArgs?: readonly string[];
  capture?: typeof captureAntigravityCli;
};

export type AntigravityRunSummary = {
  runtime?: RuntimeExecutionSummary;
  runId: string;
  attemptId: string;
  bundlePath: string;
  terminal: TerminalRecord;
  classification: RunAttemptResult["classification"]["kind"];
  captureQualification: CaptureQualificationStatus;
  assessmentMode: TaskPacket["assessmentMode"];
  sessionId?: string;
  stopReason?: string;
  normalizedEvents: number;
  unmappedNativeRecords: number;
  retainedWorkspacePath?: string;
};

/** Execute exactly one persisted frozen queue entry through the pinned Antigravity CLI adapter. */
export async function runAntigravityQueueEntry(options: RunAntigravityQueueEntryOptions): Promise<AntigravityRunSummary> {
  const binding = options.runtime ?? (currentStudyRuntime() ? undefined : { studyRoot: options.bundleRoot });
  return runInStudyRuntime(ANTIGRAVITY_HARNESS, binding, () => runAntigravityQueueEntryOwned(options));
}

async function runAntigravityQueueEntryOwned(options: RunAntigravityQueueEntryOptions): Promise<AntigravityRunSummary> {
  const bundleRoot = resolve(options.bundleRoot);
  const queue = readRunQueue(options.queuePath, undefined, { bundleRoot });
  assertActiveRuntimeQueue(queue);
  const matches = queue.entries.filter((entry) => queueEntryMatches(queue, entry, options.runId)).map(entry => bindActiveQueueEntry(queue, entry));
  if (matches.length !== 1) throw new Error(matches.length === 0
    ? `Run "${options.runId}" is not in the queue.` : `Run "${options.runId}" matches more than one queue entry.`);
  const entry = matches[0]!;
  const model = resolveAntigravityConfigurationRecord(bundleRoot, entry.configuration.model, "model");
  const harness = resolveAntigravityConfigurationRecord(bundleRoot, entry.configuration.harness, "harness");
  const limits = resolveAntigravityConfigurationRecord(bundleRoot, entry.configuration.nativeLimits, "native-limits");
  const toolPolicy = resolveAntigravityConfigurationRecord(bundleRoot, entry.configuration.nativeToolPolicy, "native-tool-policy");
  const captureProfile = resolveAntigravityConfigurationRecord(bundleRoot, queue.captureProfile, "capture-profile");
  if (entry.harness.id !== ANTIGRAVITY_HARNESS) throw new Error(`Queue harness must be ${ANTIGRAVITY_HARNESS}.`);
  const locked = lockedRuntimeExecutable("agy");
  const runtime = await (options.probeRuntime ?? probeAntigravityRuntime)(locked.path);
  await recordRuntimeProbe("agy", runtime.version, "executable");

  const inspection = assertTaskPacketAdmitted(bundleRoot, entry.task.packetRef.locator);
  const packet = inspection.packet as TaskPacket;
  if (inspection.packetDigest === null || inspection.packetDigest.value !== entry.task.packetRef.digest.value
      || inspection.packetDigest.algorithm !== entry.task.packetRef.digest.algorithm) {
    throw new Error(`Task packet "${entry.task.packetRef.locator}" changed from its frozen queue reference.`);
  }
  const attemptId = options.attemptId ?? randomUUID();
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) throw new Error("Attempt ID must be one safe path component.");
  const outputRoot = resolve(options.outputRoot);
  const destination = join(outputRoot, entry.runId, attemptId);
  const fromOutput = relative(outputRoot, destination);
  if (fromOutput === "" || isAbsolute(fromOutput) || fromOutput === ".." || fromOutput.startsWith(`..${sep}`)) {
    throw new Error("Attempt destination escapes the selected output root.");
  }
  if (await exists(destination)) throw new Error(`Attempt destination "${destination}" already exists and is never replaced.`);

  const workspace = await materializeWorkspace({
    bundleRoot,
    packetLocator: entry.task.packetRef.locator,
    freezeLocator: entry.task.freezeLocator,
    ...(options.workspaceRoot === undefined ? {} : { workspaceParent: options.workspaceRoot }),
  });
  if (workspace.status !== "ready") throw new Error(`Workspace materialization failed: ${workspace.error ?? "unknown failure"}`);
  let baselineRoot: string | undefined;
  let captureStarted = false;
  try {
    baselineRoot = await mkdtemp(join(tmpdir(), "ebo-antigravity-baseline-"));
    const startingWorkspacePath = join(baselineRoot, "workspace");
    await cp(workspace.path, startingWorkspacePath, { recursive: true, preserveTimestamps: true, force: false });
    const verifierReference = packet.assessmentMode === "verified" ? packet.restricted.verifier : undefined;
    const verifierFormat = verifierReference?.locator.toLowerCase().endsWith(".mjs") ? "module" : "commonjs";
    const definition = buildDefinition(queue.captureProfile, entry, packet, destination, attemptId, model, harness, verifierFormat);
    const result = await captureAntigravityCliRunOwned({
      definition,
      startingWorkspacePath,
      workspace: {
        setup: () => {
          captureStarted = true;
          return { status: "ready", path: workspace.path, artifactId: "workspace", retained: true };
        },
        cleanup: () => cleanupWorkspace(workspace),
      },
      configuration: {
        executable: runtime.path,
        ...(options.executableArgs === undefined ? {} : { executableArgs: options.executableArgs }),
        version: harness.version,
        model: model.model,
        effort: model.effort,
        permissionMode: toolPolicy.permissionMode,
        sandbox: toolPolicy.sandbox,
        accountHome: harness.accountHome,
      },
      prompt: packet.agentInput.prompt,
      ...(verifierReference === undefined ? {} : {
        verifier: (context, outcome, projectedPath) => executeVerifier({
          bundleId: definition.bundleId,
          verifierRoot: bundleRoot,
          verifier: verifierReference,
          workspacePath: projectedPath,
          workspaceFingerprint: outcome.fingerprint,
          workspace: { artifactId: outcome.descriptor.id, digest: outcome.descriptor.digest, fingerprint: outcome.fingerprint },
          artifactRoot: destination,
          moduleFormat: verifierFormat,
          signal: context.signal,
        }),
      }),
      maxWallClockMs: queue.coordinatorBudget.maxWallClockMs,
      ...(limits.shutdownGraceMs === undefined ? {} : { shutdownGraceMs: limits.shutdownGraceMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.capture === undefined ? {} : { capture: options.capture }),
      ...(captureProfile.workspaceOutcome === undefined ? {} : {
        workspaceOutcomeExcludedDirectoryNames: captureProfile.workspaceOutcome.excludeDirectoryNames,
        ...(captureProfile.workspaceOutcome.respectGitignore === undefined ? {} : {
          workspaceOutcomeRespectsGitignore: captureProfile.workspaceOutcome.respectGitignore,
        }),
        ...(captureProfile.workspaceOutcome.omitEmptyDirectories === undefined ? {} : {
          workspaceOutcomeOmitsEmptyDirectories: captureProfile.workspaceOutcome.omitEmptyDirectories,
        }),
      }),
    });
    const manifest = reopenManifest(destination);
    const stopReason = result.capture?.terminal?.status;
    return {
      runtime: runtimeExecutionSummary(),
      runId: entry.runId,
      attemptId,
      bundlePath: destination,
      terminal: manifest.terminal,
      classification: result.attempt.classification.kind,
      captureQualification: result.qualification.status,
      assessmentMode: packet.assessmentMode,
      ...(result.capture?.sessionId === undefined ? {} : { sessionId: result.capture.sessionId }),
      ...(typeof stopReason === "string" ? { stopReason } : {}),
      normalizedEvents: result.normalized?.events.length ?? 0,
      unmappedNativeRecords: result.normalized?.unmapped.length ?? 0,
      ...(workspace.state === "ready" ? { retainedWorkspacePath: workspace.path } : {}),
    };
  } finally {
    if (baselineRoot !== undefined) await rm(baselineRoot, { recursive: true, force: true });
    if (!captureStarted && workspace.state === "ready") await cleanupWorkspace(workspace).catch(() => undefined);
  }
}

type AntigravityConfigurationByKind = {
  model: AntigravityModelConfiguration;
  harness: AntigravityHarnessConfiguration;
  "native-limits": AntigravityNativeLimitsConfiguration;
  "native-tool-policy": AntigravityNativeToolPolicyConfiguration;
  "capture-profile": AntigravityCaptureProfileConfiguration;
};

export function resolveAntigravityConfigurationRecord<Kind extends AntigravityConfigurationKind>(
  bundleRoot: string,
  reference: ArtifactReference,
  kind: Kind,
): AntigravityConfigurationByKind[Kind] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(resolveBundleConfiguration(bundleRoot, reference));
  assertNoDuplicateJsonKeys(text);
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || value.schemaVersion !== ANTIGRAVITY_CONFIG_SCHEMA_VERSION || value.kind !== kind) {
    throw configError(reference, `must declare ${ANTIGRAVITY_CONFIG_SCHEMA_VERSION} kind ${kind}`);
  }
  validateConfiguration(value, kind, reference);
  return value as AntigravityConfigurationByKind[Kind];
}

function validateConfiguration(record: Record<string, unknown>, kind: AntigravityConfigurationKind, reference: ArtifactReference): void {
  if (kind === "model") {
    keys(record, ["schemaVersion", "kind", "provider", "model", "effort"], ["provider", "model"], reference);
    if (record.provider !== "google") throw configError(reference, "provider must be google for account authentication");
    requiredText(record.model, "model", reference);
    if (record.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(String(record.effort))) throw configError(reference, "effort is invalid");
  } else if (kind === "harness") {
    keys(record, ["schemaVersion", "kind", "adapter", "executable", "version", "contractDigest", "accountHome"], ["adapter", "executable", "version", "contractDigest"], reference);
    if (record.adapter !== ANTIGRAVITY_HARNESS || !isExactRuntimeVersion(record.version) || record.contractDigest !== ANTIGRAVITY_CONTRACT_DIGEST) throw configError(reference, "adapter, version, or contractDigest is not pinned");
    requiredText(record.executable, "executable", reference);
    if (!isAbsolute(record.executable as string) || record.accountHome !== undefined && (typeof record.accountHome !== "string" || !isAbsolute(record.accountHome))) throw configError(reference, "executable and accountHome must be absolute");
  } else if (kind === "native-limits") {
    keys(record, ["schemaVersion", "kind", "shutdownGraceMs"], [], reference);
    if (record.shutdownGraceMs !== undefined && (!Number.isSafeInteger(record.shutdownGraceMs) || (record.shutdownGraceMs as number) < 1 || (record.shutdownGraceMs as number) > 2147483647)) throw configError(reference, "shutdownGraceMs is invalid");
  } else if (kind === "native-tool-policy") {
    keys(record, ["schemaVersion", "kind", "permissionMode", "sandbox"], ["permissionMode", "sandbox"], reference);
    if (!["request-review", "always-proceed"].includes(String(record.permissionMode)) || typeof record.sandbox !== "boolean") throw configError(reference, "permissionMode or sandbox is invalid");
  } else {
    keys(record, ["schemaVersion", "kind", "workspaceOutcome"], [], reference);
    if (record.workspaceOutcome !== undefined) validateWorkspaceOutcome(record.workspaceOutcome, reference);
  }
}

function validateWorkspaceOutcome(value: unknown, reference: ArtifactReference): void {
  if (!isRecord(value)) throw configError(reference, "workspaceOutcome must be an object");
  keys(value, ["excludeDirectoryNames", "respectGitignore", "omitEmptyDirectories"], ["excludeDirectoryNames"], reference);
  if (!Array.isArray(value.excludeDirectoryNames) || value.excludeDirectoryNames.some((name) => typeof name !== "string"
      || name.includes("/") || !isSafeArtifactRelativePath(name))) throw configError(reference, "workspace exclusions are invalid");
  for (const flag of ["respectGitignore", "omitEmptyDirectories"] as const) {
    if (value[flag] !== undefined && typeof value[flag] !== "boolean") throw configError(reference, `${flag} must be boolean`);
  }
}

function buildDefinition(
  captureProfile: ArtifactReference,
  entry: RunQueueEntry,
  packet: TaskPacket,
  bundleRoot: string,
  attemptId: string,
  model: AntigravityModelConfiguration,
  harness: AntigravityHarnessConfiguration,
  verifierFormat: "commonjs" | "module",
): RunBundleDefinition {
  return {
    bundleRoot,
    bundleId: `bundle-${attemptId}`,
    run: {
      id: entry.runId,
      trial: { index: entry.trial.index },
      assessmentMode: packet.assessmentMode,
      task: { id: entry.task.id, digest: `sha256:${entry.task.packetRef.digest.value}` },
      fixture: { id: packet.agentInput.fixture.source.locator, digest: `sha256:${packet.agentInput.fixture.source.digest.value}` },
      model: { provider: model.provider, id: model.model, configurationDigest: `sha256:${entry.configuration.model.digest.value}` },
      harness: { id: ANTIGRAVITY_HARNESS, version: harness.version, configurationDigest: `sha256:${entry.configuration.harness.digest.value}` },
      runtime: [
        { source: "Google", name: "antigravity-cli", version: harness.version },
        { source: "EBO", name: "antigravity-adapter", version: ANTIGRAVITY_ADAPTER_VERSION },
      ],
      ...(packet.assessmentMode === "verified" ? {
        verifier: { locator: packet.restricted.verifier.locator, digest: `sha256:${packet.restricted.verifier.digest.value}`, format: verifierFormat },
      } : {}),
    },
    attempt: { id: attemptId, number: 1 },
    configuration: {
      digest: `sha256:${digestMetadata({ model: entry.configuration.model, harness: entry.configuration.harness, captureProfile }).value}`,
      captureProfileDigest: `sha256:${captureProfile.digest.value}`,
      budgetDigest: `sha256:${entry.configuration.nativeLimits.digest.value}`,
      toolPolicyDigest: `sha256:${entry.configuration.nativeToolPolicy.digest.value}`,
    },
  };
}

function withPinnedRuntime(definition: RunBundleDefinition): RunBundleDefinition {
  return {
    ...structuredClone(definition),
    run: {
      ...structuredClone(definition.run),
      harness: { ...structuredClone(definition.run.harness), id: ANTIGRAVITY_HARNESS, version: lockedRuntimeExecutable("agy").version },
      runtime: definition.run.runtime.filter(({ name }) => !["antigravity-cli", "antigravity-adapter"].includes(name)).concat([
        { source: "Google", name: "antigravity-cli", version: lockedRuntimeExecutable("agy").version },
        { source: "EBO", name: "antigravity-adapter", version: ANTIGRAVITY_ADAPTER_VERSION },
      ]),
    },
  };
}

function durableCaptureEvidence(capture: AntigravityCliCapture): Record<string, unknown> {
  return {
    qualification: capture.qualification,
    ...(capture.sessionId === undefined ? {} : { sessionId: capture.sessionId }),
    ...(capture.terminalStatus === undefined ? {} : { terminalStatus: capture.terminalStatus }),
    gaps: capture.gaps,
    process: {
      status: capture.process.status,
      partial: capture.process.partial,
      termination: capture.process.termination,
      stdoutFrames: capture.process.stdoutFrames,
      exitCode: capture.process.launch.exitCode,
      signal: capture.process.launch.signal,
      stderrSizeBytes: capture.process.stderr.sizeBytes,
      stderrTruncated: capture.process.stderr.truncated,
    },
  };
}

function reopenManifest(bundleRoot: string): RunManifest {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(join(bundleRoot, "manifest.json"), "Run manifest"));
  assertNoDuplicateJsonKeys(text);
  const value: unknown = JSON.parse(text);
  const errors = [...validateArtifact("manifest.json", value), ...validateRunManifestEvidence("manifest.json", value, bundleRoot)];
  if (errors.length > 0) throw new Error(`Retained run manifest failed validation:\n${formatErrors(errors)}`);
  return value as RunManifest;
}

async function nonempty(path: string): Promise<boolean> {
  try { return (await stat(path)).size > 0; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function keys(record: Record<string, unknown>, allowed: readonly string[], required: readonly string[], reference: ArtifactReference): void {
  const set = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !set.has(key));
  if (unexpected !== undefined) throw configError(reference, `contains unknown field "${unexpected}"`);
  const missing = required.find((key) => record[key] === undefined);
  if (missing !== undefined) throw configError(reference, `is missing "${missing}"`);
}

function requiredText(value: unknown, field: string, reference: ArtifactReference): void {
  if (typeof value !== "string" || value.trim() === "") throw configError(reference, `${field} must be nonempty`);
}

function configError(reference: ArtifactReference, detail: string): Error {
  return new Error(`Antigravity configuration "${reference.locator}" ${detail}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
