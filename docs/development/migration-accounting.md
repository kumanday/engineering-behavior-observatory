# Retained-study migration accounting

Use `inventoryMigrationStudy` before changing a retained study's analysis
runtime. A study declares its supported frozen runtime and the exact relative
artifact paths to inventory. Discovery and archive admission belong to the
operator's census. The report records that selection so its completeness claim
can be assessed without treating a directory scan as a workspace-wide audit.

The reader validates EBO assertions, judgments, inputs, observation sets and
ratings. It verifies each judgment's sibling input and assertion by canonical
content digest, run, attempt, behavior, rubric and evaluator. Reading is bounded to 100,000
files, 64 MiB per file and 2 GiB total. Paths stay inside the declared study;
symbolic links, invalid JSON and duplicate keys fail validation. Raw study
content remains private, and reports contain source-relative paths and digests.

Judgment units bind the declared input digest, evaluator receipt and assertion
configuration. Copied judgments and cost receipts count once. When configuration
identity is unavailable, distinct judgments remain distinct units. Missing input
or assertion/configuration evidence receives a `preserve-frozen-missing-evidence`
disposition. Integrity failures block reconciliation.
Assertions without a retained judgment receipt receive a separate preservation
disposition. Complementary copies can recover input and assertion files, and
the assembled bindings are verified before those units become eligible for reuse.

Historical Codex 0.162.1 relay receipts have an explicit optional reader profile,
`codex-relay-0.162.1-no-wall-limit/v1`. Select it in `receiptProfiles` only for
studies that used that relay. It admits the single absent `maxWallClockMs`
field after every other current-schema check passes, and records the profile
on the artifact row. The original evaluator receipt and its missing limit
remain unchanged. Failed judgments may omit assertions and remain available
for frozen preservation.

```ts
const inventory = inventoryMigrationStudy({
  id: "study-2026-11",
  root: studyRoot,
  analysisRuntime: supportedRuntimePin,
  artifacts: ["judgments/example/judgment.json", "judgments/example/assertion.json"],
});
const preflight = reconcileMigration(inventory);
```

Preflight leaves readable units `pending-target`. Build new deterministic
projections and packaged judge inputs alongside the originals, then provide
`MigrationTarget` entries to `reconcileMigration`. Each target binds one original
unit and supplies the regenerated input, evaluator digest and configuration
digest. Changed dataset, selection, selected evidence, rubric, prompt, ratings
and evaluator dependencies are listed independently. Identical dependencies
permit reuse; changed dependencies identify a `rejudge` unit. The original
assertion remains bound to its original dataset.

Forecasts use unique retained measured costs for the same evaluator receipt.
An affected unit without a matching measured sample makes the affected-unit
forecast null. A report always carries an authorized paid budget of zero.
An operator must obtain a separate spending authorization before launching
judgments. Pending targets and missing evidence remain visible alongside the
forecast; it covers only the explicitly reconciled affected units.

Frozen readers preserve existing studies. Reconciliation accepts verified v1
inputs and typed v2 targets, and records their dependency identities separately.
Final reconciliation uses the actual target inputs after their native adapters
and consumers pass the source and semantic validation gates.

## Typed v2 targets and protocol planning

`prepareMigrationTargetV2` preserves a verified original input's behavior,
rubric and selected source references. It prepares a typed v2 input against a
qualified source, records the retained evaluator configuration and requires
rating-dependency regeneration when the original input used ratings.
`createMigrationTargetV2` verifies source readback before binding the target to
its original judgment unit. Reconciliation records the target's input schema,
configuration digest and rating readiness.

V2 targets are created through `createMigrationTargetV2` or
`prepareMigrationTargetV2`. Reconciliation accepts only the unchanged target
object returned after source validation. The input JSON and reconciliation
receipts remain durable artifacts. After loading an input from JSON, recreate
its target against the retained source before reconciliation; a TypeScript
cast or a copied target object does not establish source validation.

`planMigrationV2` identifies the exact affected units from the supported prompt
protocol change from the retained 1.0, 1.1, 1.2 and 1.3 generations to 2.0. This proof remains available while source
rebuilds are pending. Its counts distinguish affected judgment units, distinct
assertion contents, retained rating dependencies and prepared target inputs.
An unchanged v1 input remains reusable under its preserved runtime; the v2
protocol has its own dependency identity.

Native admission failures retain their original evidence and explicit pending
source status. Missing original inputs and assertion configurations retain a
frozen preservation disposition. Planning assigns no target digest to an
unprepared input and authorizes no paid execution. A cost forecast remains
unavailable until the target workloads have measured receipts.
