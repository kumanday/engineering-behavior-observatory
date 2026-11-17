import { legacyV1Profile, markRetainedVersion } from "./legacy-v1-confidence.js";
import { isExactRuntimeVersion } from "./runtime-resolution.js";
import { requireStudyRuntime, runInStudyRuntime, runtimeExecutionSummary, probeLockedRuntimeExecutable, type StudyRuntimeBinding, type RuntimeExecutionSummary } from "./runtime-context.js";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { assertNoDuplicateJsonKeys, digestMetadata } from "./artifacts.js";
import { createCapturedNativeEvidenceResolver, describeNormalizedDataset, validateNormalizedDataset, type AdapterCoverageReport, type NormalizedDataset } from "./normalization-integrity.js";
import { spawnProtocolProcess, writeProtocolLine, type ProtocolObservation, type ProtocolProcess, type ProtocolProcessResult } from "./process-protocol.js";
import { validateUniformEvents, type AdapterCapabilityProfile, type HarnessAdapter, type NormalizationResult, type QualifiedNativeCapture, type UniformEvent } from "./uniform-events.js";

export const ANTIGRAVITY_CLI_VERSION = "1.5.9";
export const RETAINED_ANTIGRAVITY_CLI_VERSIONS: readonly string[] = [ANTIGRAVITY_CLI_VERSION];
export const ANTIGRAVITY_ADAPTER_VERSION = "0.1.0";
export const ANTIGRAVITY_HARNESS = "antigravity-cli";
export const ANTIGRAVITY_CLIENT = "ebo-antigravity-client";
export const ANTIGRAVITY_DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
export const ANTIGRAVITY_CONTRACT_DIGEST = `sha256:${digestMetadata({
  version: ANTIGRAVITY_CLI_VERSION, input: "stream-json", output: "stream-json",
  inputEvents: ["user"], outputEvents: ["init", "step_update", "result"],
  terminal: "one result for the init conversation_id and num_turns=1", authentication: "google-account",
}).value}` as const;

export type AntigravityCliConfiguration = {
  executable: string;
  version: string;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode: "request-review" | "always-proceed";
  sandbox: boolean;
  /** Native CLI home, with a Google-account login established by the operator. EBO never copies credentials. */
  accountHome?: string;
  /** Test-only executable prefix, absent from persisted configuration. */
  executableArgs?: readonly string[];
};
export type AntigravityCliCaptureRequest = {
  runtime?: StudyRuntimeBinding;
  runId: string; attemptId: string; workspacePath: string; prompt: string;
  configuration: AntigravityCliConfiguration; evidencePath: string;
  signal?: AbortSignal; shutdownGraceMs?: number; maxLineBytes?: number; maxInMemoryObservations?: number;
  registerShutdown?: (shutdown: () => Promise<void>) => void;
};
export type AntigravityRuntimeEvidence = {
  schemaVersion: "ebo.antigravity-runtime/v1";
  runtime: { executable: string; version: string; adapterVersion: string; contractDigest: string };
  effectiveConfiguration: {
    model: string; effort?: string; permissionMode: string; sandbox: boolean;
    authentication: "google-account"; environmentKeys: string[]; settingsDigest: string; useG1Credits?: boolean;
  };
  usage: { semantics: "cumulative-session"; final?: Record<string, unknown>; chargedUsd: null };
  telemetry: { status: "unsupported"; detail: string };
};
export type AntigravityCliCapture = QualifiedNativeCapture<ProtocolObservation> & {
  runtime?: RuntimeExecutionSummary;
  sessionId?: string; terminalStatus?: "completed" | "interrupted" | "failed";
  terminal?: Record<string, unknown>; process: ProtocolProcessResult;
  gaps: readonly { kind: string; detail: string }[]; telemetry: AntigravityRuntimeEvidence;
};

export const ANTIGRAVITY_CLI_CAPABILITIES = {
  schemaVersion: "ebo.adapter-capability-profile/v1", adapterId: "ebo-antigravity-cli", harness: ANTIGRAVITY_HARNESS,
  nativeTypes: ["user", "init", "step_update:user_input", "step_update:agent_response", "step_update:tool", "step_update:checkpoint", "result"],
  families: {
    message: { status: "partial", detail: "Owned input and agent_response text deltas; no complete-message history API is claimed." },
    "model-request": { status: "unsupported", detail: "Steps do not establish individual model requests." },
    tool: { status: "partial", detail: "One ACTIVE start and one DONE result per conversation step; intermediate updates remain native." },
    context: { status: "unsupported", detail: "Checkpoint steps do not establish compaction or context-policy changes." },
    permission: { status: "unsupported", detail: "Headless permissions are native CLI policy; no interactive control protocol is exposed." },
    delegation: { status: "partial", detail: "Native subagent identities and metadata are retained; child histories are unavailable." },
    artifact: { status: "unsupported", detail: "Workspace outcomes are packaged separately from tool execution." },
    validation: { status: "unsupported", detail: "Verifiers run outside the native CLI." },
    runtime: { status: "partial", detail: "Terminal cumulative-session usage; per-step snapshots remain native and are not added to totals." },
    outcome: { status: "available", detail: "Owned result.status establishes the native outcome; exit alone does not." },
  },
  evidence: {
    nativeOrder: { status: "available", detail: "Append order in the owned stdio stream." },
    nativeTime: { status: "partial", detail: "EBO receipt timestamps labeled capture-receipt; native durations stay in the payload." },
    parentage: { status: "partial", detail: "Tool results link to the first observed start for the same conversation and step." },
    content: { status: "partial", detail: "Native payload references; hidden reasoning steps remain unmapped." },
  },
} as const satisfies AdapterCapabilityProfile;

export async function probeAntigravityRuntime(executable: string): Promise<{ path: string; version: string }> {
  if (!isAbsolute(executable)) throw new Error("Antigravity executable must be an absolute path.");
  const path = await realpath(executable);
  const exec = promisify(execFile);
  const { stdout: versionText } = await exec(path, ["--version"], { timeout: 5_000, maxBuffer: 64 * 1024 });
  const { stdout: help, stderr } = await exec(path, ["--help"], { timeout: 5_000, maxBuffer: 128 * 1024 });
  if (!["--input-format", "--output-format", "--print-timeout"].every(flag => (help + stderr).includes(flag))) {
    throw new Error("This agy is the Antigravity IDE launcher. Install the standalone Antigravity CLI and select its absolute executable path.");
  }
  const version = versionText.trim().replace(/^(?:Antigravity|antigravity|agy)(?: CLI)?\s+v?/u, "");
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("Antigravity CLI returned an unrecognized runtime version.");
  return { path, version };
}

/** Retain a single owned conversation. stdin closes after exactly one user message. */
export async function captureAntigravityCli(request: AntigravityCliCaptureRequest): Promise<AntigravityCliCapture> {
  return runInStudyRuntime(ANTIGRAVITY_HARNESS, request.runtime, async () => ({ ...await captureAntigravityCliOwned(request), runtime: runtimeExecutionSummary() }));
}

export async function bindAntigravityRuntime(configuration: AntigravityCliConfiguration): Promise<AntigravityCliConfiguration> {
  requireStudyRuntime(ANTIGRAVITY_HARNESS);
  const actual = await probeLockedRuntimeExecutable("agy");
  await probeAntigravityRuntime(actual.path);
  return { ...configuration, executable: actual.path, version: actual.version };
}

/** Internal protocol layer of an already checked launch. */
export async function captureAntigravityCliOwned(request: AntigravityCliCaptureRequest): Promise<AntigravityCliCapture> {
  if (!isExactRuntimeVersion(request.configuration.version)) throw new Error("Antigravity capture requires an exact requested runtime version.");
  request = { ...request, configuration: await bindAntigravityRuntime(request.configuration) };
  const config = request.configuration;
  if (!isExactRuntimeVersion(config.version)) throw new Error(`Antigravity CLI ${ANTIGRAVITY_CLI_VERSION} is required.`);
  if (!request.runId || !request.attemptId || !request.prompt.trim() || !isAbsolute(request.workspacePath) || !isAbsolute(config.executable)
    || !config.model.trim() || !["request-review", "always-proceed"].includes(config.permissionMode) || typeof config.sandbox !== "boolean"
    || config.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(config.effort)) throw new Error("Invalid Antigravity capture configuration.");
  const accountHome = config.accountHome ?? homedir();
  if (!isAbsolute(accountHome)) throw new Error("Antigravity accountHome must be absolute.");
  const settings = await inspectAccountSettings(accountHome);
  const env: NodeJS.ProcessEnv = {};
  // Retain native OS keyring access, without importing provider credentials or routing overrides.
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = accountHome;
  if (process.platform === "win32") env.USERPROFILE = accountHome;
  env.AGY_CLI_DISABLE_AUTO_UPDATE = "true";
  const gaps: Array<{ kind: string; detail: string }> = [];
  const gap = (kind: string, detail: string) => { if (!gaps.some(g => g.kind === kind && g.detail === detail)) gaps.push({ kind, detail }); };
  let sessionId: string | undefined;
  let terminal: Record<string, unknown> | undefined;
  let aborted = request.signal?.aborted ?? false;
  let protocol: ProtocolProcess;
  let resultTimer: ReturnType<typeof setTimeout> | undefined;
  let retainedStderrBytes = 0;
  const grace = request.shutdownGraceMs ?? ANTIGRAVITY_DEFAULT_SHUTDOWN_GRACE_MS;
  if (!Number.isSafeInteger(grace) || grace < 1 || grace > 2_147_483_647) throw new Error("Invalid Antigravity shutdown grace.");
  const abort = () => { aborted = true; void protocol?.interrupt(grace); };
  protocol = spawnProtocolProcess({
    command: config.executable,
    args: [...(config.executableArgs ?? []), "--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "0", "--disable-slash-commands",
      "--model", config.model, ...(config.effort ? ["--effort", config.effort] : []),
      ...(config.permissionMode === "always-proceed" ? ["--dangerously-skip-permissions"] : []), ...(config.sandbox ? ["--sandbox"] : [])],
    cwd: request.workspacePath, env, source: ANTIGRAVITY_HARNESS, evidencePath: request.evidencePath,
    shutdownGraceMs: grace, maxLineBytes: request.maxLineBytes, maxInMemoryObservations: request.maxInMemoryObservations,
    // stderr is a bounded restricted diagnostic observation, never a second protocol channel.
    onStderr: async (chunk, _final, recorder) => {
      const bytes = Buffer.from(chunk).subarray(0, Math.max(0, 64 * 1024 - retainedStderrBytes));
      retainedStderrBytes += bytes.length;
      if (bytes.length) await recorder.recordNotification({ source: ANTIGRAVITY_HARNESS, method: "diagnostic/stderr", payload: { text: bytes.toString("utf8") } });
    },
    onFrame: async (value, recorder) => {
      if (!isRecord(value) || typeof value.event !== "string") { gap("invalid-event", "CLI emitted an object without an event name."); return; }
      if (value.event === "init") {
        if (sessionId !== undefined || !nonempty(value.conversation_id) || !isRecord(value.init)) { gap("session-identity", "CLI init is duplicated or has no conversation identity."); return; }
        sessionId = value.conversation_id;
        if (value.init.model !== config.model) gap("model-mismatch", "Native init model differs from the selected model.");
        if (value.init.permission_mode !== config.permissionMode) gap("permission-mismatch", "Native init permission mode differs from the frozen policy.");
      } else if (value.event === "step_update") {
        const step = value.step_update;
        if (!isRecord(step) || sessionId === undefined || step.conversation_id !== sessionId) gap("foreign-step", "Step update is not bound to the owned conversation.");
        else if (!Number.isSafeInteger(step.step_index) || (step.step_index as number) < 0) gap("invalid-step", "Step has no valid native step index.");
      } else if (value.event === "result") {
        const native = value.result;
        if (sessionId === undefined && isRecord(native) && native.status === "ERROR" && native.num_turns === 0 && !native.conversation_id) {
          gap("startup-error", "CLI failed before conversation initialization; the restricted native result retains its diagnostic."); return;
        }
        if (!isRecord(native) || sessionId === undefined || native.conversation_id !== sessionId || native.num_turns !== 1 || terminal !== undefined) {
          gap("terminal-identity", "Result lacks the unique owned conversation and single-turn identity."); return;
        }
        terminal = native;
        if (!nonempty(native.status)) { gap("terminal-status", "Result has no native status."); return; }
        await recorder.recordCompletion({ source: ANTIGRAVITY_HARNESS, method: "result", sourceIdentity: sessionId, status: native.status, evidence: native });
        // A native result closes the turn; bound any subsequent child shutdown.
        resultTimer = setTimeout(() => { void protocol.shutdown(); }, grace);
        resultTimer.unref();
      } else gap("unknown-event", `Unmapped native event ${value.event}.`);
    },
  });
  request.registerShutdown?.(async () => { await protocol.interrupt(grace); });
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    await protocol.evidence.recordCapability({ source: ANTIGRAVITY_HARNESS, name: "runtime-composition", status: "available", details: {
      version: config.version, adapterVersion: ANTIGRAVITY_ADAPTER_VERSION, contractDigest: ANTIGRAVITY_CONTRACT_DIGEST,
      model: config.model, authentication: "google-account", settingsDigest: settings.digest,
    } });
    const payload = { event: "user", message: { content: request.prompt } };
    await protocol.evidence.recordRequest({ source: ANTIGRAVITY_CLIENT, method: "user", payload, raw: JSON.stringify(payload) });
    if (aborted) abort();
    else {
      await writeProtocolLine(protocol.stdin, payload);
      protocol.stdin.end();
    }
  } catch (error) {
    gap("capture-error", error instanceof Error ? error.message : String(error));
    await protocol.shutdown();
  }
  let processResult: ProtocolProcessResult;
  try { processResult = await protocol.wait(); }
  finally { request.signal?.removeEventListener("abort", abort); if (resultTimer) clearTimeout(resultTimer); }
  if (!terminal) gap("terminal-missing", "CLI ended without an owned terminal result; exit alone does not establish completion.");
  if (processResult.error || processResult.protocolError || processResult.recorderError) gap("process-error", processResult.error ?? processResult.protocolError?.message ?? processResult.recorderError!);
  if (processResult.droppedObservations) gap("normalization-projection-truncated", "Earlier records remain durable; use retained readback for the complete projection.");
  if (await inspectAccountSettings(accountHome).then(s => s.digest !== settings.digest, () => true)) gap("settings-changed", "Native account settings changed during capture.");
  const nativeStatus = terminal?.status;
  const terminalStatus = aborted || terminal?.finished_reason === "interrupted" || nativeStatus === "CANCELED" || nativeStatus === "INTERRUPTED" ? "interrupted"
    : nativeStatus === "SUCCESS" && !gaps.some(g => ["session-identity", "model-mismatch", "permission-mismatch", "foreign-step", "invalid-step", "terminal-identity", "terminal-status", "process-error", "settings-changed"].includes(g.kind)) ? "completed" : "failed";
  return {
    runId: request.runId, attemptId: request.attemptId, qualification: "qualified-with-gaps",
    records: processResult.observations.map(record => ({ reference: { artifactId: "session", recordLocator: `line:${record.sequence}` }, record })),
    sessionId, terminal, terminalStatus, process: processResult, gaps,
    telemetry: {
      schemaVersion: "ebo.antigravity-runtime/v1",
      runtime: { executable: config.executable, version: config.version, adapterVersion: ANTIGRAVITY_ADAPTER_VERSION, contractDigest: ANTIGRAVITY_CONTRACT_DIGEST },
      effectiveConfiguration: { model: config.model, ...(config.effort ? { effort: config.effort } : {}), permissionMode: config.permissionMode, sandbox: config.sandbox, authentication: "google-account", environmentKeys: Object.keys(env).sort(), settingsDigest: settings.digest, ...(settings.useG1Credits === undefined ? {} : { useG1Credits: settings.useG1Credits }) },
      usage: { semantics: "cumulative-session", ...(isRecord(terminal?.usage) ? { final: terminal.usage } : {}), chargedUsd: null },
      telemetry: { status: "unsupported", detail: "No native OTLP export is qualified. Google product telemetry is separate from EBO evidence." },
    },
  };
}

/** Inspect settings without retaining values or touching native account credentials. */
async function inspectAccountSettings(home: string): Promise<{ digest: string; useG1Credits?: boolean }> {
  const documents: Record<string, unknown> = {};
  let useG1Credits: boolean | undefined;
  for (const path of [".gemini/antigravity-cli/settings.json", ".gemini/config/config.json", ".gemini/config/hooks.json"]) {
    let text: string;
    try { text = await readFile(join(home, path), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    assertNoDuplicateJsonKeys(text);
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new Error("Antigravity native settings must be an object.");
    if (isRecord(value.auth) && value.auth.type !== undefined && value.auth.type !== "oauth-personal") throw new Error("Antigravity requires personal OAuth in the selected native account profile.");
    if (value.modelProvider !== undefined && value.modelProvider !== "") throw new Error("Antigravity requires native Google-account authentication. Remove modelProvider from the selected account's CLI settings.");
    if (path === ".gemini/antigravity-cli/settings.json" && typeof value.useG1Credits === "boolean") useG1Credits = value.useG1Credits;
    documents[path] = value;
  }
  return { digest: `sha256:${digestMetadata(documents).value}`, ...(useG1Credits === undefined ? {} : { useG1Credits }) };
}

export function qualifyRetainedAntigravityCapture(capture: QualifiedNativeCapture<ProtocolObservation>, options: {
  sessionId: string | undefined; expectsCompletion: boolean; harnessVersion: string; runtimeVersions: readonly unknown[];
}): QualifiedNativeCapture<ProtocolObservation> & { sessionId?: string } {
  capture = markRetainedVersion(capture, options.harnessVersion, ANTIGRAVITY_HARNESS, options.runtimeVersions.length ? options.runtimeVersions : [undefined]);
  const records = capture.records.map(r => r.record);
  if (records.some(r => r.source !== ANTIGRAVITY_HARNESS && r.source !== ANTIGRAVITY_CLIENT)) throw new Error("Retained Antigravity contains a foreign source.");
  const compositions = records.filter(r => r.kind === "capability" && r.capability === "runtime-composition");
  if (compositions.length !== 1 || !isRecord(compositions[0]!.evidence) || typeof compositions[0]!.evidence.version !== "string"
    || compositions[0]!.evidence.adapterVersion !== ANTIGRAVITY_ADAPTER_VERSION
    || compositions[0]!.evidence.authentication !== "google-account"
    || compositions[0]!.evidence.contractDigest !== ANTIGRAVITY_CONTRACT_DIGEST) throw new Error("Retained Antigravity runtime composition is missing or inconsistent.");
  const inputs = records.filter(r => r.source === ANTIGRAVITY_CLIENT && r.kind === "request" && r.method === "user");
  if (inputs.length !== 1 || !isRecord(inputs[0]!.payload) || inputs[0]!.payload.event !== "user"
    || !isRecord(inputs[0]!.payload.message) || !nonempty(inputs[0]!.payload.message.content)) throw new Error("Retained Antigravity requires one owned input.");
  const frames = records.filter(r => r.source === ANTIGRAVITY_HARNESS && r.kind === "frame").map(r => ({ record: r, payload: r.payload }));
  const inits = frames.filter(r => isRecord(r.payload) && r.payload.event === "init");
  const init = inits[0]?.payload;
  const sessionId = isRecord(init) && nonempty(init.conversation_id) ? init.conversation_id : undefined;
  if (inits.length > 1 || sessionId !== options.sessionId || options.expectsCompletion && !sessionId) throw new Error("Retained Antigravity init identity differs from the manifest.");
  if (isRecord(init) && (!isRecord(init.init) || init.init.model !== compositions[0]!.evidence.model)) throw new Error("Retained Antigravity model differs from its native composition.");
  const results = frames.filter(r => isRecord(r.payload) && r.payload.event === "result");
  if (results.length > 1) throw new Error("Retained Antigravity has ambiguous terminal evidence.");
  for (const { record, payload } of frames) {
    if (!isRecord(payload)) continue;
    const body = payload.event === "result" ? payload.result : payload.event === "step_update" ? payload.step_update : undefined;
    const startupError = payload.event === "result" && sessionId === undefined && isRecord(body)
      && body.status === "ERROR" && body.num_turns === 0 && !body.conversation_id;
    if (isRecord(body) && !startupError && body.conversation_id !== sessionId) throw new Error("Retained Antigravity contains foreign conversation evidence.");
    if (isRecord(body) && payload.event === "step_update" && (!Number.isSafeInteger(body.step_index) || body.step_index < 0
      || record.sequence <= (inits[0]?.record.sequence ?? Infinity))) throw new Error("Retained Antigravity contains an invalid or unbound step.");
  }
  if (options.expectsCompletion) {
    const result = results[0]?.payload;
    const terminal = isRecord(result) && isRecord(result.result) ? result.result : undefined;
    const completions = records.filter(r => r.kind === "completion" && r.method === "result");
    if (terminal?.status !== "SUCCESS" || terminal.num_turns !== 1 || completions.length !== 1
      || completions[0]!.sourceIdentity !== sessionId || completions[0]!.status !== "SUCCESS"
      || completions[0]!.sequence <= results[0]!.record.sequence || inits[0]!.record.sequence >= results[0]!.record.sequence
      || inputs[0]!.sequence >= results[0]!.record.sequence || digestMetadata(completions[0]!.evidence).value !== digestMetadata(terminal).value) throw new Error("Completed Antigravity capture lacks matching owned SUCCESS evidence.");
  }
  return { ...capture, sessionId };
}

export async function normalizeAntigravityCapture(capture: QualifiedNativeCapture<ProtocolObservation>): Promise<NormalizationResult> {
  const init = capture.records.map(r => r.record.payload).find(p => isRecord(p) && p.event === "init");
  const sessionId = (capture as { sessionId?: string }).sessionId ?? (isRecord(init) ? init.conversation_id : undefined);
  const events: UniformEvent[] = [], mapped = new Set<number>(), starts = new Map<number, string>(), done = new Set<number>();
  const messageDone = new Set<number>();
  let mappedResult = false;
  const delegationSteps = new Set(capture.records.flatMap(({ record }) => {
    const p = record.payload, step = isRecord(p) && p.event === "step_update" && isRecord(p.step_update) ? p.step_update : undefined;
    return step && step.conversation_id === sessionId && isRecord(step.subagent_info) && Number.isSafeInteger(step.step_index) ? [step.step_index as number] : [];
  }));
  for (const { reference, record } of capture.records) {
    let family: UniformEvent["family"], actor: UniformEvent["actor"]["kind"] = "harness", phase: UniformEvent["phase"] = "instant";
    let contentPath = "#/payload", parent: string | undefined;
    const attributes: Record<string, string | number | boolean | null> = { nativeTimeSource: "capture-receipt" };
    const p = record.payload;
    if (record.source === ANTIGRAVITY_CLIENT && record.kind === "request" && record.method === "user") {
      family = "message"; actor = "user"; contentPath += "/message/content"; attributes.role = "user";
    } else if (record.source === ANTIGRAVITY_HARNESS && record.kind === "frame" && isRecord(p)) {
      if (p.event === "result" && !mappedResult && isRecord(p.result) && p.result.conversation_id === sessionId && p.result.num_turns === 1) {
        mappedResult = true;
        family = "outcome"; phase = "after"; contentPath += "/result"; attributes.status = String(p.result.status);
        if (isRecord(p.result.usage)) {
          for (const [native, normalized] of Object.entries({ input_tokens: "inputTokens", output_tokens: "outputTokens", thinking_tokens: "thinkingTokens", cache_read_tokens: "cachedInputTokens", total_tokens: "totalTokens" })) {
            const n = p.result.usage[native];
            if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) attributes[normalized] = n;
          }
          attributes.resourceSemantics = "cumulative-final";
        }
      } else if (p.event === "step_update" && isRecord(p.step_update) && p.step_update.conversation_id === sessionId && Number.isSafeInteger(p.step_update.step_index)) {
        const s = p.step_update, index = s.step_index as number;
        attributes.stepIndex = index; attributes.stepType = String(s.step_type); attributes.state = String(s.state);
        contentPath += "/step_update";
        if (s.step_type === "agent_response" && !messageDone.has(index) && typeof s.text_delta === "string" && s.text_delta.length) {
          family = "message"; actor = "agent"; phase = "during"; attributes.role = "assistant"; contentPath += "/text_delta";
          if (s.state === "DONE") messageDone.add(index);
        } else if (delegationSteps.has(index) && !done.has(index) && (s.state === "DONE" || s.state === "ACTIVE" && !starts.has(index))) {
          family = "delegation"; actor = "agent"; phase = s.state === "DONE" ? "after" : "before";
          attributes.taskId = `${String(sessionId)}:${index}`;
          if (isRecord(s.subagent_info)) contentPath += "/subagent_info";
          if (s.state === "DONE") { done.add(index); parent = starts.get(index); }
          else starts.set(index, `agy:${record.sequence}`);
        } else if (s.step_type === "tool" && !done.has(index) && (s.state === "ACTIVE" && !starts.has(index) || s.state === "DONE")) {
          family = "tool"; phase = s.state === "DONE" ? "after" : "before"; actor = phase === "after" ? "tool" : "agent";
          attributes.toolCallId = `${String(sessionId)}:${index}`;
          const info = isRecord(s.tool_info) ? s.tool_info : {};
          if (typeof s.tool_name === "string") attributes.toolName = s.tool_name;
          else if (typeof info.name === "string") attributes.toolName = info.name;
          if (info.parameters !== undefined) attributes.inputDigest = `sha256:${digestMetadata(info.parameters).value}`;
          if (s.state === "DONE") {
            done.add(index); parent = starts.get(index);
            if (isRecord(info.error)) attributes.status = "failed";
            else if (info.output !== undefined) attributes.status = "completed";
          }
          else starts.set(index, `agy:${record.sequence}`);
        } else continue;
      } else continue;
    } else continue;
    const event: UniformEvent = {
      schemaVersion: "ebo.uniform-event/v1", id: `agy:${record.sequence}`, runId: capture.runId, attemptId: capture.attemptId,
      source: { harness: ANTIGRAVITY_HARNESS, nativeType: antigravityNativeType(record), nativeReference: reference },
      nativeOrder: { status: "known", value: record.sequence, domain: "antigravity-stdio" },
      nativeTime: { status: "known", value: record.observedAt }, actor: { kind: actor }, family, phase,
      scope: { kind: "session", ...(typeof sessionId === "string" ? { id: sessionId } : {}) },
      relations: { parent: parent ? { status: "known", value: parent } : { status: "unknown", reason: "No observed native parent start." }, known: [] },
      attributes, content: { status: "known", value: [{ nativeReference: { ...reference, recordLocator: reference.recordLocator + contentPath }, mediaType: "application/json" }] },
    };
    events.push(event); mapped.add(record.sequence);
  }
  await validateUniformEvents(events, { resolve: ref => capture.records.some(r => r.reference.artifactId === ref.artifactId && ref.recordLocator.split("#")[0] === r.reference.recordLocator) });
  return { events, unmapped: capture.records.filter(r => !mapped.has(r.record.sequence)).map(r => ({ reference: r.reference, reason: "Native record has no supported uniform mapping." })) };
}

export async function describeAndValidateAntigravityDataset(capture: QualifiedNativeCapture<ProtocolObservation>, version: string = ANTIGRAVITY_CLI_VERSION): Promise<{ dataset: NormalizedDataset; coverage: AdapterCoverageReport }> {
  const dataset = describeNormalizedDataset({ capture, normalization: await normalizeAntigravityCapture(capture), capabilityProfile: legacyV1Profile(ANTIGRAVITY_CLI_CAPABILITIES, ANTIGRAVITY_HARNESS, version), adapterVersion: ANTIGRAVITY_ADAPTER_VERSION, nativeType: antigravityNativeType });
  return { dataset, coverage: await validateNormalizedDataset(dataset, createCapturedNativeEvidenceResolver(capture)) };
}
export function createAntigravityHarnessAdapter(): HarnessAdapter<AntigravityCliCaptureRequest, ProtocolObservation> {
  return { capture: { id: ANTIGRAVITY_CLI_CAPABILITIES.adapterId, harness: ANTIGRAVITY_HARNESS, capture: captureAntigravityCli }, normalization: { id: ANTIGRAVITY_CLI_CAPABILITIES.adapterId, harness: ANTIGRAVITY_HARNESS, capabilityProfile: ANTIGRAVITY_CLI_CAPABILITIES, normalize: normalizeAntigravityCapture } };
}
function antigravityNativeType(record: ProtocolObservation): string {
  const p = record.payload;
  if (record.kind === "frame" && isRecord(p) && typeof p.event === "string") return p.event === "step_update" && isRecord(p.step_update) ? `step_update:${String(p.step_update.step_type)}` : p.event;
  return record.method ?? record.kind;
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
