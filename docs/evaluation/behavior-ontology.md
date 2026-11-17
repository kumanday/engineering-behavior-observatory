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
| `values` | The named outcomes of a dimension card, each with its own test |
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

| Verdict | Meaning | What the record must carry |
| :--- | :--- | :--- |
| `present` | The card's situation occurred and its evidence test passed | At least one citation that resolves to a retained native record, a rationale, an alternative explanation and a confidence. On a dimension card, exactly one of the card's value names in `value` |
| `absent` | The trigger or the test did not occur in the visible record | A rationale, an alternative explanation and a confidence. Citations are optional, since absence may have no event to cite |
| `unknown` | The record lacks the steps the test needs | A reason, a rationale and an alternative explanation. This is the abstention |

A value appears only on a `present` verdict of a dimension card. Workflow and
finding cards never carry one. The verdict list and the value rule have one
definition, `BEHAVIOR_VERDICTS` and `resolveBehaviorDecision` in
`src/behavior-ontology.ts`, which assertions, both judge lanes, aggregation
and Atlas all use.

A verdict states a fact about the record. Whether a present card is good or
bad depends on the card: "Checks run after a change" is a practice, and
"Completion claims without linked verifier evidence" is a problem.

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
  behaviorOntologyDigest,
  loadDefaultBehaviorOntology,
  resolveBehaviorCard,
  resolveBehaviorDecision,
} from "engineering-behavior-observatory";

const ontology = loadDefaultBehaviorOntology();
const families = behaviorCardFamilies(ontology);
const card = resolveBehaviorCard({ ontologyVersion: "2.0.0", cardId: "VF-03" });
resolveBehaviorDecision({ ontologyVersion: "2.0.0", cardId: "VF-03" }, { verdict: "present", value: "no check recorded" });
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
