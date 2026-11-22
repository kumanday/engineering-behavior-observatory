# Qualify EBO 2.0.1

Qualify the release once from a clean checkout of the release commit, with the
package version set to 2.0.1 and Node 26.13.0:

```sh
npm ci
npm run acceptance
```

Acceptance builds, typechecks, runs the serialized suite, checks documentation
links and sharing scans, and compares two byte-identical npm archives. It reads
`release/2.0.1/reproducibility.json`, which binds the release's source inputs
by digest; write that manifest from the release commit when the version is set.
Its receipt records the actual source commit, fixture bindings and package
digest under `.ebo/releases/2.0.1/`. Acceptance publishes nothing.

Set `EBO_ATIF_TEST_PYTHON` and `EBO_LEADERBOARD_TEST_PYTHON` to the isolated
Harbor leaderboard-policy conformance interpreter, `EBO_ATIF_NEXT_PYTHON` to the
independent next-Harbor interpreter and `EBO_HARBOR_PYTHON` to the frozen
Harbor and Smol interpreter. Keep private paths and evidence outside Git. Set
`PYTHONDONTWRITEBYTECODE=1` for the frozen Python cache.

Install the resulting archive in a fresh local project. Check CLI help, the nine
native adapters, generic unknown-producer ATIF import, a decision-model run
against a fixture provider and an LLM-judge run against a fixture backend.
Repeat no-inference SDK API and runtime-version probes against actual isolated
installations. Keep those receipts separate from simulated protocol tests and
any live-provider qualification. Optional provider and VM tests stay opt-in and
confer no qualification when skipped.
