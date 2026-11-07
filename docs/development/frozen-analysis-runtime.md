# Frozen 1.x analysis runtime

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
read APIs do not launch a candidate, verifier or model judge. Its external npm
dependencies remain pinned to the installed versions named in the manifest;
a later dependency upgrade must retain a compatible installation or qualify a
new runtime identity. Snapshot files are ordinary shipped EBO code under the
repository's license.

## Reproduce the snapshot

From a source checkout with Node 24.19.0 and installed dependencies:

```sh
npm run compatibility:verify
```

The builder archives the exact trusted Git commit into a temporary directory,
bundles the named read APIs with the installed esbuild, copies the source
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
