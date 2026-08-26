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
    BACKUP_RECORD_FILENAME,
    ExclusiveFileLock,
    MirrorCoordinator,
    MirrorError,
    MirrorRecoveryRequired,
    journal_path_for_target,
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


def recovery_validator_for(capsule: Path):
    state = {"expected_sha256": None, "context": None}

    def validate_recovery(root: Path, boundary: str, expected: dict):
        expected_sha256 = canonical_hash(expected)
        if state["context"] is None:
            state["expected_sha256"] = expected_sha256
            state["context"] = RequestVerificationContext(
                "AUDIT_FULL",
                repository_root=capsule,
                pointer_path=None,
                version_path=capsule / "VERSION",
                remote_head=expected["remote_head"],
                endpoint_trust=EndpointTrust.load(capsule / "config" / "clued-endpoint-trust.json"),
                allow_authoritative=False,
            )
        elif state["expected_sha256"] != expected_sha256:
            return {}, ["recovery:prior-lkg-evidence-changed"]

        def validate_expected(path: Path):
            manifest, errors = basic_validator(path)
            try:
                generation = json.loads((path / ".clued-mirror-generation.json").read_text(encoding="utf-8"))
            except Exception as exc:
                return manifest, [*errors, f"recovery:generation-invalid:{exc}"]
            comparisons = {
                "snapshot-version": manifest.get("snapshot_version") == expected["snapshot_version"],
                "manifest-sha256": sha256_file(path / "manifest.json") == expected["manifest_sha256"],
                "generation-id": generation.get("generation_id") == expected["generation_id"],
                "generation-manifest": generation.get("manifest_sha256") == expected["manifest_sha256"],
                "generation-remote": generation.get("remote_head") == expected["remote_head"],
                "generation-target-identity": generation.get("target_identity_sha256") == expected["target_identity_sha256"],
                "generation-read-only": generation.get("read_only_sha256") == expected["read_only_sha256"],
            }
            errors.extend(f"recovery:{name}-mismatch" for name, matches in comparisons.items() if not matches)
            return manifest, errors

        return state["context"].verify_bundle(root, validate_expected, boundary=boundary)

    return validate_recovery


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
        recovery_validator=recovery_validator_for(capsule),
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

    def test_acl_security_descriptor_change_invalidates_noop(self):
        capsule, target, backups = self._fixture()
        original = PathIdentity.capture

        def changed(path):
            captured = original(path)
            if Path(path).resolve(strict=False) == target.resolve(strict=False):
                return dataclasses.replace(captured, security_sha256="f" * 64)
            return captured

        with mock.patch.object(isolated_mirror.PathIdentity, "capture", side_effect=changed):
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


def worker_crash(spec_path: Path):
    spec = json.loads(spec_path.read_text(encoding="utf-8"))

    def crash_at(phase, candidate, backup):
        if phase == spec["crash_phase"]:
            os._exit(int(spec.get("crash_exit", 86)))

    apply_capsule(
        Path(spec["capsule"]),
        Path(spec["target"]),
        Path(spec["backups"]),
        Path(spec["policy"]),
        spec["remote_head"],
        switch_hook=crash_at,
    )
    os._exit(97)


def worker_recover(spec_path: Path):
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    capsule = Path(spec["validation_capsule"])
    coordinator = MirrorCoordinator(
        target=Path(spec["target"]),
        backup_root=Path(spec["backups"]),
        policy_path=Path(spec["policy"]),
        raw_validator=basic_validator,
        recovery_validator=recovery_validator_for(capsule),
    )
    result = coordinator.recover_interrupted_switch()
    print(json.dumps(result), flush=True)


class F32CrashRecoveryStateMachine(TempFixture):
    CRASH_EXIT = 86

    def _spawn_mode(self, mode, spec):
        spec_path = self.root / f"{mode}-{time.time_ns()}.json"
        spec_path.write_text(json.dumps(spec), encoding="utf-8")
        return subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), f"--{mode}", str(spec_path)],
            cwd=ROOT,
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def _crash(self, *, capsule, target, backups, crash_phase, remote_head):
        process = self._spawn_mode("crash-worker", {
            "capsule": str(capsule),
            "target": str(target),
            "backups": str(backups),
            "policy": str(self.policy),
            "remote_head": remote_head,
            "crash_phase": crash_phase,
            "crash_exit": self.CRASH_EXIT,
        })
        stdout, stderr = process.communicate(timeout=60)
        self.assertEqual(self.CRASH_EXIT, process.returncode, stderr + stdout)

    def _recover(self, *, validation_capsule, validation_remote_head, target, backups):
        process = self._spawn_mode("recover-worker", {
            "validation_capsule": str(validation_capsule),
            "validation_remote_head": validation_remote_head,
            "target": str(target),
            "backups": str(backups),
            "policy": str(self.policy),
        })
        stdout, stderr = process.communicate(timeout=60)
        self.assertEqual(0, process.returncode, stderr + stdout)
        return json.loads(stdout.strip().splitlines()[-1])

    def _apply_process(self, *, capsule, target, backups, remote_head):
        process = self._spawn_mode("worker", {
            "capsule": str(capsule),
            "target": str(target),
            "backups": str(backups),
            "policy": str(self.policy),
            "remote_head": remote_head,
            "delay": 0,
        })
        stdout, stderr = process.communicate(timeout=60)
        self.assertEqual(0, process.returncode, stderr + stdout)
        return json.loads(stdout.strip().splitlines()[-1])

    @staticmethod
    def _repo_state():
        index = ROOT / ".git" / "index"
        return {
            "head": subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, capture_output=True, check=True
            ).stdout.strip(),
            "status": subprocess.run(
                ["git", "status", "--porcelain=v1"], cwd=ROOT, text=True, capture_output=True, check=True
            ).stdout,
            "index": hashlib.sha256(index.read_bytes()).hexdigest(),
            "manifest": sha256_file(ROOT / "memory" / "manifest.json"),
            "pointer": sha256_file(ROOT / "artifacts" / "clued-two-level-snapshots" / "current.json"),
            "implementation": sha256_file(ROOT / "isolated_mirror.py"),
        }

    @staticmethod
    def _journal_state(target):
        payload = json.loads(journal_path_for_target(target).read_text(encoding="utf-8"))
        candidate = Path(payload["candidate"])
        backup = Path(payload["backup"]) if payload["backup"] else None
        return payload, candidate, backup, (
            target.exists(),
            candidate.exists(),
            backup is not None and backup.exists(),
        )

    def test_replacement_real_process_crashes_restore_verified_old_lkg(self):
        windows = (
            ("after_prepared_journal", "prepared", (True, True, False)),
            ("after_old_moved_before_journal", "prepared", (False, True, True)),
            ("after_old_moved_journal", "old-moved", (False, True, True)),
            ("after_candidate_promoted_before_journal", "old-moved", (True, False, True)),
            ("after_candidate_promoted_journal", "candidate-promoted", (True, False, True)),
        )
        repo_before = self._repo_state()
        for index, (crash_phase, journal_phase, expected_state) in enumerate(windows, 1):
            with self.subTest(crash_phase=crash_phase):
                case = self.root / f"replacement-{index}"
                old = make_capsule(
                    case / "old", snapshot=f"old_{index}", canonical=index * 2 - 1,
                    build_epoch=f"2026-08-26T{index:02d}:00:00Z", content=f"old-{index}\n",
                )
                new = make_capsule(
                    case / "new", snapshot=f"new_{index}", canonical=index * 2,
                    build_epoch=f"2026-08-26T{index:02d}:30:00Z", content=f"new-{index}\n",
                )
                target = case / "mirror"
                backups = case / "backups"
                old_remote = f"{index:x}" * 40
                new_remote = f"{(index + 8) % 16:x}" * 40
                apply_capsule(old, target, backups, self.policy, old_remote)
                old_digest = tree_digest(target)
                self._crash(
                    capsule=new, target=target, backups=backups,
                    crash_phase=crash_phase, remote_head=new_remote,
                )
                journal, candidate, backup, actual_state = self._journal_state(target)
                self.assertEqual(journal_phase, journal["phase"])
                self.assertEqual(expected_state, actual_state)
                recovered = self._recover(
                    validation_capsule=old,
                    validation_remote_head=old_remote,
                    target=target,
                    backups=backups,
                )
                self.assertEqual("recovered", recovered["status"])
                self.assertTrue(target.is_dir())
                self.assertEqual(old_digest, tree_digest(target))
                _, errors = basic_validator(target)
                self.assertEqual([], errors)
                self.assertFalse(candidate.exists())
                self.assertFalse(journal_path_for_target(target).exists())
                self.assertEqual([], list(backups.glob("backup-*")))
                with ExclusiveFileLock(lock_path_for_target(target), timeout_seconds=2):
                    pass
                events = [json.loads(line) for line in (backups / AUDIT_FILENAME).read_text(encoding="utf-8").splitlines()]
                self.assertFalse(any(
                    event["event"] == "mirror_switched" and event.get("snapshot_version") == f"new_{index}"
                    for event in events
                ))
                self.assertTrue(any(
                    event["event"] == "interrupted_switch_recovered" and event.get("phase") == journal_phase
                    for event in events
                ))
                self.assertTrue(any(event["event"] == "lock_released" and event.get("operation") == "recovery-only" for event in events))
                if backup is not None:
                    self.assertFalse(backup.exists())
        self.assertEqual(repo_before, self._repo_state())

    def test_first_install_real_process_crashes_leave_no_false_success_then_reinstall(self):
        windows = (
            ("after_prepared_journal", "prepared", (False, True, False)),
            ("after_candidate_promoted_before_journal", "prepared", (True, False, False)),
            ("after_candidate_promoted_journal", "candidate-promoted", (True, False, False)),
        )
        repo_before = self._repo_state()
        for index, (crash_phase, journal_phase, expected_state) in enumerate(windows, 1):
            with self.subTest(crash_phase=crash_phase):
                case = self.root / f"first-install-{index}"
                capsule = make_capsule(
                    case / "source", snapshot=f"first_{index}", canonical=index,
                    build_epoch=f"2026-08-26T{index:02d}:00:00Z", content=f"first-{index}\n",
                )
                target = case / "mirror"
                backups = case / "backups"
                remote = f"{index + 2:x}" * 40
                self._crash(
                    capsule=capsule, target=target, backups=backups,
                    crash_phase=crash_phase, remote_head=remote,
                )
                journal, candidate, backup, actual_state = self._journal_state(target)
                self.assertEqual(journal_phase, journal["phase"])
                self.assertEqual(expected_state, actual_state)
                self.assertIsNone(backup)
                recovered = self._recover(
                    validation_capsule=capsule,
                    validation_remote_head=remote,
                    target=target,
                    backups=backups,
                )
                self.assertEqual("recovered", recovered["status"])
                self.assertFalse(target.exists())
                self.assertFalse(candidate.exists())
                self.assertFalse(journal_path_for_target(target).exists())
                self.assertEqual([], list(backups.glob("backup-*")))
                events = [json.loads(line) for line in (backups / AUDIT_FILENAME).read_text(encoding="utf-8").splitlines()]
                self.assertFalse(any(event["event"] == "mirror_switched" for event in events))
                installed = self._apply_process(
                    capsule=capsule, target=target, backups=backups, remote_head=remote
                )
                self.assertEqual("mirrored", installed["status"])
                _, errors = basic_validator(target)
                self.assertEqual([], errors)
                with ExclusiveFileLock(lock_path_for_target(target), timeout_seconds=2):
                    pass
        self.assertEqual(repo_before, self._repo_state())

    def test_invalid_journal_fields_and_ambiguous_state_fail_closed_without_deletion(self):
        cases = ("phase", "target", "candidate", "backup", "prior-lkg", "inconsistent-state")
        for index, field in enumerate(cases, 1):
            with self.subTest(field=field):
                case = self.root / f"invalid-{index}"
                old = make_capsule(
                    case / "old", snapshot=f"invalid_old_{index}", canonical=index * 2 - 1,
                    build_epoch=f"2026-08-26T{index:02d}:00:00Z", content=f"invalid-old-{index}\n",
                )
                new = make_capsule(
                    case / "new", snapshot=f"invalid_new_{index}", canonical=index * 2,
                    build_epoch=f"2026-08-26T{index:02d}:30:00Z", content=f"invalid-new-{index}\n",
                )
                target = case / "mirror"
                backups = case / "backups"
                old_remote = f"{index:x}" * 40
                new_remote = f"{index + 9:x}" * 40
                apply_capsule(old, target, backups, self.policy, old_remote)
                old_digest = tree_digest(target)
                self._crash(
                    capsule=new, target=target, backups=backups,
                    crash_phase="after_prepared_journal", remote_head=new_remote,
                )
                journal_path = journal_path_for_target(target)
                journal = json.loads(journal_path.read_text(encoding="utf-8"))
                original_candidate = Path(journal["candidate"])
                original_backup = Path(journal["backup"])
                if field == "phase":
                    journal["phase"] = "unknown-phase"
                elif field == "target":
                    journal["target"] = str(case / "other-target")
                elif field == "candidate":
                    journal["candidate"] = str(case / "outside-candidate")
                elif field == "backup":
                    journal["backup"] = str(case / "outside-backup")
                elif field == "prior-lkg":
                    journal["prior_lkg"]["generation_id"] = "invalid"
                else:
                    shutil.copytree(target, original_backup)
                journal_path.write_text(json.dumps(journal, indent=2) + "\n", encoding="utf-8")
                coordinator = MirrorCoordinator(
                    target=target,
                    backup_root=backups,
                    policy_path=self.policy,
                    raw_validator=basic_validator,
                    recovery_validator=recovery_validator_for(old),
                )
                with self.assertRaisesRegex(MirrorRecoveryRequired, "manual intervention"):
                    coordinator.recover_interrupted_switch()
                self.assertEqual(old_digest, tree_digest(target))
                self.assertTrue(original_candidate.exists())
                self.assertTrue(journal_path.exists())
                if field == "inconsistent-state":
                    self.assertTrue(original_backup.exists())
                events = [json.loads(line) for line in (backups / AUDIT_FILENAME).read_text(encoding="utf-8").splitlines()]
                self.assertTrue(any(event["event"] == "switch_recovery_blocked" for event in events))
                self.assertTrue(any(event["event"] == "lock_released" and event.get("operation") == "recovery-only" for event in events))

    def test_invalid_backup_is_rejected_in_place_before_current_target_is_removed(self):
        old = make_capsule(
            self.root / "invalid-backup-old", snapshot="invalid_backup_old", canonical=1,
            build_epoch="2026-08-26T00:00:00Z", content="verified-old\n",
        )
        new = make_capsule(
            self.root / "invalid-backup-new", snapshot="invalid_backup_new", canonical=2,
            build_epoch="2026-08-26T01:00:00Z", content="uncommitted-new\n",
        )
        target = self.root / "invalid-backup-mirror"
        backups = self.root / "invalid-backup-store"
        apply_capsule(old, target, backups, self.policy, "1" * 40)
        self._crash(
            capsule=new,
            target=target,
            backups=backups,
            crash_phase="after_candidate_promoted_journal",
            remote_head="2" * 40,
        )
        journal, candidate, backup, state = self._journal_state(target)
        self.assertEqual("candidate-promoted", journal["phase"])
        self.assertEqual((True, False, True), state)
        assert backup is not None
        current_before = tree_digest(target)
        make_writable(backup)
        (backup / "data.txt").write_text("corrupted-backup\n", encoding="utf-8")
        coordinator = MirrorCoordinator(
            target=target,
            backup_root=backups,
            policy_path=self.policy,
            raw_validator=basic_validator,
            recovery_validator=recovery_validator_for(old),
        )
        with self.assertRaisesRegex(MirrorRecoveryRequired, "manual intervention"):
            coordinator.recover_interrupted_switch()
        self.assertEqual(current_before, tree_digest(target))
        self.assertTrue(backup.exists())
        self.assertFalse(candidate.exists())
        self.assertTrue(journal_path_for_target(target).exists())

    def _apply_with_sync_fault(self, *, old, new, target, backups, old_remote, new_remote, fault):
        context = context_for(new, new_remote)
        recovery_observations = []
        base_recovery_validator = recovery_validator_for(old if old is not None else new)

        def observe_recovery(path, boundary, expected):
            recovery_observations.append({
                "boundary": boundary,
                "path": str(path),
                "target_exists": target.exists(),
                "backup_exists": any(backups.glob("backup-*")),
            })
            return base_recovery_validator(path, boundary, expected)

        coordinator = MirrorCoordinator(
            target=target,
            backup_root=backups,
            policy_path=self.policy,
            raw_validator=basic_validator,
            recovery_validator=observe_recovery,
        )
        original_replace = isolated_mirror.os.replace
        original_write_journal = coordinator._write_journal
        original_finalize_generation = coordinator._finalize_generation
        original_backup_record = coordinator._write_backup_record

        def replace_with_fault(source, destination):
            source_path = Path(source)
            destination_path = Path(destination)
            if fault == "target_backup_replace" and source_path == target and destination_path.parent == backups:
                raise PermissionError("injected target-to-Backup pre-move failure")
            if (
                fault == "candidate_promote_replace"
                and source_path.parent == target.parent
                and source_path.name.startswith(f".{target.name}.candidate-")
                and destination_path == target
            ):
                raise PermissionError("injected Candidate promotion pre-move failure")
            return original_replace(source, destination)

        def write_journal_with_fault(**kwargs):
            if fault == "old_moved_journal" and kwargs["phase"] == "old-moved":
                raise OSError("injected old-moved journal write failure")
            if fault == "candidate_promoted_journal" and kwargs["phase"] == "candidate-promoted":
                raise OSError("injected candidate-promoted journal write failure")
            return original_write_journal(**kwargs)

        def write_backup_then_fail(*args, **kwargs):
            original_backup_record(*args, **kwargs)
            raise OSError("injected Backup record post-write failure")

        def finalize_then_fail(*args, **kwargs):
            original_finalize_generation(*args, **kwargs)
            raise OSError("injected generation finalize post-write failure")

        def validate_boundary(path, boundary):
            manifest, errors = context.verify_bundle(path, basic_validator, boundary=boundary)
            if fault == "final_target_validation" and path == target and boundary == "local_mirror":
                return manifest, [*errors, "injected-final-target-validation-failure"]
            return manifest, errors

        def switch_hook(phase, candidate, backup):
            if fault == "after_prepared_journal" and phase == "after_prepared_journal":
                raise RuntimeError("injected after-prepared synchronous failure")

        with contextlib.ExitStack() as stack:
            if fault in {"target_backup_replace", "candidate_promote_replace"}:
                stack.enter_context(mock.patch.object(isolated_mirror.os, "replace", side_effect=replace_with_fault))
            if fault in {"old_moved_journal", "candidate_promoted_journal"}:
                stack.enter_context(mock.patch.object(coordinator, "_write_journal", side_effect=write_journal_with_fault))
            if fault == "generation_finalize":
                stack.enter_context(mock.patch.object(coordinator, "_finalize_generation", side_effect=finalize_then_fail))
            if fault == "backup_record":
                stack.enter_context(mock.patch.object(coordinator, "_write_backup_record", side_effect=write_backup_then_fail))
            with self.assertRaises(MirrorError) as raised:
                coordinator.apply(
                    source=new / "memory",
                    context=context,
                    validate_boundary=validate_boundary,
                    remote_head=new_remote,
                    switch_hook=switch_hook,
                )
        self.assertNotIsInstance(raised.exception, MirrorRecoveryRequired)
        return recovery_observations

    def test_sync_exception_matrix_preserves_or_discards_by_journal_state_contract(self):
        replacement_faults = (
            "after_prepared_journal",
            "target_backup_replace",
            "old_moved_journal",
            "candidate_promote_replace",
            "candidate_promoted_journal",
            "generation_finalize",
            "final_target_validation",
            "backup_record",
        )
        first_install_faults = (
            "after_prepared_journal",
            "candidate_promote_replace",
            "candidate_promoted_journal",
            "generation_finalize",
            "final_target_validation",
        )
        repo_before = self._repo_state()
        for index, fault in enumerate(replacement_faults, 1):
            with self.subTest(kind="replacement", fault=fault):
                case = self.root / f"sync-replacement-{index}"
                old = make_capsule(
                    case / "old", snapshot=f"sync_old_{index}", canonical=index * 2 - 1,
                    build_epoch=f"2026-08-26T{index:02d}:00:00Z", content=f"sync-old-{index}\n",
                )
                new = make_capsule(
                    case / "new", snapshot=f"sync_new_{index}", canonical=index * 2,
                    build_epoch=f"2026-08-26T{index:02d}:30:00Z", content=f"sync-new-{index}\n",
                )
                target = case / "mirror"
                backups = case / "backups"
                old_remote = f"{index:x}" * 40
                new_remote = f"{(index + 8) % 16:x}" * 40
                apply_capsule(old, target, backups, self.policy, old_remote)
                old_digest = tree_digest(target)
                observations = self._apply_with_sync_fault(
                    old=old, new=new, target=target, backups=backups,
                    old_remote=old_remote, new_remote=new_remote, fault=fault,
                )
                self.assertEqual(old_digest, tree_digest(target))
                _, errors = basic_validator(target)
                self.assertEqual([], errors)
                self.assertFalse(journal_path_for_target(target).exists())
                self.assertEqual([], list(target.parent.glob(f".{target.name}.candidate-*")))
                self.assertEqual([], list(backups.glob("backup-*")))
                with ExclusiveFileLock(lock_path_for_target(target), timeout_seconds=2):
                    pass
                events = [json.loads(line) for line in (backups / AUDIT_FILENAME).read_text(encoding="utf-8").splitlines()]
                self.assertTrue(
                    any(event["event"] == "switch_transaction_failed" for event in events),
                    [event["event"] for event in events],
                )
                self.assertTrue(any(event["event"] == "interrupted_switch_recovered" for event in events))
                self.assertFalse(any(
                    event["event"] == "mirror_switched" and event.get("snapshot_version") == f"sync_new_{index}"
                    for event in events
                ))
                if fault in {"candidate_promoted_journal", "generation_finalize", "final_target_validation", "backup_record"}:
                    backup_checks = [item for item in observations if item["boundary"] == "recovery_backup_lkg"]
                    self.assertTrue(backup_checks)
                    self.assertTrue(backup_checks[0]["target_exists"])
                if fault == "backup_record":
                    self.assertTrue(any(item["boundary"] == "recovery_backup_lkg_after_metadata_cleanup" for item in observations))
                    self.assertTrue(any(event["event"] == "backup_restore_metadata_removed" for event in events))
                    self.assertFalse((target / BACKUP_RECORD_FILENAME).exists())
                installed = self._apply_process(
                    capsule=new, target=target, backups=backups, remote_head=new_remote
                )
                self.assertEqual("mirrored", installed["status"])
                self.assertEqual(f"sync-new-{index}\n", (target / "data.txt").read_text(encoding="utf-8"))

        for index, fault in enumerate(first_install_faults, 1):
            with self.subTest(kind="first-install", fault=fault):
                case = self.root / f"sync-first-install-{index}"
                capsule = make_capsule(
                    case / "source", snapshot=f"sync_first_{index}", canonical=index,
                    build_epoch=f"2026-08-26T{index:02d}:00:00Z", content=f"sync-first-{index}\n",
                )
                target = case / "mirror"
                backups = case / "backups"
                remote = f"{index + 2:x}" * 40
                self._apply_with_sync_fault(
                    old=None, new=capsule, target=target, backups=backups,
                    old_remote=remote, new_remote=remote, fault=fault,
                )
                self.assertFalse(target.exists())
                self.assertFalse(journal_path_for_target(target).exists())
                self.assertEqual([], list(target.parent.glob(f".{target.name}.candidate-*")))
                self.assertEqual([], list(backups.glob("backup-*")))
                events = [json.loads(line) for line in (backups / AUDIT_FILENAME).read_text(encoding="utf-8").splitlines()]
                self.assertFalse(any(event["event"] == "mirror_switched" for event in events))
                installed = self._apply_process(
                    capsule=capsule, target=target, backups=backups, remote_head=remote
                )
                self.assertEqual("mirrored", installed["status"])
        self.assertEqual(repo_before, self._repo_state())

    def test_secondary_recovery_failures_preserve_remaining_artifacts_and_require_manual(self):
        old = make_capsule(
            self.root / "secondary-old", snapshot="secondary_old", canonical=1,
            build_epoch="2026-08-26T00:00:00Z", content="secondary-old\n",
        )
        new = make_capsule(
            self.root / "secondary-new", snapshot="secondary_new", canonical=2,
            build_epoch="2026-08-26T01:00:00Z", content="secondary-new\n",
        )
        old_remote = "1" * 40
        new_remote = "2" * 40

        target = self.root / "secondary-restore-mirror"
        backups = self.root / "secondary-restore-backups"
        apply_capsule(old, target, backups, self.policy, old_remote)
        context = context_for(new, new_remote)
        coordinator = MirrorCoordinator(
            target=target, backup_root=backups, policy_path=self.policy,
            raw_validator=basic_validator, recovery_validator=recovery_validator_for(old),
        )
        original_replace = isolated_mirror.os.replace

        def fail_restore(source, destination):
            source_path = Path(source)
            if source_path.parent == backups and Path(destination) == target:
                raise PermissionError("injected verified Backup restore failure")
            return original_replace(source, destination)

        def fail_after_promoted(phase, candidate, backup):
            if phase == "after_candidate_promoted_journal":
                raise RuntimeError("trigger recovery")

        with mock.patch.object(isolated_mirror.os, "replace", side_effect=fail_restore):
            with self.assertRaises(MirrorRecoveryRequired):
                coordinator.apply(
                    source=new / "memory", context=context,
                    validate_boundary=lambda path, boundary: context.verify_bundle(path, basic_validator, boundary=boundary),
                    remote_head=new_remote, switch_hook=fail_after_promoted,
                )
        journal = json.loads(journal_path_for_target(target).read_text(encoding="utf-8"))
        backup = Path(journal["backup"])
        self.assertFalse(target.exists())
        self.assertTrue(backup.exists())
        self.assertEqual([], basic_validator(backup)[1])
        self.assertTrue(journal_path_for_target(target).exists())
        events = [json.loads(line) for line in (backups / AUDIT_FILENAME).read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(event["event"] == "switch_recovery_blocked" for event in events))
        self.assertFalse(any(event["event"] == "mirror_switched" and event.get("snapshot_version") == "secondary_new" for event in events))
        with self.assertRaises(MirrorRecoveryRequired):
            MirrorCoordinator(
                target=target, backup_root=backups, policy_path=self.policy,
                raw_validator=basic_validator, recovery_validator=recovery_validator_for(old),
            ).recover_interrupted_switch()
        self.assertTrue(backup.exists())
        self.assertTrue(journal_path_for_target(target).exists())

        cleanup_target = self.root / "secondary-cleanup-mirror"
        cleanup_backups = self.root / "secondary-cleanup-backups"
        apply_capsule(old, cleanup_target, cleanup_backups, self.policy, old_remote)
        old_digest = tree_digest(cleanup_target)
        cleanup_context = context_for(new, new_remote)
        cleanup_coordinator = MirrorCoordinator(
            target=cleanup_target, backup_root=cleanup_backups, policy_path=self.policy,
            raw_validator=basic_validator, recovery_validator=recovery_validator_for(old),
        )
        original_remove = isolated_mirror._safe_remove

        def fail_candidate_cleanup(path, parent):
            if Path(path).name.startswith(f".{cleanup_target.name}.candidate-"):
                raise PermissionError("injected Candidate cleanup failure")
            return original_remove(path, parent)

        with mock.patch.object(isolated_mirror, "_safe_remove", side_effect=fail_candidate_cleanup):
            with self.assertRaises(MirrorRecoveryRequired):
                cleanup_coordinator.apply(
                    source=new / "memory", context=cleanup_context,
                    validate_boundary=lambda path, boundary: cleanup_context.verify_bundle(path, basic_validator, boundary=boundary),
                    remote_head=new_remote,
                    switch_hook=lambda phase, candidate, backup: (_ for _ in ()).throw(RuntimeError("trigger cleanup recovery")) if phase == "after_prepared_journal" else None,
                )
        cleanup_journal = json.loads(journal_path_for_target(cleanup_target).read_text(encoding="utf-8"))
        self.assertEqual(old_digest, tree_digest(cleanup_target))
        self.assertTrue(Path(cleanup_journal["candidate"]).exists())
        self.assertTrue(journal_path_for_target(cleanup_target).exists())
        cleanup_events = [json.loads(line) for line in (cleanup_backups / AUDIT_FILENAME).read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(event["event"] == "switch_recovery_blocked" for event in cleanup_events))

    def test_next_new_snapshot_request_uses_recovery_context_then_switches(self):
        old = make_capsule(
            self.root / "next-request-old", snapshot="next_request_old", canonical=1,
            build_epoch="2026-08-26T00:00:00Z", content="next-old\n",
        )
        new = make_capsule(
            self.root / "next-request-new", snapshot="next_request_new", canonical=2,
            build_epoch="2026-08-26T01:00:00Z", content="next-new\n",
        )
        target = self.root / "next-request-mirror"
        backups = self.root / "next-request-backups"
        apply_capsule(old, target, backups, self.policy, "1" * 40)
        self._crash(
            capsule=new,
            target=target,
            backups=backups,
            crash_phase="after_prepared_journal",
            remote_head="2" * 40,
        )
        result = self._apply_process(
            capsule=new, target=target, backups=backups, remote_head="2" * 40
        )
        self.assertEqual("mirrored", result["status"])
        self.assertEqual("next-new\n", (target / "data.txt").read_text(encoding="utf-8"))
        self.assertFalse(journal_path_for_target(target).exists())
        events = [json.loads(line) for line in (backups / AUDIT_FILENAME).read_text(encoding="utf-8").splitlines()]
        self.assertTrue(any(
            event["event"] == "interrupted_switch_recovered"
            and event.get("outcome") == "prepared-target-lkg-preserved"
            for event in events
        ))
        self.assertTrue(any(
            event["event"] == "mirror_switched" and event.get("snapshot_version") == "next_request_new"
            for event in events
        ))


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
    elif len(sys.argv) > 1 and sys.argv[1] == "--crash-worker":
        worker_crash(Path(sys.argv[2]))
    elif len(sys.argv) > 1 and sys.argv[1] == "--recover-worker":
        worker_recover(Path(sys.argv[2]))
    elif len(sys.argv) > 1 and sys.argv[1] == "--hold-lock":
        with ExclusiveFileLock(Path(sys.argv[2]), timeout_seconds=10):
            Path(sys.argv[3]).write_text("ready\n", encoding="utf-8")
            time.sleep(float(sys.argv[4]))
    else:
        unittest.main()
