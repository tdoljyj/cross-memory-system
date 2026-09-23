#!/usr/bin/env python3
"""Publish only threshold-reaching CI health anomalies through one dedicated PR."""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


TRANSPORT_BRANCH = "automation/clued-ci-health-event"
TRANSPORT_PATH = ".github/ci-health-events/latest.json"
TRANSPORT_TITLE = "[Clued CI Health] anomaly event transport"
TRANSPORT_LABEL = "ci-health-anomaly-event"
PR_BODY = """<!-- clued-ci-health-event:v1 -->
This draft pull request is a machine-owned anomaly transport for Clued CI Health.

Only commit-update activity on this exact pull request, head branch, title, and label may enter the ChatGPT Work analysis path. Ordinary pull requests, reviews, comments, merges, and close/recovery activity must be ignored. The structured evidence is stored at `.github/ci-health-events/latest.json` on the PR head.

Do not merge this PR. It is closed automatically when the anomaly clears and reopened on a later anomaly episode.
"""


class GitHubClient:
    def __init__(self, token: str, api_url: str = "https://api.github.com") -> None:
        self.token = token
        self.api_url = api_url.rstrip("/")

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        allow_404: bool = False,
    ) -> dict[str, Any] | list[Any] | None:
        query = urllib.parse.urlencode(params or {})
        url = f"{self.api_url}{path}"
        if query:
            url = f"{url}?{query}"
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            url,
            data=data,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "User-Agent": "clued-ci-health-transport/1",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read()
                return json.loads(body) if body else None
        except urllib.error.HTTPError as exc:
            if allow_404 and exc.code == 404:
                return None
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"GitHub API {method} {path} failed ({exc.code}): {detail}") from exc


def decide_transport(
    report: dict[str, Any],
    current_report: dict[str, Any] | None,
    pr_state: str | None,
    force_event: bool = False,
) -> str:
    if report["status"] == "HEALTHY":
        return "RECOVER" if pr_state == "open" else "NOOP"
    if force_event:
        return "UPSERT"
    if (
        pr_state == "open"
        and current_report is not None
        and current_report.get("fingerprint") == report.get("fingerprint")
        and current_report.get("status") == "ANOMALY"
    ):
        return "NOOP"
    return "UPSERT"


def get_ref(client: GitHubClient, repository: str, branch: str) -> dict[str, Any] | None:
    encoded = urllib.parse.quote(branch, safe="/")
    result = client.request("GET", f"/repos/{repository}/git/ref/heads/{encoded}", allow_404=True)
    return result if isinstance(result, dict) else None


def get_pr(client: GitHubClient, repository: str, owner: str, branch: str) -> dict[str, Any] | None:
    result = client.request(
        "GET",
        f"/repos/{repository}/pulls",
        params={"state": "all", "head": f"{owner}:{branch}", "per_page": 100},
    )
    pulls = result if isinstance(result, list) else []
    return pulls[0] if pulls else None


def read_current_report(client: GitHubClient, repository: str, branch: str) -> dict[str, Any] | None:
    encoded_path = urllib.parse.quote(TRANSPORT_PATH, safe="/")
    result = client.request(
        "GET",
        f"/repos/{repository}/contents/{encoded_path}",
        params={"ref": branch},
        allow_404=True,
    )
    if not isinstance(result, dict) or "content" not in result:
        return None
    raw = base64.b64decode(result["content"])
    return json.loads(raw.decode("utf-8"))


def ensure_label(client: GitHubClient, repository: str) -> None:
    encoded = urllib.parse.quote(TRANSPORT_LABEL, safe="")
    existing = client.request(
        "GET",
        f"/repos/{repository}/labels/{encoded}",
        allow_404=True,
    )
    if existing is None:
        client.request("POST", f"/repos/{repository}/labels", {
            "name": TRANSPORT_LABEL,
            "color": "b60205",
            "description": "Machine-owned Clued CI health anomaly transport",
        })


def commit_report(
    client: GitHubClient,
    repository: str,
    base_branch: str,
    branch: str,
    report: dict[str, Any],
) -> None:
    ref = get_ref(client, repository, branch)
    if ref is None:
        base_ref = get_ref(client, repository, base_branch)
        if base_ref is None:
            raise RuntimeError(f"Base branch {base_branch} was not found")
        base_sha = base_ref["object"]["sha"]
        client.request("POST", f"/repos/{repository}/git/refs", {
            "ref": f"refs/heads/{branch}",
            "sha": base_sha,
        })
        ref = get_ref(client, repository, branch)
    if ref is None:
        raise RuntimeError("Transport branch creation did not produce a readable ref")

    parent_sha = ref["object"]["sha"]
    parent = client.request("GET", f"/repos/{repository}/git/commits/{parent_sha}")
    if not isinstance(parent, dict):
        raise RuntimeError("Transport parent commit was not readable")
    content = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    blob = client.request("POST", f"/repos/{repository}/git/blobs", {
        "content": content,
        "encoding": "utf-8",
    })
    tree = client.request("POST", f"/repos/{repository}/git/trees", {
        "base_tree": parent["tree"]["sha"],
        "tree": [{
            "path": TRANSPORT_PATH,
            "mode": "100644",
            "type": "blob",
            "sha": blob["sha"],
        }],
    })
    commit = client.request("POST", f"/repos/{repository}/git/commits", {
        "message": f"[skip ci] ci-health: publish anomaly {report['fingerprint'][:12]}",
        "tree": tree["sha"],
        "parents": [parent_sha],
    })
    client.request("PATCH", f"/repos/{repository}/git/refs/heads/{urllib.parse.quote(branch, safe='/')}", {
        "sha": commit["sha"],
        "force": False,
    })


def write_outputs(action: str, pr_number: int | None) -> None:
    output_path = os.environ.get("GITHUB_OUTPUT")
    if not output_path:
        return
    with open(output_path, "a", encoding="utf-8") as handle:
        handle.write(f"transport_action={action}\n")
        handle.write(f"pr_number={pr_number or ''}\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY", "tdoljyj/cross-memory-system"))
    parser.add_argument("--base-branch", default="main")
    parser.add_argument("--branch", default=TRANSPORT_BRANCH)
    parser.add_argument(
        "--force-event",
        action="store_true",
        help="Publish one commit update even when the current anomaly fingerprint is unchanged.",
    )
    args = parser.parse_args()

    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        raise RuntimeError("GITHUB_TOKEN is required")
    report = json.loads(args.report.read_text(encoding="utf-8"))
    if report.get("schema") != "clued.ci-health-report/v1":
        raise RuntimeError("Unexpected CI health report schema")

    owner = args.repository.split("/", 1)[0]
    client = GitHubClient(token, os.environ.get("GITHUB_API_URL", "https://api.github.com"))
    pr = get_pr(client, args.repository, owner, args.branch)
    current_report = read_current_report(client, args.repository, args.branch)
    previous_pr_state = pr.get("state") if pr else None
    action = decide_transport(report, current_report, previous_pr_state, args.force_event)

    if action == "NOOP":
        write_outputs(action, pr.get("number") if pr else None)
        print(json.dumps({"action": action, "pr_number": pr.get("number") if pr else None}))
        return 0

    if action == "RECOVER":
        client.request("PATCH", f"/repos/{args.repository}/pulls/{pr['number']}", {"state": "closed"})
        write_outputs(action, pr["number"])
        print(json.dumps({"action": action, "pr_number": pr["number"]}))
        return 0

    if pr is not None and pr["state"] != "open":
        pr = client.request("PATCH", f"/repos/{args.repository}/pulls/{pr['number']}", {
            "state": "open",
            "body": PR_BODY,
        })

    should_commit = (
        args.force_event
        or previous_pr_state == "closed"
        or current_report is None
        or current_report.get("fingerprint") != report.get("fingerprint")
    )
    if should_commit:
        commit_report(client, args.repository, args.base_branch, args.branch, report)

    if pr is None:
        created = client.request("POST", f"/repos/{args.repository}/pulls", {
            "title": TRANSPORT_TITLE,
            "head": args.branch,
            "base": args.base_branch,
            "body": PR_BODY,
            "draft": True,
        })
        pr = created

    ensure_label(client, args.repository)
    client.request("POST", f"/repos/{args.repository}/issues/{pr['number']}/labels", {
        "labels": [TRANSPORT_LABEL],
    })
    write_outputs(action, pr["number"])
    print(json.dumps({"action": action, "pr_number": pr["number"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
