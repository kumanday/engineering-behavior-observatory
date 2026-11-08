# Study runtime locks

A study runtime lock freezes the software selected for a study. It records exact
releases, publication times, integrity hashes, dependency graphs, installation
receipts and security checks. Reopening the freeze reuses those selections.
Changing the requested composition or policy requires a new study revision.

## Prepare and inspect a freeze

Write a request file with the study ID and the runtime roles it needs:

```json
{
  "studyId": "example-study",
  "roles": ["claude-agent-sdk", "codex-app-server", "codex-judge"],
  "policy": { "minReleaseAgeMs": 86400000 },
  "harnessPolicies": {
    "claude-agent-sdk": { "minReleaseAgeMs": 172800000 }
  },
  "overrides": { "codex": "0.162.1" }
}
```

Run the preparation commands:

```sh
ebo runtime list
ebo runtime freeze ./study ./runtime-request.json
ebo runtime inspect ./study
ebo runtime check ./study claude-agent-sdk
```

`freeze` resolves and installs the requested software. `inspect` reads the
retained lock. `check` rereads withdrawal metadata, queries OSV, verifies the
installed files and checks the selected SDK's API exports. These commands do not
submit an agent or judge turn.

The harness roles are `claude-agent-sdk`, `codex-app-server`, `devin-cli`,
`cursor-sdk`, `pi-sdk`, `factory-droid`, `openhands-agent-server` and
`deepseek-harness`. `codex-judge`, `harbor` and `smol` select supporting runtimes.
The `list` output names each role's components and upstream package sources.

## Verification evidence

The [verification catalog](harness-verification.md) records admitted probe and
scoped capture results for the selected runtime. New study locks snapshot that
interpretation; later admissions do not change an existing freeze. Use
`runtime verify` to prepare a no-inference candidate and pass
`--verification-catalog <path>` to `runtime freeze` when adopting an operator
catalog. A package version in EBO’s development dependencies does not establish
capture verification.

## Bind a queue to the freeze

After compiling a task-packet or Harbor queue, bind it to the study:

```sh
ebo runtime bind-queue ./study ./study/queue.json ./study/queue-with-runtime.json
```

The command writes `ebo.run-queue/v3`, containing the validated source queue and
an `ebo.study-freeze/v1` record. The freeze binds the queue digest to the runtime
lock and remains identical when repeated. The command reports each original
assignment ID as `sourceRunId` and its executable `runId`. Use the executable ID
with the existing harness run command. A source ID also resolves to that same
execution. Captures derive their run identity from the study freeze and retain
both identities in their manifest.

The source queue's bytes and existing readers remain usable. Retained queues
open without installing their runtimes. Execution checks that a bound queue's
runtime lock matches the active study before reading harness configuration or
starting capture. A different runtime selection belongs to a new study revision.
All arms in the queue must have a frozen native adapter runtime; arm names can
refer to that adapter through their harness configuration. DeepSeek’s versioned runtime composition identifies its adapter directly.

A request's `target` supplies the default OS and CPU architecture. `roleTargets`
overrides them for an individual role, for example:

```json
"roleTargets": { "pi-sdk": { "platform": "linux", "architecture": "arm64" } }
```

This lets a study prepare guest SDKs alongside host supporting runtimes. npm
resolution and installation receive explicit OS, CPU and Linux libc settings.
The inspection output shows each graph's platform and ABI. Loading a graph on
a different host reports a target mismatch before an SDK can execute.

Python runtimes resolve on their execution host. Set `EBO_RUNTIME_PYTHON` to an
absolute interpreter path when `python3` does not meet the selected packages'
requirements. The freeze records the probed Python version, ABI, platform and
binary digest. Installation verifies that interpreter; each launch verifies the
installed virtual environment and probes its installed package versions. A host
interpreter cannot prepare a Python runtime labelled for a different platform.
The bootstrap interpreter needs `pip` and `pypi-attestations`. Its TLS trust store
must validate PyPI and Sigstore; `SSL_CERT_FILE` selects an operator-provided CA
bundle for installation commands. Signature and certificate checks remain enabled.

OpenHands freezes an OCI image and a local `smol` engine in the same study.
OCI admission verifies the registry descriptors; Smol pulls the immutable image
when creating its VM. A native coordinator owns that VM and its loopback server.
A Harbor worker runs the server inside its existing task VM. Set
`"openhandsBoundary": "task-guest"` for that study; the default is `"host-vm"`.
Qualification binds the selected boundary, coordinator platform, Node ABI and
Smol/Python composition. The guest coordinator runs as root inside its task VM,
joins the server to a dedicated cgroup, then applies the workspace owner's UID
and GID. Shutdown confirms the cgroup is empty before retaining a stable
workspace. `baseUrl` remains a configuration compatibility field; the owned
server supplies the executable endpoint.

The configuration bundle and runtime study can use separate directories. Pass
`--configuration-root <bundle-root>` to `runtime bind-queue` to resolve the queue’s
source references there. Pass `--runtime-study <study-root>` to a native queue-run
command to select the corresponding runtime freeze. Without those options, each
command uses its existing root argument.

## Selection policy

The default minimum release age is 24 hours. `policy.minReleaseAgeMs` changes it
for the study; `harnessPolicies` overrides it for an individual harness or
supporting role. Selection uses registry publication timestamps and release
ordering, rather than a mutable dist-tag.

Stable releases are selected by default. Default selection skips deprecated runtime releases. A harness whose public packages use a
release-candidate channel needs an explicit opt-in:

```json
{
  "studyId": "deepseek-example",
  "roles": ["deepseek-harness"],
  "harnessPolicies": {
    "deepseek-harness": { "allowPrerelease": true }
  }
}
```

An override names an exact component version. The component IDs appear in
`ebo runtime list`; a role override applies to its primary component. Overrides
still undergo age, withdrawal, integrity and security checks. A deprecated
frozen release or exact reproduction override produces a warning. Deprecated
transitive dependencies produce `RUNTIME_DEPENDENCY_DEPRECATED` warnings with
the package name, version and reason. These appear in preparation, inspection,
checks and run output and remain in retained receipts. Yanked,
unpublished and malicious releases block execution.

Native npm build variants retain their upstream package name and full artifact
version. Their OS/CPU constraints and stable parent release identify the build;
the parent runtime's stable-release policy determines selection. Security queries
use the actual package identity, and the lock separately records its install alias.

## Installation and security receipts

The study stores its lock at `runtimes/lock.json` and installations under
`runtimes/cache/`. Installation identities include the dependency graph,
platform, ABI and recipe. An installation becomes reusable after its files and
receipt have been written atomically. Changed installed bytes fail verification.

npm installs use the exact package lock with lifecycle scripts disabled. Registry
signatures and provenance are verified when offered. Python installs use exact,
hash-bound wheels; source builds are disabled. Python dependency resolution uses
`uv` and pip. Offered PyPI attestations require the `pypi_attestations` verifier
in the selected bootstrap Python environment. A missing verifier reports an
installation failure.

Vendor archives and container images also check the maintained publisher’s GitHub attestations. Offered bundles are retained and verified with `gh attestation verify` against that repository and artifact digest. OCI discovery follows referrers and Cosign signature/attestation tags; offered Cosign proofs require `cosign` and the publisher’s GitHub Actions identity. BuildKit provenance is checked against the selected platform digest and retained as unsigned, content-linked metadata. It does not establish a signed publisher identity. Failed proof discovery or verification blocks installation; an absent proof is recorded as `not-offered`.

Per-study SDK installation keeps studies isolated and lets compatible releases run without rebuilding EBO. It costs disk space, preparation time and registry access. The package.json SDK dependencies supply development types and conformance fixtures. Before loading a study’s SDK, EBO verifies its files and required API exports; conformance tests exercise the retained protocol shapes. A changed API reports its specific contract failure. Automated dependency bumps alone would keep one shared SDK version and would not reproduce different frozen studies concurrently.

OSV is queried for every locked component during resolution and before a launch.
A `MAL-…` advisory blocks execution. Other active advisories are retained as
warnings. Security results include query times. A blocked malicious-package
check retains its query receipt under `runtimes/resolution-failures/` or
`runtimes/launches/`.

## Library calls and retained bundles

Queue runners read the freeze from the study root. Direct capture callers pass
`runtime: { studyRoot }`, or establish a context with
`withStudyRuntime({ studyRoot, role }, callback)`. Each public capture launch
refreshes withdrawal, integrity and security checks before it inspects capture
inputs. Internal capture layers share that checked launch. SDK calls inside that callback load the selected study's
modules. Concurrent studies retain separate module identities. An API contract
failure names the missing export or method; an unfamiliar version number alone
does not prevent loading a compatible SDK.

Run bundles created in this context use `run-manifest/v2`. They retain the lock
and launch receipt as internal diagnostics and bind them through `runtimeLock`.
Queue-bound captures also retain the study freeze, its digest and the original
assignment ID. Bundle verification checks the derived run ID against those
retained records. Direct capture APIs keep the run IDs supplied by their caller.
The launch receipt records actual package-version, executable or server-info
probes. A reported executable or server release that differs from its selected
release blocks the launch and retains both values. DeepSeek and Devin also
report service/protocol versions that are independent of the installed package
release; those values stay in native evidence. A changed lock,
missing receipt or inconsistent runtime binding fails bundle verification.
Existing v1 bundles retain their original schema and bytes. Retained analysis
uses the copies of the lock and launch receipt inside the bundle. It does not
need an installed study runtime, a registry connection or an OSV query.

Harbor with Smol requires both `harbor` and `smol` roles in one freeze. EBO
resolves them together in an isolated Python environment. Preparation and trials
probe the installed versions and compare them with the lock. Python imports do
not write bytecode into the frozen cache. The trial passes the same lock digest
to its guest worker, which performs its own withdrawal and OSV checks before
native capture. The supported Smol environment policy uses public egress for
these checks. Each native executor records actual runtime probes in its bundle.

## Judge execution

Freeze `codex-judge` for the Codex backend or `claude-agent-sdk` for the Claude
backend. Pass `--runtime-study <study-root>` to `ebo judge run` or
`ebo judge batch`. The batch rechecks each job before launch. The same option
binds the Codex fallback used by `ebo occurrences rate`. Library callers pass
`runtime: { studyRoot }` to the semantic-judge runner or establish a study
context. A configured or ambient executable does not select the judge runtime.

New operational judgments use `ebo.semantic-judgment/v3`. They retain the lock
and actual launch receipt as restricted artifacts and expose runtime warnings.
Their evaluator configuration digest binds the stable lock digest. Changing an
unused executable path or the launch receipt ID does not change that digest.
The v1 operational judgment and v2 analysis judgment contracts remain readable.

A shared npm graph applies each selected root's own age policy. Dependencies
use the strictest age policy in that graph. Resolution acquires the selected
root tarballs directly, then writes an exact-version package manifest and
package lock for installation. A nested dependency with the same package name
is checked as a dependency of the graph.

## Admit a prepared Python wheel

A missing wheel can be prepared outside EBO and admitted explicitly:

```sh
ebo runtime freeze ./study ./runtime-request.json \
  --python-wheelhouse /private/prepared-wheels/wheelhouse.json
```

The `ebo.local-python-wheels/v1` manifest lists each wheel and its
`ebo.python-wheel-build/v1` provenance file with separate SHA-256 digests. The
provenance records the upstream released sdist, source publication time, build
time, Python/platform target, recipe, pinned build tools, library inputs and
passing check receipts. EBO checks that the source matches PyPI and enforces
release age against that source. Applied source patches record their URL, exact
commit, SHA-256, publication time and upstream status. The age gate uses the
newest source or patch publication time. Repackaged upstream binary wheels also
record the original wheel's URL, hash and publication time. EBO checks that
binary against PyPI at freeze and before launch; its age and withdrawal status
participate in admission. Stable-ABI wheels retain their upstream ABI tag and
record the Python version used to test the prepared artifact. Each admitted
wheel may be up to 64 MiB, with a 128 MiB total per manifest. The complete
serialized study lock must also fit the 64 MiB qualification artifact limit.
Retained wheel bytes use base64, so the effective combined wheel limit is
smaller and depends on the other lock receipts. Freeze rejects an oversized
lock before creating its frozen record.

A locally prepared wheel is labelled
as an operator build. Its build time remains separate from source age.

The freeze retains the wheel bytes and provenance in its content-addressed
plan. Installs remain wheel-only, hash-checked and offline. The original
wheelhouse is therefore unnecessary when reopening retained installations.
Supplying a wheelhouse again validates it against the frozen admission;
different inputs require a new study revision. Registry withdrawal checks
apply to the upstream source, and launch security receipts query OSV for the
runtime packages and declared build inputs. `runtime inspect` displays admitted
wheels, source identity, build time and provenance digest. EBO executes no source
builds during resolution or installation.
