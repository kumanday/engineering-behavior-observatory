# Antigravity CLI 1.5.9 qualification

Personal OAuth qualification passed on macOS ARM64 and in a Linux ARM64 Harbor
child on 2026-11-17, using EBO's Node 26.13.0 coordinator. The publisher archives
passed frozen installation integrity, release withdrawal, provenance discovery
and OSV checks. Publisher attestations were not offered.

| Execution boundary | Admitted capture receipt |
| --- | --- |
| Local macOS | [Receipt](catalog/receipts/fed3bea96e31eda06fe3f6ee9edb3c23962ea09ea1dcd9331a02e95dbab2fae7.json) |
| Linux Harbor child | [Receipt](catalog/receipts/d81e372c921079b02193658014f02ecf9a4f3863fd0a70428768355e4f85a0b7.json) |

Each boundary ran three distinct owned attempts against the exact frozen CLI:

- Read and edit an authored file, then run its local test. An independent local test
  passed after capture.
- Run a deliberately failing test, edit the implementation and rerun the test.
  An independent local test passed after capture.
- Interrupt a started foreground tool. The retained lifecycle confirmed complete
  evidence drain, completed cleanup and owned process termination.

Both receipts check installation, runtime probe, native readback, session
identity, tool-call/result pairing, workspace retention, usage, native terminal,
interruption and teardown. Native v2 validation passed. Every ATIF derivative
passed EBO's structural admission and the independent Harbor trajectory model.
ATIF retains available visible call/result content; a DONE snapshot without
output has no ATIF result body. Complete endpoint-population equivalence is not
claimed. The success and recovery derivatives each retained four calls and
three result bodies; native v2 retained four paired tool operations. The
interruption derivative retained one pending call and no result.

A separate live `ebo antigravity run` used a runtime-bound frozen queue and
produced a `run-manifest/v2` bundle with 17 normalized events. Its retained proof
file, native v2 projection, independent ATIF validation and sanitized portable
export all passed their checks.

The Linux preparation and provider checks used Harbor 0.26.0 and Smol 1.35.0.
Two additional independent warm Harbor branches each executed the production
EBO worker and passed a proof-file task, native v2 readback and ATIF validation.
The checker confirmed distinct conversations and EBO attempts, an unchanged
parent workspace, accessible parent keyring and deletion of both children.
The private branch report has SHA-256
`d5a2ae03f38faa34661d3889863c501323114e206c75f0de2c16a5ee09100472`.
Only digests and capability results are published; native source evidence and
OAuth state remain private.

Hooks, model-request identities, complete child histories and OTLP are
unqualified through this stream-json boundary. The catalog's failure-follow-up
claim remains unavailable because the stream does not identify distinct issuing
inferences or consistently supply structured tool outcomes. `module-api` is
unavailable for this executable integration. Cold restart and expired-token
refresh were not tested; authentication requires a prepared, unlocked keyring.
The preparation helper's provider/worker check does not bind a normal study's
queue or prepare its task parents.

The [contract](../contracts/antigravity-cli-1.5.9/manifest.json) records release
selection and archive digests. The [harness guide](../docs/harnesses/antigravity-cli.md)
contains the reproducible setup and qualification commands.
