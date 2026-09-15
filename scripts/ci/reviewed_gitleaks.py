"""Materialize reviewed, commit-specific findings; never suppress a global rule."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tomllib

PREFIX = "# clued-reviewed-finding: "
COUNT_PREFIX = "# clued-reviewed-count: "
EXPECTED_COUNT = 429
IMAGE = "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"
KINDS = {
    "GIT_OBJECT_METADATA", "OWNER_COMMIT_ID", "API_BUNDLE_DIGEST",
    "ARTIFACT_DIGEST", "IDEMPOTENCY_METADATA", "GA_RECORD_ID", "OAUTH_USER_ID",
}
BASE_CONFIG = {
    "title": "Clued Gitleaks configuration",
    "extend": {"useDefault": True},
    "allowlists": [{
        "description": "Known test-only Supabase private-key rejection fixture; never a credential",
        "regexTarget": "secret", "regexes": ["^sb_secret_fixture_rejected$"],
    }],
}


def run(args, *, cwd=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, check=False)
    if result.returncode:
        raise ValueError("Verification command failed; raw output intentionally withheld")
    return result.stdout


def parse_records(text):
    if tomllib.loads(text) != BASE_CONFIG:
        raise ValueError("Default detection rules or pre-existing policy changed")
    counts = [int(line[len(COUNT_PREFIX):]) for line in text.splitlines() if line.startswith(COUNT_PREFIX)]
    records = [json.loads(line[len(PREFIX):]) for line in text.splitlines() if line.startswith(PREFIX)]
    if counts != [EXPECTED_COUNT] or len(records) != EXPECTED_COUNT:
        raise ValueError("Reviewed finding count changed")
    fingerprints = []
    for record in records:
        if set(record) != {"fingerprint", "kinds"}:
            raise ValueError("Unexpected review metadata")
        parts = record["fingerprint"].split(":")
        if len(parts) != 4 or not re.fullmatch(r"[a-f0-9]{40}", parts[0]):
            raise ValueError("Only full-commit fingerprints are allowed")
        commit, path, rule, line = parts
        if (not path.startswith(("artifacts/", "scripts/", "work/"))
                or any(p in ("", ".", "..") for p in path.split("/"))
                or any(c in path for c in "\\*?[]\r\n")
                or not re.fullmatch(r"[1-9][0-9]*", line)):
            raise ValueError("Non-exact finding location")
        if rule not in {"generic-api-key", "sourcegraph-access-token"}:
            raise ValueError("Unreviewed rule")
        if not record["kinds"] or set(record["kinds"]) - KINDS:
            raise ValueError("Unreviewed reason")
        if rule == "sourcegraph-access-token" and record["kinds"] != ["GIT_OBJECT_METADATA"]:
            raise ValueError("Object rule requires object proof")
        fingerprints.append(record["fingerprint"])
    if len(set(fingerprints)) != len(fingerprints):
        raise ValueError("Duplicate reviewed fingerprint")
    return records


def verify_history(repo, records):
    commits = set()
    blobs = {}
    for record in records:
        commit, path, rule, line = record["fingerprint"].split(":")
        if commit not in commits:
            if run(["git", "cat-file", "-t", commit], cwd=repo).strip() != b"commit":
                raise ValueError("Reviewed commit is not available")
            commits.add(commit)
        key = commit + ":" + path
        if key not in blobs:
            blobs[key] = run(["git", "cat-file", "blob", key], cwd=repo).decode("utf-8")
        text = blobs[key]
        if int(line) > len(text.splitlines()):
            raise ValueError("Reviewed location no longer resolves")
        if rule == "sourcegraph-access-token":
            if not path.endswith("/IndependentEnvOrderSourcePublicationAcceptance.json") or "sgp_" in text:
                raise ValueError("Unexpected historical object subject")
    # Verify all bare object identifiers in both reviewed document versions.
    object_ids = set()
    for key, text in blobs.items():
        if key.endswith("/IndependentEnvOrderSourcePublicationAcceptance.json"):
            object_ids.update(re.findall(r"\b[a-fA-F0-9]{40}\b", text))
    if len(object_ids) != 130:
        raise ValueError("Reviewed object set changed")
    result = subprocess.run(["git", "cat-file", "--batch-check=%(objectname) %(objecttype)"],
                            cwd=repo, input=("\n".join(sorted(object_ids)) + "\n").encode(),
                            capture_output=True, check=False)
    if result.returncode or any(line.split()[-1] not in (b"commit", b"tree", b"blob")
                               for line in result.stdout.splitlines()):
        raise ValueError("Historical object proof failed")
    return {"commits": len(commits), "files_at_commits": len(blobs), "verified_git_objects": len(object_ids)}


def self_test(config, production_ignore):
    docker = shutil.which("docker")
    if not docker:
        raise ValueError("Docker is required for detection regression checks")
    # Generated synthetic test data only. No real repository files or credentials are changed.
    root = Path(tempfile.mkdtemp(prefix="clued-gitleaks-regression-")).resolve()
    test_repo = root / "repo"
    test_repo.mkdir()
    ignore = root / "reviewed.ignore"
    ignore.write_text(production_ignore, encoding="utf-8", newline="\n")
    run(["git", "init", "--quiet"], cwd=test_repo)

    def commit():
        run(["git", "add", "."], cwd=test_repo)
        run(["git", "-c", "user.name=Clued CI test", "-c", "user.email=ci-test@example.invalid",
             "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "synthetic detection test"], cwd=test_repo)

    def scan():
        args = [docker, "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
                "--security-opt", "no-new-privileges", "--mount", f"type=bind,source={test_repo},target=/test,readonly",
                "--mount", f"type=bind,source={config},target=/config/gitleaks.toml,readonly",
                "--mount", f"type=bind,source={ignore},target=/reviewed.ignore,readonly",
                "--env", "GIT_CONFIG_COUNT=1", "--env", "GIT_CONFIG_KEY_0=safe.directory",
                "--env", "GIT_CONFIG_VALUE_0=/test", IMAGE, "git", "/test", "--config", "/config/gitleaks.toml",
                "--gitleaks-ignore-path", "/reviewed.ignore", "--redact=100", "--no-banner", "--no-color",
                "--log-level", "error", "--report-format", "json", "--report-path", "-", "--exit-code", "1"]
        result = subprocess.run(args, capture_output=True, check=False)
        if result.returncode not in (0, 1):
            raise ValueError("Isolated detector test failed")
        try:
            return result.returncode, json.loads(result.stdout)
        except (ValueError, UnicodeError):
            raise ValueError("Invalid detector test output") from None

    def sample(seed):
        return ("sourcegraph: " + "sgp_" + hashlib.sha1(seed.encode()).hexdigest() + "\n"
                + 'api_key="' + hashlib.sha256(seed.encode()).hexdigest() + '"\n')

    (test_repo / "probe.txt").write_text(sample("first controlled synthetic case"), encoding="utf-8")
    commit()
    code, first = scan()
    if code != 1 or {f["RuleID"] for f in first} != {"sourcegraph-access-token", "generic-api-key"}:
        raise ValueError("Baseline no longer detects both synthetic token types")
    ignore.write_text(production_ignore + "".join(f["Fingerprint"] + "\n" for f in first), encoding="utf-8", newline="\n")
    code, suppressed = scan()
    if code != 0 or suppressed:
        raise ValueError("Exact historical fingerprint was not isolated")
    (test_repo / "probe.txt").write_text(sample("second controlled synthetic case"), encoding="utf-8")
    (test_repo / "other-path.txt").write_text(sample("first controlled synthetic case"), encoding="utf-8")
    commit()
    code, fresh = scan()
    if code != 1 or len(fresh) != 4 or {f["File"] for f in fresh} != {"probe.txt", "other-path.txt"}:
        raise ValueError("New commits or different paths were incorrectly suppressed")
    return {"baseline_detection": True, "exact_history_only": True,
            "new_commit_detection": True, "different_path_detection": True,
            "synthetic_test_repository": str(test_repo)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    config = Path(args.config).resolve(strict=True)
    records = parse_records(config.read_text(encoding="utf-8"))
    proof = verify_history(config.parent, records)
    content = "".join(r["fingerprint"] + "\n" for r in records)
    output = Path(args.output).resolve()
    if output == config or output.is_relative_to(config.parent):
        raise ValueError("Generated ignore file must remain outside the source repository")
    output.write_text(content, encoding="utf-8", newline="\n")
    report = {"exact_historical_fingerprints": len(records), "default_rules_unchanged": True,
              "global_fingerprints": 0, "ignore_sha256": hashlib.sha256(content.encode()).hexdigest(), **proof}
    if args.self_test:
        report["regression"] = self_test(config, content)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError):
        raise SystemExit("Reviewed-finding verification failed; raw data intentionally withheld") from None
