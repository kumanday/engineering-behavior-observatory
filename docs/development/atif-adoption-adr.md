# ATIF admission and EBO normalization

Status: accepted. The additive 1.x implementation preserves existing capture and normalization contracts. EBO v2 adapter activation, consumer migration and release qualification have separate gates.

## Decisions

1. Retain ATIF as an additional source format. Analytical consumers read EBO
   normalized datasets and operations. Native sessions, hooks and protocol
   evidence remain authoritative for their recorded facts.
2. Add a version-aware reader, an explicit producer-profile registry, and
   Harbor/leaderboard source-context importers. Imported evidence has its own
   qualification class and cannot contribute to capture-qualified rates.
3. Ship the compatibility guard, occurrence-order correction, and first Pi
   import as independently reviewable 1.x slices. Existing dataset bytes and
   source manifests remain immutable.
4. Use EBO v2 for typed operations, clock provenance, measure-level coverage,
   and removal of consumer-side native vocabulary. Ship a frozen compatibility
   reader and selective re-judge accounting with those changes.
5. Keep the ATIF reader extensible by format version. Support the released v1
   corpus first. Reassess the event-model boundary against the ATIF v2 RFC
   before freezing EBO v2 contracts. An unmerged RFC is research input.
6. Use pinned Harbor converters for independent fixture pairs. Defer an
   EBO-authored exporter until a named consumer and an unsupported harness
   justify it.

## Basis and consequences

The Harbor migration policy permits ATIF interchange and gives import-only
data limited capture/comparison eligibility. This ADR makes that policy part of
the tracked product documentation. The design generalizes the existing
`RetainedBehaviorEvidence` boundary and adds `ebo.operation/v1`; it introduces no
second editable trajectory store.

The pilot projected four Pi documents through the current normalized-dataset
validator and Atlas unit builder without changing product code. Two native Pi
pairs matched five selected measures and their operation signatures. A third
converted successfully while native qualification rejected it. Public Codex
logs preserved one call absent from the matching ATIF. These results require
distinct import qualification and producer-specific fidelity gates.

Replacing every analytical input with ATIF v1 steps would move failure status,
source-local ordering, provenance and completeness into an EBO-specific
companion. Direct ATIF consumers would also need their own interpretation of
producer conventions. The chosen boundary centralizes that interpretation.

See the [design and implementation sequence](atif-adoption-design.md),
[pilot results](atif-import-pilot.md), and
[existing Harbor boundary](harbor-adr.md).
