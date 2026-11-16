# Candidate qualification

After M2 is merged into develop, qualify this candidate once from a clean checkout with Node 24.19.0:

```sh
npm ci
npm run acceptance
npm run compatibility:verify
```

Set `EBO_ATIF_TEST_PYTHON` and `EBO_LEADERBOARD_TEST_PYTHON` to the isolated Harbor 0.24 leaderboard-policy conformance interpreter. Set `EBO_ATIF_NEXT_PYTHON` to the independent Harbor 0.25 interpreter, `EBO_HARBOR_PYTHON` to the frozen Harbor/Smol pilot interpreter, `EBO_ATIF_PRIVATE_FIXTURES` to private fixture storage, and `EBO_COMPATIBILITY_PACKET_ROOT` to the retained packet used for historical readback. Keep private paths and evidence outside Git. Set `PYTHONDONTWRITEBYTECODE=1` for the frozen Python cache.

Acceptance builds, typechecks, runs the serialized suite, checks documentation links and sharing scans, and compares two byte-identical npm archives. Its receipt records the actual source commit, fixture bindings and package digest under `.ebo/releases/2.0.0-rc.2/`. No package, tag or site is published. Optional provider and VM tests remain opt-in and confer no qualification when skipped.

Install the resulting archive in a fresh local project. Check CLI help, the eight native adapters, generic unknown-producer ATIF import, retained v2 analysis, both fixed readers and historical packet verification. Repeat no-inference SDK API and runtime-version probes against actual isolated installations. Keep those receipts separate from simulated protocol tests and any live-provider qualification.

The rc.1 archive and its qualification receipts stay unchanged. The local rc.2 archive is a distinct candidate; its status comes from its qualification receipt.
