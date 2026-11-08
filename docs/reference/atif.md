# ATIF source imports

EBO reads conforming ATIF documents from any producer. The core reader uses the
ATIF schema version to project recorded messages, calls, linked results,
observations, declared metrics and references into EBO events and operations.
It requires neither a producer profile nor a Python installation.

## Inspect and import

```sh
ebo atif inspect trajectory.json
ebo atif import trajectory.json private-import --run study-1 --attempt trial-1
ebo v2 inspect private-import private-analysis
```

Use a new destination for each admission. Source files are retained with
restricted sharing. The run and attempt identifiers bind the import to an
operator-selected analytical case; they do not prove ownership of execution.
Imported qualification stays separate from qualified native capture.

Inspection reports EBO structural validation, version policy, pointer digests,
reference availability and unmapped fields. `--python /path/to/python` adds an
optional cross-check using the installed Harbor validator. Its actual version,
model digest and result appear in `harborCrossCheck`; disagreement leaves the
EBO validation result available. Source-supplied code is never executed.

The reader supports ATIF v1.2 through v1.8. A future v1 minor uses the latest
known semantics and retains unfamiliar fields as unmapped. An unsupported major
produces a specific diagnostic. A readable parent can retain a child whose
major version is unsupported. [Limitation codes](atif-limitations.md) explain
these qualifications.

## Recorded populations

Each measurement describes its recorded document. Embedded children have
independent sources and populations, including when their agent versions
differ. Parent totals are not added to child totals. Missing fields remain
unknown; an explicitly empty call collection can establish a document-level
zero. A zero never establishes the absence of activity outside that document.

Tool calls and results correlate by `tool_call_id` within their issuing step.
Repeated IDs in different steps remain distinct. Missing or ambiguous identities
retain their content without inventing a logical operation. Bodyless result
records remain endpoints. Result text does not establish success or failure:
ATIF core has no tool-failure field. Folded results do not establish when the
result arrived, so their issuing step ordinal cannot prove an execution follow-up.

The core retains `extra` without interpreting it. Literal text such as
`[COMPACTED HISTORY]` is a message, not a compaction event. Copied context remains
visible without adding new operations or inference counts. Declared inference
counts remain separate from native provider request identities.

Step and final metrics retain their source field names and populations. Final
values cite the recorded fields. Their presence does not establish component
completeness or native billing semantics. Media, subagent and continuation
references remain inspectable; unavailable files remain unavailable. Inspection
can inventory explicitly admitted local files with `--retain relative/path`.
The reader does not fetch remote references. Hidden reasoning and reversible
token arrays remain protected by EBO's evidence projection.

## Optional interpretation

Pi and Codex have optional producer overlays for fixture-backed converter
conventions. `ebo atif overlays` lists their matching rules and version ranges.
`--profile ebo.pi-harbor` or `--profile ebo.codex-harbor` supplies example converter
context for import. An agent name alone does not establish which converter ran.
The library API accepts optional converter and context metadata without requiring
source or wrapper digests. Document agent and schema fields remain authoritative
for the recorded declaration.

An overlay can interpret extensions, qualify particular facts and record each
adjustment with its reason and evidence pointers. Outside verified ranges, core
content and counts remain available with conservative limitations. See
[ATIF interpretation](../development/atif-producer-profiles.md) for the measured
Pi and Codex gaps, and the [eight-harness coverage matrix](atif-harness-coverage.md)
for converter availability and same-run evidence.

## Admission and reopening

An import contains `trajectory.json`, `inspection.json`, `interpretation.json`,
`mapping.json` and an `ebo.import-manifest/v2` manifest. The manifest binds raw
source bytes, inspection, operator context and admission overlay IDs/digests.
The interpretation receipt binds the core implementation and overlays used at
admission. Mapping is a derivation, not an editable source of truth.

Reopening verifies source and receipt digests, then projects with the current
reader. An interpretation revision reports the admission and current identities
when code or overlays change. Existing v1 admissions remain readable; their
recorded profile data is retained as admission history. Reinterpretation never
rewrites an old manifest, packet, dataset or judgment. A changed derivation
requires dependency reconciliation before reusing downstream analysis.

## Consumers and source context

Native and imported evidence use the same retained reader boundary for
structural observations, cited judging and Atlas. Imported outcomes, capture
quality and document measurements keep their distinct authority and scope.
Choose `evidenceOrigins: "imported"` for imported aggregation or `"separate"` for
separate owned and imported groups. The default selects owned captures.
Complete-attempt comparisons require complete-attempt evidence; a document count
does not supply it. [Aggregation](../evaluation/aggregation.md) defines this boundary.

[Harbor imports](harbor-imports.md) bind trial directories to executions and
assessments. [Leaderboard imports](leaderboard-imports.md) retain protected
source facts, snapshot receipts and execution reuse. These source-context
checks do not make a producer profile a prerequisite for reading ATIF.
