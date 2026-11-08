"""Check public fixtures with frozen independent converters. Never runs agents.

The release and module pins identify test provenance, not EBO reader eligibility.
"""
import argparse
import hashlib
import inspect
import json
import logging
import pathlib
import tempfile
from importlib.metadata import version

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.agents.installed.codex import Codex
from harbor.agents.installed.cursor_cli import CursorCli
from harbor.agents.installed.devin import Devin
from harbor.agents.installed.openhands import OpenHands
from harbor.agents.installed.pi import Pi
from harbor.models.agent.context import AgentContext

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("root", type=pathlib.Path)
args = parser.parse_args()
print(json.dumps({"harborVersion": version("harbor")}), flush=True)
logging.disable(logging.CRITICAL)
classes = {"claude-agent-sdk": ClaudeCode, "codex-app-server": Codex,
           "cursor-sdk": CursorCli, "devin-cli": Devin,
           "openhands-agent-server": OpenHands, "pi-sdk": Pi}
receipts = json.loads((args.root / "generation-receipts.json").read_text())["fixtures"]

def rows(path, values):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(value) + "\n" for value in values))

for receipt in receipts:
    harness = receipt["harness"]
    if harness not in classes:
        continue  # Capture-derived authored ATIF is checked against retained values locally.
    cls = classes[harness]
    if hashlib.sha256(pathlib.Path(inspect.getfile(cls)).read_bytes()).hexdigest() != receipt["converterModuleSha256"]:
        raise SystemExit(f"Converter source drift: {harness}")
    native_path = args.root / f"{harness}.native.json"
    if hashlib.sha256(native_path.read_bytes()).hexdigest() != receipt["nativeSha256"]:
        raise SystemExit(f"Native fixture drift: {harness}")
    native = json.loads(native_path.read_text())
    for _ in range(2):
        with tempfile.TemporaryDirectory() as temporary:
            logs = pathlib.Path(temporary) / "authored-session"
            logs.mkdir()
            agent = cls(logs_dir=logs, model_name="authored/model")
            if harness == "claude-agent-sdk":
                session = logs / "session"
                rows(session / "session.jsonl", native)
                trajectory = agent._convert_events_to_trajectory(session, logs_dir=logs)
            elif harness == "codex-app-server":
                session = logs / "session"
                rows(session / "rollout-authored.jsonl", native)
                trajectory = agent._convert_events_to_trajectory(session)
            elif harness == "cursor-sdk":
                trajectory = agent._convert_events_to_trajectory(native)
            elif harness == "devin-cli":
                trajectory = agent._messages_to_trajectory([(value, None) for value in native], session_id="authored-session")
            elif harness == "openhands-agent-server":
                events = logs / "events"
                events.mkdir()
                for index, value in enumerate(native):
                    (events / f"{index}.json").write_text(json.dumps(value))
                trajectory = agent._convert_events_to_trajectory(events)
            else:
                rows(logs / agent._SESSIONS_DIRECTORY / "session.jsonl", native)
                agent.populate_context_post_run(AgentContext())
                trajectory = json.loads((logs / "trajectory.json").read_text())
            if trajectory is None:
                raise SystemExit(f"No trajectory: {harness}")
            document = trajectory if isinstance(trajectory, dict) else trajectory.to_json_dict()
            encoded = (json.dumps(document, indent=2) + "\n").encode()
            if encoded != (args.root / f"{harness}.json").read_bytes():
                raise SystemExit(f"Conversion drift: {harness}")
    print(f"PASS: {harness}; two deterministic independent conversions")
if len(classes) != sum(receipt["harness"] in classes for receipt in receipts):
    raise SystemExit("Missing or duplicate converter fixture receipts")
