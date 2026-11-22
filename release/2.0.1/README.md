# EBO 2.0.1

EBO 2.0.1 is the first EBO 2 release on npm. It carries everything in
[2.0.0](../2.0.0/README.md), which was tagged and qualified but not published,
and fixes what using the 2.0.0 release found: native captures through Harbor
from the released archive, and LLM judging of audited trajectories.

Install with `npm install -g engineering-behavior-observatory@2.0.1`.

## Fixed

### The installed package

- **Harbor workers build from the package.** The package carries the worker
  builder and the npm inputs it installs from. `ebo harbor build-worker --check`
  confirms them, and `ebo harbor build-worker <output-dir> --study <study-root>
  --node-image <image@sha256:digest>` builds the worker without a source
  checkout. ([Harbor tasks](../../docs/guides/harbor-tasks.md))
- **The default embedding sets up from the package.** The package carries the
  embedding runtime's scripts and pinned requirements. `ebo atlas embeddings
  check` prints where they are, and with `--python` runs the check a bundle
  build runs first. ([Atlas bundles](../../docs/evaluation/atlas-bundles.md))
- **A corpus over Harbor output validates.** `ebo corpus build` over the
  output of `ebo harbor run` indexes each attempt's step bundles and skips the
  attempt summary and Harbor's own files.

### Captured evidence

- **A unit's status follows the harness.** A captured tool unit's status and
  exit code come from the harness's own result. They are read from the output
  text only when the harness records no result, and the unit's new
  `status_source` column then says `inferred`. An agent echoing
  `exit status: 17` inside a successful call no longer marks the call failed.
- **`node --test` is a test run**, so Node's built-in test runner yields
  validation-run occurrences and checks in the attempt audit.
- **Repeated operations are ordered per call.** A repeat is marked whenever
  native order places it after the first identical call, whatever else the
  attempt holds. Identical calls that native order cannot place, such as two in
  one ATIF step, are counted in the repeated-operation coverage's `unordered`
  entry instead of hiding every repeat in the attempt.

### LLM judge

- **A judgment answered by another model is refused.** When the Claude Agent
  SDK reports that a model other than the requested one produced the answer
  (as after a safeguard stops the requested model), the judgment is a provider
  failure naming the answering model, and no assertion is written.
- **Claim workspaces from encoded results.** A `cwd` field inside a tool
  result stored as a JSON-encoded string counts as the stated workspace, so
  such claims no longer discard the judgment.
- **Overflow keeps the opening and closing events.** When a selection exceeds
  `maxInputChars`, events are dropped from the middle of the selection order.
- **The rejected answer is kept.** The Claude backend retains the model's final
  answer in `raw-model-response.json` under its own size limit.
- **Event ids are listable.** `ebo evidence events <run-bundle-root>` lists an
  attempt's normalized events, the ids a judge request selects.
  ([LLM judge](../../docs/evaluation/semantic-judge.md))

### Smaller fixes

- `ebo runtime check` succeeds for the `harbor` and `smol` roles.
- `ebo harbor doctor` reports the interpreter's exit code and stderr when Harbor
  cannot be imported.
- A file check names why a file is not isolated, for example that it has more
  than one hard link.
- `ebo --version` prints the version.
- The judge pages name `--runtime-study`, the LLM-judge example allows three
  turns (a Claude judgment takes two), and the study-runtime reference explains
  that a role frozen for a guest platform needs its own freeze to run on the
  host.

## New commands

- `ebo harbor build-worker --check | <output-dir> --study <study-root>
  --node-image <image@sha256:digest> [--platform <platform>] [--context |
  --adopt <dir>]`
- `ebo atlas embeddings check [--python <executable>] [--no-layout]`
- `ebo evidence events <run-bundle-root>`

## Compatibility

- Observation sets and judgments written by 2.0.0 stay valid and open
  unchanged.
- Observation sets written by 2.0.1 use occurrence rules 1.3.0. Their
  repeated-operation and validation-run occurrences differ from 2.0.0's where
  the fixes above apply; rebuild a study's observation sets to get the new
  marks.
- Atlas bundles built by 2.0.1 carry the `status_source` cloud column.
- Rerunning a judge request can give a different record where 2.0.1 refuses a
  substituted model, drops overflow from the middle, or accepts a workspace
  from an encoded result.

## Known limits

- **Harness configuration.** A harness configuration has no field of its own.
  Two arms with the same harness version and different settings merge unless
  the import declares a distinguishing version, for example with semver build
  metadata (`2026.11.1+noreasoning`).
- **Adding attempts to a corpus.** `ebo observations corpus` cannot add
  attempts to an existing corpus.
- **Tool outcomes of imports.** Imported trajectories carry no tool outcome, by
  design; error views are empty for imported cohorts.
- **Bundle build hosts.** A bundle of millions of units needs a Node heap above
  16 GB and, on Linux, a raised `vm.max_map_count`.
- **Judge batches** stop at the first failed job and cannot resume.
- **Judge input.** The record envelope counts against `maxRecordChars`, so a
  record limit near 2,048 characters can cut a step's tool-call names; evidence
  is sent double-encoded, and the card precedes the evidence, so requests for
  different cards share no prompt prefix.
- **Judge preparation for imports.** `ebo judge prepare` selects few events for
  an imported attempt; select one `message-instant` event per step instead.
- **Decision-model endpoints** are fixed per provider; a gateway cannot be
  named.
- **Storage.** Each Harbor attempt keeps a copy of the worker archive, and each
  judgment a copy of the study runtime lock.
- **Viewer.** It requests optional files a bundle may not have (logged as
  404s), and `describe()` of a decision-model result omits the probabilities
  the drawer shows.
- The decision model's measured accuracy applies to `jev-1.14.0` on ATIF
  trajectories at the 0.9 and 0.1 thresholds.

[Qualification](QUALIFICATION.md) covers how this release is qualified. Moving
from 1.x follows the [2.0.0 migration](../2.0.0/MIGRATION.md).
