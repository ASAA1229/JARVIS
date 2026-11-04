import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.customer_preupgrade_verifier import VerificationError, verify_release


class CustomerPreUpgradeVerifierTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.extracted = self.root / "extracted"
        self.extracted.mkdir()
        (self.extracted / "app.txt").write_text("customer payload", encoding="utf-8")
        self.artifact = self.root / "release.zip"
        self.artifact.write_bytes(b"archive bytes")
        file_bytes = (self.extracted / "app.txt").read_bytes()
        file_hash = hashlib.sha256(file_bytes).hexdigest()
        artifact_hash = hashlib.sha256(self.artifact.read_bytes()).hexdigest()
        manifest = {
            "schemaVersion": 1, "algorithm": "SHA256", "project": "demo",
            "source": {"gitCommit": "UNKNOWN", "buildNumber": "LOCAL"},
            "fileCount": 1, "files": [{"path": "app.txt", "size": len(file_bytes), "sha256": file_hash}],
            "artifact": {"name": self.artifact.name, "size": self.artifact.stat().st_size, "sha256": artifact_hash},
        }
        self.manifest = self.root / "manifest.json"
        self.manifest.write_text(json.dumps(manifest), encoding="utf-8")
        policy = {
            "schemaVersion": 1, "algorithm": "SHA256", "purpose": "manifest-ignore",
            "project": "demo",
            "manifest": {"name": self.manifest.name, "sha256": hashlib.sha256(self.manifest.read_bytes()).hexdigest()},
            "artifact": {"name": self.artifact.name, "size": self.artifact.stat().st_size, "sha256": artifact_hash},
        }
        self.policy = self.root / "manifest-ignore.json"
        self.policy.write_text(json.dumps(policy), encoding="utf-8")
        self.trusted = hashlib.sha256(self.policy.read_bytes()).hexdigest()

    def tearDown(self):
        self.temp.cleanup()

    def verify(self):
        return verify_release(self.policy, self.manifest, self.artifact, self.extracted, self.trusted)

    def test_valid_release_passes(self):
        result = self.verify()
        self.assertEqual(result["project"], "demo")
        self.assertEqual(result["verified_file_count"], 1)

    def test_tampered_policy_fails_before_json_is_trusted(self):
        self.policy.write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(VerificationError, "independently trusted"):
            self.verify()

    def test_tampered_manifest_fails(self):
        self.manifest.write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(VerificationError, "manifest name or SHA-256"):
            self.verify()

    def test_modified_package_file_fails(self):
        (self.extracted / "app.txt").write_text("modified", encoding="utf-8")
        with self.assertRaisesRegex(VerificationError, "MISMATCH"):
            self.verify()

    def test_unexpected_package_file_fails(self):
        (self.extracted / "extra.txt").write_text("unexpected", encoding="utf-8")
        with self.assertRaisesRegex(VerificationError, "UNEXPECTED"):
            self.verify()

    def test_missing_package_file_fails(self):
        (self.extracted / "app.txt").unlink()
        with self.assertRaisesRegex(VerificationError, "MISSING"):
            self.verify()

    def test_unsafe_manifest_path_fails(self):
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        manifest["files"][0]["path"] = "../outside"
        self.manifest.write_text(json.dumps(manifest), encoding="utf-8")
        policy = json.loads(self.policy.read_text(encoding="utf-8"))
        policy["manifest"]["sha256"] = hashlib.sha256(self.manifest.read_bytes()).hexdigest()
        self.policy.write_text(json.dumps(policy), encoding="utf-8")
        self.trusted = hashlib.sha256(self.policy.read_bytes()).hexdigest()
        with self.assertRaisesRegex(VerificationError, "Unsafe manifest path"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
