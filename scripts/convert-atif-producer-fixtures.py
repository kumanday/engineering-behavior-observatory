"""Regenerate authored producer fixtures with pinned independent converters. No agents run."""
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
if version("harbor") != "0.24.0":
    raise SystemExit("Requires harbor==0.24.0")
expected = {codex: "1fbd52746468b9734cc3af963c9398a21f6fda6f7173b84fa0ac3ae0fe623c66",
            hermes: "561549f4c3449e3c4a7cbc3e6929c8b1b02b754567a551feec02df6b7196087e",
            trajectories: "c64c9a8e47c731d4f18337d3e05469044c470d73a57e8e10333c1c8bf004f894"}
for module, digest in expected.items():
    if hashlib.sha256(pathlib.Path(module.__file__).read_bytes()).hexdigest() != digest:
        raise SystemExit(f"Converter source drift: {module.__name__}")
manifest = {"schemaVersion": "ebo.atif-producer-fixtures/v1", "harborVersion": version("harbor"),
            "converterDigests": {m.__name__: d for m, d in expected.items()}, "fixtures": []}
for name in ["codex", "hermes", "openclaw", "hermes-empty", "openclaw-empty", "openclaw-late-results"]:
    family = name.split("-", 1)[0]
    extension = "json" if family == "hermes" else "jsonl"
    source = args.root / f"{name}.native.{extension}"
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
    if target.read_text() != data:
        raise SystemExit("Fixture manifest drift")
else:
    target.write_text(data)
print("PASS: 6 independent deterministic producer conversions")
