# Retained Harbor trial imports

Use the post-run import path to inspect or retain an existing Harbor trial.
This path launches no candidate agent, verifier or environment:

```sh
ebo atif inspect-harbor ./trial --namespace source-collection \
  --python /path/to/harbor-0.24.0/bin/python

ebo atif import-harbor ./trial ./restricted-store \
  --namespace source-collection \
  --profile 'pi/harbor-0.24.0/atif-1.7/agent-unknown/harbor' \
  --python /path/to/harbor-0.24.0/bin/python
```

The producer profile is an explicit operator declaration. An unversioned
`lock.json` does not establish the Harbor converter version. Source-context
validation uses Harbor 0.24.0's `TrialResult` model in an isolated bounded
subprocess, records its model-source and validation-policy digests, and keeps
the original JSON as evidence. EBO also requires explicit source identity and
lineage fields; model defaults never supply an execution UUID or prove that a
trial was an original execution.

## Identity and lineage

The source namespace and original `TrialResult.id` define the execution ID.
Relocation and byte-identical reuse preserve that ID. Execution identity binds
the original task checksum, agent/model configuration and declared start. A
conflicting reuse of the UUID cannot replace the retained execution record.

Capture revisions hash the original execution identity, native agent-file
inventory and retained ATIF bytes. The selected producer fingerprint also enters
the stored capture revision. An ATIF backfill or changed native log therefore
creates a revision of the same execution. Assessment IDs separately bind the
trial-result bytes, verifier-file inventory and original executor. Regrading or
rewriting an assessment does not manufacture another agent attempt.

For regrades, supply an explicit local binding file with `--originals`:

```json
[
  { "sourceReference": "11111111-1111-4111-8111-111111111111", "directory": "./retained-original" }
]
```

A hub derivation uses its `source_trial.trial_id` as the reference; a local
one uses the exact recorded `source_trial.path`. Source references never trigger
local-path traversal, hub access or downloads. The retained original must have
matching agent information and native agent-file hashes. Lineage cycles,
unresolved executors and conflicting evidence stay inspect-only. EBO native
adapter trials require an owned binding; this importer rejects their admission.

## Storage and evidence limits

The store separates immutable `sources`, `inspections`, `executions`,
`captures`, `bindings`, versioned contextual `memberships` and `assessments`. A source snapshot's
identity depends on its namespace and sorted file descriptors. Contextual
inspection receipts are separate, so supplying a missing original binding can
resolve an existing snapshot without replacing its bytes. Repeated identical
imports verify and reuse the existing capture. Failed admission remains under
`pending`; a retry preserves that evidence and uses another pending directory.

The source inventory contains named root records plus `agent/` and `verifier/`
files. It admits at most 4,096 entries, 64 MiB per file, 256 MiB in total and
32 directory levels. Links are rejected. Trial-result validation is bounded to
4 MiB, 15 seconds and a 64 KiB validator response. Media files remain retained
source artifacts; references cause no implicit fetch or activation.

Root trial records, agent logs and verifier records retain separate third-party
authority labels. Reward values and exception types remain source declarations.
A `finished_at` timestamp does not prove agent completion, and arbitrary numeric
rewards do not become EBO verifier passes. Imported captures keep their separate
qualification and complete-attempt measurement limits.

`captures/` is a revision store rather than a selected corpus: several revisions
may share one execution identity. Select one revision per execution for a
cohort. The leaderboard importer owns cohort membership, source refresh and
benchmark-specific outcome interpretation. Native-companion fidelity checks and
portable export policy are separate integrations.

`readHarborCapture(store, captureRevision, sourceSnapshotDigest)` reopens an
explicitly selected revision without Python. It verifies retained source bytes,
the ATIF admission receipt and the execution, inspection, assessment and revision
bindings before returning source context. Changed or linked retained evidence
fails readback. ATIF and trial agent names and explicit versions must agree.

Source and context writes are staged under unique `pending-writes` paths and
published without replacing existing files. Interrupted staged bytes stay
retained; retries publish a complete new stage. Capture identity includes
descendant trajectories and every agent artifact; the root trajectory is hashed
separately. Context memberships are versioned by inspection digest. If a snapshot
has several valid contexts, pass the returned `inspectionDigest` as the fourth
argument to `readHarborCapture`; readback requires explicit selection. The import
CLI returns the stored `captureRevision` and the separate `sourceCaptureDigest`.
