"""Acquire a bounded, explicit public sample. This is development tooling, not EBO admission."""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import urllib.request
from datetime import datetime, timezone

BUCKET = "https://huggingface.co/buckets/joelniklaus/harness-leaderboard"
API = "https://huggingface.co/api/buckets/joelniklaus/harness-leaderboard/tree/"
CASES = {
    "pi": "runs/20261018-191100-glm-5-3-flash-full-low-3c31/terminal-bench-2.1/adaptive-rejection-sampler__E5tQWPd",
    "hermes": "runs/20261018-191100-glm-5-3-flash-full-low-3c31/terminal-bench-2.1/adaptive-rejection-sampler__3SLWJee",
    "openclaw": "runs/20261018-191100-glm-5-3-flash-full-low-3c31/terminal-bench-2.1/adaptive-rejection-sampler__3hz5Qds",
    "codex-pending": "runs/20261030-015111-deepseek-v4-1-flash-full-low-1200/terminal-bench-2.1/extract-moves-from-video__PQuRNAE",
}
MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 100 * 1024 * 1024


def fetch(url: str, limit: int = MAX_FILE) -> bytes:
    with urllib.request.urlopen(url, timeout=45) as response:
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError("bounded acquisition limit exceeded")
    return data


def wanted(relative: str) -> bool:
    if relative in ("config.json", "result.json", "lock.json", "hlb-record-copy.json", "hlb-record.jsonl"):
        return True
    if relative.startswith("verifier/"):
        return relative.endswith((".json", ".txt"))
    if not relative.startswith("agent/"):
        return False
    return relative.endswith((".jsonl", ".json", ".txt")) and not relative.startswith("agent/openclaw-trajectory/")


def acquire(output: pathlib.Path, refresh: bool = False) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    output.chmod(0o700)
    manifest_path = output / "acquisition.json"
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
    if previous and not refresh:
        for artifact in previous["artifacts"]:
            data = (output / artifact["localPath"]).read_bytes()
            if hashlib.sha256(data).hexdigest() != artifact["sha256"]:
                raise ValueError("retained artifact digest mismatch")
        return {"status": "no-op", "files": len(previous["artifacts"]), "bytes": previous["bytes"]}
    if previous:
        raise ValueError("refresh requires a new output directory; preserve the prior snapshot")
    if any(output.iterdir()):
        raise ValueError("incomplete acquisition destination is not empty; preserve it and choose a new directory")
    manifest = {"schemaVersion": "ebo.atif-pilot-acquisition/v1", "sharingClass": "restricted",
                "terms": "unstated", "retrievedAt": datetime.now(timezone.utc).isoformat(),
                "samplePolicy": "purposeful conversion-fidelity sample; no leaderboard rate estimates",
                "cases": {}, "artifacts": [], "bytes": 0, "limits": {"perFile": MAX_FILE, "total": MAX_TOTAL}}
    pending_path = output / "acquisition.pending.json"

    def checkpoint() -> None:
        pending_path.write_text(json.dumps(manifest, indent=2) + "\n")
        pending_path.chmod(0o600)

    checkpoint()

    def retain(case: str, relative: str, entry: dict) -> None:
        if any(part in ("..", "") for part in pathlib.PurePosixPath(relative).parts) or relative.startswith("/"):
            raise ValueError("unsafe acquisition path")
        if entry.get("size", 0) > MAX_FILE:
            manifest["cases"][case]["limitations"].append({"path": relative, "reason": "OVERSIZED_ARTIFACT"})
            return
        data = fetch(BUCKET + "/resolve/" + entry["path"])
        if manifest["bytes"] + len(data) > MAX_TOTAL:
            raise ValueError("total acquisition limit exceeded")
        local = pathlib.Path("sources") / case / relative
        destination = output / local
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("xb") as retained:
            retained.write(data)
        destination.chmod(0o600)
        manifest["bytes"] += len(data)
        manifest["artifacts"].append({"case": case, "path": entry["path"], "sourceUrl": BUCKET + "/resolve/" + entry["path"],
                                      "localPath": str(local), "sha256": hashlib.sha256(data).hexdigest(),
                                      "xetHash": entry.get("xetHash"), "bytes": len(data), "sharingClass": "restricted"})
        checkpoint()

    for case, prefix in CASES.items():
        with urllib.request.urlopen(API + prefix + "?recursive=true&limit=1000", timeout=45) as response:
            entries = json.loads(response.read(4 * 1024 * 1024))
            if response.headers.get("Link"):
                raise ValueError("sample subtree unexpectedly paginated")
        manifest["cases"][case] = {"prefix": prefix, "limitations": []}
        checkpoint()
        for entry in entries:
            if entry["type"] != "file":
                continue
            relative = entry["path"][len(prefix) + 1:]
            if wanted(relative):
                retain(case, relative, entry)
        run = "/".join(prefix.split("/")[:2])
        run_entries = json.loads(fetch(API + run + "?recursive=false&limit=1000", 4 * 1024 * 1024))
        run_file = next((x for x in run_entries if x["path"] == run + "/run.json"), None)
        if run_file:
            retain(case, "run.json", run_file)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    manifest_path.chmod(0o600)
    pending_path.unlink()
    return {"status": "acquired", "files": len(manifest["artifacts"]), "bytes": manifest["bytes"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=pathlib.Path)
    parser.add_argument("--refresh", action="store_true")
    arguments = parser.parse_args()
    print(json.dumps(acquire(arguments.output, arguments.refresh)))
