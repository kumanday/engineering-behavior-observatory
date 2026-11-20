# Atlas bundles

An Atlas bundle is the analytical layer behind the interactive viewer: Parquet
tables built from validated EBO artifacts, one report per cohort, and a manifest
that binds every file by size and SHA-256. Native records stay authoritative;
the tables are derived views that point back to them.

```sh
ebo atlas bundle build <request.json> <output-root>
ebo atlas bundle verify <bundle-dir>
```

## Request

```json
{
  "schemaVersion": "ebo.atlas-bundle-request/v2",
  "id": "behavior-study",
  "title": "Behavior study",
  "cohorts": [
    { "id": "primary", "atlasRequest": "primary/atlas.json" },
    { "id": "matched-timeout", "atlasRequest": "matched-timeout/atlas.json" }
  ],
  "condition": { "pattern": "^(?<task>.+)-(?<condition>direct|sandboxed)-\\d+$" },
  "claims": "claims/behavior-study.json",
  "views": "views/",
  "embeddings": { "python": ".embeddings-venv/bin/python" }
}
```

Each cohort names an existing [Atlas request](../guides/atlas.md). The build
loads every cohort through the same validation as `ebo atlas build`: corpus
index, current structural observation sets, assertions and their citations,
and reviews. A stale or invalid source fails the build. Paths are relative to
the request file. `condition` names study arms with a regular expression over
each run bundle's directory name; without it an arm is `<model> · <harness>`, and
an imported arm adds the harness version (`<model> · <harness> <version>`), since
two releases of one harness can write the same agent name.

With a `condition` pattern, every run bundle must match it. Atlas tables key
attempts by attempt id and assessments by assertion id, so each must be unique
in a bundle: an attempt that appears in several cohorts must have the same run
manifest digest in each, and a reused id fails the build. The
bundle is built in a temporary sibling directory and published by rename only
after its manifest validates; the destination must be new or empty, and a bundle
is never overwritten.

`claims` names a claims file the study authors; claims are never generated.
`views` names a directory of view specs. `embeddings` chooses how cloud units
are embedded:

- `embeddinggemma` (the default): `google/embeddinggemma-2` at a pinned
  `revision`, run locally through SentenceTransformers in the Python runtime
  that `scripts/embeddings/requirements.txt` pins. `python` names that
  runtime's executable, relative to the request; without it the build uses
  `EBO_EMBEDDINGS_PYTHON` and otherwise stops before reading any attempt.
  Before reading any attempt, the build checks the runtime: it loads the model
  and embeds one text, and imports the layout backend when the layout may run
  at build time. A missing package fails the build in seconds.
  The runtime uses CUDA (bfloat16 where supported), else MPS, else CPU
  (float32), and says when it falls back to CPU; `device` and `batchSize`
  override its choices. Each unit's `embed_text` (behavior summaries and
  message text capped for embedding, never tool output or file contents),
  with secrets redacted, gets the model card's clustering prompt
  (`task: clustering | query: `). The published graph mean-pools and
  L2-normalizes. `dimensions` is 768 by default; 512, 256 and 128 are
  truncations, normalized again.
- `hashed-tfidf`: the offline option. TF-IDF over each unit's words,
  feature-hashed to `dimensions` (default 256). No runtime and no model.

EmbeddingGemma 2 vectors are cached under `cache` (default
`.atlas-cache/embeddings`) by model, revision, dimensions and redacted text
digest, so a rebuild embeds only new texts. Each distinct text is embedded
once. `cloud.embeddings` in the manifest records the provider, model,
revision and dimensions, and `run` records the pass: units, distinct texts,
cache hits, texts embedded, and the runtime's device, precision, batch size,
throughput and package versions. The viewer header and `describe()` name the
provider.

`layout` chooses where the cloud is laid out. `browser` leaves it to the
viewer, which runs UMAP over the vectors. `build` lays it out at build time in
the same runtime: per unit family, identical vectors once, PCA to 128
dimensions, then cosine UMAP with 15 neighbors, minimum distance 0.1 and seed
42. It uses cuML on a CUDA device (install `scripts/embeddings/requirements-gpu.txt`
too) and umap-learn on the CPU elsewhere. `units.arrow` then carries each
unit's `x`, `y` and nearest `neighbors`, the viewer clusters and labels the
given positions, and `cloud.layout.run` in the manifest names the backend and
its timings. `auto` (the default) lays out at build time above 200,000 units
when the runtime is available, since a browser cannot hold millions of
768-dimension vectors.

## Large bundles

Above 2,000 attempts the viewer's per-attempt documents are split, so neither
the build nor the viewer handles one document for the whole study:

- `assessments.json` keeps the cards, cohorts, attempts and certified tallies,
  with an empty `assessments` list. `assessments.arrow` indexes every card
  result (id, attempt, card, mode, producer, outcome, value, direction, review,
  cohort flags, probability, confidence and citation count, the repeated
  strings as codes into `index.dictionaries`). `assessments/<attempt>.json`
  holds that attempt's full documents. Certified cells keep their counts and
  arms without their judgment lists.
- `audit.json` names `split: "audit/"`, and `audit/<attempt>.json` holds each
  attempt's audit.
- `lanes.json` keeps every lane's metadata, and `lanes/<attempt>.json` holds
  its usage and context series.

The viewer loads the index up front and fetches an attempt's files when its
task's lanes or one of its drawer views open. The tables are the same either
way.

The build keeps only the identities of observation sets and card results
between the cohort pass and the attempt pass, and re-reads each attempt's
documents in the attempt pass. Tables, cloud rows and viewer documents are
written as each attempt is processed. Memory is set by the largest cohort's
validation, about 1.3 MB per attempt on synthetic imports with 93 card results
each, and the attempt pass takes about a quarter of a second per attempt.

## Contents

| Path | Content |
| :--- | :--- |
| `manifest.json` | `ebo.atlas-bundle/v2`: identity, builder, request digest, cohorts with source and cohort digests, tables with row counts, and every file with size, SHA-256 and role |
| `reports/<cohort>.json` | the cohort's aggregation report (the certified tallies), with its source and cohort digests |
| `tables/*.parquet` | Atlas tables v1 (zstd) |
| `units.arrow`, `embeddings.f32` | the cloud: one row per embedded unit (Arrow IPC, with `x`, `y` and `neighbors` after a build-time layout) and its vector (float32, row order) |
| `lanes.json` | swimlanes: lane metadata, cumulative tokens and context per request from normalized usage events |
| `assessments.json`, `audit.json`, `native/<attempt>.json` | card results per attempt and card (`card`, `family`, `outcome` as present, absent or unknown, `value` on a present dimension card, `mode` and `producer`, the ontology's `direction` for a present result, and for a decision-model result its `probability`, `probabilities`, `thresholds` and what it was `shown`) with an LLM judge's citations linked to units and native lines (SHA-256 of the full line), the judged cards and families in ontology order, the `modes` and `directions` in use, attempt audits, per-unit native records |
| `claims.json`, `views.json` | validated claims and view specs with their receipts, when the request names them |

Atlas tables v1, all keyed by stable EBO identities (`event_key` is
`<attemptId>/<eventId>`, since event ids are attempt-scoped):

| Table | One row per |
| :--- | :--- |
| `cohorts`, `attempt_cohorts` | cohort; attempt membership |
| `attempts` | attempt: identity, arm, capture qualification, terminal state, adapter, dataset digest, native record and unmapped counts, time span |
| `events` | uniform event with its native reference, order, time, tool fields, the resolved native content as JSON, and a flattened text view for search and embedding |
| `event_relations` | known relation between two events |
| `assessments`, `assessment_cohorts` | card result with its `card_id`, `family_id`, `ontology_version`, `verdict`, `value`, `producer_mode`, `direction`, `probability` and review state; inclusion and dispute per cohort |
| `citations` | assertion citation, with its occurrence and whether it resolves to a bundled event |
| `claims` | atomic factual claim of an assertion, with its cited events and workspace |
| `observations`, `observation_sources` | structural observation; its source events |
| `occurrences` | occurrence with its rule, heuristic flag, events and attributes |
| `edges` | typed provenance edge between the identities above |

Units 1.0.0 are the comparable steps of an attempt: a tool unit is one EBO tool
operation (call, result and hooks), a message unit one completed visible
message, compaction and delegation units are EBO occurrences, and an episode is
a message plus the tool units that follow it. A converter placeholder such as
`[tool call]`, written as the message of a turn that only calls tools, is not a
message unit; that turn's calls are its tool units. Unit ids are
`<attemptId>/<first event id>`. Their command classification reads command
text and is heuristic.

The viewer lays the cloud out in the browser with Embedding Atlas: a cosine
UMAP per unit family with a fixed seed, density clusters and labels from the
facets most over-represented in each cluster. Cloud statistics are exploratory.

## Claims and view receipts

The build validates every claim: each number recomputes to its stated value
(from a cohort report, a JSON pointer into a report, SQL over the bundle tables,
or audit verdicts), every supporting assessment is in the bundle, every cited
native line still hashes to its recorded SHA-256, and every cited view exists.
`claims.json` records each claim's result and the failures; it never drops a
claim that no longer holds. A claim over cohort report cells selects one
producer mode: when a cohort holds LLM-judge and decision-model results for
the selected card, the claim names the mode in `where.mode`, and a selection
that spans both fails.

Each view spec's `query` is recomputed over the same host tables the viewer
builds; its canonical rows (keys sorted, whole numbers as integers, compact
UTF-8 JSON) and their SHA-256 form the receipt the viewer checks.

Event text and content are never truncated. `ebo atlas bundle verify`
recomputes every listed file's size and digest and reports changed, missing and
unlisted files; it exits non-zero on any.

The tables are written with DuckDB 1.5.4, the release the viewer's DuckDB-WASM
runs, so a query or view receipt computes the same rows in Node and in the
browser.

The export uses one DuckDB thread and a 4 GB memory budget, and spills to the
build's temporary staging directory, so a study whose event table exceeds
memory still builds. Within one build, an attempt's validated evidence is
reused for that attempt's further assertions; every reuse first hashes the
manifest and each listed artifact again, and changed bytes force a rebuild.
