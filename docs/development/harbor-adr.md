# Harbor execution boundary

Harbor 0.24.0 owns task schema 1.4, content hashing, instruction composition,
task setup, multi-step policy, verification, locks and cleanup. Its native
`harbor.environments.smol` adapter uses Smol Python SDK 1.26.1. The local profile uses its bundled SmolVM/libkrun
runtime on Apple Silicon; the Cloud profile uses explicit API connection
metadata and detached native jobs.
EBO owns study governance and source-native trajectory capture. The boundary is an official
Harbor `BaseAgent` extension launched by `Trial.create`, not a copy of its loop.

The TypeScript worker runs inside the task environment. A host SDK pointed at a
downloaded workspace would bypass task setup, tools and isolation. A host-to-host
workspace copy is therefore not an execution mode. Each worker call invokes the
existing native capture core and drains it before Harbor verifies the result.

The implementation takes the useful Pi prototype admission and capture wrappers,
replaces its invalid environment calls and duplicated scheduler, and uses the
existing archive materializer for legacy conversion. It preserves the current
Cursor recovery/usage behavior and workspace projection fixes. The old packet
formats and captures are not rewritten.

The runtime archive is operator-controlled and digest-pinned. It keeps npm/Linux
packaging separate from task content and does not introduce a new SDK shim or
universal protocol. Native OpenHands/DeepSeek/Codex runtime installation remains
an explicit prerequisite, as it is outside Harbor tasks. Secrets enter through
selected environment keys; hidden verifier and solution files are never copied
by the worker.

## Verification

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run acceptance
node dist/src/cli.js harbor --help
git diff --check
```

The PR workflow checks the pinned Python model/provider contracts and native
worker tests. It does not claim VM qualification on a hosted Linux runner.
The provenance unit test uses fixture library bytes and mocked host metadata to
check the Apple Silicon policy, bundled-library requirement and digest binding.
The local-preparation gate uses a public Alpine image and uploads a unique
fixture locally, then checks two isolated branches and an unchanged parent:

```sh
EBO_HARBOR_PYTHON="$PWD/.harbor-venv/bin/python" \
EBO_SMOL_LOCAL_SETUP_TEST=1 node --test dist/test/harbor-smol.test.js
```

The live gate needs an approved registry-accessible arm64 execution image:

```sh
EBO_HARBOR_PYTHON="$PWD/.harbor-venv/bin/python" \
EBO_HARBOR_RUNTIME=.ebo/smol-runtime/worker.tgz \
EBO_SMOL_IMAGE="<registry/execution-image@sha256:platform-digest>" \
EBO_SMOL_LIBKRUN_SHA256="<library digest>" \
node --test dist/test/harbor-smol-live.test.js
```

It uses the pinned Pi SDK and a local deterministic HTTP provider, with no paid
model calls. Cases exercise observational capture, separate verification,
threshold stopping, missing rewards and setup failure. The normal suite also
tests the real Pi worker on the host as a unit boundary. Host-only evidence does
not substitute for the Smol gate. Live-provider success is a separate operator
qualification; this migration does not assert that all providers were called.

## Shared preparation and failure boundaries

The foreground queue owner keeps live parents alive across independent Python
attempt processes. OS locks cover the owner and active borrowers; receipts are
evidence, not a substitute for those locks. The provider wrapper enforces exact
parent bindings and delegates branching, transfers and deletion to Smol. There
is no distributed lease service, custom scheduler or checkpoint distribution.

The image and runtime manifest is part of the experiment digest. Volatile parent
names are not. Harbor's parsed models produce an image-bound execution copy;
instructions, setup, verifier order and rewards remain Harbor-owned. The original
task digest and derived digest are both retained.

Runtime publication is independent of task preparation. A binding may select a
frozen local setup script; the owner transfers only that role's build context
into a local parent, executes setup and retains its result before allowing
branches. The manifest identity includes this choice. Public images need contain
no repository or task data. Per-step setup remains Harbor-owned, and worker
credentials are injected only into attempt children.

Smol's bundled disk-capacity fix must pass the direct and separate-process
branching gate. Public-egress image-backed execution also needs its full live gate.
No-network image import and allowlist/virtio-net are not qualified. Reject these
policies instead of substituting public egress.

Native step bundles remain usable before behavioral assessment. Harbor rewards
are retained as source outcomes; structural extractors and judges do not inherit
them as invented semantic-quality labels.

## Cloud job recovery

Cloud uses the same official Harbor provider, task transformation and native
worker. A v2 environment manifest selects the endpoint, credential environment
variable and architecture. Credentials are resolved by the coordinator and never
written to receipts. Task image bindings and runtime digests remain frozen.
The control credential is excluded from the worker allowlist.

A detached Smol job holds the worker while the coordinator persists its machine
ID, job ID, boot identity and output offsets. Transport loss withholds deletion.
Explicit cancellation targets that job; recovery reads it without creating a
replacement. Submission intent is written before the request so a lost response
cannot silently trigger another model run. Recovery retrieves existing evidence;
it does not restart Harbor or invent a terminal native capture. It runs under the
study's frozen Harbor and Smol runtime, like preparation and trials. The coordinator
and parent owner share a durable filesystem and OS locks.

A local branch proves its image by pulling the frozen reference in the guest and
recording the config digest. The Cloud SDK has no guest pull, so a Cloud branch
is checked against the source reference in its machine record and its config
digest stays absent, not invented.

The v2 coordinator budget accepts an omitted wall-clock limit. The worker, Python
trial timeout and TypeScript child watchdog preserve omission. Frozen task and
native harness limits remain explicit conditions. Process output is fully spooled
to disk, with bounded in-memory diagnostic tails; output volume does not stop an
attempt. Cloud deletion retains settled usage or an explicit cleanup error.

`harbor-cloud.test.ts` checks connection validation, secret isolation, ambiguous
submissions, known-job disconnects, byte-offset recovery, cancellation and usage
receipts against the installed SDK's public data types, with native VM operations
mocked. These checks perform no Cloud allocation or inference. Live Cloud setup,
frozen-task execution and billing account verification are separate operator
gates.

## Hierarchical preparation

The v3 manifest declares one immutable image per compatible family and references
trusted harness setup scripts by artifact digest. Preparation validates the full
selected task/harness set before allocation, creates one clean meta-parent per
family, and derives branchable harness/grader parents with the native SDK.
Harbor's official provider creates the trial children from those exact parents.
Model/provider/config variants do not create extra prepared parents.

Family compatibility includes the effective resource specification and network
policy. A branch cannot silently change those conditions. Harness preparation
and task context stay out of the meta-parent; grader preparation is shared only
when the complete grader identity matches. The owner receipt retains the image,
recipe, source ID, prepared-parent fingerprint and meta-parent lineage.
Cloud machine IDs are distinct from display names and are used for reconnects,
checkpoints, jobs and recovery. Cloud `started` plus readiness is accepted as a
warm parent; kernel boot identity still rejects cold restarts.

Cloud preparation commands use native jobs with durable submission intent, IDs
and output offsets. Pending or lost setup jobs block ancestor cleanup; they must
be reconciled with native inventory before another preparation is attempted.

Ambiguous allocations retain their source lineage. Deletion works from children
toward ancestors and stops on a failed owned deletion. The v1/v2 direct-parent
path remains supported. CLI authentication is an explicit v3 option using the
SDK's documented session fallback, with ambient Cloud tokens rejected.

`harbor-hierarchy.test.ts` uses official Harbor models and branching code with
only native machine operations mocked. It verifies one image create, distinct
harness parents, shared clean graders, six trial branches, stable Cloud IDs,
unchanged frozen task inputs, incompatible resources, changed preparation scripts
and ancestor retention after an ambiguous branch response. Live infrastructure
qualification remains separate from frozen-task and private-registry qualification.
