# EBO 2.0.0

EBO 2.0.0 judges agent behavior against a new behavior ontology, in two judging
modes that write one record. It reads ATIF trajectories from any producer next
to its own captures, and it runs every capture, judge and worker on software
frozen per study. It is a major release: EBO 2 does not open 1.x studies, and
1.4.0 remains the version for them.

The [map of EBO 2.0](../../docs/guides/ebo-2-map.md) describes the whole
system, from capture to report, and lists every record format with the command
that writes and reads it.

## What is new

- **Behavior ontology 2.0.0.** 93 cards in 11 families replace the eight
  categories of 1.x. A judgment decides whether one card's situation occurred
  and gives a verdict of `present`, `absent` or `unknown`, plus one named value
  on a present dimension card. Each workflow and finding card, and each value,
  has a fixed direction (`favourable`, `unfavourable` or `neutral`) that no
  judge decides. ([Behavior ontology](../../docs/evaluation/behavior-ontology.md))
- **Two judging modes, one record.** [Decision-model judging](../../docs/evaluation/decision-model-judge.md)
  judges whole cohorts on every recorded step: `ebo judge decision-model` asks
  a decision model about the cards in batches, resumes after an interruption
  and can take the cards a few at a time. The [LLM judge](../../docs/evaluation/semantic-judge.md)
  reads a selection of an attempt's events and cites the ones its verdict rests
  on, for audits. Both write `ebo.behavior-assertion/v2`, which names its
  producer mode. Aggregation, calibration, Atlas and the viewer keep the two
  modes apart and report direction shares beside the per-card rates.
- **ATIF import.** Conforming ATIF documents from any producer are read through
  a producer-independent core, with optional Pi and Codex overlays. Harbor
  trials and pinned Harness Leaderboard cohorts import with their execution
  identity and assessments. Imported evidence keeps its own qualification and
  never counts toward capture-qualified rates.
  ([ATIF](../../docs/reference/atif.md), [Harbor imports](../../docs/reference/harbor-imports.md),
  [leaderboard imports](../../docs/reference/leaderboard-imports.md))
- **A stricter evidence model under normalization.** The typed projection gives
  every native record a mapping disposition, every operation a scope and one
  identity, failures and clocks explicit status, and every count its
  population. ATIF imports and harness verification read it.
  ([Typed evidence projection](../../docs/development/normalization-v2.md))
- **Study runtimes.** A study freezes exact, age-eligible releases with their
  dependency graphs, checks advisories when it resolves and before every
  launch, and records the software that actually ran. Every capture, judge and
  Harbor worker uses its study's lock. ([Study runtimes](../../docs/reference/study-runtimes.md))
- **Remote workers on Smol Cloud.** Harbor trials run in Smol machines on Smol
  Cloud as well as locally, from frozen worker packs, with per-task images or
  shared image families. ([Harbor tasks](../../docs/guides/harbor-tasks.md))
- **Open Responses.** Responses-style endpoints are recorded on the wire through
  Pi and checked against the specification. ([Open Responses](../../docs/harnesses/open-responses.md))
- **Google Antigravity CLI** is the ninth native harness, next to Claude Agent
  SDK, Codex, Devin CLI, Cursor, Pi, OpenHands, DeepSeek Harness and Factory
  Droid.
- **Leaderboard labels in Atlas.** An Atlas bundle can name a verified
  leaderboard cohort; imports then show the leaderboard's task and trial names,
  and its verdict apart from EBO's run status.

## Record formats

Every format has one current version, and a format's number states its shape.
Formats that changed shape during 2.0 carry their next number, and different
kinds of document carry their own names. A file with any other name or number
fails with "Unsupported schema version." The [format table](../../docs/guides/ebo-2-map.md#record-formats)
lists all of them.

## Not in 2.0.0

- EBO 2 carries no reader, converter or compatibility layer for 1.x studies.
- Analysis consumers read the normalized dataset; reading the typed projection's
  operations directly is planned for a later release.
- Review samples list single result files; sampling from decision-model result
  sets is planned.
- The decision model's measured accuracy applies to ATIF trajectories at the
  0.9 and 0.1 thresholds. Native captures and other thresholds have not been
  measured.

[Migration](MIGRATION.md) covers moving from 1.x and from the 2.0 release
candidates. [Qualification](QUALIFICATION.md) covers how this release is
qualified.
