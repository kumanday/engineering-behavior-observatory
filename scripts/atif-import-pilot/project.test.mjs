import assert from "node:assert/strict";
import test from "node:test";
import { orderingProbe, pointerValue, projectPi } from "./project.mjs";

function fixture() {
  return { schema_version: "ATIF-v1.7", agent: { name: "pi", version: "synthetic" }, steps: [
    { step_id: 1, source: "user", message: "Test the parser." },
    { step_id: 2, source: "agent", message: "Running tests.", llm_call_count: 1, timestamp: "2026-11-07T00:00:00Z",
      tool_calls: [{ tool_call_id: "a", function_name: "bash", arguments: { command: "npm test" } },
        { tool_call_id: "b", function_name: "bash", arguments: { command: "npm run lint" } }],
      observation: { results: [{ source_call_id: "a", content: "A test failed.", extra: { is_error: true } },
        { source_call_id: "b", content: "Done", extra: { is_error: false } }] } },
  ] };
}

test("projects exact source pointers, shared step order and no invented request identities", async () => {
  const source = fixture();
  const projected = await projectPi(source);
  const tools = projected.dataset.events.filter((event) => event.family === "tool");
  assert.equal(tools.length, 4);
  assert.ok(tools.every((event) => event.nativeOrder.value === 2));
  assert.ok(tools.every((event) => event.nativeTime.status === "unknown"));
  assert.deepEqual(new Set(tools.map((event) => event.scope.id)), new Set(["a", "b"]));
  assert.equal(projected.dataset.events.some((event) => event.family === "model-request"), false);
  assert.equal(pointerValue(source, "#/steps/1/tool_calls/0/arguments/command"), "npm test");
  assert.equal(pointerValue(source, "#/steps/100"), undefined);
  assert.ok(projected.units.units.some((unit) => unit.unit_kind === "tool"));
});

test("projection is deterministic and unknown result status is preserved", async () => {
  const source = fixture();
  delete source.steps[1].observation.results[0].extra;
  const left = await projectPi(source), right = await projectPi(source);
  assert.deepEqual(left.dataset, right.dataset);
  const result = left.dataset.events.find((event) => event.id === "1-result-0");
  assert.equal(Object.hasOwn(result.attributes, "isError"), false);
});

test("associates follow-up calls by source order when a result lacks a timestamp", () => {
  const probe = orderingProbe();
  assert.equal(probe.defectReproduced, false);
  assert.equal(probe.observedResponseEventId, "call-b");
  assert.equal(probe.ruleVersion, "1.2.0");
});
