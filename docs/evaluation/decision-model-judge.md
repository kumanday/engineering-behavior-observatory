# Decision-model judging

`ebo judge decision-model` judges whole cohorts against the
[behavior ontology](behavior-ontology.md). For each attempt it renders every
recorded step, asks a decision model about the cards in batches, and writes
one [card result](behavior-assertions.md) per attempt and card. It is the
suggested way to judge many attempts. Use the
[LLM judge](semantic-judge.md) when a result has to cite the steps it rests
on, such as an audit.

```sh
ebo judge decision-model study/decision-model.json
```

## What the model reads

The model reads a **step excerpt**: every step of the attempt, in order, with
each field cut so that the whole trace stays near 37,000 characters.

- A field's limit is `37,000 ÷ (3 × steps)`, kept between 30 and 430
  characters. The first 10 and the last 5 steps get three times that, up to
  3,600 characters. If the result still exceeds 380,000 characters, every
  field is cut to at most 320.
- A cut field keeps its first three quarters and its last quarter of the
  limit around an `[excerpt gap]` marker. No step is dropped.
- Fields named like credentials are replaced with `[redacted]`. Secrets in text,
  home directories and the evaluated model's names are removed before
  cutting.
- An ATIF import is rendered from its own steps: message, tool calls and
  results, with the copied-context flag. A native capture is rendered from its
  normalized events: each message starts a step, and each tool operation joins
  the model turn that issued it.

Each result's `evidence` block records this: `scope: "all-steps"`, the step
count, the rendering (`ebo-step-excerpt-atif` or `ebo-step-excerpt-events`,
version `1.0.0`), the smallest and largest field limit used, and the budget.

## What the model is asked

One request carries the excerpt and the questions for a batch of cards (24 by
default). Every question includes the card's title, definition, trigger,
evidence test and near miss.

- A **workflow or finding card** is one choice between `present`,
  `near-miss` and `absent`. Its result stores the three probabilities.
- A **dimension card** is two questions: the probability that the card
  applies, and a choice between its named values assuming it applies. Its
  result stores both.

The run's thresholds turn probabilities into a verdict. The decisive
probability (`present`, or `applies` on a dimension card) at or above
`thresholds.present` is `present`, below `thresholds.absent` is `absent`, and
anything between is `unknown`, the model's abstention. On a present dimension
card the value is the most probable one. Thresholds are stored in each result,
and validation rejects a result whose verdict does not follow from them.

A decision-model result has no citations, rationale or alternative
explanation. It says how strongly the model judged the card to apply, given a
cut-down view of every step.

## The run file

```json
{
  "schemaVersion": "ebo.decision-model-run/v1",
  "corpusRoot": "corpus",
  "corpusIndex": "corpus/index.jsonl",
  "cards": ["VF-03", "TI-03"],
  "provider": { "id": "typesafe", "model": "jev-1.14.0" },
  "thresholds": { "present": 0.9, "absent": 0.1 },
  "batchSize": 24,
  "concurrency": 16,
  "requestsPerSecond": 7,
  "output": "derived/decision-model"
}
```

| Field | Meaning |
| :--- | :--- |
| `corpusRoot`, `corpusIndex` | The corpus to judge, built with `ebo corpus build`. Every run and import entry is judged, including a whole imported cohort |
| `cards` | Cards to ask; all 93 when omitted |
| `provider` | A System One decision model: `typesafe` (Jev, `TYPESAFE_API_KEY`) or `fireworks` (`FIREWORKS_API_KEY`) |
| `thresholds` | `0 < absent ≤ present ≤ 1`. Keep them fixed across compared cohorts |
| `batchSize` | Cards per request, 24 by default |
| `concurrency` | Requests in flight at once, 16 by default |
| `requestsPerSecond` | The highest request start rate, 7 by default |
| `output` | Where results are written |

Paths are relative to the run file. Credentials come from the environment and
are never written.

The example uses the operating point at which Jev was measured on ATIF
trajectories, 0.9 for present and 0.1 for absent. On two blind audits of 160
trajectories by an independent reader, Jev scored an AUC of 0.939 and 0.930,
and its results at 0.9 or above agreed with the reader 95.9% and 96.7% of the
time. Other thresholds, other models and native captures have not been
measured.

## Large cohorts

- **Resumable.** Results are written per attempt and card batch, to
  `<output>/<run>/<attempt>/cards-<digest>.jsonl`, each file complete before
  it appears. A rerun skips every batch whose file exists, so an interrupted
  run continues where it stopped.
- **In parts.** A run with another `cards` list writes other batch files next
  to the first. A cohort can be judged a few cards at a time.
- **Rate limits.** Requests are paced to `requestsPerSecond` and capped at
  `concurrency`. A 408, 429, 500, 502, 503, 504 or 529 response is retried up
  to six times, honouring `Retry-After`. A batch that still fails is reported
  and left unwritten, and the next run retries it. The command exits 1 while
  any batch has failed.
- An attempt with no recorded steps gets no request and is counted.

`<output>/run-summary.json` counts attempts, batches written, skipped and
failed, requests and results. It also lists the result files for the run's
cards as `assertionSets`.

## Aggregate the results

An [aggregation request](aggregation.md) reads result files through
`sources.assertionSets`, one entry per file:

```json
"assertionSets": [
  { "bundleRoot": "corpus/attempt-a", "path": "derived/decision-model/run-a/attempt-a/cards-0f3c2a91d4e5b6a7.jsonl" }
]
```

Copy the list from `run-summary.json`. Aggregation reports decision-model
results apart from LLM-judge results, per card and producer, and Atlas and the
viewer show one producer mode at a time.

## Write results produced elsewhere

Results from another decision-model pipeline can be written as EBO card results
when they name an attempt in the corpus. Write one JSON line per attempt and
card:

```json
{"schemaVersion": "ebo.decision-model-result/v1", "runId": "run-a", "attemptId": "attempt-a", "cardId": "TI-03",
 "probabilities": {"present": 0.08, "nearMiss": 0.04, "absent": 0.88},
 "producer": {"provider": "example", "model": "example-model", "version": "1.0.0"},
 "evidence": {"scope": "step-excerpt", "steps": {"included": 180, "total": 212}, "rendering": {"id": "example-excerpt", "version": "1"}, "fieldChars": {"min": 40, "max": 400}, "budgetChars": 40000}}
```

Then import them with the run file's corpus, thresholds and output:

```sh
ebo judge decision-model import study/decision-model.json results.jsonl
```

Each line is checked against its retained attempt: the attempt exists in the
corpus, the card exists, the probabilities have the card's shape and sum to 1,
and the verdict follows from the thresholds. If any line fails, nothing is
written. The file is read in two streaming passes, so a file of millions of
lines needs memory for one attempt's results at a time. Valid results are written to `<output>/<run>/<attempt>/imported-<digest>.jsonl`
and listed for `assertionSets`. The `evidence` block must describe what the
external model was actually shown.

## In code

`runDecisionModelJudge` and `importDecisionModelResults` implement the two
commands. `DecisionModelProvider` is the interface a decision model meets: a
producer identity and an `ask(state, questions)` that returns typed answers.
`systemOneDecisionModel` adapts any provider of EBO's System One client, and
`decisionModelResult` builds one card result from probabilities.
`renderStepExcerpt` renders an attempt the way the command does.
