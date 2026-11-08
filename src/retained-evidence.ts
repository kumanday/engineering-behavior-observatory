import { markRetainedVersion, retainedVersionProfile } from "./retained-version-policy.js";
import { probeClaudeAgentSdkCapabilities } from "./agent-sdk.js";
import type { OutcomeEvidenceInput } from "./outcome-evidence.js";
import { isAtifImportSchema, readImportedBehaviorEvidence } from "./atif-import.js";
import { digestMetadata } from "./artifacts.js";
import { factoryModelSelection } from "./factory-model.js";
import { FACTORY_HARNESS, RETAINED_FACTORY_CLI_VERSIONS, RETAINED_FACTORY_ADAPTER_VERSIONS, RETAINED_FACTORY_SDK_VERSIONS, qualifyFactoryCapture, describeAndValidateFactoryDataset } from "./factory-droid.js";
import { join } from "node:path";
import { CLAUDE_AGENT_SDK_HARNESS, readQualifiedRunCapture, createAgentSdkNativeEvidenceResolver } from "./agent-sdk-normalizer.js";
import { createAgentSdkBehaviorEvidence } from "./behavior-assertions.js";
import { describeAndValidateCodexDataset, CODEX_HARNESS, RETAINED_CODEX_APP_SERVER_VERSIONS } from "./codex.js";
import { describeAndValidateDevinDataset, DEVIN_HARNESS, qualifyRetainedDevinCapture, RETAINED_DEVIN_CLI_VERSIONS } from "./devin.js";
import { normalizeOpenHandsCapture, openHandsCapabilityProfile, RETAINED_OPENHANDS_AGENT_SERVER_VERSIONS, type OpenHandsNativeRecord } from "./openhands.js";
import { createDeepSeekHarnessAdapter, DEEPSEEK_HARNESS_ID, RETAINED_DEEPSEEK_SDK_VERSIONS, normalizeDeepSeekCapture, qualifyRetainedDeepSeekCapture, type DeepSeekNativeObservation } from "./deepseek-adapter.js";
import { createCursorSdkBehaviorEvidence, CURSOR_SDK_HARNESS, RETAINED_CURSOR_SDK_VERSIONS } from "./cursor-sdk.js";
import { createCapturedNativeEvidenceResolver, describeNormalizedDataset, validateNormalizedDataset, type AdapterCoverageReport, type NormalizedDataset } from "./normalization-integrity.js";
import { readBoundedFile } from "./scheduler.js";
import { assertProtocolObservation, type ProtocolObservation } from "./process-protocol.js";
import type { NormalizationInput, RetainedNormalizationInput, NativeEvidenceResolver } from "./uniform-events.js";
import type { RunManifest } from "./run-bundles.js";
import {
  assertPiNativeRecord,
  normalizePiCapture,
  piCapabilityProfile,
  piNativeType,
  qualifyRetainedPiCapture,
  PI_NORMALIZATION_ADAPTER_VERSION,
  RETAINED_PI_ADAPTER_VERSIONS,
  PI_HARNESS,
  RETAINED_PI_SDK_VERSIONS,
  type PiNativeRecord,
} from "./pi.js";

export type RetainedBehaviorEvidence = {
  capture: RetainedNormalizationInput<unknown>;
  /** Known source model and route aliases, used together for evaluator blinding. */
  modelAliases?: readonly string[];
  overlayAdjustments?: readonly import("./atif-overlays.js").AtifInterpretationAdjustment[];
  interpretationRevision?: { changed: boolean; admitted: unknown; current: unknown };
  /** Verified bundle metadata for outcome import; never replaces native session records. */
  outcomeCapture: OutcomeEvidenceInput;
  dataset: NormalizedDataset;
  resolver: NativeEvidenceResolver;
  coverage: AdapterCoverageReport;
};

export async function createRetainedBehaviorEvidence(bundleRoot: string): Promise<RetainedBehaviorEvidence> {
  const evidence = await readRetainedBehaviorEvidence(bundleRoot);
  if (evidence.capture.qualification === "imported") return evidence;
  const manifest = JSON.parse(readBoundedFile(join(bundleRoot, "manifest.json"), "Run manifest").toString("utf8")) as RunManifest;
  const harness = manifest.run.harness.id;
  const verified: Record<string, readonly string[]> = {
    [CLAUDE_AGENT_SDK_HARNESS]: [probeClaudeAgentSdkCapabilities().sdkVersion],
    "agent-sdk": [probeClaudeAgentSdkCapabilities().sdkVersion],
    [CODEX_HARNESS]: RETAINED_CODEX_APP_SERVER_VERSIONS,
    [DEVIN_HARNESS]: RETAINED_DEVIN_CLI_VERSIONS,
    [PI_HARNESS]: RETAINED_PI_SDK_VERSIONS,
    [FACTORY_HARNESS]: RETAINED_FACTORY_CLI_VERSIONS,
    [CURSOR_SDK_HARNESS]: RETAINED_CURSOR_SDK_VERSIONS,
    "openhands-agent-server": RETAINED_OPENHANDS_AGENT_SERVER_VERSIONS,
    [DEEPSEEK_HARNESS_ID]: RETAINED_DEEPSEEK_SDK_VERSIONS,
  };
  let profile = retainedVersionProfile(evidence.dataset.capabilityProfile, verified[harness] ?? [], manifest.run.harness.version);
  const components = harness === PI_HARNESS ? [["pi-sdk-adapter", RETAINED_PI_ADAPTER_VERSIONS]] as const
    : harness === FACTORY_HARNESS ? [["factory-adapter", RETAINED_FACTORY_ADAPTER_VERSIONS], ["@factory/droid-sdk", RETAINED_FACTORY_SDK_VERSIONS]] as const : [];
  for (const [name, versions] of components) for (const runtime of manifest.run.runtime.filter((runtime) => runtime.name === name)) {
    profile = retainedVersionProfile(profile, versions, runtime.version);
  }
  const componentVersions = manifest.run.runtime.filter(({ name, source }) => name === harness || source === harness
    || [CLAUDE_AGENT_SDK_HARNESS, "agent-sdk"].includes(harness) && [CLAUDE_AGENT_SDK_HARNESS, "agent-sdk"].includes(name)).map(({ version }) => version);
  const confidence = markRetainedVersion(evidence.capture, manifest.run.harness.version, verified[harness] ?? [], componentVersions);
  if (confidence.sourceLimitations?.length) profile = { ...profile, limitations: [...new Set([...(profile.limitations ?? []), ...confidence.sourceLimitations])] };
  if (retainedRuntimeProbeConflict(bundleRoot, manifest)) profile = {...profile, limitations: [...new Set([...(profile.limitations ?? []), "HARNESS_VERSION_UNVERIFIED", "HARNESS_VERSION_CONFLICT"])]};
  if (profile === evidence.dataset.capabilityProfile) return evidence;
  const dataset = { ...evidence.dataset, capabilityProfile: profile };
  return { ...evidence, dataset, coverage: await validateNormalizedDataset(dataset, evidence.resolver) };
}

async function readRetainedBehaviorEvidence(bundleRoot: string): Promise<RetainedBehaviorEvidence> {
  const manifest = JSON.parse(readBoundedFile(join(bundleRoot, "manifest.json"), "Run manifest").toString("utf8")) as RunManifest;
  if (isAtifImportSchema((manifest as unknown as { schemaVersion: string }).schemaVersion)) return readImportedBehaviorEvidence(bundleRoot);
  const harness = manifest.run.harness.id;
  if (harness === CURSOR_SDK_HARNESS) return createCursorSdkBehaviorEvidence(bundleRoot);
  const isAgentSdk = [CLAUDE_AGENT_SDK_HARNESS, "agent-sdk"].includes(harness)
    || manifest.run.runtime.some(({ source, name }) => source === "anthropic" && [CLAUDE_AGENT_SDK_HARNESS, "agent-sdk"].includes(name));
  if (isAgentSdk) {
    const evidence = await createAgentSdkBehaviorEvidence(bundleRoot);
    return { ...evidence, outcomeCapture: evidence.capture };
  }
  if (![CODEX_HARNESS, DEVIN_HARNESS, FACTORY_HARNESS, "openhands-agent-server", DEEPSEEK_HARNESS_ID, PI_HARNESS].includes(harness)) {
    throw new Error(`Unsupported retained harness ${harness}; refusing Agent SDK fallback normalization.`);
  }
  if (harness === "openhands-agent-server") openHandsCapabilityProfile(manifest.run.harness.version);
  if (harness === PI_HARNESS) {
    const expected = new Map([
      ["pi-coding-agent", { source: "earendil-works", version: manifest.run.harness.version }],
      [PI_HARNESS, { source: "EBO", version: manifest.run.harness.version }],
    ]);
    for (const [name, identity] of expected) {
      const matches = manifest.run.runtime.filter((runtime) => runtime.name === name);
      if (matches.length !== 1 || matches[0]!.source !== identity.source) {
        throw new Error(`Retained Pi runtime identity ${name} differs from the pinned adapter manifest.`);
      }
    }
    const adapters = manifest.run.runtime.filter(({ name }) => name === "pi-sdk-adapter");
    if (adapters.length !== 1 || adapters[0]!.source !== "EBO") {
      throw new Error("Retained Pi runtime identity pi-sdk-adapter differs from the supported capture adapter manifest.");
    }
  }
  const outcomeCapture = await readQualifiedRunCapture(bundleRoot);
  // A verifier task failure also presupposes a normally completed native run.
  const expectsCompletion = manifest.terminal.state === "completed" || manifest.terminal.failureClass === "task";
  let capture: NormalizationInput<unknown> = {
    ...outcomeCapture,
    records: outcomeCapture.records.filter(({ record }) => record.kind === "session")
      .map(({ reference, record }) => {
        const line = Number(reference.recordLocator.match(/^line:(\d+)$/u)?.[1]);
        if (harness === PI_HARNESS) assertPiNativeRecord(record.document, line);
        else assertNativeEnvelope(harness, record.document, line);
        return { reference, record: record.document };
      }),
  };
  const resolver = createCapturedNativeEvidenceResolver(capture, createAgentSdkNativeEvidenceResolver({ ...outcomeCapture,
    records: outcomeCapture.records.filter(({ record }) => record.kind !== "session" && record.kind !== "hook"),
  }));
  let dataset: NormalizedDataset;
  if (harness === PI_HARNESS) {
    // The manifest's runtime identity must agree with the one composition record the capture wrote natively.
    const compositions = capture.records.filter(({ record }) => {
      const value = record as Record<string, unknown>;
      return value.channel === "adapter" && value.nativeType === "session_created";
    }).map(({ record }) => record as { payload?: { sdk?: { version?: unknown } } });
    if (compositions.length !== 1) throw new Error(`Retained Pi capture has ${String(compositions.length)} native composition records; expected exactly one.`);
    capture = markRetainedVersion(capture, manifest.run.harness.version, RETAINED_PI_SDK_VERSIONS, [compositions[0]!.payload?.sdk?.version]);
    const native = qualifyRetainedPiCapture(capture as NormalizationInput<PiNativeRecord>, manifest.run.native?.sessionId, expectsCompletion);
    capture.qualification = native.qualification;
    outcomeCapture.qualification = native.qualification;
    dataset = describeNormalizedDataset({
      capture: native,
      normalization: await normalizePiCapture(native),
      capabilityProfile: piCapabilityProfile,
      adapterVersion: PI_NORMALIZATION_ADAPTER_VERSION,
      nativeType: piNativeType,
    });
  } else if (harness === CODEX_HARNESS) {
    let native = capture as NormalizationInput<ProtocolObservation> & { threadId?: string; turnId?: string };
    const handshakeVersions = native.records.filter(({ record }) => record.kind === "response" && record.source === CODEX_HARNESS && record.method === "initialize")
      .map(({ record }) => String((record.payload as Record<string, unknown> | undefined)?.userAgent ?? "").match(/^[^\s/]+\/([^\s]+)/u)?.[1]);
    const telemetryVersions = outcomeCapture.records.flatMap(({ record }) => {
      const document = record.document as Record<string, any> | undefined;
      return document?.schemaVersion === "ebo.codex-telemetry/v1" ? [document.runtime?.version] : [];
    });
    native = markRetainedVersion(native, manifest.run.harness.version, RETAINED_CODEX_APP_SERVER_VERSIONS, [...handshakeVersions, ...telemetryVersions,
      ...manifest.run.runtime.filter(({ name }) => name === CODEX_HARNESS).map(({ version }) => version)]);
    capture = native;
    let acceptedStartSequence = 0;
    const identities = (method: string, key: "thread" | "turn"): string | undefined => {
      const accepted = native.records.filter(({ record }) => {
        const payload = record.payload as Record<string, any> | undefined;
        return record.kind === "response" && record.source === CODEX_HARNESS && record.method === method
          && typeof payload?.[key]?.id === "string" && payload[key].id.trim() !== "";
      });
      const optionalPartialTurn = key === "turn" && !expectsCompletion;
      if (accepted.length === 0 && optionalPartialTurn) return undefined;
      if (accepted.length !== 1) throw new Error(`Retained Codex ${method} requires one owned identity.`);
      const response = accepted[0]!.record;
      const requests = native.records.filter(({ record }) => record.kind === "request" && record.source === "ebo-codex-client" && record.id === response.id);
      const responses = native.records.filter(({ record }) => record.kind === "response" && record.source === CODEX_HARNESS && record.id === response.id);
      const request = requests[0]?.record;
      const payload = response.payload as Record<string, any>;
      if (response.id === undefined || response.id === null || requests.length !== 1 || responses.length !== 1
        || request?.method !== method || request.sequence <= acceptedStartSequence || request.sequence >= response.sequence
        || key === "turn" && ((request.payload as Record<string, unknown> | undefined)?.threadId !== native.threadId
          || payload.turn.threadId !== undefined && payload.turn.threadId !== native.threadId)) {
        throw new Error(`Retained Codex ${method} requires a unique ordered owned request/response pair.`);
      }
      acceptedStartSequence = response.sequence;
      return payload[key].id as string;
    };
    native.threadId = identities("thread/start", "thread");
    native.turnId = identities("turn/start", "turn");
    if (native.threadId !== manifest.run.native?.sessionId) throw new Error("Retained Codex thread identity differs from the run manifest.");
    const terminals = native.records.filter(({ record }) => {
      const payload = record.payload as Record<string, any> | undefined;
      return record.kind === "notification" && record.source === CODEX_HARNESS && record.method === "turn/completed"
        && payload?.threadId === native.threadId && payload?.turn?.id === native.turnId;
    });
    if (terminals.length > 1 || terminals.some(({ record }) => record.sequence <= acceptedStartSequence)
      || expectsCompletion && (terminals[0]?.record.payload as Record<string, any> | undefined)?.turn?.status !== "completed") {
      throw new Error("Retained Codex capture requires unambiguous matching owned terminal evidence.");
    }
    dataset = (await describeAndValidateCodexDataset(native, manifest.run.harness.version)).dataset;
  } else if (harness === FACTORY_HARNESS) {
    const expected = new Map([[FACTORY_HARNESS, { source: "Factory", version: manifest.run.harness.version }]]);
    for (const [name, identity] of expected) {
      const matches = manifest.run.runtime.filter((runtime) => runtime.name === name);
      if (matches.length !== 1 || matches[0]!.source !== identity.source) {
        throw new Error(`Retained Factory runtime identity ${name} differs from the manifest.`);
      }
    }
    const adapters = manifest.run.runtime.filter(({ name }) => name === "factory-adapter");
    const sdks = manifest.run.runtime.filter(({ name }) => name === "@factory/droid-sdk");
    if (adapters.length !== 1 || adapters[0]!.source !== "EBO"
      || sdks.length !== 1 || sdks[0]!.source !== "Factory") {
      throw new Error("Retained Factory runtime composition requires one EBO adapter and one Factory SDK identity.");
    }
    const captureAdapterVersion = adapters[0]!.version;
    const captureSdkVersion = sdks[0]!.version;
    const runtimeDocuments = outcomeCapture.records.filter(({ record }) => record.kind === "telemetry")
      .map(({ record }) => record.document as Record<string, any> | undefined);
    const runtime = runtimeDocuments[0]?.runtime;
    if (runtimeDocuments.length !== 1 || runtimeDocuments[0]?.schemaVersion !== "ebo.factory-runtime/v1" || !runtime || typeof runtime !== "object") throw new Error("Retained Factory runtime document has an invalid capture format.");
    capture = markRetainedVersion(capture, manifest.run.harness.version, RETAINED_FACTORY_CLI_VERSIONS, [runtime.version]);
    capture = markRetainedVersion(capture, captureSdkVersion, RETAINED_FACTORY_SDK_VERSIONS, [runtime.sdkVersion]);
    capture = markRetainedVersion(capture, captureAdapterVersion, RETAINED_FACTORY_ADAPTER_VERSIONS, [runtime.adapterVersion]);
    if (runtimeDocuments[0]?.effectiveConfiguration?.model !== manifest.run.model.id) throw new Error("Retained Factory model differs from the run manifest.");
    const native = qualifyFactoryCapture(capture as NormalizationInput<ProtocolObservation>, {
      sessionId: manifest.run.native?.sessionId, expectsCompletion, cliVersion: manifest.run.harness.version, sdkVersion: captureSdkVersion,
      adapterVersion: captureAdapterVersion,
    });
    const initialization = native.records.find(({ record }) => record.source === "ebo-factory-client" && record.method === "droid.initialize_session")?.record;
    const effective = runtimeDocuments[0]!.effectiveConfiguration;
    const selection = effective.modelSelection === undefined ? factoryModelSelection(manifest.run.model.id)
      : factoryModelSelection(effective.modelSelection.model, effective.modelSelection.route);
    if (selection.model !== manifest.run.model.id || effective.modelSelection !== undefined
      && digestMetadata(selection).value !== digestMetadata(effective.modelSelection).value) throw new Error("Retained Factory model route is invalid.");
    if (effective.settings?.modelId !== undefined && effective.settings.modelId !== selection.nativeModelId) throw new Error("Retained Factory effective selector differs from its route.");
    if (initialization !== undefined && (initialization.payload as Record<string, any>)?.params?.modelId !== selection.nativeModelId) throw new Error("Retained Factory initialization model differs from the manifest.");
    const composition = native.records.find(({ record }) => record.capability === "runtime-composition")?.record.evidence as Record<string, unknown> | undefined;
    if (selection.route.kind === "byok" && (effective.customModelSource !== "attempt-settings-override"
      || composition?.customModelSource !== "attempt-settings-override")) throw new Error("Retained Factory BYOK route lacks an attempt-owned settings override.");
    if (effective.modelSelection !== undefined && digestMetadata(composition?.modelSelection ?? null).value !== digestMetadata(selection).value) throw new Error("Retained Factory route differs from recorded composition.");
    if (composition?.binaryDigest !== runtime.binaryDigest) {
      throw new Error("Retained Factory runtime digest differs from native composition.");
    }
    dataset = (await describeAndValidateFactoryDataset(native)).dataset;
  } else if (harness === DEVIN_HARNESS) {
    // The native runtime document is the only runtime-version evidence; never fall back to the manifest pin alone.
    const telemetryDocuments = outcomeCapture.records.filter(({ record }) => record.kind === "telemetry").map(({ record }) => record.document as Record<string, any> | undefined);
    if (telemetryDocuments.length !== 1 || telemetryDocuments[0]?.schemaVersion !== "ebo.devin-telemetry/v1") {
      throw new Error("Retained Devin capture requires exactly one recognized ebo.devin-telemetry/v1 runtime document.");
    }
    const telemetryVersion = telemetryDocuments[0].runtime?.version;
    const runtimeVersions = manifest.run.runtime.filter(({ name }) => name === DEVIN_HARNESS).map(({ version }) => version);
    const native = qualifyRetainedDevinCapture(capture as NormalizationInput<ProtocolObservation>, {
      sessionId: manifest.run.native?.sessionId,
      expectsCompletion,
      harnessVersion: manifest.run.harness.version,
      runtimeVersions: [telemetryVersion, ...runtimeVersions],
    });
    dataset = (await describeAndValidateDevinDataset(native, manifest.run.harness.version)).dataset;
  } else if (harness === "openhands-agent-server") {
    const native = capture as NormalizationInput<OpenHandsNativeRecord>;
    const sessionId = manifest.run.native?.sessionId;
    const serverInfo = native.records.filter(({ record }) => record.channel === "server-info");
    if (serverInfo.length !== 1) throw new Error("Retained OpenHands capture requires exactly one native server-info record.");
    for (const { record } of native.records) {
      if (record.channel === "server-info") capture = markRetainedVersion(capture, manifest.run.harness.version, RETAINED_OPENHANDS_AGENT_SERVER_VERSIONS, [record.payload.version]);
      if (record.session_id !== undefined && record.session_id !== sessionId
        || ["conversation-created", "websocket-status", "websocket-event", "rest-event", "conversation-final"].includes(record.channel)
          && (sessionId === undefined || record.session_id !== sessionId)
        || ["conversation-created", "conversation-final"].includes(record.channel) && record.payload.id !== sessionId) {
        throw new Error("Retained OpenHands conversation identity differs from the run manifest.");
      }
    }
    const finals = native.records.filter(({ record }) => record.channel === "conversation-final");
    if (expectsCompletion && (finals.length !== 1 || finals[0]!.record.payload.execution_status !== "finished")) {
      throw new Error("Completed retained OpenHands capture lacks owned finished conversation evidence.");
    }
    dataset = describeNormalizedDataset({ capture: { ...native, sourceLimitations: capture.sourceLimitations }, normalization: await normalizeOpenHandsCapture({ ...native, sourceLimitations: capture.sourceLimitations }),
      capabilityProfile: openHandsCapabilityProfile(manifest.run.harness.version), adapterVersion: manifest.run.harness.version,
      nativeType: (record) => typeof record.payload.kind === "string" ? record.payload.kind : record.channel });
  } else {
    const native = qualifyRetainedDeepSeekCapture(capture as NormalizationInput<DeepSeekNativeObservation>,
      manifest.run.native?.sessionId, expectsCompletion, manifest.run.harness.version);
    capture.qualification = native.qualification;
    outcomeCapture.qualification = native.qualification;
    dataset = describeNormalizedDataset({ capture: native, normalization: normalizeDeepSeekCapture(native),
      capabilityProfile: createDeepSeekHarnessAdapter().normalization.capabilityProfile, adapterVersion: manifest.run.harness.version,
      nativeType: (record) => record.method ?? record.kind });
  }
  const coverage = await validateNormalizedDataset(dataset, resolver);
  return { capture, outcomeCapture, dataset, resolver, coverage };
}

function assertNativeEnvelope(harness: string, value: unknown, line: number): void {
  const fail = (): never => { throw new Error(`Invalid retained ${harness} native envelope at line ${line}.`); };
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(line) || line < 1 || record.sequence !== line) fail();
  if (harness === FACTORY_HARNESS) {
    assertProtocolObservation(value, line);
    if (value.source !== FACTORY_HARNESS && value.source !== "ebo-factory-client") fail();
    return;
  }
  if (harness === DEVIN_HARNESS) {
    assertProtocolObservation(value, line);
    if (value.source !== DEVIN_HARNESS && value.source !== "ebo-devin-client") fail();
    if (value.source === "ebo-devin-client" && (!["request", "response", "notification"].includes(value.kind)
      || value.kind === "notification" && value.method !== "session/cancel")) fail();
    return;
  }
  if (harness === CODEX_HARNESS) {
    assertProtocolObservation(value, line);
    if (value.source !== CODEX_HARNESS && value.source !== "ebo-codex-client") fail();
    if (value.source === "ebo-codex-client" && (!["request", "response", "notification"].includes(value.kind)
      || value.kind === "notification" && value.method !== "initialized")) fail();
    return;
  }
  const optionalText = (fields: string[]) => fields.every((field) => record[field] === undefined
    || typeof record[field] === "string" && (record[field] as string).trim() !== "");
  if (harness === "openhands-agent-server") {
    if (record.schemaVersion !== "ebo.openhands-native-record/v1"
      || !["server-info", "conversation-create-response", "conversation-created", "websocket-status", "websocket-event", "conversation-final", "rest-event", "capture-error", "cleanup"].includes(String(record.channel))
      || record.payload === null || typeof record.payload !== "object" || Array.isArray(record.payload)
      || !optionalText(["session_id"]) || record.channelSequence !== undefined
        && (typeof record.channelSequence !== "number" || !Number.isSafeInteger(record.channelSequence) || record.channelSequence < 0)) fail();
    return;
  }
  if (record.schemaVersion !== "ebo.deepseek-native-observation/v1"
    || !["composition", "capability", "request", "response", "notification", "diagnostic", "error"].includes(String(record.kind))
    || typeof record.observedAt !== "string" || record.observedAt.trim() === ""
    || !optionalText(["method", "sessionId", "sourceIdentity"]) || record.stream !== undefined && record.stream !== "stderr"
    || ["request", "response", "notification"].includes(String(record.kind)) && typeof record.method !== "string") fail();
}

/** Retained observations qualify confidence; version disagreement never rejects reading. */
function retainedRuntimeProbeConflict(bundleRoot: string, manifest: RunManifest): boolean {
  if (!manifest.runtimeLock) return false;
  const descriptor = manifest.evidence.find((descriptor) => descriptor.id === manifest.runtimeLock!.launchArtifactId);
  if (!descriptor) return false; // Structural validation reports a missing diagnostic.
  const launch = JSON.parse(readBoundedFile(join(bundleRoot, descriptor.relativePath), "Retained runtime launch").toString("utf8")) as {
    role: string; roots?: {id: string}[]; probes?: {componentId: string; package: string; expectedVersion: string; actualVersion: string}[]};
  const primary = launch.roots?.[0]?.id;
  return (launch.probes ?? []).some((probe) => {
    const declarations = manifest.run.runtime.filter((component) => component.name === probe.package || component.name === probe.componentId
      || probe.componentId === primary && component.name === launch.role).map((component) => component.version);
    if (probe.componentId === primary) declarations.push(manifest.run.harness.version);
    return probe.expectedVersion !== probe.actualVersion || declarations.some((version) => version !== probe.actualVersion);
  });
}
