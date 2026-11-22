import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { assertNoDuplicateJsonKeys, digestMetadata, validateArtifact } from "./artifacts.js";
import { validateBehaviorAssertion, type BehaviorProducer, type DecisionModelAssertion, type DecisionModelEvidence } from "./behavior-assertions.js";
import {
  behaviorOntologyDigest, decideFromProbabilities, loadDefaultBehaviorOntology, resolveBehaviorCard,
  type BehaviorCard, type DecisionModelProbabilities, type DecisionThresholds,
} from "./behavior-ontology.js";
import { readCorpusIndex, type CorpusIndexEntry } from "./corpus.js";
import { decide, type DecideOptions, type DecisionAnswer, type DecisionProviderId, type DecisionQuestion } from "./decision-models.js";
import { createRetainedBehaviorEvidence, type RetainedBehaviorEvidence } from "./retained-evidence.js";
import { renderStepExcerpt, type StepExcerpt } from "./step-excerpt.js";

/**
 * Decision-model judging: every recorded step of an attempt, rendered as a step excerpt, is sent to a decision model
 * with the ontology's cards asked in batches. Each card's probabilities become one `ebo.behavior-assertion/v2` result
 * whose verdict follows from the run's thresholds. Results are written per attempt and card batch as JSON Lines, so a
 * rerun skips finished batches and a cohort can be judged in parts.
 */
export const DECISION_MODEL_JUDGE_VERSION = "1.0.0";
export const DEFAULT_CARD_BATCH = 24;
export const DEFAULT_CONCURRENCY = 16;
export const DEFAULT_REQUESTS_PER_SECOND = 7;

/** What the model is told about the trace and a card. The card text comes from the ontology. */
const RULES = "Judge this card against the single recorded trace in the input. Each row has an anchor id, a role, a copied flag, "
  + "a message, tool calls (anchor, tool, arguments) and results (anchor, linked call anchor, content). "
  + "Judge the trigger first: the card does not apply when its trigger or starting situation never occurs. "
  + "A linked error is an observed outcome. Treat '[excerpt gap]' and copied rows as limits.";
const PRESENCE_CRITERIA = {
  present: "The trace shows evidence for every condition of the card's evidence test.",
  "near-miss": "The trace shows something that resembles the card, with an explicit missing or contrary condition.",
  absent: "The card's trigger or situation does not occur in the trace, or the record cannot settle it.",
} as const;
const APPLIES_STATEMENT = "The card applies to this trace: its trigger or starting situation occurs and one of its values can be observed.";
const VALUE_INSTRUCTION = "Assume the card applies and pick the value the trace shows.";

/** A decision model, whatever serves it: one request carries one trace and a batch of typed questions. */
export type DecisionModelProvider = {
  /** Recorded as the result's producer; `mode` is always `decision-model`. */
  readonly producer: Omit<BehaviorProducer<"decision-model">, "mode" | "configurationDigest">;
  ask(state: unknown, questions: Record<string, DecisionQuestion>, signal?: AbortSignal): Promise<{ answers: Record<string, DecisionAnswer> } | { error: string }>;
};

/** Jev on its public System One API (`TYPESAFE_API_KEY`), or another System One provider in EBO's registry. */
export function systemOneDecisionModel(config: { provider: DecisionProviderId; model: string }, options: DecideOptions = {}): DecisionModelProvider {
  // Jev reads inputs beyond its default context length only with this opt-in header.
  const headers: Record<string, string> = config.provider === "typesafe" ? { "TypeSafe-Danger-Zone-Long-Context": "true" } : {};
  return {
    producer: { provider: config.provider, model: config.model, version: DECISION_MODEL_JUDGE_VERSION },
    async ask(state, questions, signal) {
      const record = await decide(config, state, questions, {
        maxRetries: 6, retryStatuses: [408, 429, 500, 502, 503, 504, 529], timeoutMs: 300_000, ...options,
        headers: { ...headers, ...options.headers }, ...(signal === undefined ? {} : { signal }),
      });
      return record.status === "completed" && record.answers !== undefined ? { answers: record.answers } : { error: record.error ?? "Decision request failed." };
    },
  };
}

function cardText(card: BehaviorCard): string {
  const fields = (["title", "definition", "trigger", "evidenceTest", "nearMiss"] as const).flatMap((key) => (card[key] ? [`${key}: ${card[key]}`] : []));
  return `${RULES}\nCARD\n${fields.join("\n")}`;
}

/** The questions for one batch of cards: three-way presence for workflow and finding cards; applies and value for a dimension card. */
export function decisionModelQuestions(cards: readonly BehaviorCard[]): Record<string, DecisionQuestion> {
  const questions: Record<string, DecisionQuestion> = {};
  for (const card of cards) {
    if (card.kind === "dimension") {
      questions[`${card.id}_applies`] = { type: "noul", instructions: `${cardText(card)}\nSTATEMENT\n${APPLIES_STATEMENT}` };
      questions[`${card.id}_value`] = { type: "choice", instructions: `${cardText(card)}\n${VALUE_INSTRUCTION}`,
        criteria: Object.fromEntries(card.values!.map(({ name, test }) => [name, test])) };
    } else {
      questions[card.id] = { type: "choice", instructions: cardText(card), criteria: { ...PRESENCE_CRITERIA } };
    }
  }
  return questions;
}

/** A card's probabilities from the answers to its questions. */
export function probabilitiesFromAnswers(card: BehaviorCard, answers: Record<string, DecisionAnswer>): DecisionModelProbabilities {
  if (card.kind === "dimension") {
    const applies = answers[`${card.id}_applies`], value = answers[`${card.id}_value`];
    if (applies?.type !== "noul" || value?.type !== "choice") throw new Error(`Answers for dimension card "${card.id}" are missing.`);
    return { applies: applies.noul, values: { ...value.probabilities } };
  }
  const answer = answers[card.id];
  if (answer?.type !== "choice") throw new Error(`Answer for card "${card.id}" is missing.`);
  return { present: answer.probabilities.present!, nearMiss: answer.probabilities["near-miss"]!, absent: answer.probabilities.absent! };
}

/** Digest of everything that shapes a request apart from the trace and the cards asked: rules, criteria, rendering. */
export function decisionModelConfigurationDigest(rendering: StepExcerpt["rendering"]): `sha256:${string}` {
  return `sha256:${digestMetadata({ version: DECISION_MODEL_JUDGE_VERSION, rules: RULES, presence: PRESENCE_CRITERIA, applies: APPLIES_STATEMENT, value: VALUE_INSTRUCTION, rendering }).value}`;
}

export type DecisionModelResultInput = {
  runId: string;
  attemptId: string;
  cardId: string;
  probabilities: DecisionModelProbabilities;
  thresholds: DecisionThresholds;
  producer: Omit<BehaviorProducer<"decision-model">, "mode">;
  evidence: DecisionModelEvidence;
  dataset: { schemaVersion: "ebo.normalized-dataset/v1"; digest: `sha256:${string}` };
};

/** One card result from a decision model's probabilities. The verdict and value follow from the thresholds. */
export function decisionModelResult(input: DecisionModelResultInput): DecisionModelAssertion {
  const ontology = loadDefaultBehaviorOntology();
  const behavior = { ontologyVersion: ontology.version, cardId: input.cardId, ontologyDigest: behaviorOntologyDigest(ontology) };
  const card = resolveBehaviorCard(behavior, ontology);
  const decision = decideFromProbabilities(card, input.probabilities, input.thresholds);
  const producer: BehaviorProducer<"decision-model"> = { mode: "decision-model", ...input.producer };
  // The id names one result: this attempt, this card, this producer (configuration included) and these thresholds.
  const id = `decision-model-${input.cardId}-${digestMetadata({ runId: input.runId, attemptId: input.attemptId, cardId: input.cardId, producer, thresholds: input.thresholds }).value.slice(0, 16)}`;
  return {
    schemaVersion: "ebo.behavior-assertion/v2", id, runId: input.runId, attemptId: input.attemptId, dataset: input.dataset, behavior, producer,
    evidence: structuredClone(input.evidence),
    judgment: { basis: "probabilities", ...decision, probabilities: structuredClone(input.probabilities), thresholds: { ...input.thresholds } },
  };
}

export type DecisionModelRunSpec = {
  schemaVersion: "ebo.decision-model-run/v1";
  /** Corpus root and index, relative to the spec file. Every run and import entry is judged. */
  corpusRoot: string;
  corpusIndex: string;
  /** Card identifiers to ask; all cards when omitted. */
  cards?: string[];
  provider: { id: DecisionProviderId; model: string };
  thresholds: DecisionThresholds;
  batchSize?: number;
  concurrency?: number;
  requestsPerSecond?: number;
  /** Output directory, relative to the spec file. */
  output: string;
};

export type DecisionModelRunSummary = {
  attempts: number;
  attemptsWithoutSteps: number;
  batches: { written: number; skipped: number; failed: number };
  requests: number;
  results: number;
  failures: Array<{ runId: string; attemptId: string; batch: string; error: string }>;
  /** Assertion sets on disk for this run's cards, relative to the spec file, ready for an aggregation request's `assertionSets`. */
  assertionSets: Array<{ bundleRoot: string; path: string }>;
};

export type DecisionModelRunOptions = {
  provider?: DecisionModelProvider;
  decide?: DecideOptions;
  signal?: AbortSignal;
  log?: (line: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
};

/** Read and validate a run spec. */
export function readDecisionModelRunSpec(path: string): DecisionModelRunSpec {
  const text = readFileSync(path, "utf8");
  assertNoDuplicateJsonKeys(text);
  const spec = JSON.parse(text) as DecisionModelRunSpec;
  const errors = validateArtifact("Decision-model run", spec);
  if (errors.length > 0) throw new Error(errors.map(({ field, message }) => `${field}: ${message}`).join("\n"));
  const ontology = loadDefaultBehaviorOntology();
  for (const cardId of spec.cards ?? []) resolveBehaviorCard({ ontologyVersion: ontology.version, cardId }, ontology);
  decideFromProbabilities(ontology.cards.find(({ kind }) => kind !== "dimension")!, { present: 1, nearMiss: 0, absent: 0 }, spec.thresholds);
  return spec;
}

const safeSegment = (value: string) => value.replace(/[^A-Za-z0-9._-]/gu, (char) => `%${char.codePointAt(0)!.toString(16).padStart(2, "0")}`);
const batchName = (cards: readonly BehaviorCard[]) => `cards-${createHash("sha256").update(cards.map(({ id }) => id).join(",")).digest("hex").slice(0, 16)}.jsonl`;

function judgedEntries(corpusRoot: string, corpusIndex: string): Array<{ entry: CorpusIndexEntry; bundleRoot: string }> {
  return readCorpusIndex(corpusIndex)
    .filter((entry) => (entry.manifestKind === "run" || entry.manifestKind === "import") && entry.runId !== undefined && entry.attemptId !== undefined)
    .map((entry) => ({ entry, bundleRoot: resolve(corpusRoot, dirname(entry.manifestPath)) }));
}

/** Judge every attempt of a corpus with a decision model. Finished batches are skipped; failed batches are retried on the next run. */
export async function runDecisionModelJudge(specPath: string, options: DecisionModelRunOptions = {}): Promise<DecisionModelRunSummary> {
  const spec = readDecisionModelRunSpec(specPath);
  const base = dirname(resolve(specPath));
  const ontology = loadDefaultBehaviorOntology();
  const wanted = new Set(spec.cards ?? ontology.cards.map(({ id }) => id));
  const cards = ontology.cards.filter(({ id }) => wanted.has(id));
  const size = spec.batchSize ?? DEFAULT_CARD_BATCH;
  const batches = Array.from({ length: Math.ceil(cards.length / size) }, (_, index) => cards.slice(index * size, (index + 1) * size));
  const provider = options.provider ?? systemOneDecisionModel({ provider: spec.provider.id, model: spec.provider.model }, options.decide);
  const output = resolve(base, spec.output);
  const entries = judgedEntries(resolve(base, spec.corpusRoot), resolve(base, spec.corpusIndex));
  const summary: DecisionModelRunSummary = { attempts: entries.length, attemptsWithoutSteps: 0, batches: { written: 0, skipped: 0, failed: 0 }, requests: 0, results: 0, failures: [], assertionSets: [] };
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds)));
  const interval = 1000 / (spec.requestsPerSecond ?? DEFAULT_REQUESTS_PER_SECOND);
  let nextSlot = 0;
  // Requests start no closer together than the configured rate allows, across every worker.
  // At most `concurrency` requests are in flight at once, whatever the number of attempts being prepared.
  const limit = spec.concurrency ?? DEFAULT_CONCURRENCY;
  let inFlight = 0;
  const waiting: Array<() => void> = [];
  const acquire = async () => { if (inFlight >= limit) await new Promise<void>((done) => waiting.push(done)); inFlight += 1; };
  const release = () => { inFlight -= 1; waiting.shift()?.(); };
  const paced = async () => { const now = Date.now(), wait = Math.max(0, nextSlot - now); nextSlot = Math.max(now, nextSlot) + interval; if (wait > 0) await sleep(wait); };

  const judgeAttempt = async ({ entry, bundleRoot }: { entry: CorpusIndexEntry; bundleRoot: string }) => {
    const directory = join(output, safeSegment(entry.runId!), safeSegment(entry.attemptId!));
    const pending = batches.filter((batch) => !existsSync(join(directory, batchName(batch))));
    summary.batches.skipped += batches.length - pending.length;
    if (pending.length > 0) {
      const evidence = await createRetainedBehaviorEvidence(bundleRoot);
      const excerpt = await renderStepExcerpt(bundleRoot, evidence);
      if (excerpt.trace.recordedSteps === 0) { summary.attemptsWithoutSteps += 1; return; }
      await Promise.all(pending.map((batch) => judgeBatch(entry, evidence, excerpt, batch, directory)));
    }
    for (const batch of batches) {
      const path = join(directory, batchName(batch));
      if (existsSync(path)) summary.assertionSets.push({ bundleRoot: relative(base, bundleRoot) || ".", path: relative(base, path) });
    }
  };

  const judgeBatch = async (entry: CorpusIndexEntry, evidence: RetainedBehaviorEvidence, excerpt: StepExcerpt, batch: readonly BehaviorCard[], directory: string) => {
    const name = batchName(batch);
    await acquire();
    let reply: Awaited<ReturnType<DecisionModelProvider["ask"]>>;
    try {
      await paced();
      summary.requests += 1;
      reply = await provider.ask(excerpt.trace, decisionModelQuestions(batch), options.signal);
    } finally {
      release();
    }
    if ("error" in reply) {
      summary.batches.failed += 1;
      summary.failures.push({ runId: entry.runId!, attemptId: entry.attemptId!, batch: name, error: reply.error.slice(0, 512) });
      return;
    }
    const dataset = { schemaVersion: "ebo.normalized-dataset/v1" as const, digest: `sha256:${digestMetadata(evidence.dataset).value}` as const };
    const producer = { ...provider.producer, configurationDigest: decisionModelConfigurationDigest(excerpt.rendering) };
    const evidenceBlock: DecisionModelEvidence = { scope: "all-steps", steps: { included: excerpt.trace.recordedSteps, total: excerpt.trace.recordedSteps },
      rendering: excerpt.rendering, fieldChars: excerpt.fieldChars, budgetChars: excerpt.budgetChars };
    const lines = batch.map((card) => {
      const result = decisionModelResult({ runId: entry.runId!, attemptId: entry.attemptId!, cardId: card.id, probabilities: probabilitiesFromAnswers(card, reply.answers),
        thresholds: spec.thresholds, producer, evidence: evidenceBlock, dataset });
      const errors = validateArtifact("Behavior assertion", result);
      if (errors.length > 0) throw new Error(`Decision-model result for card "${card.id}": ${errors[0]!.field} ${errors[0]!.message}`);
      return JSON.stringify(result);
    });
    mkdirSync(directory, { recursive: true });
    const path = join(directory, name), partial = `${path}.partial`;
    writeFileSync(partial, `${lines.join("\n")}\n`, { mode: 0o600 });
    renameSync(partial, path);
    summary.batches.written += 1;
    summary.results += lines.length;
  };

  const queue = [...entries];
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (options.signal?.aborted) return;
      try {
        await judgeAttempt(next);
      } catch (error) {
        summary.batches.failed += 1;
        summary.failures.push({ runId: next.entry.runId!, attemptId: next.entry.attemptId!, batch: "*", error: (error instanceof Error ? error.message : String(error)).slice(0, 512) });
      }
      options.log?.(`${next.entry.runId}/${next.entry.attemptId}: ${summary.batches.written} written, ${summary.batches.skipped} skipped, ${summary.batches.failed} failed`);
    }
  });
  await Promise.all(workers);
  summary.assertionSets.sort((a, b) => a.path.localeCompare(b.path));
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "run-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return summary;
}

/** One line of results produced elsewhere, written into EBO's record by `importDecisionModelResults`. */
export type DecisionModelResultLine = {
  schemaVersion: "ebo.decision-model-result/v1";
  runId: string;
  attemptId: string;
  cardId: string;
  probabilities: DecisionModelProbabilities;
  producer: Omit<BehaviorProducer<"decision-model">, "mode">;
  evidence: DecisionModelEvidence;
};

/**
 * Write decision-model results produced outside EBO as card results. Every line is checked against its retained
 * attempt (dataset digest, card, probabilities and thresholds) before anything is written; one invalid line writes
 * nothing. Results land beside the command's own, one file per attempt.
 */
export async function importDecisionModelResults(specPath: string, resultsPath: string): Promise<{ attempts: number; results: number; assertionSets: Array<{ bundleRoot: string; path: string }> }> {
  const spec = readDecisionModelRunSpec(specPath);
  const base = dirname(resolve(specPath));
  const output = resolve(base, spec.output);
  // Two streaming passes, so a results file of millions of lines is never one string or one array: the first checks
  // every line's shape, digests the file and notes where each attempt's lines are; the second validates one attempt
  // at a time against its retained evidence and stages its file. Nothing is published unless every line is valid.
  const hash = createHash("sha256"), byAttempt = new Map<string, number[]>();
  let results = 0;
  // The digest is of the file's bytes, so the same results always name the same file.
  for (const { line, number, offset, length } of readLineSpans(resultsPath, (bytes) => hash.update(bytes))) {
    if (line.trim() === "") continue;
    const value = parseResultLine(line, number);
    const key = `${value.runId}\0${value.attemptId}`, spans = byAttempt.get(key);
    if (spans) spans.push(offset, length, number); else byAttempt.set(key, [offset, length, number]);
    results += 1;
  }
  const entries = new Map(judgedEntries(resolve(base, spec.corpusRoot), resolve(base, spec.corpusIndex)).map((item) => [`${item.entry.runId}\0${item.entry.attemptId}`, item]));
  for (const key of byAttempt.keys()) if (!entries.has(key)) {
    const [runId, attemptId] = key.split("\0");
    throw new Error(`Results name attempt "${runId!}/${attemptId!}", which the corpus index does not contain.`);
  }
  const name = `imported-${hash.digest("hex").slice(0, 16)}.jsonl`;
  const staged: Array<{ partial: string; path: string; bundleRoot: string }> = [];
  const created: string[] = [];
  const fd = openSync(resultsPath, "r");
  try {
    for (const [key, spans] of byAttempt) {
      const item = entries.get(key)!;
      const evidence = await createRetainedBehaviorEvidence(item.bundleRoot);
      const dataset = { schemaVersion: "ebo.normalized-dataset/v1" as const, digest: `sha256:${digestMetadata(evidence.dataset).value}` as const };
      const own: DecisionModelAssertion[] = [];
      for (let i = 0; i < spans.length; i += 3) {
        const bytes = Buffer.allocUnsafe(spans[i + 1]!);
        readSync(fd, bytes, 0, bytes.length, spans[i]!);
        const line = parseResultLine(bytes.toString("utf8"), spans[i + 2]!);
        const result = decisionModelResult({ ...line, thresholds: spec.thresholds, dataset });
        await validateBehaviorAssertion(result, evidence.dataset, evidence.resolver, undefined, evidence.capture);
        own.push(result);
      }
      if (new Set(own.map(({ id }) => id)).size !== own.length) throw new Error(`Results for attempt "${own[0]!.runId}/${own[0]!.attemptId}" repeat a card.`);
      const directory = join(output, safeSegment(item.entry.runId!), safeSegment(item.entry.attemptId!));
      const made = mkdirSync(directory, { recursive: true });
      if (made !== undefined) created.push(made);
      const path = join(directory, name), partial = `${path}.partial`;
      writeFileSync(partial, `${own.map((result) => JSON.stringify(result)).join("\n")}\n`, { flag: "wx", mode: 0o600 });
      staged.push({ partial, path, bundleRoot: item.bundleRoot });
    }
  } catch (error) {
    // An invalid file writes nothing: staged files and the directories made for them are removed.
    for (const { partial } of staged) rmSync(partial, { force: true });
    for (const directory of created.reverse()) rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally { closeSync(fd); }
  for (const { partial, path } of staged) renameSync(partial, path);
  return { attempts: staged.length, results, assertionSets: staged.map(({ path, bundleRoot }) => ({ bundleRoot: relative(base, bundleRoot) || ".", path: relative(base, path) })) };
}

function parseResultLine(line: string, number: number): DecisionModelResultLine {
  assertNoDuplicateJsonKeys(line);
  const value = JSON.parse(line) as DecisionModelResultLine;
  const errors = validateArtifact(`Result line ${String(number)}`, value);
  if (errors.length > 0) throw new Error(`Result line ${String(number)} ${errors[0]!.field}: ${errors[0]!.message}`);
  return value;
}

/** Each line of a file with its 1-based number and byte span, read in chunks. */
function* readLineSpans(path: string, onBytes: (bytes: Buffer) => void): Generator<{ line: string; number: number; offset: number; length: number }> {
  const fd = openSync(path, "r"), chunk = Buffer.allocUnsafe(1 << 20);
  let pending = Buffer.alloc(0), start = 0, number = 0, size: number;
  try {
    while ((size = readSync(fd, chunk, 0, chunk.length, null)) !== 0) {
      onBytes(chunk.subarray(0, size));
      const data = Buffer.concat([pending, chunk.subarray(0, size)]);
      let from = 0, newline: number;
      while ((newline = data.indexOf(10, from)) !== -1) {
        yield { line: data.toString("utf8", from, newline), number: ++number, offset: start, length: newline - from };
        start += newline - from + 1; from = newline + 1;
      }
      pending = Buffer.from(data.subarray(from));
    }
    if (pending.length) yield { line: pending.toString("utf8"), number: ++number, offset: start, length: pending.length };
  } finally { closeSync(fd); }
}
