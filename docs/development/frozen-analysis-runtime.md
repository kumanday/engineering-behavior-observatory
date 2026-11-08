# Frozen 1.x analysis runtimes

`ebo-v1.4-atif-20261107` preserves the 1.x read and analysis implementation at
`fb1dfd7397836de1eab370090534433f0383f45f`. It contains the reviewed capture-version
guard, occurrence rules 1.2.0, pointer citations, Pi import, Harbor lineage and
origin-aware Atlas analysis. This runtime keeps those semantics while later
normalizers and schemas evolve.

Use `listAnalysisRuntimes()` to find shipped identities and
`await loadAnalysisRuntime(id)` to open one. The returned identity binds its
source commit, raw snapshot-manifest digest and Node version. It exposes retained
behavior loading, structural observations, assertion validation, Atlas loading
and querying, and packet/RO-Crate verification. Preserve that identity with each
cohort's analysis receipts.

The registry accepts a shipped ID. It accepts no reader path, source revision,
module URL or executable supplied by a packet. Before importing the fixed entry
module, the loader verifies every asset's size and SHA-256, rejects links and
unlisted files, and checks Node and installed dependency versions against the
snapshot. Unsupported identities or changed runtimes fail explicitly.

The frozen capsule includes its schema, contract and ontology assets. Its eight
read APIs consume retained evidence. The external dependency roots named in each
manifest are isolated from active capture SDKs through a dependency anchor and
exact compatibility aliases. Pi's historical sibling packages are routed through
the same isolated graph. Snapshot bytes and identities stay fixed.

The returned `nodeVersion` identifies the snapshot's original qualification
host. Compatibility checks also replay both readers on Node 26.13.0. The
published dependency anchor declares its original Node 24.19.0 engine; standard
npm installs warn on Node 26, and `engine-strict` installs reject that metadata.
Use `npm run ebo` or the checkout's explicit `dist/src/cli.js` when operating from
source. The dependency anchor carries its own historical CLI entrypoint.

The package lock retains the resolved support dependencies. The snapshot
manifest pins the original external roots; it does not describe every transitive
package as a byte-identical historical closure. Golden retained readback and
packet verification check the preserved analysis behavior.

## Reproduce the native 1.4 baseline

`ebo-v1.4.0-86a6010` binds the original 1.4.0 source at
`86a601079a51243756fe52798365a9cbf69cfe6f`, including occurrence rules 1.1.0.
Use it to reproduce native studies and observation digests created with that
implementation. Use `ebo-v1.4-atif-20261107` for refreshed source-local ordering
and additive ATIF imports. Both are fixed shipped implementations with their
own source, asset and dependency receipts.

The legacy runtime supports the native manifest formats present at its source
revision. Select the additive runtime for imported trajectories. Per-cohort pins
allow different retained studies to keep their original reader; shared attempts
still require equivalent projections and observation sets.

## Reproduce the snapshots

From a source checkout with the repository’s pinned Node release and installed dependencies:

```sh
npm run compatibility:verify
```

The builder verifies both registered snapshots. It archives each exact trusted Git commit into a temporary directory,
bundles the named read APIs with the pinned historical esbuild, copies the source
assets, and constructs a raw-byte inventory. It compares an existing capsule
byte for byte and never overwrites it. A different source, builder or dependency
result requires an explicit new runtime identity and qualification.

## Compatibility and migration

The native fixture baseline remains the reference for supported 1.x readback.
The runtime must preserve each accepted dataset digest and each rejection
boundary. Existing 1.x packets retain file verification and regenerated
RO-Crate equality. The current 1.x runtime includes the occurrence correction;
older observation sets and ledgers still require the version-specific
compatibility accounting described in the ATIF design.

V2 adapter and consumer activation is a separate gate. This capsule supplies the
shipped reader mechanism. Migration still requires deduplicating study inputs,
comparing dataset and ledger dependencies, identifying affected assertion units
and proposing any paid re-judge budget. Runtime selection does not authorize
regeneration or inference.

## Pin an Atlas cohort

A bundle request can select the fixed runtime and its exact manifest digest for
each cohort:

```json
{
  "id": "retained-study",
  "atlasRequest": "study/atlas.json",
  "analysisRuntime": {
    "id": "ebo-v1.4-atif-20261107",
    "manifestDigest": "sha256:16c2da39f03f44e33eaccd8ddc9f72de6b73e3a5cf25152ae292f8e7295548c5"
  }
}
```

This object belongs in the bundle request's `cohorts` array. The builder loads
and queries the cohort and reads its retained attempts through the selected
runtime. Its manifest and cohort report retain the full source/runtime receipt.
A cohort without a pin uses the current implementation.

One attempt can belong to current and frozen cohorts when their datasets,
coverage, qualification, model-blinding aliases and outcome inputs agree. A
conflicting projection fails the build rather than silently choosing a reader.
The Atlas tables v1 column contract is preserved. Runtime selection changes no
source bundle and runs no model judgments.
