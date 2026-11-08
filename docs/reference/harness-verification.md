# Harness verification

A runtime can install, report the expected version and expose the expected API
without delivering every piece of capture evidence. EBO records these checks
separately. One verification catalog supplies confidence for all eight native
harnesses, retained analysis and launch summaries. Development dependency pins
and historical fixture inventories do not decide confidence.

An unfamiliar runtime remains runnable when its installation and format contract
work. Its recorded evidence remains readable. Verification never gates generic
ATIF import.

## Read the status

| State | Meaning |
| --- | --- |
| `unverified` | No matching admitted runtime probe is frozen, or matching probe claims conflict. |
| `probe-checked` | Matching installation/version probes have been admitted. Capture capabilities still need scoped evidence. |
| `capture-checked` | At least one named capture capability has matching evidence for this profile and model route. Read each capability's result. |

Each named capability is `checked`, `unverified` or `conflict`. A checked capability
describes the recorded qualification cases. It does not establish complete delivery
on every task. Missing evidence stays unverified; contradictory receipts remain
conflicted until an operator admits an explicit resolution.

The receipt stores `checked`, `failed` or `unavailable` test results. The selected
interpretation turns absent or unavailable evidence into `unverified`. A failed
claim cannot be promoted by another receipt with a later timestamp.

| Capability | Evidence checked |
| --- | --- |
| `installation` | Frozen installation passes file integrity, withdrawal and current security checks. |
| `runtime-probe` | Each runtime root reports the version in the lock, through package metadata, an executable or server information. |
| `module-api` | Required SDK exports exist; OpenHands instead checks its owned server-info response. This does not exercise a model turn. |
| `readback` | Owned native records reopen and produce a nonempty v2 projection. |
| `session-identity` | A native session identity is retained. |
| `tool-call-result` | A recorded tool operation has linked call and result endpoints. |
| `workspace` | The retained terminal references the validated workspace artifact. This does not prove task correctness. |
| `usage` | Typed native resource values are present, with their recorded scope and semantics. Completeness is unproven. |
| `hooks` | A native hook record is projected. This does not establish delivery of every hook. |
| `terminal` | The success case retains a completed terminal accepted by its native reader. |
| `failure-follow-up` | A known failed result precedes a successful call issued by a distinct, known inference in the same scope. Sibling calls from one output do not establish a response. |
| `interruption` | An interrupted case retains a started native operation and semantic evidence, plus matched running/terminal lifecycle, complete drain, completed cleanup and confirmed harness termination. |
| `teardown` | The lifecycle diagnostic records complete drain, completed cleanup and confirmed harness termination. |

Capture capabilities require three distinct owned bundles: success, failure
follow-up and interruption. Prepare the success task to read and edit a file and
run a local test; prepare the failure task to expose a deliberately failing tool;
interrupt an active owned operation in the third case. Review those task-level
expectations alongside the exact checks above. The tool reports only the
capabilities its retained evidence establishes. Imported and authored ATIF are
not owned qualification captures.

## Prepare evidence without model inference

First freeze a separate qualification study with the exact runtimes to check,
using the [runtime workflow](study-runtimes.md). The study can be capture unverified.
Write a verification request:

```json
{
  "studyRoot": "/absolute/path/qualification-study",
  "role": "cursor-sdk"
}
```

```sh
ebo runtime verify ./verification-request.json ./private/candidate.json
```

This verifies the installation and security policy, loads the selected SDK and
checks its API, and probes owned executables where the role has them. OpenHands
starts its locked local container and reads server information. It submits no
model turns. Its candidate can establish probe claims only.

For capture checks, add `cases` to the request after the owned runs exist:

```json
"cases": [
  { "kind": "owned-capture", "case": "success", "bundleRoot": "/private/success" },
  { "kind": "owned-capture", "case": "failure-recovery", "bundleRoot": "/private/failure" },
  { "kind": "owned-capture", "case": "interruption", "bundleRoot": "/private/interrupted" }
]
```

The three bundles must bind the same runtime graph, artifact integrities,
platform, capture contract, capture profile and model/provider route. Reuse real
retained captures when those identities match. Bundles without the required
binding cannot establish capture verification. Older captures without lifecycle
evidence leave interruption and teardown unverified.

Candidate files contain private source paths. Keep them with the qualification
study. Catalog receipts contain identities, digests and capability results;
they contain neither native messages nor source paths. Hash-only receipts do not
grant permission to publish the corresponding logs.

Before any paid qualification captures, prepare the exact route, token/turn/time
limits, vendor pricing and proposed spending ceiling for operator approval.
`runtime verify` does not create or retry paid captures.

## Admit and freeze the interpretation

Admission is a trusted operator action. Review the candidate and retained evidence,
then write an operator file:

```json
{ "id": "qualification-operator", "reason": "Reviewed the retained probe and capability results." }
```

```sh
ebo runtime verification admit ./catalog ./private/candidate.json ./operator.json
ebo runtime verification inspect ./catalog
ebo runtime freeze ./research-study ./runtime-request.json --verification-catalog ./catalog
```

Admission reloads and validates the candidate's source evidence and performs fresh
launch security checks. Library callers must similarly prepare or validate the
candidate before calling `admitHarnessVerification`. Changing a candidate does
not preserve its admission authority. Admission cannot elevate a probe into
capture verification.

The catalog has immutable `receipts/<digest>.json` and `admissions/<digest>.json`
records. A new release can gain evidence through these data files without an
adapter change or an EBO release. EBO combines its shipped seed catalog with the
explicit operator catalog. A checkout with no admitted seed evidence starts
unverified; mocked tests are never shipped as verification seeds.

To resolve conflicting claims, include `supersedes` in the operator file, naming
the **receipt digests** being replaced for the same runtime and scope. To withdraw
evidence, write a withdrawal file with `id`, `reason` and `receiptDigests`, then run:

```sh
ebo runtime verification withdraw ./catalog ./withdrawal.json
```

Selection is deterministic and independent of timestamps. Withdrawal of a
replacement never reactivates its superseded receipts. Neither action changes
snapshots already frozen into studies.

New freezes use `ebo.study-runtime-lock/v2` and retain the selected receipts,
admissions and catalog digest. Runs use `ebo.runtime-launch/v2`; their
`run-manifest/v2` retains `runtime/harness-verification.json` alongside its lock
and launch receipt. The run selects capture claims by capture-profile digest
and model/provider route digest. A changed component, artifact, platform or
capture contract requires matching evidence; changing a route or profile leaves
its capture claims unverified.

An existing freeze stays immutable when `freeze` is repeated. Create an explicit
new study revision to adopt new receipts. Offline readback uses the run's frozen
snapshot and never queries a live catalog, registry or installation. Version
contradictions remain readable with a confidence limitation. Invalid diagnostic
bindings fail with a specific integrity error. Lock and launch v1 remain
readable; captures without a verification snapshot have unverified confidence.
The frozen rc.1 and rc.2 archives retain their original interpretations.

Verification is metadata alongside the retained reader result. It does not alter
the normalized 1.x dataset payload, so existing assertion digests and frozen Atlas
readers keep their original contract. Native v2 sources include verification
limitations; those interpreted v2 dataset digests can change with a new explicit
study snapshot.

Launch output and retained source limitations expose the
[confidence limitation codes](atif-limitations.md#native-version-confidence).
Runtime security warnings and blocks remain independent of historical
verification: withdrawal, integrity and OSV checks run before every owned launch.
