# Migrating analytical artifacts

Retain source bundles, manifests, original assertions and evaluator receipts.
Derive v2 datasets in a new destination. Native capture adapter versions remain
independent of normalization versions. Imported trajectories retain `imported`
qualification throughout.

| Artifact | Readback and regeneration |
| --- | --- |
| Owned native capture | Retain original bytes and qualification. Derive a new v2 dataset through its registered native profile. |
| ATIF import manifest | Retain raw bytes, declared producer and pinned structural receipt. Pi v1 mapping remains supported; additional producers use their independent v2 registry. |
| v1 analytical artifact | Read using its supported shipped runtime. Reuse only when all recorded dependencies match. |
| v2 observation or occurrence ledger | Rebuild from its v2 dataset and source resolver. Typed operation, clock and coverage changes affect dependency digests. |
| Rating or semantic input | Reconstruct source-bound evidence and compare dataset, ledger, observation, rubric, evaluator and configuration digests. |
| Existing assertion | Preserve the original. Changed dependencies require a new judgment and assertion identity. |
| Serialized migration target | Reconstruct through `createMigrationTargetV2` against its source. A JSON object alone cannot provide source-validation proof. |

The v1 occurrence ordering correction also changes occurrence-derived artifacts.
It is independent of the v2 schema migration. V2 datasets bind reader/profile
implementation bytes, so normalizer changes can alter their digests even when
selected numerical measures agree. The additional-producer dispatch changes the
Pi ATIF v2 implementation digest; original Pi v1 outputs remain readable. Native
v2 projection modules are unaffected by the additional ATIF producer profiles.

Use `inventoryMigrationStudy`, `planMigrationV2`, `prepareMigrationTargetV2`,
`createMigrationTargetV2` and `reconcileMigration` through the library API. Select
study roots explicitly and preserve their receipts. The
[migration accounting guide](../../docs/development/migration-accounting.md)
describes limits, runtime pins and the historical missing-wall-limit exception.
That exception admits an observed legacy omission without inventing a limit.

The restricted seven-study selection contains 646 judgment units: 567 require
v2 re-judgment and 79 preserve missing original evidence. Of the 567, 335 target
inputs are prepared and 232 await admissible source evidence. The prepared set
contains 194 ready inputs and 141 requiring 4,458 bounded occurrence rating
inputs. These are explicit selection counts, not a census of all studies or the
leaderboard. Source admission limits remain in force for pending units.

No evaluation-model calls were dispatched for this migration preparation.
A paid forecast requires measured unit cost and a separately bounded invocation
and retry count. Code-review costs are outside that evaluation accounting.
Original ratings and assertions remain available for historical readback.
