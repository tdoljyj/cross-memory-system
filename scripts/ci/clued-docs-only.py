"""A narrow documentation qualification; unknown input requires full app checks."""
import json
import os
from pathlib import Path
import re
import subprocess

SHA = re.compile(r"[a-f0-9]{40}\Z")
BLOCKED_DOCS = ("docs/execution-plans/", "docs/clued-", "docs/contracts/")
BLOCKED_FILES = {"docs/maintenance/database-security.md", "docs/maintenance/migration-ledger.md"}
EXTRA_DOCS = {"README.md", "scripts/ci/self-hosted/README.md"}


def paper_path(name):
    return bool(name and "\\" not in name and not any(x in {"", ".", ".."} for x in name.split("/"))
                and (name in EXTRA_DOCS or (name.startswith("docs/") and name.endswith(".md")
                     and not name.startswith(BLOCKED_DOCS) and name not in BLOCKED_FILES)))


def full(reason):
    return {"run_full": True, "qualification": "FULL_APP_CHECKS_REQUIRED", "reason": reason}


def git(*args, binary=False):
    return subprocess.check_output(["git", *args], text=not binary, timeout=30,
                                   stderr=subprocess.PIPE)


def regular_at(ref, name):
    row = git("ls-tree", "-z", ref, "--", name, binary=True)
    if not row:
        return None  # Added or deleted on this side of the comparison.
    parts = row.rstrip(b"\0").split(b"\t")
    if len(parts) != 2 or parts[1].decode("utf-8") != name:
        raise ValueError("tree_path_identity")
    return parts[0].split(b" ")[0] == b"100644"


def classify(env, event):
    try:
        head = env.get("GITHUB_SHA", "")
        repository = env.get("GITHUB_REPOSITORY", "")
        if not SHA.fullmatch(head) or not re.fullmatch(r"[\w.-]+/[\w.-]+", repository):
            return full("invalid_identity")
        if env.get("GITHUB_EVENT_NAME") == "pull_request":
            pr = event.get("pull_request", {})
            number = pr.get("number")
            base_info = pr.get("base", {})
            pr_head = pr.get("head", {}).get("sha", "")
            if type(number) is not int or number <= 0 or env.get("GITHUB_REF") != f"refs/pull/{number}/merge" or \
                    base_info.get("ref") != "main" or env.get("GITHUB_BASE_REF") != "main" or not SHA.fullmatch(pr_head):
                return full("pr_identity")
            if base_info.get("repo", {}).get("full_name") != repository:
                return full("foreign_base")
            base = base_info.get("sha", "")
        elif env.get("GITHUB_EVENT_NAME") == "push" and env.get("GITHUB_REF") == "refs/heads/main":
            if event.get("after") != head:
                return full("push_identity")
            base = event.get("before", "")
        else:
            return full("event_not_qualified")
        if not SHA.fullmatch(base) or base == "0" * 40:
            return full("base_missing")
        if git("rev-parse", "HEAD").strip() != head or git("status", "--porcelain", "--untracked-files=no").strip():
            return full("checkout_not_clean_and_exact")
        if env.get("GITHUB_EVENT_NAME") == "pull_request":
            parents = git("rev-list", "--parents", "-n", "1", head).strip().split()
            if len(parents) != 3 or parents[0] != head or parents[2] != pr_head:
                return full("pr_merge_checkout")
            subprocess.run(["git", "merge-base", "--is-ancestor", base, parents[1]], check=True,
                           timeout=30, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        subprocess.run(["git", "merge-base", "--is-ancestor", base, head], check=True,
                       timeout=30, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        raw = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, head, binary=True)
        names = [x.decode("utf-8") for x in raw.split(b"\0") if x]
        if not names or len(names) > 200 or not all(paper_path(x) for x in names):
            return full("not_only_ordinary_documentation")
        for name in names:
            modes = [regular_at(ref, name) for ref in (base, head)]
            if all(x is None for x in modes) or any(x is False for x in modes):
                return full("nonregular_documentation")
        return {"run_full": False, "qualification": "DOCUMENTATION_ONLY", "full_app_tests": False,
                "reason": "only_regular_ordinary_documentation_changed", "repository": repository, "base_sha": base,
                "checkout_sha": head, "changed_count": len(names)}
    except (OSError, ValueError, TypeError, AttributeError, UnicodeError, subprocess.SubprocessError):
        return full("comparison_unavailable")


def main():
    try:
        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
        result = classify(os.environ, event)
    except (OSError, KeyError, ValueError):
        result = full("event_unavailable")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write("run_full=" + str(result["run_full"]).lower() + "\n")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as output:
            output.write("### Quality validation scope\n\n" + json.dumps(result) +
                         "\n\nDOCUMENTATION_ONLY is not evidence that application lint, build or tests ran.\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
