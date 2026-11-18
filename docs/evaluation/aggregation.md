# Comparison and aggregation

`ebo aggregate build` creates a deterministic local read model from a current
corpus index, structural observations, model behavior assessments, optional human
calibration lineage, and per-measure comparison eligibility reports. It reads
JSON/JSONL directly and writes one derived JSON document outside the source
corpus; it does not alter retained bundles.

```sh
ebo aggregate build request.json aggregate.json
```

The request uses paths relative to `request.json`:

```json
{
  "schemaVersion": "ebo.aggregation-request/v2",
  "sources": {
    "corpusRoot": "corpus",
    "corpusIndex": "corpus-index.jsonl",
    "observationSets": [{ "bundleRoot": "corpus/run-a", "path": "derived/observations/run-a.json" }],
    "assertions": [{ "bundleRoot": "corpus/run-a", "path": "derived/assertions/assertion-a.json" }],
    "calibrations": []
  },
  "groupBy": ["task", "model", "harness"],
  "selectedAttemptPolicy": "all-attempts",
  "recurrence": { "minimumOccurrences": 2 },
  "comparisons": [{
    "id": "matched-verifier-outcome",
    "measure": "verified:verifier-passed",
    "left": { "model": "model-a" },
    "right": { "model": "model-b" },
    "matchBy": ["task", "harness", "trial"],
    "eligibilityGates": [{
      "request": "derived/comparisons/model-a-model-b.request.json",
      "report": "derived/comparisons/model-a-model-b.report.json"
    }]
  }]
}
```

`sources.assertions` lists single card-result files. `sources.assertionSets`
lists JSON Lines files with one card result per line, bound to one bundle each;
[decision-model judging](decision-model-judge.md) writes its results this way
and lists the files in its run summary.

Grouping dimensions are `task`, `model`, `harness`, `trial`, and
`capture-qualification`. `all-attempts` is the evidence-preserving default.
`trial` is the queue's retained numeric trial index; legacy bundles without it
remain unavailable and are excluded from trial-matched comparisons.
`latest-attempt-per-run` selects the highest declared attempt number regardless
of terminal state and reports every excluded earlier attempt; it never searches
for or substitutes a completed retry.

Each metric names its run, attempt, operation, assertion, or reviewed-assertion
population and carries numerator, denominator, units, exclusions, and a claim
status. Empty denominators are `unavailable`. Observational completion is only
a terminal-state measure; task-success rates come only from available verified
attempt outcomes. Duplicate identical inputs are counted once, while conflicting
records with the same identity fail the build.

The four assertion metrics (`assertion-abstention-rate`,
`reviewed-assertion-confirmed-rate`, `review-unresolved-rate` and
`review-disputed-rate`) count results of one producer mode. When a group holds
results of both modes, those four are `unavailable`, and the group carries
each of them once per mode with the mode as a suffix, such as
`assertion-abstention-rate:llm-judge` and
`assertion-abstention-rate:decision-model`.

Each group's additive `behaviors` array reports one entry per
[behavior card](behavior-ontology.md), ordered by family and then by card as
the ontology orders them, separately from review agreement. An entry names the
card as `{ ontologyVersion, cardId, ontologyDigest }`, its `family` and its
`producer`: mode, provider, model, version and configuration digest. An
LLM-judge entry also names its rubric id and version. Each producer gets its
own entry for a card, so a card judged by an LLM judge and by a decision model
appears twice and the two sets of counts are never added together. A producer
without a configuration digest stays a separate entry.

`verdicts` is the distribution over `present`, `absent` and `unknown`. Its
denominator is distinct judged attempt-cards (`judged-attempt-card`), not
judge calls: agreeing reruns count once, and reruns that disagree on the
verdict or on the value exclude that attempt as `conflicting-judge-reruns`. An
`unknown` verdict counts in the distribution.

A dimension card also has `values`: each named value's count among the
attempts judged present (`present-attempt-card`), with the absent and unknown
attempts listed as exclusions.

Each group's `directions` array is the second view of the same results. Its
producers are the ones of the per-card entries: the full `producer`,
configuration digest included, and for an LLM judge the `rubric`. It has one
entry per producer and family, and one more per producer for all families
together (`family: "all"`). The ontology fixes a
[direction](behavior-ontology.md#direction) for every present result:
`favourable`, `unfavourable` or `neutral`. An entry reports two shares for
each direction:

- `results`: present results of that direction among all present results
  (`present-attempt-card`);
- `attempts`: attempts with at least one present result of that direction
  among the attempts that producer judged (`judged-attempt`). An attempt can
  count under more than one direction.

Neutral results are counted and never scored: the report gives the three
shares and does not combine them into one number. Reruns of one attempt and
card that disagree are excluded as `conflicting-judge-reruns`, as in the
per-card rates. Read the direction shares next to the per-card rates; the
shares say how a cohort member's results lean, and the rates say which
behaviors produce that lean.

Human review is optional: unreviewed, disputed, and rejected verdicts remain
model judgments in this population, not human-endorsed findings. Assertion
references expose review outcome and inclusion alongside run/attempt/digest.
An empty denominator is unavailable. These distributions remain descriptive.

Corpus indexing prefers `structuralQualification.status` over legacy
`qualification`. Legacy-only known states remain readable; missing or invalid
structural status is unavailable. Qualified-with-gaps, incomplete, unqualified,
and unavailable remain distinct. Rebuild older corpus indexes before using
them; source manifests and native artifacts are never rewritten.

Every report retains the logical request and corpus-index digests plus the
exact admitted manifest, observation-set, assertion, calibration, and
comparison-gate digests. Moving the report therefore does not detach its
metrics from their rebuild inputs.

Observation and assertion sources name their retained bundle so the build can
recompute structural observations, resolve assertion citations, and reject
stale derived evidence. Calibration selections are likewise reloaded from their
digest-bound sources before their review history contributes to a metric.
Legacy v1 structural sets without the optional declared capability profile stay
readable; aggregation and semantic judging rebuild that profile from the native
bundle before use.

Matched comparisons require one candidate on each side for every caller-chosen
match key and one eligibility report whose candidate IDs are those two run IDs.
Missing, ambiguous, unavailable, or ungated pairs are exclusions. Supported
measures are `attempt:infrastructure-failure`,
`attempt:terminal-completed`, `verified:verifier-passed`, and any numeric
`structural:<extractor-id>` observation. The supplied comparison gate applies
only to that candidate pair, must name the exact measure, and must include the
measure's required capability;
an unsupported gate makes the comparison
unavailable, and partial-capability or declared-condition caveats remain in the
output.

Each eligibility report carries the digest of its source comparison request.
The aggregate build reloads that request and recomputes the report before using
the gate, so an edited or stale report cannot authorize a matched difference.
These bindings use `ebo.comparison-request/v2` and
`ebo.comparison-report/v2`.

The caller supplies the recurrence threshold. A divergent matched unit below
that threshold is a `case-study`; reaching it yields only a
`recurring-description`. Neither state establishes causality or statistical
significance, and the report never emits a composite model ranking.

## Evidence origins

Aggregation defaults to owned run manifests. Set `evidenceOrigins` to `imported`
for imported evidence or `separate` to include both instruments. Any included
imported attempts add `evidence-origin` to the effective grouping dimensions,
so an operator cannot pool them by omitting that dimension. The selected mode
and effective grouping are recorded in the report. Legacy requests keep their
owned-only behavior and output shape.

Imported qualification never contributes to the capture-qualified numerator.
Missing imported failure classes and terminal states are excluded from those
rates with explicit reasons; they are not observed zeroes. Exact structural
attempt measures retain the importer's coverage limits.

Comparison candidates bind imported origin to their indexed manifest and
observation set. Admission overlay digests remain audit metadata rather than
comparison eligibility keys. Complete-attempt measures require complete-attempt
evidence; imported document counts do not establish that population. Task,
fixture, budget and tool-policy requirements remain independent. Mixed retained
harness versions are labelled as a comparison caveat, and exact replicate
selection retains exact version matching.

Atlas exposes an origin facet and an imported-evidence label with source format
and producer digest. Its existing capture-qualification column carries
`imported`; its event and native drawers preserve canonical JSON pointers.
Standalone imports have no trial outcome until source-context records bind one.

Atlas viewer arms include their evidence origin whenever imported attempts are
present, including arms produced by a condition pattern. Certified matrix cells
retain that separation. The task selector treats an unavailable task as a distinct
value and labels it explicitly.
