# Behavior assertions and evidence resolution

`ebo.behavior-assertion/v1` records one verdict on one card of the
[behavior ontology](behavior-ontology.md) for one attempt. The verdict is
`present`, `absent` or `unknown`.

Each assertion binds the normalized-dataset schema version and canonical
digest, run and attempt IDs, the card as `{ ontologyVersion, cardId }`, and
evaluator/rubric identities.

- A `present` verdict retains confidence on the explicit
  `evaluator-reported-0-to-1` scale, a rationale, an alternative explanation
  and at least one citation. Confidence is not a calibrated probability. On a
  dimension card it also names exactly one of the card's values in `value`.
- An `absent` verdict retains confidence, a rationale and an alternative
  explanation. Citations are optional.
- An `unknown` verdict is the abstention. It retains its reason and may name
  the missing event or evidence capability; citations are optional.

A citation names both a normalized event ID and that event's exact native
source reference. `validateBehaviorAssertion` first applies the existing
normalized-dataset integrity validator, then checks the dataset digest and
assertion identity, the declared card and its value rule, event ownership, native reference, and
resolver-provided run/attempt/digest. Changed datasets, foreign attempts,
dangling events or native records, and stale digests fail closed.

`ebo.behavior-review/v1` is a separate record bound to the assertion digest.
Its states are `proposed`, `confirmed`, `disputed`, `rejected`, and
`insufficient-evidence`. Proposed records cannot carry a reviewer; all other
states require an explicitly identified human reviewer and rationale. The
library validates human confirmation against the assertion and its native
evidence. Human review is optional: verdict distributions include
assertions independently of review status. `proposed` denotes a
verdict without human adjudication, not a missing evaluation. A judge
assertion cannot set human confirmation itself.

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
