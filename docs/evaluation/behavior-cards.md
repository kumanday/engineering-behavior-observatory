# Behavior cards

A behavior card describes one thing an engineering agent does in a recorded
trajectory, written so that a reader can decide from the record whether it
happened. The catalog is the data file
[`ontology/behavior-cards.v3.json`](../../ontology/behavior-cards.v3.json)
(`ebo.behavior-card-catalog/v1`): 93 cards in 11 families. The
[card reference](../reference/behavior-cards.md) lists every card and is
generated from that file.

The catalog is a draft. Its cards were consolidated from a larger registry
built by reading public Harness Leaderboard trajectories, and the merges are
pending review. The file says so in `stage`, and its version is
`3.0.0-draft.1`. Version 3 follows the eight-category vocabulary, which is
version 1, and an intermediate registry that was never shipped. Expect titles,
tests and values to change before `stage` becomes `reviewed`.

## What a card contains

| Field | Meaning |
| :--- | :--- |
| `id`, `title`, `family` | A stable identifier such as `VF-03`, a short title, and the family the identifier's prefix names |
| `kind` | `workflow`, `dimension` or `finding` |
| `definition` | The behavior in one or two sentences |
| `trigger` | The observable event that must occur before the card applies, or `null` when the card records none |
| `evidenceTest` | What to look for in the record to decide the card |
| `nearMiss` | Records that resemble the behavior and do not count |
| `significance` | How the card changes the reading of a record; present on 72 cards |
| `values` | The named outcomes of a dimension card, each with its own test |
| `unit` | The span one judgment covers: `trajectory`, `episode`, `call-result` or `change` |
| `layers` | One or more of `strategy`, `interface`, `evidence`, `verification` and `architecture` |
| `status` | `active` or `rewritten-untested` |
| `proposedClassification` | `rule`, `classifier` or `judgment`: an untested proposal for how the card could be decided |
| `parent`, `related` | Links to other cards by identifier |

## Three kinds of card

- A **workflow** card (25) describes a common practice, such as reading the
  affected files before the first edit. It is present or absent.
- A **dimension** card (29) describes a situation with several outcomes and
  names them. "Final check relative to the last edit" has the values *check
  after the last edit*, *last edit after the last check* and *no check
  recorded*. A reader first decides whether the situation occurred, then picks
  exactly one value. Value names are unique within a card.
- A **finding** card (39) describes a specific situation, such as a completion
  claim with no linked verifier evidence. It is present or absent.

## Status

Status records how a card fared when candidate cases were checked against the
source trajectories during discovery.

- `active` (64 cards): confirmed on at least 5 tasks, and at least 30% of
  sampled candidate cases passed the source check.
- `rewritten-untested` (29 cards): confirmed on at least 5 tasks, but under
  30% of sampled candidates passed with the earlier evidence test. Most
  rejected candidates were traces where the card's situation never occurred,
  so each of these cards now starts with a `trigger`, and its evidence test
  and near miss were rewritten from the reviewers' rejection reasons. The new
  text has not been run on any trajectory.

Treat a result on a `rewritten-untested` card as weaker than a result on an
`active` card until the rewritten test has been measured.

## Coding rules

The catalog carries four rules in `codingRules` that apply to every card:

1. A card is absent when its trigger does not occur in the visible record.
   Judge the trigger first.
2. Code unknown when the record lacks the steps a test needs, such as the
   first edit or the closing message.
3. A linked error is an observed outcome. Only a missing result row is an
   unobserved one.
4. For a dimension, report the trigger and then exactly one value per episode.

The second rule matches EBO's handling of missing evidence: a record that
cannot show a step is unknown for that card.

## Cards and the behavior vocabulary

[Behavior assertions](behavior-assertions.md) and
[judge requests](semantic-judge.md) name a category and dimension from
`ebo.behavior-vocabulary/v1`, the eight-category file at
[`ontology/behavior-categories.v1.json`](../../ontology/behavior-categories.v1.json).
That contract is unchanged. Assertions, judge requests, aggregation, human
calibration and Atlas read the eight categories exactly as before, and
retained version 1 material stays valid.

The card catalog ships beside the vocabulary. A rubric author can copy a
card's definition, trigger, evidence test and near miss into the rubric
instructions of a judge request today. No current record type refers to a card
by identifier.

## Use the catalog in code

```ts
import {
  behaviorCardCatalogDigest,
  behaviorCardFamilies,
  loadDefaultBehaviorCardCatalog,
} from "engineering-behavior-observatory";

const catalog = loadDefaultBehaviorCardCatalog();
const dimensions = catalog.cards.filter((card) => card.kind === "dimension");
const families = behaviorCardFamilies(catalog);
const digest = behaviorCardCatalogDigest(catalog);
```

`loadDefaultBehaviorCardCatalog` validates the shipped file once and returns a
frozen object. `assertBehaviorCardCatalog` validates any other catalog against
[`schemas/behavior-cards.v1.json`](../../schemas/behavior-cards.v1.json) and
then checks what a schema cannot state: every card belongs to a declared
family and carries its prefix, every family has a card, value names are unique
within a card, and `parent` and `related` resolve to other cards without a
cycle. The schema itself requires `values` on dimension cards only and a
`trigger` on every `rewritten-untested` card. `behaviorCardCatalogDigest`
returns the canonical digest of a catalog, which identifies the exact card
texts a result was produced against.

After changing the catalog, regenerate the reference page:

```sh
npm run build && node dist/test/behavior-cards-write.js
```

`npm test` fails when the page and the catalog differ.
