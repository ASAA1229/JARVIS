import unittest

from scripts.compatibility_matrix import MatrixError, compare, validate_matrix


class CompatibilityMatrixTests(unittest.TestCase):
    def setUp(self):
        self.snapshot = {
            "schema_version": 1,
            "operating_system": "Linux",
            "details": {"kernel": "Linux 6.1.0", "runtime": {"python": "3.12"}},
        }

    def test_all_matching_checks_are_supported(self):
        matrix = {
            "schema_version": 1,
            "matrix_id": "customer-approved-example",
            "matrix_version": "1",
            "checks": [
                {"id": "os", "field": "operating_system", "operator": "equals", "expected": "Linux"},
                {"id": "kernel", "field": "details.kernel", "operator": "exists"},
                {"id": "python", "field": "details.runtime.python", "operator": "one_of", "expected": ["3.12", "3.13"]},
            ],
        }
        report = compare(self.snapshot, matrix)
        self.assertEqual(report["overall_status"], "supported")
        self.assertEqual(report["counts"]["supported"], 3)

    def test_mismatch_is_unsupported(self):
        matrix = {
            "schema_version": 1,
            "checks": [{"id": "os", "field": "operating_system", "operator": "equals", "expected": "AIX"}],
        }
        report = compare(self.snapshot, matrix)
        self.assertEqual(report["overall_status"], "unsupported")
        self.assertEqual(report["results"][0]["status"], "unsupported")

    def test_missing_field_is_unavailable_not_unsupported(self):
        matrix = {
            "schema_version": 1,
            "checks": [{"id": "db", "field": "details.database.version", "operator": "exists"}],
        }
        report = compare(self.snapshot, matrix)
        self.assertEqual(report["overall_status"], "incomplete")
        self.assertEqual(report["results"][0]["status"], "unavailable")

    def test_invalid_operator_fails_closed(self):
        with self.assertRaisesRegex(MatrixError, "Unsupported operator"):
            validate_matrix({
                "schema_version": 1,
                "checks": [{"id": "x", "field": "x", "operator": "regex"}],
            })

    def test_duplicate_check_ids_are_rejected(self):
        check = {"id": "same", "field": "os", "operator": "exists"}
        with self.assertRaisesRegex(MatrixError, "Duplicate check id"):
            validate_matrix({"schema_version": 1, "checks": [check, check]})

    def test_empty_expected_list_is_rejected(self):
        with self.assertRaisesRegex(MatrixError, "non-empty expected array"):
            validate_matrix({
                "schema_version": 1,
                "checks": [{"id": "x", "field": "x", "operator": "one_of", "expected": []}],
            })


if __name__ == "__main__":
    unittest.main()
