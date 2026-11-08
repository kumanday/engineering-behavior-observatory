# ATIF interpretation

ATIF core projection is producer-agnostic. It maps standard fields according to
`schema_version`, retains extensions and supplies the same EBO analytical
contracts as native projections. Producers outside EBO's eight maintained native
harnesses use this generic path. Reading, visualization and document-scoped
measurements require no overlay.

## Optional overlays

Only Pi and Codex have dedicated overlays. Matching uses rules over the document's
`agent.name` and version plus optional operator-declared converter ID and version.
Source digests and wrapper revisions are audit context, not matching keys. Each
overlay records its ID, version, implementation digest and verified ranges.

| Overlay | Verified agent range | Converter ID and range | Measured interpretation |
| --- | --- | --- | --- |
| `ebo.pi-harbor` | `>=0.85.0 <2.0.0` | `harbor.agents.installed.pi.Pi`, `>=0.24.0 <0.26.0` | Positive `is_error` extension flags; response-model aliases for blinding; context-management extensions; inclusive prompt/cache reconciliation. False error flags and zero-filled usage do not prove success or component completeness. Active-branch conversion can omit other history. |
| `ebo.codex-harbor` | `>=0.162.0 <0.163.0` | `harbor.agents.installed.codex.Codex`, `>=0.24.0 <0.26.0` | Original argument representations and converter inference groups. Converted output order and clocks have limited authority; unanswered calls can be omitted and orphan-call/result slots can be synthesized by conversion. |

A matching overlay outside its verified ranges supplies conservative limitations
and marks the version unverified. It preserves the core projection and recorded
counts. A missing converter declaration uses core alone. Adjustments identify
the affected subject, reason, source pointers, prior value and interpreted value.
Standard declared counts remain visible separately from converter-specific
interpretations. [Limitation definitions](../reference/atif-limitations.md) own
the meaning of each code.

Codex function arguments use canonical decoded objects when retained raw
provenance agrees with the converted object. Custom and malformed arguments keep
their raw representation. Missing provenance qualifies native input equality;
recorded calls and standard argument content remain inspectable. Converter API
groups are not native provider request IDs. Folded results have unknown arrival
order and cannot establish tool execution durations.

## Evidence and conformance

The [coverage matrix](../reference/atif-harness-coverage.md) is generated from the
native adapter registry and actual core fixture imports. It distinguishes
converter availability, source-surface differences, authored examples and real
same-run evidence. An authored selection derived from a capture demonstrates
readability; it is not an independent conversion-equivalence result.

Real Hermes and OpenClaw trajectories are private generic-producer fixtures,
with authored public counterparts. OpenClaw includes both a partial zero-call
history and a positive 65-call/65-result document. Their producer names and
versions have no dedicated interpretation code. Hermes's missing inference
count remains unknown; OpenClaw history-marker text remains ordinary content.

Public conformance checks run without a Harbor prerequisite for core reading.
Pinned independent converter lanes preserve reproducible fixture generation;
those pins describe test provenance. The optional installed-validator lane
records whatever Harbor version it uses. Private fixture gates also verify raw
source digests, supporting artifacts, capture-derived values and same-run
call/result identity populations. No fixture generation invokes an agent.

## Durable interpretation identity

Admission manifests retain the IDs and digests of applied overlays. Reopening
reprojects with current code and reports an interpretation revision rather than
requiring today's registry to reproduce an admission key. Source and receipt
integrity remain mandatory. New core or overlay semantics change derivation
identity and require selective downstream dependency reconciliation. Frozen
compatibility readers and the rc.1 artifact retain their own implementations.

## Mapping status

In `ebo.atif-core-mapping/v1`, `producerStatus: "supported"` means **core-readable**:
the document has an ATIF interpretation available through EBO's generic reader.
Overlay admission is recorded separately by the import manifest's `overlays`
and the mapping's optional `profileDigest`. An unknown producer normally has
`producerStatus: "supported"` and no overlay digest. This field conveys no
claim about native harness support, complete history or behavioral equivalence.
