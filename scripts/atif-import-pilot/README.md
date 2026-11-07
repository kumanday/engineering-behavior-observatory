# ATIF import development pilot

These scripts inspect and project a bounded public sample. They do not register
a production import adapter or create qualified run manifests. Source data,
private pairs and generated outputs stay outside Git. No script invokes a model
or executes any instruction found in a trajectory.

## Set up

Use Node 24.19.0 and Python 3.13.12. Install the repository dependencies and
compile EBO with its pinned Node runtime. Then, from the repository root:

```sh
nvm use
npm ci
npm run build
pilot_root="$PWD/.ebo/atif-pilot"
uv venv --python 3.13 "$pilot_root/.venv"
uv pip sync --python "$pilot_root/.venv/bin/python" scripts/atif-import-pilot/requirements.lock.txt
```

The lock records the pilot's exact installed distribution versions. Local
receipts also retain interpreter versions, source pins and conversion digests.

## Acquire and inspect

```sh
"$pilot_root/.venv/bin/python" scripts/atif-import-pilot/acquire.py "$pilot_root/sample"
"$pilot_root/.venv/bin/python" scripts/atif-import-pilot/acquire.py "$pilot_root/sample"
"$pilot_root/.venv/bin/python" scripts/atif-import-pilot/inspect_sample.py "$pilot_root/sample"
node scripts/atif-import-pilot/project.mjs "$pilot_root/sample"
```

The second acquisition verifies the retained hashes and returns `no-op`. The
sample paths are fixed in `acquire.py`. Acquisition is bounded to 16 MiB per
file and 100 MiB overall; dependencies referenced inside documents are never
fetched automatically. A new upstream snapshot needs a new output directory.
An interrupted acquisition keeps a checkpoint receipt and its retained files.
Retries refuse that nonempty partial destination; use a new directory rather
than replacing the incomplete snapshot.

To compare an owned Pi source, add a repeated `--pair` argument to inspection:

```sh
"$pilot_root/.venv/bin/python" scripts/atif-import-pilot/inspect_sample.py "$pilot_root/sample" \
  --pair /absolute/path/to/private/pi-run-bundle
node scripts/atif-import-pilot/project.mjs "$pilot_root/sample"
```

Each bundle must contain its original `pi-session.jsonl` and `manifest.json`.
The pinned Harbor Pi converter runs twice on copied input. Readback then uses
EBO's existing native qualification path. A native rejection is an important
negative result; conversion never upgrades it. Normalized experimental datasets
have no production import manifest and remain in the private pilot output.

## Scan and inventory

`atif-scan` accepts a manifest with local `inputs` entries (`id`, `path`). Use
only local paths and omit all model/image-model options:

```sh
"$pilot_root/.venv/bin/atif-scan" --manifest "$pilot_root/sample/scanner-inputs.json" \
  --format json --no-cache > "$pilot_root/sample/atif-scan-report.json"
"$pilot_root/.venv/bin/python" scripts/atif-import-pilot/inventory.py \
  "$pilot_root/compatibility-inventory.json" /absolute/path/to/selected-study
```

The scanner manifest is caller-owned operational input; the original pilot
receipt retains its exact four entries. Scanner findings remain review
candidates. Inventory is explicitly bounded to supplied roots, excludes named
workspace/source directories and ignores JSON larger than 2 MiB. Its output
records those limits and is not a workspace census.

## Focused checks

```sh
node --test scripts/atif-import-pilot/project.test.mjs
"$pilot_root/.venv/bin/python" -m unittest discover -s scripts/atif-import-pilot -p 'test_*.py'
```

One Node test intentionally records the current occurrence-order defect as a
baseline blocker. Replace that expectation with the corrected behavior in the
ordering-fix slice. The Python version-policy probe is a pilot subset, not the
complete product version table. The JSON-pointer and reference-resolution checks
are development evidence, not a complete production admission boundary.

See the [measured pilot report](../../docs/development/atif-import-pilot.md),
[design](../../docs/development/atif-adoption-design.md), and
[ADR](../../docs/development/atif-adoption-adr.md).
