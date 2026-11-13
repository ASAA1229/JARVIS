import tempfile
import unittest
import zipfile
from pathlib import Path
from scripts.build_customer_bundle import FILES, ROOT, build_bundle

class CustomerBundleTests(unittest.TestCase):
    def test_bundle_contains_allowlisted_files(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "bundle.zip"
            path, digest = build_bundle(output)
            self.assertEqual(path, output.resolve())
            self.assertEqual(len(digest), 64)
            with zipfile.ZipFile(path) as archive:
                self.assertEqual(set(archive.namelist()), set(FILES) | {"README-CUSTOMER.md"})

    def test_no_overwrite_by_default(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "bundle.zip"
            output.write_bytes(b"existing")
            with self.assertRaises(FileExistsError):
                build_bundle(output)
            self.assertEqual(output.read_bytes(), b"existing")

    def test_existing_checksum_sidecar_is_checked_before_bundle_creation(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "bundle.zip"
            sidecar = output.with_name(output.name + ".sha256")
            sidecar.write_text("trusted-existing-checksum\\n", encoding="utf-8")
            with self.assertRaises(SystemExit) as raised:
                main(["--output", str(output)])
            self.assertEqual(raised.exception.code, 1)
            self.assertFalse(output.exists())
            self.assertEqual(sidecar.read_text(encoding="utf-8"), "trusted-existing-checksum\\n")

    def test_force_replaces_bundle_and_checksum_together(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "bundle.zip"
            sidecar = output.with_name(output.name + ".sha256")
            output.write_bytes(b"old bundle")
            sidecar.write_text("old checksum\\n", encoding="utf-8")
            self.assertEqual(main(["--output", str(output), "--force"]), 0)
            self.assertEqual(sidecar.read_text(encoding="utf-8"), f"{__import__('hashlib').sha256(output.read_bytes()).hexdigest()}  {output.name}\\n")
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(set(archive.namelist()), set(FILES) | {"README-CUSTOMER.md"})

    def test_output_must_not_be_a_symlink(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "target.zip"
            target.write_bytes(b"keep")
            link = Path(folder) / "bundle.zip"
            try:
                link.symlink_to(target)
            except (OSError, NotImplementedError):
                self.skipTest("Symlink creation is unavailable on this platform")
            with self.assertRaises(ValueError):
                build_bundle(link)
            self.assertEqual(target.read_bytes(), b"keep")

    def test_output_must_be_outside_repository(self):
        with self.assertRaises(ValueError):
            build_bundle(ROOT / "bundle.zip")

if __name__ == "__main__":
    unittest.main()
