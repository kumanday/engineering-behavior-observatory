# Migrate to the rc.2 candidate

Keep retained bundles, source logs, admitted imports, assertions and packets unchanged. Open them through their original reader when reproducing an existing result. Both shipped fixed 1.x readers remain available. Reopening an ATIF import through the current reader produces an interpretation receipt when projection rules differ; its admission identity stays intact.

New ATIF derivations use producer-independent spec semantics. Optional overlays contribute extension interpretations and limitations. EBO retains unknown fields and missing values explicitly. Unknown future ATIF 1.x minor versions use the latest supported minor’s semantics with a warning. An ATIF 2.x document reports an unsupported major schema until that format is implemented.

Generate new datasets, observations, occurrence ledgers, rating inputs and judge inputs beside existing results. Use migration accounting to reuse only artifacts whose dependencies remain identical. New interpretations do not authorize rerunning paid ratings or judgments.

## Prepare execution

Write a runtime request naming the study and its required roles, then run:

```sh
ebo runtime freeze ./study ./runtime-request.json
ebo runtime inspect ./study
ebo runtime check ./study claude-agent-sdk
ebo runtime bind-queue ./study ./queue.json ./study/queue-with-runtime.json
```

The default selects stable releases at least 24 hours old. Use per-harness age policies, exact reproduction overrides and explicit prerelease opt-ins as needed. Inspect advisory and deprecation warnings before running. Missing runtimes and changed or withdrawn artifacts require repair of that study’s exact installation; EBO does not silently select another release.

Use the bound queue’s reported executable run ID with the harness command. The source assignment ID also resolves to that run. The manifest retains both IDs, the study freeze, runtime lock and launch receipt. Direct library capture callers pass `runtime: { studyRoot }`; their caller-supplied run IDs remain unchanged.

SDKs load from the isolated study installation. Configuration version and executable fields remain provenance; runtime selection comes from the lock. OpenHands starts an owned frozen container; remove executable `serverLaunch` settings. Harbor and Smol share the frozen host Python graph. Rebuild guest worker archives as `ebo.harbor-worker-runtime/v2` with that same study lock. Legacy worker metadata remains readable; execution requires the lock-bound archive.

New captures use `run-manifest/v2`; new operational judgments use `ebo.semantic-judgment/v3`. Retained readers accept their historical contracts without installing runtime software or querying a registry. Harness version disagreements are visible confidence and cohort metadata. A native format that cannot parse reports the failing format contract.
