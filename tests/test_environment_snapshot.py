import unittest
from unittest.mock import patch

from scripts.environment_snapshot import (
    AIX_COMMANDS,
    LINUX_COMMANDS,
    SnapshotError,
    collect_snapshot,
)


class EnvironmentSnapshotTests(unittest.TestCase):
    def test_linux_uses_only_linux_command_set(self):
        calls = []
        def runner(command):
            calls.append(tuple(command))
            return "sample"
        result = collect_snapshot("Linux", runner)
        self.assertEqual(result["operating_system"], "Linux")
        self.assertEqual(set(result["details"]), set(LINUX_COMMANDS))
        self.assertEqual(set(calls), set(LINUX_COMMANDS.values()))

    def test_aix_uses_only_aix_command_set(self):
        calls = []
        def runner(command):
            calls.append(tuple(command))
            return "sample"
        result = collect_snapshot("AIX", runner)
        self.assertEqual(result["operating_system"], "AIX")
        self.assertEqual(set(result["details"]), set(AIX_COMMANDS))
        self.assertEqual(set(calls), set(AIX_COMMANDS.values()))

    def test_unsupported_os_exits_before_running_commands(self):
        def runner(_command):
            self.fail("No command should run on an unsupported OS")
        with self.assertRaisesRegex(SnapshotError, "Unsupported operating system"):
            collect_snapshot("Windows", runner)

    def test_command_failure_prevents_partial_snapshot(self):
        calls = 0
        def runner(_command):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise SnapshotError("simulated failure")
            return "sample"
        with self.assertRaisesRegex(SnapshotError, "simulated failure"):
            collect_snapshot("Linux", runner)

    def test_sensitive_and_hardware_data_are_out_of_scope(self):
        result = collect_snapshot("Linux", lambda _command: "sample")
        excluded = result["scope"]["excluded"]
        self.assertIn("hardware inventory", excluded)
        self.assertIn("storage and filesystem inventory", excluded)
        self.assertNotIn("environment_variables", result["details"])


if __name__ == "__main__":
    unittest.main()
