import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertNoDuplicateJsonKeys, digestBytes, digestMetadata } from "./artifacts.js";
import { readBoundedFile } from "./scheduler.js";
import { validateAtifStructure } from "./atif-validation.js";

export const ATIF_READER_VERSION = "2.0.0";
export const ATIF_LIMITS = Object.freeze({ documentBytes: 64 * 1024 * 1024, stepBytes: 4 * 1024 * 1024,
  attachmentBytes: 16 * 1024 * 1024, attachmentTotalBytes: 64 * 1024 * 1024, depth: 64,
  nodes: 1_000_000, pointerRecords: 100_000, tokenArrayItems: 100_000 });
export const ATIF_VERSION_FEATURES = Object.freeze({
  "ATIF-v1.2": { completionTokenIds: false, promptTokenIds: false, toolDefinitions: false, toolCallExtra: false, multimodal: false, copiedContext: false, declaredInference: false, embeddedTrajectories: false, audio: false },
  "ATIF-v1.3": { completionTokenIds: true, promptTokenIds: false, toolDefinitions: false, toolCallExtra: false, multimodal: false, copiedContext: false, declaredInference: false, embeddedTrajectories: false, audio: false },
  "ATIF-v1.4": { completionTokenIds: true, promptTokenIds: true, toolDefinitions: false, toolCallExtra: false, multimodal: false, copiedContext: false, declaredInference: false, embeddedTrajectories: false, audio: false },
  "ATIF-v1.5": { completionTokenIds: true, promptTokenIds: true, toolDefinitions: true, toolCallExtra: false, multimodal: false, copiedContext: true, declaredInference: false, embeddedTrajectories: false, audio: false },
  "ATIF-v1.6": { completionTokenIds: true, promptTokenIds: true, toolDefinitions: true, toolCallExtra: false, multimodal: true, copiedContext: true, declaredInference: false, embeddedTrajectories: false, audio: false },
  "ATIF-v1.7": { completionTokenIds: true, promptTokenIds: true, toolDefinitions: true, toolCallExtra: true, multimodal: true, copiedContext: true, declaredInference: true, embeddedTrajectories: true, audio: false },
  "ATIF-v1.8": { completionTokenIds: true, promptTokenIds: true, toolDefinitions: true, toolCallExtra: true, multimodal: true, copiedContext: true, declaredInference: true, embeddedTrajectories: true, audio: true },
});
export type AtifVersion = keyof typeof ATIF_VERSION_FEATURES;
export function atifFeaturesForVersion(version: unknown): typeof ATIF_VERSION_FEATURES[AtifVersion] | undefined {
  if (typeof version !== "string") return undefined;
  if (Object.hasOwn(ATIF_VERSION_FEATURES, version)) return ATIF_VERSION_FEATURES[version as AtifVersion];
  const minor = /^ATIF-v1\.(\d+)$/u.exec(version);
  return minor ? ATIF_VERSION_FEATURES[Number(minor[1]) > 8 ? "ATIF-v1.8" : "ATIF-v1.2"] : undefined;
}
export type AtifObject = Record<string, unknown>;
export type AtifDigest = `sha256:${string}`;
export type AtifDiagnostic = { code: string; pointer: string };
export type AtifPointerRecord = { pointer: string; digest: AtifDigest; sourceDigest: AtifDigest;
  kind: "trajectory" | "step" | "call" | "result" | "field"; copied: boolean; gap: boolean };
export type AtifReference = { pointer: string; target: string; kind: "media" | "continuation" | "subagent-file" | "embedded" | "session-only"; status: "retained" | "unavailable";
  reason?: string; digest?: AtifDigest; bytes?: number };
export type AtifStructuralResult = { status: "valid" | "invalid" | "unavailable"; validator: "ebo" | "harbor";
  version: string; modelDigest?: AtifDigest; validationPolicyDigest?: AtifDigest; nativeModelStatus?: "valid" | "invalid";
  compatibilityDiagnostics?: AtifDiagnostic[]; compatibilityDiagnosticCount?: number; compatibilityDiagnosticsTruncated?: boolean;
  diagnostics: AtifDiagnostic[] };
export type AtifInspection = {
  schemaVersion: "ebo.atif-inspection/v1"; readerVersion: string;
  source: { bytes?: number; digest?: AtifDigest }; sourceVersion?: string;
  versionPolicy: { status: "supported" | "unsupported" | "inconsistent" | "unavailable"; diagnostics: AtifDiagnostic[] };
  structural: AtifStructuralResult; harborCrossCheck?: AtifStructuralResult; records: AtifPointerRecord[]; references: AtifReference[];
  fieldCoverage: Record<string, number>; limitations: string[];
  unmappedFields?: Array<{ pointer: string; reason: "ATIF_FIELD_UNRECOGNIZED" | "ATIF_EXTENSION_OPAQUE" | "ATIF_VERSION_FIELD_UNVERIFIED" }>;
};
export type AtifReadResult = { inspection: AtifInspection; document?: AtifObject };
export type AtifReadOptions = { pythonExecutable?: string; retainedFiles?: readonly string[]; propagateReadErrors?: boolean };

/** Inspect source bytes. This does not qualify a capture or produce behavioral measurements. */
export function inspectAtifBytes(bytes: Uint8Array): AtifReadResult {
  const inspection: AtifInspection = { schemaVersion: "ebo.atif-inspection/v1", readerVersion: ATIF_READER_VERSION,
    source: { bytes: bytes.byteLength, digest: hashBytes(bytes) },
    versionPolicy: { status: "unavailable", diagnostics: [] },
    structural: unavailableValidator("STRUCTURAL_VALIDATION_NOT_RUN"), records: [], references: [], fieldCoverage: {},
    limitations: ["THIRD_PARTY_SOURCE", "CAPTURE_COMPLETENESS_UNPROVEN"] };
  if (bytes.byteLength > ATIF_LIMITS.documentBytes) return rejected(inspection, "DOCUMENT_BYTE_LIMIT");
  let document: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    document = JSON.parse(text) as unknown;
    checkBounds(document);
    assertNoDuplicateJsonKeys(text);
  } catch (error) {
    return rejected(inspection, error instanceof AtifLimitError ? error.code
      : error instanceof Error && /duplicate JSON object keys/u.test(error.message) ? "DUPLICATE_JSON_KEY" : "INVALID_JSON");
  }
  if (!isAtifObject(document)) return rejected(inspection, "DOCUMENT_NOT_OBJECT");
  if (typeof document.schema_version === "string") inspection.sourceVersion = document.schema_version;
  const policyDiagnostics: AtifDiagnostic[] = [];
  let unsupported = false;
  const count = (key: string) => { inspection.fieldCoverage[key] = (inspection.fieldCoverage[key] ?? 0) + 1; };
  const sourceDigest = inspection.source.digest!;
  const pointerDigests = new Map<string, AtifDigest>();
  const record = (value: unknown, pointer: string, kind: AtifPointerRecord["kind"], copied: boolean, gap: boolean) => {
    if (inspection.records.length >= ATIF_LIMITS.pointerRecords) throw new AtifLimitError("POINTER_RECORD_LIMIT");
    if (pointerDigests.has(pointer)) return;
    const digest = hashValue(value);
    pointerDigests.set(pointer, digest);
    inspection.records.push({ pointer, digest, sourceDigest, kind, copied, gap });
  };
  const violation = (code: string, pointer: string) => policyDiagnostics.push({ code, pointer });
  const fields = (value: AtifObject, pointer: string, recognized: readonly string[]) => {
    for (const key of Object.keys(value)) if (key === "extra" || !recognized.includes(key)) {
      const location = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      (inspection.unmappedFields ??= []).push({ pointer: location, reason: key === "extra" ? "ATIF_EXTENSION_OPAQUE" : "ATIF_FIELD_UNRECOGNIZED" });
      record(value[key], location, "field", false, false);
    }
  };
  const visit = (trajectory: AtifObject, pointer: string, inheritedCopied: boolean, inheritedGap: boolean) => {
    const version = typeof trajectory.schema_version === "string" ? trajectory.schema_version : "";
    const minor = /^ATIF-v1\.(\d+)$/u.exec(version);
    const verified = Object.hasOwn(ATIF_VERSION_FEATURES, version);
    const features = atifFeaturesForVersion(version);
    if (!verified && minor) inspection.limitations.push("ATIF_MINOR_VERSION_UNVERIFIED");
    if (features === undefined) {
      if (pointer === "#") unsupported = true;
      else inspection.limitations.push("ATIF_CHILD_FORMAT_UNSUPPORTED");
      violation("ATIF_MAJOR_VERSION_UNSUPPORTED", `${pointer}/schema_version`);
      // A child with an unsupported major remains retained without interpreting it as v1.
      record(trajectory, pointer, "trajectory", inheritedCopied, inheritedGap);
      return;
    }
    if (features !== undefined && !features.embeddedTrajectories) {
      for (const key of ["trajectory_id", "subagent_trajectories"]) if (key in trajectory) violation(`VERSION_FIELD:${key}`, `${pointer}/${key}`);
      if (typeof trajectory.session_id !== "string") violation("VERSION_REQUIRES_SESSION_ID", `${pointer}/session_id`);
    }
    if (features !== undefined && !features.toolDefinitions && "tool_definitions" in object(trajectory.agent)) violation("VERSION_FIELD:agent.tool_definitions", `${pointer}/agent/tool_definitions`);
    record(trajectory, pointer, "trajectory", inheritedCopied, inheritedGap);
    fields(trajectory, pointer, ["schema_version", "agent", "session_id", "trajectory_id", "steps", "notes", "final_metrics", "continued_trajectory_ref", "subagent_trajectories", "extra"]);
    record(trajectory.agent, `${pointer}/agent`, "field", inheritedCopied, inheritedGap);
    if (trajectory.final_metrics !== undefined && trajectory.final_metrics !== null) {
      record(trajectory.final_metrics, `${pointer}/final_metrics`, "field", inheritedCopied, inheritedGap);
      for (const key of ["total_prompt_tokens", "total_completion_tokens", "total_cached_tokens", "total_cost_usd", "total_steps"]) {
        if (Object.hasOwn(object(trajectory.final_metrics), key)) record(object(trajectory.final_metrics)[key], `${pointer}/final_metrics/${key}`, "field", inheritedCopied, inheritedGap);
      }
    }
    fields(object(trajectory.agent), `${pointer}/agent`, ["name", "version", "model_name", "tool_definitions", "extra"]);
    fields(object(trajectory.final_metrics), `${pointer}/final_metrics`, ["total_prompt_tokens", "total_completion_tokens", "total_cached_tokens", "total_cost_usd", "total_steps", "extra"]);
    for (const [index, value] of array(trajectory.steps).entries()) {
      if (!isAtifObject(value)) continue;
      const stepPointer = `${pointer}/steps/${index}`;
      if (Buffer.byteLength(JSON.stringify(value)) > ATIF_LIMITS.stepBytes) throw new AtifLimitError("STEP_BYTE_LIMIT");
      const copied = inheritedCopied || value.is_copied_context === true;
      const gap = inheritedGap;
      if (features !== undefined) {
        if (!features.copiedContext && "is_copied_context" in value) violation("VERSION_FIELD:is_copied_context", `${stepPointer}/is_copied_context`);
        if (!features.declaredInference && "llm_call_count" in value) violation("VERSION_FIELD:llm_call_count", `${stepPointer}/llm_call_count`);
        if (!features.multimodal && Array.isArray(value.message)) violation("VERSION_FIELD:multimodal", `${stepPointer}/message`);
        if (!features.completionTokenIds && "completion_token_ids" in object(value.metrics)) violation("VERSION_FIELD:completion_token_ids", `${stepPointer}/metrics/completion_token_ids`);
        if (!features.promptTokenIds && "prompt_token_ids" in object(value.metrics)) violation("VERSION_FIELD:prompt_token_ids", `${stepPointer}/metrics/prompt_token_ids`);
      }
      record(value, stepPointer, "step", copied, gap);
      fields(value, stepPointer, ["step_id", "source", "message", "reasoning_content", "reasoning_effort", "timestamp", "model_name", "tool_calls", "observation", "metrics", "llm_call_count", "is_copied_context", "extra"]);
      if (value.metrics !== undefined && value.metrics !== null) record(value.metrics, `${stepPointer}/metrics`, "field", copied, gap);
      fields(object(value.observation), `${stepPointer}/observation`, ["results"]);
      fields(object(value.metrics), `${stepPointer}/metrics`, ["prompt_tokens", "completion_tokens", "cached_tokens", "cost_usd", "prompt_token_ids", "completion_token_ids", "logprobs", "extra"]);
      count("steps");
      if (copied) count("copiedSteps");
      if (gap) count("gapSteps");
      if ("llm_call_count" in value) count("declaredInferenceFields");
      for (const [callIndex, call] of array(value.tool_calls).entries()) {
        if (features !== undefined && !features.toolCallExtra && "extra" in object(call)) violation("VERSION_FIELD:tool_call.extra", `${stepPointer}/tool_calls/${callIndex}/extra`);
        record(call, `${stepPointer}/tool_calls/${callIndex}`, "call", copied, gap);
        fields(object(call), `${stepPointer}/tool_calls/${callIndex}`, ["tool_call_id", "function_name", "arguments", "extra"]);
        count("toolCallFields");
      }
      for (const [resultIndex, result] of array(object(value.observation).results).entries()) {
        const resultPointer = `${stepPointer}/observation/results/${resultIndex}`;
        record(result, resultPointer, "result", copied, gap);
        fields(object(result), resultPointer, ["source_call_id", "content", "subagent_trajectory_ref", "extra"]);
        if (!features?.multimodal && Array.isArray(object(result).content)) violation("VERSION_FIELD:multimodal", `${resultPointer}/content`);
        if (features !== undefined && !features.embeddedTrajectories && "extra" in object(result)) violation("VERSION_FIELD:result.extra", `${resultPointer}/extra`);
        if (typeof object(object(result).extra).is_error === "boolean") count("explicitIsErrorFields");
      }
    }
    for (const [index, child] of array(trajectory.subagent_trajectories).entries()) {
      if (isAtifObject(child)) visit(child, `${pointer}/subagent_trajectories/${index}`, inheritedCopied, inheritedGap);
    }
    findReferences(trajectory, pointer, inspection.references, features, pointerDigests, violation);
  };
  try { visit(document, "#", false, false); }
  catch (error) { return rejected(inspection, error instanceof AtifLimitError ? error.code : "POINTER_INVENTORY_FAILED"); }
  // Reference walking is recursive over a trajectory, so visit children only once for the reference inventory.
  inspection.references = [...new Map(inspection.references.map((reference) => [reference.pointer, reference])).values()];
  if (inspection.references.some(({ status }) => status === "unavailable")) inspection.limitations.push("EXTERNAL_REFERENCE_UNAVAILABLE");
  inspection.limitations = [...new Set(inspection.limitations)];
  try {
    for (const reference of inspection.references) {
      const value = atifPointerValue(document, reference.pointer);
      if (value !== undefined) record(value, reference.pointer, "field", false, false);
    }
  } catch (error) { return rejected(inspection, error instanceof AtifLimitError ? error.code : "POINTER_INVENTORY_FAILED"); }
  for (const diagnostic of policyDiagnostics) if (diagnostic.code.startsWith("VERSION_FIELD:")) {
    const value = atifPointerValue(document, diagnostic.pointer);
    if (value !== undefined) {
      (inspection.unmappedFields ??= []).push({ pointer: diagnostic.pointer, reason: "ATIF_VERSION_FIELD_UNVERIFIED" });
      try { record(value, diagnostic.pointer, "field", false, false); }
      catch (error) { return rejected(inspection, error instanceof AtifLimitError ? error.code : "POINTER_INVENTORY_FAILED"); }
    }
  }
  inspection.versionPolicy = { status: unsupported ? "unsupported" : policyDiagnostics.some(({ code }) => code !== "ATIF_MAJOR_VERSION_UNSUPPORTED") ? "inconsistent" : "supported",
    diagnostics: [...new Map(policyDiagnostics.map((diagnostic) => [`${diagnostic.code}\0${diagnostic.pointer}`, diagnostic])).values()] };
  if (inspection.versionPolicy.status === "inconsistent") inspection.limitations.push("ATIF_VERSION_FIELD_UNVERIFIED");
  const diagnostics = validateAtifStructure(document);
  inspection.structural = { status: diagnostics.length ? "invalid" : "valid", validator: "ebo", version: ATIF_READER_VERSION,
    modelDigest: hashValue(validateAtifStructure.toString()), validationPolicyDigest: hashValue(ATIF_VERSION_FEATURES), diagnostics };
  return { inspection, document };
}

/** EBO validation owns admission. A caller may additionally request an installed Harbor cross-check. */
export async function readAtifFile(path: string, options: AtifReadOptions = {}): Promise<AtifReadResult> {
  let bytes: Buffer;
  try { bytes = readBoundedFile(path, "ATIF document", undefined, ATIF_LIMITS.documentBytes); }
  catch (error) {
    if (options.propagateReadErrors) throw error;
    const result = inspectAtifBytes(Buffer.from("null"));
    result.inspection.source = {};
    try { const stat = lstatSync(path); result.inspection.source.bytes = stat.size; } catch { /* Missing source has no byte identity. */ }
    return rejected(result.inspection, "DOCUMENT_UNREADABLE_OR_OVERSIZED");
  }
  const result = inspectAtifBytes(bytes);
  if (result.document === undefined) return result;
  if (options.pythonExecutable !== undefined) result.inspection.harborCrossCheck = await validateWithHarbor(bytes, options.pythonExecutable);
  let totalBytes = 0;
  const admitted = new Set(options.retainedFiles ?? []);
  const retainedTargets = new Map<string, Pick<AtifReference, "status" | "reason" | "digest" | "bytes">>();
  for (const reference of result.inspection.references) {
    if (reference.kind === "embedded" || reference.kind === "session-only") continue;
    if (!safeReferencePath(reference.target)) { reference.reason = "UNSAFE_REFERENCE_PATH"; continue; }
    if (!admitted.has(reference.target)) { reference.reason = "REFERENCE_NOT_ADMITTED"; continue; }
    let target: string | undefined;
    try {
      target = resolveRelativeRegularFile(dirname(resolve(path)), reference.target);
      const retained = retainedTargets.get(target);
      if (retained !== undefined) { Object.assign(reference, retained); if (retained.reason === undefined) delete reference.reason; continue; }
      const remaining = ATIF_LIMITS.attachmentTotalBytes - totalBytes;
      if (lstatSync(target).size > remaining) {
        reference.reason = "ATTACHMENT_TOTAL_BYTE_LIMIT";
        retainedTargets.set(target, { status: "unavailable", reason: reference.reason });
        continue;
      }
      const content = readBoundedFile(target, "ATIF attachment", undefined, Math.min(ATIF_LIMITS.attachmentBytes, remaining));
      totalBytes += content.byteLength;
      Object.assign(reference, { status: "retained", digest: hashBytes(content), bytes: content.byteLength });
      delete reference.reason;
    } catch { reference.reason = "REFERENCE_MISSING_UNSAFE_OR_OVERSIZED"; }
    if (target !== undefined) retainedTargets.set(target, { status: reference.status,
      ...(reference.reason === undefined ? {} : { reason: reference.reason }),
      ...(reference.digest === undefined ? {} : { digest: reference.digest }),
      ...(reference.bytes === undefined ? {} : { bytes: reference.bytes }) });
  }
  result.inspection.limitations = result.inspection.limitations.filter((value) => value !== "EXTERNAL_REFERENCE_UNAVAILABLE");
  if (result.inspection.references.some(({ status }) => status === "unavailable")) result.inspection.limitations.push("EXTERNAL_REFERENCE_UNAVAILABLE");
  return result;
}

/** JSON pointer readback does not coerce keys or permit prototype traversal. */
export function atifPointerValue(document: unknown, pointer: string): unknown {
  if (pointer === "#") return document;
  if (!pointer.startsWith("#/")) return undefined;
  let current = document;
  for (const encoded of pointer.slice(2).split("/")) {
    if (/~(?:[^01]|$)/u.test(encoded)) return undefined;
    const key = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= current.length) return undefined;
      current = current[Number(key)];
    } else if (isAtifObject(current) && Object.hasOwn(current, key)) current = current[key];
    else return undefined;
  }
  return current;
}

export function isAtifObject(value: unknown): value is AtifObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function atifObject(value: unknown): AtifObject { return object(value); }
const object = (value: unknown): AtifObject => isAtifObject(value) ? value : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const hashBytes = (bytes: Uint8Array): AtifDigest => `sha256:${digestBytes(bytes).value}`;
const hashValue = (value: unknown): AtifDigest => `sha256:${digestMetadata(value).value}`;
class AtifLimitError extends Error { constructor(public readonly code: string) { super(code); } }
function unavailableValidator(code: string): AtifStructuralResult {
  return { status: "unavailable", validator: "harbor", version: "unknown", diagnostics: [{ code, pointer: "#" }] };
}
function rejected(inspection: AtifInspection, code: string): AtifReadResult {
  inspection.versionPolicy = { status: "unavailable", diagnostics: [{ code, pointer: "#" }] };
  inspection.records = []; inspection.references = [];
  return { inspection };
}
function checkBounds(document: unknown): void {
  const pending: Array<{ value: unknown; depth: number; key: string }> = [{ value: document, depth: 0, key: "" }];
  let nodes = 0;
  let enqueued = 1;
  const enqueue = (value: unknown, depth: number, key: string) => {
    if (++enqueued > ATIF_LIMITS.nodes) throw new AtifLimitError("DOCUMENT_COMPLEXITY_LIMIT");
    pending.push({ value, depth, key });
  };
  while (pending.length) {
    const { value, depth, key } = pending.pop()!;
    if (++nodes > ATIF_LIMITS.nodes || depth > ATIF_LIMITS.depth) throw new AtifLimitError("DOCUMENT_COMPLEXITY_LIMIT");
    if (typeof value === "number" && !Number.isFinite(value)) throw new AtifLimitError("NONFINITE_JSON_NUMBER");
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new AtifLimitError("UNSAFE_JSON_INTEGER");
    if (Array.isArray(value)) {
      if (["prompt_token_ids", "completion_token_ids", "logprobs"].includes(key) && value.length > ATIF_LIMITS.tokenArrayItems) throw new AtifLimitError("TOKEN_ARRAY_LIMIT");
      if (value.length > ATIF_LIMITS.nodes - enqueued) throw new AtifLimitError("DOCUMENT_COMPLEXITY_LIMIT");
      for (const nested of value) enqueue(nested, depth + 1, "");
    } else if (isAtifObject(value)) {
      for (const name in value) if (Object.hasOwn(value, name)) enqueue(value[name], depth + 1, name);
    }
  }
}
function findReferences(trajectory: AtifObject, pointer: string, references: AtifReference[], features: typeof ATIF_VERSION_FEATURES[AtifVersion] | undefined,
  pointerDigests: ReadonlyMap<string, AtifDigest>,
  violation: (code: string, pointer: string) => void): void {
  const children = new Map<string, { pointer: string; digest: AtifDigest } | null>();
  for (const [index, value] of array(trajectory.subagent_trajectories).entries()) {
    const identity = object(value).trajectory_id, location = `${pointer}/subagent_trajectories/${index}`;
    const digest = pointerDigests.get(location);
    if (typeof identity === "string" && digest !== undefined) children.set(identity, children.has(identity) ? null : { pointer: location, digest });
  }
  const addFile = (target: unknown, location: string, kind: AtifReference["kind"]) => {
    if (typeof target === "string") references.push({ pointer: location, target, kind, status: "unavailable", reason: "REFERENCE_NOT_ADMITTED" });
  };
  const content = (value: unknown, location: string) => {
    for (const [index, part] of array(value).entries()) {
      const item = object(part);
      if (item.type === "audio" && !features?.audio) violation("VERSION_FIELD:audio", `${location}/${index}`);
      if (["image", "audio"].includes(String(item.type))) addFile(object(item.source).path, `${location}/${index}/source/path`, "media");
    }
  };
  addFile(trajectory.continued_trajectory_ref, `${pointer}/continued_trajectory_ref`, "continuation");
  for (const [index, step] of array(trajectory.steps).entries()) {
    const location = `${pointer}/steps/${index}`;
    content(object(step).message, `${location}/message`);
    for (const [resultIndex, result] of array(object(object(step).observation).results).entries()) {
      const resultLocation = `${location}/observation/results/${resultIndex}`;
      content(object(result).content, `${resultLocation}/content`);
      for (const [refIndex, value] of array(object(result).subagent_trajectory_ref).entries()) {
        const reference = object(value), refLocation = `${resultLocation}/subagent_trajectory_ref/${refIndex}`;
        if (features !== undefined && !features.embeddedTrajectories && typeof reference.session_id !== "string") violation("VERSION_REQUIRES_REF_SESSION_ID", `${refLocation}/session_id`);
        addFile(reference.trajectory_path, `${refLocation}/trajectory_path`, "subagent-file");
        if (reference.trajectory_id == null && reference.trajectory_path == null && typeof reference.session_id === "string") {
          references.push({ pointer: `${refLocation}/session_id`, target: reference.session_id, kind: "session-only", status: "unavailable",
            reason: "SESSION_REFERENCE_NOT_RETAINED" });
        }
        if (typeof reference.trajectory_id === "string") {
          if (features !== undefined && !features.embeddedTrajectories) violation("VERSION_FIELD:ref.trajectory_id", `${refLocation}/trajectory_id`);
          const child = children.get(reference.trajectory_id);
          if (child == null) references.push({ pointer: `${refLocation}/trajectory_id`, target: reference.trajectory_id, kind: "embedded",
            status: "unavailable", reason: "EMBEDDED_REFERENCE_MISSING_OR_AMBIGUOUS" });
          else references.push({ pointer: `${refLocation}/trajectory_id`, target: child.pointer, kind: "embedded",
            status: "retained", digest: child.digest });
        }
      }
    }
  }
}
function safeReferencePath(path: string): boolean {
  return path !== "" && !isAbsolute(path) && !/^[a-z][a-z0-9+.-]*:/iu.test(path)
    && !path.includes("\\") && !path.includes("\0") && !path.split("/").some((part) => part === ".." || part === "");
}
function resolveRelativeRegularFile(root: string, path: string): string {
  let current = root;
  for (const [index, part] of path.split("/").entries()) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index === path.split("/").length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error("Unsafe attachment");
  }
  return current;
}

// Static validation code only. Input bytes are data on stdin, never Python source or paths to import.
const HARBOR_VALIDATOR = `import sys,json,hashlib,pathlib
from importlib.metadata import version
harbor_version=version('harbor')
import harbor.models.trajectories as package
from harbor.models.trajectories import Trajectory
root=pathlib.Path(package.__file__).parent
files=[(p.name,p.read_text()) for p in sorted(root.glob('*.py'))]
model_digest='sha256:'+hashlib.sha256(json.dumps(files,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
document=json.loads(sys.stdin.read().removeprefix(chr(0xfeff)))
native_status='valid'
try: Trajectory.model_validate(document)
except Exception: native_status='invalid'
compatibility=[]
def diagnostic(code,pointer):
 return {'code':code,'pointer':pointer} if len(json.dumps(pointer).encode())<=512 else {'code':code+'_LOCATION_UNAVAILABLE','pointer':'#'}
def collection(value): return value if isinstance(value,list) else []
def legacy_view(trajectory,pointer='#'):
 if not isinstance(trajectory,dict): return
 if trajectory.get('schema_version') in {'ATIF-v1.2','ATIF-v1.3','ATIF-v1.4','ATIF-v1.5','ATIF-v1.6'}:
  for si,step in enumerate(collection(trajectory.get('steps'))):
   if not isinstance(step,dict): continue
   observation=step.get('observation')
   if not isinstance(observation,dict): continue
   for ri,result in enumerate(collection(observation.get('results'))):
    if not isinstance(result,dict): continue
    for fi,ref in enumerate(collection(result.get('subagent_trajectory_ref'))):
     if isinstance(ref,dict) and isinstance(ref.get('session_id'),str) and ref.get('trajectory_id') is None and ref.get('trajectory_path') is None:
      ref['trajectory_path']='ebo-validation-unresolved-legacy-reference'
      compatibility.append(diagnostic('PRE_V1_7_SESSION_REFERENCE_VALIDATION_VIEW',pointer+'/steps/'+str(si)+'/observation/results/'+str(ri)+'/subagent_trajectory_ref/'+str(fi)))
 for ci,child in enumerate(collection(trajectory.get('subagent_trajectories'))): legacy_view(child,pointer+'/subagent_trajectories/'+str(ci))
if native_status=='invalid': legacy_view(document)
base={'version':harbor_version,'modelDigest':model_digest,'nativeModelStatus':native_status,'compatibilityDiagnostics':compatibility[:32],
 'compatibilityDiagnosticCount':len(compatibility),'compatibilityDiagnosticsTruncated':len(compatibility)>32}
try:
 Trajectory.model_validate(document)
 print(json.dumps(dict(base,status='valid',diagnostics=[])))
except Exception as error:
 locations=error.errors(include_input=False,include_context=False,include_url=False) if hasattr(error,'errors') else []
 diagnostics=[diagnostic('HARBOR_STRUCTURAL_INVALID','#/'+ '/'.join(str(x).replace('~','~0').replace('/','~1') for x in e['loc'])) for e in locations[:32]]
 print(json.dumps(dict(base,status='invalid',diagnostics=diagnostics or [{'code':'HARBOR_STRUCTURAL_INVALID','pointer':'#'}])))
`;
async function validateWithHarbor(bytes: Uint8Array, python: string): Promise<AtifStructuralResult> {
  return new Promise((complete) => {
    const child = spawn(python, ["-I", "-c", HARBOR_VALIDATOR], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let size = 0; let finished = false;
    const finish = (value: AtifStructuralResult) => { if (finished) return; finished = true; clearTimeout(timer); complete(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(unavailableValidator("HARBOR_VALIDATION_TIMEOUT")); }, 15_000);
    child.on("error", () => finish(unavailableValidator("HARBOR_VALIDATOR_UNAVAILABLE")));
    child.stdin.on("error", () => { /* Early subprocess failure is reported on close. */ });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) { child.kill("SIGKILL"); finish(unavailableValidator("HARBOR_VALIDATOR_OUTPUT_LIMIT")); }
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("close", (code) => {
      if (code !== 0) { finish(unavailableValidator("HARBOR_VALIDATOR_UNAVAILABLE")); return; }
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        if (!["valid", "invalid"].includes(String(response.status)) || typeof response.modelDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(response.modelDigest)
          || !Array.isArray(response.diagnostics)) throw new Error("Invalid validator receipt");
        finish({ status: response.status as "valid" | "invalid", validator: "harbor", version: typeof response.version === "string" ? response.version : "unknown",
          modelDigest: response.modelDigest as AtifDigest, validationPolicyDigest: hashBytes(Buffer.from(HARBOR_VALIDATOR)),
          nativeModelStatus: response.nativeModelStatus as "valid" | "invalid",
          compatibilityDiagnostics: response.compatibilityDiagnostics as AtifDiagnostic[],
          compatibilityDiagnosticCount: response.compatibilityDiagnosticCount as number,
          compatibilityDiagnosticsTruncated: response.compatibilityDiagnosticsTruncated as boolean,
          diagnostics: response.diagnostics as AtifDiagnostic[] });
      } catch { finish(unavailableValidator("HARBOR_VALIDATOR_INVALID_RECEIPT")); }
    });
    child.stdin.end(bytes);
  });
}
