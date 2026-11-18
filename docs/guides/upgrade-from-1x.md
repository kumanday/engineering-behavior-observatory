# Upgrading from EBO 1.x

EBO 2 does not open EBO 1.x studies. It reads what EBO 2 writes, and it carries
no reader, converter or compatibility layer for records produced by 1.x.
Version 1.4.0 remains the version for 1.x studies: keep it installed to reopen,
verify or extend one.

```sh
npm install engineering-behavior-observatory@1.4.0
```

## What does not carry over

| 1.x material | In EBO 2 |
| :--- | :--- |
| Behavior assertions, judge requests, judge inputs and judgments | Not read. They name one of eight categories and carry a constructive, adverse, mixed or context-dependent assessment. EBO 2 judges [behavior cards](../evaluation/behavior-ontology.md) and records a verdict of present, absent or unknown |
| Rubrics written for a category | Rewrite them for a card. The judge now receives the card's definition, trigger, evidence test and near miss, so a rubric only adds what is specific to the study |
| Aggregation reports, review samples, review packets and calibration summaries | Not read. Build them again from EBO 2 assertions |
| Atlas reports, Atlas bundles and evidence packets | Not read by the EBO 2 viewer or packet verifier. Build them again |
| Structural observation sets and occurrence ratings | Not read: EBO 2 accepts only the current extractor, occurrence-rule and question-set versions. Create them again from the run bundle |
| Comparison requests without a measure and manifest digests (`ebo.comparison-request/v1`) | Not read. Write an `ebo.comparison-request/v2` |
| Operational judgments recorded as `ebo.semantic-judgment/v1` | Not read |
| Frozen 1.x readers, `loadAnalysisRuntime`, Atlas cohorts pinned to an `analysisRuntime`, and migration accounting | Removed |

Formats whose shape changed in EBO 2 carry a new number, and formats that are
different kinds of document carry their own names. The
[map of EBO 2.0](ebo-2-map.md#record-formats) lists every current name.

Saved Atlas links and Grafana dashboards that filter on `category` or
`assessment` need `family`, `card` or `verdict`. Review sample criteria use
`cardIds`. Claims files select a cell with `where.card` and a verdict.

## Run bundles

EBO 2 is not tested against run bundles captured by 1.x and makes no promise
to read them. A bundle is read when its manifest and native records satisfy the
current contracts; nothing in EBO 2 exists to keep an older capture readable.
To study the same task under EBO 2, capture it again inside a
[study runtime](../reference/study-runtimes.md).

## Start a study in EBO 2

Follow the [quickstart](quickstart.md) and the [operator guide](operator-guide.md).
For evaluation, pick the cards to judge from the
[ontology reference](../reference/behavior-ontology.md) and follow the
[evaluation runbook](behavioral-evaluation.md).
