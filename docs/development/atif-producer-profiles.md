# ATIF producer profiles

The closed registry in `src/atif-profiles.ts` separates schema conformance from
producer semantics. A profile key includes the ATIF version, agent version,
converter package version and source digest, and any source-context revision
and wrapper digest. Unknown fields remain explicit; an agent name alone never
selects a profile. Profiles are `ebo.atif-producer-profile/v1` artifacts and can
be checked with `ebo validate`.

The initial profiles cover Harbor 0.24.0's Pi converter with its explicit
`unknown` agent version, and the pilot Harness Leaderboard HFPi wrapper at
revision `0583ba55ac8ddaea3464c85b54828baeaa8d834a` with Pi 1.2.0. The pinned
wrapper inherits trajectory conversion from Pi; its lock pins Harbor 0.24.0.
Each profile retains source links and source-file digests.

The rules identify document-scoped native tool-call IDs, Pi's result error
field, inclusive prompt accounting with cache reads and writes, active-branch
selection, copied-context exclusion and source-declared inference counts.
They keep native request identities unavailable. A registered profile grants a
mapping vocabulary; document coverage, usage reconciliation and import
admission determine which measurements are eligible. Imported evidence retains
its source class and never acquires native capture qualification from a profile.

Converter upgrades require a new fingerprint, fixture comparisons and review.
An unregistered fingerprint remains structurally inspectable without receiving
behavioral mapping rules. The registry accepts no runtime plugins or arbitrary
profile registration.

## Public conformance checks

The ATIF import conformance workflow runs the independent Pi converter, retained
media checks, reader/profile gates and imported-consumer regressions on authored
fixtures. Its production Python dependencies are pinned separately in
`scripts/atif-import-pilot/requirements-ci.lock.txt`: the board policy and
exploratory atif-scan tool require different Hugging Face Hub versions. The
production gate sets both `EBO_ATIF_TEST_PYTHON` and
`EBO_LEADERBOARD_TEST_PYTHON` so those checks execute instead of skipping.
Private study readback and optional live captures retain their own gates.

## Additional v2 interpretations

`src/atif-producers-v2.ts` registers exact fingerprints for these additional
sources. `listAtifProfilesV2()` and `ebo atif profiles --v2` list their identities.
The EBO normalization maintainer owns the profiles; each upgrade requires an
independent converter check and immutable-head code review.

| Producer | Pinned source | Interpretation and limits |
| --- | --- | --- |
| Codex 0.162.1, ATIF v1.7 | Harbor 0.24.0 Codex converter; HFCodex wrapper at `0583ba55` | Document-scoped converted calls and grouped declared inference. Unanswered native calls can be omitted. Converted timestamps remain producer observations; tool execution durations and tool failure status are unavailable. |
| Hermes v0.22.1, ATIF v1.2 | Harbor 0.24.0 Hermes converter; HFHermes wrapper at `0583ba55` | Tool IDs can be converter-assigned. Inference counts, tool failure state and component-complete usage stay unknown. The inserted `[tool call]` placeholder produces no assistant-report event. |
| OpenClaw 2026.10.4, ATIF v1.8 | HLB 0.1.1 `hlb.harbor_ext.trajectories` and HFOpenClaw wrapper at `c4a8c4cb` | Explicit `context_management.type` records real compaction. HLB gap steps record missing history. Positive result `is_error` is failure evidence; nested results are observations of their parent, not completed parent endpoints. |

Their source-file digests and full revisions are in the closed registry. The
native authorities are Codex rollout records, Hermes session messages and
OpenClaw session transcript entries. Public bucket metadata alone does not
verify the operator's producer declaration. Claude and Kimi imports await
independent native companions and scope gates.

Admission retains these sources through the existing import manifest and v1
reader. Its `profile.status: unsupported` describes the frozen v1 mapping
registry. `readImportedBehaviorEvidenceV2()` independently validates the exact
v2 fingerprint and derives a typed dataset. This keeps existing Pi admission
receipts readable. The v2 CLI and leaderboard bindings accept the additional
profile IDs; v1 analysis remains retained-only for them.

Recorded operations are distinguishable from whole-attempt totals. Positive
source attempt counts are lower bounds; zero recorded calls never proves zero
calls executed. Missing or duplicate results preserve unknown outcomes. Copied
steps and unqualified children produce no new behavior. Child contents remain
retained; parent final usage has its own source-reported population and is never
added to child totals. Step and final usage preserve the converter's field names
and unknown aggregation semantics instead of becoming normalized native input
usage. Replacement boundaries remain unknown, so these profiles cannot rebuild
the model's context.

`scripts/convert-atif-producer-fixtures.py` regenerates three authored native/ATIF
pairs twice, checks converter source digests, and verifies byte-identical output.
`test/atif-producers-v2.test.ts` separately checks admission, offline readback,
typed consumers, partial histories and unsupported measures. Restricted
same-run source comparisons retain their own reports; an ATIF-only conformance
pass never establishes native equivalence.

The retained four-trial pilot independently reproduces Codex's 45 native calls
and 44 converted calls; the omitted call has no native result. Hermes matches
28 call IDs and tool names between its session export and ATIF. OpenClaw's
fallback conversion reproduces its retained steps and partial marker, with zero
recorded calls and unknown whole-attempt count. Its native session is absent,
so paired native fidelity remains unavailable. These case-specific results do
not authorize cross-origin pooling. The implementation's public regression gate
passes 148 focused tests with pinned Harbor and board-policy runtimes; all three
independent authored conversions reproduce byte for byte.
