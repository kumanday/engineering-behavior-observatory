"""Inventory explicitly selected study roots by parsed schema and content digest."""
import argparse
import collections
import hashlib
import json
import os
import pathlib

SCHEMAS = {"ebo.behavior-assertion/v1", "ebo.structural-observation-set/v1",
           "ebo.occurrence-ratings/v1", "ebo.semantic-judgment/v1"}
SKIP = {"node_modules", ".git", ".venv", "workspace", "baseline", "repository", "repo",
        "environment", "source", "staging", "__pycache__", "screenshots"}


def inventory(roots):
    counts = collections.Counter()
    unique = collections.defaultdict(set)
    datasets = collections.defaultdict(set)
    parsed = 0
    records = []
    pi = []
    for root in roots:
        for directory, dirs, names in os.walk(root):
            dirs[:] = sorted(name for name in dirs if name not in SKIP)
            for name in sorted(names):
                path = pathlib.Path(directory) / name
                if name == "pi-session.jsonl" and (path.parent / "manifest.json").exists():
                    pi.append(str(path.parent))
                if not name.endswith(".json") or path.stat().st_size > 2 * 1024 * 1024:
                    continue
                parsed += 1
                try:
                    document = json.loads(path.read_bytes())
                except (ValueError, UnicodeError, OSError):
                    continue
                schema = document.get("schemaVersion") if isinstance(document, dict) else None
                if not isinstance(schema, str) or schema not in SCHEMAS:
                    continue
                content_digest = hashlib.sha256(json.dumps(document, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                source = document.get("dataset") or document.get("normalization") or {}
                source = source if isinstance(source, dict) else {}
                dataset_digest = document.get("datasetDigest") or source.get("digest") or source.get("datasetDigest")
                counts[schema] += 1
                unique[schema].add(content_digest)
                if dataset_digest:
                    datasets[schema].add(dataset_digest)
                records.append({"path": str(path), "schemaVersion": schema, "contentDigest": content_digest,
                                "datasetDigest": dataset_digest, "observationSetDigest": document.get("observationSetDigest"),
                                "inputDigest": (document.get("input") or {}).get("digest") if isinstance(document.get("input"), dict) else None})
    return {"scope": [str(root) for root in roots], "completeWorkspaceInventory": False,
            "selection": {"excludedDirectoryNames": sorted(SKIP), "maximumJsonBytes": 2 * 1024 * 1024},
            "jsonFilesParsedOrAttempted": parsed,
            "artifacts": {schema: {"files": count, "uniqueContentDigests": len(unique[schema]),
                                   "uniqueDatasetDigests": len(datasets[schema])} for schema, count in sorted(counts.items())},
            "records": records, "piBundleRoots": sorted(set(pi)),
            "forecast": {"paidJudgingAuthorized": False, "pilotModelCalls": 0,
                         "rejudgeFormula": "affected distinct attempt-dimension-evaluator assertions x measured cost per judgment; reuse unchanged assertions by exact dataset digest"}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=pathlib.Path)
    parser.add_argument("roots", nargs="+", type=pathlib.Path)
    args = parser.parse_args()
    result = inventory(args.roots)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"artifacts": result["artifacts"], "piBundles": len(result["piBundleRoots"])}))
