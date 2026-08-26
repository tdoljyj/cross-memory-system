import contextlib
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from verification_context import RequestVerificationContext


ROOT = Path(__file__).resolve().parents[1]
SYNC_PATH = ROOT / "sync-memory.py"
REMOTE_SHA = "1" * 40
LOCAL_SHA = "0" * 40


def load_sync_module():
    spec = importlib.util.spec_from_file_location("sync_memory_p1", SYNC_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def completed(stdout="", returncode=0, stderr=""):
    return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=returncode)


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted((p for p in root.rglob("*") if p.is_file()), key=lambda item: item.as_posix()):
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


class F01SingleRemoteHeadQuery(unittest.TestCase):
    def setUp(self):
        self.sync = load_sync_module()

    def test_each_request_queries_once_and_reuses_concrete_sha(self):
        calls = []
        mirrored = []

        def fake_run(*args, check=True):
            calls.append(args)
            if args[:3] == ("git", "status", "--porcelain"):
                return completed()
            if args[:2] == ("git", "ls-remote"):
                return completed(f"{REMOTE_SHA}\trefs/heads/main\n")
            if args[:3] == ("git", "rev-parse", "HEAD"):
                return completed(REMOTE_SHA + "\n")
            raise AssertionError(f"unexpected command: {args}")

        with mock.patch.object(self.sync, "run", side_effect=fake_run), mock.patch.object(
            self.sync, "mirror", side_effect=lambda remote_sha=None, context=None: mirrored.append(remote_sha)
        ):
            self.assertEqual(0, self.sync.cmd_align_and_verify("PROJECT"))
            self.assertEqual(0, self.sync.cmd_align_and_verify("PROJECT"))

        ls_remote = [call for call in calls if call[:2] == ("git", "ls-remote")]
        self.assertEqual(2, len(ls_remote), "two independent requests must each query once")
        self.assertEqual([REMOTE_SHA, REMOTE_SHA], mirrored)

    def test_query_failure_blocks_without_old_result_fallback(self):
        mirrored = []

        def fake_run(*args, check=True):
            if args[:3] == ("git", "status", "--porcelain"):
                return completed()
            if args[:2] == ("git", "ls-remote"):
                raise RuntimeError("transport unavailable")
            raise AssertionError(f"unexpected command: {args}")

        with mock.patch.object(self.sync, "run", side_effect=fake_run), mock.patch.object(
            self.sync, "mirror", side_effect=lambda remote_sha=None, context=None: mirrored.append(remote_sha)
        ):
            with self.assertRaisesRegex(RuntimeError, "remote unavailable"):
                self.sync.cmd_align_and_verify("PROJECT")
        self.assertEqual([], mirrored)

    def test_remote_ahead_fetch_and_merge_consume_the_resolved_sha(self):
        calls = []

        def fake_run(*args, check=True):
            calls.append(args)
            if args[:3] == ("git", "status", "--porcelain"):
                return completed()
            if args[:2] == ("git", "ls-remote"):
                return completed(f"{REMOTE_SHA}\trefs/heads/main\n")
            if args[:3] == ("git", "rev-parse", "HEAD"):
                return completed(LOCAL_SHA + "\n")
            if args[:3] == ("git", "fetch", "origin"):
                return completed()
            if args[:3] == ("git", "rev-parse", "FETCH_HEAD"):
                return completed(REMOTE_SHA + "\n")
            if args[:3] == ("git", "merge-base", "--is-ancestor"):
                return completed(returncode=0)
            if "merge" in args:
                return completed()
            raise AssertionError(f"unexpected command: {args}")

        with mock.patch.object(self.sync, "run", side_effect=fake_run):
            self.assertEqual(REMOTE_SHA, self.sync.align_and_verify())

        self.assertIn(("git", "fetch", "origin", REMOTE_SHA), calls)
        merge_calls = [call for call in calls if "merge" in call]
        self.assertEqual(REMOTE_SHA, merge_calls[0][-1])
        self.assertNotIn("FETCH_HEAD", merge_calls[0])

    def test_malformed_remote_ref_fails_closed(self):
        with mock.patch.object(self.sync, "run", return_value=completed("not-a-sha\trefs/heads/main\n")):
            with self.assertRaisesRegex(RuntimeError, "concrete commit SHA"):
                self.sync.resolve_remote_head()

    def test_none_remains_zero_git_and_zero_mirror(self):
        with mock.patch.object(self.sync, "run") as run_mock, mock.patch.object(self.sync, "mirror") as mirror_mock:
            self.assertEqual(0, self.sync.cmd_align_and_verify("NONE"))
        run_mock.assert_not_called()
        mirror_mock.assert_not_called()


class GitAlignmentNegativeRegression(unittest.TestCase):
    def setUp(self):
        self.sync = load_sync_module()
        self.temp = tempfile.TemporaryDirectory(prefix="clued-p1-git-")
        self.root = Path(self.temp.name)
        self.seed = self.root / "seed"
        self.origin = self.root / "origin.git"
        self.endpoint = self.root / "endpoint"
        self.publisher = self.root / "publisher"
        self._git("init", "-b", "main", str(self.seed), cwd=self.root)
        self._git("config", "user.name", "P1-Fixture", cwd=self.seed)
        self._git("config", "user.email", "fixture@example.invalid", cwd=self.seed)
        (self.seed / "state.txt").write_text("base\n", encoding="utf-8")
        self._git("add", "state.txt", cwd=self.seed)
        self._git("commit", "-m", "base", cwd=self.seed)
        self._git("clone", "--bare", str(self.seed), str(self.origin), cwd=self.root)
        self._git("clone", str(self.origin), str(self.endpoint), cwd=self.root)
        self._git("clone", str(self.origin), str(self.publisher), cwd=self.root)
        for repo in (self.endpoint, self.publisher):
            self._git("config", "user.name", "P1-Fixture", cwd=repo)
            self._git("config", "user.email", "fixture@example.invalid", cwd=repo)

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def _git(*args, cwd):
        return subprocess.run(["git", *args], cwd=cwd, text=True, encoding="utf-8", errors="replace", capture_output=True, check=True)

    def _publish_remote_ahead(self):
        (self.publisher / "remote.txt").write_text("remote\n", encoding="utf-8")
        self._git("add", "remote.txt", cwd=self.publisher)
        self._git("commit", "-m", "remote ahead", cwd=self.publisher)
        self._git("push", "origin", "main", cwd=self.publisher)
        return self._git("rev-parse", "HEAD", cwd=self.publisher).stdout.strip()

    def test_real_remote_ahead_uses_one_query_and_fast_forwards(self):
        remote_sha = self._publish_remote_ahead()
        observed = []
        original_run = self.sync.run

        def recording_run(*args, **kwargs):
            observed.append(args)
            return original_run(*args, **kwargs)

        with mock.patch.object(self.sync, "REPO", self.endpoint), mock.patch.object(self.sync, "run", side_effect=recording_run):
            self.assertEqual(remote_sha, self.sync.align_and_verify())
        self.assertEqual(1, sum(call[:2] == ("git", "ls-remote") for call in observed))
        self.assertEqual(remote_sha, self._git("rev-parse", "HEAD", cwd=self.endpoint).stdout.strip())

    def test_dirty_worktree_still_blocks_before_remote_query(self):
        (self.endpoint / "state.txt").write_text("dirty\n", encoding="utf-8")
        observed = []
        original_run = self.sync.run

        def recording_run(*args, **kwargs):
            observed.append(args)
            return original_run(*args, **kwargs)

        with mock.patch.object(self.sync, "REPO", self.endpoint), mock.patch.object(self.sync, "run", side_effect=recording_run):
            with self.assertRaisesRegex(RuntimeError, "worktree is dirty"):
                self.sync.align_and_verify()
        self.assertEqual(0, sum(call[:2] == ("git", "ls-remote") for call in observed))

    def test_unavailable_remote_still_blocks(self):
        self._git("remote", "set-url", "origin", str(self.root / "missing.git"), cwd=self.endpoint)
        with mock.patch.object(self.sync, "REPO", self.endpoint):
            with self.assertRaisesRegex(RuntimeError, "remote unavailable"):
                self.sync.align_and_verify()

    def test_real_divergence_remains_distinct_and_blocks(self):
        (self.endpoint / "local.txt").write_text("local\n", encoding="utf-8")
        self._git("add", "local.txt", cwd=self.endpoint)
        self._git("commit", "-m", "local", cwd=self.endpoint)
        self._publish_remote_ahead()
        with mock.patch.object(self.sync, "REPO", self.endpoint):
            with self.assertRaisesRegex(RuntimeError, "local and origin/main diverged"):
                self.sync.align_and_verify()


class ManifestBoundaryRegression(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("memory_p1", ROOT / "memory.py")
        cls.memory_cli = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(cls.memory_cli)

    def setUp(self):
        self.sync = load_sync_module()
        self.temp = tempfile.TemporaryDirectory(prefix="clued-p1-integrity-")
        self.root = Path(self.temp.name)
        self.fixture_repo = self.root / "repo"
        self.fixture_repo.mkdir()
        shutil.copytree(ROOT / "memory", self.fixture_repo / "memory")
        self.target = self.root / "endpoint" / "memory"
        self.target.parent.mkdir()
        shutil.copytree(ROOT / "memory", self.target)
        self.backup_root = self.root / "backups"
        self.current_pointer = ROOT / "artifacts" / "clued-two-level-snapshots" / "current.json"
        self.pointer_before = hashlib.sha256(self.current_pointer.read_bytes()).hexdigest()
        self.target_before = tree_digest(self.target)
        manifest = json.loads((self.fixture_repo / "memory" / "manifest.json").read_text(encoding="utf-8"))
        self.manifest_file = Path(manifest["files"][0]["path"])

    def tearDown(self):
        self.temp.cleanup()

    def _patch_fixture(self):
        return contextlib.ExitStack()

    def _enter_fixture_patches(self, stack):
        stack.enter_context(mock.patch.object(self.sync, "REPO", self.fixture_repo))
        stack.enter_context(mock.patch.object(self.sync, "LOCAL_MEMORY", self.target))
        stack.enter_context(mock.patch.object(self.sync, "validate", side_effect=self.memory_cli.validate_bundle))
        stack.enter_context(mock.patch.dict(os.environ, {"CROSS_MEMORY_BACKUP_DIR": str(self.backup_root)}))

    def _assert_lkg_unchanged_and_valid(self):
        self.assertEqual(self.target_before, tree_digest(self.target))
        self.assertEqual(self.pointer_before, hashlib.sha256(self.current_pointer.read_bytes()).hexdigest())
        _, errors = self.memory_cli.validate_bundle(self.target)
        self.assertEqual([], errors)
        backups = list(self.backup_root.glob("memory-[0-9]*")) if self.backup_root.exists() else []
        self.assertEqual([], backups)

    def _p2_context(self):
        return RequestVerificationContext(
            "REPO_IMPLEMENT",
            repository_root=self.fixture_repo,
            pointer_path=self.current_pointer,
            version_path=ROOT / "VERSION",
            remote_head=REMOTE_SHA,
        )

    def test_f05_source_hash_failure_blocks_before_copy(self):
        source_file = self.fixture_repo / "memory" / self.manifest_file
        source_file.write_bytes(source_file.read_bytes() + b"\ncorrupted")
        output = io.StringIO()
        with self._patch_fixture() as stack:
            self._enter_fixture_patches(stack)
            stack.enter_context(contextlib.redirect_stdout(output))
            with self.assertRaisesRegex(RuntimeError, "canonical snapshot invalid"):
                self.sync.mirror(REMOTE_SHA)
        self.assertEqual("", output.getvalue())
        self._assert_lkg_unchanged_and_valid()
        self.assertFalse(self.backup_root.exists())

    def test_f05_p2_context_preserves_source_rejection(self):
        source_file = self.fixture_repo / "memory" / self.manifest_file
        source_file.write_bytes(source_file.read_bytes() + b"\ncorrupted")
        with self._patch_fixture() as stack:
            self._enter_fixture_patches(stack)
            with self.assertRaisesRegex(RuntimeError, "canonical snapshot invalid"):
                self.sync.mirror(REMOTE_SHA, self._p2_context())
        self._assert_lkg_unchanged_and_valid()
        self.assertFalse(self.backup_root.exists())

    def test_f06_post_copy_corruption_fails_target_validation(self):
        real_copytree = shutil.copytree

        def corrupting_copytree(source, destination, *args, **kwargs):
            result = real_copytree(source, destination, *args, **kwargs)
            copied_file = Path(destination) / self.manifest_file
            copied_file.write_bytes(copied_file.read_bytes() + b"\ncorrupted-after-copy")
            return result

        output = io.StringIO()
        with self._patch_fixture() as stack:
            self._enter_fixture_patches(stack)
            fixture_shutil = SimpleNamespace(copytree=corrupting_copytree, rmtree=shutil.rmtree)
            stack.enter_context(mock.patch.object(self.sync, "shutil", fixture_shutil))
            stack.enter_context(contextlib.redirect_stdout(output))
            with self.assertRaisesRegex(RuntimeError, "local candidate invalid"):
                self.sync.mirror(REMOTE_SHA)
        self.assertEqual("", output.getvalue())
        self._assert_lkg_unchanged_and_valid()
        self.assertEqual([], list(self.backup_root.glob("memory-next-*")))

    def test_f06_p2_context_preserves_target_rejection(self):
        real_copytree = shutil.copytree

        def corrupting_copytree(source, destination, *args, **kwargs):
            result = real_copytree(source, destination, *args, **kwargs)
            copied_file = Path(destination) / self.manifest_file
            copied_file.write_bytes(copied_file.read_bytes() + b"\ncorrupted-after-copy")
            return result

        with self._patch_fixture() as stack:
            self._enter_fixture_patches(stack)
            fixture_shutil = SimpleNamespace(copytree=corrupting_copytree, rmtree=shutil.rmtree)
            stack.enter_context(mock.patch.object(self.sync, "shutil", fixture_shutil))
            with self.assertRaisesRegex(RuntimeError, "local candidate invalid"):
                self.sync.mirror(REMOTE_SHA, self._p2_context())
        self._assert_lkg_unchanged_and_valid()
        self.assertEqual([], list(self.backup_root.glob("memory-next-*")))


class UnifiedEntryContract(unittest.TestCase):
    def test_consumer_contract_uses_unified_entry_without_external_preflight(self):
        agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
        ps1 = (ROOT / "sync-memory.ps1").read_text(encoding="utf-8")
        self.assertIn("-AlignAndVerify", agents)
        self.assertNotIn("Check `git ls-remote origin main`", agents)
        self.assertIn('@("align-and-verify", $Access)', ps1)

    def test_post_push_remote_verification_is_retained(self):
        source = SYNC_PATH.read_text(encoding="utf-8")
        self.assertIn('remote_after = run("git", "ls-remote", "origin", "refs/heads/main")', source)
        self.assertIn('run("git", "merge-base", "--is-ancestor", head_after, remote_after', source)


if __name__ == "__main__":
    unittest.main()
