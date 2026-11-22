import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digestMetadata } from "../src/artifacts.js";
import { describeAndValidatePiDataset, qualifyRetainedPiArtifacts, type PiNativeRecord } from "../src/pi.js";

const sessionId = "pi-stream-fixture";
const receivedAt = "2026-10-25T00:00:00.000Z";
const files = [["pi-session", "pi-session.jsonl"], ["pi-events", "pi-events.jsonl"], ["pi-observer", "pi-observer.jsonl"]] as const;
const envelope = (sequence: number, channel: string, nativeType: string, payload: unknown): PiNativeRecord => ({
  schemaVersion: "ebo.pi-native-record/v1", sequence, channel, nativeType, sessionId, receivedAt, payload,
});
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ebo-pi-stream-"));
  const history = [
    { type: "session", version: 3, id: sessionId, cwd: "/workspace" },
    { type: "message", id: "call", parentId: null, timestamp: receivedAt,
      message: { role: "assistant", timestamp: 1, stopReason: "toolUse", content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "echo ok" } }] } },
    { type: "message", id: "result", parentId: "call", timestamp: receivedAt,
      message: { role: "toolResult", timestamp: 2, toolCallId: "tool-1", toolName: "bash", content: [{ type: "text", text: "ok" }] } },
    { type: "message", id: "final", parentId: "result", timestamp: receivedAt,
      message: { role: "assistant", timestamp: 3, responseId: "response-1", stopReason: "stop", content: [{ type: "text", text: "done" }] } },
  ];
  const stream = [
    envelope(1, "stream", "agent_start", {}),
    envelope(2, "stream", "tool_execution_start", { toolCallId: "tool-1", toolName: "bash", args: { command: "echo ok" } }),
    envelope(3, "stream", "tool_execution_end", { toolCallId: "tool-1", toolName: "bash", isError: false }),
    envelope(4, "stream", "agent_settled", { aborted: false }),
  ];
  const observer = [envelope(1, "observer", "before_provider_request", { sessionId, payload: { text: "ñ".repeat(40_000) } })];
  for (const [index, data] of [history, stream, observer].entries()) {
    writeFileSync(join(root, files[index]![1]), data.map((record) => JSON.stringify(record)).join("\n") + "\n");
  }
  return root;
}
function capture(root: string) {
  return { runId: "run-pi-stream", attemptId: "attempt-pi-stream", qualification: "qualified" as const,
    records: files.flatMap(([artifactId, path]) => readFileSync(join(root, path), "utf8").trim().split("\n").map((line, index) => ({
      reference: { artifactId, recordLocator: `line:${index + 1}` }, record: JSON.parse(line) as PiNativeRecord,
    }))) };
}

test("streamed Pi qualification matches complete-record datasets and raw canonical digests", async () => {
  const root = fixture();
  try {
    const expected = await describeAndValidatePiDataset(capture(root));
    const actual = await qualifyRetainedPiArtifacts(root, "run-pi-stream", "attempt-pi-stream", sessionId, true);
    assert.deepEqual(actual.dataset, expected.dataset);
    assert.deepEqual(actual.coverage, expected.coverage);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a Pi tool result's structured exit code reaches the tool event", async () => {
  const root = fixture();
  try {
    const path = join(root, "pi-events.jsonl");
    const records = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    records[2].payload = { toolCallId: "tool-1", toolName: "bash", isError: true,
      result: { content: [{ type: "text", text: "Command exited with code 3" }], structuredContent: { output: "", exit_code: 3 } } };
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const { dataset } = await describeAndValidatePiDataset(capture(root));
    const end = dataset.events.find(({ source }) => source.nativeType === "stream:tool_execution_end")!;
    assert.equal(end.attributes.exitCode, 3);
    assert.equal(end.attributes.isError, true);
    const start = dataset.events.find(({ source }) => source.nativeType === "stream:tool_execution_start")!;
    assert.equal("exitCode" in start.attributes, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi source validation streams traces above 128 MiB and retains full-record digests", async () => {
  const root = fixture();
  try {
    let last: PiNativeRecord | undefined;
    const padding = "retained-private-provider-payload-" + "x".repeat(1024 * 1024);
    for (let index = 2; index <= 131; index++) {
      last = envelope(index, "observer", "before_provider_request", { sessionId, payload: { padding } });
      appendFileSync(join(root, "pi-observer.jsonl"), JSON.stringify(last) + "\n");
    }
    assert.ok(statSync(join(root, "pi-observer.jsonl")).size > 128 * 1024 * 1024);
    const result = await qualifyRetainedPiArtifacts(root, "run-pi-stream", "attempt-pi-stream", sessionId, true);
    assert.equal(result.coverage.records.total, 139);
    assert.equal(result.dataset.nativeRecords.at(-1)!.digest, `sha256:${digestMetadata(last).value}`);
    assert.ok(JSON.stringify(result.dataset).length < 1024 * 1024, "Validation retains projection metadata rather than provider payloads");
    appendFileSync(join(root, "pi-observer.jsonl"), '{"schemaVersion":"ebo.pi-native-record/v1","sequence":132,"sequence":132}\n');
    await assert.rejects(qualifyRetainedPiArtifacts(root, "run-pi-stream", "attempt-pi-stream", sessionId, true), /duplicate JSON object keys/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("streamed Pi validation preserves settled, tool identity and observer session checks", async () => {
  const root = fixture();
  try {
    const path = join(root, "pi-events.jsonl");
    const records = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    records[3].payload.aborted = true;
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await assert.rejects(qualifyRetainedPiArtifacts(root, "run-pi-stream", "attempt-pi-stream", sessionId, true), /settled terminal/);
    records[3].payload.aborted = false;
    records[2].payload.toolCallId = "foreign-tool";
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await assert.rejects(qualifyRetainedPiArtifacts(root, "run-pi-stream", "attempt-pi-stream", sessionId, true), /tool identities/);
    records[2].payload.toolCallId = "tool-1";
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(join(root, "pi-observer.jsonl"), JSON.stringify(envelope(1, "observer", "before_provider_request", { sessionId: "foreign-session" })) + "\n");
    await assert.rejects(qualifyRetainedPiArtifacts(root, "run-pi-stream", "attempt-pi-stream", sessionId, true), /stream identity/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
