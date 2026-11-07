# Typed v2 analysis

The opt-in v2 lane derives structural observations, occurrence ledgers, rating
inputs, semantic judge inputs, assertions and Atlas units from typed operations
and event facts. It accepts all eight registered owned-native projections and
the registered Pi, Codex, Hermes and OpenClaw ATIF producers. Imported evidence
retains imported qualification; each measurement names its recorded population
or a partial whole-attempt lower bound.

```sh
ebo v2 inspect /path/to/retained-bundle /path/to/new-analysis-directory
ebo v2 prepare-judge /path/to/retained-bundle /path/to/new-analysis-directory request.json
```

The output includes the v2 dataset, observations, occurrence ledger, individual
rating inputs and a local Atlas page. Judge preparation also writes
`judge-input.json`. These commands prepare local artifacts. Backend execution
requires an explicit callback through the library API. Existing CLI analysis
commands retain their v1 contracts, and shipped v1 readers remain available
through their fixed runtime identities.

A judge request names one declared behavior dimension and pins its rubric and
evaluator configuration:

```json
{
  "schemaVersion": "ebo.semantic-judge-request/v2",
  "behavior": {
    "vocabularyVersion": "1.0.0",
    "categoryId": "verification-completion",
    "dimensionId": "verification-completion"
  },
  "rubric": {"id": "verification", "version": "1.0.0", "instructions": "Assess the visible verification evidence."},
  "evaluator": {"id": "operator-selected", "version": "1.0.0", "configuration": {}},
  "eventIds": [],
  "limits": {"maxRecordChars": 6000, "maxInputChars": 1000000}
}
```

`eventIds` selects complete native records to include alongside the full typed
ledger and structural measurements. An empty selection supplies the ledger and
measurements without additional native records. Bounds fail explicitly when
selected evidence or a ledger does not fit. Long strings retain marked excerpts.
Missing evidence remains unknown; preparation never drops a ledger row to make
an input fit.

## Measurement and occurrence semantics

Measurements declare a population and coverage. Identified tool operations,
source-native requests, observed request boundaries and declared inference
counts are distinct measures. A Pi model-output identity groups sibling tool
calls without establishing a provider request or an inference count. ATIF
source diagnostics use a `source-` prefix and explicit population. Whole-attempt
counts remain partial or unavailable. Converter
zero-fill limitations preserve unknown success and partial failure counts.

Resource measurements keep source, population, authority and
increment/snapshot/final semantics separate. Repeated cumulative snapshots do
not become summed usage. Receipt and producer-observation clocks provide no
execution duration.

`execution-follow-up` requires an explicit failed result and a uniquely earliest
comparable subsequent call in the same activity scope. A sibling from the same
model output is excluded. `inference-conditioned-response` remains unavailable
until a source establishes that the later inference received the failure.
Chronology supplies no conditioning relation. Repeated-operation groups count
additional equal signatures without inventing their chronological first member.
Command-based validation and source-change occurrences are labeled heuristic;
a write command establishes an attempt, and recorded failure stays explicit.

## Evaluation and evidence

Rating inputs read normalized `tool-input` and `tool-result` roles. The source
adapter owns native field interpretation. Deterministic facts remain separate
from model answers. `rateOccurrenceV2` requires an explicit backend callback,
validates its citation whitelist, and retains failed or deferred answers.
`validateRatingRecordV2` reconstructs the input and acceptance policy.

Semantic inputs bind dataset, observations, ledger, ratings, request and
configuration digests. Evaluated-model aliases are blinded in visible evidence;
hidden reasoning is omitted. The prompt delimits untrusted evidence and asks
for atomic cited claims, an alternative explanation and abstention when needed.
Behavior assertions retain constructive/adverse/mixed/context-dependent
assessments, confidence and proposed status. Workspace claims require an
explicit cited working-directory field. Validation reconstructs judge inputs
from retained source evidence.

Judge and Atlas use `citeEventV2`: the cited event must own the exact reference,
and its canonical pointed-value digest must resolve in the same run and attempt.
Changing the pointer, content, dataset, evaluator or dependent ledger invalidates
readback.

## Atlas and compatibility

`buildAtlasViewV2` produces typed operation, canonical message and context units
with evidence drilldown. Unknown status and duration remain explicit.
`buildAtlasCohortsV2` combines cohort summaries with declared runtime identities;
v1 cohorts execute only fixed shipped readers. Cohort measures keep their own
origin and populations.

The local Atlas page and JSON are restricted inspection artifacts. Their source
content remains private. Sharing and release packet generation retain their
separate policy and verification gates. The v2 page uses escaped embedded data
and text nodes for evidence.

The v1 operation aliases and message-role policy live in
`v1-consumer-compatibility.ts`. Typed v2 consumers use operations and facts.
Frozen runtime capsules and retained source artifacts remain unchanged.

## Verification

Run the consumer fixtures and the existing v1 regression checks with the pinned
Node version. The authored paired Pi fixtures exercise equal recorded tool
counts, branch-selection loss, interrupted results, converter status loss and
independent request/inference measures. Additional checks cover citation
readback, blinding, bounded inputs, stale ratings, assertion reconstruction,
mixed v1/v2 cohorts, Atlas escaping and the CLI. Release qualification also
requires the retained native baseline and migration reconciliation.

Model-facing payloads carry a citation registry with explicit accepted IDs.
Semantic answers return `citationIds`; EBO resolves them to the original
pointer references and digests. Input-owned run, attempt, behavior, evaluator
and dataset bindings cannot be supplied by an answer. Backend callbacks receive
the blinded model payload. Canonical ledgers, ratings and their digests remain
in the private preparation artifact for validation.

A request can declare `ratingRequirements.types`. Preparation records the
occurrences still needing rating receipts, and judge dispatch stays blocked
until those receipts exist. Failed or uncertain ratings remain visible evidence.

Backend callbacks also receive a closed response schema. Its answer body omits
artifact versions and input-owned identifiers; EBO supplies those fields when
it validates and records the response. `ratingAnswerSchemaV2` and
`semanticJudgeAnswerSchemaV2` expose the same wire contracts to integrations.

Owned readers bind the manifest model and producer-reported model aliases before
preparation. Blinded workspace labels map back to one canonical cited working
directory when an assertion is recorded. Compaction and delegation rating
inputs include bounded source records. Atlas groups content blocks sharing a
message identity and retains partial-message facts and every block's evidence.

Occurrence extraction uses adapter-established canonical endpoint order when
passive hook copies have a different clock domain. All source copies remain
citable. Source-change heuristics include file creation and notebook edits as
attempts. Rating batch readback reconstructs each distinct bounds configuration
once and verifies every retained receipt against its original occurrence.

Rating output includes normalized tool-result and tool-error evidence with
pointed citations. Editor subcommands retain mutation attempts; explicit view
commands remain read-only. Scalar shell commands retain their native text even
when that text also parses as a JSON primitive.
