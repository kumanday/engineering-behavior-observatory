import assert from "node:assert/strict";
import test from "node:test";
import { digestMetadata, validateArtifact } from "../src/artifacts.js";
import { createAgentSdkNativeEvidenceResolver, type AgentSdkNativeRecord } from "../src/agent-sdk-normalizer.js";
import { createCapturedNativeEvidenceResolver, describeNormalizedDataset } from "../src/normalization-integrity.js";
import { createSourceEvidenceResolverV2, listNativeV2Profiles, projectNativeEvidenceV2 } from "../src/native-v2.js";
import { datasetV2Digest, precedes } from "../src/normalization-v2.js";
import type { RetainedBehaviorEvidence } from "../src/retained-evidence.js";
import { UNIFORM_EVENT_FAMILIES, type AdapterCapabilityProfile, type NormalizationInput, type UniformEvent } from "../src/uniform-events.js";
const hash = (value: unknown): `sha256:${string}` => `sha256:${digestMetadata(value).value}`;
const unknown = { status: "unknown", reason: "UNREPORTED" } as const;
type Spec = { record: number; family: UniformEvent["family"]; phase?: UniformEvent["phase"]; id?: string; pointer?: string; role?: string; attributes?: UniformEvent["attributes"]; domain?: string };
function fixture(harness: string, documents: unknown[], specs: Spec[], owner?: { threadId: string; turnId: string }): RetainedBehaviorEvidence {
  const capture: NormalizationInput<unknown> = { runId: "run", attemptId: "attempt", qualification: "qualified-with-gaps",
    records: documents.map((record, index) => ({ record: harness === "claude-agent-sdk" ? { kind: "session", document: record } : record,
      reference: { artifactId: "native", recordLocator: `line:${index + 1}` } })) };
  Object.assign(capture, owner);
  const nativeType = new Map(capture.records.map(({ record }, index) => [record, `native-${index}`]));
  const profile: AdapterCapabilityProfile = { schemaVersion: "ebo.adapter-capability-profile/v1", adapterId: "fixture", harness,
    nativeTypes: [...nativeType.values()], families: Object.fromEntries(UNIFORM_EVENT_FAMILIES.map((family) => [family, { status: "available" }])) as AdapterCapabilityProfile["families"],
    evidence: { nativeOrder: { status: "available" }, nativeTime: { status: "partial" }, parentage: { status: "partial" }, content: { status: "available" } } };
  const events: UniformEvent[] = specs.map((spec, index) => ({ schemaVersion: "ebo.uniform-event/v1", id: spec.id ?? `event-${index}`,
    runId: capture.runId, attemptId: capture.attemptId, source: { harness, nativeType: `native-${spec.record}`, nativeReference: capture.records[spec.record]!.reference },
    family: spec.family, phase: spec.phase ?? "instant", nativeOrder: { status: "known", value: spec.record, domain: spec.domain ?? "native-stream" },
    nativeTime: unknown, actor: { kind: "harness" }, scope: { kind: "attempt", id: capture.attemptId }, relations: { parent: unknown, known: [] },
    attributes: spec.attributes ?? {}, content: spec.pointer ? { status: "known", value: [{ nativeReference: { ...capture.records[spec.record]!.reference,
      recordLocator: `line:${spec.record + 1}#${spec.pointer}` }, ...(spec.role ? { role: spec.role } : {}) }] } : unknown }));
  const dataset = describeNormalizedDataset({ capture, normalization: { events, unmapped: capture.records.filter((_, index) => !specs.some((spec) => spec.record === index))
    .map(({ reference }) => ({ reference, reason: "Retained control record" })) }, capabilityProfile: profile, adapterVersion: "fixture-v1", nativeType: (record) => nativeType.get(record)! });
  return { capture, dataset, resolver: harness === "claude-agent-sdk" ? createAgentSdkNativeEvidenceResolver(capture as NormalizationInput<AgentSdkNativeRecord>) : createCapturedNativeEvidenceResolver(capture),
    coverage: {} as RetainedBehaviorEvidence["coverage"], outcomeCapture: { ...capture, records: [] } };
}
const project = (evidence: RetainedBehaviorEvidence) => projectNativeEvidenceV2(evidence, { manifestDigest: hash("manifest"), harnessVersion: "fixture-pin" });
const piRecord = (type: string, id: string, message?: object, parentId?: string) => ({ type, id, ...(message ? { message } : {}), ...(parentId ? { parentId } : {}), timestamp: "2026-11-07T00:00:00.000Z" });
const stream = (sequence: number, type: string, payload: object) => ({ schemaVersion: "ebo.pi-native-record/v1", sequence, sessionId: "s", channel: "stream", nativeType: type, payload, receivedAt: "2026-11-07T00:00:01.000Z" });

test("native v2 registers all eight current producers and creates separate deterministic derivations", async () => {
  assert.equal(listNativeV2Profiles().length, 8);
  const evidence = fixture("pi-sdk", [piRecord("session", "s"), piRecord("message", "m", { role: "assistant", content: [] })], [{ record: 1, family: "message", phase: "after" }]);
  const original = hash(evidence.dataset), first = await project(evidence), second = await project(evidence);
  assert.equal(hash(evidence.dataset), original); assert.notEqual(datasetV2Digest(first.dataset), original);
  assert.equal(datasetV2Digest(first.dataset), datasetV2Digest(second.dataset));
  assert.equal(first.dataset.recordCoverage.length, evidence.capture.records.length);
  assert.equal(first.dataset.sources[0]!.executedHarness.version.status, "known");
  assert.deepEqual(validateArtifact("v2", first.dataset), []);
});
test("v2 citations hash the pointed JSON value for both JSONL and document records", async () => {
  const resolver = createSourceEvidenceResolverV2({ runId: "r", attemptId: "a", records: [
    { reference: { artifactId: "jsonl", recordLocator: "line:1" }, record: { content: { text: "one" } } },
    { reference: { artifactId: "json", recordLocator: "#" }, record: { steps: [{ text: "one" }] } },
  ], fallback: { resolve: () => ({ runId: "other", attemptId: "a", digest: hash("one") }) } });
  for (const reference of [{ artifactId: "jsonl", recordLocator: "line:1#/content/text" }, { artifactId: "json", recordLocator: "#/steps/0/text" }]) {
    assert.deepEqual(await resolver.resolve(reference), { runId: "r", attemptId: "a", digest: hash("one") }); assert.equal(resolver.read(reference), "one");
  }
  assert.equal(await resolver.resolve({ artifactId: "jsonl", recordLocator: "line:1#/missing" }), false);
  assert.equal(await resolver.resolve({ artifactId: "external", recordLocator: "#" }), false);
  assert.throws(() => createSourceEvidenceResolverV2({ runId: "r", attemptId: "a", records: [
    { reference: { artifactId: "json", recordLocator: "#" }, record: { nested: 1 } },
    { reference: { artifactId: "json", recordLocator: "#/nested" }, record: 2 },
  ] }), /conflicts/u);
});
test("Pi joins stream/history copies, preserves pending calls and keeps one issuing inference for sibling calls", async () => {
  const evidence = fixture("pi-sdk", [piRecord("session", "s"), piRecord("message", "m1", { role: "assistant", responseId: "provider-response",
    content: [{ type: "toolCall", id: "one", name: "bash", arguments: { command: "false" } }, { type: "toolCall", id: "pending", name: "bash", arguments: {} }] }),
    piRecord("message", "m2", { role: "toolResult", toolCallId: "one", toolName: "bash", isError: true, content: [] }, "m1"),
    stream(1, "tool_execution_start", { toolCallId: "one", toolName: "bash", args: { command: "false" } }),
    stream(2, "tool_execution_end", { toolCallId: "one", toolName: "bash", isError: true })], [
      { record: 1, family: "message", phase: "after" }, { record: 2, family: "message", phase: "after" },
      { record: 3, family: "tool", phase: "before", domain: "pi-stream" }, { record: 4, family: "tool", phase: "after", domain: "pi-stream" },
    ]);
  const { dataset } = await project(evidence), completed = dataset.operations.find(({ identity }) => identity.nativeId === "one")!, pending = dataset.operations.find(({ identity }) => identity.nativeId === "pending")!;
  assert.equal(dataset.operations.length, 2); assert.equal(completed.callEventIds.length, 2); assert.equal(completed.resultEventIds.length, 2);
  assert.deepEqual(completed.failure, { status: "known", value: true }); assert.equal(pending.failure.status, "unknown");
  assert.equal(pending.resultEventIds.length, 0); assert.deepEqual(completed.issuingInference, pending.issuingInference);
  const message = dataset.events.find(({ family }) => family === "message")!; assert.equal(message.facts.inference!.nativeRequestId.status, "unknown");
  assert.equal(precedes({ ...message, nativeOrder: completed.startOrder }, { ...message, nativeOrder: pending.startOrder }), "same-observation");
});
test("Pi scopes reused IDs to the issuing message on each recorded branch", async () => {
  const docs = [piRecord("session", "s"), piRecord("message", "a", { role: "assistant", content: [{ type: "toolCall", id: "same", name: "bash", arguments: {} }] }),
    piRecord("message", "ar", { role: "toolResult", toolCallId: "same", isError: false }, "a"),
    piRecord("message", "b", { role: "assistant", content: [{ type: "toolCall", id: "same", name: "bash", arguments: {} }] }),
    piRecord("message", "br", { role: "toolResult", toolCallId: "same", isError: true }, "b")];
  const { dataset } = await project(fixture("pi-sdk", docs, docs.slice(1).map((_, index) => ({ record: index + 1, family: "message", phase: "after" }))));
  assert.equal(dataset.operations.length, 2); assert.equal(new Set(dataset.operations.map(({ identity }) => identity.scope)).size, 2);
  assert.deepEqual(dataset.operations.map(({ failure }) => failure.status === "known" ? failure.value : null).sort(), [false, true]);
});
test("Codex retains owned pending starts while excluding foreign starts and completions", async () => {
  const record = (sequence: number, threadId: string, method: string, item: object) => ({ sequence, kind: "notification", source: "codex-app-server", method,
    observedAt: "2026-11-07T00:00:00.000Z", payload: { threadId, turnId: "turn", item } });
  const docs = [record(1, "one", "item/started", { id: "same", type: "commandExecution", command: "false" }),
    record(2, "two", "item/started", { id: "same", type: "commandExecution", command: "true" }),
    record(3, "one", "item/completed", { id: "same", type: "commandExecution", exitCode: 1, completedAtMs: 1794000000000 }),
    record(4, "two", "item/completed", { id: "same", type: "commandExecution", exitCode: 0 }),
    record(5, "one", "item/started", { id: "pending", type: "commandExecution", command: "pwd" })];
  const { dataset } = await project(fixture("codex-app-server", docs, [{ record: 2, family: "tool", phase: "after" }], { threadId: "one", turnId: "turn" }));
  assert.equal(dataset.operations.length, 2); assert.equal(dataset.operations.filter(({ resultEventIds }) => !resultEventIds.length).length, 1);
  assert.ok(dataset.operations.every(({ identity }) => identity.scope === "thread:one/turn:turn"));
  assert.equal(dataset.recordCoverage.filter(({ reference, eventIds }) => ["line:2", "line:4"].includes(reference.recordLocator) && eventIds.length === 0).length, 2);
  const completed = dataset.operations.find(({ resultEventIds }) => resultEventIds.length)!, event = dataset.events.find(({ id }) => id === completed.resultEventIds[0])!;
  assert.deepEqual(completed.failure, { status: "known", value: true }); assert.equal(event.clock.status === "known" && event.clock.value.kind, "producer-observation");
});
test("Factory retains unknown result status and separates inclusive turn totals from session snapshots", async () => {
  const frame = (sequence: number, sessionId: string, notification: object) => ({ sequence, kind: "frame", observedAt: "2026-11-07T00:00:00Z",
    payload: { method: "droid.session_notification", params: { sessionId, notification } } });
  const docs = [frame(1, "root", { type: "tool_call", toolUse: { id: "id", name: "shell", input: {} } }),
    frame(2, "root", { type: "tool_result", toolUseId: "id" }), frame(3, "child", { type: "tool_call", toolUse: { id: "id", name: "shell", input: {} } }),
    frame(4, "root", { type: "session_token_usage_changed", tokenUsage: { inputTokens: 5 } }),
    frame(5, "root", { type: "agent_turn_completed", tokenUsage: { inputTokens: 10 } })];
  const { dataset } = await project(fixture("factory-droid", docs, [{ record: 0, family: "tool", phase: "before" }, { record: 1, family: "tool", phase: "after" },
    { record: 2, family: "tool", phase: "before" }, { record: 3, family: "context" }, { record: 4, family: "outcome", phase: "after" }, { record: 4, family: "runtime", phase: "after" }]));
  assert.equal(dataset.operations.length, 2); assert.ok(dataset.operations.every(({ failure }) => failure.status === "unknown"));
  const resource = dataset.events.flatMap(({ facts }) => facts.resource ?? []);
  assert.deepEqual(resource.map(({ scope }) => scope).sort(), ["child-inclusive", "session"]);
  assert.ok(dataset.events.every(({ clock }) => clock.status !== "known" || clock.value.kind === "receipt"));
});
test("Cursor missing status remains an observation and collector order cannot establish behavior", async () => {
  const record = (sequence: number, message: object) => ({ schemaVersion: "ebo.cursor-native-record/v1", sequence, receivedAt: "2026-11-07T00:00:00Z",
    channel: "stream", agentId: "agent", sessionId: "session", runId: "native-run", payload: { message } });
  const { dataset } = await project(fixture("cursor-sdk", [record(1, { type: "tool_call", call_id: "one", name: "shell" }),
    record(2, { type: "tool_call", call_id: "two", name: "shell", status: "completed", result: { status: "success" } })],
    [{ record: 0, family: "tool", phase: "after" }, { record: 1, family: "tool", phase: "after" }]));
  const pending = dataset.operations.find(({ identity }) => identity.nativeId === "one")!;
  assert.equal(pending.resultEventIds.length, 0); assert.equal(pending.observationEventIds!.length, 1); assert.equal(pending.failure.status, "unknown");
  assert.ok(dataset.events.every(({ nativeOrder }) => nativeOrder.status === "unknown"));
});
test("Claude native message/hook copies join one scoped operation without counting batch callbacks as calls", async () => {
  const session = { nativeType: "assistant", sessionId: "session", capturedAt: "2026-11-07T00:00:00Z", message: { type: "assistant", session_id: "session",
    message: { id: "output", content: [{ type: "tool_use", id: "call", name: "bash", input: { command: "pwd" } }] } } };
  const hook = { hook: "PreToolUse", callbackAt: "2026-11-07T00:00:00Z", nativePayload: { session_id: "session", tool_use_id: "call", tool_name: "bash" } };
  const batch = { hook: "PostToolBatch", callbackAt: "2026-11-07T00:00:01Z", nativePayload: { tool_calls: [{ tool_use_id: "call" }] } };
  const permission = { hook: "PermissionRequest", nativePayload: { session_id: "session", tool_use_id: "call" } };
  const { dataset } = await project(fixture("claude-agent-sdk", [session, hook, batch, permission], [
    { record: 0, family: "tool", phase: "before", pointer: "/message/message/content/0", role: "tool-input", domain: "sdk" },
    { record: 1, family: "tool", phase: "before", domain: "hooks" }, { record: 2, family: "tool", phase: "after", domain: "hooks" },
    { record: 3, family: "permission", phase: "before", domain: "hooks" },
  ]));
  assert.equal(dataset.operations.length, 1); assert.equal(dataset.operations[0]!.callEventIds.length, 2); assert.equal(dataset.operations[0]!.failure.status, "unknown");
  assert.equal(dataset.events[2]!.family, "runtime"); assert.equal(dataset.events[1]!.clock.status === "known" && dataset.events[1]!.clock.value.kind, "producer-observation");
  assert.equal(dataset.events[3]!.scope.id, dataset.operations[0]!.id);
});
test("OpenHands action relations bind results with missing call IDs and preserve unreported failure", async () => {
  const record = (sequence: number, session_id: string, payload: object) => ({ sequence, session_id, channel: "rest-event", channelSequence: sequence, payload });
  const docs = [record(1, "one", { id: "action", kind: "ActionEvent", tool_call_id: "call-one", tool_name: "terminal", action: {} }),
    record(2, "two", { id: "action", kind: "ActionEvent", tool_call_id: "call-two", tool_name: "terminal", action: {} }),
    record(3, "one", { id: "result", kind: "ObservationEvent", action_id: "action", observation: { output: "done" } })];
  const { dataset } = await project(fixture("openhands-agent-server", docs, [{ record: 0, family: "tool", phase: "before" },
    { record: 1, family: "tool", phase: "before" }, { record: 2, family: "tool", phase: "after" }]));
  assert.equal(dataset.operations.length, 2); const completed = dataset.operations.find(({ resultEventIds }) => resultEventIds.length)!;
  assert.equal(completed.identity.nativeId, "call-one"); assert.equal(completed.failure.status, "unknown");
});
test("DeepSeek separates multi-call results and retains nonzero exit failure despite a successful tool envelope", async () => {
  const record = (sequence: number, type: string, data: object) => ({ schemaVersion: "ebo.deepseek-native-observation/v1", sequence, method: "session.event", kind: "notification",
    observedAt: "2026-11-07T00:00:00Z", payload: { sessionId: "s", event: { seq: sequence, type, time: 1794000000000, data: { turn: 0, step: 1, ...data } } } });
  const docs = [record(1, "tool/call", { callId: "one", name: "bash", arguments: {} }), record(2, "tool/call", { callId: "two", name: "bash", arguments: {} }),
    record(3, "tool/result", { message: { content: [{ type: "tool_result", toolCallId: "one", isError: false, content: [{ text: "bad\n[exit code: 1]" }] },
      { type: "tool_result", toolCallId: "two", isError: false, content: [{ text: "ok\n[exit code: 0]" }] }] } })];
  const { dataset } = await project(fixture("deepseek-harness", docs, [{ record: 0, family: "tool" }, { record: 1, family: "tool" }, { record: 2, family: "tool", phase: "after" }]));
  assert.equal(dataset.operations.length, 2); assert.deepEqual(dataset.operations.find(({ identity }) => identity.nativeId === "one")!.failure, { status: "known", value: true });
  assert.deepEqual(dataset.operations.find(({ identity }) => identity.nativeId === "two")!.failure, { status: "known", value: false });
  assert.ok(dataset.operations.every(({ callEventIds, resultEventIds }) => callEventIds.length === 1 && resultEventIds.length === 1));
});
test("Devin retains a prior terminal exit update and keeps message chunks partial", async () => {
  const record = (sequence: number, update: object) => ({ sequence, method: "session/update", kind: "notification", source: "devin-cli", observedAt: "2026-11-07T00:00:00Z", payload: { sessionId: "s", update } });
  const docs = [record(1, { sessionUpdate: "tool_call", toolCallId: "call", rawInput: {} }),
    record(2, { sessionUpdate: "tool_call_update", toolCallId: "call", _meta: { terminal_exit: { exit_code: 2 } } }),
    record(3, { sessionUpdate: "tool_call_update", toolCallId: "call", status: "completed" }), record(4, { sessionUpdate: "agent_message_chunk", content: { text: "partial" } })];
  const { dataset } = await project(fixture("devin-cli", docs, [{ record: 0, family: "tool", phase: "before" }, { record: 2, family: "tool", phase: "after" }, { record: 3, family: "message" }]));
  assert.deepEqual(dataset.operations[0]!.failure, { status: "known", value: true }); assert.equal(dataset.events[2]!.facts.message!.completeness.status === "known" && dataset.events[2]!.facts.message!.completeness.value, "partial");
});
test("v2 origin and source gates reject imported evidence and unsupported producers", async () => {
  const evidence = fixture("unregistered", [{}], []); await assert.rejects(project(evidence), /Unsupported/u);
  const imported = fixture("pi-sdk", [], []); imported.capture = { ...imported.capture, qualification: "imported" };
  await assert.rejects(project(imported), /owned qualified/u);
});
test("Claude JSON hook documents resolve canonical tool pointers from the document root", async () => {
  const evidence = fixture("claude-agent-sdk", [{ hook: "PreToolUse", nativePayload: { session_id: "session", tool_use_id: "call", tool_name: "Read", tool_input: { path: "source.ts" } } }],
    [{ record: 0, family: "tool", phase: "before" }]);
  evidence.capture.records[0]!.reference.recordLocator = "#";
  evidence.dataset.nativeRecords[0]!.reference.recordLocator = "#";
  evidence.dataset.events[0]!.source.nativeReference.recordLocator = "#";
  evidence.resolver = createAgentSdkNativeEvidenceResolver(evidence.capture as NormalizationInput<AgentSdkNativeRecord>);
  const projected = await project(evidence), reference = projected.dataset.events[0]!.content;
  assert.equal(reference.status, "known");
  if (reference.status === "known") {
    assert.equal(reference.value[0]!.nativeReference.recordLocator, "#/nativePayload/tool_input");
    assert.deepEqual(await projected.resolver.resolve(reference.value[0]!.nativeReference), { runId: "run", attemptId: "attempt", digest: hash({ path: "source.ts" }) });
  }
});
test("Claude tool summaries retain aggregate evidence without creating an extra operation", async () => {
  const { dataset } = await project(fixture("claude-agent-sdk", [{ nativeType: "tool_use_summary", message: { type: "tool_use_summary", summary: "Two tools completed.", preceding_tool_use_ids: ["one", "two"] } }],
    [{ record: 0, family: "tool", phase: "after" }]));
  assert.equal(dataset.operations.length, 0); assert.equal(dataset.events[0]!.family, "runtime");
});
test("DeepSeek marks interrupted assistant output partial and retains explicit child completion status", async () => {
  const docs = [{ sequence: 1, kind: "notification", method: "session.event", payload: { sessionId: "root", event: { type: "assistant/message", seq: 1, data: { interrupted: true, message: { id: "message", content: [{ type: "text", text: "delivered prefix" }] } } } } },
    { sequence: 2, kind: "notification", method: "subagent.started", payload: { parentSessionId: "root", childSessionId: "child" } },
    { sequence: 3, kind: "notification", method: "subagent.finished", payload: { parentSessionId: "root", childSessionId: "child", status: "error" } }];
  const { dataset } = await project(fixture("deepseek-harness", docs, [{ record: 0, family: "message" }, { record: 1, family: "delegation" }, { record: 2, family: "delegation" }]));
  assert.deepEqual(dataset.events[0]!.facts.message!.completeness, { status: "known", value: "partial" });
  assert.deepEqual(dataset.operations[0]!.failure, { status: "known", value: true });
  assert.deepEqual(dataset.events[2]!.facts.operation!.failure, { status: "known", value: true });
  docs[2]!.payload.status = "ok";
  assert.deepEqual((await project(fixture("deepseek-harness", docs, [{ record: 0, family: "message" }, { record: 1, family: "delegation" }, { record: 2, family: "delegation" }]))).dataset.operations[0]!.failure, { status: "known", value: false });
});
test("missing logical identities and non-result endpoints keep explicit unavailable facts", async () => {
  const { dataset } = await project(fixture("cursor-sdk", [{ schemaVersion: "ebo.cursor-native-record/v1", sequence: 1, channel: "stream", payload: { message: { type: "tool_call", status: "running" } } }],
    [{ record: 0, family: "tool", phase: "before" }]));
  assert.equal(dataset.operations[0]!.scope.status, "unknown");
  assert.equal(dataset.events[0]!.facts.operation!.failure.status, "unknown");
});
test("supplemental outcome documents cannot create native operations or alter native branch bindings", async () => {
  const pi = fixture("pi-sdk", [piRecord("session", "s"), piRecord("message", "message", { role: "assistant", content: [{ type: "toolCall", id: "call", name: "bash", arguments: {} }] })],
    [{ record: 1, family: "message", phase: "after" }]);
  if (pi.outcomeCapture.qualification !== "imported") pi.outcomeCapture.records = [{ reference: { artifactId: "verifier", recordLocator: "#" },
    record: { kind: "verifier", document: { type: "message", id: "spoofed", parentId: null, message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "spoofed" }] } } } }];
  const actual = await project(pi); assert.equal(actual.dataset.operations.length, 1);
  assert.equal(actual.dataset.operations[0]!.startOrder.status, "known");
  const codex = fixture("codex-app-server", [{ sequence: 1, kind: "response", method: "initialize", source: "codex-app-server", payload: {} }], []);
  if (codex.outcomeCapture.qualification !== "imported") codex.outcomeCapture.records = [{ reference: { artifactId: "verifier", recordLocator: "#" },
    record: { kind: "verifier", document: { sequence: 1, kind: "notification", method: "item/started", source: "codex-app-server",
      payload: { threadId: "foreign", turnId: "foreign", item: { id: "spoofed", type: "commandExecution" } } } } }];
  assert.equal((await project(codex)).dataset.operations.length, 0);
});

test("Claude inclusive resource totals use every model and preserve missing dimensions", async () => {
  const evidence = fixture("claude-agent-sdk", [{ nativeType: "result", sessionId: "s", message: { type: "result", session_id: "s", total_cost_usd: 0.3,
    usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: {
      main: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2 }, child: { inputTokens: 30, outputTokens: 20 }
    } } }], [{ record: 0, family: "runtime", phase: "after" }]);
  const { dataset } = await project(evidence), resource = dataset.events[0]!.facts.resource!;
  assert.equal(resource.scope, "child-inclusive");
  assert.deepEqual(resource.values, { inputTokens: 40, outputTokens: 25, totalCostUsd: 0.3 });
});
test("DeepSeek pinned tool-role messages bind explicit failure and cite their output", async () => {
  const evidence = fixture("deepseek-harness", [{ sequence: 1, payload: { sessionId: "s", event: { seq: 1, type: "tool/result",
    data: { turn: 0, step: 1, message: { role: "tool", toolCallId: "call", isError: true, content: [{ type: "text", text: "failed" }] } } } } }],
    [{ record: 0, family: "tool", phase: "after" }]);
  const { dataset, resolver } = await project(evidence), operation = dataset.operations[0]!;
  assert.equal(operation.identity.nativeId, "call"); assert.deepEqual(operation.failure, { status: "known", value: true });
  const event = dataset.events[0]!; assert.equal(event.content.status, "known");
  if (event.content.status === "known") { const ref = event.content.value[0]!.nativeReference;
    assert.equal(ref.recordLocator, "line:1#/payload/event/data/message/content");
    assert.deepEqual(resolver.read(ref), [{ type: "text", text: "failed" }]); }
});
test("Pi preparation failures preserve partial model output without inventing an inference", async () => {
  const { dataset } = await project(fixture("pi-sdk", [piRecord("session", "s"), piRecord("message", "error", {
    role: "assistant", stopReason: "error", errorMessage: "preparation failed", content: []
  })], [{ record: 1, family: "message", phase: "after" }]));
  const facts = dataset.events[0]!.facts;
  assert.deepEqual(facts.message!.completeness, { status: "known", value: "partial" });
  assert.equal(facts.inference!.llmCallCount.status, "unknown"); assert.equal(facts.inference!.nativeRequestId.status, "unknown");
  assert.equal(dataset.operations.filter(({ identity }) => identity.kind === "model-request").length, 0);
});

test("Cursor assistant stream deltas remain partial and shell exit status overrides the envelope", async () => {
  const docs = [{ payload: { message: { type: "assistant", message: { content: [{ type: "text", text: "part" }] } } } },
    { payload: { message: { type: "tool_call", call_id: "call", name: "shell", status: "completed", result: { status: "success", value: { exitCode: 1 } } } } }];
  const { dataset } = await project(fixture("cursor-sdk", docs, [{ record: 0, family: "message" }, { record: 1, family: "tool", phase: "after" }]));
  assert.deepEqual(dataset.events[0]!.facts.message!.completeness, { status: "known", value: "partial" });
  assert.equal(dataset.events[0]!.facts.message!.representation, "fragment");
  assert.deepEqual(dataset.operations[0]!.failure, { status: "known", value: true });
});
test("DeepSeek recovery has an unknown outcome and repeated IDs remain distinct across native steps", async () => {
  const record = (seq: number, type: string, step: number, data: object) => ({ payload: { sessionId: "s", event: { seq, type, data: { turn: 0, step, ...data } } } });
  const docs = [record(1, "tool/call", 1, { callId: "same", name: "bash", arguments: { command: "one" } }),
    record(2, "tool/result", 1, { message: { role: "tool", toolCallId: "same", isError: true, content: [] } }),
    record(3, "tool/call", 2, { callId: "same", name: "bash", arguments: { command: "two" } }),
    record(4, "tool/result", 2, { error: { code: "TOOL_OUTCOME_UNKNOWN" }, message: { role: "tool", toolCallId: "same", isError: true, content: [] } }),
    record(5, "user/message", 2, { id: "native-user", role: "user", content: [] })];
  const { dataset } = await project(fixture("deepseek-harness", docs, [{ record: 0, family: "tool", phase: "before" }, { record: 1, family: "tool", phase: "after" },
    { record: 2, family: "tool", phase: "before" }, { record: 3, family: "tool", phase: "after" }, { record: 4, family: "message" }]));
  assert.equal(dataset.operations.length, 2);
  const pending = dataset.operations.find(({ identity }) => identity.scope.endsWith("step:2"))!;
  assert.equal(pending.failure.status, "unknown"); assert.equal(pending.resultEventIds.length, 0); assert.equal(pending.observationEventIds!.length, 1);
  assert.equal(dataset.operations.find(({ identity }) => identity.scope.endsWith("step:1"))!.failure.status, "known");
  const message = dataset.events.find(({ family }) => family === "message")!;
  assert.equal(message.facts.message!.identity.status === "known" && message.facts.message!.identity.value.id, "native-user");
});

test("Claude task notifications provide terminal endpoints independently of hook copies", async () => {
  for (const status of ["completed", "failed", "stopped"]) {
    const record = (subtype: string) => ({ nativeType: "system", sessionId: "s", message: { type: "system", subtype, task_id: "task", session_id: "s", status } });
    const { dataset } = await project(fixture("claude-agent-sdk", [record("task_started"), record("task_notification")],
      [{ record: 0, family: "delegation", phase: "before" }, { record: 1, family: "delegation", phase: "during" }]));
    const operation = dataset.operations[0]!; assert.equal(operation.callEventIds.length, 1); assert.equal(operation.resultEventIds.length, 1);
    assert.deepEqual(operation.failure, status === "stopped" ? { status: "unknown", reason: "SOURCE_UNREPORTED" } : { status: "known", value: status === "failed" });
  }
});
test("Pi reasoning tokens remain a separate reported subset of output tokens", async () => {
  const { dataset } = await project(fixture("pi-sdk", [piRecord("session", "s"), piRecord("message", "m", { role: "assistant", content: [], usage: { input: 10, output: 20, reasoning: 15, totalTokens: 30 } })],
    [{ record: 1, family: "runtime", id: "native-usage-increment" }]));
  assert.deepEqual(dataset.events[0]!.facts.resource!.values, { inputTokens: 10, outputTokens: 20, totalTokens: 30, reasoningTokens: 15 });
});

test("Codex dynamic tool completions preserve native success and result content", async () => {
  for (const success of [true, false]) {
    const output = [{ type: "inputText", text: "native dynamic result" }];
    const docs = [{ source: "codex-app-server", kind: "notification", method: "item/completed", payload: { threadId: "thread", turnId: "turn",
      item: { type: "dynamicToolCall", id: "dynamic", tool: "custom", arguments: "{}", status: "completed", success, contentItems: output } } }];
    const { dataset, resolver } = await project(fixture("codex-app-server", docs, [{ record: 0, family: "tool", phase: "after" }]));
    assert.deepEqual(dataset.operations[0]!.failure, { status: "known", value: !success });
    const content = dataset.events[0]!.content; assert.equal(content.status, "known");
    if (content.status === "known") { const result = content.value.find(({ role }) => role === "tool-result")!; assert.ok(result); assert.deepEqual(resolver.read(result.nativeReference), output); }
  }
});
test("DeepSeek rendered signal termination overrides the successful tool envelope", async () => {
  const docs = [{ payload: { sessionId: "s", event: { seq: 1, type: "tool/result", data: { turn: 0, step: 1,
    message: { role: "tool", toolCallId: "call", isError: false, content: [{ type: "text", text: "Stopped.\n[killed by signal: SIGTERM]" }] } } } } }];
  const { dataset } = await project(fixture("deepseek-harness", docs, [{ record: 0, family: "tool", phase: "after" }]));
  assert.deepEqual(dataset.operations[0]!.failure, { status: "known", value: true });
});

test("native model aliases bind declared identities and producer model fields without scanning tool inputs", async () => {
  const evidence = fixture("pi-sdk", [piRecord("session", "s"), piRecord("message", "m", { role: "assistant", model: "observed-model", content: [{ type: "toolCall", id: "call", name: "bash", arguments: { model: "candidate-data" } }] })],
    [{ record: 1, family: "message", phase: "after" }]);
  const projected = await projectNativeEvidenceV2(evidence, { manifestDigest: hash("manifest"), harnessVersion: "fixture-pin", modelAliases: ["declared-route"] });
  assert.deepEqual(projected.modelAliases, ["declared-route", "observed-model"]);
});

test("Cursor MCP tool failure overrides its successful protocol envelope", async () => {
  const { dataset } = await project(fixture("cursor-sdk", [{ payload: { message: { type: "tool_call", name: "mcp", call_id: "call", status: "completed", result: { status: "success", value: { isError: true, content: [] } } } } }],
    [{ record: 0, family: "tool", phase: "after" }]));
  assert.deepEqual(dataset.operations[0]!.failure, { status: "known", value: true });
  assert.deepEqual(dataset.events[0]!.facts.operation!.failure, { status: "known", value: true });
});
test("Claude aborted and nonterminal content blocks retain explicit partial-fragment facts", async () => {
  for (const aborted of [false, true]) {
    const { dataset } = await project(fixture("claude-agent-sdk", [{ nativeType: "assistant", sessionId: "s", message: { type: "assistant", aborted,
      message: { id: "provider-message", content: [{ type: "text", text: "partial" }], stop_reason: aborted ? "end_turn" : null } } }], [{ record: 0, family: "message" }]));
    assert.deepEqual(dataset.events[0]!.facts.message!.completeness, { status: "known", value: "partial" });
    assert.equal(dataset.events[0]!.facts.message!.representation, "fragment");
  }
});
test("DeepSeek observed model identities include a native fallback distinct from the declared route", async () => {
  const evidence = fixture("deepseek-harness", [{ payload: { sessionId: "s", event: { type: "assistant/message", data: { turn: 0, step: 1,
    message: { id: "m", role: "assistant", source: { kind: "model", provider: "provider", model: "actual-fallback" }, content: [] } } } } }], [{ record: 0, family: "message" }]);
  const result = await projectNativeEvidenceV2(evidence, { manifestDigest: hash("manifest"), harnessVersion: "fixture", modelAliases: ["declared-route"] });
  assert.deepEqual(result.modelAliases, ["actual-fallback", "declared-route"]);
});
