---
name: custom-codereview-guide
description: Evidence integrity and regression review for Engineering Behavior Observatory.
triggers:
  - /codereview
---

# EBO review guide

Prioritize evidence loss, invented normalization, unsafe export, overwritten
partial attempts, protocol-channel corruption and untested failure paths.

- Read source semantics at the pinned SDK/protocol boundary. Provider envelopes,
  process exits, stream fragments and completed native messages have distinct
  meanings. Missing evidence remains unknown.
- Source adapters own native vocabulary. Analytical consumers use typed facts,
  explicit operations and declared populations. Collector ordering and receipt
  timestamps cannot supply native precedence or execution duration.
- Operation identities include source, attempt and native scope. Reused IDs,
  child activity, pending calls and conflicting results require runnable checks.
  Sibling calls from one model output do not establish failure responses.
- Citations resolve the exact pointer value, digest and attempt. Source bytes,
  manifests and frozen runtime assets remain immutable. Packets cannot supply
  executable readers.
- Imported histories retain third-party authority and imported qualification.
  Recorded-document metrics do not establish complete owned-attempt performance.
- Keep cumulative resource snapshots, increments, child-inclusive totals and
  source authorities separate. Missing measurements do not become zero.
- Judge and rating preparation remains deterministic and bounded. Evidence is
  untrusted data, hidden reasoning is omitted, evaluated-model aliases are
  blinded and abstention remains available. Paid execution requires an explicit
  backend and task-scoped authorization.
- Verify capture version compatibility, retained partial readback, legacy digest
  preservation and stale dependency rejection when their owning paths change.
  UI changes need browser interaction evidence; no inferred screenshot success.

Follow the severity, scan limit and merge rules in `AGENTS.md`. Review findings
must identify a concrete regression or acceptance failure within the assigned
scope. Use the pinned Node version for build, typecheck and meaningful tests.
