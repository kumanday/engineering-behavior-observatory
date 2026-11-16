import assert from "node:assert/strict";
import test from "node:test";

import { checkKindsOf, extractOccurrences, findCommand, shellWrites, type OccurrenceOperation } from "../src/occurrences.js";
import type { UniformEvent } from "../src/uniform-events.js";
import { compareEventDisplayOrder, nativeEventPrecedence } from "../src/event-order.js";
import { occurrenceRequest } from "../src/occurrence-ratings.js";

function event(sequence: number, family: UniformEvent["family"], attributes: UniformEvent["attributes"] = {}, phase: UniformEvent["phase"] = "instant"): UniformEvent {
  return {
    schemaVersion: "ebo.uniform-event/v1", id: `event-${sequence}`, runId: "run", attemptId: "attempt",
    source: { harness: "fixture", nativeType: family, nativeReference: { artifactId: "session", recordLocator: `line:${sequence}` } },
    nativeOrder: { status: "known", value: sequence, domain: "session" },
    nativeTime: { status: "known", value: new Date(Date.UTC(2026, 9, 4, 0, 0, sequence)).toISOString() },
    actor: { kind: "tool" }, family, phase, scope: { kind: "session", id: "session" },
    relations: { parent: { status: "unknown", reason: "fixture" }, known: [] }, attributes,
    content: { status: "known", value: [{ nativeReference: { artifactId: "session", recordLocator: `line:${sequence}` } }] },
  };
}

function call(sequence: number, toolName: string, command: string, result: { isError?: boolean; output?: string } = {}): { operation: OccurrenceOperation; content: Record<string, unknown> } {
  const start = event(sequence * 10, "tool", { toolName, inputDigest: `sha256:${command}` }, "before");
  const end = event(sequence * 10 + 1, "tool", { toolName, ...(result.isError === undefined ? {} : { isError: result.isError }) }, "after");
  return {
    operation: { id: `op-${sequence}`, events: [start, end], toolName, inputDigest: `sha256:${command}`, failed: result.isError === true },
    content: { [`line:${sequence * 10}`]: { input: { command } }, [`line:${sequence * 10 + 1}`]: { output: result.output ?? "" } },
  };
}

const capability = { status: "available" as const };

function extract(operations: OccurrenceOperation[]) {
  return extractOccurrences({ attemptId: "attempt", events: operations.flatMap(({ events }) => events), operations,
    toolCapability: capability, delegationCapability: capability, isCompaction: () => false, resolveContent: () => undefined });
}

test("source precedence recognizes a later call after an untimed failure result", () => {
  const failed = call(1, "Bash", "fail", { isError: true }).operation;
  failed.events = failed.events.map((value) => value.phase === "after"
    ? { ...value, nativeTime: { status: "unknown", reason: "No source clock" } } : value);
  const response = call(2, "Bash", "recover", { isError: false }).operation;
  const { occurrences, coverage } = extract([response, failed]);
  const chain = occurrences.find(({ type }) => type === "failure-response")!;
  assert.equal(chain.attributes.lastFailureEventId, "event-11");
  assert.equal(chain.attributes.responseEventId, "event-20");
  assert.equal(chain.rule.version, "1.2.0");
  assert.equal(chain.rule.heuristic, true);
  assert.equal(coverage.find(({ type }) => type === "failure-response")!.status, "available");
});

test("unrelated order domains and receipt clocks cannot establish a response", () => {
  const failed = call(1, "Bash", "fail", { isError: true }).operation;
  const other = call(2, "Bash", "other", { isError: false }).operation;
  other.events = other.events.map((value) => ({ ...value, nativeOrder: { status: "known", domain: "hooks", value: 1 },
    attributes: { ...value.attributes, nativeTimeSource: "capture-receipt" } }));
  const { occurrences, coverage } = extract([failed, other]);
  assert.equal(nativeEventPrecedence(failed.events[0]!, other.events[0]!), undefined);
  assert.equal(occurrences.some(({ type }) => type === "failure-response"), false);
  assert.equal(coverage.find(({ type }) => type === "failure-response")!.status, "unavailable");
});

test("tied source positions have a deterministic display order and unavailable precedence", () => {
  const failed = call(1, "Bash", "fail", { isError: true }).operation;
  const other = call(2, "Bash", "other", { isError: false }).operation;
  for (const operation of [failed, other]) operation.events = operation.events.map((value) => ({ ...value,
    nativeOrder: { status: "known", domain: "steps", value: 1 } }));
  assert.notEqual(compareEventDisplayOrder(failed.events[0]!, other.events[0]!), 0);
  assert.equal(nativeEventPrecedence(failed.events[0]!, other.events[0]!), undefined);
  assert.equal(extract([failed, other]).coverage.find(({ type }) => type === "failure-response")!.status, "unavailable");
});

test("a tied failure endpoint is unavailable rather than an accepted no-response", () => {
  const failed = call(1, "Bash", "fail", { isError: true }).operation;
  const next = call(2, "Bash", "next", { isError: false }).operation;
  next.events = next.events.map((value) => value.phase === "before"
    ? { ...value, nativeOrder: { status: "known", domain: "session", value: 11 } } : value);
  const result = extract([failed, next]);
  assert.equal(result.occurrences.some(({ type }) => type === "failure-response"), false);
  assert.equal(result.coverage.find(({ type }) => type === "failure-response")!.status, "unavailable");
});

test("duplicate session and hook views retain the supported failure sequence", () => {
  const failed = call(1, "Bash", "fail", { isError: true }).operation;
  const response = call(2, "Bash", "recover", { isError: false }).operation;
  for (const operation of [failed, response]) operation.events = operation.events.flatMap((value) => [value, { ...value,
    id: `hook-${value.id}`, nativeOrder: { ...value.nativeOrder, domain: "hooks" } as UniformEvent["nativeOrder"],
    source: { ...value.source, nativeReference: { artifactId: "hooks", recordLocator: value.source.nativeReference.recordLocator } } }]);
  const result = extract([failed, response]);
  assert.equal(result.coverage.find(({ type }) => type === "failure-response")!.status, "available");
  const chain = result.occurrences.find(({ type }) => type === "failure-response")!;
  assert.equal(chain.attributes.failures, 1);
  assert.equal(chain.eventIds.length, 8, "both native views remain cited");
  assert.ok(["event-20", "hook-event-20"].includes(String(chain.attributes.responseEventId)));
});

test("serial hooks cannot make siblings from one retained declaration into feedback", () => {
  const failed = call(1, "Bash", "fail", { isError: true }).operation;
  const sibling = call(2, "Bash", "sibling", { isError: false }).operation;
  const response = call(3, "Bash", "response", { isError: false }).operation;
  for (const operation of [failed, sibling, response]) operation.events = operation.events.flatMap((value) => {
    const history = value.phase === "before" && operation !== response ? { ...value,
      nativeOrder: { status: "known" as const, domain: "session", value: 1 },
      source: { ...value.source, nativeReference: { artifactId: "session", recordLocator: "line:1" } } } : value;
    return [history, { ...value, id: `hook-${value.id}`, nativeOrder: { ...value.nativeOrder, domain: "hooks" } as UniformEvent["nativeOrder"],
      source: { ...value.source, nativeReference: { artifactId: "hooks", recordLocator: value.source.nativeReference.recordLocator } } }];
  });
  const chain = extract([failed, sibling, response]).occurrences.find(({ type }) => type === "failure-response")!;
  assert.ok(["event-30", "hook-event-30"].includes(String(chain.attributes.responseEventId)));
  assert.equal(chain.eventIds.some((id) => ["event-20", "hook-event-20"].includes(id)), false);
});

test("failed retries retain response roles and originating-failure identities across display inversions", () => {
  const failed = call(1, "Bash", "fail", { isError: true }).operation;
  const sibling = call(2, "Bash", "sibling", { isError: false }).operation;
  const retry = call(3, "Bash", "retry", { isError: true }).operation;
  const recovery = call(4, "Bash", "recover", { isError: false }).operation;
  const operations = [failed, sibling, retry, recovery];
  for (const operation of operations) operation.events = operation.events.map((value) => ({ ...value,
    attributes: { ...value.attributes, toolCallId: operation.id,
      ...([failed, sibling].includes(operation) ? { inferenceId: "batch-a" } : {}) },
    ...(operation === failed ? { nativeTime: { status: "unknown" as const, reason: "No source clock" } } : {}) }));
  const chains = extract(operations).occurrences.filter(({ type }) => type === "failure-response");
  assert.equal(chains.length, 2);
  assert.equal(new Set(chains.map(({ id }) => id)).size, 2);
  const original = chains.find(({ attributes }) => attributes.lastFailureEventId === "event-11")!;
  assert.equal(original.id, "attempt/occ/failure-response/event-10");
  assert.equal(original.attributes.responseEventId, "event-30");
  assert.equal(original.attributes.nextOutcome, "failed");
  const state = occurrenceRequest(original, chains, new Map(operations.flatMap(({ events }) => events).map((value) => [value.id, value])), () => undefined).state!;
  assert.deepEqual((state.calls as Array<{ position: string; nativeResult: string }>).map(({ position, nativeResult }) => [position, nativeResult]),
    [["failure 1", "failed"], ["response", "failed"]]);
});

test("compaction traversal follows source order when its start is untimed", () => {
  const pre = { ...event(1, "context", { hook: "PreCompact" }), nativeTime: { status: "unknown" as const, reason: "No clock" } };
  const post = event(2, "context", { hook: "PostCompact" });
  const result = extractOccurrences({ attemptId: "attempt", events: [pre, post], operations: [],
    toolCapability: capability, delegationCapability: capability, isCompaction: () => true });
  assert.equal(result.coverage.find(({ type }) => type === "compaction")!.status, "available");
  assert.equal(result.occurrences.filter(({ type }) => type === "compaction").length, 1);
  assert.deepEqual(new Set(result.occurrences[0]!.eventIds), new Set([pre.id, post.id]));
});

test("mixed-domain compaction merge preserves native order against reversed clocks", () => {
  const pre = { ...event(1, "context", { hook: "PreCompact" }), nativeTime: event(2, "context").nativeTime };
  const post = { ...event(2, "context", { hook: "PostCompact" }), nativeTime: event(1, "context").nativeTime };
  const other = { ...event(3, "tool"), nativeOrder: { status: "known" as const, domain: "other-stream", value: 1 } };
  const result = extractOccurrences({ attemptId: "attempt", events: [pre, post, other], operations: [],
    toolCapability: capability, delegationCapability: capability, isCompaction: ({ family }) => family === "context" });
  assert.equal(result.coverage.find(({ type }) => type === "compaction")!.status, "available");
  assert.equal(result.occurrences.filter(({ type }) => type === "compaction").length, 1);
});

test("repeated-operation support retains both endpoints from the selected native view", () => {
  const first = call(1, "Bash", "same", { isError: false }).operation;
  const repeated = call(3, "Bash", "same", { isError: false }).operation;
  for (const operation of [first, repeated]) operation.events = operation.events.flatMap((value) => [value, { ...value,
    id: `hook-${value.id}`, nativeTime: { status: "known" as const, value: new Date(Date.parse((value.nativeTime as { value: string }).value) + 100).toISOString() },
    nativeOrder: { ...value.nativeOrder, domain: "hooks" } as UniformEvent["nativeOrder"],
    source: { ...value.source, nativeReference: { artifactId: "hooks", recordLocator: value.source.nativeReference.recordLocator } } }]);
  const occurrences = extract([first, repeated]).occurrences;
  const target = occurrences.find(({ type }) => type === "repeated-operation")!;
  assert.equal(target.attributes.firstEventId, "hook-event-10");
  assert.equal(target.attributes.repeatedEventId, "hook-event-30");
  const edit = { ...event(20, "artifact", { mutation: true }), nativeOrder: { status: "known" as const, domain: "hooks", value: 20 } };
  const change = { ...target, id: "edit", type: "source-change" as const, eventIds: [edit.id] };
  const request = occurrenceRequest(target, [...occurrences, change], new Map([...first.events, ...repeated.events, edit].map((value) => [value.id, value])), () => undefined);
  assert.equal((request.state!.facts as Record<string, unknown>).sourceChangesBetween, 1);
});

test("rating support selects the edit view compatible with the failure endpoints", () => {
  const failed = call(1, "Bash", "fail", { isError: true }).operation;
  const response = call(3, "Bash", "response", { isError: false }).operation;
  const chains = extract([failed, response]).occurrences;
  const sessionEdit = event(20, "tool", { mutation: true }, "before");
  const hookEdit = { ...sessionEdit, id: "hook-edit", nativeOrder: { status: "known" as const, domain: "hooks", value: 20 } };
  const sourceChange = { ...chains[0]!, id: "edit", type: "source-change" as const, eventIds: [hookEdit.id, sessionEdit.id] };
  const events = new Map([...failed.events, ...response.events, hookEdit, sessionEdit].map((value) => [value.id, value]));
  const request = occurrenceRequest(chains.find(({ type }) => type === "failure-response")!, [...chains, sourceChange], events, () => undefined);
  assert.equal((request.state!.facts as Record<string, unknown>).sourceChangesBetween, 1);
});

test("compaction grouping preserves cross-stream barriers and a complete boundary", () => {
  const pre = { ...event(1, "context", { hook: "PreCompact" }), nativeOrder: { status: "known" as const, domain: "hooks", value: 1 } };
  const marker = event(3, "context", { subtype: "compact_boundary" });
  const tool = event(0, "tool");
  const result = extractOccurrences({ attemptId: "attempt", events: [tool, pre, marker], operations: [],
    toolCapability: capability, delegationCapability: capability, isCompaction: ({ family }) => family === "context" });
  assert.deepEqual(result.occurrences.filter(({ type }) => type === "compaction").map(({ eventIds }) => eventIds), [[pre.id, marker.id]]);
  const barrier = event(2, "message");
  const separated = extractOccurrences({ attemptId: "attempt", events: [pre, barrier, marker], operations: [],
    toolCapability: capability, delegationCapability: capability, isCompaction: ({ family }) => family === "context" });
  assert.equal(separated.occurrences.filter(({ type }) => type === "compaction").length, 2);
  const receiptPre = { ...pre, attributes: { ...pre.attributes, nativeTimeSource: "hook-callback" } };
  const ambiguous = extractOccurrences({ attemptId: "attempt", events: [receiptPre, marker], operations: [],
    toolCapability: capability, delegationCapability: capability, isCompaction: ({ family }) => family === "context" });
  assert.equal(ambiguous.coverage.find(({ type }) => type === "compaction")!.status, "unavailable");
  assert.equal(ambiguous.occurrences.some(({ type }) => type === "compaction"), false);
});

test("serial execution of calls from one inference never turns a sibling into a response", () => {
  const failed = call(1, "Bash", "fail", { isError: true }).operation;
  const sibling = call(2, "Bash", "sibling", { isError: false }).operation;
  for (const operation of [failed, sibling]) operation.events = operation.events.map((value) => ({ ...value,
    attributes: { ...value.attributes, inferenceId: "inference-a" } }));
  const response = call(3, "Bash", "response", { isError: false }).operation;
  const chain = extract([failed, sibling, response]).occurrences.find(({ type }) => type === "failure-response")!;
  assert.equal(chain.attributes.responseEventId, "event-30");
  assert.equal(chain.eventIds.includes("event-20"), false);
});

test("unknown source order with known clocks withholds exact occurrence coverage", () => {
  const failed = call(1, "Bash", "same", { isError: true }).operation;
  const other = call(2, "Bash", "same", { isError: false }).operation;
  for (const operation of [failed, other]) operation.events = operation.events.map((value) => ({ ...value,
    nativeOrder: { status: "unknown", reason: "No source ordinal" } }));
  const result = extract([failed, other]);
  for (const type of ["failure-response", "repeated-operation"]) {
    assert.equal(result.coverage.find((value) => value.type === type)!.status, "unavailable");
    assert.equal(result.occurrences.some((value) => value.type === type), false);
  }
});

test("rating support facts use source precedence and abstain across clock-only domains", () => {
  const failed = call(1, "Bash", "fail", { isError: true }).operation;
  const response = call(3, "Bash", "recover", { isError: false }).operation;
  const occurrences = extract([failed, response]).occurrences;
  const change = { ...event(20, "artifact", { mutation: true }), nativeOrder: { status: "known" as const, domain: "hooks", value: 2 } };
  const sourceChange = { ...occurrences[0]!, id: "change", type: "source-change" as const, eventIds: [change.id] };
  const request = occurrenceRequest(occurrences.find(({ type }) => type === "failure-response")!, [...occurrences, sourceChange],
    new Map([...failed.events, ...response.events, change].map((value) => [value.id, value])), () => undefined);
  assert.equal((request.state!.facts as Record<string, unknown>).sourceChangesBetween, "unknown");
  const legacy = { ...occurrences.find(({ type }) => type === "failure-response")!, rule: { ...occurrences[0]!.rule, version: "1.1.0" as const } };
  const retainedRequest = occurrenceRequest(legacy, [...occurrences, sourceChange],
    new Map([...failed.events, ...response.events, change].map((value) => [value.id, value])), () => undefined);
  assert.equal((retainedRequest.state!.facts as Record<string, unknown>).sourceChangesBetween, 1, "retained rating inputs preserve their recorded rule semantics");
});

test("classifies every check a command runs per segment and the source paths it writes", () => {
  assert.deepEqual(checkKindsOf("cd app && pnpm exec jest src/a.test.ts; npx tsc --noEmit | tail -5"), ["test", "typecheck"]);
  assert.deepEqual(checkKindsOf("bash -lc 'pnpm lint && pnpm build'"), ["lint", "build"]);
  assert.deepEqual(checkKindsOf("cat tsc-output.txt && grep -r test src"), []);
  assert.deepEqual(checkKindsOf("cat SKILL.md; npx playwright --version 2>/dev/null; ls /root/.cache"), [], "a version query is not a check run");
  assert.deepEqual(checkKindsOf("npx playwright install chromium && npx tsc --version"), []);
  assert.deepEqual(checkKindsOf("npx jest --listTests && pnpm exec playwright show-report"), []);
  assert.deepEqual(checkKindsOf("npx playwright test e2e/login.spec.ts"), ["test"]);
  assert.deepEqual(checkKindsOf("npx jest add"), ["test"], "a test selector named like a setup command is still a run");
  assert.deepEqual(shellWrites("node -e \"require('fs').writeFileSync('src/app.tsx', s)\""), ["src/app.tsx"]);
  assert.deepEqual(shellWrites("sed -i 's/a/b/' src/lib/util.ts && cat src/lib/util.ts > /tmp/out.log"), ["src/lib/util.ts"]);
  assert.deepEqual(shellWrites("pnpm test 2>&1 | tail"), []);
  assert.equal(findCommand({ data: { arguments: JSON.stringify({ command: "pnpm test" }) } }), "pnpm test");
  assert.equal(findCommand({ command: ["bash", "-lc", "jest"] }), "bash -lc jest");
});

test("extracts instance-sized occurrences that cite only their own events", () => {
  const calls = [
    call(1, "Bash", "pnpm exec jest", { isError: true, output: "Exit code 1" }),
    call(2, "Bash", "pnpm exec jest --watch=false", { isError: true }),
    call(3, "Read", "src/a.ts", { isError: false }),
    call(4, "Bash", "pnpm exec jest", { isError: false, output: "Tests: 4 passed" }),
    call(5, "Edit", "src/a.ts", { isError: false }),
    call(6, "Bash", "pnpm test 2>&1 | tail > /tmp/test.log", { isError: false, output: "ELIFECYCLE Command failed with exit code 1." }),
  ];
  const content = Object.assign({}, ...calls.map(({ content: value }) => value)) as Record<string, unknown>;
  const compactionStart = event(100, "context", { subtype: "compact_boundary" });
  const compactionHook = event(101, "context", { hook: "PreCompact" });
  const operations = calls.map(({ operation }) => operation);
  const events = [...operations.flatMap(({ events: operationEvents }) => operationEvents), compactionStart, compactionHook];
  const { occurrences, coverage } = extractOccurrences({
    attemptId: "attempt", events, operations, toolCapability: capability,
    delegationCapability: { status: "unsupported", detail: "The fixture adapter does not expose delegation." },
    isCompaction: ({ family, attributes }) => family === "context" && (attributes.subtype === "compact_boundary" || attributes.hook === "PreCompact"),
    resolveContent: ({ recordLocator }) => content[recordLocator],
  });
  const of = (type: string) => occurrences.filter((occurrence) => occurrence.type === type);

  const [chain] = of("failure-response");
  assert.equal(of("failure-response").length, 1);
  assert.deepEqual(chain!.eventIds, ["event-10", "event-11", "event-20", "event-21", "event-40", "event-41"], "two failures of Bash, then its next call");
  assert.deepEqual(chain!.attributes, { toolName: "Bash", failures: 2, lastFailureEventId: "event-21", nextOutcome: "passed", responseEventId: "event-40" });
  assert.equal(chain!.id, "attempt/occ/failure-response/event-10");
  assert.equal(chain!.rule.heuristic, true, "execution follow-up does not establish model causality");

  const validations = of("validation-run");
  assert.equal(validations.length, 4);
  assert.ok(validations.every(({ rule, eventIds }) => rule.heuristic && eventIds.length === 2));
  assert.deepEqual(validations.map(({ attributes }) => attributes.result), ["failed", "failed", "passed", "passed"]);
  assert.equal(validations[0]!.attributes.reportedExitCode, 1);
  assert.equal(validations[3]!.attributes.reportedExitCode, 1, "a check failing inside a pipeline is visible though the call succeeded");
  assert.equal(validations[3]!.attributes.outputRedirected, true);

  assert.deepEqual(of("source-change").map(({ attributes }) => attributes.detectedBy), ["edit-tool"]);
  assert.deepEqual(of("repeated-operation").map(({ eventIds, attributes }) => [eventIds, attributes.firstEventId]), [[["event-40", "event-41"], "event-10"]]);
  assert.deepEqual(of("compaction").map(({ eventIds }) => eventIds), [["event-100", "event-101"]], "records of one boundary form one compaction");

  assert.equal(of("delegation").length, 0);
  assert.deepEqual(coverage.find(({ type }) => type === "delegation"), { type: "delegation", status: "unavailable", reason: "The fixture adapter does not expose delegation." });
  assert.deepEqual(coverage.find(({ type }) => type === "validation-run"), { type: "validation-run", status: "available", count: 4 });
});

test("command-based occurrence types are unavailable without native content, never zero", () => {
  const { operation } = call(1, "Bash", "pnpm exec jest", { isError: false });
  const { occurrences, coverage } = extractOccurrences({
    attemptId: "attempt", events: [...operation.events], operations: [operation], toolCapability: capability,
    delegationCapability: capability, isCompaction: () => false,
  });
  assert.equal(occurrences.some(({ type }) => type === "validation-run" || type === "source-change"), false);
  assert.equal(coverage.find(({ type }) => type === "validation-run")?.status, "unavailable");
  assert.equal(coverage.find(({ type }) => type === "source-change")?.status, "unavailable");
  assert.deepEqual(coverage.find(({ type }) => type === "delegation"), { type: "delegation", status: "available", count: 0 });
});

test("explicit mutations outside tool operations are source changes", () => {
  const fileChange = event(5, "artifact", { mutation: true, itemType: "fileChange", status: "completed" }, "after");
  const { occurrences } = extractOccurrences({
    attemptId: "attempt", events: [fileChange], operations: [], toolCapability: capability, delegationCapability: capability,
    isCompaction: () => false, resolveContent: () => undefined,
  });
  assert.deepEqual(occurrences.map(({ type, eventIds, rule, attributes }) => [type, eventIds, rule.heuristic, attributes.detectedBy, attributes.toolName]),
    [["source-change", ["event-5"], false, "explicit-mutation", "fileChange"]]);
});

test("a failure response starts after the failure, in the same session", () => {
  const at = (sequence: number, seconds: number, attributes: UniformEvent["attributes"], phase: UniformEvent["phase"], session = "s1") => {
    const value = event(sequence, "tool", { ...attributes, sessionId: session }, phase);
    return { ...value, nativeTime: { status: "known" as const, value: new Date(Date.UTC(2026, 9, 4, 0, 0, seconds)).toISOString() } };
  };
  const operation = (id: string, events: UniformEvent[], failed: boolean): OccurrenceOperation => ({ id, events, toolName: "Bash", inputDigest: `sha256:${id}`, failed });
  const failing = operation("a", [at(1, 1, { toolName: "Bash" }, "before"), at(4, 4, { toolName: "Bash", isError: true }, "after")], true);
  const parallel = operation("b", [at(2, 2, { toolName: "Bash" }, "before"), at(5, 5, { toolName: "Bash", isError: false }, "after")], false);
  const otherSession = operation("c", [at(6, 6, { toolName: "Bash" }, "before", "s2"), at(7, 7, { toolName: "Bash", isError: false }, "after", "s2")], false);
  const response = operation("d", [at(8, 8, { toolName: "Bash" }, "before"), at(9, 9, { toolName: "Bash", isError: false }, "after")], false);
  const operations = [failing, parallel, otherSession, response];
  const { occurrences } = extractOccurrences({
    attemptId: "attempt", events: operations.flatMap(({ events }) => events), operations, toolCapability: capability,
    delegationCapability: capability, isCompaction: () => false, resolveContent: () => undefined,
  });
  const [chain] = occurrences.filter(({ type }) => type === "failure-response");
  assert.deepEqual(chain!.eventIds, ["event-1", "event-4", "event-8", "event-9"], "the running parallel call and the other session's call are not responses");
  assert.equal(chain!.attributes.lastFailureEventId, "event-4");
  assert.equal(chain!.attributes.responseEventId, "event-8");
});

test("a partial compaction stays separate and spans use parsed timestamps", () => {
  const compaction = (sequence: number, hook: string, time: string) => ({ ...event(sequence, "context", { hook }), nativeTime: { status: "known" as const, value: time } });
  const firstStart = compaction(1, "PreCompact", "2026-01-01T07:00:00Z");
  const message = { ...event(2, "message", {}), nativeTime: { status: "known" as const, value: "2026-01-01T07:30:00Z" } };
  const secondStart = compaction(3, "PreCompact", "2026-01-01T10:00:00+02:00");
  const secondEnd = compaction(4, "PostCompact", "2026-01-01T09:00:00Z");
  const { occurrences } = extractOccurrences({
    attemptId: "attempt", events: [firstStart, message, secondStart, secondEnd], operations: [], toolCapability: capability,
    delegationCapability: capability, isCompaction: ({ family }) => family === "context", resolveContent: () => undefined,
  });
  const compactions = occurrences.filter(({ type }) => type === "compaction");
  assert.deepEqual(compactions.map(({ eventIds }) => eventIds), [["event-1"], ["event-3", "event-4"]]);
  assert.ok(compactions.every(({ rule }) => rule.heuristic), "grouping by adjacency is labeled heuristic");
  assert.deepEqual(compactions[1]!.span, { start: "2026-01-01T10:00:00+02:00", end: "2026-01-01T09:00:00Z" }, "10:00+02:00 is 08:00Z, before 09:00Z");
});

test("failure chains form within their own session, and failed edits are not source changes", () => {
  const at = (sequence: number, attributes: UniformEvent["attributes"], phase: UniformEvent["phase"], session: string) =>
    event(sequence, "tool", { ...attributes, sessionId: session }, phase);
  const operation = (id: string, toolName: string, events: UniformEvent[], failed: boolean): OccurrenceOperation => ({ id, events, toolName, inputDigest: `sha256:${id}`, failed });
  const firstFailure = operation("a", "Bash", [at(1, { toolName: "Bash" }, "before", "s1"), at(2, { toolName: "Bash", isError: true }, "after", "s1")], true);
  const otherSession = operation("b", "Bash", [at(3, { toolName: "Bash" }, "before", "s2"), at(4, { toolName: "Bash", isError: false }, "after", "s2")], false);
  const secondFailure = operation("c", "Bash", [at(5, { toolName: "Bash" }, "before", "s1"), at(6, { toolName: "Bash", isError: true }, "after", "s1")], true);
  const recovery = operation("d", "Bash", [at(7, { toolName: "Bash" }, "before", "s1"), at(8, { toolName: "Bash", isError: false }, "after", "s1")], false);
  const failedEdit = operation("e", "Edit", [at(9, { toolName: "Edit" }, "before", "s1"), at(10, { toolName: "Edit", isError: true }, "after", "s1")], true);
  const operations = [firstFailure, otherSession, secondFailure, recovery, failedEdit];
  const { occurrences } = extractOccurrences({
    attemptId: "attempt", events: operations.flatMap(({ events }) => events), operations, toolCapability: capability,
    delegationCapability: capability, isCompaction: () => false, resolveContent: () => undefined,
  });
  const chains = occurrences.filter(({ type, attributes }) => type === "failure-response" && attributes.toolName === "Bash");
  assert.deepEqual(chains.map(({ eventIds, attributes }) => [eventIds, attributes.failures]),
    [[["event-1", "event-2", "event-5", "event-6", "event-7", "event-8"], 2]], "the other session's call does not split the chain");
  assert.equal(occurrences.some(({ type }) => type === "source-change"), false, "a failed edit is an attempt, not a change");
});

test("inferred changes need native success, partitions use the resolved scope, DeepSeek compaction kinds differ", () => {
  const tool = (sequence: number, attributes: UniformEvent["attributes"], phase: UniformEvent["phase"]) => ({ ...event(sequence, "tool", attributes, phase), scope: { kind: "operation" as const, id: `op-${sequence}` } });
  const operation = (id: string, toolName: string, events: UniformEvent[], failed: boolean, scope?: string): OccurrenceOperation =>
    ({ id, events, toolName, inputDigest: `sha256:${id}`, failed, ...(scope === undefined ? {} : { scope }) });
  // Agent SDK tool events carry no sessionId; the resolved scope separates the main agent from a subagent.
  const mainFailure = operation("a", "Bash", [tool(1, { toolName: "Bash" }, "before"), tool(2, { toolName: "Bash", isError: true }, "after")], true, "main");
  const subagentFailure = operation("b", "Bash", [tool(3, { toolName: "Bash" }, "before"), tool(4, { toolName: "Bash", isError: true }, "after")], true, "subagent");
  const interruptedEdit = operation("c", "Edit", [tool(5, { toolName: "Edit" }, "before")], false, "main");
  const hookConfirmedEdit = operation("d", "Edit", [tool(6, { toolName: "Edit" }, "before"), tool(7, { toolName: "Edit", hook: "PostToolUse" }, "after")], false, "main");
  const compaction = (sequence: number, eventType: string) => ({ ...event(sequence, "context", { eventType }), source: { ...event(sequence, "context").source, nativeType: "session.event" } });
  const operations = [mainFailure, subagentFailure, interruptedEdit, hookConfirmedEdit];
  const { occurrences } = extractOccurrences({
    attemptId: "attempt", events: [...operations.flatMap(({ events }) => events), compaction(20, "compaction/start"), compaction(21, "compaction/end")],
    operations, toolCapability: capability, delegationCapability: capability, isCompaction: ({ family }) => family === "context", resolveContent: () => undefined,
  });
  const of = (type: string) => occurrences.filter((occurrence) => occurrence.type === type);
  assert.deepEqual(of("failure-response").map(({ attributes }) => attributes.failures), [1, 1], "main-agent and subagent failures are separate chains");
  assert.deepEqual(of("source-change").map(({ eventIds }) => eventIds), [["event-6", "event-7"]], "an unfinished edit is not a change; a PostToolUse-confirmed one is");
  assert.deepEqual(of("compaction").map(({ eventIds }) => eventIds), [["event-20", "event-21"]], "start and end of one DeepSeek compaction form one boundary");
});


test("intervening tools separate source-ordered failure chains without hiding a failed retry", () => {
  const first = call(1, "Bash", "fail", { isError: true }).operation;
  const edit = call(2, "Edit", "change", { isError: false }).operation;
  const retry = call(3, "Bash", "retry", { isError: true }).operation;
  first.events = first.events.map((value) => value.phase === "after"
    ? { ...value, nativeTime: { status: "unknown", reason: "No source clock" } } : value);
  const { occurrences, coverage } = extract([retry, first, edit]);
  const chains = occurrences.filter(({ type }) => type === "failure-response");
  assert.equal(chains.length, 2);
  const original = chains.find(({ attributes }) => attributes.lastFailureEventId === "event-11")!;
  assert.equal(original.attributes.failures, 1);
  assert.equal(original.attributes.responseEventId, "event-30");
  assert.equal(original.attributes.nextOutcome, "failed");
  const terminal = chains.find(({ attributes }) => attributes.lastFailureEventId === "event-31")!;
  assert.equal(terminal.attributes.failures, 1);
  assert.equal(terminal.attributes.nextOutcome, "none");
  assert.equal(coverage.find(({ type }) => type === "failure-response")!.status, "available");
});


test("completion-only native operations retain source-ordered repetition evidence", () => {
  const first = call(1, "Bash", "same", { isError: false }).operation;
  const repeated = call(2, "Bash", "same", { isError: false }).operation;
  for (const operation of [first, repeated]) operation.events = operation.events.filter(({ phase }) => phase === "after");
  const result = extract([repeated, first]);
  const occurrence = result.occurrences.find(({ type }) => type === "repeated-operation")!;
  assert.equal(occurrence.attributes.firstEventId, "event-11");
  assert.equal(occurrence.attributes.repeatedEventId, "event-21");
  assert.equal(result.coverage.find(({ type }) => type === "repeated-operation")!.status, "available");
});

test("repetition needs comparable source observations without requiring a failure result in that domain", () => {
  const first = call(1, "Bash", "same", { isError: true }).operation;
  const repeated = call(2, "Bash", "same", { isError: false }).operation;
  first.events = first.events.map((value) => value.phase === "after" ? { ...value,
    nativeOrder: { status: "known", value: 1, domain: "results" } } : value);
  const result = extract([first, repeated]);
  assert.equal(result.occurrences.filter(({ type }) => type === "repeated-operation").length, 1);
  assert.equal(result.coverage.find(({ type }) => type === "repeated-operation")!.status, "available");
});

test("tied earliest successors cannot be selected by display time or event ID", () => {
  const failed = call(1, "Bash", "fail", { isError: true }).operation;
  const left = call(2, "Bash", "left", { isError: false }).operation;
  const right = call(3, "Bash", "right", { isError: false }).operation;
  right.events = right.events.map((value) => ({ ...value,
    nativeOrder: { status: "known", value: value.phase === "before" ? 20 : 21, domain: "session" } }));
  const result = extract([right, failed, left]);
  assert.equal(result.coverage.find(({ type }) => type === "failure-response")!.status, "unavailable");
  assert.equal(result.occurrences.filter(({ type }) => type === "failure-response").length, 0);
});


test("an instant call is not a failure endpoint when its actual result has another or unknown order", () => {
  for (const unknown of [false, true]) {
    const failed = call(1, "Bash", "fail", { isError: true }).operation;
    failed.events = failed.events.map((value) => value.phase === "before" ? { ...value, phase: "instant" } : { ...value,
      nativeOrder: unknown ? { status: "unknown", reason: "No source order" } : { status: "known", value: 100, domain: "other-results" } });
    const next = call(2, "Bash", "already-running", { isError: false }).operation;
    const result = extract([failed, next]);
    assert.equal(result.occurrences.some(({ type }) => type === "failure-response"), false);
    assert.equal(result.coverage.find(({ type }) => type === "failure-response")!.status, "unavailable");
  }
});

test("tied intervening-tool boundaries cannot establish one consecutive failure chain", () => {
  const first = call(1, "Bash", "fail", { isError: true }).operation;
  const edit = call(2, "Edit", "change", { isError: false }).operation;
  const retry = call(3, "Bash", "retry", { isError: true }).operation;
  edit.events = edit.events.map((value) => ({ ...value, nativeOrder: { status: "known", value: value.phase === "before" ? 30 : 31, domain: "session" } }));
  const result = extract([first, edit, retry]);
  assert.equal(result.coverage.find(({ type }) => type === "failure-response")!.status, "unavailable");
  assert.ok(result.occurrences.filter(({ type }) => type === "failure-response").every(({ attributes }) => attributes.failures === 1));
});


test("a definite intervening tool separates failures independently of another tool's display clock", () => {
  const first = call(1, "Bash", "fail", { isError: true }).operation;
  const edit = call(2, "Edit", "change", { isError: false }).operation;
  const retry = call(3, "Bash", "retry", { isError: true }).operation;
  const read = call(4, "Read", "inspect", { isError: false }).operation;
  read.events = read.events.map((value) => ({ ...value, nativeOrder: { status: "known", value: value.phase === "before" ? 30 : 31, domain: "session" } }));
  const early = extract([first, edit, retry, { ...read, events: read.events.map((value) => ({ ...value,
    nativeTime: { status: "known", value: "2026-10-01T00:00:00Z" } })) }]);
  const late = extract([first, edit, retry, { ...read, events: read.events.map((value) => ({ ...value,
    nativeTime: { status: "known", value: "2026-10-10T00:00:00Z" } })) }]);
  assert.deepEqual(early, late);
  assert.equal(early.coverage.find(({ type }) => type === "failure-response")!.status, "available");
  assert.equal(early.occurrences.filter(({ type }) => type === "failure-response").length, 2);
});
