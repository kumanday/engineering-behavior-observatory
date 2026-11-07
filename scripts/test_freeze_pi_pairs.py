"""Pinned-converter regression: frozen trajectories keep their referenced images."""
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest


class PairRetentionTests(unittest.TestCase):
    def test_generated_media_is_retained_and_digest_pinned(self):
        repository = pathlib.Path(__file__).resolve().parent.parent
        rows = [json.loads(line) for line in (repository / "test/fixtures/atif/pi/parallel-failure-cache-write.native.jsonl").read_text().splitlines()]
        user = next(row["message"] for row in rows if row.get("message", {}).get("role") == "user")
        user["content"] = [{"type": "text", "text": "Synthetic image fixture."}, {"type": "image", "mimeType": "image/png",
                            "data": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg=="}]
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source = root / "native"
            source.mkdir()
            manifest = source / "manifest.json"
            manifest.write_text(json.dumps({"run": {"model": {"id": "synthetic-model"}}}))
            session = source / "pi-session.jsonl"
            session.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
            sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
            baseline = root / "baseline.json"
            baseline.write_text(json.dumps({"results": [{"status": "accepted", "datasetDigest": "sha256:fixture", "root": str(source),
                "sessionSha256": sha(session), "manifestSha256": sha(manifest), "measures": {}}]}))
            output = root / "pairs"
            subprocess.run([sys.executable, str(repository / "scripts/freeze-pi-pairs.py"), str(baseline), str(output)], check=True, capture_output=True)
            receipt = json.loads((output / "manifest.json").read_text())["fixtures"][0]
            media = [item for item in receipt["artifacts"] if item["relativePath"].startswith("images/")]
            self.assertEqual(len(media), 1)
            self.assertEqual(sha(output / "fixture" / media[0]["relativePath"]), media[0]["sha256"])
            self.assertFalse((output / "pending.json").exists())
            retry = subprocess.run([sys.executable, str(repository / "scripts/freeze-pi-pairs.py"), str(baseline), str(output)], capture_output=True)
            self.assertNotEqual(retry.returncode, 0)
            self.assertEqual(sha(output / "fixture" / media[0]["relativePath"]), media[0]["sha256"])


if __name__ == "__main__":
    unittest.main()
