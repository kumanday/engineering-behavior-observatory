# Behavior ontology

The EBO behavior ontology is the vocabulary every behavior judgment uses. It
is a data file,
[`ontology/behavior-ontology.v2.json`](../../ontology/behavior-ontology.v2.json)
(`ebo.behavior-ontology/v2`, version `2.0.0`): 93 cards in 11 families. A card
describes one thing an engineering agent does in a recorded trajectory,
written so that a reader can decide from the record whether it happened. The
[ontology reference](../reference/behavior-ontology.md) lists every card and
is generated from the file.

The ontology was derived from the public Harness Leaderboard trajectories.
Candidate behaviors found by reading the trajectories were consolidated into
93 cards, and the cards were then applied to the whole corpus of 68,383
trajectories. Two blind audits by a separate reader, on 160 trajectories in
all, measured that classification at an AUC of 0.96 and 0.95.

## What a card contains

| Field | Meaning |
| :--- | :--- |
| `id`, `title`, `family` | A stable identifier such as `VF-03`, a short title, and the family the identifier's prefix names |
| `kind` | `workflow`, `dimension` or `finding` |
| `definition` | The behavior in one or two sentences |
| `trigger` | The observable event that must occur before the card applies; 29 cards state one |
| `evidenceTest` | What to look for in the record to decide the card |
| `nearMiss` | Records that resemble the behavior and do not count |
| `significance` | How the card changes the reading of a record; present on 72 cards |
| `direction` | On a workflow or finding card: what the card means in a comparison when it is present. One of `favourable`, `unfavourable`, `neutral` |
| `values` | The named outcomes of a dimension card, each with its own test and its own `direction` |
| `unit` | The span one judgment covers: `trajectory`, `episode`, `call-result` or `change` |
| `layers` | One or more of `strategy`, `interface`, `evidence`, `verification` and `architecture` |
| `proposedClassification` | `rule`, `classifier` or `judgment`: a proposal for how the card could be decided |
| `parent`, `related` | Links to other cards by identifier |

## Three kinds of card

- A **workflow** card (25) describes a common practice, such as reading the
  affected files before the first edit.
- A **dimension** card (29) describes a situation with several outcomes and
  names them. "Final check relative to the last edit" has the values *check
  after the last edit*, *last edit after the last check* and *no check
  recorded*. Value names are unique within a card.
- A **finding** card (39) describes a specific situation, such as a completion
  claim with no linked verifier evidence.

## Verdicts

A judgment on a card is one of three verdicts.

| Verdict | Meaning | From an LLM judge | From a decision model |
| :--- | :--- | :--- | :--- |
| `present` | The card's situation occurred and its evidence test passed | At least one citation that resolves to a retained native record, a rationale, an alternative explanation and a confidence | The decisive probability is at or above the `present` threshold |
| `absent` | The trigger or the test did not occur in the visible record | A rationale, an alternative explanation and a confidence. Citations are optional, since absence may have no event to cite | The decisive probability is below the `absent` threshold |
| `unknown` | The record does not settle the card. This is the abstention | A reason, a rationale and an alternative explanation | The decisive probability lies between the two thresholds |

On a dimension card a `present` verdict names exactly one of the card's
values in `value`. Workflow and finding cards never carry one. The verdict
list and the value rule have one definition, `BEHAVIOR_VERDICTS` and
`resolveBehaviorDecision` in `src/behavior-ontology.ts`, which assertions,
both judge lanes, aggregation and Atlas all use.

A [behavior assertion](behavior-assertions.md) records which of the two
produced a verdict. An LLM judge reads a selection of an attempt's events and
cites the ones its verdict rests on. A decision model reads every recorded
step and returns probabilities: `present`, `nearMiss` and `absent` for a
workflow or finding card, and for a dimension card the probability that it
applies and one probability per value. The thresholds that turn those
probabilities into a verdict are stored with the result.

## Direction

A card states a fact about the record. Its direction says what that fact
means when two harnesses or models are compared: `favourable`, `unfavourable`
or `neutral`. A workflow or finding card has one direction, read when the
card is present. A dimension card has none of its own; each of its values
has one, so "check after the last edit" is favourable and "no check recorded"
is unfavourable on the same card.

| | Favourable | Unfavourable | Neutral |
| :--- | ---: | ---: | ---: |
| Workflow cards (25) | 23 | 1 | 1 |
| Finding cards (39) | 9 | 17 | 13 |
| Dimension values (68) | 21 | 21 | 26 |

A card's kind does not give its direction. Nine finding cards are favourable,
and one workflow card, "Identical retry after a failure", is unfavourable.
Read the direction from the card or the value.

Directions were assigned by two independent reads of the card texts. The two
reads agreed on 120 of the 132 entries, and the rest were set conservatively,
10 of them to neutral.

Direction is fixed in the ontology. No judge decides it and no result stores
it: a consumer looks it up with `behaviorDirection`, using the ontology
version and digest the result names. [Aggregation](aggregation.md) reports
the share of favourable, unfavourable and neutral results beside the per-card
rates. Neutral results are counted and never scored.

## Coding rules

The ontology carries four rules in `codingRules` that apply to every card. The
judge receives them with the card.

1. A card is absent when its trigger does not occur in the visible record.
   Judge the trigger first.
2. Code unknown when the record lacks the steps a test needs, such as the
   first edit or the closing message.
3. A linked error is an observed outcome. Only a missing result row is an
   unobserved one.
4. For a dimension, report the trigger and then exactly one value per episode.

One [behavior assertion](behavior-assertions.md) holds one verdict for one
attempt and card. When a dimension card's situation occurs several times in an
attempt, the assertion states the value the judge finds for the attempt as a
whole.

## Name a card in a record

A record refers to a card by ontology version and card identifier:

```json
{ "ontologyVersion": "2.0.0", "cardId": "VF-03" }
```

[Judge requests](semantic-judge.md), judge inputs, behavior assertions,
[aggregation reports](aggregation.md), [review samples](human-calibration.md)
and [Atlas bundles](atlas-bundles.md) all use this reference. A reference to
another ontology version or to an identifier the ontology does not declare
fails validation.

## Use the ontology in code

```ts
import {
  behaviorCardFamilies,
  behaviorDirection,
  behaviorOntologyDigest,
  decideFromProbabilities,
  loadDefaultBehaviorOntology,
  resolveBehaviorCard,
  resolveBehaviorDecision,
} from "engineering-behavior-observatory";

const ontology = loadDefaultBehaviorOntology();
const families = behaviorCardFamilies(ontology);
const card = resolveBehaviorCard({ ontologyVersion: "2.0.0", cardId: "VF-03" });
resolveBehaviorDecision({ ontologyVersion: "2.0.0", cardId: "VF-03" }, { verdict: "present", value: "no check recorded" });
behaviorDirection(card, { verdict: "present", value: "no check recorded" }); // "unfavourable"
decideFromProbabilities(card, {
  applies: 0.97,
  values: { "check after the last edit": 0.91, "last edit after the last check": 0.06, "no check recorded": 0.03 },
}, { present: 0.9, absent: 0.1 }); // { verdict: "present", value: "check after the last edit" }
const digest = behaviorOntologyDigest(ontology);
```

`loadDefaultBehaviorOntology` validates the shipped file once and returns a
frozen object. `assertBehaviorOntology` validates any other ontology against
[`schemas/behavior-ontology.v2.json`](../../schemas/behavior-ontology.v2.json)
and then checks what a schema cannot state: every card belongs to a declared
family and carries its prefix, every family has a card, value names are unique
within a card, and `parent` and `related` resolve to other cards without a
cycle. `behaviorOntologyDigest` returns the canonical digest of an ontology,
which identifies the exact card texts a result was produced against.

After changing the ontology file, regenerate the reference page:

```sh
npm run build && node dist/test/behavior-ontology-write.js
```

`npm test` fails when the page and the file differ.
