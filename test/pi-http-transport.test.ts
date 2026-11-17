import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPiGzipFetch } from "../src/pi-http-transport.js";

test("compressed Pi transport preserves large native bytes, request headers, query and response stream", async () => {
  const base = "https://recorder.invalid/attempt/native/v1";
  const body = ` { "model": "test-model", "input": ${JSON.stringify("café\n".repeat(2_300_000))} } `;
  const expected = Buffer.from(body);
  assert.ok(expected.byteLength > 10 * 1024 * 1024);
  const controller = new AbortController();
  let calls = 0;
  const raw = "data: {\"type\":\"response.completed\"}\n\n";
  const transport = createPiGzipFetch(base, async (input, init) => {
    calls++;
    const r = new Request(input, init);
    assert.equal(r.url, base + "/responses?beta=true");
    assert.equal(r.headers.get("authorization"), "Bearer scoped-attempt-token");
    assert.equal(r.headers.get("x-session-affinity"), "native-session");
    assert.equal(r.headers.get("content-encoding"), "gzip");
    assert.equal(r.headers.get("content-length"), null);
    assert.equal(r.headers.get("x-ebo-native-body-bytes"), String(expected.byteLength));
    assert.equal(r.headers.get("x-ebo-native-body-sha256"), createHash("sha256").update(expected).digest("hex"));
    const encoded = Buffer.from(await r.arrayBuffer());
    assert.ok(encoded.byteLength < 10 * 1024 * 1024);
    assert.deepEqual(gunzipSync(encoded), expected);
    assert.equal(r.signal.aborted, false);
    return new Response(raw, { headers: { "content-type": "text/event-stream", "x-request-id": "response-1" } });
  });
  const response = await transport(base + "/responses?beta=true", {
    method: "POST", body, signal: controller.signal,
    headers: { authorization: "Bearer scoped-attempt-token", "content-length": String(expected.byteLength), "x-session-affinity": "native-session" },
  });
  assert.equal(response.headers.get("x-request-id"), "response-1");
  assert.equal(await response.text(), raw);
  assert.equal(calls, 1);
});

test("compressed Pi transport fails closed on route escape, unsupported encoding and cancellation without retry", async () => {
  let calls = 0;
  const transport = createPiGzipFetch("https://recorder.invalid/attempt/native/v1", async () => { calls++; return new Response(); });
  const options = { method: "POST", body: "{}" };
  await assert.rejects(transport("https://other.invalid/attempt/native/v1/messages", options), /escaped/);
  await assert.rejects(transport("https://recorder.invalid/attempt/native/v10/messages", options), /escaped/);
  await assert.rejects(transport("https://recorder.invalid/attempt/native/v1/messages", { ...options, headers: { "content-encoding": "gzip" } }), /already/);
  await assert.rejects(transport("https://recorder.invalid/attempt/native/v1/messages", { ...options, signal: AbortSignal.abort() }));
  assert.equal(calls, 0);
});

test("pinned Pi native providers pass compressed fetch through each campaign API", async () => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "ebo-compression-sdk-"));
  try {
    for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
      const runtime = await ModelRuntime.create({ authPath: join(root, api + ".json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
      const baseUrl = "https://recorder.invalid/attempt/native/v1";
      const config = { name: "fixture", baseUrl, apiKey: "fixture-key", api, models: [{ id: "fixture-model", name: "fixture-model", api, reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 128 }] };
      runtime.registerProvider("fixture-provider", config);
      const nativeProvider = runtime.getProvider("fixture-provider")!;
      let calls = 0;
      let nativeSize = 0;
      const transport = createPiGzipFetch(baseUrl, async (input, init) => {
        calls++;
        const request = new Request(input, init);
        assert.equal(request.headers.get("content-encoding"), "gzip");
        const original = gunzipSync(Buffer.from(await request.arrayBuffer()));
        nativeSize = original.byteLength;
        const payload = JSON.parse(original.toString());
        assert.equal(payload.model, "fixture-model");
        assert.ok(nativeSize > 10 * 1024 * 1024);
        return new Response('{"error":{"message":"fixture transport reached"}}', { status: 400, headers: { "content-type": "application/json" } });
      });
      runtime.registerProvider("fixture-provider", { ...config, streamSimple: (model, context, options) => nativeProvider.streamSimple(model, context, { ...options, fetch: transport }) });
      const model = runtime.getModel("fixture-provider", "fixture-model")!;
      const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "abc".repeat(3_600_000), timestamp: 1 }] }, { apiKey: "fixture-key", maxRetries: 0 });
      assert.equal(result.stopReason, "error");
      assert.match(result.errorMessage!, /fixture transport reached/);
      assert.equal(calls, 1, api);
      assert.ok(nativeSize > 10 * 1024 * 1024);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
