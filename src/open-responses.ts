import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import { readBoundedFile } from "./scheduler.js";

/**
 * Wire-conformance analysis of recorded Responses traffic against the Open Responses specification.
 * Interoperability facts (did requests finish, were tool results replayed) and schema conformance are
 * reported in separate blocks. The report carries identifiers, type names, and counts; it never copies
 * prompt, completion, or reasoning text out of the recording.
 */
export const OPEN_RESPONSES_SPEC_VERSION = "2026-04-24";
/** SHA-256 of the vendored `contracts/open-responses-2026-04-24/openapi.json`. */
export const OPEN_RESPONSES_SCHEMA_SHA256 = "d598753c3a86fd8a2434828fe39dcc8786a7a694bbe46080a0d24c9fa40e72df";
export const OPEN_RESPONSES_ANALYSIS_FORMAT = "ebo.open-responses-wire-analysis/v1";
export const OPEN_RESPONSES_ENDPOINTS = ["responses", "chat/completions"] as const;
export type OpenResponsesEndpoint = typeof OPEN_RESPONSES_ENDPOINTS[number];

const BUNDLED_SCHEMA_PATH = fileURLToPath(new URL(`../../contracts/open-responses-${OPEN_RESPONSES_SPEC_VERSION}/openapi.json`, import.meta.url));
const MAX_SCHEMA_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_ERRORS = 8;
const TERMINAL_EVENTS = ["response.completed", "response.failed", "response.incomplete"];

export type OpenResponsesSchema = {
  source: "bundled" | "caller-supplied";
  /** `info.version` declared by the schema document. */
  specVersion: string;
  sha256: string;
  eventValidators: ReadonlyMap<string, ValidateFunction>;
  responseValidator: ValidateFunction;
};

/** Load the vendored schema, or a caller-supplied OpenAPI document whose digest and declared version are recorded. */
export function loadOpenResponsesSchema(path?: string): OpenResponsesSchema {
  const bytes = readBoundedFile(path ?? BUNDLED_SCHEMA_PATH, "Open Responses schema", undefined, MAX_SCHEMA_BYTES);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (path === undefined && sha256 !== OPEN_RESPONSES_SCHEMA_SHA256) throw new Error("Bundled Open Responses schema does not match its recorded digest.");
  const document: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const info = isRecord(document) && isRecord(document.info) ? document.info : {};
  const schemas = isRecord(document) && isRecord(document.components) && isRecord(document.components.schemas) ? document.components.schemas : undefined;
  if (typeof info.version !== "string" || info.version === "" || schemas === undefined || !isRecord(schemas.ResponseResource)) {
    throw new Error("Open Responses schema must declare info.version and components.schemas.ResponseResource.");
  }
  if (path === undefined && info.version !== OPEN_RESPONSES_SPEC_VERSION) throw new Error("Bundled Open Responses schema declares an unexpected version.");
  const id = `urn:ebo:contract:open-responses:${sha256}`;
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema({ ...(document as object), $id: id });
  const eventValidators = new Map<string, ValidateFunction>();
  for (const [name, value] of Object.entries(schemas)) {
    if (!name.endsWith("StreamingEvent") || !isRecord(value) || !isRecord(value.properties) || !isRecord(value.properties.type)) continue;
    const declared = value.properties.type;
    const type = typeof declared.const === "string" ? declared.const : Array.isArray(declared.enum) && declared.enum.length === 1 ? declared.enum[0] : undefined;
    if (typeof type === "string") eventValidators.set(type, ajv.compile({ $ref: `${id}#/components/schemas/${name}` }));
  }
  if (eventValidators.size === 0) throw new Error("Open Responses schema declares no streaming event types.");
  return {
    source: path === undefined ? "bundled" : "caller-supplied", specVersion: info.version, sha256, eventValidators,
    responseValidator: ajv.compile({ $ref: `${id}#/components/schemas/ResponseResource` }),
  };
}

export type SseFrame = { event: string | null; value: Record<string, unknown> | null; parseError: string | null };

/** Parse an SSE body into data frames. Parse errors name the defect and never echo the payload. */
export function parseSse(bytes: Uint8Array): SseFrame[] {
  const frames: SseFrame[] = [];
  let event: string | null = null;
  let data: string[] = [];
  const flush = (): void => {
    if (data.length > 0) {
      const text = data.join("\n");
      if (text !== "[DONE]") {
        try {
          const value: unknown = JSON.parse(text);
          frames.push(isRecord(value) ? { event, value, parseError: null } : { event, value: null, parseError: "SSE data is not an event object." });
        } catch {
          frames.push({ event, value: null, parseError: "Invalid JSON in SSE data." });
        }
      }
    }
    event = null;
    data = [];
  };
  for (const line of Buffer.from(bytes).toString("utf8").split(/\r?\n/u)) {
    if (line === "") { flush(); continue; }
    if (line.startsWith(":")) continue;
    const at = line.indexOf(":");
    const field = at < 0 ? line : line.slice(0, at);
    let value = at < 0 ? "" : line.slice(at + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  flush();
  return frames;
}

export type OpenResponsesSchemaViolation = {
  /** Frame index within the response stream. */
  index: number;
  type: string | null;
  errorCount: number;
  /** First schema errors, reduced to locations and keywords so no instance value is retained. */
  errors: Array<{ instancePath: string; schemaPath: string; keyword: string; message: string }>;
};

export type OpenResponsesStreamAnalysis = {
  events: number;
  eventTypes: Record<string, number>;
  /** Events whose type carries an implementor prefix (`slug:name`) and is therefore outside the core schema. */
  extensionEvents: number;
  eventSchemaViolations: OpenResponsesSchemaViolation[];
  sseEventNameDeviations: Array<{ index: number; event: string | null; type: string | null }>;
  sseParseErrors: Array<{ index: number; error: string }>;
  sequenceGaps: Array<{ index: number; previous: number; current: number }>;
  terminalEvents: Array<{ index: number; type: string; status: string | null }>;
  responseSchemaViolations: OpenResponsesSchemaViolation[];
  functionCalls: Array<{ callId: string | null; name: string | null; argumentsJsonValid: boolean }>;
};

/** Check one response stream: event schemas, SSE event names, sequence order, and terminal response objects. */
export function analyzeOpenResponsesStream(schema: OpenResponsesSchema, frames: readonly SseFrame[]): OpenResponsesStreamAnalysis {
  const eventTypes = new Map<string, number>();
  const calls = new Map<string, OpenResponsesStreamAnalysis["functionCalls"][number]>();
  const report: OpenResponsesStreamAnalysis = {
    events: 0, eventTypes: {}, extensionEvents: 0, eventSchemaViolations: [], sseEventNameDeviations: [], sseParseErrors: [],
    sequenceGaps: [], terminalEvents: [], responseSchemaViolations: [], functionCalls: [],
  };
  let previousSequence: number | null = null;
  for (const [index, frame] of frames.entries()) {
    if (frame.value === null) { report.sseParseErrors.push({ index, error: frame.parseError ?? "Unreadable SSE data." }); continue; }
    const event = frame.value;
    const type = typeof event.type === "string" ? event.type : null;
    report.events += 1;
    eventTypes.set(type ?? "(missing)", (eventTypes.get(type ?? "(missing)") ?? 0) + 1);
    if (frame.event !== type) report.sseEventNameDeviations.push({ index, event: frame.event, type });
    const validate = type === null ? undefined : schema.eventValidators.get(type);
    if (validate !== undefined) {
      if (!validate(event)) report.eventSchemaViolations.push(violation(index, type, validate.errors));
    } else if (type !== null && type.includes(":")) {
      report.extensionEvents += 1;
    } else {
      report.eventSchemaViolations.push({ index, type, errorCount: 1, errors: [{
        instancePath: "/type", schemaPath: "", keyword: "unknown-event-type", message: "Event type is absent from the Open Responses schema.",
      }] });
    }
    if (typeof event.sequence_number === "number") {
      if (previousSequence !== null && event.sequence_number !== previousSequence + 1) {
        report.sequenceGaps.push({ index, previous: previousSequence, current: event.sequence_number });
      }
      previousSequence = event.sequence_number;
    }
    const response = isRecord(event.response) ? event.response : undefined;
    if (type !== null && TERMINAL_EVENTS.includes(type)) {
      report.terminalEvents.push({ index, type, status: typeof response?.status === "string" ? response.status : null });
      if (!schema.responseValidator(event.response)) report.responseSchemaViolations.push(violation(index, type, schema.responseValidator.errors));
    }
    const items = [
      ...(type === "response.output_item.done" && isRecord(event.item) ? [event.item] : []),
      ...(Array.isArray(response?.output) ? response.output.filter(isRecord) : []),
    ];
    for (const item of items) {
      if (item.type !== "function_call") continue;
      const callId = typeof item.call_id === "string" ? item.call_id : null;
      calls.set(callId ?? `(missing):${calls.size}`, { callId, name: typeof item.name === "string" ? item.name : null, argumentsJsonValid: validJson(item.arguments) });
    }
  }
  report.eventTypes = Object.fromEntries(eventTypes);
  report.functionCalls = [...calls.values()];
  return report;
}

type Unchecked = { status: "not-applicable" | "unavailable"; reason: string };

export type OpenResponsesRequestAnalysis = {
  number: number;
} & ({ state: "in-progress" } | {
  state: "finished";
  endpoint: OpenResponsesEndpoint | null;
  httpStatus: number | null;
  transportError: boolean;
  /** Terminal marker the recorder observed, or null when the stream ended without one. */
  terminal: string | null;
  /** Request facts read from the retained body; null when the body is unreadable. */
  request: { store: boolean | null; continuesStoredResponse: boolean } | null;
  conformance: ({ status: "checked" } & OpenResponsesStreamAnalysis) | Unchecked;
  replay: { status: "checked"; expectedCallIds: string[]; replayedCallIds: string[]; missingCallIds: string[] } | Unchecked;
});

export type OpenResponsesRouteAnalysis = {
  requests: OpenResponsesRequestAnalysis[];
  /** Wire-level outcomes. Whether the agent completed its task is native harness evidence, not recorded here. */
  interoperability: {
    requests: { total: number; finished: number; inProgress: number };
    terminals: Record<string, number>;
    withoutTerminal: number;
    httpErrors: number;
    transportErrors: number;
    toolResultReplay: { checked: number; notApplicable: number; unavailable: number; missingToolResults: number | null };
  };
  /** Schema conformance. A count is null when no request supplied evidence for that check. */
  conformance: {
    checked: number;
    notApplicable: number;
    unavailable: number;
    terminalResponsesChecked: number;
    responseSchemaViolations: number | null;
    eventSchemaViolations: number | null;
    eventSchemaViolationsByType: Record<string, number>;
    sseEventNameDeviations: number | null;
    sseParseErrors: number | null;
    sequenceGaps: number | null;
  };
};

export type OpenResponsesWireAnalysis = {
  schemaVersion: typeof OPEN_RESPONSES_ANALYSIS_FORMAT;
  specification: { name: "Open Responses"; version: string; schema: { source: OpenResponsesSchema["source"]; sha256: string } };
  routes: Record<string, OpenResponsesRouteAnalysis>;
};

/** Analyze every route directory under a recording root written by the Open Responses recorder. */
export function analyzeOpenResponsesRecording(recordingRoot: string, schema = loadOpenResponsesSchema()): OpenResponsesWireAnalysis {
  const routes = new Map<string, OpenResponsesRouteAnalysis>();
  for (const entry of readdirSync(recordingRoot, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : 1)) {
    if (entry.isDirectory()) routes.set(entry.name, analyzeOpenResponsesRoute(join(recordingRoot, entry.name), schema));
  }
  return {
    schemaVersion: OPEN_RESPONSES_ANALYSIS_FORMAT,
    specification: { name: "Open Responses", version: schema.specVersion, schema: { source: schema.source, sha256: schema.sha256 } },
    routes: Object.fromEntries(routes),
  };
}

export function analyzeOpenResponsesRoute(routeDirectory: string, schema = loadOpenResponsesSchema()): OpenResponsesRouteAnalysis {
  const requests: OpenResponsesRequestAnalysis[] = [];
  // Function calls the next request must answer: known after a completed response, unknown after an unobserved one.
  let basis: { known: true; callIds: string[] } | { known: false; reason: string } | undefined;
  for (const name of readdirSync(routeDirectory).filter((candidate) => /^\d+$/u.test(candidate)).sort()) {
    const directory = join(routeDirectory, name);
    const number = Number(name);
    if (!existsSync(join(directory, "receipt.json"))) {
      requests.push({ number, state: "in-progress" });
      basis = { known: false, reason: "A preceding request has no receipt." };
      continue;
    }
    const receipt = readJsonObject(join(directory, "receipt.json")) ?? {};
    const endpoint = OPEN_RESPONSES_ENDPOINTS.find((candidate) => candidate === receipt.endpoint) ?? null;
    const httpStatus = typeof receipt.status === "number" ? receipt.status : null;
    const body = readJsonObject(join(directory, "request.json"));
    const continuesStoredResponse = typeof body?.previous_response_id === "string";

    let conformance: Extract<OpenResponsesRequestAnalysis, { state: "finished" }>["conformance"];
    if (endpoint !== "responses") conformance = { status: "not-applicable", reason: "The request did not use the Responses endpoint." };
    else if (httpStatus === null || httpStatus < 200 || httpStatus > 299) conformance = { status: "unavailable", reason: httpStatus === null ? "No upstream response was received." : `Upstream returned HTTP ${httpStatus}.` };
    else if (typeof receipt.contentType !== "string" || !receipt.contentType.toLowerCase().startsWith("text/event-stream")) conformance = { status: "unavailable", reason: "The response is not an event stream." };
    else if (!existsSync(join(directory, "response.bin"))) conformance = { status: "unavailable", reason: "The response body was not retained." };
    else conformance = { status: "checked", ...analyzeOpenResponsesStream(schema, parseSse(readFileSync(join(directory, "response.bin")))) };

    let replay: Extract<OpenResponsesRequestAnalysis, { state: "finished" }>["replay"];
    if (endpoint !== "responses") replay = { status: "not-applicable", reason: "The request did not use the Responses endpoint." };
    else if (body === null) replay = { status: "unavailable", reason: "The request body is unreadable." };
    else if (continuesStoredResponse) replay = { status: "not-applicable", reason: "The request continues a stored response." };
    else if (basis === undefined) replay = { status: "not-applicable", reason: "No completed response precedes this request." };
    else if (!basis.known) replay = { status: "unavailable", reason: basis.reason };
    else {
      const replayed = new Set(Array.isArray(body.input) ? body.input.flatMap((item) =>
        isRecord(item) && item.type === "function_call_output" && typeof item.call_id === "string" ? [item.call_id] : []) : []);
      replay = {
        status: "checked", expectedCallIds: basis.callIds,
        replayedCallIds: basis.callIds.filter((id) => replayed.has(id)), missingCallIds: basis.callIds.filter((id) => !replayed.has(id)),
      };
    }

    // A failed response or HTTP error leaves the earlier expectation in force for the retry that follows.
    if (conformance.status === "checked") {
      const completed = conformance.terminalEvents.some(({ type }) => type === "response.completed");
      const failed = conformance.terminalEvents.some(({ type }) => type === "response.failed");
      if (completed && conformance.sseParseErrors.length === 0 && conformance.functionCalls.every(({ callId }) => callId !== null)) {
        basis = { known: true, callIds: conformance.functionCalls.map(({ callId }) => callId!) };
      } else if (!failed) basis = { known: false, reason: "The preceding response was not observed to completion." };
    }
    requests.push({
      number, state: "finished", endpoint, httpStatus, transportError: receipt.error !== null && receipt.error !== undefined,
      terminal: typeof receipt.terminal === "string" ? receipt.terminal : null,
      request: body === null ? null : { store: typeof body.store === "boolean" ? body.store : null, continuesStoredResponse },
      conformance, replay,
    });
  }

  const finished = requests.filter((request) => request.state === "finished");
  const checked = finished.flatMap(({ conformance }) => conformance.status === "checked" ? [conformance] : []);
  const replays = finished.map(({ replay }) => replay);
  const checkedReplays = replays.flatMap((replay) => replay.status === "checked" ? [replay] : []);
  const total = (count: (stream: OpenResponsesStreamAnalysis) => number): number | null =>
    checked.length === 0 ? null : checked.reduce((sum, stream) => sum + count(stream), 0);
  const terminalResponsesChecked = checked.reduce((sum, stream) => sum + stream.terminalEvents.length, 0);
  const terminals = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const { terminal } of finished) if (terminal !== null) terminals.set(terminal, (terminals.get(terminal) ?? 0) + 1);
  for (const stream of checked) for (const { type } of stream.eventSchemaViolations) byType.set(type ?? "(missing)", (byType.get(type ?? "(missing)") ?? 0) + 1);
  return {
    requests,
    interoperability: {
      requests: { total: requests.length, finished: finished.length, inProgress: requests.length - finished.length },
      terminals: Object.fromEntries(terminals),
      withoutTerminal: finished.filter(({ terminal }) => terminal === null).length,
      httpErrors: finished.filter(({ httpStatus }) => httpStatus !== null && (httpStatus < 200 || httpStatus > 299)).length,
      transportErrors: finished.filter(({ transportError }) => transportError).length,
      toolResultReplay: {
        checked: checkedReplays.length,
        notApplicable: replays.filter(({ status }) => status === "not-applicable").length,
        unavailable: replays.filter(({ status }) => status === "unavailable").length,
        missingToolResults: checkedReplays.length === 0 ? null : checkedReplays.reduce((sum, { missingCallIds }) => sum + missingCallIds.length, 0),
      },
    },
    conformance: {
      checked: checked.length,
      notApplicable: finished.filter(({ conformance }) => conformance.status === "not-applicable").length,
      unavailable: finished.filter(({ conformance }) => conformance.status === "unavailable").length,
      terminalResponsesChecked,
      responseSchemaViolations: terminalResponsesChecked === 0 ? null : checked.reduce((sum, stream) => sum + stream.responseSchemaViolations.length, 0),
      eventSchemaViolations: total((stream) => stream.eventSchemaViolations.length),
      eventSchemaViolationsByType: Object.fromEntries(byType),
      sseEventNameDeviations: total((stream) => stream.sseEventNameDeviations.length),
      sseParseErrors: total((stream) => stream.sseParseErrors.length),
      sequenceGaps: total((stream) => stream.sequenceGaps.length),
    },
  };
}

function violation(index: number, type: string | null, errors: ErrorObject[] | null | undefined): OpenResponsesSchemaViolation {
  const all = errors ?? [];
  return {
    index, type, errorCount: all.length,
    errors: all.slice(0, MAX_RETAINED_ERRORS).map(({ instancePath, schemaPath, keyword, message }) => ({ instancePath, schemaPath, keyword, message: message ?? keyword })),
  };
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function validJson(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try { JSON.parse(value); return true; } catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
