# Capture a Harbor task

Harbor is the task format for new isolated studies. Its `Trial` owns the
environment, effective instructions, step setup, verification and cleanup.
EBO adds admission, frozen experiment conditions and native harness capture.
Existing task-packet/v1 studies and their commands remain readable and unchanged.

## Prepare the study runtime

EBO runs on Node 26.13.0 with npm 12.2.2. Harbor and Smol run in a jointly resolved Python
virtual environment selected by the [study runtime lock](../reference/study-runtimes.md).
The host needs a compatible Python interpreter, `uv`, and `pypi-attestations`
available to that bootstrap interpreter for verifying offered wheel attestations.
Set `EBO_RUNTIME_PYTHON` to its absolute path.

For a Pi study, save this request as `runtime-request.json`:

```json
{
  "studyId": "harbor-example",
  "roles": ["harbor", "smol", "pi-sdk"],
  "roleTargets": {"pi-sdk": {"platform": "linux", "architecture": "arm64"}}
}
```

```sh
ebo runtime freeze study runtime-request.json
ebo runtime inspect study
ebo runtime check study harbor
unset SMOLVM_LIB_DIR
```

Use the inspection output's Python installation key to point read-only task
commands at `study/runtimes/cache/<installationKey>/venv/bin/python` through
`EBO_HARBOR_PYTHON`. Execution selects the interpreter from the study lock.
Keep the study directory in a durable location. Rebuild worker archives and
freeze a new environment manifest when changing the runtime lock: the worker
archive, image bindings and bundled `libkrunSha256` identify that execution
condition.

A frozen task whose snapshot fails content verification reports
`Harbor task status: changed`. Confirm `EBO_HARBOR_PYTHON`
is exported before checking the snapshot's contents.

The local profile targets Apple Silicon macOS with Smol's bundled libkrun.
Its environment manifest pins that library's SHA-256. Do not override
`SMOLVM_LIB_DIR`. The [Cloud profile](#smol-cloud) uses the same Harbor provider
through the Smol Cloud API and needs no local hypervisor.
Smol prepares workers and executes agents and graders using immutable OCI images.
`local-fs-test` supports preparation tests only; retained Docker queues remain
readable but must be explicitly recompiled as new Smol conditions to run.

The worker runtime's `environmentKeys` allowlist passes selected host values as
plaintext into the attempt child. Keep it minimal: an agent with shell access
inside the guest can read those values. Smol exposes host-side HTTPS
header substitution through `MachineConfig.credentials` and `CredentialSpec`.
EBO's qualified Harbor worker path uses the environment allowlist. Use a
separately approved route for experiments that require host-held credentials;
gateway configuration belongs to the operator, not to a frozen task or EBO.

## Prepare, review and freeze

An ordinary Harbor task has `task.toml`, `instruction.md` and `environment/`.
Use task schema **1.4**. Declare `environment.workdir`, such as
`/workspace`; the agent changes that directory inside the task VM. Multi-step tasks use `[[steps]]` and
`steps/<name>/instruction.md`. Harbor composes shared and per-step instructions.

```sh
ebo harbor inspect path/to/task
ebo harbor prepare study path/to/task --mode observational
```

Preparation returns a content-derived task-source ID and writes a proposal to
`study/governance/admissions/harbor/<id>.proposed.json`. Review the task,
Docker build context, effective instructions, provenance and sharing policy.
Create `study/governance/reviews/harbor/<id>.json` using the proposal's
`preAdmissionDigest` (also available through `preAdmissionDigestOf`):

```json
{
  "schemaVersion": "ebo.harbor-review/v1",
  "taskSourceId": "<id>",
  "preAdmissionDigest": {"algorithm": "sha256", "value": "<proposal digest>"},
  "decision": "admitted",
  "reviewedAt": "<ISO timestamp>",
  "reviewedBy": "<reviewer>"
}
```

```sh
ebo harbor admit study <id>
ebo harbor freeze study <id>
ebo harbor status study <id>
```

Preparing or compiling a queue does not grant review approval. Changed content
needs a new identity, review and freeze. An observational task has no verifier
requirement. For verified tasks, Harbor owns `tests/`, reward parsing and
`verifier.environment_mode`. Use `separate` with declared `artifacts` when the
verifier needs an independent container. Missing rewards remain missing; a
recorded reward of zero is not treated as missing.

## Build and pin the guest runtime

The host Python extension launches an EBO **TypeScript worker inside Harbor's
environment**. SDK tools and subprocesses therefore see its actual filesystem.
Python carries control messages only; it does not capture or normalize sessions.

EBO qualifies verified multi-step tasks with a separate verifier environment
for every step. Admission requires that profile; Harbor owns setup, verification
and cleanup.
Single-step shared verification retains its weaker, candidate-modified trust
boundary; it is not independent grading.

```sh
ebo harbor build-worker --check
ebo harbor build-worker study/config/runtime \
  --study study \
  --node-image <pinned-Node-Linux-arm64-image@sha256:platform-digest>
```

The installed package carries everything the builder reads. `--check` confirms
that, and prints the folder it builds from. In a source checkout, run
`npm run build` first; `node scripts/build-harbor-runtime.mjs` takes the same
arguments as `ebo harbor build-worker`.

Use an empty destination. The builder uses the study's local Smol SDK and an
immutable Linux Node image. It verifies the pinned npm release and installs
EBO's coordinating dependencies from the npm lock with install scripts
disabled. The archive retains the full study lock, selected Linux installations
and the host Smol receipt used by OpenHands.
`worker-build.json` records the image digest, actual Node and npm probes,
npm integrity, archive digest and Smol execution receipt.

Place `worker.tgz` in the admitted agent environment context and use `localSetup`
to verify its SHA-256, extract it into `/opt/ebo`, and write that archive digest to
`/opt/ebo/runtime.sha256`. The preparation owner runs the setup before checking
the marker and creating reusable parents. Bind a registry-accessible
**linux/arm64 manifest digest** in the environment manifest. The supplied image
must provide Git, CA certificates and compatible system libraries. Worker
preparation and local setup use Smol directly.

The reusable runtime image must have compatible Linux
architecture, glibc and the system tools needed by its harness. A macOS runtime
or Alpine/musl image is not interchangeable with this archive.
Git is required for workspace evidence, even when the task starts from an archive
without a `.git` directory. Live conformance checks capture qualification as well
as execution completion.

Save a runtime profile in the study and reference it by its SHA-256 digest:

```json
{
  "schemaVersion": "ebo.harbor-worker-runtime/v2",
  "studyLockDigest": "sha256:<study lock digest>",
  "archive": {"locator": "config/runtime/worker.tgz", "digest": {"algorithm": "sha256", "value": "<archive digest>"}},
  "node": "node",
  "entrypoint": "dist/src/harbor/worker.js",
  "environmentKeys": ["ZAI_API_KEY"]
}
```

Only explicitly listed credential/route variables enter the worker. Values are
not written to the runtime profile. `resources` may list additional digest-pinned
configuration files needed by a harness. Paths in those configurations refer to
the **guest**, where the runtime lives at `/opt/ebo` and selected
configuration files at `/tmp/ebo-worker/config/<locator>`.

| Harness | Container prerequisite | Native execution |
| --- | --- | --- |
| Claude Agent SDK | SDK archive and authorized route | Direct SDK query, hooks and session capture |
| Pi | SDK archive and selected provider key | Fresh Pi session, native tools and persistence |
| Cursor | SDK archive, `CURSOR_API_KEY`, required local system tools | Direct SDK, HTTP/1.1 and native recovery |
| Factory Droid | Frozen Linux CLI/SDK graph and selected Factory key | Official SDK with native recording; fresh owned session per step |
| Codex | Frozen Linux app-server runtime | Owned stdio child; no host daemon |
| DeepSeek Harness | Named Linux runtime/plugin composition and its installed runtime | Official TypeScript JSON-RPC client |
| OpenHands | Frozen Agent Server image as the task guest; cgroup v2 | Agent Server inside that guest, loopback REST/WebSocket and the same task workspace |
| [Google Antigravity CLI](../harnesses/antigravity-cli.md#harbor-execution) | Frozen Linux CLI and private personal OAuth keyring in the guest | Fresh stream-json conversation per step |
| Devin CLI | Frozen Linux vendor binary and Cognition credential | Owned ACP child and retained session |

The archive contains EBO's coordinating dependencies and the study's exact
runtime installations. The guest checks its lock digest against the host's
selection before capture. Native CLI paths come from the selected cache. Each
worker refreshes registry withdrawal metadata and OSV before launching the
harness; the Smol profile provides public egress for these checks. Runtime
availability and provider entitlement are separate prerequisites.

## Compile and run

Use `ebo.harbor-experiment/v1`. Its `taskSet` entry is
`{"kind":"harbor-task","taskSourceId":"<id>"}`. Model, harness,
native-limit, tool-policy and capture-profile references retain their existing
source-specific formats for Claude, Codex, Cursor and Pi. OpenHands and DeepSeek
use their native harness configuration, a model reference containing
`{"model":"<native model>","provider":"<provider>"}`, and a tool-policy reference
`{"source":"harness"}`. Their native tools and policies belong to the pinned
conversation request or runtime composition, not a second EBO tool schema.

For OpenHands, the limits record accepts `timeoutMs`, `pollIntervalMs`,
`maxReconnects`, `reconnectDelayMs`, `maxResponseBytes` and `maxCaptureBytes`.
For DeepSeek it accepts `requestTimeoutMs`, `activityTimeoutMs`,
`shutdownTimeoutMs`, `disposeEofGraceMs` and `disposeGraceMs`. Values are positive
integers; `{}` uses the native defaults. Their capture profile accepts
`workspaceOutcome` with the existing exclusion and gitignore settings.
Unsupported fields are rejected. Native telemetry gaps remain explicit, including
Claude collector receipts that have not been independently checked.

Save a `config/environments.json` manifest (`ebo.smol-task-environments/v1`,
one image binding per task). Keys under `tasks` are the frozen
task-source IDs; grader keys are step names, or `single` for a single-step task.
Each image binding records `image`, `baseImageDigest` and `recipeDigest` from
the reusable runtime build. Task code does not need to enter a registry.
Use `localSetup` to prepare a private local parent from that image.

```json
{
  "schemaVersion": "ebo.smol-task-environments/v1",
  "target": "local",
  "platform": "linux/arm64",
  "runtimeArchiveDigest": "<worker.tgz SHA-256>",
  "libkrunSha256": "<bundled libkrun.dylib SHA-256>",
  "tasks": {
    "<task-source-id>": {
      "agent": {
        "image": "<registry/ebo-runtime@sha256:platform-digest>",
        "baseImageDigest": "<base image SHA-256>",
        "recipeDigest": "<build recipe SHA-256>",
        "localSetup": "setup.sh"
      },
      "graders": {}
    }
  }
}
```

### Private local task preparation

Smol mounts `/tmp` as a RAM-backed filesystem. EBO keeps worker evidence under
`/var/tmp/ebo-evidence` and sets worker `TMPDIR` to `/var/tmp/ebo-scratch`, so
baseline copies and temporary Git indexes use disk. Allow space for those copies
as well as dependencies. Qualify capture with a representative repository before
a model trial; successful setup alone does not prove enough capture space remains.

Put a repository snapshot and a setup script in the task's `environment/`
before admission and freezing. For example, with files under `environment/repo/`,
`environment/setup.sh` can contain:

```sh
set -eu
cp -R repo/. /workspace/
cd /workspace
npm ci --ignore-scripts
```

Choose dependency-install flags appropriate to the repository. Pin dependencies
and include required setup inputs in the frozen context. A snapshot avoids
needing repository credentials in the VM; if fetching public sources instead,
pin their revisions explicitly.

`localSetup` is relative to the role's frozen environment context. The owner
uploads that context locally and runs the script with `sh -eu`, with the
uploaded context as its working directory. It creates the declared task workdir
first. Setup runs once per parent, before any attempt branches; failure prevents
that parent from becoming ready. The binding uses the image's startup and user
by default. For an OpenHands task image, set `parentStartup: "idle"` to defer
Agent Server startup and `localSetupUser: "root"` to install the worker during
trusted setup. Assign the prepared workspace to the image's non-root user so
Agent Server can run there with that user's permissions. Both choices are
frozen in the image binding. The temporary context is removed after success.
The setup exit code, output and script digest are retained as local evidence.
No Dockerfile instructions are interpreted or translated into shell commands.
When switching from a task-built image, explicitly move its installation/copy
steps into this script and review the new frozen task.

Separate grader bindings may use their own `localSetup`, relative to Harbor's
resolved grader build context. The agent receives only `environment/`, never
the task root, hidden solutions, or separate grader tests. Harbor's per-step
setup still runs in each attempt at its normal stage. Verifier files enter
`/tests` in the grader child after branching, not in the shared parent.

The public image contains runtime software only. Repository files, prepared
parents, branch disks and trajectories stay on this computer. Registry privacy
is relevant only if you choose a private runtime base; authenticated private
image pulls are not yet qualified for local machines. The Cloud profile
[pulls private images](#pull-a-private-image) with a stored credential. Never put credentials
in frozen contexts, setup scripts or parent state. Harness credentials and
attempt configuration enter after branching through the worker profile.
Setup commands have the declared public egress, so their network activity must
also respect the repository's sharing policy.

Reference the environment manifest by digest in the execution policy:

```json
{
  "execution": {
    "environmentProfile": "smol",
    "contextPolicy": "fresh",
    "environmentRef": {"locator": "config/environments.json", "digest": {"algorithm": "sha256", "value": "<environment manifest digest>"}},
    "workerRef": {"locator": "config/runtime.json", "digest": {"algorithm": "sha256", "value": "<profile digest>"}}
  }
}
```

```sh
ebo harbor compile study experiment.json queue.json
ebo runtime bind-queue study queue.json queue-with-runtime.json
# Terminal A: keep this foreground owner alive until all attempts finish.
ebo harbor environment serve study queue-with-runtime.json
# Terminal B: use the run IDs printed by compile (trialCount: 2 for two entries).
ebo harbor run study queue-with-runtime.json <first-run-id-from-bind> runs
ebo harbor run study queue-with-runtime.json <second-run-id-from-bind> runs
# Then Ctrl-C in terminal A to drain borrowers and delete the owned parents.
```

Deletion uses the Smol SDK, with at most three attempts and five seconds between
failures. Parent receipts retain `cleanupAttempts`; child cleanup events retain
the same history. Exhausted retries remain `cleanup-pending`. Successful recovery
does not erase earlier errors or start a replacement model attempt.

The queue selects the harness. One entry creates one attempt, with no replacement
attempts or EBO retry loop. Each step gets a fresh native conversation and shares
the Harbor workspace. An explicit coordinator deadline covers the whole trial and does not reset
between steps. Set `"coordinatorBudget": {}` in a v2 experiment to omit the
coordinator deadline. The worker and native capture then receive no wall-clock
limit. Frozen task setup/verifier limits and explicit native harness policies
remain part of the task condition.
Resume and imported trajectories fail preflight rather than silently changing
the experiment.

The owner prepares one clean live parent per environment fingerprint. Attempts
branch from it through the official Smol provider, and receive credentials only
after branching. No agent warm-up or provider call runs in a parent. Image binding
creates a derived execution task and retains both content digests; the admitted
snapshot stays unchanged. Separate graders borrow distinct clean parents.

Receipts live under `study/runtime/smol/<queue-digest>/`. A stale ready file is
not sufficient: borrowers check the owner lock, queue, runtime and live parent.
Shutdown stops admission of branches and allows 60 seconds for active trials to
drain. A failed transfer or deletion records `cleanup-pending` and owned VM IDs;
recover those resources before removing the receipt or preparing again. The
SDK may stop local machines when their owning process exits, so withholding
deletion does not guarantee that a warm child remains recoverable. The runner
never turns a missing parent or a branch-chain limit into a cold attempt.
Drain and restart preparation if the runtime exhausts its branch chain.

This runtime profile currently accepts public egress only. No-network image
import and allowlist networking remain unqualified. Such policies fail before
creation rather than being broadened. Host-expanded task environment variables,
GPU/TPU, task MCP services,
Compose and other platforms are also rejected. Worker credential keys
remain the supported injection path. The full image-backed trial gate must pass
before treating this integration as operationally qualified.

## Smol Cloud

Smol Cloud guests run `linux/amd64`. Freeze the study runtime with the guest
harness installations for that platform, for example
`"roleTargets": {"pi-sdk": {"platform": "linux", "architecture": "x64"}}`.
Harbor and Smol stay host roles in the same lock. `ebo harbor doctor --target cloud`
checks the host installation only: it performs no network call and provides no
account, billing or live runtime qualification.

### Build the Cloud guest image

A local Smol VM builds `linux/arm64` worker archives only. For Cloud, the worker
builder writes an OCI build context, and a native `linux/amd64` builder turns it
into both the worker archive and the guest image:

```sh
ebo harbor build-worker build/cloud-context \
  --study study --platform linux/amd64 --context \
  --node-image <pinned-Node-Linux-amd64-image@sha256:platform-digest>
```

The context holds a `Dockerfile`, `build-worker.sh`, EBO's built coordinator,
the study lock with its `linux-x64` installations, the pinned npm release and
`context.json`. That receipt records the study lock digest, platform, Node image,
Node and npm versions, the npm artifact, `baseImageDigest` (the Node image) and
`recipeDigest` (the `Dockerfile` SHA-256). The `worker` stage runs the same
steps as the local builder and leaves `worker.tgz`, the Node and npm probes and
the receipt in `/output`. The final stage starts from the same Node image, adds
Git and CA certificates, and carries the unpacked archive at `/opt/ebo` with its
digest in `/opt/ebo/runtime.sha256`.

Build both stages on one `linux/amd64` builder so they share the worker layer,
copy `/output` out of the `worker` stage, and push the final image to a registry
the guests can pull from. With Docker on the builder:

```sh
docker build --target worker -t ebo-worker build/cloud-context
docker build -t <registry>/<repository>:<tag> build/cloud-context
id=$(docker create ebo-worker) && docker cp "$id:/output" build/cloud-output && docker rm "$id"
docker push <registry>/<repository>:<tag>
```

A hosted build service can run the same three steps and store `/output` as build
artifacts. Record the pushed **platform-specific manifest digest**. Then adopt
the output on the coordinator host:

```sh
ebo harbor build-worker study/config/runtime \
  --study study --platform linux/amd64 --adopt build/cloud-output \
  --node-image <the same Node image digest>
```

Adoption checks the receipt against the selected study lock, platform and Node
image, the Node and npm probes, and that the archive retains the study lock. It
writes `worker.tgz`, `worker.json` and `worker-build.json`; the build record's
`execution` names the external OCI build with its recipe and base image digests.
Use `runtimeArchiveDigest`, `recipeDigest`, `baseImageDigest` and the pushed
image digest in the environment manifest. The builder is a trusted input:
adoption verifies what the archive contains, not which machine produced it.
Rebuild and adopt again after changing the study lock or EBO build; the image
and the adopted archive must come from the same build.

### Pull a private image

A registry that requires authentication needs a pull credential stored with
Smol Cloud for that registry host before the first machine starts. Register a
short-lived credential (`PUT /v1/registry/credentials` with the registry host,
a username and a password or access token), create machines from the complete
image digest, and delete the credential (`DELETE /v1/registry/credentials/{registry}`)
when no further start needs it. The credential authenticates Smol's nodes, not
the coordinator; a registry login on the coordinator host has no effect on
guests. A credential that expires before a later cold start makes that start
fail with a pull error, which a new image build does not fix. EBO does not
register or retire registry credentials. Verify the endpoint against the
current Smol Cloud registry documentation before use.

The worker layer is about 2.5 GB unpacked, so the first start on a node pulls
for several minutes. That pull can outlast the node's start deadline: machine
creation then fails with a retryable `503`, the SDK removes the machine, and the
owner stops with the allocation recorded as `submitting` and the receipt
`cleanup-pending`. The pull continues on the node. Confirm through the Cloud
machine inventory that the named machine is absent, set that allocation intent's
`state` to `reconciled-absent` in the owner receipt, and start the owner again
with `--resume`. A start from the node's cache takes seconds. EBO does not
repeat an allocation by itself after an ambiguous response.

### Cloud environment manifest

Use the same task-environment manifest with a Cloud target:

```json
{
  "schemaVersion": "ebo.smol-task-environments/v1",
  "target": "cloud",
  "platform": "linux/amd64",
  "cloud": {
    "baseUrl": "https://api.smolmachines.com",
    "tokenEnv": "SMOL_CLOUD_TOKEN"
  },
  "runtimeArchiveDigest": "<runtime archive SHA-256>",
  "tasks": {
    "<frozen task source ID>": {
      "agent": {
        "image": "<registry/image@sha256:platform-specific-digest>",
        "recipeDigest": "<build recipe SHA-256>",
        "baseImageDigest": "<base image SHA-256>"
      }
    }
  }
}
```

Export the Cloud control token only in the coordinator environment. EBO rejects
its inclusion in the worker's `environmentKeys`. Provider credentials selected
for the candidate remain a separate worker allowlist. Build the runtime with the manifest's `--platform` and bind a matching
image digest. Parent preparation checks the actual guest architecture before
running setup. Registry access and architecture capacity need live qualification.
EBO does not infer account identity from a token's presence.

The foreground parent owner and attempt coordinators must share one durable
filesystem and OS lock domain. They can run on a remote coordinator. This profile
moves task VMs to Cloud; it does not distribute the Harbor coordinator across
hosts. Keep its study files, requests, receipts and logs on persistent storage.
After coordinator loss, jobs and guest evidence remain recoverable through their
owned machine IDs. An active Harbor trial cannot be resumed by restarting its
command. Recovery retrieves the existing job and evidence without running agents
or graders again.

Cloud harness and parent setup commands also use native jobs. The owner receipt's
`preparationJobs` entries retain submission intent, machine/job IDs and output
receipt paths. Output is fsynced with byte offsets. An uncertain submission,
disconnection or lost job retains the affected machine and its ancestors. Inspect
the native job inventory and reconcile setup receipts before ancestor cleanup;
worker `job recover` commands below apply to worker evidence retrieval.

Cloud workers use the SDK's detached jobs API. Before submission, EBO writes a
submission intent; it then records the accepted job ID, boot identity and output
byte offsets. Receipts and transport logs live beside the retrieved step in
`steps/<index>-cloud-job/`. These control files are outside the downloaded guest
content. Output is appended and fsynced while the client is connected. Cloud
retains output while it is disconnected. An absent coordinator deadline leaves
the job timeout unset. An explicit deadline or cancellation stops the owned job;
a connection error retains the machine for recovery.

```sh
# Snapshot existing output, or retrieve a terminal job's evidence.
ebo harbor job recover study /durable/attempt/steps/1-cloud-job/smol-job.json
# Explicitly cancel the existing job, retrieve evidence, then delete its VM.
ebo harbor job recover study /durable/attempt/steps/1-cloud-job/smol-job.json --cancel --delete
```

Recovery runs under the study's frozen Harbor and Smol runtime and accepts only
receipts of that study's preparations. It reconnects the original worker job. Separate native jobs package its retained files for transfer; they do not rerun the worker. If submission lost its response before the ID
was saved, inspect the recorded machine's native `jobs()` inventory and reconcile
the original ID in the receipt. Do not rerun the attempt. Recovery records boot
continuity and any restart gap, uses Harbor's archive extraction with durable packaging jobs and 64 MiB transfer chunks, and leaves missing native terminal
capture explicit. It does not convert a partial attempt into a completed or
qualified trial. A lost job can yield partial files without a native terminal.
A running job is retained unless explicitly canceled; a failed transfer prevents
deletion. Recovery serializes receipt updates with an exclusive OS lock and refuses to
race a live Trial coordinator. Archive retrieval shares an owner lock to keep large transfers from exhausting coordinator memory. Declared workspace directory exclusions also apply to the worker's temporary comparison baseline during Cloud transfer, with a retained policy receipt; native bundles transfer intact.

A Cloud branch takes its image identity from its machine record, which names the
source image reference. EBO compares that reference with the frozen binding. The
SDK cannot pull an image inside a Cloud guest, so the image config digest is
recorded as absent on Cloud, and so is the local `libkrunSha256`. The OpenHands
task-guest boundary requires both values and is not available on Cloud.

Borrowers serialize the readiness check and native fork creation per prepared parent. A warm source can temporarily report unready while Smol snapshots it; EBO waits while its owner remains alive. Stopped sources fail the warm-parent check. Trial children execute in parallel after branching.

Cloud child and parent deletion requests settled usage through
`delete(include_usage=True)`. Usage and cleanup failures remain in the job or
owner receipt and child event journal. Retained machines can continue accruing
charges. Inspect these receipts and the Cloud console when cleanup is pending;
a command exit does not certify that billing stopped.

Before running a study, verify the selected tenant and billing account in Cloud,
then qualify the frozen tasks' image, setup, worker, verifier, evidence retrieval,
job recovery and cleanup paths. Any host recorder must be reachable from the
Cloud guest through its approved remote endpoint; a laptop loopback address is
not a remote service. Qualify Docker inside a guest only for tasks that need it.
The Docker daemon's data root must use persistent guest storage. Campaign hold
and launch approval belong to the study operations files.

## Hierarchical image families

Use `ebo.smol-family-environments/v1` for a shared image followed by prepared harness
parents and isolated trial children. Each compatible family has one OCI image.
The coordinator creates one meta-parent per used family, branches a parent for
each task/harness preparation, and lets the official Harbor provider branch the
trial children. Separate graders branch from a clean meta-parent and share their
prepared parent across harness conditions when their full identities match.

```json
{
  "schemaVersion": "ebo.smol-family-environments/v1",
  "target": "cloud",
  "platform": "linux/amd64",
  "cloud": {
    "baseUrl": "https://api.smolmachines.com",
    "auth": "cli"
  },
  "runtimeArchiveDigest": "<worker archive SHA-256>",
  "families": {
    "node-bookworm-amd64": {
      "image": "<private registry/meta-image@sha256:platform-digest>",
      "recipeDigest": "<meta-image recipe SHA-256>",
      "baseImageDigest": "<base image SHA-256>"
    }
  },
  "harnesses": {
    "pi-sdk": {"families": ["node-bookworm-amd64"]},
    "codex-app-server": {
      "families": ["node-bookworm-amd64"],
      "setupRef": {
        "locator": "config/prepare-codex.sh",
        "digest": {"algorithm": "sha256", "value": "<script SHA-256>"}
      }
    }
  },
  "tasks": {
    "<frozen task source ID>": {
      "agent": {"family": "node-bookworm-amd64"},
      "graders": {"single": {"family": "node-bookworm-amd64"}}
    }
  }
}
```

The image contains common runtimes and pinned harness distributions. A harness
`setupRef` is optional trusted preparation code, resolved from the study bundle
and checked by digest before any VM allocation. It runs only in that harness's
prepared parent, without the coordinator's environment. Preparation must stay
free of candidate sessions, model calls, credentials and hidden grader data.
The task binding may select `localSetup`, using the same frozen-context contract
as the direct-parent profile. The meta-parent receives neither task setup nor
harness preparation. No derived harness image needs publication to the registry.

A compatible family shares CPU architecture, OS/runtime prerequisites, resource
requirements and network policy. EBO checks the selected task environments before
allocation and rejects conflicting resources or network conditions within one
family. Declare another family when those requirements differ. Each task and
harness remains part of its prepared parent's identity; model/provider/config
variants share that parent and receive their attempt configuration after branching.

`auth: "cli"` explicitly reuses the Smol SDK's `smol auth login` session.
Keep `SMOL_CLOUD_TOKEN` unset in this mode so an ambient token cannot replace that
session. Expired sessions fail with the SDK's login guidance. For unattended
work, select `tokenEnv` instead of `auth`; its worker allowlist exclusion remains
enforced. CLI session credentials are never copied into the image or guest.

Receipts record durable Cloud IDs for meta-parents, harness/grader parents and
trial children. Display names are retained only as allocation intent labels.
A lost branch response leaves the lineage `cleanup-pending` for reconciliation;
it never creates a replacement image or another trial. Teardown deletes
descendants before ancestors and retains ancestors after a failed or ambiguous
child deletion. Settled usage remains attached to each deletion receipt.

Cloud placement is verified against the family architecture. Ready Cloud VMs
can report `started`; EBO also checks readiness and the recorded boot identity.
Cloud branches are node-local, so node capacity and account quotas apply to the
whole preparation tree. This profile keeps prepared ancestors running; frozen
ancestor optimization is not enabled. It imposes no new trial duration or budget
limit, and does not upgrade the account plan automatically.

## Inspect and evaluate

The returned `bundlePath` contains:

- `harbor/trials/<attempt>/`: official lock, configuration, result, logs and
  verifier artifacts.
- `harbor/preparation.json`, `task-transformation.json`, `smol-events.jsonl`:
  parent bindings, original/derived task identity, branch timings and cleanup state.
- `steps/<n>/bundle/`: ordinary EBO native run bundles, including each step's
  pre-verifier workspace patch and capture report.
- `steps/<n>/worker-finished.json`: native terminal and qualification summary.
- `ebo/manifest.json`: links among task, condition, trial, steps and Harbor result.

Each step bundle includes a restricted `harbor-result.json` diagnostic so its
provenance remains reachable through corpus inspection and portable export.
Step-specific fixture identities prevent comparisons from pooling different
steps as repetitions. Use these ordinary step bundles with the existing
[evidence/export](evidence-and-sharing.md) and [Behavior Atlas](atlas.md) commands.
`ebo corpus build <output-root> <index.jsonl>` over the output root indexes each
attempt's step bundles and skips its `ebo/` summary and `harbor/` files, so the
output root is a corpus root as it stands.
The Harbor trial summary is not itself a native run bundle or a quality score.

Native step bundles capture execution in observational mode, including when
Harbor verifies the task afterward. The attached Harbor result retains the
frozen task's assessment mode and original rewards. Corpus indexing reads that
bound result as `assessmentMode` and keeps the child's mode as
`captureAssessmentMode`, for both retained bundles and portable exports. EBO
does not translate Harbor rewards into an invented pass/fail verifier result.

Interrupted attempts retain available files and explicit gaps. If the VM
becomes unreachable, environment cleanup and evidence download can fail; inspect
the retained control logs and trial directory before retrying with a new ID.

## Convert an existing task packet

```sh
ebo harbor convert-legacy study packets/task.json --image node:24.19.0-bookworm-slim
```

The converter uses EBO's existing admitted-archive materializer. It copies only
agent-visible files, preserves the prompt and writes a new, unadmitted task plus
an external `.conversion.json` report. It never modifies the packet or freeze.
Review the image and setup assumptions. Verified packets require manual verifier
and optional solution adaptation; conversion does not invent rewards or approval.

Windows, GPU/TPU environments, MCP services and multi-service Compose tasks are
classified as unsupported by this initial profile. The official Harbor validator
remains responsible for task-format validity.

### Factory provider qualification

Factory uses the same capture core for managed and BYOK models. Freeze the
[Factory model route](../harnesses/factory-droid.md#freeze-the-condition) and
include its credential variable in the worker's `environmentKeys`:
`FACTORY_API_KEY` for managed inference, or `FIREWORKS_API_KEY` for the Fireworks
BYOK template. Credentials are injected after branching and excluded from frozen
model records. Include `factory-droid` in the runtime request with a Linux ARM64 target before building the guest pack.

Run the [Factory live checks](../harnesses/factory-droid.md#verification-and-live-qualification)
for each selected provider/image combination. The synthetic Pi Smol conformance
suite validates infrastructure independently of Factory inference.

### Task-shipped prior trajectories

EBO rejects `trajectory.json` at the task root or beside a step's
`instruction.md` with `unsupported-imported-trajectory`. The check runs during
inspection/admission, queue compilation and execution preparation, including
frozen tasks. Regular files, symlinks and dangling symlinks at these reserved
locations all require seeded-context support, which the execution profile does
not declare. Data files under a task's ordinary work directory keep their
normal meaning.

This guard also applies with Harbor 0.24.0; it does not depend on a later
Harbor release detecting the file. Post-run ATIF analysis uses the separate
[import admission path](../reference/atif.md#inspect-and-import).
