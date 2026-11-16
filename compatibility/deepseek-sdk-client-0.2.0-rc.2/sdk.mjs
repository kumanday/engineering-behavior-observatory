// node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js
import { randomUUID as randomUUID2 } from "node:crypto";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

// node_modules/@deepseek-ai/dsh-sdk-protocol/lib/index.js
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
var JsonRpcResponseError = class extends Error {
  code;
  data;
  /**
  * @param code - the wire error code, or `undefined` when the peer sent none.
  * @param message - the wire error message.
  * @param data - the optional structured error payload, verbatim.
  */
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = "JsonRpcResponseError";
  }
};
var JsonRpcLineTransport = class {
  input;
  output;
  buffer = "";
  decoder = new StringDecoder("utf8");
  started = false;
  requestHandler;
  notificationHandler;
  pending = /* @__PURE__ */ new Map();
  constructor(input, output) {
    this.input = input;
    this.output = output;
  }
  /** Attach the input listeners and begin reading frames. Idempotent. */
  start() {
    if (this.started) return;
    this.started = true;
    this.input.on("data", this.onData);
    this.input.on("error", this.onInputError);
    this.input.on("end", this.onInputEnd);
  }
  /**
  * Detach listeners and reject pending requests. Safe before {@link start}.
  */
  close() {
    this.input.off("data", this.onData);
    this.input.off("error", this.onInputError);
    this.input.off("end", this.onInputEnd);
    this.failPending(/* @__PURE__ */ new Error("JSON-RPC transport closed"));
  }
  /**
  * Install the request handler, replacing any prior handler.
  * @param handler - resolves to the response `result`; a rejection becomes a
  * `-32603` error response carrying the message.
  */
  onRequest(handler) {
    this.requestHandler = handler;
  }
  /**
  * Install the notification handler, replacing any prior handler.
  * @param handler - invoked per notification with the method and normalized
  * params object.
  */
  onNotification(handler) {
    this.notificationHandler = handler;
  }
  /**
  * Send a request and await its response.
  * @param method - the JSON-RPC method name.
  * @param params - the request parameters object.
  * @param signal - optional abandonment signal: aborting removes the pending
  * entry (no state is retained for a response that may never come) and
  * rejects with the signal's reason.
  * @returns the result; rejects per {@link JsonRpcTransportPeer.request}.
  */
  request(method, params, signal) {
    const id = `req_${randomUUID().replaceAll("-", "")}`;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };
    return new Promise((resolve2, reject) => {
      let detach = () => {
      };
      if (signal !== void 0) {
        if (signal.aborted) {
          reject(abortError(signal.reason));
          return;
        }
        const onAbort = () => {
          this.pending.delete(id);
          reject(abortError(signal.reason));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detach = () => {
          signal.removeEventListener("abort", onAbort);
        };
      }
      this.pending.set(id, {
        resolve: (value) => {
          detach();
          resolve2(value);
        },
        reject: (error) => {
          detach();
          reject(error);
        }
      });
      try {
        this.write(message);
      } catch (error) {
        this.pending.delete(id);
        detach();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  notify(method, params) {
    this.write(params === void 0 ? {
      jsonrpc: "2.0",
      method
    } : {
      jsonrpc: "2.0",
      method,
      params
    });
  }
  /**
  * Wait for prior frame write callbacks. The empty barrier emits no bytes.
  * @returns a promise that settles with the output write callback.
  */
  flush() {
    return new Promise((resolve2, reject) => {
      this.output.write("", (error) => {
        if (error) reject(error);
        else resolve2();
      });
    });
  }
  onData = (chunk) => {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.drainLines();
  };
  drainLines() {
    for (; ; ) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }
  onInputError = (error) => {
    this.failPending(error);
  };
  onInputEnd = () => {
    this.buffer += this.decoder.end();
    this.drainLines();
    this.failPending(/* @__PURE__ */ new Error("JSON-RPC input closed"));
  };
  async handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const frame = message;
    const id = frame.id;
    const method = frame.method;
    if ((typeof id === "string" || typeof id === "number") && typeof method === "string") {
      await this.handleIncomingRequest(id, method, objectParams(frame.params));
      return;
    }
    if (typeof id === "string" || typeof id === "number") {
      this.handleIncomingResponse(id, frame);
      return;
    }
    if (typeof method === "string") this.notificationHandler?.(method, objectParams(frame.params));
  }
  async handleIncomingRequest(id, method, params) {
    const handler = this.requestHandler;
    if (!handler) {
      this.writeError(id, -32601, `method not found: ${method}`);
      return;
    }
    try {
      const result = await handler(method, params);
      this.write({
        jsonrpc: "2.0",
        id,
        result
      });
    } catch (error) {
      this.writeError(id, -32603, error instanceof Error ? error.message : String(error));
    }
  }
  handleIncomingResponse(id, frame) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (frame.error && typeof frame.error === "object") {
      const error = frame.error;
      pending.reject(new JsonRpcResponseError(typeof error.code === "number" ? error.code : void 0, typeof error.message === "string" ? error.message : "JSON-RPC error", error.data));
      return;
    }
    pending.resolve(frame.result);
  }
  writeError(id, code, message) {
    this.write({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message
      }
    });
  }
  write(message) {
    this.output.write(`${JSON.stringify(message)}
`);
  }
  failPending(error) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of pending) waiter.reject(error);
  }
};
function objectParams(params) {
  return params && typeof params === "object" && !Array.isArray(params) ? params : {};
}
function abortError(reason) {
  return reason instanceof Error ? reason : /* @__PURE__ */ new Error(`JSON-RPC request aborted: ${String(reason)}`);
}

// node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
function exitsWithin(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve2) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve2(true);
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve2(false);
    }, ms).unref();
    child.once("exit", onExit);
  });
}
function forceTerminateWithin(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve2, reject) => {
    let accepted = false;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const settle = (complete) => {
      if (settled) return;
      settled = true;
      cleanup();
      complete();
    };
    const onExit = () => {
      settle(resolve2);
    };
    const onError = (error) => {
      settle(() => {
        reject(error);
      });
    };
    child.once("exit", onExit);
    child.once("error", onError);
    const timer = setTimeout(() => {
      const disposition = accepted ? "accepted" : "refused";
      settle(() => {
        reject(/* @__PURE__ */ new Error(`runtime process did not exit within ${ms}ms after SIGKILL was ${disposition}`));
      });
    }, ms).unref();
    try {
      accepted = child.kill("SIGKILL");
      if (child.exitCode !== null || child.signalCode !== null) settle(resolve2);
    } catch (error) {
      settle(() => {
        reject(new Error("SIGKILL failed", { cause: error }));
      });
    }
  });
}
async function disposeRuntimeProcess(child, graces, platform = process.platform) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.end();
  if (await exitsWithin(child, graces.disposeEofGraceMs)) return;
  if (platform !== "win32") {
    child.kill("SIGTERM");
    if (await exitsWithin(child, graces.disposeGraceMs)) return;
  }
  await forceTerminateWithin(child, graces.disposeGraceMs);
}
function manifest(url) {
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
}
function resolveDshBinFromManifests(dshManifestUrl, clientManifestUrl) {
  const dshManifest = manifest(dshManifestUrl);
  const clientManifest = manifest(clientManifestUrl);
  if (typeof dshManifest.version !== "string" || dshManifest.version !== clientManifest.version) throw new Error(`dsh SDK client ${String(clientManifest.version)} requires the same dsh version, got ${String(dshManifest.version)}`);
  const bin = typeof dshManifest.bin === "object" && dshManifest.bin !== null ? dshManifest.bin.dsh : dshManifest.bin;
  if (typeof bin !== "string" || bin === "") throw new Error("@deepseek-ai/dsh declares no dsh executable");
  return resolve(dirname(fileURLToPath(dshManifestUrl)), bin);
}
function resolveDshNodeLaunchFromManifests(dshManifestUrl, clientManifestUrl, sourceLoaderUrl) {
  const bin = resolveDshBinFromManifests(dshManifestUrl, clientManifestUrl);
  if (existsSync(bin)) return {
    nodeArgs: [bin],
    patches: [],
    environment: {}
  };
  const packageDir = dirname(fileURLToPath(dshManifestUrl));
  const sourceBin = resolve(packageDir, "src/bin.ts");
  const sourcePatch = resolve(packageDir, "src/sdk-source.cordis.patch.yml");
  const sourceTsconfig = resolve(packageDir, "tsconfig.json");
  if (!existsSync(sourceBin) || !existsSync(sourcePatch) || !existsSync(sourceTsconfig)) throw new Error(`@deepseek-ai/dsh is missing its built executable ${bin} and complete source launch files ${sourceBin}, ${sourcePatch}, ${sourceTsconfig}`);
  return {
    nodeArgs: [
      "--import",
      sourceLoaderUrl ?? import.meta.resolve("tsx/esm"),
      sourceBin
    ],
    patches: [sourcePatch],
    environment: { TSX_TSCONFIG_PATH: sourceTsconfig }
  };
}
function installedDshNodeLaunch() {
  return resolveDshNodeLaunchFromManifests(import.meta.resolve("@deepseek-ai/dsh/package.json"), new URL("../package.json", import.meta.url).href);
}
function resolveDshLaunch(options = {}, callerCwd = process.cwd()) {
  const profile = options.profile ?? "sdk";
  const dshLaunch = options.dshBin === void 0 ? installedDshNodeLaunch() : {
    nodeArgs: [resolve(callerCwd, options.dshBin)],
    patches: [],
    environment: {}
  };
  const patches = [...dshLaunch.patches, ...(options.patches ?? []).map((path) => resolve(callerCwd, path))];
  const dshHome = options.dshHome === void 0 ? void 0 : resolve(callerCwd, options.dshHome);
  return {
    command: process.execPath,
    args: [
      ...dshLaunch.nodeArgs,
      "--profile",
      profile,
      ...patches.flatMap((path) => ["--patch", path])
    ],
    ...options.processCwd === void 0 ? {} : { cwd: resolve(callerCwd, options.processCwd) },
    environment: () => ({
      ...options.env ?? process.env,
      ...dshLaunch.environment,
      ...dshHome === void 0 ? {} : { DSH_HOME: dshHome }
    }),
    description: `dsh profile ${JSON.stringify(profile)}`,
    initializeTimeoutMs: options.initializeTimeoutMs ?? 1e4,
    ...options.requestTimeoutMs === void 0 ? {} : { requestTimeoutMs: options.requestTimeoutMs },
    ...options.shutdownTimeoutMs === void 0 ? {} : { shutdownTimeoutMs: options.shutdownTimeoutMs },
    ...options.disposeEofGraceMs === void 0 ? {} : { disposeEofGraceMs: options.disposeEofGraceMs },
    ...options.disposeGraceMs === void 0 ? {} : { disposeGraceMs: options.disposeGraceMs }
  };
}
var STDERR_TAIL_LIMIT = 400;
var STREAM_SETTLE_MS = 100;
var TransportClosedError = class extends Error {
  /** @param message - the failure description, including any stderr tail. */
  constructor(message) {
    super(message);
    this.name = "TransportClosedError";
  }
};
var RequestTimeoutError = class extends Error {
  /** @param message - which method timed out. */
  constructor(message) {
    super(message);
    this.name = "RequestTimeoutError";
  }
};
var SdkProtocolError = class extends Error {
  /** @param message - the protocol violation description. */
  constructor(message) {
    super(message);
    this.name = "SdkProtocolError";
  }
};
var NotificationSubscriptionImpl = class {
  state;
  unsubscribe;
  constructor(state, unsubscribe) {
    this.state = state;
    this.unsubscribe = unsubscribe;
  }
  /**
  * Await the next matching notification.
  * @returns the notification; after the runtime died, drains what was
  * already delivered and then rejects; after {@link close}, rejects
  * immediately (the queue is dropped).
  */
  next() {
    const queued = this.state.queue.shift();
    if (queued !== void 0) return Promise.resolve(queued);
    if (this.state.failure !== void 0) return Promise.reject(this.state.failure);
    return new Promise((resolve2, reject) => {
      this.state.waiters.push({
        resolve: resolve2,
        reject
      });
    });
  }
  /**
  * Drain one already-delivered notification without waiting.
  * @returns the next queued notification, or `undefined` when none is queued.
  */
  tryNext() {
    return this.state.queue.shift();
  }
  /** Detach from the client; queued items drop and pending waiters reject. */
  close() {
    this.unsubscribe();
    this.state.queue.length = 0;
    this.fail(new TransportClosedError("notification subscription closed"));
  }
  /**
  * Reject pending and future waits (delivery stops; the first failure wins).
  * Already-queued notifications remain drainable via {@link next}/{@link tryNext}.
  * @param error - the terminal failure delivered to waiters.
  */
  fail(error) {
    this.state.failure ??= error;
    for (const waiter of this.state.waiters.splice(0)) waiter.reject(this.state.failure);
  }
  /**
  * Deliver one notification to a waiter or the queue when the filter
  * matches. A throwing filter fails only THIS subscription (detached, the
  * throw becomes its terminal error) — it never disturbs sibling
  * subscriptions or the transport's read loop.
  * @param notification - the wire notification to deliver.
  */
  push(notification) {
    let matches;
    try {
      matches = this.state.filter === void 0 || this.state.filter(notification);
    } catch (error) {
      this.unsubscribe();
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (!matches) return;
    const waiter = this.state.waiters.shift();
    if (waiter !== void 0) waiter.resolve(notification);
    else this.state.queue.push(notification);
  }
  /**
  * Iterate notifications until the subscription or runtime closes (the
  * terminating rejection propagates).
  * @returns an async iterator over {@link next} results.
  */
  async *[Symbol.asyncIterator]() {
    for (; ; ) yield await this.next();
  }
};
var HarnessClient = class {
  /** Original public dsh launch and timeout options for this client. */
  options;
  runtime;
  child;
  transport;
  stderrTail = [];
  subscriptions = /* @__PURE__ */ new Map();
  sessionParents = /* @__PURE__ */ new Map();
  subscriptionSerial = 0;
  exitCode;
  spawnError;
  streamsSettled = Promise.resolve();
  closeTask;
  constructor(options = {}, runtime) {
    this.options = options;
    this.runtime = runtime ?? resolveDshLaunch(options);
  }
  /**
  * Spawn the runtime subprocess and start reading frames. Idempotent while
  * the process is live; rejects reuse after {@link close}.
  */
  start() {
    if (this.closeTask !== void 0) throw new TransportClosedError("DeepSeek Harness runtime client is closed");
    if (this.child !== void 0) return;
    const child = spawn(this.runtime.command, this.runtime.args, {
      cwd: this.runtime.cwd,
      env: this.runtime.environment(),
      stdio: [
        "pipe",
        "pipe",
        "pipe"
      ]
    });
    this.child = child;
    child.once("error", (error) => {
      this.spawnError = error;
      this.transport?.close();
      this.failSubscriptions(this.closedError("DeepSeek Harness runtime failed to start"));
    });
    child.stdin.on("error", () => {
    });
    let stderrBuffer = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk;
      const newline = stderrBuffer.lastIndexOf("\n");
      if (newline >= 0) {
        this.appendStderr(stderrBuffer.slice(0, newline).split("\n"));
        stderrBuffer = stderrBuffer.slice(newline + 1);
      }
    });
    let signalStreamsSettled;
    this.streamsSettled = new Promise((resolve2) => {
      signalStreamsSettled = resolve2;
    });
    const settled = {
      stderr: false,
      exited: false
    };
    const maybeSettle = () => {
      if (settled.stderr && settled.exited) signalStreamsSettled();
    };
    child.stderr.once("close", () => {
      if (stderrBuffer.length > 0) this.appendStderr([stderrBuffer]);
      settled.stderr = true;
      maybeSettle();
    });
    child.once("exit", (code) => {
      this.exitCode = code;
      settled.exited = true;
      maybeSettle();
      this.failSubscriptions(this.closedError("DeepSeek Harness runtime exited"));
    });
    child.once("close", () => {
      this.transport?.close();
    });
    const transport = new JsonRpcLineTransport(child.stdout, child.stdin);
    transport.onNotification((method, params) => {
      this.dispatchNotification({
        method,
        params
      });
    });
    transport.start();
    this.transport = transport;
  }
  /**
  * Perform the process-wide handshake.
  * @param params - workspace cwd plus the provider/model route.
  * @returns the runtime's wire identity.
  */
  async initialize(params) {
    const result = await this.request("initialize", { ...params }, this.runtime.initializeTimeoutMs);
    if (!isRecord(result) || !isRecord(result.serverInfo) || typeof result.serverInfo.name !== "string" || typeof result.serverInfo.version !== "string") throw new SdkProtocolError(`initialize returned no server identity: ${JSON.stringify(result)}`);
    return { serverInfo: {
      name: result.serverInfo.name,
      version: result.serverInfo.version
    } };
  }
  /**
  * Queue one prompt and return its durable inbox identity.
  * @param sessionId - target session; an unknown id creates it.
  * @param contentBlocks - the user message, sent verbatim.
  * @returns the queued message id.
  */
  async prompt(sessionId, contentBlocks) {
    const params = {
      sessionId,
      contentBlocks
    };
    const result = await this.request("session/prompt", { ...params });
    if (!isRecord(result) || typeof result.messageId !== "string") throw new SdkProtocolError(`session/prompt returned no message id: ${JSON.stringify(result)}`);
    return result.messageId;
  }
  /**
  * Send one JSON-RPC request and await its result.
  * @param method - the wire method name.
  * @param params - the params object; omitted params send `{}`.
  * @param timeoutMs - per-call override of {@link HarnessClientOptions.requestTimeoutMs}.
  * @returns the raw result; rejects with {@link JsonRpcResponseError} on a
  * protocol error response, {@link RequestTimeoutError} on timeout, and
  * {@link TransportClosedError} when the runtime is gone.
  */
  async request(method, params, timeoutMs) {
    this.start();
    if (this.exitCode !== void 0 || this.spawnError !== void 0) {
      await this.settleStreams();
      throw this.closedError("DeepSeek Harness runtime is not running");
    }
    const transport = this.transport;
    if (transport === void 0) throw new TransportClosedError("DeepSeek Harness runtime is not running");
    const timeout = timeoutMs ?? this.runtime.requestTimeoutMs;
    try {
      if (timeout === void 0) return await transport.request(method, params ?? {});
      const abandon = new AbortController();
      const timer = setTimeout(() => {
        const stderr = this.stderrTail.length === 0 ? "" : `; stderr tail:
${this.stderrTail.join("\n")}`;
        abandon.abort(new RequestTimeoutError(`${method} timed out after ${timeout}ms waiting for ${this.runtime.description}${stderr}`));
      }, timeout);
      try {
        return await transport.request(method, params ?? {}, abandon.signal);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      if (error instanceof JsonRpcResponseError || error instanceof RequestTimeoutError) throw error;
      await this.settleStreams();
      throw this.closedError(errorMessage(error));
    }
  }
  /**
  * Subscribe to server notifications.
  * @param filter - optional predicate; omitted means every notification.
  * @returns the subscription handle; close it to stop delivery. After
  * {@link close} or runtime death the handle is born failed — there is no
  * producer left, so `next()` rejects instead of waiting forever.
  */
  subscribe(filter) {
    const id = String(this.subscriptionSerial++);
    const subscription = new NotificationSubscriptionImpl({
      queue: [],
      waiters: [],
      filter,
      failure: void 0
    }, () => {
      this.subscriptions.delete(id);
    });
    if (this.closeTask !== void 0 || this.exitCode !== void 0 || this.spawnError !== void 0) {
      subscription.fail(this.closedError("DeepSeek Harness runtime closed"));
      return subscription;
    }
    this.subscriptions.set(id, subscription);
    return subscription;
  }
  /**
  * Subscribe to one session and the descendants discovered from
  * `subagent.started` lineage edges. The runtime notifies for every session
  * in its context, so this client applies the scope.
  * @param sessionId - the root session id.
  * @returns the filtered subscription handle.
  */
  subscribeSessionTree(sessionId) {
    return this.subscribe((notification) => {
      const params = notification.params;
      if (notification.method === "subagent.started" || notification.method === "subagent.finished") {
        const parentId = params.parentSessionId;
        if (typeof parentId === "string" && this.isDescendantOf(parentId, sessionId)) return true;
        return params.childSessionId === sessionId;
      }
      const relatedId = params.sessionId;
      return typeof relatedId === "string" && this.isDescendantOf(relatedId, sessionId);
    });
  }
  /**
  * Shut the runtime down and reap it: a best-effort protocol `shutdown`
  * bounded by `shutdownTimeoutMs`, then the shared stdin-EOF → SIGTERM →
  * SIGKILL ladder until the process actually exited. Idempotent.
  * @returns settlement of the complete teardown.
  */
  close() {
    this.closeTask ??= this.performClose();
    return this.closeTask;
  }
  async performClose() {
    const child = this.child;
    if (child === void 0) return;
    try {
      await this.request("shutdown", void 0, this.runtime.shutdownTimeoutMs ?? 1e3);
    } catch (error) {
      this.appendStderr([`shutdown request failed: ${errorMessage(error)}`]);
    }
    await disposeRuntimeProcess(child, {
      disposeEofGraceMs: this.runtime.disposeEofGraceMs ?? 6e3,
      disposeGraceMs: this.runtime.disposeGraceMs ?? 3e3
    });
    this.transport?.close();
    this.failSubscriptions(this.closedError("DeepSeek Harness runtime closed"));
  }
  dispatchNotification(notification) {
    this.recordSessionRelationship(notification);
    for (const subscription of this.subscriptions.values()) subscription.push(notification);
  }
  recordSessionRelationship(notification) {
    if (notification.method !== "subagent.started") return;
    const parentId = notification.params.parentSessionId;
    const childId = notification.params.childSessionId;
    if (typeof parentId === "string" && parentId !== "" && typeof childId === "string" && childId !== "" && parentId !== childId) this.sessionParents.set(childId, parentId);
  }
  isDescendantOf(sessionId, rootSessionId) {
    const visited = /* @__PURE__ */ new Set();
    let current = sessionId;
    while (!visited.has(current)) {
      if (current === rootSessionId) return true;
      visited.add(current);
      const parent = this.sessionParents.get(current);
      if (parent === void 0) return false;
      current = parent;
    }
    return false;
  }
  failSubscriptions(error) {
    for (const subscription of this.subscriptions.values()) subscription.fail(error);
  }
  appendStderr(lines) {
    const kept = lines.filter((line) => line.length > 0);
    this.stderrTail.push(...kept);
    if (this.stderrTail.length > STDERR_TAIL_LIMIT) this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LIMIT);
  }
  settleStreams() {
    return Promise.race([this.streamsSettled, new Promise((resolve2) => {
      setTimeout(resolve2, STREAM_SETTLE_MS);
    })]);
  }
  closedError(reason) {
    const parts = [`${this.runtime.description}: ${reason}`];
    if (this.spawnError !== void 0) parts.push(`spawn error: ${this.spawnError.message}`);
    if (this.exitCode !== void 0) parts.push(`exit code: ${String(this.exitCode)}`);
    if (this.stderrTail.length > 0) parts.push(`stderr tail:
${this.stderrTail.join("\n")}`);
    return new TransportClosedError(parts.join("\n"));
  }
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
var DeepSeekHarness = class {
  clientInstance;
  createClient;
  cwd;
  provider;
  model;
  reasoningEffort;
  maxTokens;
  initialized;
  closed = false;
  constructor(options = {}, clientFactory) {
    this.createClient = clientFactory ?? (() => new HarnessClient(options));
    this.clientInstance = this.createClient();
    this.cwd = resolve(options.cwd ?? options.processCwd ?? process.cwd());
    this.provider = options.provider ?? "deepseek-official";
    this.model = options.model ?? "deepseek-v4-flash";
    this.reasoningEffort = options.reasoningEffort;
    this.maxTokens = options.maxTokens;
  }
  /**
  * The underlying JSON-RPC client (exposed for low-level access). A failed
  * handshake swaps in a fresh instance only after cleanup proves the runtime
  * exited; cleanup failure retains this client, so do not cache it across a
  * failed {@link start}.
  * @returns the client currently owning the runtime subprocess.
  */
  get client() {
    return this.clientInstance;
  }
  /**
  * Start the subprocess and perform the `initialize` handshake once. On
  * failure, successful SDK-owned cleanup reaps the runtime and installs a
  * fresh client (`HarnessClient.close` is permanent), so a later call retries
  * with a new subprocess unless {@link close} already ended this harness. If
  * cleanup also fails, rejects with an `AggregateError` whose ordered errors
  * preserve both causes and retains the failed client rather than spawning
  * alongside a process whose exit was not proved.
  * @returns settlement of the (memoized) handshake.
  */
  start() {
    this.initialized ??= (async () => {
      try {
        this.clientInstance.start();
        await this.clientInstance.initialize({
          cwd: this.cwd,
          provider: this.provider,
          model: this.model,
          ...this.reasoningEffort === void 0 ? {} : { reasoningEffort: this.reasoningEffort },
          ...this.maxTokens === void 0 ? {} : { maxTokens: this.maxTokens }
        });
      } catch (error) {
        this.initialized = void 0;
        try {
          await this.clientInstance.close();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "DeepSeek Harness initialization and cleanup failed");
        }
        if (!this.closed) this.clientInstance = this.createClient();
        throw error;
      }
    })();
    return this.initialized;
  }
  /**
  * Open a session handle (no wire traffic; the runtime creates the session
  * on its first prompt).
  * @param sessionId - explicit id to reuse; omitted mints a fresh one.
  * @returns the session handle.
  */
  session(sessionId) {
    return new HarnessSession(this, sessionId ?? `session-${randomUUID2().replaceAll("-", "")}`);
  }
  /**
  * Run one prompt on a fresh (or named) session.
  * @param input - prompt text, or content blocks sent verbatim.
  * @param options - optional session id and per-notification observer.
  * @returns the owned activity interval.
  */
  run(input, options) {
    return this.session(options?.sessionId).run(input, options);
  }
  /**
  * Shut down and reap the runtime subprocess. Idempotent and terminal —
  * a closed harness no longer retries a failed handshake.
  * @returns settlement of the complete teardown.
  */
  close() {
    this.closed = true;
    return this.clientInstance.close();
  }
  /**
  * `await using` support: {@link close}.
  * @returns settlement of the teardown.
  */
  [Symbol.asyncDispose]() {
    return this.close();
  }
};
var HarnessSession = class {
  harness;
  id;
  /**
  * @param harness - the owning harness (supplies the client and handshake).
  * @param id - the wire session id this handle runs on.
  */
  constructor(harness, id) {
    this.harness = harness;
    this.id = id;
  }
  /**
  * Queue one prompt, then observe the whole session through its next idle.
  * @param input - prompt text, or content blocks sent verbatim.
  * @param options - optional per-notification observer.
  * @returns the owned activity interval; rejects on transport loss, timeout,
  * or a protocol error.
  */
  async run(input, options) {
    await this.harness.start();
    const client = this.harness.client;
    const contentBlocks = normalizeInput(input);
    const events = [];
    const notifications = [];
    const subscription = client.subscribeSessionTree(this.id);
    const collect = (notification) => {
      if (notification.method === "session.event" && notification.params.sessionId === this.id) {
        const event = validatedSessionEvent(notification.params.event);
        notifications.push(notification);
        options?.onNotification?.(notification);
        events.push(event);
        return;
      }
      notifications.push(notification);
      options?.onNotification?.(notification);
    };
    try {
      const messageId = await client.prompt(this.id, contentBlocks);
      let received = false;
      while (true) {
        const notification = await subscription.next();
        if (!received) {
          if (notification.method !== "session.event" || notification.params.sessionId !== this.id || !isInboxReceipt(notification.params.event, messageId)) continue;
          received = true;
        }
        collect(notification);
        if (notification.method === "session.status" && notification.params.sessionId === this.id && notification.params.status === "idle") break;
      }
    } finally {
      subscription.close();
    }
    return {
      sessionId: this.id,
      finalResponse: finalResponse(events),
      events,
      notifications
    };
  }
};
function normalizeInput(input) {
  return typeof input === "string" ? [{
    type: "text",
    text: input
  }] : input;
}
function validatedTurnEndReason(value) {
  if (!isRecord(value) || typeof value.kind !== "string") throw new SdkProtocolError(`turn/end carried no reason envelope: ${JSON.stringify(value)}`);
  if (value.kind === "aborted") {
    if (!isRecord(value.reason) || typeof value.reason.kind !== "string") throw new SdkProtocolError(`turn/end carried a malformed aborted reason: ${JSON.stringify(value)}`);
    switch (value.reason.kind) {
      case "user":
      case "parent":
      case "disposed":
      case "legacy":
        break;
      case "hook":
        if (typeof value.reason.reason !== "string") throw new SdkProtocolError(`turn/end carried a malformed hook abort reason: ${JSON.stringify(value)}`);
        break;
      default:
        throw new SdkProtocolError(`turn/end carried an unknown abort reason: ${JSON.stringify(value)}`);
    }
  }
  return value;
}
function validatedSessionEvent(value) {
  if (!isRecord(value) || typeof value.type !== "string") throw new SdkProtocolError(`session.event carried no event envelope: ${JSON.stringify(value)}`);
  if (value.type === "assistant/message") {
    const message = isRecord(value.data) ? value.data.message : void 0;
    const content = isRecord(message) ? message.content : void 0;
    if (!Array.isArray(content) || !content.every((block) => isRecord(block) && typeof block.type === "string")) throw new SdkProtocolError(`assistant/message event carried malformed content: ${JSON.stringify(value)}`);
  }
  if (value.type === "turn/end") {
    const data = isRecord(value.data) ? value.data : void 0;
    if (data === void 0) throw new SdkProtocolError(`turn/end event carried malformed data: ${JSON.stringify(value)}`);
    validatedTurnEndReason(data.reason);
  }
  return value;
}
function isInboxReceipt(value, messageId) {
  if (!isRecord(value) || value.type !== "agent/inbox/spliced" || !isRecord(value.data)) return false;
  const inserted = value.data.inserted;
  return Array.isArray(inserted) && inserted.some((message) => isRecord(message) && message.id === messageId);
}
function finalResponse(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type !== "assistant/message") continue;
    return event.data.message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
  }
  return "";
}
export {
  DeepSeekHarness,
  HarnessClient,
  HarnessSession,
  JsonRpcResponseError,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError
};
