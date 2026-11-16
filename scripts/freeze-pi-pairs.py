"""Freeze independent Harbor conversions of native-accepted private Pi fixtures."""
import argparse
import hashlib
import inspect
import json
import pathlib
import shutil
import tempfile
from importlib.metadata import version

from harbor.agents.installed.pi import Pi
from harbor.models.agent.context import AgentContext

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("baseline", type=pathlib.Path)
parser.add_argument("output", type=pathlib.Path)
args = parser.parse_args()
if version("harbor") != "0.24.0":
    raise SystemExit("Requires harbor==0.24.0")
args.output.mkdir(parents=True, exist_ok=False)
args.output.chmod(0o700)
seen = set()
fixtures = []
pending = args.output / "pending.json"
def checkpoint():
    pending.write_text(json.dumps({"status": "incomplete", "fixtures": fixtures}, indent=2) + "\n")
    pending.chmod(0o600)
checkpoint()
for row in json.loads(args.baseline.read_text())["results"]:
    if row["status"] != "accepted" or row["datasetDigest"] in seen:
        continue
    seen.add(row["datasetDigest"])
    source = pathlib.Path(row["root"])
    session = (source / "pi-session.jsonl").read_bytes()
    if hashlib.sha256(session).hexdigest() != row["sessionSha256"]:
        raise SystemExit("Native session changed since baseline")
    manifest_bytes = (source / "manifest.json").read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest() != row["manifestSha256"]:
        raise SystemExit("Native manifest changed since baseline")
    manifest = json.loads(manifest_bytes)
    outputs = []
    for _ in range(2):
        with tempfile.TemporaryDirectory() as temporary:
            logs = pathlib.Path(temporary)
            copied = logs / "pi/sessions/session.jsonl"
            copied.parent.mkdir(parents=True)
            copied.write_bytes(session)
            Pi(logs_dir=logs, model_name=manifest["run"]["model"]["id"]).populate_context_post_run(AgentContext())
            artifacts = {"trajectory.json": (logs / "trajectory.json").read_bytes()}
            for media in sorted((logs / "images").rglob("*")):
                if media.is_symlink():
                    raise SystemExit("Converter produced a symlink instead of media")
                if media.is_file():
                    artifacts[media.relative_to(logs).as_posix()] = media.read_bytes()
            outputs.append(artifacts)
    if outputs[0] != outputs[1]:
        raise SystemExit("Independent Pi conversion was nondeterministic")
    identity = row["datasetDigest"].split(":")[-1]
    destination = args.output / identity
    destination.mkdir()
    destination.chmod(0o700)
    retained = []
    for relative, content in outputs[0].items():
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.parent.chmod(0o700)
        target.write_bytes(content)
        target.chmod(0o600)
        retained.append({"relativePath": relative, "sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)})
    fixtures.append({"id": identity, "sourceRoot": str(source), "nativeDatasetDigest": row["datasetDigest"],
                     "nativeManifestSha256": row["manifestSha256"], "nativeSessionSha256": row["sessionSha256"],
                     "trajectory": str(destination / "trajectory.json"), "trajectorySha256": hashlib.sha256(outputs[0]["trajectory.json"]).hexdigest(),
                     "artifacts": retained,
                     "nativeMeasures": row["measures"], "deterministic": True})
    checkpoint()
receipt = {"schemaVersion": "ebo.pi-equivalence-fixture-set/v1", "harborVersion": version("harbor"),
           "converterSourceSha256": hashlib.sha256(pathlib.Path(inspect.getfile(Pi)).read_bytes()).hexdigest(),
           "baselineSha256": hashlib.sha256(args.baseline.read_bytes()).hexdigest(), "fixtures": fixtures}
(args.output / "manifest.json").write_text(json.dumps(receipt, indent=2) + "\n")
(args.output / "manifest.json").chmod(0o600)
pending.unlink()
print(f"PASS: {len(fixtures)} accepted native datasets converted twice; private fixture set frozen")
