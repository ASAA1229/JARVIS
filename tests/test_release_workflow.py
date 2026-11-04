from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.customer_preupgrade_verifier import main as verifier_main
from scripts.customer_preupgrade_verifier import verify_release
from scripts.compatibility_matrix import compare


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ReleaseWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.extracted = self.root / "extracted"
        self.extracted.mkdir()
        (self.extracted / "config.txt").write_text("approved-config\n", encoding="utf-8")
        self.artifact = self.root / "customer-release.zip"
        with zipfile.ZipFile(self.artifact, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(self.extracted / "config.txt", "config.txt")

        file_entry = {
            "path": "config.txt",
            "size": (self.extracted / "config.txt").stat().st_size,
            "sha256": digest(self.extracted / "config.txt"),
        }
        self.manifest = self.root / "release-manifest.json"
        manifest_data = {
            "schemaVersion": 1,
            "algorithm": "SHA256",
            "project": "integration-fixture",
            "source": {"gitCommit": "a" * 40, "buildNumber": "fixture-1"},
            "artifact": {
                "name": self.artifact.name,
                "size": self.artifact.stat().st_size,
                "sha256": digest(self.artifact),
            },
            "fileCount": 1,
            "files": [file_entry],
        }
        self.manifest.write_text(json.dumps(manifest_data), encoding="utf-8")

        self.policy = self.root / "manifest-ignore.json"
        policy_data = {
            "schemaVersion": 1,
            "algorithm": "SHA256",
            "purpose": "manifest-ignore",
            "project": "integration-fixture",
            "manifest": {"name": self.manifest.name, "sha256": digest(self.manifest)},
            "artifact": {
                "name": self.artifact.name,
                "size": self.artifact.stat().st_size,
                "sha256": digest(self.artifact),
            },
        }
        self.policy.write_text(json.dumps(policy_data), encoding="utf-8")
        self.trusted_policy_hash = digest(self.policy)

        self.snapshot = self.root / "snapshot.json"
        self.snapshot.write_text(json.dumps({
            "schema_version": 1,
            "operating_system": "Linux",
            "details": {"kernel": "Linux test-kernel"},
        }), encoding="utf-8")
        self.matrix = self.root / "approved-matrix.json"
        self.matrix.write_text(json.dumps({
            "schema_version": 1,
            "matrix_id": "fixture-approved",
            "matrix_version": "1",
            "checks": [{
                "id": "os-family",
                "field": "operating_system",
                "operator": "one_of",
                "expected": ["Linux"],
            }],
        }), encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def verify(self) -> dict:
        return verify_release(
            self.policy, self.manifest, self.artifact, self.extracted,
            self.trusted_policy_hash,
        )

    def test_release_integrity_stages_pass(self) -> None:
        result = self.verify()
        self.assertEqual(result["project"], "integration-fixture")
        self.assertEqual(result["verified_file_count"], 1)

    def test_tampered_policy_fails_before_policy_is_trusted(self) -> None:
        self.policy.write_text(self.policy.read_text(encoding="utf-8") + " ", encoding="utf-8")
        with self.assertRaisesRegex(Exception, "independently trusted"):
            self.verify()

    def test_tampered_manifest_fails_policy_binding(self) -> None:
        self.manifest.write_text(self.manifest.read_text(encoding="utf-8") + " ", encoding="utf-8")
        with self.assertRaisesRegex(Exception, "manifest name or SHA-256 mismatch"):
            self.verify()

    def test_tampered_artifact_fails_package_binding(self) -> None:
        self.artifact.write_bytes(self.artifact.read_bytes() + b"tamper")
        with self.assertRaisesRegex(Exception, "package name, size, or SHA-256 mismatch"):
            self.verify()

    def test_modified_extracted_file_fails_inventory(self) -> None:
        (self.extracted / "config.txt").write_text("changed\n", encoding="utf-8")
        with self.assertRaisesRegex(Exception, "Stage 3 FAILED"):
            self.verify()

    def test_unexpected_extracted_file_fails_inventory(self) -> None:
        (self.extracted / "unexpected.txt").write_text("extra", encoding="utf-8")
        with self.assertRaisesRegex(Exception, "Stage 3 FAILED"):
            self.verify()

    def test_compatibility_unsupported_is_not_a_release_integrity_failure(self) -> None:
        snapshot = {"operating_system": "AIX"}
        matrix = {
            "schema_version": 1,
            "checks": [{
                "id": "os-family",
                "field": "operating_system",
                "operator": "one_of",
                "expected": ["Linux"],
            }],
        }
        result = compare(snapshot, matrix)
        self.assertEqual(result["overall_status"], "unsupported")

    def test_cli_writes_consolidated_report_and_returns_success(self) -> None:
        report = self.root / "pre-upgrade-report.json"
        code = verifier_main([
            "--manifest-ignore", str(self.policy),
            "--trusted-policy-sha256", self.trusted_policy_hash,
            "--manifest", str(self.manifest),
            "--artifact", str(self.artifact),
            "--extracted-dir", str(self.extracted),
            "--matrix", str(self.matrix),
            "--snapshot", str(self.snapshot),
            "--report", str(report),
        ])
        self.assertEqual(code, 0)
        document = json.loads(report.read_text(encoding="utf-8"))
        self.assertEqual(document["overall_status"], "passed")
        self.assertEqual(document["release"]["verified_file_count"], 1)
        self.assertEqual(document["compatibility"]["overall_status"], "supported")

    def test_cli_returns_two_for_unsupported_compatibility(self) -> None:
        snapshot = json.loads(self.snapshot.read_text(encoding="utf-8"))
        snapshot["operating_system"] = "AIX"
        self.snapshot.write_text(json.dumps(snapshot), encoding="utf-8")
        report = self.root / "unsupported-report.json"
        code = verifier_main([
            "--manifest-ignore", str(self.policy),
            "--trusted-policy-sha256", self.trusted_policy_hash,
            "--manifest", str(self.manifest),
            "--artifact", str(self.artifact),
            "--extracted-dir", str(self.extracted),
            "--matrix", str(self.matrix),
            "--snapshot", str(self.snapshot),
            "--report", str(report),
        ])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(report.read_text(encoding="utf-8"))["overall_status"], "failed")


if __name__ == "__main__":
    unittest.main()
