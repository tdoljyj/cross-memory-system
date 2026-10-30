"""Materialize reviewed, commit-specific findings; never suppress a global rule."""
import argparse
import ast
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
LEGACY_COUNT = 726
LEGACY_RECORD_LINES_SHA256 = "5ec9aef1a5af7f356152ba7dfc18e197a968cf3ac70ffd2b2aa7000a4801d35c"
SCHEDULING_END = 729
PRIOR_RECORD_LINES_SHA256 = "3117636bb9809e0aa2f953340172e48ba171b010949112dbe79e5879309a45cd"
EXPECTED_COUNT = 730
SCHEDULING_COMMIT = "fd10191533a5f2139b224a90a096880039d62034"
SCHEDULING_TEST_PATH = "apps/clued-cloud/tests/ci-scheduling-stage1-ui.test.mjs"
SCHEDULING_README_PATH = "work/ci-scheduling-stage1-20261023/README.md"
SCHEDULING_BLOBS = {
    SCHEDULING_TEST_PATH: {"blob": "4081d1af33666e2194c7ffa8f3d0cccc176ca164",
                           "sha256": "e0e4215310cba92eb27747a36ed001d5b46a154b46f56ef068145cc97f0a0aa5", "bytes": 23019},
    SCHEDULING_README_PATH: {"blob": "98c9fbf54b67318274a14d1bcc96b1940add7f42",
                             "sha256": "714b03bf2d60e00ff5519c2e6f4dd20f109421e98e232bb3ad061c095355446f", "bytes": 8936},
}
# Candidate classifications are not accepted Source/runtime policy. Each is usable only
# by the exact three fingerprints below, with immutable blob, span and usage proof.
SCHEDULING_FINDINGS = {
    f"{SCHEDULING_COMMIT}:{SCHEDULING_TEST_PATH}:private-key:283": {
        "kind": "SYNTHETIC_PEM_MARKER", "end_line": 315, "span_bytes": 2432,
        "span_sha256": "2b8df28e8b3d44a0f220735283a7ea8a7eac9da1fb02c9bc69c20b5f129a9063"},
    f"{SCHEDULING_COMMIT}:{SCHEDULING_TEST_PATH}:generic-api-key:315": {
        "kind": "SYNTHETIC_REJECTION_MARKER", "end_line": 315, "span_bytes": 126,
        "span_sha256": "1d852efee7dee22146fb7488cab1584667f7833cb38ab65b160dbebc069e875f"},
    f"{SCHEDULING_COMMIT}:{SCHEDULING_README_PATH}:generic-api-key:78": {
        "kind": "PUBLIC_DOCUMENT_PROSE", "end_line": 78, "span_bytes": 79,
        "span_sha256": "1d5a4bd8cfccf414fb99d0bc2fb1e809472ce6e10f336f956db4082f78e64b92"},
}
SCHEDULING_KINDS = {spec["kind"] for spec in SCHEDULING_FINDINGS.values()}
# Batch-2 (#937) candidate: one synthetic token literal in the C2 role-probe test,
# usable only by this exact fingerprint with immutable blob, span and usage proof.
ROLE_PROBE_COMMIT = "16f981cca5bdcae27e5eb08768013b36deafe44a"
ROLE_PROBE_PATH = "work/independent-ci-resident-v1/test/role-probe.test.mjs"
ROLE_PROBE_BLOB = {"blob": "cf3254de92881aa76a03dbd8714217c6cfd23abb",
                   "sha256": "4c27c0a152006f0b7dd57b856155c221577967720fa05bc3211fd277fa8c296e", "bytes": 7681}
ROLE_PROBE_FINDINGS = {
    f"{ROLE_PROBE_COMMIT}:{ROLE_PROBE_PATH}:generic-api-key:73": {
        "kind": "SYNTHETIC_ROLE_PROBE_TOKEN", "end_line": 73, "span_bytes": 89,
        "span_sha256": "38515feffdf8a479abaf951cbd038bd01b06c13397ade3fa3654c76afd879aa6",
        "test_start_line": 72, "test_end_line": 82},
}
ROLE_PROBE_KINDS = {spec["kind"] for spec in ROLE_PROBE_FINDINGS.values()}
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
PATCH_DOCUMENT_COMMIT = "943eb9f7e579ed5f9decc15196fbd79876cce497"
PATCH_DOCUMENT_PATH = "development/contracts/context-authorization/evidence/final-scanner-policy-f8-r1/final-df698-reviewed-artifacts-delta-r1.patch"
PATCH_DOCUMENT_SHA256 = "2a0703306eec7a2c7d35343823a5b8f3bfc2a2822a72882c478c5e17e21f4a68"
PATCH_HELPER_PATH = "scripts/ci/reviewed_gitleaks.py"
PATCH_HELPER_SHA256 = "3cff545f0d26610de0097165cf9dc6d32421707357cf960a9f38af22b4d0e32f"
PATCH_METADATA_LINES = {
    46: {"prefix": " ", "constant": "REVIEW_DOCUMENT_COMMIT", "object": REVIEW_DOCUMENT_COMMIT, "helper_line": 18},
    52: {"prefix": "+", "constant": "FINAL_EVIDENCE_COMMIT", "object": FINAL_EVIDENCE_COMMIT, "helper_line": 24},
}
HANDOVER_ACCEPTANCE_PATH = "config/clued-handover-external-acceptance.json"
HANDOVER_ORIGINAL_COMMIT = "f42974c666885855b2c55d28dbe47767a77c2d9e"
HANDOVER_DIGEST_LINES = {
    32, 40, 82, 99, 110, 119, 132, 140, 165, 210,
    230, 236, 242, 574, 1112, 1118, 1119, 1123, 1416, 1419,
}
# Exact paths outside the reviewed prefixes (reviewed 2026-10-20, KooYomi Decision
# 5e5b5f64): each path is admitted only at its exact commit, line and kind.
EXACT_PATH_FINDINGS = {
    "apps/clued-cloud/app/supabase-public-config.ts": {
        ("299869b5426b6cc1235527bd130dc5fb074558da", 6): "PUBLIC_CLIENT_KEY"},
    "apps/clued-cloud/app/page.tsx": {
        ("920601a448a5ea8c99f99192cc2b3e59fd8a8843", 8): "PUBLIC_CLIENT_KEY"},
    "apps/clued-cloud/app/oauth/consent/page.tsx": {
        ("95c2e5b49f630bb4bc19ae93d837a704f0e64779", 13): "PUBLIC_CLIENT_KEY"},
    "apps/clued-cloud/worker/continuity.ts": {
        ("920601a448a5ea8c99f99192cc2b3e59fd8a8843", 2): "PUBLIC_CLIENT_KEY"},
    "apps/clued-cloud/supabase/tests/m1_runtime_contracts.test.sql": {
        ("53ce5eab2566cbc38891afe8c70d16e6302e2c49", 65): "IDEMPOTENCY_METADATA"},
    "clued/cloud_data/lifecycle.py": {
        ("567222dccd8f51b2314b460876a4de9812aa0c74", 106): "IDEMPOTENCY_METADATA"},
    "docs/execution-plans/phase2-structure-governance/step18-publication-20260907/Policy.json": {
        ("99f615bdb924c510e62c41f3510cd76acb6ce2fb", 1): "ARTIFACT_DIGEST"},
    "docs/r4-gate0/evidence/frozen-eval-manifest.json": {
        ("4fd59f797e1afc9b8bfad2e0edee7801313e4cab", 566): "ARTIFACT_DIGEST"},
    "docs/r4-gate0/evidence/model-manifest.redacted.json": {
        ("acfb5a8130ae99a81e7be529503169465939d5dc", 22): "ARTIFACT_DIGEST"},
    "memory_engine/manifest_guard.py": {
        ("dc01dd1b9c7de78f4a64631e4566a472f16349ae", 83): "ARTIFACT_DIGEST"},
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
    # The public OpenPGP fingerprint of a release-signing key, e.g. the python image's
    # GPG_KEY environment value; never a private key (reviewed 2026-10-20).
    "PUBLIC_KEY_FINGERPRINT",
    # An OAuth client identifier, public by design; never a client secret or token
    # (reviewed 2026-10-20).
    "OAUTH_CLIENT_ID",
}
KINDS |= SCHEDULING_KINDS
KINDS |= ROLE_PROBE_KINDS
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
                 or path == REVIEW_DOCUMENT_PATH or path in FINAL_EVIDENCE_DOCUMENTS or path == PATCH_DOCUMENT_PATH
                 or path == HANDOVER_ACCEPTANCE_PATH or path in EXACT_PATH_FINDINGS)
                or any(p in ("", ".", "..") for p in path.split("/"))
                or any(c in path for c in "\\*?[]\r\n")
                or not re.fullmatch(r"[1-9][0-9]*", line)):
            raise ValueError("Non-exact finding location")
        fixture = SCHEDULING_FINDINGS.get(record["fingerprint"])
        if rule not in {"generic-api-key", "sourcegraph-access-token"} and fixture is None:
            raise ValueError("Unreviewed rule")
        if not record["kinds"] or set(record["kinds"]) - KINDS:
            raise ValueError("Unreviewed reason")
        if (fixture is not None and record["kinds"] != [fixture["kind"]]
                or set(record["kinds"]) & SCHEDULING_KINDS and fixture is None):
            raise ValueError("Scheduling fixture exception identity changed")
        token_fixture = ROLE_PROBE_FINDINGS.get(record["fingerprint"])
        if (token_fixture is not None and record["kinds"] != [token_fixture["kind"]]
                or set(record["kinds"]) & ROLE_PROBE_KINDS and token_fixture is None):
            raise ValueError("Role-probe token exception identity changed")
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
        if path == PATCH_DOCUMENT_PATH and (
                commit != PATCH_DOCUMENT_COMMIT or rule != "sourcegraph-access-token"
                or int(line) not in PATCH_METADATA_LINES or record["kinds"] != ["GIT_OBJECT_METADATA"]):
            raise ValueError("Patch metadata exception identity changed")
        if path == HANDOVER_ACCEPTANCE_PATH and (
                rule != "generic-api-key" or int(line) not in HANDOVER_DIGEST_LINES
                or record["kinds"] != ["ARTIFACT_DIGEST"]):
            raise ValueError("Handover acceptance exception identity changed")
        if path in EXACT_PATH_FINDINGS and (
                rule != "generic-api-key"
                or (commit, int(line)) not in EXACT_PATH_FINDINGS[path]
                or record["kinds"] != [EXACT_PATH_FINDINGS[path][(commit, int(line))]]):
            raise ValueError("Exact path exception identity changed")
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
    expected_patch = {f"{PATCH_DOCUMENT_COMMIT}:{PATCH_DOCUMENT_PATH}:sourcegraph-access-token:{line}"
                      for line in PATCH_METADATA_LINES}
    actual_patch = {record["fingerprint"] for record in records
                    if record["fingerprint"].split(":")[1] == PATCH_DOCUMENT_PATH}
    if actual_patch != expected_patch:
        raise ValueError("Patch metadata exception set changed")
    handover = [record["fingerprint"] for record in records
                if record["fingerprint"].split(":")[1] == HANDOVER_ACCEPTANCE_PATH]
    handover_commits = {fingerprint.split(":")[0] for fingerprint in handover}
    expected_handover = {f"{commit}:{HANDOVER_ACCEPTANCE_PATH}:generic-api-key:{line}"
                         for commit in handover_commits for line in HANDOVER_DIGEST_LINES}
    if (len(handover_commits) != 2 or HANDOVER_ORIGINAL_COMMIT not in handover_commits
            or set(handover) != expected_handover):
        raise ValueError("Handover acceptance exact generation set changed")
    expected_exact = {f"{commit}:{path}:generic-api-key:{line}"
                      for path, locations in EXACT_PATH_FINDINGS.items() for commit, line in locations}
    actual_exact = {record["fingerprint"] for record in records
                    if record["fingerprint"].split(":")[1] in EXACT_PATH_FINDINGS}
    if actual_exact != expected_exact:
        raise ValueError("Exact path exception set changed")
    if {record["fingerprint"] for record in records[LEGACY_COUNT:SCHEDULING_END]} != set(SCHEDULING_FINDINGS):
        raise ValueError("Scheduling fixture exception set changed")
    if {record["fingerprint"] for record in records[SCHEDULING_END:]} != set(ROLE_PROBE_FINDINGS):
        raise ValueError("Role-probe token exception set changed")
    legacy_lines = [line for line in text.splitlines() if line.startswith(PREFIX)][:LEGACY_COUNT]
    if hashlib.sha256(("\n".join(legacy_lines) + "\n").encode()).hexdigest() != LEGACY_RECORD_LINES_SHA256:
        raise ValueError("Legacy reviewed finding bytes changed")
    prior_lines = [line for line in text.splitlines() if line.startswith(PREFIX)][:SCHEDULING_END]
    if hashlib.sha256(("\n".join(prior_lines) + "\n").encode()).hexdigest() != PRIOR_RECORD_LINES_SHA256:
        raise ValueError("Prior reviewed finding bytes changed")
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


def verify_patch_git_metadata(repo, text, line_number):
    """Prove both diff occurrences are the exact pinned helper's ancestor commits."""
    if line_number not in PATCH_METADATA_LINES:
        raise ValueError("Unreviewed patch metadata line")
    if hashlib.sha256(text.encode("utf-8")).hexdigest() != PATCH_DOCUMENT_SHA256:
        raise ValueError("Patch document bytes changed")
    spec = PATCH_METADATA_LINES[line_number]
    assignment = f'{spec["constant"]} = "{spec["object"]}"'
    if text.splitlines()[line_number - 1] != spec["prefix"] + assignment:
        raise ValueError("Patch metadata prefix or assignment changed")
    helper = run(["git", "cat-file", "blob", f"{PATCH_DOCUMENT_COMMIT}:{PATCH_HELPER_PATH}"], cwd=repo)
    if hashlib.sha256(helper).hexdigest() != PATCH_HELPER_SHA256:
        raise ValueError("Patch helper bytes changed")
    if helper.decode("utf-8").splitlines()[spec["helper_line"] - 1] != assignment:
        raise ValueError("Patch helper constant identity changed")
    if run(["git", "cat-file", "-t", spec["object"]], cwd=repo).strip() != b"commit":
        raise ValueError("Patch metadata object is not a commit")
    ancestor = subprocess.run(["git", "merge-base", "--is-ancestor", spec["object"], PATCH_DOCUMENT_COMMIT],
                              cwd=repo, capture_output=True, check=False)
    if ancestor.returncode:
        raise ValueError("Patch metadata object is not an ancestor")


def _unique_acceptance_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate acceptance JSON member")
        result[key] = value
    return result


def verify_handover_acceptance_digest(repo, commit, path, text, line_number):
    # This proves public artifact metadata only, not Source/runtime acceptance.
    if (path != HANDOVER_ACCEPTANCE_PATH or line_number not in HANDOVER_DIGEST_LINES
            or not re.fullmatch(r"[a-f0-9]{40}", commit)):
        raise ValueError("Unreviewed handover acceptance location")
    document = json.loads(text, object_pairs_hook=_unique_acceptance_object)
    source = document.get("source_commit")
    if (document.get("schema") != "clued.external-qualification-independent-acceptance/1"
            or document.get("status") != "accepted"
            or document.get("repository") != "tdoljyj/cross-memory-system"
            or document.get("task_id") != "6176fdcc-c5b0-46c9-9769-d5e0bc0ce4f8"
            or not isinstance(source, str) or not re.fullmatch(r"[a-f0-9]{40}", source)
            or not isinstance(document.get("files"), dict)):
        raise ValueError("Handover acceptance context changed")
    lines = text.splitlines()
    starts = [i for i, line in enumerate(lines) if line == '  "files": {']
    if len(starts) != 1:
        raise ValueError("Handover acceptance files location changed")
    ends = [i for i in range(starts[0] + 1, len(lines)) if lines[i] in ('  }', '  },')]
    if not ends or not starts[0] < line_number - 1 < ends[0]:
        raise ValueError("Handover acceptance digest line is outside files")
    location = json.loads("{" + lines[line_number - 1].strip().rstrip(",") + "}",
                          object_pairs_hook=_unique_acceptance_object)
    if len(location) != 1:
        raise ValueError("Handover acceptance digest line is not unique")
    source_path, digest = next(iter(location.items()))
    if (not source_path or source_path.startswith("/")
            or any(part in ("", ".", "..") for part in source_path.split("/"))
            or any(char in source_path for char in "\\:*?[]\r\n")
            or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
            or document["files"].get(source_path) != digest):
        raise ValueError("Handover acceptance artifact map changed")
    if run(["git", "cat-file", "blob", f"{commit}:{path}"], cwd=repo).decode("utf-8") != text:
        raise ValueError("Handover acceptance immutable document changed")
    if run(["git", "cat-file", "-t", source], cwd=repo).strip() != b"commit":
        raise ValueError("Handover acceptance source is not a commit")
    ancestor = subprocess.run(["git", "merge-base", "--is-ancestor", source, commit],
                              cwd=repo, capture_output=True, check=False)
    if ancestor.returncode:
        raise ValueError("Handover acceptance source is not an ancestor")
    blob = run(["git", "cat-file", "blob", f"{source}:{source_path}"], cwd=repo)
    if hashlib.sha256(blob).hexdigest() != digest:
        raise ValueError("Handover acceptance digest differs from immutable artifact")


def verify_scheduling_fixture(repo, fingerprint, text):
    """Prove only the three pinned non-credential uses; never infer safety from a rule or path."""
    spec = SCHEDULING_FINDINGS.get(fingerprint)
    if spec is None:
        raise ValueError("Unreviewed scheduling fixture identity")
    commit, path, rule, line = fingerprint.split(":")
    pin = SCHEDULING_BLOBS[path]
    blob = text.encode("utf-8")
    object_id = hashlib.sha1(b"blob " + str(len(blob)).encode() + b"\0" + blob).hexdigest()
    if (len(blob) != pin["bytes"] or object_id != pin["blob"]
            or hashlib.sha256(blob).hexdigest() != pin["sha256"]
            or run(["git", "rev-parse", f"{commit}:{path}"], cwd=repo).decode().strip() != pin["blob"]):
        raise ValueError("Scheduling fixture immutable blob changed")
    lines = text.splitlines(keepends=True)
    first = int(line) - 1
    span = "".join(lines[first:spec["end_line"]]).encode()
    if len(span) != spec["span_bytes"] or hashlib.sha256(span).hexdigest() != spec["span_sha256"]:
        raise ValueError("Scheduling fixture exact span changed")
    source = lines[first].rstrip("\r\n")
    literals = list(re.finditer(r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"", source))
    values = [ast.literal_eval(match.group()) for match in literals]
    if spec["kind"] == "SYNTHETIC_PEM_MARKER":
        if (rule != "private-key" or not re.search(r"\bdiagnostic\b", source)
                or not re.search(r"\bmessage\s*:", source) or len(values) != 1
                or len(literals[0].group()) - 2 != 68 or len(values[0]) != 66
                or values[0].count("\n") != 2):
            raise ValueError("Scheduling diagnostic marker use changed")
        parts = values[0].splitlines()
        if (len(parts) != 3 or len(parts[1]) != 12
                or not re.fullmatch(r"-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}", parts[0])
                or parts[2] != parts[0].replace("BEGIN ", "END ", 1)):
            raise ValueError("Scheduling diagnostic marker shape changed")
        try:
            base64.b64decode(parts[1], validate=True)
        except ValueError:
            pass  # Invalid Base64 cannot encode ASN.1/PKCS private-key material.
        else:
            raise ValueError("Scheduling marker unexpectedly contains valid Base64")
    elif spec["kind"] == "SYNTHETIC_REJECTION_MARKER":
        if (rule != "generic-api-key" or not re.search(r"for\s*\(\s*const\s+\w+\s+of\s*\[", source)
                or [len(value) for value in values] != [30, 24, 14, 14]
                or not re.fullmatch(r"-+BEGIN [A-Z ]+KEY-+", values[0])
                or not values[1].startswith("Bearer ")
                or not re.fullmatch(r"[A-Za-z0-9_-]{17}", values[1][7:])
                or not all(re.fullmatch(r"[A-Za-z0-9_-]{14}", value) for value in values[2:])):
            raise ValueError("Scheduling rejection markers use changed")
    elif spec["kind"] == "PUBLIC_DOCUMENT_PROSE":
        if (rule != "generic-api-key" or not source.isascii() or any(char.isdigit() for char in source)
                or max(map(len, re.findall(r"[A-Za-z]+", source)), default=0) != 11 or len(source) != 78):
            raise ValueError("Scheduling public prose use changed")
    else:
        raise ValueError("Unreviewed scheduling fixture classification")


ROLE_PROBE_STRING = re.compile(r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|`(?:\\.|[^`\\])*`")
ROLE_PROBE_IDENTIFIER = re.compile(r"(?<![\w$.])token(?![\w$])")


def verify_role_probe_token(repo, fingerprint, text):
    """Prove only the pinned test-local literal: digested and returned by in-test fakes, never a credential."""
    spec = ROLE_PROBE_FINDINGS.get(fingerprint)
    if spec is None:
        raise ValueError("Unreviewed role-probe token identity")
    commit, path, rule, line = fingerprint.split(":")
    blob = text.encode("utf-8")
    object_id = hashlib.sha1(b"blob " + str(len(blob)).encode() + b"\0" + blob).hexdigest()
    if (len(blob) != ROLE_PROBE_BLOB["bytes"] or object_id != ROLE_PROBE_BLOB["blob"]
            or hashlib.sha256(blob).hexdigest() != ROLE_PROBE_BLOB["sha256"]
            or run(["git", "rev-parse", f"{commit}:{path}"], cwd=repo).decode().strip() != ROLE_PROBE_BLOB["blob"]):
        raise ValueError("Role-probe token immutable blob changed")
    lines = text.splitlines(keepends=True)
    first = int(line) - 1
    span = "".join(lines[first:spec["end_line"]]).encode()
    if len(span) != spec["span_bytes"] or hashlib.sha256(span).hexdigest() != spec["span_sha256"]:
        raise ValueError("Role-probe token exact span changed")
    declaration = re.fullmatch(r"  const token = ('[A-Za-z0-9_]+'), reads = \[\], protectedCalls = \[\], native = \[\];",
                               lines[first].rstrip("\r\n"))
    if (rule != "generic-api-key" or declaration is None or not path.startswith("work/")
            or "/test/" not in path or not path.endswith(".test.mjs")):
        raise ValueError("Role-probe token declaration changed")
    value = ast.literal_eval(declaration.group(1))
    if not re.fullmatch(r"clued_bnd_fixture[0-9]{6}", value) or text.count(value) != 1:
        raise ValueError("Role-probe token value changed")
    # Every use of the local `token` (strings removed) is inside the one enclosing test:
    # one digest input and two in-test fake tokenReader return values. Nothing else.
    start, end = spec["test_start_line"] - 1, spec["test_end_line"]
    if not lines[start].startswith("test('controller entry reads exactly native token ") or lines[end - 1] != "});\n":
        raise ValueError("Role-probe token test boundary changed")
    uses = []
    for number, source in enumerate(lines, 1):
        code = ROLE_PROBE_STRING.sub('""', source)
        uses += [(number, code[max(0, match.start() - 3):match.end() + 1]) for match in ROLE_PROBE_IDENTIFIER.finditer(code)]
    block = "".join(lines[start:end])
    if (uses != [(73, "st token "), (74, " + token)"), (76, "rn token;"), (81, "=> token,")]
            or "tokenReader: async (file, options) => { reads.push({ file, options }); return token; }" not in block
            or "fetchImpl: async (...v) => { native.push(v); return new Response(" not in block
            or "tokenReader: async () => token, fetchImpl: async () => { assert.fail('no request'); }" not in block
            or set(re.findall(r"https?://[^'\"/ ]+", block)) != {"https://fixture.supabase.co"}
            or "process.env" in text):
        raise ValueError("Role-probe token use changed")


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
        if record["fingerprint"] in SCHEDULING_FINDINGS:
            verify_scheduling_fixture(repo, record["fingerprint"], text)
        if record["fingerprint"] in ROLE_PROBE_FINDINGS:
            verify_role_probe_token(repo, record["fingerprint"], text)
        if path == REVIEW_DOCUMENT_PATH:
            verify_auth_review_digest(repo, text, int(line))
        if path in FINAL_EVIDENCE_DOCUMENTS:
            verify_final_evidence_digest(repo, path, text, int(line))
        if path == HANDOVER_ACCEPTANCE_PATH:
            verify_handover_acceptance_digest(repo, commit, path, text, int(line))
        if path == PATCH_DOCUMENT_PATH:
            verify_patch_git_metadata(repo, text, int(line))
        elif rule == "sourcegraph-access-token":
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


def _self_test_handover_acceptance(root):
    # Separate public-only Git fixture; the original detector probes stay intact.
    repo = root / "handover-artifact-proof"
    repo.mkdir()
    run(["git", "init", "--quiet"], cwd=repo)
    identity = ["git", "-c", "user.name=Clued CI test", "-c", "user.email=ci-test@example.invalid",
                "-c", "commit.gpgsign=false"]

    def commit_file(relative, text):
        target = repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="\n")
        run(["git", "add", "."], cwd=repo)
        run(identity + ["commit", "--quiet", "-m", "public artifact proof fixture"], cwd=repo)
        return run(["git", "rev-parse", "HEAD"], cwd=repo).decode().strip()

    source_path = "scripts/ci/controlled-public-artifact.txt"
    artifact = "controlled public artifact, never a credential\n"
    source = commit_file(source_path, artifact)
    digest = hashlib.sha256(artifact.encode()).hexdigest()

    def document(source_commit, artifact_digest):
        value = {"schema": "clued.external-qualification-independent-acceptance/1", "status": "accepted",
                 "repository": "tdoljyj/cross-memory-system", "task_id": "6176fdcc-c5b0-46c9-9769-d5e0bc0ce4f8",
                 "source_commit": source_commit, "files": {source_path: artifact_digest}}
        lines = json.dumps(value, indent=2).splitlines()
        index = next(i for i, line in enumerate(lines) if line.lstrip().startswith(json.dumps(source_path) + ":"))
        lines[index:index] = [""] * (32 - index - 1)
        return "\n".join(lines) + "\n"

    def reject(commit, path, text, line, category):
        try:
            verify_handover_acceptance_digest(repo, commit, path, text, line)
        except ValueError as error:
            if category in str(error):
                return
            raise ValueError("Wrong handover rejection branch") from None
        raise ValueError("Invalid handover public digest was admitted")

    valid = document(source, digest)
    accepted_commit = commit_file(HANDOVER_ACCEPTANCE_PATH, valid)
    verify_handover_acceptance_digest(repo, accepted_commit, HANDOVER_ACCEPTANCE_PATH, valid, 32)
    forged = document(source, "0" * 64)
    forged_commit = commit_file(HANDOVER_ACCEPTANCE_PATH, forged)
    reject(forged_commit, HANDOVER_ACCEPTANCE_PATH, forged, 32, "differs from immutable artifact")
    tree = run(["git", "rev-parse", source + "^{tree}"], cwd=repo).decode().strip()
    unrelated = run(identity + ["commit-tree", tree, "-m", "unrelated public source fixture"], cwd=repo).decode().strip()
    wrong_ancestor = document(unrelated, digest)
    wrong_ancestor_commit = commit_file(HANDOVER_ACCEPTANCE_PATH, wrong_ancestor)
    reject(wrong_ancestor_commit, HANDOVER_ACCEPTANCE_PATH, wrong_ancestor, 32, "not an ancestor")
    reject(accepted_commit, HANDOVER_ACCEPTANCE_PATH, valid, 31, "Unreviewed handover acceptance location")
    reject(accepted_commit, "config/other-acceptance.json", valid, 32, "Unreviewed handover acceptance location")
    return {"actual_git_artifact_passes": True, "forged_digest_rejected": True,
            "valid_nonancestor_rejected": True, "wrong_line_rejected": True, "wrong_path_rejected": True}


def synthetic_valid_private_pem():
    """A public deterministic Ed25519 PKCS#8 fixture, generated only at runtime and never used for access."""
    seed = hashlib.sha256(b"public controlled gitleaks detector regression fixture").digest()
    der = bytes.fromhex("302e020100300506032b657004220420") + seed
    return ("-----BEGIN " + "PRIVATE KEY-----\n" + base64.b64encode(der).decode()
            + "\n-----END " + "PRIVATE KEY-----\n").encode()


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
    # Reuse only the immutable, reviewed non-credential test/document blobs inside
    # this throwaway repository. No original match text enters the report.
    fixture_blobs = {}
    for path, pin in SCHEDULING_BLOBS.items():
        blob = run(["git", "cat-file", "blob", f"{SCHEDULING_COMMIT}:{path}"], cwd=config.parent)
        if hashlib.sha256(blob).hexdigest() != pin["sha256"]:
            raise ValueError("Scheduling detector fixture blob changed")
        fixture_blobs[path] = blob
        target = test_repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)
    commit()
    code, new_commit = scan()
    required = {(SCHEDULING_TEST_PATH, "private-key"), (SCHEDULING_TEST_PATH, "generic-api-key"),
                (SCHEDULING_README_PATH, "generic-api-key")}
    if code != 1 or not required <= {(finding["File"], finding["RuleID"]) for finding in new_commit}:
        raise ValueError("Scheduling marker or prose was suppressed in a new commit")
    for path, blob in fixture_blobs.items():
        target = test_repo / "other-path" / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)
    commit()
    code, different_path = scan()
    if code != 1 or not {("other-path/" + path, rule) for path, rule in required} <= {
            (finding["File"], finding["RuleID"]) for finding in different_path}:
        raise ValueError("Scheduling marker or prose was suppressed at a different path")
    # Copy the exact historical role-probe blob as data. A new commit, path or line
    # must still be detected; the one old fingerprint grants none of these uses.
    role_blob = run(["git", "cat-file", "blob", f"{ROLE_PROBE_COMMIT}:{ROLE_PROBE_PATH}"], cwd=config.parent)
    if hashlib.sha256(role_blob).hexdigest() != ROLE_PROBE_BLOB["sha256"]:
        raise ValueError("Role-probe detector fixture blob changed")
    role_target = test_repo / ROLE_PROBE_PATH
    role_target.parent.mkdir(parents=True, exist_ok=True)
    role_target.write_bytes(role_blob)
    commit()
    code, role_new_commit = scan()
    if code != 1 or not any(f["File"] == ROLE_PROBE_PATH and f["RuleID"] == "generic-api-key"
                            and f["StartLine"] == 73 for f in role_new_commit):
        raise ValueError("Role-probe marker was suppressed in a new commit")
    other_role_path = "other-path/" + ROLE_PROBE_PATH
    other_role_target = test_repo / other_role_path
    other_role_target.parent.mkdir(parents=True, exist_ok=True)
    other_role_target.write_bytes(role_blob)
    commit()
    code, role_different_path = scan()
    if code != 1 or not any(f["File"] == other_role_path and f["RuleID"] == "generic-api-key"
                            for f in role_different_path):
        raise ValueError("Role-probe marker was suppressed at another path")
    # Delete and commit first, so the shifted token is a real Git-added line, not shifted context.
    role_target.unlink()
    commit()
    role_target.write_bytes(b"\n" + role_blob)
    commit()
    code, role_different_line = scan()
    if code != 1 or not any(f["File"] == ROLE_PROBE_PATH and f["RuleID"] == "generic-api-key"
                            and f["StartLine"] == 74 for f in role_different_line):
        raise ValueError("Role-probe marker was suppressed at another line")
    (test_repo / "controlled-valid-private.pem").write_bytes(synthetic_valid_private_pem())
    commit()
    code, valid_private = scan()
    if code != 1 or not any(finding["File"] == "controlled-valid-private.pem"
                            and finding["RuleID"] == "private-key" for finding in valid_private):
        raise ValueError("A valid controlled PKCS8 private fixture was incorrectly suppressed")
    return {"baseline_detection": True, "exact_history_only": True,
            "new_commit_detection": True, "different_path_detection": True,
            "scheduling_marker_new_commit_detection": True,
            "scheduling_marker_different_path_detection": True,
            "role_probe_new_commit_detection": True,
            "role_probe_different_path_detection": True,
            "role_probe_different_line_detection": True,
            "valid_private_key_detection": True,
            "synthetic_test_repository": str(test_repo),
            "handover_acceptance_artifact_proof": _self_test_handover_acceptance(root)}


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
