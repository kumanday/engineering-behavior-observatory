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
