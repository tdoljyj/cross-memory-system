#!/usr/bin/env python3
"""Keep git tags in step with the root VERSION and with production releases.

Task 6dfd7560 (item 6). Two kinds of annotated tag, both created only by the
clued-release-tags workflow:

* Product version tag. Its name is exactly the content of the root VERSION
  file (for example `Clued-v1.6`) and it points at the commit on main that set
  VERSION to that value. This is the convention the older `vNext-1.3` and
  `vNext-2.0` tags already follow.
* Release tag, `release/<YYYY-MM-DD>-r<run number>`, on the commit a successful
  production deploy (clued-cloud-production-release.yml, its "Deploy Clued
  production Worker" step) put live. Its message names the VERSION and the
  component versions of config/clued-components.json at that commit, and the
  run.

    python3 scripts/ci/clued_release_tags.py check [--ref HEAD]
    python3 scripts/ci/clued_release_tags.py product [--ref <sha>] [--apply]
    python3 scripts/ci/clued_release_tags.py release --run-id <id> [--apply]

Without --apply the planned tag is printed and nothing is written. A tag that
already exists on the same commit is left alone; one on another commit is an
error, never moved.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RELEASE_WORKFLOW = ".github/workflows/clued-cloud-production-release.yml"
DEPLOY_STEP = "Deploy Clued production Worker"
TAG_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
SHA = re.compile(r"^[0-9a-f]{40}$")
TAGGER = ("clued-release-tags", "clued-release-tags@users.noreply.github.com")


class TagError(RuntimeError):
    pass


@dataclass
class Plan:
    name: str
    target: str
    message: str


def git(*args: str, root: Path = ROOT, check: bool = True) -> str:
    result = subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise TagError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout.strip() if result.returncode == 0 else ""


def resolve(ref: str, root: Path = ROOT) -> str:
    return git("rev-parse", "--verify", f"{ref}^{{commit}}", root=root)


def version_at(sha: str, root: Path = ROOT) -> str:
    version = git("show", f"{sha}:VERSION", root=root).strip()
    if not TAG_NAME.match(version):
        raise TagError(f"VERSION {version!r} at {sha[:12]} is not a valid tag name")
    return version


def existing_target(name: str, root: Path = ROOT) -> str | None:
    out = git("rev-parse", "--verify", "--quiet", f"refs/tags/{name}^{{commit}}", root=root, check=False)
    return out or None


def product_plan(ref: str = "HEAD", root: Path = ROOT) -> Plan:
    """The product tag for the VERSION at ref: on the commit that last set VERSION."""
    sha = resolve(ref, root)
    version = version_at(sha, root)
    setter = git("log", "-1", "--format=%H", sha, "--", "VERSION", root=root)
    if not setter:
        raise TagError(f"no commit at or before {sha[:12]} touches VERSION")
    return Plan(version, setter, f"{version}\n\nRoot VERSION set to {version} in {setter}.")


def component_versions(sha: str, root: Path = ROOT) -> dict[str, str]:
    text = git("show", f"{sha}:config/clued-components.json", root=root, check=False)
    if not text:
        return {}
    try:
        return {c["id"]: str(c["version"]) for c in json.loads(text).get("components", [])}
    except (ValueError, KeyError, TypeError):
        return {}


def github(path: str, token: str, repository: str) -> dict:
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repository}{path}",
        headers={"authorization": f"Bearer {token}", "accept": "application/vnd.github+json",
                 "x-github-api-version": "2022-11-28"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode())


def release_plan(run: dict, jobs: list[dict], root: Path = ROOT) -> Plan | None:
    """The release tag for a production release run, or None when the run did not deploy."""
    if run.get("path") != RELEASE_WORKFLOW:
        raise TagError(f"run {run.get('id')} is {run.get('path')!r}, not {RELEASE_WORKFLOW}")
    if run.get("conclusion") != "success":
        raise TagError(f"run {run.get('id')} concluded {run.get('conclusion')!r}, not success")
    if run.get("head_branch") != "main" or run.get("event") != "workflow_dispatch":
        raise TagError(f"run {run.get('id')} is a {run.get('event')} on {run.get('head_branch')!r}, "
                       "not a dispatch on main")
    deployed = [step for job in jobs for step in job.get("steps") or []
                if step.get("name") == DEPLOY_STEP and step.get("conclusion") == "success"]
    if not deployed:
        return None  # preflight, backup, migrate or source-capture: nothing went live
    sha = str(run.get("head_sha", ""))
    if not SHA.match(sha):
        raise TagError(f"run {run.get('id')} has no full head SHA")
    if subprocess.run(["git", "merge-base", "--is-ancestor", sha, "origin/main"], cwd=root).returncode != 0:
        raise TagError(f"{sha[:12]} is not on origin/main")
    finished = str(deployed[-1].get("completed_at") or run.get("updated_at") or "")
    date = finished[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", finished) else "unknown-date"
    name = f"release/{date}-r{run['run_number']}"
    components = component_versions(sha, root)
    lines = [name, "", f"Production deploy of {sha}.",
             f"Run: {run.get('html_url')} (run {run.get('id')}, attempt {run.get('run_attempt', 1)})",
             f"Deployed: {finished}", f"VERSION: {version_at(sha, root)}"]
    if components:
        lines += ["", "Components:"] + [f"  {cid} {version}" for cid, version in components.items()]
    return Plan(name, sha, "\n".join(lines))


def apply(plan: Plan, push: bool, root: Path = ROOT) -> str:
    current = existing_target(plan.name, root)
    if current == plan.target:
        return f"{plan.name} already on {plan.target[:12]}"
    if current:
        raise TagError(f"tag {plan.name} is on {current[:12]}, not {plan.target[:12]}; tags are never moved")
    env = {**os.environ, "GIT_COMMITTER_NAME": TAGGER[0], "GIT_COMMITTER_EMAIL": TAGGER[1]}
    subprocess.run(["git", "tag", "-a", plan.name, plan.target, "-F", "-"], cwd=root, input=plan.message,
                   text=True, check=True, env=env)
    if push:
        pushed = subprocess.run(["git", "push", "origin", f"refs/tags/{plan.name}"], cwd=root,
                                capture_output=True, text=True)
        if pushed.returncode != 0:
            subprocess.run(["git", "tag", "-d", plan.name], cwd=root, capture_output=True)
            raise TagError(f"pushing {plan.name} failed: {pushed.stderr.strip()}")
    return f"created {plan.name} on {plan.target[:12]}" + (" and pushed" if push else "")


def check(ref: str = "HEAD", root: Path = ROOT) -> list[str]:
    """VERSION is a valid tag name and its tag, if any, is on the commit that set it."""
    try:
        plan = product_plan(ref, root)
    except TagError as error:
        return [str(error)]
    current = existing_target(plan.name, root)
    if current and current != plan.target:
        return [f"tag {plan.name} is on {current[:12]} but VERSION became {plan.name} in {plan.target[:12]}; "
                "a new product version needs a new VERSION value"]
    return []


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    checker = sub.add_parser("check")
    checker.add_argument("--ref", default="HEAD")
    product = sub.add_parser("product")
    product.add_argument("--ref", default="HEAD")
    product.add_argument("--apply", action="store_true")
    release = sub.add_parser("release")
    release.add_argument("--run-id", required=True)
    release.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    try:
        if args.command == "check":
            problems = check(args.ref)
            for problem in problems:
                print(f"clued-release-tags: {problem}", file=sys.stderr)
            if not problems:
                print("clued-release-tags: VERSION and its tag agree")
            return 1 if problems else 0
        if args.command == "product":
            plan = product_plan(args.ref)
        else:
            if not re.match(r"^\d{1,20}$", args.run_id):
                raise TagError("--run-id must be a number")
            token, repository = os.environ.get("GITHUB_TOKEN", ""), os.environ.get("GITHUB_REPOSITORY", "")
            if not token or not repository:
                raise TagError("GITHUB_TOKEN and GITHUB_REPOSITORY are required")
            run = github(f"/actions/runs/{args.run_id}", token, repository)
            jobs = github(f"/actions/runs/{args.run_id}/jobs?per_page=100", token, repository).get("jobs", [])
            plan = release_plan(run, jobs)
            if plan is None:
                print(f"clued-release-tags: run {args.run_id} did not deploy; no release tag")
                return 0
        print(f"clued-release-tags: {plan.name} -> {plan.target}\n{plan.message}")
        if args.apply:
            print(f"clued-release-tags: {apply(plan, push=True)}")
        return 0
    except TagError as error:
        print(f"clued-release-tags: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
