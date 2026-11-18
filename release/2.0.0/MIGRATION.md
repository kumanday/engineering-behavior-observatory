# Migrate to EBO 2.0.0

## From 1.x

EBO 2 does not open 1.x studies. Keep 1.4.0 installed to reopen, verify or
extend one:

```sh
npm install engineering-behavior-observatory@1.4.0
```

To study the same tasks under EBO 2, capture them again inside a
[study runtime](../../docs/reference/study-runtimes.md) and judge them against
the [behavior ontology](../../docs/evaluation/behavior-ontology.md).
[Upgrading from 1.x](../../docs/guides/upgrade-from-1x.md) lists what does not
carry over and what replaces it.

## From the 2.0 release candidates

Records written by the release candidates use names and numbers that 2.0.0
does not read. Write them again with 2.0.0:

| Release candidate | 2.0.0 |
| :--- | :--- |
| `ebo.behavior-assertion/v1`, `ebo.semantic-judge-request/v1`, `ebo.semantic-judge-input/v1`, `ebo.semantic-judgment/v3`, `ebo.judge-prepare-spec/v1` | `/v2` of each, and `ebo.semantic-judgment/v4` |
| `ebo.aggregation-request/v1`, `ebo.aggregation-report/v1` | `ebo.aggregation-request/v2`, `ebo.aggregation-report/v2` |
| `ebo.review-sample-criteria/v1`, `ebo.review-sample/v1`, `ebo.review-packet/v1`, `ebo.calibration-summary/v1` | `/v2` of each |
| `ebo.atlas-view/v1`, `ebo.atlas-bundle/v1`, `ebo.atlas-bundle-request/v1` | `/v2` of each |
| `ebo.experiment/v1`, `ebo.run-queue/v1` | `ebo.task-packet-experiment/v1`, `ebo.task-packet-queue/v1` |
| `ebo.experiment/v2`, `ebo.run-queue/v2` | `ebo.harbor-experiment/v1`, `ebo.harbor-queue/v1` |
| `ebo.run-queue/v3` | `ebo.study-queue/v1` |
| `ebo.smol-environments/v1`, `/v2` | `ebo.smol-task-environments/v1` with an explicit `target` |
| `ebo.smol-environments/v3` | `ebo.smol-family-environments/v1` |
| `ebo.import-manifest/v1` | `ebo.import-manifest/v2`: import the ATIF source again |
| `ebo.study-runtime-lock/v1`, `ebo.runtime-launch/v1` | `/v2` of each: freeze the study again |
| `ebo.harbor-worker-runtime/v1` | `ebo.harbor-worker-runtime/v2`, bound to the study lock |
| `run-manifest/v1` | `run-manifest/v2`, with `runtimeLock` present for study-runtime captures |

The typed analysis commands of the candidates (`ebo v2 inspect`,
`ebo v2 prepare-judge`) and their records are removed. Use `ebo observations`,
`ebo judge` and `ebo atlas`.

Judging requests and results name a behavior card instead of a 1.x category;
see the [behavior ontology](../../docs/evaluation/behavior-ontology.md). Judge
cohorts with [`ebo judge decision-model`](../../docs/evaluation/decision-model-judge.md)
and audits with the LLM judge.
