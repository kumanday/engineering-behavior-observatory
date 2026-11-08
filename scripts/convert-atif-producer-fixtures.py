"""Regenerate authored producer fixtures with independent converters. No agents run."""
import argparse
import hashlib
import json
import pathlib
import tempfile
from importlib.metadata import version

import harbor.agents.installed.codex as codex
import harbor.agents.installed.hermes as hermes
from hlb.harbor_ext import trajectories

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("root", type=pathlib.Path)
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
print(json.dumps({"harborVersion": version("harbor")}), flush=True)
modules = [codex, hermes, trajectories]
actual = {module.__name__: hashlib.sha256(pathlib.Path(module.__file__).read_bytes()).hexdigest() for module in modules}
manifest = {"schemaVersion": "ebo.atif-producer-fixtures/v1", "harborVersion": version("harbor"),
            "converterDigests": actual, "fixtures": []}
for source in sorted(args.root.glob("*.native.*")):
    name, extension = source.name.split(".native.")
    family = name.split("-", 1)[0]
    if family not in {"codex", "hermes", "openclaw"} or extension != ("json" if family == "hermes" else "jsonl"):
        raise SystemExit(f"Unsupported authored fixture: {source.name}")
    outputs = []
    for _ in range(2):
        with tempfile.TemporaryDirectory() as tmp:
            logs = pathlib.Path(tmp)
            if family == "codex":
                (logs / "rollout.jsonl").write_bytes(source.read_bytes())
                result = codex.Codex(logs_dir=logs, model_name="synthetic-model")._convert_events_to_trajectory(logs)
            elif family == "hermes":
                agent = hermes.Hermes(logs_dir=logs, model_name="synthetic-model", version="v0.22.1")
                result = agent._convert_hermes_session_to_atif(source.read_text(), "synthetic-hermes")
            else:
                (logs / trajectories.OPENCLAW_TRANSCRIPT).write_bytes(source.read_bytes())
                result = trajectories.openclaw(logs, "synthetic-model", "2026.10.4")
            assert result is not None
            outputs.append((json.dumps(result.to_json_dict(), indent=2) + "\n").encode())
    if outputs[0] != outputs[1]:
        raise SystemExit(f"Non-deterministic conversion: {family}")
    target = args.root / f"{name}.atif.json"
    if args.check:
        if target.read_bytes() != outputs[0]:
            raise SystemExit(f"Conversion drift: {family}")
    else:
        target.write_bytes(outputs[0])
    manifest["fixtures"].append({"id": name, "native": source.name, "trajectory": target.name,
                                 "nativeSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                                 "trajectorySha256": hashlib.sha256(outputs[0]).hexdigest()})
target = args.root / "manifest.json"
data = json.dumps(manifest, indent=2) + "\n"
if args.check:
    if json.loads(target.read_text())["fixtures"] != manifest["fixtures"]:
        raise SystemExit("Fixture digest drift")
else:
    target.write_text(data)
print(f"PASS: {len(manifest['fixtures'])} independent deterministic producer conversions")
