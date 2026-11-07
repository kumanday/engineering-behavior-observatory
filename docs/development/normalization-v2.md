# EBO v2 analytical contracts

EBO owns the normalized dataset, uniform event and operation contracts. ATIF is
an admitted source format with its own versioned readers and producer profiles.
The v2 API is explicit: default retained loading and 1.x consumers keep their
existing dataset and digest recipes until the compatibility and adapter gates
are complete.

`NormalizedDatasetV2` binds the original manifest, qualification, reader code,
source format, producer profile and executed harness independently. Native
record and content digests retain the source evidence. Every native record has
mapped, retained-only or unmapped coverage; every event belongs to that mapping.
Measure coverage names its own attempt, document, session or recorded-operation
population. Partial counts use a first-class lower bound. Imported records
cannot assert exact complete-attempt measurements.

`UniformEventV2` retains actor, phase, source-local order, parentage, content and
source annotations. Typed facts describe messages, context transformations,
declared inference counts and resource scope. An annotation remains evidence
from its source; consumers use typed facts rather than interpreting aliases.
A declared `llmCallCount: 1` identifies one issuing inference. It creates no
native request identity. Unknown counts and absent request IDs remain explicit.
Conversion gaps have their own context type and cannot become compactions.

`Operation` is the `ebo.operation/v1` projection. Tool, model-request and
delegation operations have separate kinds. Its ID hashes the canonical
`ebo.operation-identity/v1` object: run, attempt, source, adapter-established
scope, operation kind, original ID and identity class. Document/session scope
prevents equal call IDs in sibling documents from joining. Every endpoint event
names that operation scope. Auxiliary permission, runtime or context events can retain an operation association without becoming call/result endpoints. Pending calls retain unknown failure; known failure
status requires a result endpoint. Operation order must be recorded on its
endpoint events. Consumers do not reconstruct operations from attribute aliases.

`precedes` accepts positions carrying run, attempt and native order. It compares safe ordinal positions only in the same established native
order domain. Equal positions mean the same observation, which covers calls
from one declared inference. Different domains remain incomparable. Stable
presentation order, event IDs, timestamps and receipt order supply no missing
behavioral precedence.

Clock evidence declares execution, producer-observation or receipt time, its
clock domain, precision, provenance and source record. `executionDurationMs` accepts positions carrying run, attempt and clock evidence. It requires source-recorded execution clocks in one domain with sufficient precision
for an exact millisecond duration. Submillisecond timestamps that cannot be represented by that calculation remain unknown. Positions from different attempts never compare. Receipt and converter-derived times remain
useful observations without becoming execution clocks.

`validateNormalizedDatasetV2` verifies the schema, source authority, explicit
operation membership, native/content digests, original attempt identity,
record-mapping coverage, parentage, endpoint order and measurement coverage. A
resolver must return the actual run, attempt and digest; a boolean resolution
alone is insufficient. Reader code is shipped implementation, never packet data.

## Migration boundary

| 1.x field or behavior | v2 representation |
| --- | --- |
| Adapter harness doubles as source kind | Source format/profile and executed harness are independent |
| Optional scalar operation ID aliases | Required operation scope and a single operation projection |
| Boolean operation failure helper | Known, unknown or unsupported failure evidence |
| Timestamp plus a source annotation | Typed clock kind/domain/precision/provenance |
| Known/unavailable count | Exact, lower-bound or unavailable value with named population |
| Native records plus unmapped reasons | Complete per-record mapping disposition and linked events |
| Model request event positions | Native request identity separate from declared inference count |
| Compaction vocabulary in consumers | Typed context kind and explicit replacement boundary |

Adapter projections, consumer migration and frozen 1.x readers have separate
acceptance gates. Adding the contracts does not authorize regenerating retained
assertions or launching model judgments. Dataset or ledger changes must identify
the affected units before a migration budget is proposed.

## ATIF alignment

The [ATIF v2 RFC](https://github.com/harbor-framework/harbor/pull/4134) was checked
at contract preparation: open, unmerged, head
`d618a647c938e2d5fdfa3a9e3245fb08f53db259`. Its canonical actions and contributing
`event_ids` map to EBO operation identity and endpoints. ATIF-E is a potential
source projection; its consolidation conveniences do not establish native
causality, recorded execution clocks or owned capture qualification.

EBO keeps the information needed for source authority, unknown evidence,
subrecord citations and analytical eligibility. No v2 ATIF admission is enabled
by these contracts. A future reader must pass the same clock, pending-call,
shared-inference, scope and coverage cases before registering a producer.

Local upstream feedback remains a draft: preserve native versus fallback
parentage, distinguish execution and receipt clocks, standardize converter and
source provenance, and retain unknown status and count values through migration.
