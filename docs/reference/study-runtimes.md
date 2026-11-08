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

## Selection policy

The default minimum release age is 24 hours. `policy.minReleaseAgeMs` changes it
for the study; `harnessPolicies` overrides it for an individual harness or
supporting role. Selection uses registry publication timestamps and release
ordering, rather than a mutable dist-tag.

Stable releases are selected by default. A harness whose public packages use a
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

OSV is queried for every locked component during resolution and before a launch.
A `MAL-…` advisory blocks execution. Other active advisories are retained as
warnings. Security results include query times. A blocked malicious-package
check retains its query receipt under `runtimes/resolution-failures/` or
`runtimes/launches/`.

## Library calls and retained bundles

Library callers establish a study context with `withStudyRuntime({ studyRoot,
role }, callback)`. SDK calls inside that callback load the selected study's
modules. Concurrent studies retain separate module identities. An API contract
failure names the missing export or method; an unfamiliar version number alone
does not prevent loading a compatible SDK.

Run bundles created in this context use `run-manifest/v2`. They retain the lock
and launch receipt as internal diagnostics and bind them through `runtimeLock`.
The launch receipt records actual package-version probes. A changed lock,
missing receipt or inconsistent runtime binding fails bundle verification.
Existing v1 bundles retain their original schema and bytes.
