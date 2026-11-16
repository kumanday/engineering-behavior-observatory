import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

import acquire
from inventory import inventory


class RetentionInventoryTests(unittest.TestCase):
    def test_nonempty_partial_destination_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source = root / "retained.json"
            source.write_bytes(b"original bytes")
            with self.assertRaisesRegex(ValueError, "incomplete acquisition"):
                acquire.acquire(root)
            self.assertEqual(source.read_bytes(), b"original bytes")

    def test_network_failure_leaves_checkpoint_and_refuses_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary) / "new"
            with patch("acquire.urllib.request.urlopen", side_effect=OSError("synthetic network failure")):
                with self.assertRaises(OSError):
                    acquire.acquire(root)
            self.assertTrue((root / "acquisition.pending.json").is_file())
            with self.assertRaisesRegex(ValueError, "incomplete acquisition"):
                acquire.acquire(root)

    def test_inventory_uses_emitted_rating_and_judgment_schemas(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / "ratings.json").write_text(json.dumps({"schemaVersion": "ebo.occurrence-ratings/v1", "datasetDigest": "sha256:fixture", "observationSetDigest": "sha256:observations"}))
            (root / "judgment.json").write_text(json.dumps({"schemaVersion": "ebo.semantic-judgment/v1", "input": {"digest": "sha256:input"}}))
            result = inventory([root])
            self.assertEqual(result["artifacts"]["ebo.occurrence-ratings/v1"]["files"], 1)
            self.assertEqual(result["artifacts"]["ebo.occurrence-ratings/v1"]["uniqueDatasetDigests"], 1)
            self.assertEqual(result["artifacts"]["ebo.semantic-judgment/v1"]["files"], 1)
            self.assertEqual(next(row for row in result["records"] if row["schemaVersion"] == "ebo.semantic-judgment/v1")["inputDigest"], "sha256:input")


if __name__ == "__main__":
    unittest.main()
