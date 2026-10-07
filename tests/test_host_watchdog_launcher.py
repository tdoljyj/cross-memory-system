"""Native Windows regression checks; no WSL, runner, or startup mutations."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1] / "scripts/ci/self-hosted/launch-host-watchdog.py"
SPEC = importlib.util.spec_from_file_location("watchdog_launcher", SOURCE)
LAUNCHER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAUNCHER)


@unittest.skipUnless(os.name == "nt", "Native no-console behavior requires Windows")
class WatchdogLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="watchdog-launcher-")
        self.root = Path(self.temp.name)
        self.script = self.root / "watchdog space & quote'.ps1"
        self.log = self.root / "console-output.log"

    def tearDown(self):
        self.temp.cleanup()

    def test_native_child_has_no_console_and_captures_both_streams_and_exit(self):
        self.script.write_text(
            "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; "
            "public class ConsoleCheck { [DllImport(\"kernel32.dll\")] "
            "public static extern IntPtr GetConsoleWindow(); }'\n"
            "if ([ConsoleCheck]::GetConsoleWindow() -ne [IntPtr]::Zero) { exit 99 }\n"
            "Write-Output 'WATCHDOG_STDOUT'\n"
            "[Console]::Error.WriteLine('WATCHDOG_STDERR')\nexit 7\n",
            encoding="utf-8",
        )
        self.assertEqual(LAUNCHER.run_watchdog(self.script, self.log), 7)
        output = self.log.read_bytes()
        for marker in (b"WATCHDOG_STDOUT", b"WATCHDOG_STDERR", b"child_pid=", b"code=7"):
            self.assertIn(marker, output)

    def test_missing_script_does_not_create_log_or_start_process(self):
        with mock.patch.object(LAUNCHER.subprocess, "Popen") as launch:
            with self.assertRaises(ValueError):
                LAUNCHER.run_watchdog(self.script, self.log)
            launch.assert_not_called()
        self.assertFalse(self.log.exists())

    def test_relative_log_does_not_start_process(self):
        self.script.write_text("exit 0", encoding="utf-8")
        with mock.patch.object(LAUNCHER.subprocess, "Popen") as launch:
            with self.assertRaises(ValueError):
                LAUNCHER.run_watchdog(self.script, Path("relative.log"))
            launch.assert_not_called()

    def test_rotation_preserves_previous_output(self):
        self.script.write_text("exit 0", encoding="utf-8")
        previous = b"x" * (5 * 1024 * 1024 + 1)
        self.log.write_bytes(previous)
        self.assertEqual(LAUNCHER.run_watchdog(self.script, self.log), 0)
        self.assertEqual(self.log.with_suffix(".previous.log").read_bytes(), previous)
        self.assertIn(b"code=0", self.log.read_bytes())

    def test_renderer_refusal_does_not_overwrite_deployed_script(self):
        sentinel = b"# existing deployed watchdog\n"
        self.script.write_bytes(sentinel)
        renderer = SOURCE.with_name("render-host-watchdog.ps1")
        powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        result = LAUNCHER.subprocess.run(
            [str(powershell), "-NoProfile", "-NonInteractive", "-File", str(renderer),
             "-HostId", "company-primary", "-OutputPath", str(self.script), "-InstallStartup"],
            capture_output=True, creationflags=LAUNCHER.subprocess.CREATE_NO_WINDOW,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.script.read_bytes(), sentinel)
        self.assertIn(b"Deployed watchdog differs", result.stderr)

    def test_installer_rejects_console_interpreter_before_mutation(self):
        self.script.write_text("exit 0", encoding="utf-8")
        installer = SOURCE.with_name("install-host-watchdog-launcher.ps1")
        powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        result = LAUNCHER.subprocess.run(
            [str(powershell), "-NoProfile", "-NonInteractive", "-File", str(installer),
             "-HostId", "company-primary", "-WatchdogPath", str(self.script),
             "-PythonwPath", str(Path(os.sys.executable)), "-ValidateOnly"],
            capture_output=True, creationflags=LAUNCHER.subprocess.CREATE_NO_WINDOW,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"PythonwPath must name", result.stderr)

    def test_failed_process_creation_is_logged_and_returns_failure(self):
        self.script.write_text("exit 0", encoding="utf-8")
        with mock.patch.object(LAUNCHER.subprocess, "Popen", side_effect=OSError("fixture failure")):
            self.assertEqual(LAUNCHER.run_watchdog(self.script, self.log), 1)
        self.assertIn(b"launcher failed: OSError", self.log.read_bytes())


if __name__ == "__main__":
    unittest.main()
