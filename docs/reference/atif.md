# ATIF source inspection

`ebo atif inspect trajectory.json --python /path/to/pinned-venv/bin/python`
reports source identity, structural validation, version policy, JSON-pointer
records and reference availability. Inspection produces no behavioral measures
or capture qualification. Its `ebo.atif-inspection/v1` receipt can be checked
with `ebo validate`.

Install `harbor==0.24.0` in an isolated Python environment. EBO invokes its
trajectory model in a bounded subprocess and records the installed model-source
digest and validation-policy digest. An unavailable interpreter or different Harbor version produces an
unavailable validation result. TypeScript coordinates ingestion and analysis.

The reader accepts ATIF v1.2 through v1.8. Version policy is independent of
Harbor's permissive current model: completion token IDs require v1.3, prompt
token IDs v1.4, tool definitions and copied-context fields v1.5,
multimodal content v1.6, embedded trajectory identities and declared inference
counts and tool-call/result extensions v1.7, and audio v1.8. Older inference counts remain untracked. External
subagent file references remain inspectable in older documents; session IDs
identify runs and do not resolve embedded children. The
[ATIF RFC changelog](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md#version-history)
defines these version boundaries.

Pre-v1.7 session-only subagent references use a declared compatibility validation
view because Harbor's current model requires the v1.7 resolution keys. The receipt
records the raw model's result, the compatibility-location count and up to 32
locations, with an explicit truncation indicator. The validation
placeholder is confined to that subprocess; retained source bytes, pointers and
reference identities stay unchanged. A session-only reference remains unavailable
until separately retained evidence binds its target.

References are unavailable unless an operator explicitly admits each relative
file with `--retain path`. Absolute paths, parent traversal, URLs, symlinks and
missing files remain unavailable. EBO performs no network fetch. Each admitted
file receives its own byte digest. Repeated references reuse the retained target
and the aggregate budget counts unique files before reading them. Embedded references resolve by trajectory
ID within their containing document and retain canonical pointed-value digests.

Limits are 64 MiB per document, 4 MiB per step, 16 MiB per attachment, 64 MiB
total attachment bytes, depth 64, one million JSON nodes, 100,000 pointer records
and 100,000 values per token-ID or logprob array. Oversized or unsupported input
keeps an inventory receipt with an explicit diagnostic. Oversized files retain
their declared byte length; their contents are not read or hashed. Duplicate
keys are rejected. Root byte digests remain separate from canonical pointer
digests, so whitespace changes source identity without changing a pointed
value's canonical identity.

Numbers must be finite and integer values must fit JavaScript's safe-integer
range. Larger integer evidence is retained by its source byte identity and
rejected with `UNSAFE_JSON_INTEGER` before pointer records are created. UTF-8
byte-order marks are accepted consistently by the reader and validator.

These checks describe the supplied export. Import eligibility additionally
requires a registered producer profile and document-specific coverage policy.

## Pi imports

`ebo atif profiles` lists the closed producer registry. Select the exact `id`
whose agent and converter metadata match the source, then retain a local import:

```sh
ebo atif import trajectory.json ./new-import \
  --run imported-run --attempt attempt-1 \
  --profile 'pi/harbor-0.24.0/atif-1.7/agent-unknown/harbor' \
  --python /path/to/pinned-venv/bin/python
```

The profile and attempt identity are operator declarations. They do not verify
upstream provenance or establish an EBO-owned capture. The importer writes an
`ebo.import-manifest/v1` with qualification `imported` and restricted sharing.
It retains raw source bytes before validation, writes admission last, and leaves
failed imports inspectable without a manifest. Repeating the same import at the
same destination is a verified no-op. A different source, producer or identity
requires a new destination. References never trigger fetches or candidate code.

Retained readback verifies raw bytes, the structural-validation receipt, profile
identity and JSON-pointer inventory. It needs no Python process. The shared
retained-evidence loader and corpus index recognize the import manifest;
existing owned-capture qualification rules remain separate. Corpus entries use
`manifestKind: import`, and default owned-run aggregation excludes them.

The Pi mapping report describes the **retained selected trajectory**, with
recorded operation signatures and producer-declared usage/inference diagnostics.
These diagnostics are not full-attempt measures. The normalized dataset marks
exact attempt measures unavailable because the converter can omit branches,
interrupted messages and native request identities. No native request IDs,
per-tool clocks or owned terminal events are synthesized. All events from a
step share its native ordinal; a declared single-inference group prevents a
sibling tool call from being treated as a response to another sibling's failure.

Copied steps, conversion gaps, summarizer children and unbound/borrowed children
remain retained without new-agent-behavior events. Child documents require the
same registered producer conventions before receiving behavior projections.
Pending, missing and ambiguous results keep unknown status. Pi's converter can
zero-fill a missing failure flag to false, so a false flag is retained as
`producerIsError` without asserting native success. Empty converted arguments
cannot establish an identical-input digest. Explicit true errors remain failure
evidence. Zero-filled per-step usage stays unavailable even when positive sibling steps
make the sum nonzero. Uncached input requires
cache-write fields and reconciled step/final inclusive prompt totals.

The TypeScript API can also retain structurally valid unregistered producers;
their records remain inspectable with no behavioral events or measures. New
profiles require source pins, conformance checks and independent paired gates.
`mapping.json` is a reproducible diagnostic; source bytes and the admission
manifest are authoritative. Portable import export and Harbor/leaderboard trial
identity/outcome binding are separate source-context integrations.

Judge preparation retains ordinary Pi assistant reports as model messages.
Occurrence ratings resolve pointed argument objects and result strings directly,
with the same hidden-content projection used for semantic evidence. Imported
judge inputs carry their source class, unproven completeness and producer
limitations; these constrain absence and whole-attempt claims. Declared session
and trajectory IDs partition child operations without manufacturing native
request or timing identities. Ambiguous duplicate child IDs remain unavailable.

Pi behavior projection requires canonical JSON booleans and integer ordinals;
Harbor's structural coercions are not applied silently to the retained source.
Usage from a step with an untracked or aggregated inference count stays
unavailable unless its component completeness is established. Positive merged
usage cannot hide a zero-filled component. Independent fixture gates record
these cases as named source-information losses.
