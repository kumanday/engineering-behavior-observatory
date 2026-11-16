import assert from "node:assert/strict";
import test from "node:test";
import { LEADERBOARD_PUBLIC_POLICY, selectPinnedLeaderboardFacts, type LeaderboardPolicyInput } from "../src/leaderboard-policy.js";
const python = process.env.EBO_LEADERBOARD_TEST_PYTHON;
function input(): LeaderboardPolicyInput {
  const run = { run_id: "full", created_at: "2026-11-01T00:00:00Z", model: "zai-org/GLM-5.3-Flash", provider: "zai-org", reasoning_effort: "low", stage: "full", harness_versions: { pi: "1.2.0" }, benchmark_setups: { "terminal-bench-2.1": { commit: "d49e28f1e4ddd13d289e85a5f312a66750951932", network: null } }, price: { input: 0.15, cached_input: 0.03, output: 0.5 } };
  const facts = Array.from({ length: 4 }, (_, index) => ({ id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`, trial: `trial-${index}`, task: "adaptive-rejection-sampler", harness: "pi", harness_version: "1.2.0", run_id: "full", benchmark: "terminal-bench-2.1", reused_from: null, reward: index === 0 ? 1 : 0, exception: null, agent_started: true, meter: { n_calls: 1, last_status: 200 } }));
  return { schemaVersion: "ebo.leaderboard-policy-input/v1", policyRevision: LEADERBOARD_PUBLIC_POLICY.revision, historyCompleteness: "bounded-subset", facts, runs: { full: run }, invalid: {} };
}
test("unavailable policy runtimes never turn unselected facts into exclusions or failures", async () => {
  const result = await selectPinnedLeaderboardFacts(input(), "/missing/leaderboard-policy-python");
  assert.equal(result.status, "unavailable"); assert.deepEqual(result.rows, []); assert.deepEqual(result.excludedSourceIndexes, []);
});
test("policy data cannot provide a runtime or overwrite internal derived fields", async () => {
  const source = input(); source.facts[0]!._outcome = "pass";
  await assert.rejects(selectPinnedLeaderboardFacts(source), /Unsupported/u);
  delete source.facts[0]!._outcome; source.policyRevision = "unregistered";
  await assert.rejects(selectPinnedLeaderboardFacts(source), /Unsupported/u);
});
test("pinned public policy handles current trial-specific invalidation verdicts and scored caps", { skip: !python }, async () => {
  const source = input(); source.invalid.full = { rules: [{ trials: ["trial-0"], outcome: "fail", reason: "Synthetic third-party assessment" }] };
  const result = await selectPinnedLeaderboardFacts(source, python);
  assert.equal(result.status, "available", JSON.stringify(result.diagnostics));
  assert.equal(result.rows.length, 3); assert.equal(result.rows[0]!.outcome, "fail");
  assert.deepEqual(result.excludedSourceIndexes, [3]);
  assert.equal(result.sourceAuthority, "third-party"); assert.equal(result.population, "retained-subset-not-full-board");
});
test("future invalidation selectors fail closed instead of matching an entire run", { skip: !python }, async () => {
  const source = input(); source.invalid.full = { rules: [{ future_selector: ["one trial"] }] };
  const result = await selectPinnedLeaderboardFacts(source, python);
  assert.equal(result.status, "unavailable"); assert.deepEqual(result.rows, []);
  assert.deepEqual(result.diagnostics, ["LEADERBOARD_SOURCE_OR_RULES_UNSUPPORTED"]);
});
test("provider exhaustion remains pinned third-party policy rather than an EBO verifier result", { skip: !python }, async () => {
  const source = input();
  source.facts = Array.from({ length: 8 }, (_, index) => ({ ...source.facts[0], id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`, trial: `provider-${index}`, reward: 0, meter: { n_calls: 1, last_status: 503 } }));
  const result = await selectPinnedLeaderboardFacts(source, python);
  assert.equal(result.status, "available"); assert.ok(result.rows.some(({ providerExhausted }) => providerExhausted));
  assert.equal(result.rows.filter(({ outcome }) => outcome === "fail").length, 3);
});

test('complete history never classifies facts without their run or reused executor context',async()=>{
 for(const reused of[false,true]){const source=input();source.historyCompleteness='complete';source.facts=[source.facts[0]!];if(reused)source.facts[0]!.reused_from='missing-original';else source.runs={};
  const receipt=await selectPinnedLeaderboardFacts(source,'/runtime-must-not-be-needed');assert.equal(receipt.status,'unavailable');assert.deepEqual(receipt.excludedSourceIndexes,[]);assert.deepEqual(receipt.diagnostics,['LEADERBOARD_RUN_OR_REUSE_CONTEXT_UNAVAILABLE']);
 }
});

test('complete reuse history requires original facts and rejects cycles before classification',async()=>{
 const source=input();source.historyCompleteness='complete';source.facts=[{...source.facts[0],reused_from:'pilot'}];source.runs.pilot={...source.runs.full as object,run_id:'pilot',stage:'pilot'};source.invalid.pilot={rules:[{}]};
 const missing=await selectPinnedLeaderboardFacts(source,'/runtime-not-needed');assert.equal(missing.status,'unavailable');assert.deepEqual(missing.excludedSourceIndexes,[]);
 source.facts.push({...source.facts[0],run_id:'pilot',reused_from:'full'});const cycle=await selectPinnedLeaderboardFacts(source,'/runtime-not-needed');assert.equal(cycle.status,'unavailable');assert.deepEqual(cycle.excludedSourceIndexes,[]);
});
test('retained original invalidation facts prevent a reused trial from becoming a complete-history pass',{skip:!python},async()=>{
 const source=input();source.historyCompleteness='complete';source.facts=[{...source.facts[0],reused_from:'pilot'}];source.runs.pilot={...source.runs.full as object,run_id:'pilot',stage:'pilot'};source.invalid.pilot={rules:[{}]};
 source.facts.push({...source.facts[0],run_id:'pilot',reused_from:null});const result=await selectPinnedLeaderboardFacts(source,python);assert.equal(result.status,'available');assert.equal(result.rows.length,0);
});
