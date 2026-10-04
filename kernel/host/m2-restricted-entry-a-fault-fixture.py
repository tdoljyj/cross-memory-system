"""Uninstalled trusted-management fixture; never an Agent-selected launcher.

Default entry denies. The one explicit fixture entry creates one bounded child
in the inherited process group. No inputs, files, networking or role changes.
This file is deliberately excluded from the approved A executor package.
"""
import os
import signal
import sys
import time

FIXED_ARG = "--fixed-management-fixture"
SAFETY_CEILING_SECONDS = 10.0  # Harness fail-safe, not a stop acceptance limit.


def run_fixed():
    if sys.platform != "linux" or not hasattr(os, "fork"):
        raise RuntimeError("FIXTURE_PLATFORM_UNAVAILABLE")
    # A leader-only graceful stop must not look like whole-group termination.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    ready_read, ready_write = os.pipe()
    end = time.monotonic() + SAFETY_CEILING_SECONDS
    child = os.fork()
    if child == 0:
        os.close(ready_read)
        os.write(ready_write, b"1")
        os.close(ready_write)
        while time.monotonic() < end:
            time.sleep(0.01)
        os._exit(0)
    os.close(ready_write)
    try:
        if os.read(ready_read, 1) != b"1":
            raise RuntimeError("FIXTURE_CHILD_NOT_READY")
    finally:
        os.close(ready_read)
    print("FIXED_DESCENDANT_READY", flush=True)
    # Child and leader remain live until the supervisor's fault or the safety
    # ceiling. Readiness text alone is not stop evidence; observe /proc identities.
    os.waitpid(child, 0)
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv != [FIXED_ARG]:
        print('{"status":"deny","error_code":"NOT_CONFIGURED","qualification":"NOT_ISSUED"}')
        return 2
    return run_fixed()


if __name__ == "__main__":
    raise SystemExit(main())
