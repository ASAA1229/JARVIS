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
            self.assertEqual(path, output)
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

    def test_output_must_be_outside_repository(self):
        with self.assertRaises(ValueError):
            build_bundle(ROOT / "bundle.zip")

if __name__ == "__main__":
    unittest.main()
