# Candidate qualification and cold readback

Use Node 24.19.0 and a clean checkout. Install the locked dependencies, then run:

```sh
npm ci
npm run acceptance
npm run compatibility:verify
```

For the independent Python fixture and board-policy checks, use the pinned
Harbor 0.24.0 environment described by the ATIF conformance workflow. Set
`EBO_ATIF_TEST_PYTHON` and `EBO_LEADERBOARD_TEST_PYTHON` to that interpreter before
acceptance so their integration tests execute. Set `EBO_COMPATIBILITY_PACKET_ROOT`
to a verified retained packet to exercise historical packet readback as well. The workflow also regenerates
Pi and additional-producer authored fixtures with independent converters.
Optional live-provider and image-backed environment tests retain explicit opt-in.
A skipped optional test supplies no new live qualification.

Acceptance writes `.ebo/releases/2.0.0-rc.1/acceptance-result.json`, the candidate
archive and `SHA256SUMS`. It records the checked Git commit, fixture count and
package digest. It builds and typechecks, runs the full serialized deterministic
suite, checks source and packaged documentation links, scans for restricted or
machine-local content, and compares two byte-identical archives. Keep the
checkout unchanged until the check ends. The command publishes nothing.

Extract the resulting archive into a fresh local directory, install its declared
dependencies, and invoke the packaged CLI with Node:

```sh
node package/dist/src/cli.js atif profiles --v2
node package/dist/src/cli.js v2 inspect RETAINED_BUNDLE NEW_OUTPUT
```

Select a retained admitted import or owned source bundle. The analysis command
reopens sources without Python and produces a dataset, observations, ledger,
rating inputs and local Atlas page. It dispatches no inference. For programmatic
checks, `listNativeV2Profiles()` returns eight profiles, `listAtifProfilesV2()`
returns five fingerprints, and `listAnalysisRuntimes()` returns two fixed readers.
Reconstruct a stored v2 input through `createMigrationTargetV2` against the exact
retained source and verify its reconciliation. A direct JSON reload must fail
that guard.

Private qualification additionally checks the frozen 144-path native baseline,
41 independent Pi pairs, explicit study migration receipts and the bounded public
producer sample. Restricted evidence stays outside the archive. The Pi matrix
separates equal values, declared losses and unavailable measures. Codex's retained
pilot has 45 native calls and 44 converted calls; Hermes matches 28 call IDs and
names; OpenClaw's missing-session fallback has unknown whole-attempt tool count.
These cases do not qualify global cross-origin pooling or the entire leaderboard.

Review the actual acceptance receipt and CI jobs for the intended candidate head.
A new source edit requires checking affected gates and regenerating candidate
fixture hashes when their pinned inputs change. Published historical manifests
remain immutable. Release publication follows the ordering in `AGENTS.md` after
its own authorization.
