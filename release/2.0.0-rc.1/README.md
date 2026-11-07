# EBO 2.0.0-rc.1 candidate

This unpublished candidate adds retained ATIF source imports, typed v2 analysis
and migration accounting. Existing capture protocols remain native. The typed
lane is opt-in through `ebo v2 inspect` and `ebo v2 prepare-judge`; existing
analysis commands and two shipped 1.x readers keep their contracts. Dependencies
used by the fixed readers are pinned to their qualified versions, including
Ajv 8.20.0 and ajv-formats 3.0.1, so fresh installation preserves readback.

The candidate includes bounded ATIF 1.2-1.8 inspection, exact converter profiles,
Harbor execution/capture/assessment lineage, pinned Harness Leaderboard cohorts,
evidence companions, typed operations and clock provenance, source-bound
citations, occurrence ratings, semantic inputs and a local Atlas view. It keeps
imported evidence separate from EBO-owned qualified captures. Missing evidence
retains unknown values or explicit lower bounds.

The [profile support table](../../docs/development/atif-producer-profiles.md)
covers two Pi profiles and additional Codex, Hermes and OpenClaw fingerprints.
[Native projections](../../docs/development/native-v2-adapters.md) cover all eight
supported capture harnesses. Schema conformance, native fidelity and individual
measurement eligibility remain separate gates. Claude and Kimi ATIF imports need
independent native companions before admission to behavioral analysis.

[Migration instructions](MIGRATION.md) explain dependency changes and frozen
readback. [Qualification instructions](QUALIFICATION.md) define exact-head checks,
package reproduction and cold readback. The [reproducibility manifest](reproducibility.json)
binds candidate source, contracts, fixtures, documentation and runtime pins.
Verification receipts bind the actual checked commit and tarball digest; they
are produced by the checks rather than asserted by this source record.

ATIF's upstream v2 RFC remains open at pinned head
`d618a647c938e2d5fdfa3a9e3245fb08f53db259`. EBO v2 retains its normalized contracts;
it implements ATIF 1.x source admission. Source-proven precedence, unknown values,
authority and pointed citations require explicit EBO interpretation. The [boundary decision](../../docs/development/atif-adoption-adr.md) records
the source interpretation rules.

Candidate qualification prepares local artifacts. Publication, version tags,
main-branch integration and hosted deployment are separate actions.
