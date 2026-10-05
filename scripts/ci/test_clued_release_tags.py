"""Tests for scripts/ci/clued_release_tags.py (Task 6dfd7560, item 6)."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import clued_release_tags as rt  # noqa: E402

IDENTITY = ["-c", "user.email=t@t", "-c", "user.name=t"]


class Repo:
    def __init__(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="clued-release-tags-"))
        self.git("init", "-q", "-b", "main")
        self.commits: dict[str, str] = {}

    def git(self, *args: str) -> str:
        return subprocess.run(["git", *IDENTITY, *args], cwd=self.dir, check=True,
                              capture_output=True, text=True).stdout.strip()

    def commit(self, label: str, files: dict[str, str]) -> str:
        for name, text in files.items():
            path = self.dir / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-qm", label)
        sha = self.git("rev-parse", "HEAD")
        self.commits[label] = sha
        self.git("update-ref", "refs/remotes/origin/main", sha)
        return sha

    def close(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


def manifest(**versions: str) -> str:
    return json.dumps({"schema": "clued.components/1",
                       "components": [{"id": k, "version": v} for k, v in versions.items()]})


def run_payload(sha: str, **overrides) -> dict:
    payload = {"id": 37284642120, "run_number": 247, "run_attempt": 1, "path": rt.RELEASE_WORKFLOW,
               "conclusion": "success", "head_branch": "main", "event": "workflow_dispatch",
               "head_sha": sha, "html_url": "https://github.com/o/r/actions/runs/37284642120",
               "updated_at": "2026-10-05T08:39:35Z"}
    payload.update(overrides)
    return payload


def jobs(deploy: str = "success") -> list[dict]:
    return [{"steps": [{"name": "Consume the Owner Grant for this commit", "conclusion": "success"},
                       {"name": rt.DEPLOY_STEP, "conclusion": deploy,
                        "completed_at": "2026-10-05T08:38:28Z"}]}]


class ProductTagTest(unittest.TestCase):
    def setUp(self):
        self.repo = Repo()
        self.addCleanup(self.repo.close)
        self.repo.commit("v13", {"VERSION": "vNext-1.3\n"})
        self.repo.commit("work", {"a.txt": "1"})
        self.repo.commit("v16", {"VERSION": "Clued-v1.6\n"})
        self.repo.commit("later", {"a.txt": "2"})

    def test_tag_names_the_version_and_points_at_the_commit_that_set_it(self):
        plan = rt.product_plan("HEAD", self.repo.dir)
        self.assertEqual((plan.name, plan.target), ("Clued-v1.6", self.repo.commits["v16"]))
        old = rt.product_plan(self.repo.commits["work"], self.repo.dir)
        self.assertEqual((old.name, old.target), ("vNext-1.3", self.repo.commits["v13"]))

    def test_apply_creates_an_annotated_tag_once(self):
        plan = rt.product_plan("HEAD", self.repo.dir)
        self.assertIn("created Clued-v1.6", rt.apply(plan, push=False, root=self.repo.dir))
        self.assertEqual(self.repo.git("cat-file", "-t", "Clued-v1.6"), "tag")
        self.assertIn("already on", rt.apply(plan, push=False, root=self.repo.dir))
        self.assertEqual(rt.check("HEAD", self.repo.dir), [])

    def test_a_tag_on_another_commit_is_never_moved(self):
        self.repo.git("tag", "Clued-v1.6", self.repo.commits["work"])
        plan = rt.product_plan("HEAD", self.repo.dir)
        with self.assertRaises(rt.TagError):
            rt.apply(plan, push=False, root=self.repo.dir)
        self.assertEqual(len(rt.check("HEAD", self.repo.dir)), 1)

    def test_push_sends_the_tag_and_a_refused_push_leaves_no_local_tag(self):
        remote = Path(tempfile.mkdtemp(prefix="clued-release-tags-remote-"))
        self.addCleanup(shutil.rmtree, remote, True)
        self.repo.git("remote", "add", "origin", str(remote / "missing.git"))
        plan = rt.product_plan("HEAD", self.repo.dir)
        with self.assertRaisesRegex(rt.TagError, "pushing Clued-v1.6 failed: .+"):
            rt.apply(plan, push=True, root=self.repo.dir)
        self.assertIsNone(rt.existing_target("Clued-v1.6", self.repo.dir))
        subprocess.run(["git", "init", "-q", "--bare", str(remote / "missing.git")], check=True)
        self.assertIn("and pushed", rt.apply(plan, push=True, root=self.repo.dir))
        pushed = subprocess.run(["git", "rev-parse", "Clued-v1.6^{commit}"], cwd=remote / "missing.git",
                                check=True, capture_output=True, text=True).stdout.strip()
        self.assertEqual(pushed, self.repo.commits["v16"])

    def test_version_must_be_a_valid_tag_name(self):
        self.repo.commit("bad", {"VERSION": "Clued v1.7\n"})
        problems = rt.check("HEAD", self.repo.dir)
        self.assertTrue(problems and "not a valid tag name" in problems[0], problems)


class ReleaseTagTest(unittest.TestCase):
    def setUp(self):
        self.repo = Repo()
        self.addCleanup(self.repo.close)
        self.sha = self.repo.commit("release", {
            "VERSION": "Clued-v1.6\n",
            "config/clued-components.json": manifest(**{"skill.clued": "1.0.0", "mcp.server": "0.4.0"})})

    def test_successful_deploy_gets_a_dated_release_tag_with_versions(self):
        plan = rt.release_plan(run_payload(self.sha), jobs(), self.repo.dir)
        self.assertEqual((plan.name, plan.target), ("release/2026-10-05-r247", self.sha))
        for text in ("VERSION: Clued-v1.6", "skill.clued 1.0.0", "mcp.server 0.4.0", "runs/37284642120"):
            self.assertIn(text, plan.message)
        self.assertIn("created release/2026-10-05-r247", rt.apply(plan, push=False, root=self.repo.dir))

    def test_runs_that_did_not_deploy_get_no_tag(self):
        self.assertIsNone(rt.release_plan(run_payload(self.sha), jobs(deploy="skipped"), self.repo.dir))

    def test_failed_foreign_or_off_main_runs_are_refused(self):
        for bad in ({"conclusion": "failure"}, {"path": ".github/workflows/other.yml"},
                    {"head_branch": "feature"}, {"event": "push"}):
            with self.subTest(bad=bad), self.assertRaises(rt.TagError):
                rt.release_plan(run_payload(self.sha, **bad), jobs(), self.repo.dir)

    def test_commit_must_be_on_main(self):
        self.repo.git("checkout", "-qb", "side")
        side = self.repo.commit("side", {"b.txt": "x"})
        self.repo.git("update-ref", "refs/remotes/origin/main", self.sha)
        with self.assertRaises(rt.TagError):
            rt.release_plan(run_payload(side), jobs(), self.repo.dir)


if __name__ == "__main__":
    unittest.main()
