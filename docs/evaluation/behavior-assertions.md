# Behavior assertions and evidence resolution

`ebo.behavior-assertion/v2` records one verdict on one card of the
[behavior ontology](behavior-ontology.md) for one attempt. The verdict is
`present`, `absent` or `unknown`. One record type holds results from both
producer modes: an LLM judge that cites the events it read, and a decision
model that returns probabilities.

## Fields every result carries

| Field | Meaning |
| :--- | :--- |
| `id`, `runId`, `attemptId` | The result and the attempt it is about |
| `dataset` | Schema version and canonical digest of the normalized dataset |
| `behavior` | `{ ontologyVersion, cardId, ontologyDigest }`: the card, and the digest of the exact ontology text it was judged against |
| `producer` | `{ mode, provider, model, version }`, with an optional `configurationDigest`. `mode` is `llm-judge` or `decision-model` |
| `evidence` | What the producer was shown |
| `judgment` | `basis`, `verdict`, `value` on a present dimension card, and the fields of the producer's mode |

A result never stores the card's direction. A reader looks it up in the
ontology the result names by version and digest.

## LLM-judge results

`producer.mode` is `llm-judge` and `judgment.basis` is `cited-evidence`. The
record also carries the `rubric` identity.

- A `present` verdict retains confidence on the explicit
  `evaluator-reported-0-to-1` scale, a rationale, an alternative explanation
  and at least one citation. Confidence is not a calibrated probability. On a
  dimension card it also names exactly one of the card's values in `value`.
- An `absent` verdict retains confidence, a rationale and an alternative
  explanation. Citations are optional.
- An `unknown` verdict is the abstention. It retains its reason and may name
  the missing event or evidence capability; citations are optional.

`evidence` states that the judge read a selection of the attempt:
`scope: "selected-events"`, the number of events included out of the
attempt's total, the structural observations and occurrence ledger rows
included, how many requested items were omitted or truncated, and the limits
in force (`maxEvidenceItems`, `maxRecordChars`, `maxInputChars`,
`maxCitations`).

## Decision-model results

`producer.mode` is `decision-model` and `judgment.basis` is `probabilities`.
A decision model returns probabilities and nothing else, so this variant has
no citations, rationale, alternative explanation, confidence or rubric, and
the schema rejects them.

```json
{
  "producer": { "mode": "decision-model", "provider": "example", "model": "example-model", "version": "1.0.0" },
  "evidence": {
    "scope": "all-steps",
    "steps": { "included": 212, "total": 212 },
    "rendering": { "id": "ebo-step-excerpt", "version": "1.0.0" },
    "fieldChars": { "min": 30, "max": 430 },
    "budgetChars": 37000
  },
  "judgment": {
    "basis": "probabilities",
    "verdict": "present",
    "value": "check after the last edit",
    "probabilities": {
      "applies": 0.97,
      "values": { "check after the last edit": 0.91, "last edit after the last check": 0.06, "no check recorded": 0.03 }
    },
    "thresholds": { "present": 0.9, "absent": 0.1 }
  }
}
```

- `probabilities` on a workflow or finding card are `present`, `nearMiss` and
  `absent`. On a dimension card they are `applies`, the probability that the
  card applies, and `values`, one probability for each of the card's values.
- `thresholds` are recorded with the result. The verdict is `present` when
  the decisive probability (`present`, or `applies` on a dimension card) is
  at or above `thresholds.present`, `absent` when it is below
  `thresholds.absent`, and `unknown` between the two. `unknown` is the
  abstention. On a present dimension card, `value` is the value with the
  highest probability.
- `evidence` describes what the model was shown: `all-steps` when every
  recorded step was rendered or `step-excerpt` when some were left out, the
  step counts, the rendering's identity, the range each message, argument and
  result was cut to, and the character budget.

`decideFromProbabilities` in `src/behavior-ontology.ts` applies the threshold
rule, and validation rejects a decision-model result whose verdict or value
does not follow from its own probabilities and thresholds.

## The two modes stay apart

Every consumer shows the producer mode with each result. [Aggregation](aggregation.md)
reports each card once per producer, [review samples](human-calibration.md)
count agreement per mode, and [Atlas](../guides/atlas.md) and the viewer label
each result with its mode and let a reader filter by it. No rate combines
results of the two modes.

## Validation

A citation names both a normalized event ID and that event's exact native
source reference. `validateBehaviorAssertion` first applies the existing
normalized-dataset integrity validator, then checks the dataset digest and
assertion identity, the declared card, its ontology digest and its value
rule, and the coherence of the evidence description. For an LLM-judge result
it then checks event ownership, native reference and resolver-provided
run/attempt/digest for every citation. For a decision-model result it checks
the verdict against the probabilities and thresholds. Changed datasets,
foreign attempts, other card texts, dangling events or native records, and
stale digests fail closed.

`ebo.behavior-review/v1` is a separate record bound to the assertion digest.
Its states are `proposed`, `confirmed`, `disputed`, `rejected`, and
`insufficient-evidence`. Proposed records cannot carry a reviewer; all other
states require an explicitly identified human reviewer and rationale. The
library validates human confirmation against the assertion and its native
evidence. Human review is optional: verdict distributions include
assertions independently of review status. `proposed` denotes a
verdict without human adjudication, not a missing evaluation. A producer
cannot set human confirmation itself.

The callable validator accepts any `ebo.normalized-dataset/v1` and its
source-specific native resolver. The current CLI rebuilds and validates the
normalized dataset from a retained Claude Agent SDK, Codex, OpenHands, Pi, or
DeepSeek run bundle through `validateRetainedBehaviorAssertion`:

```sh
ebo assertions validate <run-bundle-root> <assertion.json> [review.json]
```

This command validates contracts and evidence only. It does not run a judge,
change review state, adjudicate a dispute, aggregate results, or build an
Atlas.
