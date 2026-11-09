import json
import pathlib
import tempfile
import unittest

from inspect_sample import inspect_document


class InspectionTests(unittest.TestCase):
    def inspect(self, value):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "trajectory.json"
            path.write_text(json.dumps(value))
            return inspect_document(path)

    def fixture(self):
        return {"schema_version": "ATIF-v1.7", "agent": {"name": "pi", "version": "synthetic"},
                "steps": [{"step_id": 1, "source": "agent", "message": "done", "llm_call_count": 1}]}

    def test_version_label_is_checked_separately_from_structural_validation(self):
        document = self.fixture()
        document["schema_version"] = "ATIF-v1.2"
        result = self.inspect(document)
        self.assertEqual(result["structuralGate"], "pass")
        self.assertIn("VERSION_LABEL_INCONSISTENT:llm_call_count", result["versionPolicyViolations"])

    def test_partial_history_never_establishes_zero_inferences(self):
        document = self.fixture()
        document["extra"] = {"partial": {"missing": ["tool_calls"]}}
        result = self.inspect(document)
        self.assertIsNone(result["declaredInferenceCount"])
        self.assertIn("PRODUCER_PARTIAL_HISTORY", result["limitations"])

    def test_missing_usage_and_final_delta_stay_unavailable(self):
        document = self.fixture()
        document["final_metrics"] = {"total_prompt_tokens": 100}
        result = self.inspect(document)
        self.assertIsNone(result["rootStepUsage"]["prompt_tokens"])
        self.assertIsNone(result["rootUsageDeltas"]["prompt_tokens"])
        self.assertEqual(result["rootStepUsageCoverage"]["prompt_tokens"], {"reported": 0, "missing": 1})
        document["steps"][0]["metrics"] = {"prompt_tokens": 0}
        self.assertEqual(self.inspect(document)["rootStepUsage"]["prompt_tokens"], 0)
        document["steps"].append({"step_id": 2, "source": "agent", "message": "Missing usage."})
        self.assertIsNone(self.inspect(document)["rootStepUsage"]["prompt_tokens"])

    def test_tool_argument_paths_are_not_media_dependencies(self):
        document = self.fixture()
        document["steps"][0]["tool_calls"] = [{"tool_call_id": "a", "function_name": "read", "arguments": {"path": "/app/main.ts"}}]
        self.assertEqual(self.inspect(document)["references"], [])

    def test_external_media_is_unavailable_without_network_resolution(self):
        document = self.fixture()
        document["steps"][0]["message"] = [{"type": "image", "source": {"media_type": "image/png", "path": "../secret.png"}}]
        result = self.inspect(document)
        self.assertEqual(result["references"][0]["status"], "unavailable")
        self.assertIn("EXTERNAL_REFERENCE_NOT_RETAINED", result["limitations"])


if __name__ == "__main__":
    unittest.main()
