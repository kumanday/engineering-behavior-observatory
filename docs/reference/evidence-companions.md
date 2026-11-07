# Retain supplemental evidence for an attempt

`ebo.evidence-companion/v1` binds supplemental evidence to an existing owned or
imported attempt. The library API retains an immutable companion beside the
original bundle. Ordinary corpus discovery, qualification and normalization
continue to use the original attempt. A companion contributes no trial, native
message, tool operation or execution outcome.

Use `writeEvidenceCompanion(baseRoot, destination, request, files)` to retain a
new companion and `readEvidenceCompanion(baseRoot, companionRoot)` to verify it.
The request names the original manifest's canonical SHA-256, a producer/version
and policy digest, original source ranges, supplemental artifacts and coverage.
The generated manifest also binds the original manifest's exact byte digest,
run ID and attempt ID. Each original source range must resolve through the
original attempt's verified resolver with the same identity and digest.

Artifact descriptors declare IDs, relative paths, raw byte digests, sizes and
JSON, JSONL or text media types. Files are supplied as a map from descriptor ID
to bytes. Citations use canonical JSON-pointer value digests. A JSONL line uses
`#/lines/N`, where N is the original one-based line number; blank lines retain
their positions. A child field can use `#/lines/N/message`. JSON and text files
use `#` for their entire value.

Supplemental observations describe context boundaries, workspace changes,
coverage gaps and conversion diagnostics. They cite companion artifacts and
carry scalar attributes. A partial history can supply useful evidence while its
coverage remains partial. These observations do not override the original
capture's completeness, termination, verifier result or qualification.

Readback returns separately namespaced records and a resolver. Build a citation's
artifact ID with `companionArtifactId(read.digest, localArtifactId)`. This binds
the citation to that companion revision and prevents it from shadowing an
original native artifact. Consumers must opt in to these supplemental records;
the API does not insert them into the original dataset.

The writer validates all bindings before staging files, writes the companion
manifest last and publishes a new directory. Existing nonempty destinations are
preserved. Failed staging directories remain available for inspection. Readback
rejects stale bytes, different attempts, changed manifests, unsafe relative paths
and links within the supplied evidence roots. Limits are 64 artifacts, 16 MiB
per artifact, 64 MiB total, 10,000 JSONL records and a 4 MiB manifest. JSON has a
64-level, 250,000-node bound.

Companions remain restricted. Sanitizing selected supplemental content with
`sanitizeDerivedExport` requires recomputing artifact and pointed-value digests
before binding it. That transformation does not grant sharing approval. A
companion bound to a restricted attempt cannot simply be copied onto a portable
export: that export has a different manifest identity. This API implements the
EBO binding contract; it does not collect workspace history or execute converter
code supplied by a document.
