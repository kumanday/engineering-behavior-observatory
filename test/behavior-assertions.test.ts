import {createRetainedBehaviorEvidence} from "../src/retained-evidence.js";
import { runtimeTest } from "./with-runtime-fixture.js";
const test = runtimeTest("claude-agent-sdk");
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { HookInput, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  captureClaudeAgentSdkRun,
  createAgentSdkNativeEvidenceResolver,
  digestMetadata,
  isConfirmedBehaviorAssertion,
  isDecisionModelAssertion,
  producerLabel,
  probeClaudeAgentSdkCapabilities,
  readQualifiedClaudeAgentSdkCapture,
  validateBehaviorAssertion,
  validateBehaviorReview,
  type BehaviorAssertion,
  type BehaviorReview,
  type DecisionModelAssertion,
  type LlmJudgeAssertion,
  type ClaudeAgentSdkQuery,
  type NativeEvidenceResolver,
  type NormalizedDataset,
  type RunBundleDefinition,
} from "../src/index.js";
import { main } from "../src/cli.js";
import { ONTOLOGY_DIGEST, decisionModelAssertion } from "./behavior-fixture.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = join(repositoryRoot, "test/fixtures/behavior-assertions");

test("configuration digests belong only to producers", async () => {
  const dataset = fixture<NormalizedDataset>("dataset.json");
  const assertion = fixture<LlmJudgeAssertion>("positive.json");
  assertion.producer.configurationDigest = `sha256:${"a".repeat(64)}`;
  assert.equal((await validateBehaviorAssertion(assertion, dataset, resolver(dataset))).length, 1);
  const invalid = { ...assertion, rubric: { ...assertion.rubric, configurationDigest: assertion.producer.configurationDigest } };
  await assert.rejects(validateBehaviorAssertion(invalid, dataset, resolver(dataset)), /rubric.*additional properties/u);
});

test("validates positive, disputed, abstained, and invalid-reference fixtures", async () => {
  const dataset = fixture<NormalizedDataset>("dataset.json");
  const positive = fixture<LlmJudgeAssertion>("positive.json");
  const disputed = fixture<BehaviorReview>("disputed.review.json");
  const abstained = fixture<LlmJudgeAssertion>("abstained.json");

  assert.equal((await validateBehaviorAssertion(positive, dataset, resolver(dataset))).length, 1);
  validateBehaviorReview(positive, disputed);
  assert.equal(await isConfirmedBehaviorAssertion(positive, dataset, resolver(dataset), disputed), false);
  assert.equal(await isConfirmedBehaviorAssertion(positive, dataset, resolver(dataset)), false);

  const confirmed = structuredClone(disputed);
  confirmed.state = "confirmed";
  assert.equal(await isConfirmedBehaviorAssertion(positive, dataset, resolver(dataset), confirmed), true);

  assert.deepEqual(await validateBehaviorAssertion(abstained, dataset, resolver(dataset)), []);
  assert.equal(await isConfirmedBehaviorAssertion(
    abstained,
    dataset,
    resolver(dataset),
    { ...confirmed, assertion: binding(abstained) },
  ), false);

  await assert.rejects(
    validateBehaviorAssertion(fixture("invalid-reference.json"), dataset, resolver(dataset)),
    /unknown normalized event/u,
  );
});

test("rejects wrong-run, changed-digest, stale, dangling, and conflicting assertion identities", async () => {
  const dataset = fixture<NormalizedDataset>("dataset.json");
  const assertion = fixture<LlmJudgeAssertion>("positive.json");
  const disputed = fixture<BehaviorReview>("disputed.review.json");

  const wrongRun = structuredClone(assertion);
  wrongRun.attemptId = "another-attempt";
  await assert.rejects(validateBehaviorAssertion(wrongRun, dataset, resolver(dataset)), /wrong run or attempt/u);

  const changedDigest = structuredClone(assertion);
  changedDigest.dataset.digest = sha("0");
  await assert.rejects(validateBehaviorAssertion(changedDigest, dataset, resolver(dataset)), /dataset version or digest/u);

  await assert.rejects(validateBehaviorAssertion(assertion, dataset, {
    resolve: () => ({ runId: dataset.runId, attemptId: dataset.attemptId, digest: sha("0") }),
  }), /digest mismatch/u);

  const dangling = structuredClone(dataset);
  dangling.nativeRecords = [];
  await assert.rejects(validateBehaviorAssertion({
    ...assertion,
    dataset: { ...assertion.dataset, digest: digest(dangling) },
  }, dangling, resolver(dataset)), /captured native record/u);

  const wrongNative = structuredClone(assertion);
  wrongNative.judgment.citations[0]!.nativeReference.recordLocator = "line:2";
  await assert.rejects(validateBehaviorAssertion(wrongNative, dataset, resolver(dataset)), /does not match its native source/u);

  assert.throws(() => validateBehaviorReview(assertion, {
    ...disputed,
    assertion: { ...disputed.assertion, id: "another-assertion" },
  }), /identity or digest does not match/u);
});

test("rejects undeclared cards, other ontology versions and misplaced values, and keeps proposed review separate from human confirmation", async () => {
  const dataset = fixture<NormalizedDataset>("dataset.json");
  const assertion = fixture<LlmJudgeAssertion>("positive.json");
  const undeclared = structuredClone(assertion);
  undeclared.behavior.cardId = "ZZ-99";

  await assert.rejects(validateBehaviorAssertion(undeclared, dataset, resolver(dataset)), /does not identify one card of behavior ontology 2\.0\.0/u);
  const otherVersion = structuredClone(assertion);
  otherVersion.behavior.ontologyVersion = "1.0.0";
  await assert.rejects(validateBehaviorAssertion(otherVersion, dataset, resolver(dataset)), /does not identify one card/u);
  const retired = { ...structuredClone(assertion), behavior: { vocabularyVersion: "1.0.0", categoryId: "verification-completion", dimensionId: "verification-completion" } } as unknown as BehaviorAssertion;
  await assert.rejects(validateBehaviorAssertion(retired, dataset, resolver(dataset)), /behavior.*(ontologyVersion|additional properties)/u, "a category and dimension reference is not a behavior reference");
  const valence = { ...structuredClone(assertion), judgment: { ...assertion.judgment, verdict: undefined, disposition: "assessed", assessment: "constructive" } } as unknown as BehaviorAssertion;
  await assert.rejects(validateBehaviorAssertion(valence, dataset, resolver(dataset)), /judgment/u, "a valence judgment is not a verdict");
  // VF-01 is a workflow card: it takes no value. VF-03 is a dimension card: present needs exactly one declared value.
  const stray = structuredClone(assertion);
  if (stray.judgment.verdict === "present") stray.judgment.value = "check after the last edit";
  await assert.rejects(validateBehaviorAssertion(stray, dataset, resolver(dataset)), /Only a present verdict on a dimension card carries a value/u);
  const dimension = structuredClone(assertion);
  dimension.behavior.cardId = "VF-03";
  await assert.rejects(validateBehaviorAssertion(dimension, dataset, resolver(dataset)), /needs exactly one value/u);
  if (dimension.judgment.verdict === "present") dimension.judgment.value = "an invented value";
  await assert.rejects(validateBehaviorAssertion(dimension, dataset, resolver(dataset)), /is not a value of behavior card "VF-03"/u);
  if (dimension.judgment.verdict === "present") dimension.judgment.value = "check after the last edit";
  assert.equal((await validateBehaviorAssertion(dimension, dataset, resolver(dataset))).length, 1);
  const absent = structuredClone(dimension);
  absent.judgment = { basis: "cited-evidence", verdict: "absent", confidence: { value: 0.7, scale: "evaluator-reported-0-to-1" }, rationale: "No edit occurs in the record.", alternativeExplanation: "An edit may be unrecorded.", citations: [] };
  assert.deepEqual(await validateBehaviorAssertion(absent, dataset, resolver(dataset)), [], "an absent verdict needs no citation and no value");
  const uncited = structuredClone(assertion);
  uncited.judgment.citations = [];
  await assert.rejects(validateBehaviorAssertion(uncited, dataset, resolver(dataset)), /judgment/u, "a present verdict needs a citation");
  await assert.rejects(isConfirmedBehaviorAssertion(undeclared, dataset, resolver(dataset), {
    schemaVersion: "ebo.behavior-review/v1",
    id: "invalid-confirmation",
    assertion: binding(undeclared),
    state: "confirmed",
    reviewer: { kind: "human", id: "synthetic-fixture-reviewer" },
    rationale: "Synthetic fixture must not confirm an invalid assertion.",
  }), /does not identify one card/u);
  assert.throws(() => validateBehaviorReview(assertion, {
    schemaVersion: "ebo.behavior-review/v1",
    id: "invalid-proposal",
    assertion: binding(assertion),
    state: "proposed",
    reviewer: { kind: "human", id: "must-not-appear" },
  }), /must NOT be valid/u);
});

test("a decision-model result carries probabilities and thresholds, and its verdict follows from them", async () => {
  const dataset = fixture<NormalizedDataset>("dataset.json");
  const result = fixture<DecisionModelAssertion>("decision-model.json");
  assert.equal(isDecisionModelAssertion(result), true);
  assert.equal(result.behavior.ontologyDigest, ONTOLOGY_DIGEST, "the fixture names the shipped card texts");
  assert.deepEqual(await validateBehaviorAssertion(result, dataset, resolver(dataset)), [], "a decision-model result resolves no citations");
  assert.equal(producerLabel(result.producer), "decision-model fixture/fixture-decision-model");

  // The record says what it does not carry: citations, a rationale and an alternative explanation are not fields of this variant.
  for (const field of ["citations", "rationale", "alternativeExplanation", "confidence", "claims"]) {
    await assert.rejects(validateBehaviorAssertion({ ...result, judgment: { ...result.judgment, [field]: field === "citations" || field === "claims" ? [] : "text" } } as unknown as BehaviorAssertion, dataset, resolver(dataset)),
      /behavior assertion/u, `a decision-model result takes no ${field}`);
  }
  await assert.rejects(validateBehaviorAssertion({ ...result, rubric: { id: "rubric", version: "1.0.0" } } as unknown as BehaviorAssertion, dataset, resolver(dataset)), /behavior assertion/u, "a rubric belongs to the LLM judge");

  // The verdict is the probabilities under the recorded thresholds, so a record cannot state another one.
  const overstated = structuredClone(result);
  if ("applies" in overstated.judgment.probabilities) overstated.judgment.probabilities.applies = 0.6;
  await assert.rejects(validateBehaviorAssertion(overstated, dataset, resolver(dataset)), /does not follow from its probabilities and thresholds/u);
  const abstained = structuredClone(overstated);
  abstained.judgment.verdict = "unknown";
  delete abstained.judgment.value;
  assert.deepEqual(await validateBehaviorAssertion(abstained, dataset, resolver(dataset)), [], "between the thresholds the verdict is unknown, the abstention");
  const otherValue = structuredClone(result);
  otherValue.judgment.value = "no check recorded";
  await assert.rejects(validateBehaviorAssertion(otherValue, dataset, resolver(dataset)), /does not follow/u);
  const missingValue = structuredClone(result);
  if ("applies" in missingValue.judgment.probabilities) missingValue.judgment.probabilities.values = { "check after the last edit": 0.9, "an invented value": 0.1 };
  await assert.rejects(validateBehaviorAssertion(missingValue, dataset, resolver(dataset)), /must cover exactly the values/u);

  // A workflow or finding card takes the three-way answer, and a dimension card takes applies and values.
  const workflow = decisionModelAssertion(result, "VF-01", { present: 0.04, nearMiss: 0.21, absent: 0.75 });
  assert.equal(workflow.judgment.verdict, "absent");
  assert.deepEqual(await validateBehaviorAssertion({ ...workflow, id: "workflow" }, dataset, resolver(dataset)), []);
  await assert.rejects(validateBehaviorAssertion({ ...workflow, judgment: { ...workflow.judgment, probabilities: result.judgment.probabilities } }, dataset, resolver(dataset)), /needs present, near-miss and absent probabilities/u);
  await assert.rejects(validateBehaviorAssertion({ ...workflow, judgment: { ...workflow.judgment, probabilities: { present: 0.5, nearMiss: 0.1, absent: 0.1 } } }, dataset, resolver(dataset)), /do not sum to 1/u);
  await assert.rejects(validateBehaviorAssertion({ ...workflow, judgment: { ...workflow.judgment, thresholds: { present: 0.1, absent: 0.9 } } }, dataset, resolver(dataset)), /thresholds need/u);

  // What the model was shown is part of the record and has to be coherent.
  const excerpt = structuredClone(result);
  excerpt.evidence.steps = { included: 1, total: 4 };
  await assert.rejects(validateBehaviorAssertion(excerpt, dataset, resolver(dataset)), /evidence description is inconsistent/u);
  excerpt.evidence.scope = "step-excerpt";
  assert.deepEqual(await validateBehaviorAssertion(excerpt, dataset, resolver(dataset)), []);

  // A review binds a decision-model result like any other, and an abstention is never confirmed.
  const review: BehaviorReview = { schemaVersion: "ebo.behavior-review/v1", id: "review-decision-model", assertion: binding(result), state: "confirmed", reviewer: { kind: "human", id: "synthetic-fixture-reviewer" }, rationale: "Synthetic fixture review." };
  assert.equal(await isConfirmedBehaviorAssertion(result, dataset, resolver(dataset), review), true);
  assert.equal(await isConfirmedBehaviorAssertion(abstained, dataset, resolver(dataset), { ...review, assertion: binding(abstained) }), false);
});

test("a result names the card texts it was judged against, and each mode keeps its own fields", async () => {
  const dataset = fixture<NormalizedDataset>("dataset.json");
  const assertion = fixture<LlmJudgeAssertion>("positive.json");
  const otherTexts = structuredClone(assertion);
  otherTexts.behavior.ontologyDigest = sha("0");
  await assert.rejects(validateBehaviorAssertion(otherTexts, dataset, resolver(dataset)), /judged against other card texts/u);
  const undigested = structuredClone(assertion) as unknown as { behavior: { ontologyDigest?: string } };
  delete undigested.behavior.ontologyDigest;
  await assert.rejects(validateBehaviorAssertion(undigested as unknown as BehaviorAssertion, dataset, resolver(dataset)), /behavior/u);
  // An LLM-judge result cannot borrow the decision-model fields, and a result without a producer is not a result.
  await assert.rejects(validateBehaviorAssertion({ ...assertion, judgment: { ...assertion.judgment, probabilities: { present: 0.9, nearMiss: 0.05, absent: 0.05 } } } as unknown as BehaviorAssertion, dataset, resolver(dataset)), /behavior assertion/u);
  const anonymous = structuredClone(assertion) as unknown as { producer?: unknown };
  delete anonymous.producer;
  await assert.rejects(validateBehaviorAssertion(anonymous as unknown as BehaviorAssertion, dataset, resolver(dataset)), /producer/u);
  const overread = structuredClone(assertion);
  overread.evidence.events = { included: 3, total: 1 };
  await assert.rejects(validateBehaviorAssertion(overread, dataset, resolver(dataset)), /evidence description is inconsistent/u);
});

test("Agent SDK assertion CLI validates through retained native evidence", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "ebo-behavior-cli-"));
  const bundleRoot = await qualifiedBundle(temporary);
  const {dataset} = await createRetainedBehaviorEvidence(bundleRoot);
  const capture = await readQualifiedClaudeAgentSdkCapture(bundleRoot);
  const event = dataset.events[0]!;
  const assertion: LlmJudgeAssertion = {
    ...fixture<LlmJudgeAssertion>("positive.json"),
    id: "assertion-cli",
    runId: dataset.runId,
    attemptId: dataset.attemptId,
    dataset: { schemaVersion: dataset.schemaVersion, digest: digest(dataset) },
    judgment: {
      ...fixture<LlmJudgeAssertion>("positive.json").judgment,
      citations: [{ eventId: event.id, nativeReference: event.source.nativeReference }],
    },
  };
  const path = join(temporary, "assertion.json");
  writeFileSync(path, JSON.stringify(assertion));
  let output = "";

  try {
    assert.equal(await main(["assertions", "validate", bundleRoot, path], (message) => (output += message)), 0);
    assert.match(output, /Validated behavior assertion "assertion-cli" \(1 citation\(s\); review=unreviewed\)/u);
    assert.equal(typeof await createAgentSdkNativeEvidenceResolver(capture).resolve(event.source.nativeReference), "object");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

function fixture<Value>(name: string): Value {
  return JSON.parse(readFileSync(join(fixtureRoot, name), "utf8")) as Value;
}

async function qualifiedBundle(root: string): Promise<string> {
  const start = join(root, "start");
  const final = join(root, "final");
  const bundleRoot = join(root, "bundle");
  mkdirSync(start);
  writeFileSync(join(start, "result.txt"), "before\n");
  cpSync(start, final, { recursive: true, preserveTimestamps: true });
  writeFileSync(join(final, "result.txt"), "after\n");
  const capabilities = probeClaudeAgentSdkCapabilities();
  const definition: RunBundleDefinition = {
    bundleRoot,
    bundleId: "bundle-behavior-cli",
    run: {
      id: "run-behavior-cli",
      assessmentMode: "observational",
      task: { id: "task-behavior-cli" },
      fixture: { id: "fixture-behavior-cli", digest: sha("a") },
      model: { provider: "anthropic", id: "claude-test" },
      harness: { id: "agent-sdk", version: capabilities.sdkVersion },
      runtime: [{ source: "anthropic", name: "agent-sdk", version: capabilities.sdkVersion }],
    },
    attempt: { id: "attempt-behavior-cli", number: 1 },
    configuration: { digest: sha("b"), budgetDigest: sha("c"), toolPolicyDigest: sha("d") },
  };
  const query: ClaudeAgentSdkQuery = (input) => ({
    close: () => undefined,
    async *[Symbol.asyncIterator]() {
      await input.options?.hooks?.SessionStart?.[0]?.hooks[0]?.({
        hook_event_name: "SessionStart",
        session_id: "session-behavior-cli",
        transcript_path: "/restricted/session.jsonl",
        cwd: final,
        source: "startup",
      } as HookInput, undefined, { signal: new AbortController().signal });
      yield {
        type: "assistant",
        uuid: "assistant-behavior-cli",
        session_id: "session-behavior-cli",
        parent_tool_use_id: null,
        message: { role: "assistant", content: [] },
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        duration_ms: 12,
        duration_api_ms: 8,
        is_error: false,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0.01,
        usage: { input_tokens: 3, output_tokens: 2 },
        modelUsage: { "claude-test": { inputTokens: 3, outputTokens: 2, costUSD: 0.01 } },
        permission_denials: [],
        result: "done",
        session_id: "session-behavior-cli",
        uuid: "result-behavior-cli",
      } as unknown as SDKResultMessage;
    },
  });
  const captured = await captureClaudeAgentSdkRun({
    definition,
    startingWorkspacePath: start,
    workspace: { setup: async () => ({ status: "ready", path: final, artifactId: "workspace", retained: true }) },
    configuration: { prompt: "Inspect result.txt.", model: "claude-test", tools: ["Read"], permissionMode: "dontAsk" },
    expectedHooks: ["SessionStart"],
    query,
  });
  assert.equal(captured.qualification.semanticAnalysisUsable, true);
  return bundleRoot;
}

function resolver(dataset: NormalizedDataset): NativeEvidenceResolver {
  return {
    resolve(reference) {
      const record = dataset.nativeRecords.find(({ reference: candidate }) =>
        candidate.artifactId === reference.artifactId && candidate.recordLocator === reference.recordLocator);
      return record === undefined ? false : {
        runId: dataset.runId,
        attemptId: dataset.attemptId,
        digest: record.digest,
      };
    },
  };
}

function binding(assertion: BehaviorAssertion): BehaviorReview["assertion"] {
  return { id: assertion.id, schemaVersion: assertion.schemaVersion, digest: digest(assertion) };
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${digestMetadata(value).value}`;
}

function sha(value: string): `sha256:${string}` {
  return `sha256:${value.repeat(64).slice(0, 64)}`;
}

test("a claim workspace can come from a cwd field inside a JSON-encoded tool result", async () => {
  const { evidenceWorkspaces } = await import("../src/evidence-projection.js");
  // A step whose tool result is a JSON document carried as a string, as some producers write it.
  const step = { step_id: 7, observation: { results: [{ source_call_id: "call-1", content: JSON.stringify({ output: "ok", exit_code: 0, cwd: "/app" }) }] } };
  assert.deepEqual(evidenceWorkspaces(step), ["/app"]);
  assert.deepEqual(evidenceWorkspaces({ content: JSON.stringify(JSON.stringify({ cwd: "/app" })) }), ["/app"], "a doubly encoded result is read too");
  assert.deepEqual(evidenceWorkspaces({ content: "cwd: /app" }), [], "free text naming a directory is not a cwd field");
  assert.deepEqual(evidenceWorkspaces({ cwd: "/app", content: JSON.stringify({ cwd: "/other" }) }), ["/app", "/other"], "two stated directories stay ambiguous");
});
