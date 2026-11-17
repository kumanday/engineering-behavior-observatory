# Google Antigravity CLI

EBO captures one fresh Google Antigravity CLI conversation per attempt through
an owned `agy` child. The supported standalone CLI is **1.5.9**. The Antigravity
IDE launcher also uses the name `agy`; EBO checks the standalone headless flags
and rejects the IDE launcher before creating a workspace.

## Install and authenticate

Install the standalone CLI from [Google's quickstart](https://www.antigravity.google/docs/quickstart/).
Confirm the selected absolute executable reports `1.5.9` and supports
`--input-format stream-json` and `--output-format stream-json`. The checked-in
[contract record](../../contracts/antigravity-cli-1.5.9/manifest.json) records the
pin and the checksum for the Linux ARM64 runtime archive.

Run the CLI interactively once and choose personal OAuth with the Google account
whose quota you intend to use. Authentication belongs to the CLI and its native OS keyring.
EBO uses that login without reading, copying, or exporting its credentials.
`accountHome` optionally selects the native home in the execution environment;
its default is the current user's home. The CLI can update its own native
session and log files there.

This adapter selects Google-account authentication. It passes no API keys,
ADC flags, proxy routes, or provider overrides to its child. A `modelProvider`
setting in the selected account's settings causes a preflight failure.
The native account settings control subscription quota and AI-credit usage;
EBO records an explicit `useG1Credits` preference when present.
Account access and model entitlements are established by the native CLI;
EBO records reported token usage and leaves billed USD unknown.
The frozen archive recipe supports macOS and Linux; ARM64 is live-qualified.
Windows ZIP installation is outside this runtime recipe.
See [Google's authentication guide](https://www.antigravity.google/docs/install?tab=cli).

## Freeze the condition

The five configuration records use `ebo.antigravity-config/v1`. The
[example directory](../../examples/antigravity/) contains each record separately.
Choose the model from the CLI's own `agy models` output. Model selection is a
study input; the example `gemini-4-argon-high` does not establish access.

- `model`: `provider: "google"`, the native model slug, and optional `effort`
  (`low`, `medium`, `high`, `xhigh`, or `max`).
- `harness`: `adapter: "antigravity-cli"`, absolute `executable`, `version`,
  `contractDigest`, and optional absolute `accountHome`.
- `native-limits`: optional `shutdownGraceMs` (default 2000). The queue's
  coordinator budget owns the execution deadline.
- `native-tool-policy`: `permissionMode` (`request-review` or `always-proceed`)
  and explicit `sandbox`. `always-proceed` passes the native skip-permissions
  flag. `sandbox: true` requests Antigravity's terminal sandbox.
- `capture-profile`: optional `workspaceOutcome` exclusions and projection flags.

The child respects its native settings and workspace instructions. EBO records
a digest of the native settings before execution and detects changes during the
attempt. Keep those settings fixed across matched trials. Under `request-review`,
the CLI soft-denies tools that require unattended approval; a native `SUCCESS`
result can therefore coexist with denied commands. Review the native tool
results and workspace outcome when assessing task quality.

Freeze the study's `antigravity-cli` runtime and bind its queue as described in
[study runtime locks](../reference/study-runtimes.md). The executable comes from
the installed lock. Execute one selected frozen entry:

```sh
ebo antigravity run <bundle-root> <queue.json> <run-id> <output-root> [--workspace-root <path>] [--runtime-study <path>]
```

`ebo agy run` is an alias. The library entry points are
`captureAntigravityCli`, `captureAntigravityCliRun`,
`runAntigravityQueueEntry`, and `createAntigravityHarborExecutor`.

## Harbor execution

A study freezes the Linux ARM64 CLI before preparing a guest. The regular
runtime builder includes that installation when packaging the study:

```sh
node scripts/build-harbor-runtime.mjs study/config/runtime \
  --study study --node-image <public-node-image@sha256:platform-digest>
```

The worker executes the study's frozen binary in the actual task workspace.
Harbor owns independent task assessment. A guest needs its own personal OAuth
login and a D-Bus Secret Service keyring accessible to the execution user.
Credentials stay in private running VMs and their branches. Keep them outside
worker archives, task inputs, run bundles and shared images.

### Prepare and check a personal OAuth guest

The helper prepares a private Linux parent with D-Bus, GNOME Keyring and a pinned
SSH host key. It checks warm keyring isolation before the operator signs in.
Use an isolated interpreter with the repository's hash-locked Harbor 0.26.0 and
Smol 1.35.0 conformance packages, then build EBO with Node 26.13.0:

```sh
uv venv --no-project --python 3.14 .ebo/agy-python
uv pip install --python .ebo/agy-python/bin/python --only-binary=:all: \
  --require-hashes -r scripts/harbor-ci/requirements.lock.txt
npm run build
```

Prepare a runtime request for the guest:

```json
{
  "studyId": "agy-guest-qualification",
  "roles": ["antigravity-cli"],
  "target": {"platform": "linux", "architecture": "arm64"},
  "overrides": {"agy": "1.5.9"}
}
```

```sh
ebo runtime freeze study/agy-guest study/agy-runtime-request.json
.ebo/agy-python/bin/python scripts/antigravity-guest-auth.py \
  --study study/agy-guest --state-root .ebo/agy-guest \
  --image node@sha256:067b2d425f1204b5a898ae3d3145f7524c1425a4096a62b0f67dd4344a494440
```

Keep the foreground owner running. When it reports `awaiting-google-sign-in`,
run `.ebo/agy-guest/login.sh` in another terminal, complete personal Google
sign-in, and enter `/exit`. The helper selects native `oauth-personal`.
`--port` chooses another local SSH port (default 48723).

```sh
.ebo/agy-python/bin/python scripts/check-antigravity-guest-branch.py \
  --state-root .ebo/agy-guest --model <account-available-model>
```

Each of two independent official Harbor `SmolEnvironment` branches invokes the
production EBO worker with the frozen study, checks a proof-file outcome,
reopens native evidence, validates its v2 projection, and writes a sanitized
ATIF derivative. The checker asserts distinct conversations and attempts,
parent workspace isolation, keyring access, and child deletion. Failed evidence
is retained privately. `--login-confirmed` accepts an operator-confirmed sign-in
whose interactive CLI exit did not create the completion marker.

This helper qualifies warm guest branching through Harbor's provider and worker.
A frozen task queue owns its preparation and parent bindings; attach the same
native home, D-Bus address and runtime directory when configuring that workflow.
Cold restart and expired-token refresh need separate qualification. After all
borrowers finish, touch `.ebo/agy-guest/stop` or interrupt its owner to delete
that parent. A fresh parent requires a fresh sign-in.

## Evidence and completion

`session.jsonl` retains native frames before parsing, the single outbound user
message, runtime composition, bounded stderr diagnostics, native completion,
and process termination. `telemetry/antigravity.json` records runtime identity,
non-secret configuration metadata, cumulative usage, and the explicit OTLP gap.
Workspace snapshots and patches use EBO's existing outcome path.

The adapter sends one text `user` event through stdin, closes stdin, and reads
`init`, `step_update`, and `result` events continuously. Only one result bound
to the init conversation with `num_turns: 1` can complete the turn. `SUCCESS`
means native completion; the CLI’s `finished_reason: "interrupted"`
identifies an interrupted `ERROR` result. A local abort and native `CANCELED` or
`INTERRUPTED` statuses also retain interruption. Other statuses fail the attempt. Process exit without that result preserves a failed
partial attempt. Abort sends SIGINT, then escalates within the shutdown grace.
A process that lingers after its result is shut down within the same bound.

Readback checks the manifest against native runtime composition, model,
conversation identity, input, and terminal evidence. Repeated ACTIVE tool
updates and repeated DONE snapshots retain their native records while yielding
at most one tool start and result per step. Assistant deltas form one Atlas
message per native step. Tool errors remain independent of the turn's outcome.
Native error diagnostics retain pointed `tool-error` content for v2 rating inputs,
including results that have an error without an output field.

Per-step usage remains native evidence. The final result's cumulative-session
usage supplies totals once, including input, output, cache reads, and thinking
token counts when present. The monitor neither sums repeated snapshots nor
invents per-request billing records. Absent token fields stay unknown.

## Capabilities and verification

The [recorded personal OAuth qualification](../../verification/antigravity-cli-1.5.9.md)
covers local macOS, Linux Harbor captures and warm VM branching at the maintained pin.

Native subagent metadata includes child identities; complete child histories
remain unavailable through this boundary. Individual model requests, compaction
semantics, lifecycle-hook capture, and native OTLP receipt are unqualified.
Product usage telemetry is separate from EBO capture. These gaps remain explicit
in retained bundles and analysis capability profiles.

Private reasoning steps remain restricted and unmapped. Portable exports omit
private step bodies and raw frame copies, rewrite conversation identities,
redact local paths and secrets, then run the existing final export scan.

```sh
npm run build
node --test dist/test/antigravity.test.js
```

The deterministic fixture covers successful and failed turns, malformed and
oversized output, identity mismatches, repeated updates, interrupted children,
retained readback, structural observations, Atlas units, monitor usage, export,
and the Harbor worker. A live smoke is opt-in and requires an existing native
account login and the pinned executable:

```sh
EBO_LIVE_RUNTIME_STUDY=/absolute/path/to/frozen-study \
EBO_LIVE_ANTIGRAVITY_SMOKE=1 \
EBO_LIVE_ANTIGRAVITY_EXECUTABLE=/absolute/path/to/agy \
EBO_LIVE_ANTIGRAVITY_MODEL=gemini-4-argon-high \
node --test --test-name-pattern='opt-in Google-account' dist/test/antigravity.test.js
```

The smoke consumes the selected account's quota and creates a synthetic proof
file in a temporary workspace. A skipped smoke does not qualify account access.
The native protocol is documented in
[Google's headless guide](https://www.antigravity.google/docs/cli/headless/).

For the three retained local qualification cases, run:

```sh
node scripts/qualify-antigravity.mjs <frozen-study> <new-private-output> <native-model>
ebo runtime verify <new-private-output>/verification-request.json <private-candidate.json>
```

The cases exercise a read/edit/test task, a deliberate failed test with follow-up,
and interruption of an active tool. Admission uses the common
[verification catalog workflow](../reference/harness-verification.md). Native
stream-json exposes no issuing-inference identity, so failure-follow-up remains
unverified even when the task visibly recovers. Hooks and OTLP remain unqualified.

`exportAntigravityAtif(bundleRoot, policy)` produces a sanitized ATIF-v1.8
selection from a retained native bundle. It preserves visible messages and
identified tool calls/results; native v2 readback validates the source first.
Private reasoning and unsupported accounting conversions are omitted. The ATIF
reader validates the derivative. This source-specific export does not establish
independent converter equivalence or complete native history.

## Maintained conformance release

[CLI 1.5.9](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.9)
was the newest stable release older than 24 hours at the contract's recorded
selection time. The publisher timestamp for 1.5.10 fell after that cutoff.
`scripts/freeze-antigravity-contract.mjs` regenerates the pin using the runtime
registry's release selection and verified GitHub archive digests.

The 1.5.9 live stream retains the `init`, `step_update`, `result` envelope and
single-input protocol. Its interrupted terminal uses `ERROR` with
`finished_reason: "interrupted"`. The fixture reproduces that shape and the
observed `read_file`, `edit_file` and `run_command` names. A DONE tool snapshot
can omit output, so output absence stays unknown. Native conversation storage
includes protobuf and database files alongside JSONL logs; EBO's owned stdio
session is its authoritative capture, with no dependency on those private
on-disk formats.
