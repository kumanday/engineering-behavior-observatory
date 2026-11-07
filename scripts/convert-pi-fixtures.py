"""Regenerate public synthetic Pi ATIF fixtures with the independent Harbor converter."""
import argparse
import hashlib
import json
import pathlib
import shutil
import tempfile
from importlib.metadata import version

from harbor.agents.installed.pi import Pi
from harbor.models.agent.context import AgentContext

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("root", type=pathlib.Path)
parser.add_argument("--check", action="store_true")
args = parser.parse_args()
if version("harbor") != "0.24.0":
    raise SystemExit("Synthetic fixture generation requires harbor==0.24.0")
manifest = {"schemaVersion": "ebo.atif-synthetic-fixtures/v1", "producer": "harbor.agents.installed.pi.Pi", "harborVersion": "0.24.0", "fixtures": []}
for source in sorted(args.root.glob("*.native.jsonl")):
    name = source.name.removesuffix(".native.jsonl")
    outputs = []
    for _ in range(2):
        with tempfile.TemporaryDirectory() as temporary:
            logs = pathlib.Path(temporary)
            session = logs / "pi/sessions/session.jsonl"
            session.parent.mkdir(parents=True)
            shutil.copyfile(source, session)
            Pi(logs_dir=logs, model_name="synthetic-model").populate_context_post_run(AgentContext())
            outputs.append((logs / "trajectory.json").read_bytes())
    if outputs[0] != outputs[1]:
        raise SystemExit(f"Non-deterministic converter: {name}")
    target = args.root / f"{name}.atif.json"
    if args.check:
        if not target.exists() or target.read_bytes() != outputs[0]:
            raise SystemExit(f"Independent conversion drift: {name}")
    else:
        target.write_bytes(outputs[0])
    manifest["fixtures"].append({"id": name, "native": source.name, "trajectory": target.name,
                                  "nativeSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                                  "trajectorySha256": hashlib.sha256(outputs[0]).hexdigest()})
target = args.root / "manifest.json"
text = json.dumps(manifest, indent=2) + "\n"
if args.check:
    if target.read_text() != text:
        raise SystemExit("Synthetic manifest drift")
else:
    target.write_text(text)
print(f"PASS: {len(manifest['fixtures'])} independent deterministic Pi conversions")
