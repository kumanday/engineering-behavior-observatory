"""Offline fidelity inspection using pinned Harbor and atif-scan. No model calls."""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import shutil
from importlib.metadata import version

from atif_scan.data.loader import load_trace
from harbor.agents.installed.pi import Pi
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import Trajectory


def read(path: pathlib.Path):
    return json.loads(path.read_bytes())


def rows(path: pathlib.Path):
    for line in path.read_bytes().splitlines():
        if line.strip():
            yield json.loads(line)


def native_calls(root: pathlib.Path, harness: str) -> dict:
    calls, results = {}, set()
    if harness in ("pi", "openclaw"):
        files = list((root / "agent/pi/sessions").glob("*.jsonl")) if harness == "pi" else list((root / "agent").glob("openclaw-session.jsonl"))
        for path in files:
            for event in rows(path):
                message = event.get("message") or {}
                if not isinstance(message, dict):
                    continue
                for content in message.get("content") or []:
                    if isinstance(content, dict) and content.get("type") == "toolCall":
                        calls[content["id"]] = content.get("name")
                if message.get("role") == "toolResult":
                    results.add(message.get("toolCallId"))
    elif harness == "codex":
        files = list((root / "agent/sessions").rglob("rollout-*.jsonl"))
        for path in files:
            for event in rows(path):
                payload = event.get("payload") or {}
                if event.get("type") == "response_item" and payload.get("type") in ("function_call", "custom_tool_call"):
                    calls[payload["call_id"]] = payload.get("name")
                if event.get("type") == "response_item" and payload.get("type") in ("function_call_output", "custom_tool_call_output"):
                    results.add(payload.get("call_id"))
    else:
        return {"status": "unsupported", "reason": "NATIVE_READER_NOT_IMPLEMENTED_IN_PILOT"}
    return {"status": "known" if files else "unavailable", "files": len(files), "callIds": sorted(calls),
            "resultIds": sorted(x for x in results if x), "pendingIds": sorted(set(calls) - results)}


def inspect_document(path: pathlib.Path, root: pathlib.Path | None = None, harness: str | None = None) -> dict:
    document = read(path)
    try:
        Trajectory.model_validate(document)
        structural = "pass"
    except Exception as error:
        structural = type(error).__name__
    schema = document.get("schema_version", "")
    minor = int(schema.rsplit(".", 1)[-1]) if schema.startswith("ATIF-v1.") else -1
    violations = []
    if minor not in range(2, 9):
        violations.append("UNSUPPORTED_ATIF_VERSION")
    step_summaries, atif_calls, linked_results = [], {}, set()
    declared, missing_declared = 0, 0
    copied = gaps = 0
    totals = {"prompt_tokens": 0, "completion_tokens": 0, "cached_tokens": 0, "cache_write_tokens": 0}
    usage_coverage = {key: {"reported": 0, "missing": 0} for key in totals}
    field_coverage = {"is_error": 0, "tool_result_is_error": 0, "tool_use_is_error": 0, "codex_status": 0}

    def visit(doc: dict, pointer: str = ""):
        nonlocal declared, missing_declared, copied, gaps
        for index, step in enumerate(doc.get("steps", [])):
            location = pointer + f"/steps/{index}"
            extra = step.get("extra") or {}
            if step.get("is_copied_context"):
                copied += 1
                continue
            if extra.get("added_by") == "hlb":
                gaps += 1
                continue
            if minor < 7 and "llm_call_count" in step:
                violations.append("VERSION_LABEL_INCONSISTENT:llm_call_count")
            if step.get("source") == "agent":
                count = step.get("llm_call_count") if minor >= 7 else None
                if count is None:
                    missing_declared += 1
                else:
                    declared += count
            for call in step.get("tool_calls") or []:
                atif_calls[(pointer, call["tool_call_id"])] = call.get("function_name")
                if "tool_use_is_error" in (call.get("extra") or {}):
                    field_coverage["tool_use_is_error"] += 1
                if "status" in (extra.get("tool_call_details") or {}).get(call["tool_call_id"], {}):
                    field_coverage["codex_status"] += 1
            for result in (step.get("observation") or {}).get("results", []):
                if result.get("source_call_id"):
                    linked_results.add((pointer, result["source_call_id"]))
                for key in ("is_error", "tool_result_is_error"):
                    if key in (result.get("extra") or {}):
                        field_coverage[key] += 1
            metrics = step.get("metrics") or {}
            for key in totals:
                value = metrics.get(key) if key != "cache_write_tokens" else (metrics.get("extra") or {}).get(key)
                if pointer == "" and step.get("source") == "agent":
                    if isinstance(value, (int, float)) and not isinstance(value, bool):
                        totals[key] += value
                        usage_coverage[key]["reported"] += 1
                    else:
                        usage_coverage[key]["missing"] += 1
            step_summaries.append({"pointer": "#" + location, "stepId": step.get("step_id"), "calls": len(step.get("tool_calls") or []),
                                   "source": step.get("source"), "llmCallCount": step.get("llm_call_count"), "context": extra.get("context_management")})
        for index, child in enumerate(doc.get("subagent_trajectories") or []):
            visit(child, pointer + f"/subagent_trajectories/{index}")

    visit(document)
    totals = {key: value if usage_coverage[key]["reported"] and not usage_coverage[key]["missing"] else None
              for key, value in totals.items()}
    trace = load_trace(path)
    scanner_calls = sum(len(step.calls) for step in trace.steps if not step.copied)
    root_steps = document.get("steps") or []
    root_calls = sum(len(step.get("tool_calls") or []) for step in root_steps if not step.get("is_copied_context"))
    final = document.get("final_metrics") or {}
    native = native_calls(root, harness) if root and harness else {"status": "not-checked"}
    atif_ids = {call_id for _, call_id in atif_calls}
    absent = sorted(set(native.get("callIds", [])) - atif_ids)
    references = []

    def find_references(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in ("trajectory_path", "continued_trajectory_ref") or key == "path" and "media_type" in value and isinstance(child, str):
                    text = str(child)
                    safe = not ("://" in text or pathlib.PurePosixPath(text).is_absolute() or ".." in pathlib.PurePosixPath(text).parts)
                    exists = safe and (path.parent / text).is_file() and not (path.parent / text).is_symlink()
                    references.append({"kind": key, "status": "retained" if exists else "unavailable", "reason": None if exists else "EXTERNAL_REFERENCE_NOT_RETAINED"})
                else:
                    find_references(child)
        elif isinstance(value, list):
            for child in value:
                find_references(child)

    find_references(document)
    limitations = ["EVENT_LOG_COMPLETENESS_UNPROVEN", "THIRD_PARTY_CONVERTED_SOURCE"]
    if absent:
        limitations.append("NATIVE_CALLS_MISSING_FROM_ATIF")
    if gaps or (document.get("extra") or {}).get("partial"):
        limitations.append("PRODUCER_PARTIAL_HISTORY")
    if missing_declared:
        limitations.append("DECLARED_INFERENCE_COUNT_UNAVAILABLE")
    if any(x["status"] == "unavailable" for x in references):
        limitations.append("EXTERNAL_REFERENCE_NOT_RETAINED")
    return {"schema": schema, "agent": {k: document.get("agent", {}).get(k) for k in ("name", "version")},
            "qualification": "imported", "structuralGate": structural, "versionPolicyViolations": sorted(set(violations)),
            "rootSteps": len(root_steps), "recordedToolCalls": len(atif_calls), "linkedResults": len(linked_results),
            "declaredInferenceCount": None if missing_declared or gaps or (document.get("extra") or {}).get("partial") else declared, "untrackedInferenceSteps": missing_declared,
            "copiedSteps": copied, "gapSteps": gaps, "steps": step_summaries, "errorFieldCoverage": field_coverage,
            "rootStepUsage": totals, "rootStepUsageCoverage": usage_coverage,
            "finalUsage": {k: final.get(k) for k in ("total_prompt_tokens", "total_completion_tokens", "total_cached_tokens")},
            "rootUsageDeltas": {key: final.get("total_" + key) - totals[key] if totals[key] is not None else None
                                for key in ("prompt_tokens", "completion_tokens", "cached_tokens") if isinstance(final.get("total_" + key), (int, float))},
            "scanner": {"version": version("atif-scan"), "rootRecordedCalls": scanner_calls, "rootCallAgreement": scanner_calls == root_calls},
            "native": {k: v for k, v in native.items() if k not in ("callIds", "resultIds", "pendingIds")},
            "nativeCallCount": len(native["callIds"]) if native["status"] == "known" else None,
            "pendingNativeCalls": len(native["pendingIds"]) if native["status"] == "known" else None,
            "nativeCallsMissingFromAtif": len(absent) if native["status"] == "known" else None, "references": references, "limitations": limitations}


def convert_pair(bundle: pathlib.Path, output: pathlib.Path) -> dict:
    manifest = read(bundle / "manifest.json")
    digests = []
    for suffix in ("a", "b"):
        logs = output / suffix
        sessions = logs / "pi/sessions"
        sessions.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(bundle / "pi-session.jsonl", sessions / "session.jsonl")
        agent = Pi(logs_dir=logs, model_name=manifest["run"]["model"]["id"])
        agent.populate_context_post_run(AgentContext())
        digests.append(hashlib.sha256((logs / "trajectory.json").read_bytes()).hexdigest())
    return {"bundleRoot": str(bundle), "sourceManifestSha256": hashlib.sha256((bundle / "manifest.json").read_bytes()).hexdigest(),
            "sourceSessionSha256": hashlib.sha256((bundle / "pi-session.jsonl").read_bytes()).hexdigest(),
            "converter": "harbor.agents.installed.pi.Pi.populate_context_post_run", "harborVersion": version("harbor"),
            "trajectorySha256": digests[0], "deterministic": digests[0] == digests[1]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sample", type=pathlib.Path)
    parser.add_argument("--pair", action="append", default=[])
    args = parser.parse_args()
    result = {"harborVersion": version("harbor"), "atifScanVersion": version("atif-scan"), "public": {}, "pairs": []}
    for path in sorted((args.sample / "sources").glob("*/agent/trajectory.json")):
        name = path.parents[1].name
        result["public"][name] = inspect_document(path, path.parents[1], "codex" if name.startswith("codex") else name)
    for index, source in enumerate(args.pair):
        output = args.sample / "paired" / f"pair-{index}"
        pair = convert_pair(pathlib.Path(source), output)
        pair["inspection"] = inspect_document(output / "a/trajectory.json")
        result["pairs"].append(pair)
    (args.sample / "inspection.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"public": {k: {f: v[f] for f in ("schema", "structuralGate", "recordedToolCalls", "nativeCallCount", "nativeCallsMissingFromAtif")} for k, v in result["public"].items()},
                      "pairs": [{"deterministic": p["deterministic"], "calls": p["inspection"]["recordedToolCalls"]} for p in result["pairs"]]}))
