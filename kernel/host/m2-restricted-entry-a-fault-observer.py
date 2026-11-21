"""Read-only management stop observation candidate, not an activation adapter.

Reuse the installed runner's whole-cgroup stop proof. Process-group observations
alone (including real same-user sandbox kills) never issue cgroup qualification.
No command, root, role, launcher or trigger can arrive through Agent arguments.
"""
from dataclasses import dataclass
import os
from pathlib import Path
import stat
import time
import uuid

# Existing A supervisor acceptance bound; not a fixture-configurable threshold.
STOP_TIMEOUT = 0.1

FIXED_COMMAND = ("/usr/bin/python3", "-B", "-I", "-S",
                 "/usr/local/lib/clued-m2-a-fault-fixture/fault_fixture.py",
                 "--fixed-management-fixture")
MAX_PROCESSES = 4096
MAX_STAT_BYTES = 65536


class Uncertain(Exception):
    pass


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    start_ticks: int
    pgid: int
    session: int
    uid: int
    gid: int
    state: str

    def generation(self):
        return self.pid, self.start_ticks, self.pgid, self.session, self.uid, self.gid


@dataclass(frozen=True)
class GroupBinding:
    boot_id: str
    leader: ProcessIdentity


@dataclass(frozen=True)
class Observation:
    binding: GroupBinding
    members: tuple
    tracked: tuple
    complete: bool
    reason: str = ""


def read_process(pid):
    """Bound /proc read; ignore comm content, including spaces and parentheses."""
    if type(pid) is not int or pid <= 0:
        raise Uncertain("PID_INVALID")
    if not hasattr(os, "O_NOFOLLOW"):
        raise Uncertain("PROC_PLATFORM_UNAVAILABLE")
    path = Path("/proc") / str(pid) / "stat"
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode):
            raise Uncertain("PROC_TYPE_INVALID")
        raw = os.read(fd, MAX_STAT_BYTES + 1)
        if len(raw) > MAX_STAT_BYTES or not raw.startswith(str(pid).encode() + b" ("):
            raise Uncertain("PROC_STAT_INVALID")
        tail = raw[raw.rfind(b")") + 2:].split()
        if len(tail) < 20 or tail[0] not in tuple(x.encode() for x in "RSDZTtXxKWPI"):
            raise Uncertain("PROC_STAT_INVALID")
        result = ProcessIdentity(pid, int(tail[19]), int(tail[2]), int(tail[3]),
                                 s.st_uid, s.st_gid, tail[0].decode("ascii"))
        # Other /proc entries include early kernel tasks with zero start ticks,
        # group or session. They must remain readable during a complete census.
        if result.start_ticks < 0 or result.pgid < 0 or result.session < 0:
            raise Uncertain("PROC_STAT_INVALID")
        return result
    finally:
        os.close(fd)


def boot_id():
    value = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    if str(uuid.UUID(value)) != value:
        raise Uncertain("BOOT_ID_INVALID")
    return value


def scan_group(pgid):
    paths = [p for p in Path("/proc").iterdir() if p.name.isascii() and p.name.isdigit()]
    if len(paths) > MAX_PROCESSES:
        raise Uncertain("PROC_SCAN_LIMIT")
    members = []
    for path in paths:
        try:
            member = read_process(int(path.name))
        except FileNotFoundError:
            continue  # This generation has exited during enumeration.
        # Permission, malformed data and all other uncertainty propagate: an
        # unreadable PID could be a group member, so the scan is not complete.
        if member.pgid == pgid:
            members.append(member)
    return tuple(sorted(members, key=lambda x: x.pid))


def bind_started_group(leader_pid):
    """Caller is trusted management holding its own newly spawned Popen object."""
    leader = read_process(leader_pid)
    if (leader.start_ticks <= 0 or leader.pgid != leader.pid or
            leader.session != leader.pid or leader.state in "ZXx"):
        raise Uncertain("NEW_SESSION_LEADER_REQUIRED")
    return GroupBinding(boot_id(), leader)


def observe(binding, tracked=()):
    try:
        if boot_id() != binding.boot_id:
            raise Uncertain("BOOT_ID_DRIFT")
        try:
            leader = read_process(binding.leader.pid)
        except FileNotFoundError:
            leader = None
        if leader is not None and leader.generation() != binding.leader.generation():
            raise Uncertain("LEADER_GENERATION_DRIFT")
        first = scan_group(binding.leader.pgid)
        second = scan_group(binding.leader.pgid)
        if tuple(x.generation() for x in first) != tuple(x.generation() for x in second):
            raise Uncertain("GROUP_CHANGED_DURING_OBSERVATION")
        observed = []
        for old in tracked:
            try:
                current = read_process(old.pid)
            except FileNotFoundError:
                current = None
            if current is not None and current.generation() != old.generation():
                # PID reuse or group/session/UID escape is not a successful stop.
                raise Uncertain("TRACKED_GENERATION_DRIFT")
            observed.append(current)
        if boot_id() != binding.boot_id:
            raise Uncertain("BOOT_ID_DRIFT")
        return Observation(binding, second, tuple(observed), True)
    except (OSError, ValueError, Uncertain):
        return Observation(binding, (), (), False, "OBSERVATION_UNKNOWN")


def ready(before):
    leader = before.binding.leader
    return (before.complete and
            all((x.pgid, x.session, x.uid, x.gid) ==
                (leader.pgid, leader.session, leader.uid, leader.gid) for x in before.members)
            and any(x.generation() == before.binding.leader.generation()
                                    and x.state not in "ZXx" for x in before.members)
            and any(x.pid != before.binding.leader.pid and x.state not in "ZXx"
                    for x in before.members))


def terminated(before, after):
    return (ready(before) and after.complete and after.binding == before.binding
            and len(after.tracked) == len(before.members)
            and all(x is None or x.state in "ZXx" for x in after.tracked)
            and all(x.state in "ZXx" for x in after.members))


def stop_and_observe(runner, before, timeout, clock=time.monotonic):
    """Existing runner.stop performs the action; this layer only adds evidence.

    timeout must be the existing supervisor STOP_TIMEOUT supplied by management.
    A late observation, absent readiness or any missing native proof is UNKNOWN.
    """
    start = clock()
    try:
        if type(timeout) not in (int, float) or timeout != STOP_TIMEOUT or not ready(before):
            raise Uncertain("FIXED_STOP_BOUND_OR_READINESS_INVALID")
        proof = runner.stop(timeout)
        after = observe(before.binding, before.members)
        elapsed = clock() - start
        confirmed = (0 <= elapsed < timeout and terminated(before, after)
                     and type(proof) is dict and proof.get("scope") == "entire_cgroup"
                     and all(proof.get(k) is True for k in
                             ("cgroup_empty", "leader_reaped", "identity_unchanged")))
    except Exception:
        confirmed = False
        after = Observation(before.binding, (), (), False, "STOP_OR_OBSERVATION_UNKNOWN")
    return {"execution_state": "STOPPED" if confirmed else "UNKNOWN",
            "qualification": "NOT_ISSUED", "observation": after}
