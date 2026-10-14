# EBO 1.4.0

EBO 1.4.0 adds `ebo monitor`, a local dashboard for campaigns in progress.
It reads the runner's campaign status, request logs and EBO run bundles to show
attempt state, costs, token usage, activity, limits and capture qualification.
Paused campaigns can include a runner note. The monitor displays the latest
structural capture verdict alongside the live capture state.
See the [run monitor guide](../../docs/guides/run-monitor.md).

Pi captures with a recognized native provider-error or abort terminal retain
session evidence without requiring successful execution. A failed attempt stays
failed while its retained session can qualify for analysis. Regression coverage
includes a provider timeout with partial reasoning and no final answer; missing
identities, unknown terminals and damaged capture remain disqualified.

Harness and environment pins remain those recorded for
[1.3.0](../1.3.0/README.md), including its
[runtime qualification](../1.3.0/runtime-qualification.md). Capture qualification,
execution completion and implementation correctness remain separate facts.

`npm run acceptance` checks build, typechecking, deterministic tests, fixture
digests, documentation links, package scanning and two byte-identical archives.
The [reproducibility manifest](reproducibility.json) binds the release inputs.
Live provider tests remain separate opt-in checks.
