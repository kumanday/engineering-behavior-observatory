import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { main } from "../src/cli.js";
import {
  analyzeOpenResponsesRecording,
  analyzeOpenResponsesStream,
  loadOpenResponsesSchema,
  OPEN_RESPONSES_ANALYSIS_FORMAT,
  OPEN_RESPONSES_SCHEMA_SHA256,
  OPEN_RESPONSES_SPEC_VERSION,
  parseSse,
  type SseFrame,
} from "../src/open-responses.js";
import { runOpenResponsesCommand } from "../src/open-responses-cli.js";
import { createOpenResponsesRecorder, OPEN_RESPONSES_RECEIPT_FORMAT } from "../src/open-responses-recorder.js";

// Every fixture below is authored from the specification's shapes with synthetic values.
const schema = loadOpenResponsesSchema();
const message = { type: "message", id: "msg_synthetic_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "synthetic answer", annotations: [], logprobs: [] }] };
const call = { type: "function_call", id: "fc_synthetic_1", call_id: "call_synthetic_1", name: "read", arguments: "{\"path\":\"README.md\"}", status: "completed" };
const responseObject = (output: unknown[], status = "completed"): Record<string, unknown> => ({
  id: "resp_synthetic_1", object: "response", created_at: 1, completed_at: 2, status, incomplete_details: null,
  model: "synthetic-model", previous_response_id: null, instructions: null, output, error: null, tools: [], tool_choice: "auto",
  truncation: "disabled", parallel_tool_calls: true, text: { format: { type: "text" } }, top_p: 1, presence_penalty: 0, frequency_penalty: 0,
  top_logprobs: 0, temperature: 1, reasoning: null,
  usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  max_output_tokens: null, max_tool_calls: null, store: false, background: false, service_tier: "default", metadata: {}, safety_identifier: null, prompt_cache_key: null,
});
const delta = { type: "response.output_text.delta", item_id: "msg_synthetic_1", output_index: 0, content_index: 0, delta: "synthetic-private-delta", logprobs: [] };
const named = (events: Array<Record<string, unknown>>): SseFrame[] => events.map((value, index) => ({ event: String(value.type), value: { sequence_number: index, ...value }, parseError: null }));
const sse = (events: Array<Record<string, unknown>>): string => events.map((event, index) => `event: ${String(event.type)}\ndata: ${JSON.stringify({ sequence_number: index, ...event })}\n\n`).join("");
const toolStream = sse([{ type: "response.output_item.done", output_index: 0, item: call }, { type: "response.completed", response: responseObject([call]) }]);
const textStream = sse([delta, { type: "response.completed", response: responseObject([message]) }]);

test("the Open Responses specification version is a pinned, digest-bound analyzer input", () => {
  assert.equal(OPEN_RESPONSES_SPEC_VERSION, "2026-04-24");
  const directory = join(process.cwd(), `contracts/open-responses-${OPEN_RESPONSES_SPEC_VERSION}`);
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  const bytes = readFileSync(join(directory, "openapi.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), OPEN_RESPONSES_SCHEMA_SHA256);
  assert.equal(manifest.files["openapi.json"], OPEN_RESPONSES_SCHEMA_SHA256);
  assert.equal(manifest.specification.version, OPEN_RESPONSES_SPEC_VERSION);
  assert.equal(manifest.license.spdx, "Apache-2.0");
  assert.deepEqual([schema.source, schema.specVersion, schema.sha256], ["bundled", OPEN_RESPONSES_SPEC_VERSION, OPEN_RESPONSES_SCHEMA_SHA256]);

  const root = mkdtempSync(join(tmpdir(), "ebo-or-schema-"));
  try {
    const supplied = JSON.stringify({ ...JSON.parse(bytes.toString()), info: { title: "Open Responses", version: "2099-01-01" } });
    writeFileSync(join(root, "openapi.json"), supplied);
    const callerSchema = loadOpenResponsesSchema(join(root, "openapi.json"));
    mkdirSync(join(root, "recording"));
    const report = analyzeOpenResponsesRecording(join(root, "recording"), callerSchema);
    assert.deepEqual(report.specification, { name: "Open Responses", version: "2099-01-01", schema: { source: "caller-supplied", sha256: createHash("sha256").update(supplied).digest("hex") } });
    assert.deepEqual(analyzeOpenResponsesRecording(join(root, "recording")).specification,
      { name: "Open Responses", version: OPEN_RESPONSES_SPEC_VERSION, schema: { source: "bundled", sha256: OPEN_RESPONSES_SCHEMA_SHA256 } });
    writeFileSync(join(root, "unversioned.json"), JSON.stringify({ components: { schemas: { ResponseResource: {} } } }));
    assert.throws(() => loadOpenResponsesSchema(join(root, "unversioned.json")), /info\.version/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SSE parsing handles multiline data, comments, CRLF and DONE without retaining payload in errors", () => {
  const frames = parseSse(Buffer.from(': heartbeat\r\nevent: response.in_progress\r\ndata: {"type":\r\ndata: "response.in_progress"}\r\n\r\ndata: [DONE]\r\n\r\n'));
  assert.deepEqual(frames, [{ event: "response.in_progress", value: { type: "response.in_progress" }, parseError: null }]);
  const invalid = parseSse(Buffer.from("data: {synthetic-private-payload}\n\ndata: null\n\n"));
  assert.equal(invalid.length, 2);
  assert.ok(invalid.every((frame) => frame.value === null && frame.parseError !== null));
  assert.equal(JSON.stringify(invalid).includes("synthetic-private-payload"), false);
});

test("event schema, SSE event names and sequence order are checked without copying event content", () => {
  const clean = analyzeOpenResponsesStream(schema, named([delta, delta, { type: "acme:trace_event" }]));
  assert.deepEqual([clean.eventSchemaViolations, clean.sseEventNameDeviations, clean.sequenceGaps, clean.sseParseErrors], [[], [], [], []]);
  assert.equal(clean.extensionEvents, 1);
  assert.deepEqual(clean.eventTypes, { "response.output_text.delta": 2, "acme:trace_event": 1 });

  const frames: SseFrame[] = [
    { event: "response.output_text.delta", value: { ...delta, sequence_number: 2 }, parseError: null },
    { event: null, value: { ...delta, sequence_number: 4 }, parseError: null },
    { event: "message", value: { type: "response.unlisted_text.delta", sequence_number: 5, delta: "synthetic-private-delta" }, parseError: null },
    { event: "response.output_text.delta", value: { type: "response.output_text.delta" }, parseError: null },
    { event: null, value: null, parseError: "Invalid JSON in SSE data." },
  ];
  const broken = analyzeOpenResponsesStream(schema, frames);
  assert.deepEqual(broken.sequenceGaps, [{ index: 1, previous: 2, current: 4 }]);
  assert.deepEqual(broken.sseEventNameDeviations, [
    { index: 1, event: null, type: "response.output_text.delta" }, { index: 2, event: "message", type: "response.unlisted_text.delta" },
  ]);
  assert.deepEqual(broken.eventSchemaViolations.map(({ index, type, errors }) => [index, type, errors[0]!.keyword]),
    [[2, "response.unlisted_text.delta", "unknown-event-type"], [3, "response.output_text.delta", "required"]]);
  assert.deepEqual(broken.sseParseErrors, [{ index: 4, error: "Invalid JSON in SSE data." }]);
  assert.equal(JSON.stringify(broken).includes("synthetic-private-delta"), false);
});

test("terminal response objects are validated and function calls are deduplicated", () => {
  const conforming = analyzeOpenResponsesStream(schema, named([
    { type: "response.output_item.done", output_index: 0, item: call }, { type: "response.completed", response: responseObject([call]) },
  ]));
  assert.deepEqual([conforming.eventSchemaViolations, conforming.responseSchemaViolations], [[], []]);
  assert.deepEqual(conforming.terminalEvents, [{ index: 1, type: "response.completed", status: "completed" }]);
  assert.deepEqual(conforming.functionCalls, [{ callId: "call_synthetic_1", name: "read", argumentsJsonValid: true }]);

  const partial = analyzeOpenResponsesStream(schema, named([
    { type: "response.completed", response: { status: "completed", output: [{ ...call, arguments: "{" }] } },
  ]));
  assert.equal(partial.responseSchemaViolations.length, 1);
  assert.ok(partial.responseSchemaViolations[0]!.errorCount > partial.responseSchemaViolations[0]!.errors.length);
  assert.ok(partial.responseSchemaViolations[0]!.errors.every(({ keyword }) => keyword === "required"));
  assert.deepEqual(partial.functionCalls, [{ callId: "call_synthetic_1", name: "read", argumentsJsonValid: false }]);
  assert.deepEqual(analyzeOpenResponsesStream(schema, named([delta])).terminalEvents, []);
});

function writeRequest(route: string, number: number, options: { endpoint?: string; status?: number | null; contentType?: string; input?: unknown; body?: string; response?: string; terminal?: string | null; error?: object | null; receipt?: boolean }): void {
  const directory = join(route, String(number).padStart(6, "0"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "request.json"), options.body ?? JSON.stringify({ model: "synthetic-model", store: false, input: options.input ?? "synthetic prompt" }));
  if (options.response !== undefined) writeFileSync(join(directory, "response.bin"), options.response);
  if (options.receipt === false) return;
  writeFileSync(join(directory, "receipt.json"), JSON.stringify({
    schemaVersion: OPEN_RESPONSES_RECEIPT_FORMAT, number, endpoint: options.endpoint ?? "responses", status: options.status === undefined ? 200 : options.status,
    contentType: options.contentType ?? "text/event-stream", terminal: options.terminal === undefined ? "response.completed" : options.terminal, error: options.error ?? null,
  }));
}

test("recording analysis checks tool-result replay and keeps interoperability apart from schema conformance", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-or-analysis-"));
  try {
    const route = join(root, "route-a");
    const output = { type: "function_call_output", call_id: "call_synthetic_1", output: "synthetic tool result" };
    writeRequest(route, 1, { response: toolStream });
    writeRequest(route, 2, { input: [output], response: toolStream });
    writeRequest(route, 3, { input: [output], status: 429, contentType: "application/json", response: "{}", terminal: null });
    writeRequest(route, 4, { input: [{ type: "message", role: "user", content: "synthetic prompt" }], response: textStream });
    writeRequest(route, 5, { body: JSON.stringify({ model: "synthetic-model", previous_response_id: "resp_synthetic_1", input: [] }), response: sse([delta]), terminal: null, error: { name: "AbortError", message: "synthetic" } });
    writeRequest(route, 6, { input: [], response: textStream });
    writeRequest(route, 7, { body: "{", response: textStream });
    writeRequest(route, 8, { receipt: false });
    const report = analyzeOpenResponsesRecording(root);
    assert.equal(report.schemaVersion, OPEN_RESPONSES_ANALYSIS_FORMAT);
    const { requests, interoperability, conformance } = report.routes["route-a"]!;
    const finished = requests.flatMap((request) => request.state === "finished" ? [request] : []);
    assert.deepEqual(finished.map(({ replay }) => replay.status), ["not-applicable", "checked", "checked", "checked", "not-applicable", "unavailable", "unavailable"]);
    assert.deepEqual(finished[1]!.replay, { status: "checked", expectedCallIds: ["call_synthetic_1"], replayedCallIds: ["call_synthetic_1"], missingCallIds: [] });
    // The HTTP error leaves request 2's calls owed: request 4 is the retry that must answer them and does not.
    assert.deepEqual(finished[3]!.replay, { status: "checked", expectedCallIds: ["call_synthetic_1"], replayedCallIds: [], missingCallIds: ["call_synthetic_1"] });
    assert.deepEqual(finished[2]!.conformance, { status: "unavailable", reason: "Upstream returned HTTP 429." });
    assert.deepEqual(finished[4]!.request, { store: null, continuesStoredResponse: true });
    assert.match((finished[5]!.replay as { reason: string }).reason, /not observed to completion/u);
    assert.equal(finished[6]!.request, null);
    assert.deepEqual(requests[7], { number: 8, state: "in-progress" });
    assert.deepEqual(interoperability, {
      requests: { total: 8, finished: 7, inProgress: 1 }, terminals: { "response.completed": 5 }, withoutTerminal: 2, httpErrors: 1, transportErrors: 1,
      toolResultReplay: { checked: 3, notApplicable: 2, unavailable: 2, missingToolResults: 1 },
    });
    assert.deepEqual(conformance, {
      checked: 6, notApplicable: 0, unavailable: 1, terminalResponsesChecked: 5, responseSchemaViolations: 0, eventSchemaViolations: 0,
      eventSchemaViolationsByType: {}, sseEventNameDeviations: 0, sseParseErrors: 0, sequenceGaps: 0,
    });
    for (const text of ["synthetic-private-delta", "synthetic answer", "synthetic prompt", "synthetic tool result"]) assert.equal(JSON.stringify(report).includes(text), false, text);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("checks without evidence report null counts instead of zero", () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-or-unsupported-"));
  try {
    writeRequest(join(root, "chat"), 1, { endpoint: "chat/completions", response: "data: {}\n\n", terminal: "stop" });
    writeRequest(join(root, "failed"), 1, { status: null, terminal: null, error: { name: "TypeError", message: "synthetic" } });
    writeRequest(join(root, "open"), 1, { response: sse([delta]), terminal: null });
    const { routes } = analyzeOpenResponsesRecording(root);
    for (const name of ["chat", "failed"]) {
      const { conformance, interoperability } = routes[name]!;
      assert.deepEqual([conformance.checked, conformance.responseSchemaViolations, conformance.eventSchemaViolations, conformance.sseEventNameDeviations, conformance.sseParseErrors, conformance.sequenceGaps],
        [0, null, null, null, null, null], name);
      assert.equal(interoperability.toolResultReplay.missingToolResults, null);
    }
    assert.deepEqual([routes.chat!.conformance.notApplicable, routes.failed!.conformance.unavailable], [1, 1]);
    assert.deepEqual((routes.chat!.requests[0] as { conformance: object }).conformance, { status: "not-applicable", reason: "The request did not use the Responses endpoint." });
    assert.deepEqual([routes.open!.conformance.checked, routes.open!.conformance.terminalResponsesChecked, routes.open!.conformance.responseSchemaViolations, routes.open!.conformance.eventSchemaViolations], [1, 0, null, 0]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const ROUTE_TOKEN = "synthetic-route-token";
const UPSTREAM_CREDENTIAL = "synthetic-upstream-credential";
const recorded = (directory: string): string => readdirSync(directory).map((name) => readFileSync(join(directory, name), "latin1")).join("\n");

test("recorder retains exact fragmented bytes and stores no credential, token or header value", async () => {
  const root = join(mkdtempSync(join(tmpdir(), "ebo-or-recorder-")), "recording");
  const raw = Buffer.from('event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","sequence_number":1,"delta":"café ✓"}\r\n\r\ndata: {"type":"acme:extra","sequence_number":2}\n\ndata: {"type":"response.completed","response":{"id":"resp_synthetic_1","usage":{"input_tokens":7,"output_tokens":3}}}\n\n');
  const seen: Array<{ headers: Record<string, unknown>; body: Buffer }> = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    seen.push({ headers: request.headers, body: Buffer.concat(chunks) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (let offset = 0; offset < raw.length; offset += 7) response.write(raw.subarray(offset, offset + 7));
    response.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const recorder = createOpenResponsesRecorder({ root, upstreamCredential: UPSTREAM_CREDENTIAL, upstreamBaseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1` });
  assert.equal(recorder.register({ id: "case-a", endpoint: "responses", model: "synthetic-model", token: ROUTE_TOKEN }), ROUTE_TOKEN);
  const url = `http://127.0.0.1:${await recorder.listen()}/attempt/case-a/v1/responses`;
  try {
    const native = Buffer.from(' {"model":"synthetic-model","store":false,"input":"synthetic prompt"} ');
    const headers = { authorization: `Bearer ${ROUTE_TOKEN}`, "x-session-affinity": "synthetic-session-value", cookie: "synthetic-cookie-value", "x-api-key": "synthetic-client-key" };
    const plain = await fetch(url, { method: "POST", headers, body: native });
    assert.deepEqual(Buffer.from(await plain.arrayBuffer()), raw);
    const digest = createHash("sha256").update(native).digest("hex");
    const compressed = await fetch(url, { method: "POST", body: gzipSync(native),
      headers: { ...headers, "content-encoding": "gzip", "x-ebo-native-body-bytes": String(native.byteLength), "x-ebo-native-body-sha256": digest } });
    assert.equal(compressed.status, 200);
    await compressed.arrayBuffer();
    await recorder.drain();

    for (const { headers: upstreamHeaders, body } of seen) {
      assert.deepEqual(body, native);
      assert.equal(upstreamHeaders.authorization, `Bearer ${UPSTREAM_CREDENTIAL}`);
      assert.equal(upstreamHeaders["x-session-affinity"], "synthetic-session-value");
      for (const name of ["cookie", "x-api-key", "content-encoding", "x-ebo-native-body-bytes", "x-ebo-native-body-sha256"]) assert.equal(upstreamHeaders[name], undefined, name);
    }
    for (const [name, contentEncoding] of [["000001", null], ["000002", "gzip"]] as const) {
      const directory = join(root, "case-a", name);
      assert.deepEqual(readFileSync(join(directory, "request.json")), native);
      assert.deepEqual(readFileSync(join(directory, "response.bin")), raw);
      const receipt = JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8"));
      assert.equal(receipt.schemaVersion, OPEN_RESPONSES_RECEIPT_FORMAT);
      assert.deepEqual([receipt.status, receipt.terminal, receipt.responseId, receipt.error], [200, "response.completed", "resp_synthetic_1", null]);
      assert.deepEqual(receipt.usage, { input_tokens: 7, output_tokens: 3 });
      assert.deepEqual(receipt.request, { bytes: native.byteLength, sha256: digest, contentEncoding });
      assert.deepEqual(receipt.response, { bytes: raw.byteLength, sha256: createHash("sha256").update(raw).digest("hex") });
      assert.ok(receipt.requestHeaderNames.includes("authorization") && receipt.requestHeaderNames.includes("cookie"));
      assert.ok(receipt.forwardedHeaderNames.includes("x-session-affinity") && !receipt.forwardedHeaderNames.includes("cookie"));
      for (const secret of [ROUTE_TOKEN, UPSTREAM_CREDENTIAL, "synthetic-session-value", "synthetic-cookie-value", "synthetic-client-key"]) assert.equal(recorded(directory).includes(secret), false, secret);
      for (const file of readdirSync(directory)) assert.equal(statSync(join(directory, file)).mode & 0o077, 0, file);
    }

    const post = (init: RequestInit) => fetch(url, { method: "POST", ...init, headers: { authorization: `Bearer ${ROUTE_TOKEN}`, ...init.headers } });
    assert.equal((await post({ body: JSON.stringify({ model: "other-model" }) })).status, 400);
    assert.equal((await post({ body: gzipSync(native), headers: { "content-encoding": "gzip", "x-ebo-native-body-sha256": "0".repeat(64) } })).status, 400);
    assert.equal((await post({ body: native, headers: { "content-encoding": "gzip" } })).status, 400);
    assert.equal((await post({ body: native, headers: { "content-encoding": "br" } })).status, 415);
    assert.equal((await fetch(url, { method: "POST", headers: { authorization: "Bearer wrong" }, body: native })).status, 401);
    assert.equal((await fetch(url.replace("/responses", "/chat/completions"), { method: "POST", headers: { authorization: `Bearer ${ROUTE_TOKEN}` }, body: native })).status, 404);
    assert.equal(seen.length, 2);
    assert.deepEqual(readdirSync(join(root, "case-a")), ["000001", "000002"]);
    assert.throws(() => recorder.register({ id: "case-a", endpoint: "responses" }), /new and path-safe/u);
    assert.throws(() => recorder.register({ id: "case-b", endpoint: "responses", token: UPSTREAM_CREDENTIAL }), /differ from the upstream credential/u);
    assert.throws(() => createOpenResponsesRecorder({ root, upstreamCredential: UPSTREAM_CREDENTIAL, upstreamBaseUrl: "https://user:synthetic@provider.invalid/v1" }), /without credentials/u);
    assert.throws(() => createOpenResponsesRecorder({ root, upstreamCredential: UPSTREAM_CREDENTIAL, upstreamBaseUrl: "https://provider.invalid/v1" }).register({ id: "case-a", endpoint: "responses" }), /already has a recording/u);
  } finally {
    await recorder.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(join(root, ".."), { recursive: true, force: true });
  }
  // stdout may carry a protocol, so the recorder module has no console or process-stream writes at all.
  assert.doesNotMatch(readFileSync(new URL("../src/open-responses-recorder.js", import.meta.url), "utf8"), /console\.|process\.std/u);
});

test("recorder retains non-success bodies, keeps missing usage null and redacts credentials from transport errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-or-errors-"));
  let calls = 0;
  const recorder = createOpenResponsesRecorder({ root, upstreamCredential: UPSTREAM_CREDENTIAL, upstreamBaseUrl: "https://provider.invalid/v1", fetchImpl: async () => {
    if (++calls === 1) return new Response('{"error":{"message":"synthetic overload"}}', { status: 429, headers: { "content-type": "application/json" } });
    throw new Error(`synthetic failure for ${UPSTREAM_CREDENTIAL} and ${ROUTE_TOKEN}`);
  } });
  recorder.register({ id: "case-error", endpoint: "responses", token: ROUTE_TOKEN });
  const url = `http://127.0.0.1:${await recorder.listen()}/attempt/case-error/v1/responses`;
  try {
    const request = { method: "POST", headers: { authorization: `Bearer ${ROUTE_TOKEN}` }, body: JSON.stringify({ model: "synthetic-model" }) };
    const overloaded = await fetch(url, request);
    assert.equal(overloaded.status, 429);
    assert.match(await overloaded.text(), /synthetic overload/u);
    const failed = await fetch(url, request);
    assert.equal(failed.status, 502);
    const reply = await failed.text();
    await recorder.drain();
    const first = JSON.parse(readFileSync(join(root, "case-error", "000001", "receipt.json"), "utf8"));
    assert.deepEqual([first.status, first.usage, first.terminal, first.responseId, first.error], [429, null, null, null, null]);
    const second = JSON.parse(readFileSync(join(root, "case-error", "000002", "receipt.json"), "utf8"));
    assert.deepEqual([second.status, second.contentType, second.usage, second.terminal], [null, null, null, null]);
    assert.equal(second.error.message, "synthetic failure for [redacted] and [redacted]");
    for (const text of [reply, recorded(join(root, "case-error", "000002"))]) assert.equal(text.includes(UPSTREAM_CREDENTIAL) || text.includes(ROUTE_TOKEN), false);
    const analysis = analyzeOpenResponsesRecording(root).routes["case-error"]!;
    assert.deepEqual([analysis.interoperability.httpErrors, analysis.interoperability.transportErrors, analysis.conformance.unavailable, analysis.conformance.eventSchemaViolations], [1, 1, 2, null]);
  } finally {
    await recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recorder propagates client cancellation and preserves the partial stream", async () => {
  const root = mkdtempSync(join(tmpdir(), "ebo-or-cancel-"));
  let aborted = false;
  const recorder = createOpenResponsesRecorder({ root, upstreamCredential: UPSTREAM_CREDENTIAL, upstreamBaseUrl: "https://provider.invalid/v1", fetchImpl: async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"response.in_progress"}\n\n'));
      init!.signal!.addEventListener("abort", () => { aborted = true; controller.error(new Error("synthetic cancellation")); });
    },
  }), { headers: { "content-type": "text/event-stream" } }) });
  const token = recorder.register({ id: "case-cancel", endpoint: "responses" });
  assert.match(token, /^[0-9a-f]{64}$/u);
  const port = await recorder.listen();
  try {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/attempt/case-cancel/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "synthetic-model" }), signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await reader.cancel().catch(() => {});
    await recorder.drain();
    assert.equal(aborted, true);
    const directory = join(root, "case-cancel", "000001");
    assert.match(readFileSync(join(directory, "response.bin"), "utf8"), /response\.in_progress/u);
    const receipt = JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8"));
    assert.equal(receipt.terminal, null);
    assert.ok(receipt.error);
    assert.equal(recorded(directory).includes(token), false);
  } finally {
    await recorder.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI records without writing to stdout and analyzes into a new restricted file", async () => {
  const parent = mkdtempSync(join(tmpdir(), "ebo-or-cli-"));
  const root = join(parent, "recording");
  const upstream = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(textStream); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const stdout: string[] = [];
  const diagnostics: string[] = [];
  const stop = new AbortController();
  try {
    const env = { SYNTHETIC_UPSTREAM_KEY: UPSTREAM_CREDENTIAL, SYNTHETIC_ROUTE_KEY: ROUTE_TOKEN };
    const record = ["record", root, "case-cli", "--upstream", `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`, "--upstream-key-env", "SYNTHETIC_UPSTREAM_KEY", "--route-key-env", "SYNTHETIC_ROUTE_KEY", "--model", "synthetic-model"];
    const running = runOpenResponsesCommand(record, (text) => stdout.push(text), { env, signal: stop.signal, diagnostics: (text) => diagnostics.push(text) });
    const ready = join(root, "case-cli", "recorder.json");
    for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    const description = JSON.parse(readFileSync(ready, "utf8"));
    assert.deepEqual(description.credentialEnvironment, { upstream: "SYNTHETIC_UPSTREAM_KEY", route: "SYNTHETIC_ROUTE_KEY" });
    assert.deepEqual(description.route, { id: "case-cli", endpoint: "responses", model: "synthetic-model" });
    const response = await fetch(`${description.baseUrl}/responses`, { method: "POST", headers: { authorization: `Bearer ${ROUTE_TOKEN}` }, body: JSON.stringify({ model: "synthetic-model", store: false, input: "synthetic prompt" }) });
    assert.equal(await response.text(), textStream);
    stop.abort();
    assert.equal(await running, 0);
    assert.equal(stdout.join(""), "");
    assert.equal(diagnostics.join(""), `Open Responses recorder listening at ${description.baseUrl}\n`);
    assert.equal([readFileSync(ready, "utf8"), ...diagnostics].some((text) => text.includes(ROUTE_TOKEN) || text.includes(UPSTREAM_CREDENTIAL)), false);

    assert.equal(await runOpenResponsesCommand(record, (text) => stdout.push(text), { env, signal: stop.signal, diagnostics: (text) => diagnostics.push(text) }), 1);
    assert.match(diagnostics.at(-1)!, /already has a recording/u);
    assert.equal(await runOpenResponsesCommand([...record.slice(0, 2), "case-next", ...record.slice(3)], (text) => stdout.push(text), { env: {}, diagnostics: (text) => diagnostics.push(text) }), 1);
    assert.equal(diagnostics.at(-1), "Set SYNTHETIC_UPSTREAM_KEY and SYNTHETIC_ROUTE_KEY in the environment.\n");
    assert.equal(await runOpenResponsesCommand(["record", root, "case-next", "--upstream-key", UPSTREAM_CREDENTIAL], (text) => stdout.push(text), { diagnostics: (text) => diagnostics.push(text) }), 2);
    assert.equal(stdout.join(""), "");

    const outputPath = join(parent, "analysis.json");
    assert.equal(await main(["open-responses", "analyze", root, outputPath], (text) => stdout.push(text)), 0);
    assert.match(stdout.join(""), new RegExp(`^Analyzed 1 finished requests in 1 routes against Open Responses ${OPEN_RESPONSES_SPEC_VERSION} \\(bundled schema sha256:${OPEN_RESPONSES_SCHEMA_SHA256}\\)`, "u"));
    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(report.specification.version, OPEN_RESPONSES_SPEC_VERSION);
    assert.deepEqual([report.routes["case-cli"].conformance.checked, report.routes["case-cli"].conformance.eventSchemaViolations, report.routes["case-cli"].conformance.responseSchemaViolations], [1, 0, 0]);
    assert.equal(statSync(outputPath).mode & 0o077, 0);
    assert.equal(await main(["open-responses", "analyze", root, outputPath], (text) => stdout.push(text)), 1);
    assert.equal(await main(["open-responses", "analyze", root], (text) => stdout.push(text)), 2);
    assert.match(String(await Promise.resolve(main(["--help"], (text) => stdout.push(text)))) + stdout.join(""), /ebo open-responses analyze <recording-root> <output\.json>/u);
  } finally {
    stop.abort();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(parent, { recursive: true, force: true });
  }
});
