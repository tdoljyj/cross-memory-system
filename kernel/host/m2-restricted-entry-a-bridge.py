"""Foreground trusted-management bridge. Never a complete restricted Agent Host.

No listener, registry write, service, credentials, wildcard VM or default connect.
"""
import hashlib
import json
import os
from pathlib import Path
import socket
import sys

VM_ID = "9d775385-4546-4450-a77f-08cdf4f696b6"
SERVICE_ID = "0000ac45-facb-11e6-bd58-64006a7986d3"
PROFILE = Path(r"C:\Clued\M2Isolation\host-a\profile.json")
TOOLS = ("m2_read_input", "m2_write_output", "m2_run_empty_probe")
MAX_FRAME = 98304


def unique(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate key")
        obj[key] = value
    return obj


def connect_installed():
    if sys.platform != "win32" or not hasattr(socket, "AF_HYPERV") or not PROFILE.is_file() or PROFILE.is_symlink():
        raise ValueError("NOT_CONFIGURED")
    config = json.loads(PROFILE.read_bytes(), object_pairs_hook=unique)
    if set(config) != {"schema", "vm_id", "service_id", "bridge_sha256"} or config["schema"] != "m2-a-bridge-v1" or config["vm_id"] != VM_ID or config["service_id"] != SERVICE_ID:
        raise ValueError("PROFILE_INVALID")
    if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != config["bridge_sha256"]:
        raise ValueError("PROFILE_INVALID")
    # Installation review must verify Windows ACLs on profile/code/parents:
    # SYSTEM/Administrators write, trusted Owner read/run. CID/port are not auth.
    conn = socket.socket(socket.AF_HYPERV, socket.SOCK_STREAM, socket.HV_PROTOCOL_RAW)
    try:
        conn.settimeout(1.2)
        conn.connect((VM_ID, SERVICE_ID))
        return conn
    except BaseException:
        conn.close()
        raise


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv == ["--list-tools"]:
        print(json.dumps({"tools": list(TOOLS), "qualification": "NOT_ISSUED"}))
        return 0
    if argv != ["--connect-installed-a"]:
        print(json.dumps({"status": "deny", "error_code": "NOT_CONFIGURED", "qualification": "NOT_ISSUED"}))
        return 2
    conn = None
    try:
        conn = connect_installed()
        response = conn.makefile("rb")
        with response:
            while True:
                frame = sys.stdin.buffer.readline(MAX_FRAME + 1)
                if not frame:
                    break
                if len(frame) > MAX_FRAME or not frame.endswith(b"\n"):
                    raise ValueError("FRAME_INVALID")
                obj = json.loads(frame, object_pairs_hook=unique)
                if type(obj) is not dict or set(obj) != {"tool", "arguments"} or obj["tool"] not in TOOLS:
                    raise ValueError("TOOL_NOT_ALLOWED")
                conn.sendall(frame)
                data = response.readline(MAX_FRAME + 1)
                if not data or len(data) > MAX_FRAME or not data.endswith(b"\n"):
                    raise ValueError("RESPONSE_INVALID")
                result = json.loads(data, object_pairs_hook=unique)
                if type(result) is not dict or result.get("qualification") != "NOT_ISSUED":
                    raise ValueError("RESPONSE_INVALID")
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
    except (KeyboardInterrupt, Exception):
        print(json.dumps({"status": "deny", "error_code": "TRANSPORT_UNAVAILABLE", "execution_state": "UNKNOWN", "qualification": "NOT_ISSUED"}))
        return 2
    finally:
        # EOF/interrupt closes the connection, causing guest revoke/cgroup stop.
        # A transport loss can never itself assert guest STOPPED.
        if conn is not None:
            conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
