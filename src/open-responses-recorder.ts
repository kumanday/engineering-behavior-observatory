import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import type { OpenResponsesEndpoint } from "./open-responses.js";

/**
 * Recording proxy for Responses-style traffic. An agent addresses an attempt route with a route token;
 * the recorder holds the provider credential, forwards the native request bytes, and retains the request
 * body, the exact response bytes, and a receipt. Header values, credentials, and tokens are never written;
 * receipts list header names only. The module writes nothing to stdout or stderr.
 */
export const OPEN_RESPONSES_RECEIPT_FORMAT = "ebo.open-responses-recorder-receipt/v1";

const ROUTE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const ROUTE_PATH = /^\/attempt\/([a-z0-9][a-z0-9-]{0,63})\/v1\/(responses|chat\/completions)$/u;
/** Never forwarded: hop-by-hop fields, client credentials, and encoding fields the recorder resolves itself. */
const WITHHELD_HEADERS = [
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
  "content-length", "authorization", "x-api-key", "api-key", "cookie",
  "content-encoding", "accept-encoding", "x-ebo-native-body-bytes", "x-ebo-native-body-sha256",
];
const decompress = promisify(gunzip);

export type OpenResponsesRecorderOptions = {
  /** Directory that receives one subdirectory per route. */
  root: string;
  /** Provider base URL without credentials, for example `https://provider.invalid/v1`. */
  upstreamBaseUrl: string;
  /** Provider credential, sent upstream as a bearer token and never written. */
  upstreamCredential: string;
  fetchImpl?: typeof fetch;
};

export type OpenResponsesRoute = {
  id: string;
  endpoint: OpenResponsesEndpoint;
  /** When set, a request naming another model is rejected before it is forwarded. */
  model?: string;
  /** Bearer token the agent presents. Generated when omitted. */
  token?: string;
};

export type OpenResponsesRecorder = {
  server: Server;
  /** Declare a new route and return its token. An existing route directory is never reused. */
  register(route: OpenResponsesRoute): string;
  listen(port?: number, host?: string): Promise<number>;
  /** Wait for in-flight requests to write their receipts. */
  drain(): Promise<void>;
  close(): Promise<void>;
};

type RouteState = { endpoint: OpenResponsesEndpoint; model: string | undefined; tokenDigest: Buffer; requests: number };

export function createOpenResponsesRecorder(options: OpenResponsesRecorderOptions): OpenResponsesRecorder {
  const upstream = new URL(options.upstreamBaseUrl);
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username !== "" || upstream.password !== "" || upstream.search !== "" || upstream.hash !== "") {
    throw new Error("Recorder upstream must be an http(s) base URL without credentials, query, or fragment.");
  }
  if (options.upstreamCredential === "") throw new Error("Recorder upstream credential must be nonempty.");
  const upstreamBase = upstream.href.replace(/\/$/u, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const routes = new Map<string, RouteState>();
  const secrets: string[] = [options.upstreamCredential];
  const pending = new Set<Promise<void>>();
  const redact = (text: string): string => secrets.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);

  const server = createServer((request, response) => {
    const work = handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      if (!response.destroyed) response.end(JSON.stringify({ error: { message: redact(error instanceof Error ? error.message : "Recorder failure.") } }));
    });
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  server.requestTimeout = 0;
  server.timeout = 0;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reject = (status: number, message?: string): void => {
      response.writeHead(status, message === undefined ? {} : { "content-type": "application/json" });
      response.end(message === undefined ? undefined : JSON.stringify({ error: { message } }));
    };
    const match = ROUTE_PATH.exec(request.url ?? "");
    const route = match === null ? undefined : routes.get(match[1]!);
    const presented = createHash("sha256").update(String(request.headers.authorization ?? "").replace(/^Bearer /u, "")).digest();
    if (match === null || route === undefined || !timingSafeEqual(presented, route.tokenDigest)) return reject(401);
    const endpoint = match[2] as OpenResponsesEndpoint;
    if (request.method !== "POST" || endpoint !== route.endpoint) return reject(404);

    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const received = Buffer.concat(chunks);
    const contentEncoding = request.headers["content-encoding"]?.toLowerCase() ?? null;
    let native: Buffer;
    if (contentEncoding === null || contentEncoding === "identity") native = received;
    else if (contentEncoding === "gzip") {
      try { native = await decompress(received); } catch { return reject(400, "Request body is not valid gzip."); }
    } else return reject(415, "Request content encoding is unsupported.");
    const sha256 = createHash("sha256").update(native).digest("hex");
    const declaredBytes = request.headers["x-ebo-native-body-bytes"];
    const declaredDigest = request.headers["x-ebo-native-body-sha256"];
    if (declaredBytes !== undefined && declaredBytes !== String(native.byteLength) || declaredDigest !== undefined && declaredDigest !== sha256) {
      return reject(400, "Request body differs from its declared native size or digest.");
    }
    let body: unknown;
    try { body = JSON.parse(native.toString("utf8")); } catch { return reject(400, "Request body is not JSON."); }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return reject(400, "Request body is not a JSON object.");
    if (route.model !== undefined && (body as { model?: unknown }).model !== route.model) return reject(400, "Request model differs from the declared route model.");

    const number = ++route.requests;
    const directory = join(options.root, match[1]!, String(number).padStart(6, "0"));
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(join(directory, "request.json"), native, { flag: "wx", mode: 0o600 });

    const withheld = new Set(WITHHELD_HEADERS);
    for (const name of String(request.headers.connection ?? "").split(",")) if (name.trim() !== "") withheld.add(name.trim().toLowerCase());
    const forwarded = Object.fromEntries(Object.entries(request.headers).flatMap(([name, value]) =>
      withheld.has(name) || value === undefined ? [] : [[name, Array.isArray(value) ? value.join(", ") : value] as const]));
    const forwardedHeaderNames = [...Object.keys(forwarded), "authorization", "content-type"].filter((name, index, names) => names.indexOf(name) === index).sort();

    const startedAt = new Date().toISOString();
    const controller = new AbortController();
    const cancel = (): void => { if (!response.writableEnded) controller.abort(); };
    response.on("close", cancel);
    const file = createWriteStream(join(directory, "response.bin"), { flags: "wx", mode: 0o600 });
    const responseDigest = createHash("sha256");
    let responseBytes = 0;
    let status: number | null = null;
    let contentType: string | null = null;
    let usage: unknown = null;
    let responseId: string | null = null;
    let terminal: string | null = null;
    let error: { name: string; message: string } | null = null;
    const decoder = new TextDecoder();
    let buffer = "";
    // Receipt facts are a convenience index; `response.bin` stays authoritative for every line.
    const inspect = (line: string): void => {
      if (!line.startsWith("data:")) return;
      let event: unknown;
      try { event = JSON.parse(line.slice(5)); } catch { return; }
      if (typeof event !== "object" || event === null) return;
      const record = event as Record<string, unknown>;
      const candidate = typeof record.response === "object" && record.response !== null ? record.response as Record<string, unknown> : record;
      if (typeof candidate.id === "string") responseId = candidate.id;
      if (typeof candidate.usage === "object" && candidate.usage !== null) usage = candidate.usage;
      if (typeof record.type === "string" && ["response.completed", "response.failed", "response.incomplete"].includes(record.type)) terminal = record.type;
      if (Array.isArray(record.choices)) {
        for (const choice of record.choices) {
          const reason = typeof choice === "object" && choice !== null ? (choice as { finish_reason?: unknown }).finish_reason : undefined;
          if (typeof reason === "string") terminal = reason;
        }
      }
    };
    try {
      const result = await fetchImpl(`${upstreamBase}/${endpoint}`, {
        method: "POST",
        headers: { ...forwarded, authorization: `Bearer ${options.upstreamCredential}`, "content-type": "application/json" },
        body: new Uint8Array(native),
        signal: controller.signal,
      });
      status = result.status;
      contentType = result.headers.get("content-type");
      response.writeHead(status, { "content-type": contentType ?? "application/octet-stream" });
      if (result.body !== null) {
        for await (const chunk of result.body) {
          responseDigest.update(chunk);
          responseBytes += chunk.byteLength;
          if (!file.write(chunk)) await new Promise<void>((resolve, fail) => { file.once("drain", resolve); file.once("error", fail); });
          buffer += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n")) >= 0) { inspect(buffer.slice(0, end).replace(/\r$/u, "")); buffer = buffer.slice(end + 1); }
          if (!response.destroyed && !response.write(chunk)) await new Promise<void>((resolve) => { response.once("drain", resolve); response.once("close", resolve); });
        }
      }
      buffer += decoder.decode();
      inspect(buffer);
      if (!response.destroyed) response.end();
    } catch (failure) {
      error = { name: failure instanceof Error ? failure.name : "Error", message: redact(failure instanceof Error ? failure.message : "Upstream request failed.") };
      if (!response.headersSent) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error }));
      } else if (!response.destroyed) response.destroy();
    } finally {
      response.off("close", cancel);
      await new Promise<void>((resolve, fail) => { file.once("error", fail); file.end(resolve); });
      writeFileSync(join(directory, "receipt.json"), `${JSON.stringify({
        schemaVersion: OPEN_RESPONSES_RECEIPT_FORMAT, number, endpoint, model: route.model ?? null, status, contentType,
        request: { bytes: native.byteLength, sha256, contentEncoding: contentEncoding === "gzip" ? "gzip" : null },
        response: { bytes: responseBytes, sha256: responseDigest.digest("hex") },
        requestHeaderNames: Object.keys(request.headers).sort(), forwardedHeaderNames,
        startedAt, endedAt: new Date().toISOString(), usage, responseId, terminal, error,
      }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
  }

  return {
    server,
    register(route) {
      if (!ROUTE_ID.test(route.id) || routes.has(route.id)) throw new Error("Recorder route identity must be new and path-safe.");
      const bearer = route.token ?? randomBytes(32).toString("hex");
      if (bearer === "" || bearer === options.upstreamCredential) throw new Error("Recorder route token must be nonempty and differ from the upstream credential.");
      if (existsSync(join(options.root, route.id))) throw new Error(`Recorder route "${route.id}" already has a recording; use a new route identity.`);
      mkdirSync(options.root, { recursive: true, mode: 0o700 });
      mkdirSync(join(options.root, route.id), { mode: 0o700 });
      secrets.push(bearer);
      routes.set(route.id, { endpoint: route.endpoint, model: route.model, tokenDigest: createHash("sha256").update(bearer).digest(), requests: 0 });
      return bearer;
    },
    async listen(port = 0, host = "127.0.0.1") {
      await new Promise<void>((resolve, fail) => { server.once("error", fail); server.listen(port, host, resolve); });
      return (server.address() as AddressInfo).port;
    },
    async drain() { await Promise.all([...pending]); },
    async close() {
      await Promise.all([...pending]);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
