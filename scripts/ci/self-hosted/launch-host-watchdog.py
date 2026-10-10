"""Launch a Windows host watchdog without allocating a console."""
import argparse
from datetime import datetime
import os
from pathlib import Path
import subprocess
import sys


def run_watchdog(watchdog_path, log_path):
    if os.name != "nt":
        raise RuntimeError("The no-console watchdog launcher requires Windows")
    script = Path(watchdog_path)
    log_path = Path(log_path)
    if not script.is_absolute() or not script.is_file():
        raise ValueError("watchdog-path must name an existing absolute script path")
    if not log_path.is_absolute():
        raise ValueError("log-path must be absolute")
    powershell = Path(os.environ["SystemRoot"]) / (
        "System32/WindowsPowerShell/v1.0/powershell.exe"
    )
    if not powershell.is_file():
        raise FileNotFoundError("Windows PowerShell is unavailable")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    if log_path.exists() and log_path.stat().st_size > 5 * 1024 * 1024:
        os.replace(log_path, log_path.with_suffix(".previous.log"))
    with log_path.open("ab", buffering=0) as log:
        def note(message):
            stamp = datetime.now().isoformat(timespec="seconds")
            log.write(f"\n{stamp} {message}\n".encode("utf-8"))

        try:
            child = subprocess.Popen(
                [str(powershell), "-NoLogo", "-NoProfile", "-NonInteractive",
                 "-ExecutionPolicy", "Bypass", "-File", str(script)],
                cwd=str(script.parent),
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            note(f"watchdog started without console; child_pid={child.pid}")
            code = child.wait()
            note(f"watchdog exited; code={code}")
            return code
        except Exception as error:
            note(f"launcher failed: {type(error).__name__}: {error}")
            return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--watchdog-path", required=True)
    parser.add_argument("--log-path", required=True)
    args = parser.parse_args()
    return run_watchdog(args.watchdog_path, args.log_path)


if __name__ == "__main__":
    sys.exit(main())
