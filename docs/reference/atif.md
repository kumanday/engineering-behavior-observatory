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
