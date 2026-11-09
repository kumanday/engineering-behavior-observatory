# Harbor and Smol CI snapshot

Harbor CI uses a complete, hash-locked Linux/Python 3.14 dependency graph.
`selection.json` records the Harbor and Smol releases selected through the same
`fetchRuntimeReleases` and `selectRuntimeRelease` functions used by study freezes,
with the default 24-hour age gate. This snapshot selects Harbor 0.25.0 and
Smol 1.32.4. Studies resolve and freeze their own runtimes independently.

Refresh the snapshot after building EBO, with `uv` available on PATH:

```sh
node scripts/harbor-ci/refresh.mjs
```

The refresh resolves the two root releases, then compiles wheels and dependency
hashes for the CI target with that same age cutoff. Review the selection receipt
and lock together. CI installs with `--only-binary=:all: --require-hashes`, runs
`pip check`, prints the actual installed root versions and runs no-model contract
tests. Changing any file in this directory triggers Harbor CI. The historical
ATIF 0.24 converter lane remains a separate compatibility check.
