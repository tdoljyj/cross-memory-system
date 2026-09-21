"""Observe one server-configured GitHub ref without changing Clued Current.

This is a non-production, read-only provider candidate. An observation is not
an Adoption, a canonical Drift record, or a G6 acceptance result.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener


_SHA = re.compile(r"[0-9a-f]{40}\Z")
_REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
_REF = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}\Z")


class ProviderUnavailable(Exception):
    """No trustworthy provider observation could be made."""


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, new_url):
        return None


class GitHubReadOnlyProvider:
    def __init__(self, repository: str, ref: str, token: str = "", *, api_get=None):
        if not _REPO.fullmatch(repository) or ".." in repository:
            raise ValueError("GitHub repository binding rejected")
        if (not _REF.fullmatch(ref) or ".." in ref or "//" in ref
                or ref.endswith("/") or ref.endswith(".lock")):
            raise ValueError("GitHub ref binding rejected")
        self.repository = repository
        self.ref = ref
        self._token = token
        self._api_get = api_get or self._github_get
        self._opener = build_opener(_NoRedirects())

    def _github_get(self, path: str) -> dict:
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "Clued-MPS04-ReadOnly",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if self._token:
            headers["Authorization"] = "Bearer " + self._token
        req = Request("https://api.github.com" + path, headers=headers, method="GET")
        try:
            with self._opener.open(req, timeout=10) as response:
                raw = response.read(1_048_577)
        except (HTTPError, URLError, TimeoutError, OSError) as error:
            raise ProviderUnavailable("GitHub observation unavailable") from error
        if len(raw) > 1_048_576:
            raise ProviderUnavailable("GitHub observation too large")
        try:
            value = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeError) as error:
            raise ProviderUnavailable("GitHub observation invalid") from error
        if not isinstance(value, dict):
            raise ProviderUnavailable("GitHub observation invalid")
        return value

    def observe(self, adopted_exact_commit: str) -> dict:
        if not isinstance(adopted_exact_commit, str) or not _SHA.fullmatch(adopted_exact_commit):
            raise ProviderUnavailable("Clued adopted exact commit is missing")
        owner, name = self.repository.split("/", 1)
        base = f"/repos/{quote(owner)}/{quote(name)}"
        branch = self._api_get(base + "/branches/" + quote(self.ref, safe=""))
        commit = branch.get("commit") if isinstance(branch, dict) else None
        head = commit.get("sha") if isinstance(commit, dict) else None
        if not isinstance(head, str) or not _SHA.fullmatch(head):
            raise ProviderUnavailable("GitHub branch head is not an exact commit")
        if head == adopted_exact_commit:
            status, changed_files, paths = "identical", 0, []
        else:
            comparison = self._api_get(
                base + "/compare/" + adopted_exact_commit + "..." + head
            )
            if not isinstance(comparison, dict):
                raise ProviderUnavailable("GitHub comparison is invalid")
            status = comparison.get("status")
            if status not in {"ahead", "behind", "diverged"}:
                raise ProviderUnavailable("GitHub ancestry is unverified")
            changed_files = comparison.get("files")
            if not isinstance(changed_files, list):
                raise ProviderUnavailable("GitHub comparison has no file evidence")
            paths = []
            for item in changed_files[:10]:
                filename = item.get("filename") if isinstance(item, dict) else None
                if isinstance(filename, str):
                    paths.append(filename)
        identity = {
            "repository": self.repository,
            "ref": self.ref,
            "clued_adopted_exact_commit": adopted_exact_commit,
            "provider_exact_commit": head,
            "ancestry": status,
        }
        digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        web = "https://github.com/" + self.repository
        return {
            "ok": True,
            "kind": "GITHUB_READ_ONLY_OBSERVATION",
            **identity,
            "drift": head != adopted_exact_commit,
            "changed_file_sample": paths,
            "changed_file_sample_truncated": isinstance(changed_files, list) and len(changed_files) > len(paths),
            "source_commit_url": web + "/commit/" + head,
            "source_compare_url": web + "/compare/" + adopted_exact_commit + "..." + head,
            "observation_digest": digest,
            "observed_at": datetime.now(timezone.utc).isoformat(),
            "persistence": "NOT_REGISTERED_CANDIDATE_ONLY",
            "clued_current_changed": False,
        }
