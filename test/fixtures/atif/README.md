# ATIF acceptance fixtures

All native Pi records here are newly authored synthetic data. They contain no
benchmark tasks, private sessions, credentials or provider reasoning. The ATIF
files are generated independently by Harbor 0.24.0's Pi converter and pinned by
the adjacent manifest. Run `scripts/convert-pi-fixtures.py test/fixtures/atif/pi
--check` in the pinned Harbor environment to reproduce them twice.

The grouped-call fixture includes an explicit failure, a successful sibling
call from the same inference, and nonzero cache writes. The compaction fixture
exposes how this converter represents a native compaction. Interpret its
producer metadata explicitly rather than assuming every agent step is an
ordinary assistant response.

The active-branch fixture retains historical operations in the native tree but
selects a fresh leaf for conversion. Its gate asserts the operation/signature
loss and requires `SELECTED_BRANCH_ONLY` before comparing full-attempt counts.
The timeout fixture retains an interrupted pending call with unavailable result
status. The linked continuation pair keeps copied steps out of new-call counts
and makes missing continuation coverage explicit. These are synthetic source
semantics fixtures and do not establish capture qualification.

Restricted same-run capture pairs and the native readability census live in an
operator-owned private fixture root. `scripts/freeze-native-baseline.mjs`
records source digests and accepted/rejected readback; pass its saved manifest
as the third argument to check future slices. Keep all base-loadable captures
readable, while preserving the rejection of unqualified captures.

`scripts/freeze-pi-pairs.py <native-baseline.json> <new-private-root>` runs the
pinned converter twice for every distinct accepted dataset. It retains and
digests generated image sidecars alongside each trajectory, checkpoints partial
progress, and refuses to replace an existing fixture root. Verify media retention
with `python scripts/test_freeze_pi_pairs.py` in the pinned Harbor environment.

`test/atif-fixture-gate.ts` defines the five per-measure equivalence outcomes.
This gate compares measure meaning and unit, requires an explicit reason for
loss or additional availability, and does not treat a whole-file schema pass
as proof of completeness.

After building, run `node scripts/check-pi-fixture-pairs.mjs
<frozen-pair-manifest.json> <new-private-report.json>`. It verifies frozen source
and sidecar digests, reopens native datasets, compares five declared converter
measures, and checks call-ID/name/failure signatures. Unknown step usage and
status fields have named loss reasons. Native lifecycle record cardinality is
unavailable in converted ATIF; converted compaction boundaries are retained as
a separate diagnostic. Unexplained value or signature differences fail the
gate. The report is checkpointed and an existing destination is preserved.

The source-summary audit is independent fixture tooling. Production import
eligibility and full-attempt measurement require the importer coverage policy;
the audit does not confer capture qualification. The table-driven ATIF-only
checks assert every expected summary in `conformance-cases.json`.
