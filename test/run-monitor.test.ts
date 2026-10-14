import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRunMonitor, serveRunMonitor } from "../src/run-monitor.js";

const iso = (ms: number) => new Date(ms).toISOString();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ebo-run-monitor-"));
  const now = Date.now();
  const bundle = (attempt: string, run: string, terminal: object, qualification: string) => {
    const dir = join(root, "attempts", attempt, "runs", run, attempt);
    mkdirSync(join(dir, "capture"), { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      schemaVersion: "run-bundle/v1", run: { id: run, harness: { id: "pi-sdk", version: "0.87.1" } }, attempt: { id: attempt, number: 1 }, terminal,
      evidence: [{ kind: "capture-report", path: "capture/report-0000.json" }, { kind: "capture-report", path: "capture/report-0001.json" }],
    }));
    writeFileSync(join(dir, "capture", "report-0000.json"), JSON.stringify({ qualification: "incomplete" }));
    writeFileSync(join(dir, "capture", "report-0001.json"), JSON.stringify({ qualification }));
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ apiKey: "sk-secret-never-shown" }));
    return dir;
  };
  const running = bundle("run-a", "run-1", { state: "interrupted", failureClass: "infrastructure" }, "incomplete");
  bundle("probe-a", "run-0", { state: "completed", failureClass: "none", stopReason: "none" }, "qualified");
  writeFileSync(join(running, "pi-events.jsonl"), [
    { nativeType: "event", payload: { type: "turn_start" } },
    { nativeType: "event", payload: { type: "tool_execution_start", args: { command: "cat secret.txt" } } },
    { nativeType: "event", payload: { type: "tool_execution_end", result: "SECRET-CONTENT" } },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n{\"partial\":");
  const usage = (n: number, cost: number) => JSON.stringify({ requestNumber: n, at: iso(now - 60_000 + n * 1000), cost, usage: { prompt_tokens: 1000 * n, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 * n }, completion_tokens_details: { reasoning_tokens: 2 } } }) + "\n";
  writeFileSync(join(root, "attempts", "run-a", "usage.jsonl"), usage(1, 0.5) + usage(2, 0.25));
  const status = (runState: string) => ({
    format: "ebo.campaign-status/v1",
    campaign: { id: "fixture-campaign", state: "running", stage: "pilot", startedAt: iso(now - 600_000), deadline: iso(now + 3_600_000), updatedAt: iso(now) },
    limits: { maxConcurrent: 2, wallClockPerAttemptMs: 7_200_000, budgetPerAttemptUsd: 100 }, account: { provider: "OpenRouter", creditAtStartUsd: 50 },
    models: ["meta/model-a"],
    attempts: [
      { id: "probe-a", model: "meta/model-a", harness: "pi-sdk", replicate: 0, probe: true, state: "finished", passed: true, exitCode: 0, startedAt: iso(now - 700_000), endedAt: iso(now - 690_000), runBundles: "attempts/probe-a/runs", spend: { chargedUsd: 0.02, requests: 3 } },
      { id: "run-a", model: "meta/model-a", harness: "pi-sdk", replicate: 1, state: runState, startedAt: iso(now - 300_000), ...(runState === "running" ? {} : { endedAt: iso(now), exitCode: 0 }), budgetUsd: 100, maxWallClockMs: 7_200_000, runBundles: "attempts/run-a/runs", requestLog: "attempts/run-a/usage.jsonl", spend: { chargedUsd: 0.75, reservedUsd: 5, requests: 2, accountingErrors: 0, budgetStopped: false, lastResponseAt: iso(now - 180_000) } },
      { id: "run-b", model: "meta/model-a", harness: "codex-app-server", replicate: 1, state: "pending", budgetUsd: 100 },
    ],
  });
  const statusPath = join(root, "campaign-status.json");
  writeFileSync(statusPath, JSON.stringify(status("running")));
  return { root, statusPath, running, rewrite: (state: string) => writeFileSync(statusPath, JSON.stringify(status(state))) };
}

test("the run monitor combines campaign status with run bundles into an allowlisted snapshot", () => {
  const { root, statusPath, running, rewrite } = fixture();
  try {
    const monitor = createRunMonitor(statusPath);
    const first = monitor.snapshot();
    assert.equal(first.format, "ebo.monitor-snapshot/v1");
    assert.equal(first.campaign, "fixture-campaign");
    assert.deepEqual([first.totals.chargedUsd, first.totals.reservedUsd, first.totals.probeChargedUsd, first.totals.requests], [0.75, 5, 0.02, 2]);
    assert.deepEqual([first.totals.running, first.totals.pending, first.totals.finished], [1, 1, 0]);

    const a = first.attempts.find((x) => x.id === "run-a")!;
    assert.equal(a.quiet, true, "a running attempt without a response for over two minutes is quiet");
    assert.equal(a.terminal, null, "a running attempt's provisional manifest terminal is not shown");
    assert.equal(a.qualification, "incomplete", "the latest capture report wins");
    assert.equal(a.harnessVersion, "0.87.1");
    assert.equal(a.directory, "attempts/run-a/runs");
    assert.deepEqual(a.tokens, { prompt: 3000, completion: 20, cached: 2400, reasoning: 4 });
    assert.equal(a.requests.length, 2);
    assert.deepEqual([a.native.lines, a.native.toolCalls], [3, 1], "a partial trailing line is not counted yet");
    assert.ok(a.native.types.some(([t]) => t === "tool_execution_start"));
    assert.equal(first.attempts.find((x) => x.id === "run-b")!.native.toolCalls, null, "no native evidence is unknown, not zero");
    assert.equal(first.probes[0]!.qualification, "qualified");
    assert.deepEqual(first.probes[0]!.terminal, { state: "completed", failureClass: "none", stopReason: "none" });

    const text = JSON.stringify(first);
    for (const leaked of ["sk-secret-never-shown", "SECRET-CONTENT", "cat secret.txt", root]) assert.ok(!text.includes(leaked), `snapshot must not contain ${leaked}`);

    appendFileSync(join(running, "pi-events.jsonl"), "\"x\"}\n" + JSON.stringify({ payload: { type: "tool_execution_start" } }) + "\n");
    rewrite("finished");
    const second = monitor.snapshot();
    const b = second.attempts.find((x) => x.id === "run-a")!;
    assert.deepEqual([b.native.lines, b.native.toolCalls], [5, 2], "streams are tailed incrementally, completing the partial line");
    assert.deepEqual(b.terminal, { state: "interrupted", failureClass: "infrastructure", stopReason: null }, "the manifest terminal is shown once the attempt ended");
    assert.deepEqual(second.transitions.map((t) => [t.id, t.from, t.to]), [["run-a", "running", "finished"]]);

    writeFileSync(statusPath, JSON.stringify({ format: "something-else" }));
    assert.throws(() => monitor.snapshot(), /ebo\.campaign-status\/v1/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the run monitor server is loopback-only, serves no campaign files and streams snapshots", async () => {
  const { root, statusPath } = fixture();
  try {
    await assert.rejects(serveRunMonitor(join(root, "missing.json"), 0), /campaign-status/u);
    const server = await serveRunMonitor(statusPath, 0, 250);
    try {
      const { port } = server.address() as AddressInfo;
      const get = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, init);
      const page = await get("/");
      assert.equal(page.status, 200);
      assert.match(await page.text(), /EBO Run Monitor/u);
      assert.equal((await get("/monitor.js")).status, 200);
      const snap = await (await get("/snapshot.json")).json() as { format: string };
      assert.equal(snap.format, "ebo.monitor-snapshot/v1");
      for (const path of ["/campaign-status.json", "/attempts/run-a/usage.jsonl", "/../package.json", "/attempts/run-a/runs/run-1/run-a/auth.json"]) assert.equal((await get(path)).status, 404, path);
      assert.equal((await get("/", { headers: { origin: "https://example.com" } })).status, 403);
      assert.equal((await get("/snapshot.json", { method: "POST" })).status, 405);
      const controller = new AbortController();
      const events = await get("/events", { signal: controller.signal });
      assert.match(events.headers.get("content-type") ?? "", /text\/event-stream/u);
      const reader = events.body!.getReader();
      const chunk = new TextDecoder().decode((await reader.read()).value);
      assert.match(chunk, /^retry: 3000\ndata: \{"format":"ebo\.monitor-snapshot\/v1"/u);
      controller.abort();
    } finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
