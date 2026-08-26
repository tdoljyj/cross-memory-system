import contextlib
import dataclasses
import hashlib
import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import isolated_mirror
from isolated_mirror import (
    AUDIT_FILENAME,
    BACKUP_CONTROL_CONTRACT,
    BACKUP_CONTROL_FILENAME,
    ExclusiveFileLock,
    MirrorCoordinator,
    MirrorError,
    lock_path_for_target,
)
from verification_context import EndpointTrust, PathIdentity, RequestVerificationContext, sha256_file


SYNC_PATH = ROOT / "sync-memory.py"
POLICY_PATH = ROOT / "config" / "clued-local-mirror-backup-policy.json"
OWNER = "owner_fixture"
SCOPE = "fixture-user"


def load_sync_module():
    spec = importlib.util.spec_from_file_location(f"sync_memory_p3_{time.time_ns()}", SYNC_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def canonical_hash(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def basic_validator(root: Path):
    errors = []
    try:
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    except Exception as exc:
        return {}, [f"manifest-invalid:{exc}"]
    snapshot = manifest.get("snapshot_version")
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        return manifest, ["manifest:files-empty"]
    for item in files:
        rel = item.get("path") if isinstance(item, dict) else None
        path = root / rel if isinstance(rel, str) else root / "missing"
        if not path.is_file():
            errors.append(f"manifest:missing:{rel}")
            continue
        if sha256_file(path) != item.get("sha256"):
            errors.append(f"manifest:hash-mismatch:{rel}")
        if item.get("snapshot_version") != snapshot:
            errors.append(f"manifest:snapshot-mismatch:{rel}")
    return manifest, errors


def contextual_validator(root: Path, *, context=None, boundary="repository_snapshot"):
    if context is None:
        return basic_validator(root)
    return context.verify_bundle(root, basic_validator, boundary=boundary)


def write_policy(path: Path, *, maximum=3, maximum_age=604800, minimum_lkg=1):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "contract": "clued.local-mirror-backup-policy.v1",
        "policy_version": "1.0.0",
        "max_retained_backups": maximum,
        "max_retention_seconds": maximum_age,
        "minimum_verified_lkg": minimum_lkg,
        "legal_hold_blocks_deletion": True,
        "erasure_mode": "delete-if-eligible",
        "audit_contract": "clued.local-mirror-audit.v1",
    }, indent=2) + "\n", encoding="utf-8")


def make_capsule(
    root: Path,
    *,
    snapshot: str,
    canonical: int,
    build_epoch: str,
    content: str,
) -> Path:
    memory = root / "memory"
    memory.mkdir(parents=True, exist_ok=True)
    data = memory / "data.txt"
    data.write_bytes(content.encode("utf-8"))
    manifest = {
        "contract": "fixture.snapshot",
        "baseline_claim": "current",
        "source_verification": "live_rechecked",
        "views_complete": True,
        "status": "ready",
        "snapshot_version": snapshot,
        "canonical_version": f"cv_{canonical}",
        "build_epoch": build_epoch,
        "owner_ref": OWNER,
        "bundle_scope": SCOPE,
        "generator_version": "fixture-1",
        "schema_version": "5",
        "files": [{
            "path": "data.txt",
            "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
            "snapshot_version": snapshot,
        }],
    }
    manifest_path = memory / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    pointer = root / "artifacts" / "clued-two-level-snapshots" / "current.json"
    pointer.parent.mkdir(parents=True, exist_ok=True)
    pointer.write_text(json.dumps({
        "snapshot_version": snapshot,
        "manifest_sha256": sha256_file(manifest_path),
    }, indent=2) + "\n", encoding="utf-8")
    (root / "VERSION").write_text("Clued-v1.6\n", encoding="utf-8")
    trust = root / "config" / "clued-endpoint-trust.json"
    trust.parent.mkdir(parents=True, exist_ok=True)
    trust.write_text(json.dumps({
        "contract": "clued.endpoint-trust.v1",
        "snapshot_trust": {
            "expected_owner_ref": OWNER,
            "expected_bundle_scope": SCOPE,
        },
    }, indent=2) + "\n", encoding="utf-8")
    return root


def context_for(capsule: Path, remote_head: str, repository_root: Path | None = None):
    return RequestVerificationContext(
        "REPO_IMPLEMENT",
        repository_root=repository_root or capsule,
        pointer_path=capsule / "artifacts" / "clued-two-level-snapshots" / "current.json",
        version_path=capsule / "VERSION",
        remote_head=remote_head,
        endpoint_trust=EndpointTrust.load(capsule / "config" / "clued-endpoint-trust.json"),
    )


def apply_capsule(
    capsule: Path,
    target: Path,
    backups: Path,
    policy: Path,
    remote_head: str,
    *,
    clock=time.time,
    candidate_mutator=None,
    switch_hook=None,
):
    context = context_for(capsule, remote_head)
    coordinator = MirrorCoordinator(
        target=target,
        backup_root=backups,
        policy_path=policy,
        raw_validator=basic_validator,
        clock=clock,
    )
    result = coordinator.apply(
        source=capsule / "memory",
        context=context,
        validate_boundary=lambda root, boundary: context.verify_bundle(
            root, basic_validator, boundary=boundary
        ),
        remote_head=remote_head,
        candidate_mutator=candidate_mutator,
        switch_hook=switch_hook,
    )
    return result, context, coordinator


def tree_digest(root: Path):
    digest = hashlib.sha256()
    for path in sorted((p for p in root.rglob("*") if p.is_file()), key=lambda p: p.as_posix()):
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def worktree_digest(repo: Path):
    digest = hashlib.sha256()
    for path in sorted((p for p in repo.rglob("*") if p.is_file() and ".git" not in p.parts), key=lambda p: p.as_posix()):
        digest.update(path.relative_to(repo).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def make_writable(root: Path):
    if not root.exists() and not root.is_symlink():
        return
    if root.is_symlink():
        return
    for path in root.rglob("*"):
        with contextlib.suppress(OSError):
            path.chmod(stat.S_IREAD | stat.S_IWRITE | stat.S_IEXEC)
    with contextlib.suppress(OSError):
        root.chmod(stat.S_IREAD | stat.S_IWRITE | stat.S_IEXEC)


class TempFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="clued-p3-", ignore_cleanup_errors=True)
        self.root = Path(self.temp.name)
        self.policy = self.root / "policy.json"
        write_policy(self.policy)

    def tearDown(self):
        make_writable(self.root)
        self.temp.cleanup()


class GitReadFixture(TempFixture):
    def setUp(self):
        super().setUp()
        self.seed = self.root / "seed"
        self.origin = self.root / "origin.git"
        self.endpoint = self.root / "endpoint"
        self.publisher = self.root / "publisher"
        self.target = self.root / "local" / "memory"
        self.backups = self.root / "local" / "backups"
        self._git("init", "-b", "main", str(self.seed), cwd=self.root)
        self._git("config", "user.name", "P3-Fixture", cwd=self.seed)
        self._git("config", "user.email", "fixture@example.invalid", cwd=self.seed)
        make_capsule(
            self.seed,
            snapshot="snap_p3_a",
            canonical=1,
            build_epoch="2026-08-26T00:00:00Z",
            content="snapshot-a",
        )
        (self.seed / "dev.txt").write_text("base\n", encoding="utf-8")
        self._git("add", ".", cwd=self.seed)
        self._git("commit", "-m", "base", cwd=self.seed)
        self._git("clone", "--bare", str(self.seed), str(self.origin), cwd=self.root)
        self._git("clone", str(self.origin), str(self.endpoint), cwd=self.root)
        self._git("clone", str(self.origin), str(self.publisher), cwd=self.root)
        for repo in (self.endpoint, self.publisher):
            self._git("config", "user.name", "P3-Fixture", cwd=repo)
            self._git("config", "user.email", "fixture@example.invalid", cwd=repo)

    @staticmethod
    def _git(*args, cwd):
        return subprocess.run(
            ["git", *args], cwd=cwd, text=True, encoding="utf-8", errors="replace",
            capture_output=True, check=True,
        )

    def publish_b(self):
        make_writable(self.publisher)
        shutil.rmtree(self.publisher / "memory")
        shutil.rmtree(self.publisher / "artifacts")
        shutil.rmtree(self.publisher / "config")
        (self.publisher / "VERSION").unlink()
        make_capsule(
            self.publisher,
            snapshot="snap_p3_b",
            canonical=2,
            build_epoch="2026-08-26T01:00:00Z",
            content="snapshot-b",
        )
        (self.publisher / "remote.txt").write_text("remote\n", encoding="utf-8")
        self._git("add", ".", cwd=self.publisher)
        self._git("commit", "-m", "remote b", cwd=self.publisher)
        self._git("push", "origin", "main", cwd=self.publisher)
        return self._git("rev-parse", "HEAD", cwd=self.publisher).stdout.strip()

    def run_read(self, sync):
        with mock.patch.object(sync, "REPO", self.endpoint), mock.patch.object(
            sync, "LOCAL_MEMORY", self.target
        ), mock.patch.object(sync, "validate", side_effect=contextual_validator), mock.patch.dict(os.environ, {
            "CROSS_MEMORY_BACKUP_DIR": str(self.backups),
            "CROSS_MEMORY_BACKUP_POLICY": str(self.policy),
        }, clear=False):
            return sync.cmd_align_and_verify("PROJECT")


class F02F03IsolatedRead(GitReadFixture):
    def test_f02_remote_ahead_clean_updates_only_isolated_mirror(self):
        remote_sha = self.publish_b()
        head_before = self._git("rev-parse", "HEAD", cwd=self.endpoint).stdout.strip()
        index_before = hashlib.sha256((self.endpoint / ".git" / "index").read_bytes()).hexdigest()
        tree_before = worktree_digest(self.endpoint)
        sync = load_sync_module()
        observed = []
        original_run = sync.run

        def recording_run(*args, **kwargs):
            observed.append(args)
            return original_run(*args, **kwargs)

        with mock.patch.object(sync, "run", side_effect=recording_run):
            self.assertEqual(0, self.run_read(sync))
        self.assertEqual(1, sum(call[:2] == ("git", "ls-remote") for call in observed))
        self.assertEqual(remote_sha, json.loads((self.target / ".clued-mirror-generation.json").read_text(encoding="utf-8"))["remote_head"])
        self.assertEqual("snapshot-b", (self.target / "data.txt").read_text(encoding="utf-8"))
        self.assertEqual(head_before, self._git("rev-parse", "HEAD", cwd=self.endpoint).stdout.strip())
        self.assertEqual(index_before, hashlib.sha256((self.endpoint / ".git" / "index").read_bytes()).hexdigest())
        self.assertEqual(tree_before, worktree_digest(self.endpoint))

    def test_f03_dirty_head_index_and_files_do_not_contaminate_mirror(self):
        self.publish_b()
        (self.endpoint / "dev.txt").write_text("dirty-worktree-secret\n", encoding="utf-8")
        (self.endpoint / "staged.txt").write_text("staged-dirty\n", encoding="utf-8")
        self._git("add", "staged.txt", cwd=self.endpoint)
        head_before = self._git("rev-parse", "HEAD", cwd=self.endpoint).stdout.strip()
        index_before = hashlib.sha256((self.endpoint / ".git" / "index").read_bytes()).hexdigest()
        tree_before = worktree_digest(self.endpoint)
        sync = load_sync_module()
        self.assertEqual(0, self.run_read(sync))
        self.assertEqual(head_before, self._git("rev-parse", "HEAD", cwd=self.endpoint).stdout.strip())
        self.assertEqual(index_before, hashlib.sha256((self.endpoint / ".git" / "index").read_bytes()).hexdigest())
        self.assertEqual(tree_before, worktree_digest(self.endpoint))
        self.assertFalse((self.target / "dev.txt").exists())
        self.assertFalse((self.target / "staged.txt").exists())
        self.assertEqual("snapshot-b", (self.target / "data.txt").read_text(encoding="utf-8"))


class F04ConflictPacket(GitReadFixture):
    def test_true_divergence_emits_packet_and_does_not_switch(self):
        source_a = self.root / "source-a"
        make_capsule(source_a, snapshot="snap_p3_a", canonical=1, build_epoch="2026-08-26T00:00:00Z", content="snapshot-a\n")
        apply_capsule(source_a, self.target, self.backups, self.policy, "1" * 40)
        lkg_before = tree_digest(self.target)
        (self.endpoint / "dev.txt").write_text("local-commit\n", encoding="utf-8")
        self._git("add", "dev.txt", cwd=self.endpoint)
        self._git("commit", "-m", "local", cwd=self.endpoint)
        remote_sha = self.publish_b()
        sync = load_sync_module()
        with mock.patch.object(sync, "REPO", self.endpoint), mock.patch.object(
            sync, "LOCAL_MEMORY", self.target
        ), mock.patch.object(sync, "validate", side_effect=contextual_validator), mock.patch.dict(os.environ, {
            "CROSS_MEMORY_BACKUP_DIR": str(self.backups),
            "CROSS_MEMORY_BACKUP_POLICY": str(self.policy),
        }, clear=False):
            with self.assertRaises(sync.GitConflictPacketError) as raised:
                sync.cmd_align_and_verify("PROJECT")
        packet = raised.exception.packet
        self.assertEqual("clued.git-conflict-packet.v1", packet["contract"])
        self.assertEqual(remote_sha, packet["remote"])
        self.assertNotEqual(packet["local"], packet["remote"])
        self.assertRegex(packet["base"], r"^[0-9a-f]{40}$")
        self.assertFalse(packet["canonical_cas_conflict"])
        self.assertFalse(packet["automatic_merge_attempted"])
        self.assertEqual(lkg_before, tree_digest(self.target))


class F27NoopIdentity(TempFixture):
    def _fixture(self):
        capsule = self.root / "capsule"
        make_capsule(capsule, snapshot="snap_p3_same", canonical=10, build_epoch="2026-08-26T02:00:00Z", content="same\n")
        target = self.root / "mirror"
        backups = self.root / "backups"
        result, _, _ = apply_capsule(capsule, target, backups, self.policy, "2" * 40)
        self.assertEqual("mirrored", result["status"])
        control, _, _ = apply_capsule(capsule, target, backups, self.policy, "2" * 40)
        self.assertEqual("noop", control["status"])
        return capsule, target, backups

    def test_identical_byte_directory_replacement_invalidates_noop(self):
        capsule, target, backups = self._fixture()
        replacement = self.root / "replacement"
        shutil.copytree(target, replacement)
        displaced = self.root / "displaced"
        os.replace(target, displaced)
        os.replace(replacement, target)
        with self.assertRaisesRegex(MirrorError, "no-op Evidence invalid"):
            apply_capsule(capsule, target, backups, self.policy, "2" * 40)

    def test_symlink_or_junction_target_change_invalidates_noop(self):
        capsule, target, backups = self._fixture()
        storage = self.root / "linked-storage"
        os.replace(target, storage)
        if os.name == "nt":
            created = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(target), str(storage)],
                text=True, capture_output=True,
            )
            if created.returncode:
                self.skipTest("junction creation unavailable")
        else:
            target.symlink_to(storage, target_is_directory=True)
        with self.assertRaisesRegex(MirrorError, "no-op Evidence invalid"):
            apply_capsule(capsule, target, backups, self.policy, "2" * 40)

    def test_volume_identity_change_invalidates_noop(self):
        capsule, target, backups = self._fixture()
        original = PathIdentity.capture

        def changed(path):
            captured = original(path)
            if Path(path).resolve(strict=False) == target.resolve(strict=False):
                return dataclasses.replace(captured, device=captured.device + 1)
            return captured

        with mock.patch.object(isolated_mirror.PathIdentity, "capture", side_effect=changed):
            with self.assertRaisesRegex(MirrorError, "no-op Evidence invalid"):
                apply_capsule(capsule, target, backups, self.policy, "2" * 40)

    def test_acl_or_read_only_change_invalidates_noop(self):
        capsule, target, backups = self._fixture()
        target.chmod(stat.S_IREAD | stat.S_IWRITE | stat.S_IEXEC)
        with self.assertRaisesRegex(MirrorError, "no-op Evidence invalid"):
            apply_capsule(capsule, target, backups, self.policy, "2" * 40)

    def test_generation_change_invalidates_noop_and_full_revalidates(self):
        capsule, target, backups = self._fixture()
        metadata_path = target / ".clued-mirror-generation.json"
        metadata_path.chmod(stat.S_IREAD | stat.S_IWRITE)
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["order_key"][0] = "2026-08-26T02:00:01Z"
        metadata["generation_id"] = canonical_hash({
            "snapshot_version": metadata["snapshot_version"],
            "manifest_sha256": metadata["manifest_sha256"],
            "order_key": metadata["order_key"],
        })
        metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        metadata_path.chmod(stat.S_IREAD)
        with self.assertRaisesRegex(MirrorError, "Mirror Generation changed"):
            apply_capsule(capsule, target, backups, self.policy, "2" * 40)


def worker_apply(spec_path: Path):
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    time.sleep(float(spec.get("delay", 0)))
    result, _, _ = apply_capsule(
        Path(spec["capsule"]),
        Path(spec["target"]),
        Path(spec["backups"]),
        Path(spec["policy"]),
        spec["remote_head"],
    )
    print(json.dumps({"status": result["status"], "snapshot_version": result["snapshot_version"]}))


class F32ConcurrencyRollbackRetention(TempFixture):
    def _spawn(self, capsule, target, backups, remote_head, delay=0):
        spec = self.root / f"worker-{time.time_ns()}.json"
        spec.write_text(json.dumps({
            "capsule": str(capsule),
            "target": str(target),
            "backups": str(backups),
            "policy": str(self.policy),
            "remote_head": remote_head,
            "delay": delay,
        }), encoding="utf-8")
        return subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--worker", str(spec)],
            cwd=ROOT, text=True, encoding="utf-8", stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

    def _communicate(self, process):
        stdout, stderr = process.communicate(timeout=60)
        self.assertEqual(0, process.returncode, stderr + stdout)
        return json.loads(stdout.strip().splitlines()[-1])

    def test_two_processes_same_snapshot_produce_one_generation_and_no_duplicate_backup(self):
        capsule_a = make_capsule(self.root / "a", snapshot="snap_a", canonical=1, build_epoch="2026-08-26T00:00:00Z", content="a\n")
        capsule_b = make_capsule(self.root / "b", snapshot="snap_a", canonical=1, build_epoch="2026-08-26T00:00:00Z", content="a\n")
        target = self.root / "mirror"
        backups = self.root / "backups"
        first = self._spawn(capsule_a, target, backups, "3" * 40)
        second = self._spawn(capsule_b, target, backups, "3" * 40)
        statuses = {self._communicate(first)["status"], self._communicate(second)["status"]}
        self.assertEqual({"mirrored", "noop"}, statuses)
        self.assertEqual([], list(backups.glob("backup-*")))
        events = [json.loads(line) for line in (backups / AUDIT_FILENAME).read_text(encoding="utf-8").splitlines()]
        self.assertEqual(1, sum(event["event"] == "mirror_switched" for event in events))
        self.assertEqual(1, sum(event["event"] == "mirror_noop" for event in events))

    def test_different_snapshots_finish_at_deterministic_newest_for_both_race_orders(self):
        old = make_capsule(self.root / "old", snapshot="snap_old", canonical=1, build_epoch="2026-08-26T00:00:00Z", content="old\n")
        new = make_capsule(self.root / "new", snapshot="snap_new", canonical=2, build_epoch="2026-08-26T01:00:00Z", content="new\n")
        for name, old_delay, new_delay in (("new-first", 0.2, 0), ("old-first", 0, 0.2)):
            with self.subTest(name=name):
                target = self.root / name / "mirror"
                backups = self.root / name / "backups"
                old_process = self._spawn(old, target, backups, "4" * 40, old_delay)
                new_process = self._spawn(new, target, backups, "5" * 40, new_delay)
                self._communicate(old_process)
                self._communicate(new_process)
                self.assertEqual("new\n", (target / "data.txt").read_text(encoding="utf-8"))
                metadata = json.loads((target / ".clued-mirror-generation.json").read_text(encoding="utf-8"))
                self.assertEqual("snap_new", metadata["snapshot_version"])

    def test_abnormal_lock_holder_releases_without_changing_lkg(self):
        capsule = make_capsule(self.root / "capsule", snapshot="snap_lock", canonical=3, build_epoch="2026-08-26T03:00:00Z", content="lock\n")
        target = self.root / "mirror"
        backups = self.root / "backups"
        apply_capsule(capsule, target, backups, self.policy, "6" * 40)
        before = tree_digest(target)
        ready = self.root / "lock-ready"
        holder = subprocess.Popen([
            sys.executable, str(Path(__file__).resolve()), "--hold-lock",
            str(lock_path_for_target(target)), str(ready), "30",
        ], cwd=ROOT)
        deadline = time.time() + 10
        while not ready.exists() and time.time() < deadline:
            time.sleep(0.05)
        self.assertTrue(ready.exists())
        holder.kill()
        holder.wait(timeout=10)
        result, _, _ = apply_capsule(capsule, target, backups, self.policy, "6" * 40)
        self.assertEqual("noop", result["status"])
        self.assertEqual(before, tree_digest(target))

    def test_candidate_corruption_and_switch_interrupt_restore_old_lkg(self):
        old = make_capsule(self.root / "old", snapshot="snap_old", canonical=1, build_epoch="2026-08-26T00:00:00Z", content="old\n")
        new = make_capsule(self.root / "new", snapshot="snap_new", canonical=2, build_epoch="2026-08-26T01:00:00Z", content="new\n")
        target = self.root / "mirror"
        backups = self.root / "backups"
        apply_capsule(old, target, backups, self.policy, "7" * 40)
        before = tree_digest(target)

        def corrupt(candidate):
            path = candidate / "data.txt"
            path.write_text("corrupted\n", encoding="utf-8")

        with self.assertRaisesRegex(MirrorError, "candidate invalid"):
            apply_capsule(new, target, backups, self.policy, "8" * 40, candidate_mutator=corrupt)
        self.assertEqual(before, tree_digest(target))

        def interrupt(phase, candidate, backup):
            if phase == "after_backup":
                raise RuntimeError("fixture switch interruption")

        with self.assertRaisesRegex(MirrorError, "switch failed"):
            apply_capsule(new, target, backups, self.policy, "8" * 40, switch_hook=interrupt)
        self.assertEqual(before, tree_digest(target))
        _, errors = basic_validator(target)
        self.assertEqual([], errors)

    def test_retention_is_bounded_and_audits_hold_erasure_retain_delete(self):
        write_policy(self.policy, maximum=3, maximum_age=100000, minimum_lkg=1)
        target = self.root / "mirror"
        backups = self.root / "backups"
        clock_value = [1000.0]
        coordinator = None
        for number in range(1, 6):
            capsule = make_capsule(
                self.root / f"capsule-{number}",
                snapshot=f"snap_{number}",
                canonical=number,
                build_epoch=f"2026-08-26T0{number}:00:00Z",
                content=f"{number}\n",
            )
            clock = lambda value=clock_value: value[0]
            _, _, coordinator = apply_capsule(
                capsule, target, backups, self.policy, f"{number:x}" * 40, clock=clock
            )
            clock_value[0] += 10
            current_backups = sorted(backups.glob("backup-*"))
            if number == 2 and current_backups:
                held = current_backups[0]
                _write_control(held, legal_hold=True, erasure_requested=False)
        assert coordinator is not None
        backup_paths = sorted(backups.glob("backup-*"))
        held_paths = [path for path in backup_paths if _control(path).get("legal_hold")]
        self.assertEqual(1, len(held_paths))
        nonheld = [path for path in backup_paths if path not in held_paths]
        self.assertLessEqual(len(backup_paths), 3)
        self.assertGreaterEqual(len(nonheld), 2)
        nonheld.sort(key=lambda path: path.name)
        _write_control(nonheld[0], legal_hold=False, erasure_requested=True)
        coordinator.enforce_retention(request_id="erasure-delete-fixture")
        remaining_nonheld = [path for path in backups.glob("backup-*") if path not in held_paths]
        self.assertGreaterEqual(len(remaining_nonheld), 1)
        newest = max(remaining_nonheld, key=lambda path: path.name)
        _write_control(newest, legal_hold=False, erasure_requested=True)
        coordinator.enforce_retention(request_id="erasure-skip-fixture")
        events = [json.loads(line) for line in (backups / AUDIT_FILENAME).read_text(encoding="utf-8").splitlines()]
        names = {event["event"] for event in events}
        self.assertIn("backup_retain_hold", names)
        self.assertIn("backup_deleted", names)
        self.assertIn("backup_erasure_skipped_only_lkg", names)
        self.assertTrue({"backup_retain", "backup_retain_minimum_lkg"} & names)
        self.assertTrue(held_paths[0].exists())
        self.assertGreaterEqual(len([path for path in backups.glob("backup-*")]), 1)

    def test_backup_delete_failure_is_audited_and_preserves_lkg(self):
        write_policy(self.policy, maximum=3, maximum_age=100000, minimum_lkg=1)
        target = self.root / "mirror"
        backups = self.root / "backups"
        coordinator = None
        for number in range(1, 5):
            capsule = make_capsule(
                self.root / f"failure-capsule-{number}",
                snapshot=f"failure_snap_{number}",
                canonical=number,
                build_epoch=f"2026-08-26T0{number}:00:00Z",
                content=f"failure-{number}\n",
            )
            _, _, coordinator = apply_capsule(
                capsule, target, backups, self.policy, f"{number:x}" * 40
            )
        assert coordinator is not None
        victim = min(backups.glob("backup-*"), key=lambda path: path.name)
        _write_control(victim, legal_hold=False, erasure_requested=True)
        with mock.patch.object(isolated_mirror, "_safe_remove", side_effect=PermissionError("fixture deletion denied")):
            result = coordinator.enforce_retention(request_id="delete-failure-fixture")
        self.assertIn(victim.name, result["skipped"])
        self.assertTrue(victim.exists())
        _, target_errors = basic_validator(target)
        self.assertEqual([], target_errors)
        events = [json.loads(line) for line in (backups / AUDIT_FILENAME).read_text(encoding="utf-8").splitlines()]
        failures = [event for event in events if event["event"] == "backup_delete_failed"]
        self.assertEqual(1, len(failures))
        self.assertIn("fixture deletion denied", failures[0]["reason"])


def _write_control(backup: Path, *, legal_hold: bool, erasure_requested: bool):
    backup.chmod(stat.S_IREAD | stat.S_IWRITE | stat.S_IEXEC)
    path = backup / BACKUP_CONTROL_FILENAME
    path.write_text(json.dumps({
        "contract": BACKUP_CONTROL_CONTRACT,
        "legal_hold": legal_hold,
        "erasure_requested": erasure_requested,
    }, indent=2) + "\n", encoding="utf-8")
    path.chmod(stat.S_IREAD)
    backup.chmod(stat.S_IREAD | stat.S_IEXEC)


def _control(backup: Path):
    path = backup / BACKUP_CONTROL_FILENAME
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        worker_apply(Path(sys.argv[2]))
    elif len(sys.argv) > 1 and sys.argv[1] == "--hold-lock":
        with ExclusiveFileLock(Path(sys.argv[2]), timeout_seconds=10):
            Path(sys.argv[3]).write_text("ready\n", encoding="utf-8")
            time.sleep(float(sys.argv[4]))
    else:
        unittest.main()
