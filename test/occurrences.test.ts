import assert from "node:assert/strict";
import test from "node:test";

import { checkKindsOf, extractOccurrences, findCommand, shellWrites, type OccurrenceOperation } from "../src/occurrences.js";
import type { UniformEvent } from "../src/uniform-events.js";

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

test("classifies every check a command runs per segment and the source paths it writes", () => {
  assert.deepEqual(checkKindsOf("cd app && pnpm exec jest src/a.test.ts; npx tsc --noEmit | tail -5"), ["test", "typecheck"]);
  assert.deepEqual(checkKindsOf("bash -lc 'pnpm lint && pnpm build'"), ["lint", "build"]);
  assert.deepEqual(checkKindsOf("cat tsc-output.txt && grep -r test src"), []);
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
  assert.deepEqual(chain!.attributes, { toolName: "Bash", failures: 2, nextOutcome: "passed" });
  assert.equal(chain!.id, "attempt/occ/failure-response/event-10");
  assert.equal(chain!.rule.heuristic, false);

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
