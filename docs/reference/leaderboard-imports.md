# Import a Harness Leaderboard cohort

A cohort combines protected board metadata with explicitly selected retained
Harbor trials. One execution occupies one slot in the EBO corpus. Capture
revisions, source assessments, source board classifications and cohort membership
have separate identities. Imported evidence keeps its own qualification.

## Install the policy runtime

Use Node 24.19.0 and a Python environment containing Harbor 0.24.0 and the pinned
public board package. The importer validates seven installed source/data hashes
before calling the package's public `board_facts` policy:

```sh
uv pip install --python /path/to/python --no-deps \
  'harness-leaderboard @ git+https://huggingface.co/spaces/joelniklaus/harness-leaderboard@c4a8c4cb468aa1b1e8f3e31c002d2272cc090236'
```

The policy runtime reads source JSON on stdin in an isolated subprocess, bounded
to 32 MiB input, 16 MiB output and 15 seconds. It launches no benchmark, agent,
verifier or model judge. Imported documents cannot supply executable policy code.
A missing or mismatched runtime produces an inspect-only receipt.

A `complete` input must retain every fact’s run record and the recursively linked original facts and run records needed for reuse ordering and invalidation. Cyclic or conflicting reuse chains remain unavailable. Missing closure produces an unavailable policy receipt with no definitive exclusions. Bounded subsets keep their explicit population limit.

The board-policy revision is independent of each trial's execution-time
producer/converter revision. The current board policy includes trial-specific
invalidations, verdict overrides, setup/version gates, reused-execution ordering,
scored-attempt caps and provider-exhaustion rules. EBO calls the pinned upstream
implementation so these rules retain their source meaning. Its classifications
remain third-party assessments.

## Retain an acquisition snapshot

Use a new restricted directory for each acquisition. `acquisition.json` declares
only protected root run records and benchmark fact shards:

```json
{
  "schemaVersion": "ebo.leaderboard-acquisition/v1",
  "source": "https://huggingface.co/buckets/joelniklaus/harness-leaderboard",
  "retrievedAt": "2026-11-07T00:00:00Z",
  "sharing": "restricted",
  "terms": "unstated",
  "attribution": "Joël Niklaus / Harness Leaderboard",
  "artifacts": [
    {
      "remotePath": "runs/source-run/run.json",
      "localPath": "runs/source-run/run.json",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "bytes": 0,
      "listedXetHash": null,
      "authority": "protected-leaderboard-record"
    }
  ]
}
```

Replace the example descriptor with the actual retained bytes and receipt.
Allowed source records are `run.json`, `invalid.json`, benchmark `plan.json`,
`trials-N.jsonl` and `trials-reused.jsonl`. Run/fact identities must agree with
their protected paths. Agent-writable meter logs stay in native trial evidence;
they cannot become protected board facts.

Metadata is bounded to 4,096 files, 4 MiB per file, 32 MiB total, 100,000 facts,
256 KiB per fact, 64 JSON levels and one million JSON nodes. Links are rejected.
Both the listed Xet identity and actual byte SHA are retained. A supplied observed
Xet identity must match the listing. These fields preserve the acquisition proof;
EBO performs no implicit network fetch or reference activation.

The sample acquisition helper under `scripts/atif-import-pilot/` is for a small,
purposeful source sample. A full-board claim requires the complete retained
invalidation and reuse closure. Use `bounded-subset` for a pilot; its source
selection counts describe only that retained population. Aggregate retained JSON uses the same 32 MiB byte, numeric, depth and one-million-node limits at write and read time.

## Declare the cohort

Save a request next to the snapshot and native trial directories:

```json
{
  "schemaVersion": "ebo.leaderboard-cohort-request/v1",
  "policyRevision": "c4a8c4cb468aa1b1e8f3e31c002d2272cc090236",
  "snapshotRoot": "./snapshot",
  "historyCompleteness": "bounded-subset",
  "nativeBindings": [
    {
      "factId": "11111111-1111-4111-8111-111111111111",
      "directory": "./trial",
      "profileId": "pi/harbor-0.24.0/atif-1.7/agent-1.2.0/harness-leaderboard-0583ba55ac8ddaea3464c85b54828baeaa8d834a"
    }
  ]
}
```

Choose the exact registered profile ID from `ebo atif profiles`. Request-relative
paths resolve against the request's directory. Original-trial bindings use the
[Harbor lineage contract](harbor-imports.md#identity-and-lineage).

```sh
ebo atif import-leaderboard ./cohort.json ./.ebo/leaderboard-store \
  --python /path/to/python

ebo atif read-leaderboard ./.ebo/leaderboard-store sha256:COHORT_DIGEST
```

Native bindings are limited to 64 explicitly selected trials per request. The
trial UUID, task, harness/version, reward and exception must agree with the
protected source fact. Protected selected run records and their original-run records supply canonical and route-qualified model aliases. They are bound into capture blinding metadata alongside Harbor/ATIF aliases. Additional blinding context creates a new derived capture revision of the same execution; existing capture bytes remain intact.

Unresolved context and rejected ATIF admissions stay inspect-only per trial; remaining valid selections continue. Two selected
capture revisions of one execution require an explicit choice rather than two
attempt slots.

## Reuse, refresh and quarantine

The store keeps protected source snapshots, acquisition/context receipts,
selection receipts, native snapshots/scans, Harbor capture revisions and selected
cohorts separately. Metadata inventories are sorted by remote path. Relocation
and inventory ordering preserve source and cohort identity. Exact repeat imports
verify and reuse existing bytes. Acquisition and request digests both participate in context identity, so distinct requests producing the same cohort can coexist.

Each selected corpus contains byte-identical admission manifests, trajectories
and inspections from the Harbor revision store, plus a verified corpus index.
A backfilled trajectory creates another capture revision of the same execution.
Regrades retain their linked assessments. Source board outcomes remain distinct
from EBO terminal completion and verifier success.

Pattern scans bind the source inventory and scanner implementation digest. HF
tokens and the shared export credential patterns quarantine affected revisions.
Admission reads the immutable snapshot covered by the scan. Each linked assessment retains its own scan receipt. Findings retain paths, source digests and reasons; matched values stay in the
restricted raw evidence. Unknown scan results also quarantine the revision.
Source and scanner revisions coexist as immutable records.

A refresh uses a new acquisition snapshot and can name `priorCohortId`. Missing or
moved native sources receive explicit exclusions. `withdrawnFactIds` excludes
named trials from a new cohort revision for takedown handling. Withdrawal, selection and duplicate matching use UUID identity regardless of letter case; original protected record spelling remains in provenance. Historical private
cohorts remain intact. Raw imports and source terms retain restricted status.

Readback verifies source byte hashes, policy-input binding, scan receipts,
execution/capture/assessment identities and the selected corpus. It requires no
Python or fetched code. Structural Atlas generation can consume the selected
`corpus/` through the ordinary imported-evidence path.


Acquisition contexts are content-addressed separately from cohort identity.
They are retained before cohort completion and verified during readback. One
cohort supports up to 128 contexts and 32 MiB of context receipt bytes. A new
context that exceeds either budget is rejected before publication; existing
cohorts and exact re-imports remain readable.
