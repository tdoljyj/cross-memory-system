"""Materialize reviewed, commit-specific findings; never suppress a global rule."""
import argparse
import base64
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
EXPECTED_COUNT = 491
REVIEW_DOCUMENT_PATH = "development/contracts/context-authorization/evidence/all-contexts-security-code-review-r2.json"
REVIEW_DOCUMENT_COMMIT = "4d05eb04d64fb8655cbe522a3dfcecf0d3c74904"
REVIEW_DOCUMENT_SHA256 = "d223d30902ead65ac193a2166cc081a2a2b326d71af3e8a898994427e72e1d21"
REVIEW_DOCUMENT_DIGEST_LINES = {
    150: "apps/clued-cloud/worker/delegated-oauth.ts",
    152: "apps/clued-cloud/tests/delegated-oauth-transport.test.mjs",
}
FINAL_EVIDENCE_COMMIT = "df69831166fcb43ee0dee982fb7158b770bf54a6"
FINAL_EVIDENCE_ROOT = "development/contracts/context-authorization/evidence/final-integration-f8-r1"
FINAL_SOURCE_PATH = "apps/clued-cloud/worker/delegated-oauth.ts"
FINAL_ENVELOPE_PATH = FINAL_EVIDENCE_ROOT + "/FinalIntegrationExactEvidenceF8R1.v1.json"
FINAL_DB_REPORT_PATH = FINAL_EVIDENCE_ROOT + "/readable/ui-acceptance/final-integration-db-local-check-f8-r2.json"
FINAL_LOCAL_REPORT_PATH = FINAL_EVIDENCE_ROOT + "/readable/ui-acceptance/final-integration-local-check-f8-r1.json"
FINAL_SUBJECT_PATH = FINAL_EVIDENCE_ROOT + "/readable/ui-acceptance/final-three-path-integration-review-subject-f8-r1.json"
FINAL_EVIDENCE_DOCUMENTS = {
    FINAL_DB_REPORT_PATH: {
        "sha256": "a18e3e28f4c1ef9acf6079c2bfde0f6612a98fb4b28f093fcd1e848f3ce0682c",
        "lines": {30: {"parent": "/source_before"}, 49: {"parent": "/source_after"}},
    },
    FINAL_LOCAL_REPORT_PATH: {
        "sha256": "a92829ffc664ef81026078e3aa7e1c9eeb7901e9e314fff9f1563591d274ed2b",
        "lines": {15: {"parent": "/source_before"}, 35: {"parent": "/source_after"}},
    },
    FINAL_SUBJECT_PATH: {
        "sha256": "f11d35391b0b8877118d473a1917565ee53e8b7511ed999eeb889eb7f4bdfafa",
        "lines": {230: {"parent": "/source"}},
    },
    FINAL_ENVELOPE_PATH: {
        "sha256": "612941c58af479abc203c7c64ad3caeb6465f0851b8bcb6eb273c7eac2b68b39",
        "lines": {
            184: {"entry_index": 1, "entry_path": "ui-acceptance/final-integration-db-local-check-f8-r2.json",
                  "original_sha256": "1b16fc3a1d3e1bbc725243da0e5479a2e4c779fab4a404fa800716af00523ed3",
                  "original_bytes": 6231, "readable_path": FINAL_DB_REPORT_PATH,
                  "parents": ["/source_before", "/source_after"]},
            192: {"entry_index": 2, "entry_path": "ui-acceptance/final-three-path-integration-review-subject-f8-r1.json",
                  "original_sha256": "e5fbe30d680ea41a00cb1117397ac5e40483a8312a251a4b67d7856d6a9b7459",
                  "original_bytes": 20152, "readable_path": FINAL_SUBJECT_PATH,
                  "parents": ["/source"]},
        },
    },
}
IMAGE = "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f"
KINDS = {
    "GIT_OBJECT_METADATA", "OWNER_COMMIT_ID", "API_BUNDLE_DIGEST",
    "ARTIFACT_DIGEST", "IDEMPOTENCY_METADATA", "GA_RECORD_ID", "OAUTH_USER_ID",
    # A Supabase publishable key: a public client credential by design, the same
    # value app/supabase-public-config.ts ships to every browser (reviewed 2026-10-01).
    "PUBLIC_CLIENT_KEY",
    # A made-up bearer token in a test under apps/clued-cloud/tests/ that never
    # authenticated anywhere (reviewed 2026-10-07, Owner decision, Task 27aeb894).
    "SYNTHETIC_TEST_TOKEN",
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
        # apps/clued-cloud/tests/ holds synthetic fixtures only (reviewed 2026-09-23).
        # The A03 register is admitted by exact path only (reviewed 2026-09-24, PR #330).
        if (not (path.startswith(("artifacts/", "scripts/", "work/", "apps/clued-cloud/tests/"))
                 or path == "development/contracts/information-flow/known-limitations.m0d.v0.1.json"
                 or path == REVIEW_DOCUMENT_PATH or path in FINAL_EVIDENCE_DOCUMENTS)
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
        if path == REVIEW_DOCUMENT_PATH and (
                commit != REVIEW_DOCUMENT_COMMIT or rule != "generic-api-key"
                or int(line) not in REVIEW_DOCUMENT_DIGEST_LINES
                or record["kinds"] != ["ARTIFACT_DIGEST"]):
            raise ValueError("Authorization review exception identity changed")
        if path in FINAL_EVIDENCE_DOCUMENTS and (
                commit != FINAL_EVIDENCE_COMMIT or rule != "generic-api-key"
                or int(line) not in FINAL_EVIDENCE_DOCUMENTS[path]["lines"]
                or record["kinds"] != ["ARTIFACT_DIGEST"]):
            raise ValueError("Final evidence exception identity changed")
        fingerprints.append(record["fingerprint"])
    if len(set(fingerprints)) != len(fingerprints):
        raise ValueError("Duplicate reviewed fingerprint")
    expected_final = {
        f"{FINAL_EVIDENCE_COMMIT}:{path}:generic-api-key:{line}"
        for path, document in FINAL_EVIDENCE_DOCUMENTS.items() for line in document["lines"]
    }
    actual_final = {record["fingerprint"] for record in records
                    if record["fingerprint"].split(":")[1] in FINAL_EVIDENCE_DOCUMENTS}
    if actual_final != expected_final:
        raise ValueError("Final evidence exception set changed")
    return records


def _ensure_reviewed_commits(repo, records):
    commits = sorted({record["fingerprint"].split(":", 1)[0] for record in records})
    missing = []
    for commit in commits:
        result = subprocess.run(
            ["git", "cat-file", "-e", f"{commit}^{{commit}}"],
            cwd=repo, capture_output=True, check=False,
        )
        if result.returncode:
            missing.append(commit)
    if missing:
        result = subprocess.run(
            ["git", "fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", "origin", *missing],
            cwd=repo, capture_output=True, check=False,
        )
        if result.returncode:
            raise ValueError("Reviewed commit is not available")
    for commit in commits:
        if run(["git", "cat-file", "-t", commit], cwd=repo).strip() != b"commit":
            raise ValueError("Reviewed commit is not available")
    return commits


def verify_auth_review_digest(repo, text, line_number):
    """Prove the two pinned matches are digests of the same immutable source."""
    if hashlib.sha256(text.encode("utf-8")).hexdigest() != REVIEW_DOCUMENT_SHA256:
        raise ValueError("Authorization review bytes changed")
    source_path = REVIEW_DOCUMENT_DIGEST_LINES.get(line_number)
    if source_path is None:
        raise ValueError("Unreviewed authorization digest line")
    document = json.loads(text)
    digest = document["reviewed_file_hashes"].get(source_path)
    if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("Authorization review has no exact artifact digest")
    line = text.splitlines()[line_number - 1].strip().rstrip(",")
    if json.loads("{" + line + "}") != {source_path: digest}:
        raise ValueError("Authorization digest location changed")
    blob = run(["git", "cat-file", "blob", f"{REVIEW_DOCUMENT_COMMIT}:{source_path}"], cwd=repo)
    if hashlib.sha256(blob).hexdigest() != digest:
        raise ValueError("Authorization digest differs from immutable artifact")


def _final_pointer(document, pointer):
    value = document
    for part in pointer.strip("/").split("/"):
        value = value[part]
    return value


def _final_source_digest(repo, digest):
    blob = run(["git", "cat-file", "blob", f"{FINAL_EVIDENCE_COMMIT}:{FINAL_SOURCE_PATH}"], cwd=repo)
    if not isinstance(digest, str) or hashlib.sha256(blob).hexdigest() != digest:
        raise ValueError("Final evidence digest differs from immutable artifact")


def verify_final_evidence_digest(repo, path, text, line_number):
    """Admit only the seven classified locations and their immutable artifact proof."""
    pinned = FINAL_EVIDENCE_DOCUMENTS.get(path)
    if pinned is None or line_number not in pinned["lines"]:
        raise ValueError("Unreviewed final evidence location")
    if hashlib.sha256(text.encode("utf-8")).hexdigest() != pinned["sha256"]:
        raise ValueError("Final evidence document bytes changed")
    spec = pinned["lines"][line_number]
    document = json.loads(text)
    line = text.splitlines()[line_number - 1].strip().rstrip(",")
    location = json.loads("{" + line + "}")
    if "parent" in spec:
        digest = _final_pointer(document, spec["parent"])[FINAL_SOURCE_PATH]
        if location != {FINAL_SOURCE_PATH: digest}:
            raise ValueError("Final evidence digest location changed")
        _final_source_digest(repo, digest)
        return
    entry = document["entries"][spec["entry_index"]]
    if (set(entry) != {"path", "original_sha256", "original_bytes", "original_base64", "git_text_sha256", "git_text_transform"}
            or entry["path"] != spec["entry_path"]
            or location != {"original_base64": entry["original_base64"]}):
        raise ValueError("Final evidence encoded location changed")
    if entry["original_sha256"] != spec["original_sha256"]:
        raise ValueError("Final evidence original digest changed")
    if type(entry["original_bytes"]) is not int or entry["original_bytes"] != spec["original_bytes"]:
        raise ValueError("Final evidence original size changed")
    try:
        original = base64.b64decode(entry["original_base64"], validate=True)
    except (ValueError, TypeError):
        raise ValueError("Final evidence Base64 invalid") from None
    if (len(original) != entry["original_bytes"]
            or hashlib.sha256(original).hexdigest() != entry["original_sha256"]):
        raise ValueError("Final evidence decoded original bytes changed")
    if entry["git_text_transform"] != "CRLF_to_LF":
        raise ValueError("Final evidence transform changed")
    normalized = original.replace(b"\r\n", b"\n")
    readable = run(["git", "cat-file", "blob", f"{FINAL_EVIDENCE_COMMIT}:{spec['readable_path']}"], cwd=repo)
    readable_pin = FINAL_EVIDENCE_DOCUMENTS[spec["readable_path"]]["sha256"]
    if (entry["git_text_sha256"] != readable_pin or hashlib.sha256(readable).hexdigest() != readable_pin
            or normalized != readable):
        raise ValueError("Final evidence readable artifact changed")
    decoded = json.loads(original.decode("utf-8"))
    for parent in spec["parents"]:
        _final_source_digest(repo, _final_pointer(decoded, parent)[FINAL_SOURCE_PATH])


def verify_history(repo, records):
    commits = _ensure_reviewed_commits(repo, records)
    blobs = {}
    for record in records:
        commit, path, rule, line = record["fingerprint"].split(":")
        key = commit + ":" + path
        if key not in blobs:
            blobs[key] = run(["git", "cat-file", "blob", key], cwd=repo).decode("utf-8")
        text = blobs[key]
        if int(line) > len(text.splitlines()):
            raise ValueError("Reviewed location no longer resolves")
        if path == REVIEW_DOCUMENT_PATH:
            verify_auth_review_digest(repo, text, int(line))
        if path in FINAL_EVIDENCE_DOCUMENTS:
            verify_final_evidence_digest(repo, path, text, int(line))
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
