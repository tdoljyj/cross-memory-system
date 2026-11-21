"""A-only empty executor candidate. No default installation or activation.

The Windows caller is trusted management, not a restricted Agent Host. Production
startup is a separate root-owned installation operation, never a tool argument.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import socket
import stat
import subprocess
import sys
import threading
import time

TOOLS = ("m2_read_input", "m2_write_output", "m2_run_empty_probe")
INSTALL = Path("/usr/local/lib/clued-m2-a")
PROFILE = Path("/etc/clued-m2-a/profile.json")
LEDGER = Path("/var/lib/clued-m2-a/ledger.sqlite")
CGROUP = Path("/sys/fs/cgroup/clued-m2-a")
PORT = 44101
MAX_FRAME = 98304
MAX_BYTES = 65536
TIMEOUT = 1.0
LEASE = 60.0
STOP_TIMEOUT = 0.1
VM_ID = "9d775385-4546-4450-a77f-08cdf4f696b6"
SERVICE_ID = "0000ac45-facb-11e6-bd58-64006a7986d3"


class Rejected(Exception):
    pass


def denied(code, state=None):
    result = {"status": "deny", "error_code": code, "qualification": "NOT_ISSUED"}
    if state:
        result["execution_state"] = state
    return result


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Rejected("DUPLICATE_KEY")
        result[key] = value
    return result


def decode_frame(data):
    if len(data) > MAX_FRAME or not data.endswith(b"\n"):
        raise Rejected("FRAME_INVALID")
    try:
        obj = json.loads(data, object_pairs_hook=_pairs, parse_constant=lambda _: (_ for _ in ()).throw(Rejected("FRAME_INVALID")))
    except (ValueError, UnicodeError, RecursionError):
        raise Rejected("FRAME_INVALID") from None
    if type(obj) is not dict or set(obj) != {"tool", "arguments"}:
        raise Rejected("REQUEST_INVALID")
    return obj


def encode_frame(obj):
    data = json.dumps(obj, ensure_ascii=True, separators=(",", ":")).encode("ascii") + b"\n"
    if len(data) > MAX_FRAME:
        raise Rejected("FRAME_TOO_LARGE")
    return data


def protected(path, mode, directory=False):
    """Fixed installed paths only; every ancestor is root-owned/non-writable."""
    path = Path(path)
    for parent in reversed(path.parents):
        s = parent.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022:
            raise Rejected("INSTALL_PROFILE_INVALID")
    s = path.lstat()
    expected = stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink == 1
    if not expected or s.st_uid != 0 or stat.S_IMODE(s.st_mode) != mode:
        raise Rejected("INSTALL_PROFILE_INVALID")
    return s.st_dev, s.st_ino


def load_boundary(path):
    spec = importlib.util.spec_from_file_location("m2_boundary", path)
    module = importlib.util.module_from_spec(spec)
    # Execute the verified source directly: never read or create bytecode caches
    # in the root-owned fixed installation directory.
    exec(compile(Path(path).read_bytes(), str(path), "exec"), module.__dict__)
    return module


class Executor:
    """Three operations only; injected test dependencies are not qualification."""
    def __init__(self, ledger=None, runner=None, instance=None, frozen=None, clock=time.monotonic):
        self.ledger, self.runner, self.instance = ledger, runner, instance
        self.frozen = dict(frozen or {})
        self.clock, self.started = clock, clock()
        self.revoked = False
        self.lock = threading.Lock()

    def list_tools(self):
        return list(TOOLS)

    def revoke(self):
        self.revoked = True
        if self.runner is None:
            return {"execution_state": "UNKNOWN"}
        before = self.clock()
        try:
            proof = self.runner.stop(STOP_TIMEOUT)
        except Exception:
            proof = {}
        confirmed = (self.clock() - before < STOP_TIMEOUT and type(proof) is dict and
                     proof.get("scope") == "entire_cgroup" and proof.get("cgroup_empty") is True and
                     proof.get("leader_reaped") is True and proof.get("identity_unchanged") is True)
        return {"execution_state": "STOPPED" if confirmed else "UNKNOWN"}

    def call(self, tool, arguments, disconnected=lambda: False):
        if tool not in TOOLS:
            return denied("TOOL_NOT_ALLOWED")
        keys = {"request_id"} if tool == TOOLS[2] else {"request_id", "path"}
        if tool == TOOLS[1]:
            keys.add("content_b64")
        if type(arguments) is not dict or set(arguments) != keys or any(type(v) is not str for v in arguments.values()) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", arguments["request_id"]):
            return denied("REQUEST_INVALID")
        arguments = dict(arguments)
        if self.revoked or self.clock() - self.started >= LEASE:
            self.revoke()
            return denied("ENTRY_REVOKED_OR_EXPIRED")
        if self.ledger is None or self.runner is None:
            return denied("NOT_CONFIGURED")
        if not self.lock.acquire(blocking=False):
            return denied("ENTRY_BUSY")
        try:
            # Root-private installed ledger persists instance/request IDs. Failed
            # operations with a valid shape burn their ID before any native work.
            self.ledger.burn(self.instance, arguments["request_id"])
            payload = {}
            if tool != TOOLS[2]:
                name = arguments["path"]
                if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", name) or name in (".", ".."):
                    return denied("PATH_INVALID")
                payload["path"] = name
            if tool == TOOLS[0]:
                if arguments["path"] not in self.frozen:
                    return denied("INPUT_NOT_FROZEN")
                payload["digest"] = self.frozen[arguments["path"]]
            if tool == TOOLS[1]:
                try:
                    data = base64.b64decode(arguments["content_b64"], validate=True)
                except ValueError:
                    return denied("CONTENT_INVALID")
                if len(data) > MAX_BYTES:
                    return denied("CONTENT_TOO_LARGE")
                payload["content_b64"] = arguments["content_b64"]
            deadline = min(self.started + LEASE, self.clock() + TIMEOUT)
            payload["deadline"] = deadline
            if self.revoked or disconnected() or self.clock() >= deadline:
                raise TimeoutError()
            result = self.runner.run(tool, payload, deadline, lambda: self.revoked or disconnected())
            if self.revoked or disconnected() or self.clock() >= deadline:
                raise TimeoutError()
            return {"status": "ok", "result": result, "qualification": "NOT_ISSUED"}
        except TimeoutError:
            state = self.revoke()["execution_state"]
            return denied("ENTRY_INTERRUPTED" if state == "STOPPED" else "EXECUTION_STOP_UNCONFIRMED", state)
        except Exception as error:
            if str(error) in ("REPLAY_REJECTED", "ENTRY_REQUEST_LIMIT"):
                return denied(str(error))
            state = self.revoke()["execution_state"]
            return denied("OPERATION_REJECTED", state)
        finally:
            self.lock.release()


class CgroupRunner:
    """Real Linux backend. It never creates cgroups, installs or changes policy.

    The separately approved installer prepares the one root-private v2 cgroup.
    Foreground single-threaded supervisor only: Python preexec_fn is not safe
    in a threaded process. All commands are immutable installed literals.
    """
    def __init__(self, binding):
        import pwd
        if sys.platform != "linux" or os.geteuid() != 0:
            raise Rejected("INSTALL_PROFILE_INVALID")
        account = pwd.getpwnam("m2-a")
        if account.pw_uid == 0 or account.pw_gid == 0:
            raise Rejected("IDENTITY_INVALID")
        self.uid, self.gid = account.pw_uid, account.pw_gid
        if set(binding) != {"uid", "gid", "input", "output"} or binding["uid"] != self.uid or binding["gid"] != self.gid:
            raise Rejected("IDENTITY_DRIFT")
        self.binding = dict(binding)
        self.identity = protected(CGROUP, 0o700, True)
        for name, expected in (("memory.max", "67108864"), ("pids.max", "8"), ("cpu.max", "20000 100000")):
            if (CGROUP / name).read_text().strip() != expected:
                raise Rejected("CGROUP_PROFILE_INVALID")
        if not (CGROUP / "cgroup.kill").is_file() or not self.empty():
            raise Rejected("CGROUP_PROFILE_INVALID")
        self.process = None
        self.cancelled = False

    def empty(self):
        if protected(CGROUP, 0o700, True) != self.identity:
            raise Rejected("CGROUP_IDENTITY_DRIFT")
        fields = dict(line.split() for line in (CGROUP / "cgroup.events").read_text().splitlines())
        return fields.get("populated") == "0"

    def command(self, tool):
        if tool == TOOLS[2]:
            return ("/usr/bin/python3", "-I", "-S", (INSTALL / "empty_probe.py").as_posix())
        if tool in TOOLS[:2]:
            mode = "--worker-read" if tool == TOOLS[0] else "--worker-write"
            return ("/usr/bin/python3", "-I", "-S", (INSTALL / "executor.py").as_posix(), mode)
        raise Rejected("TOOL_NOT_ALLOWED")

    def run(self, tool, payload, deadline, interrupted):
        import resource
        if threading.active_count() != 1 or self.cancelled or interrupted() or not self.empty():
            raise Rejected("EXECUTOR_NOT_READY")
        if tool in TOOLS[:2]:
            root = "/srv/clued-m2/probe/a-input" if tool == TOOLS[0] else "/srv/clued-m2/probe/a-work"
            kind = "input" if tool == TOOLS[0] else "output"
            s = os.stat(root, follow_symlinks=False)
            if [s.st_dev, s.st_ino] != self.binding[kind]:
                raise Rejected("ROOT_IDENTITY_DRIFT")
            payload = {**payload, "root_identity": self.binding[kind]}
        group_fd = os.open(CGROUP / "cgroup.procs", os.O_WRONLY | os.O_NOFOLLOW)
        def enter():
            # Attach before dropping root; no managed FD reaches the role worker.
            os.write(group_fd, str(os.getpid()).encode("ascii"))
            os.close(group_fd)
            os.setgroups([])
            os.setgid(self.gid)
            os.setuid(self.uid)
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            resource.setrlimit(resource.RLIMIT_CPU, (1, 1))
            resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
        try:
            self.process = subprocess.Popen(self.command(tool), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=subprocess.PIPE, env={}, cwd="/", close_fds=True,
                                            pass_fds=(group_fd,), start_new_session=True, preexec_fn=enter)
        finally:
            os.close(group_fd)
        data = b"" if tool == TOOLS[2] else json.dumps(payload).encode("utf-8")
        # communicate's retry does not resend stdin. Only pinned, bounded-output
        # worker code is admitted; role content is never executable.
        initial = True
        while True:
            if interrupted() or time.monotonic() >= deadline:
                raise TimeoutError()
            try:
                out, err = self.process.communicate(data if initial else None, timeout=min(0.02, deadline - time.monotonic()))
                break
            except subprocess.TimeoutExpired:
                initial = False
        if self.process.returncode != 0 or len(out) > MAX_FRAME or len(err) > 8192 or not self.empty():
            raise Rejected("WORKER_FAILED")
        if tool == TOOLS[2]:
            if out != b"EMPTY_MARKER_OK\n":
                raise Rejected("PROBE_FAILED")
            return "EMPTY_MARKER_OK"
        result = json.loads(out, object_pairs_hook=_pairs)
        if type(result) is not dict or result.get("status") != "ok":
            raise Rejected("IO_FAILED")
        return result

    def stop(self, timeout):
        self.cancelled = True
        end = time.monotonic() + timeout
        try:
            if protected(CGROUP, 0o700, True) != self.identity:
                return {}
            (CGROUP / "cgroup.kill").write_text("1")
            while time.monotonic() < end:
                reaped = self.process is None or self.process.poll() is not None
                if self.empty() and reaped:
                    if self.process is not None:
                        self.process.wait(timeout=0)
                    return {"scope": "entire_cgroup", "cgroup_empty": True, "leader_reaped": True, "identity_unchanged": True}
                time.sleep(0.001)
        except (OSError, ValueError, Rejected, subprocess.TimeoutExpired):
            pass
        return {}


def installed_executor():
    if sys.platform != "linux" or os.geteuid() != 0:
        raise Rejected("NOT_CONFIGURED")
    protected(PROFILE, 0o600)
    config = json.loads(PROFILE.read_bytes(), object_pairs_hook=_pairs)
    if set(config) != {"schema", "instance", "frozen_inputs", "files", "binding"} or config["schema"] != "m2-a-installed-v1":
        raise Rejected("INSTALL_PROFILE_INVALID")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", config["instance"]) or not config["frozen_inputs"]:
        raise Rejected("INSTALL_PROFILE_INVALID")
    for name, digest in config["frozen_inputs"].items():
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", name) or name in (".", "..") or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise Rejected("INSTALL_PROFILE_INVALID")
    if config["frozen_inputs"] != {"marker.txt": hashlib.sha256(b"PUBLIC_EMPTY_PROBE_INPUT:a-input\n").hexdigest()}:
        raise Rejected("INPUT_NOT_FROZEN")
    if set(config["files"]) != {"executor.py", "boundary.py", "empty_probe.py"}:
        raise Rejected("INSTALL_PROFILE_INVALID")
    for name, digest in config["files"].items():
        protected(INSTALL / name, 0o555)
        if hashlib.sha256((INSTALL / name).read_bytes()).hexdigest() != digest:
            raise Rejected("INSTALL_PROFILE_INVALID")
    protected(LEDGER.parent, 0o700, True)
    protected(LEDGER, 0o600)
    boundary = load_boundary(INSTALL / "boundary.py")
    ledger = boundary.ReplayLedger(LEDGER)
    try:
        return Executor(ledger, CgroupRunner(config["binding"]), config["instance"], config["frozen_inputs"])
    except BaseException:
        ledger.close()
        raise


def worker(read):
    import pwd
    account = pwd.getpwnam("m2-a")
    if os.geteuid() != account.pw_uid or os.getegid() != account.pw_gid or set(os.getgroups()) - {account.pw_gid}:
        raise Rejected("IDENTITY_INVALID")
    boundary = load_boundary(INSTALL / "boundary.py")
    payload = json.loads(sys.stdin.buffer.read(MAX_FRAME + 1), object_pairs_hook=_pairs)
    expected = {"path", "digest", "deadline", "root_identity"} if read else {"path", "content_b64", "deadline", "root_identity"}
    if set(payload) != expected or time.monotonic() >= payload["deadline"]:
        raise Rejected("ENTRY_INVALIDATED")
    if read:
        if payload["path"] != "marker.txt" or payload["digest"] != hashlib.sha256(b"PUBLIC_EMPTY_PROBE_INPUT:a-input\n").hexdigest():
            raise Rejected("INPUT_NOT_FROZEN")
        handle = boundary.DirectoryHandle("/srv/clued-m2/probe/a-input", account.pw_uid, read_only=True, gid=account.pw_gid)
        try:
            if list(handle.identity) != payload["root_identity"]:
                raise Rejected("ROOT_IDENTITY_DRIFT")
            data = handle.read_frozen(payload["path"], payload["digest"])
            result = {"status": "ok", "content_b64": base64.b64encode(data).decode("ascii"), "sha256": payload["digest"]}
        finally:
            handle.close()
    else:
        handle = boundary.DirectoryHandle("/srv/clued-m2/probe/a-work", account.pw_uid)
        try:
            if list(handle.identity) != payload["root_identity"]:
                raise Rejected("ROOT_IDENTITY_DRIFT")
            data = base64.b64decode(payload["content_b64"], validate=True)
            handle.create_only(payload["path"], data, lambda: time.monotonic() >= payload["deadline"])
            result = {"status": "ok", "sha256": hashlib.sha256(data).hexdigest()}
        finally:
            handle.close()
    sys.stdout.buffer.write(encode_frame(result))


def serve_installed():
    # One foreground management connection. No socket activation or daemon.
    entry = installed_executor()
    if not hasattr(socket, "AF_VSOCK"):
        raise Rejected("TRANSPORT_NOT_CONFIGURED")
    listener = None
    try:
        listener = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
        listener.bind((socket.VMADDR_CID_ANY, PORT))
        listener.listen(1)
        listener.settimeout(LEASE)
        conn, peer = listener.accept()
        with conn:
            # CID is host routing, NOT per-process authentication. Entire Windows
            # management host remains trusted, outside the executor qualification.
            if peer[0] != socket.VMADDR_CID_HOST:
                raise Rejected("PEER_INVALID")
            conn.settimeout(LEASE)
            stream = conn.makefile("rb")
            def closed():
                ready, _, _ = select.select([conn], [], [], 0)
                return bool(ready) and conn.recv(1, socket.MSG_PEEK) == b""
            with stream:
                while True:
                    conn.settimeout(max(0.001, entry.started + LEASE - time.monotonic()))
                    frame = stream.readline(MAX_FRAME + 1)
                    if not frame:
                        break
                    try:
                        message = decode_frame(frame)
                        result = entry.call(message["tool"], message["arguments"], closed)
                    except Rejected as error:
                        result = denied(str(error))
                        conn.sendall(encode_frame(result))
                        break
                    conn.sendall(encode_frame(result))
                    if entry.revoked:
                        break
    finally:
        entry.revoke()
        entry.ledger.close()
        if listener is not None:
            listener.close()


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv == ["--list-tools"]:
        print(json.dumps({"tools": list(TOOLS), "qualification": "NOT_ISSUED"}))
        return 0
    if argv not in (["--serve-installed-a"], ["--worker-read"], ["--worker-write"]):
        print(json.dumps(denied("NOT_CONFIGURED")))
        return 2
    try:
        if argv == ["--serve-installed-a"]:
            serve_installed()
        else:
            worker(argv == ["--worker-read"])
        return 0
    except Exception:
        print(json.dumps(denied("EXECUTOR_UNAVAILABLE", "UNKNOWN")))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
