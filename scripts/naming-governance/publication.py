"""Fail-closed TM-19 publication core; no service, deployment or runtime authority.

CLI uses authenticated GitHub responses, never caller-supplied metadata fixtures.
The caller MUST pin policy bytes independently of candidate/activation content.
GitHub performs signature verification; this module does not claim local GPG verification.
Unit tests may inject a synthetic API, which the CLI cannot select.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile
from typing import Protocol
from urllib.parse import quote
import zipfile

CONTRACT = "clued.phase2.publication-statement/v1"
POLICY_CONTRACT = "clued.phase2.publication-policy/v1"
ACTIVATION_CONTRACT = "clued.phase2.activation-reference/v1"
EXECUTION_CONTRACT = "clued.phase2.ci-execution/v1"
TARGET = Path("development/authority-index/phase2/Activation.json")
RECEIPTS = Path("artifacts/clued-validation/phase2-publication-receipts")
SOURCE_INDEX = "development/authority-index/phase2/SourceIndex.json"
GATES = ("candidate_identity", "manifest_integrity", "provenance", "product_increment_input")
BASE_CORE = {"public-mcp-protocol", "public-mcp-behavior", "gitleaks", "trivy"}
NAMING_RULES = (
    "SOURCE_REFERENCE", "OWNER", "CANONICAL_IDENTITY", "ALIAS_RESOLUTION",
    "CURRENT_HISTORICAL", "PREDECESSOR", "VERSION_AXIS", "RECEIPT_SUBJECT",
    "AUTHORIZATION_SCOPE", "CONSUMER_NAMESPACE", "COPY_ORIGINAL",
    "REPRESENTATION_CANONICAL", "PROJECTION_DRIFT", "STATUS_TRUTH", "TYPED_BINDING",
)


class PublicationError(ValueError):
    pass


def need(condition, message):
    if not condition:
        raise PublicationError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n").encode()


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            need(key not in result, f"duplicate JSON key: {key}")
            result[key] = value
        return result
    def constant(value):
        raise PublicationError(f"nonfinite JSON number: {value}")
    try:
        return json.loads(data.decode("utf-8-sig"), object_pairs_hook=pairs, parse_constant=constant)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise PublicationError(f"invalid JSON: {error}") from error


def sha(value, size=64):
    need(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{" + str(size) + r"}", value),
         f"invalid SHA-{size}: {value!r}")
    return value


def positive(value):
    need(type(value) is int and value > 0, "expected positive integer")
    return value


def relative(value):
    need(isinstance(value, str) and value and "\\" not in value and ":" not in value,
         "invalid relative path")
    need(not value.startswith("/") and all(x not in ("", ".", "..") for x in value.split("/")),
         f"unsafe relative path: {value}")
    return value


def pointer(document, path):
    need(isinstance(path, str) and path.startswith("/"), "nonempty JSON pointer required")
    value = document
    for token in path[1:].split("/"):
        token = token.replace("~1", "/").replace("~0", "~")
        try:
            value = value[int(token)] if isinstance(value, list) else value[token]
        except (KeyError, IndexError, ValueError, TypeError) as error:
            raise PublicationError(f"missing pointer {path}") from error
    return value


def exact(actual, expected, label):
    # bool must never compare equal to integer 0/1.
    need(type(actual) is type(expected) and actual == expected, f"{label}: mismatch")


def instant(value):
    need(isinstance(value, str), "timestamp required")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        need(result.tzinfo is not None, "timezone required")
        return result
    except ValueError as error:
        raise PublicationError("invalid timestamp") from error


@dataclass(frozen=True)
class PinnedPolicy:
    value: dict
    sha256: str


def load_policy(raw, independently_pinned_sha256):
    sha(independently_pinned_sha256)
    exact(digest(raw), independently_pinned_sha256, "independently pinned policy")
    p = strict_json(raw)
    exact(p["contract"], POLICY_CONTRACT, "policy contract")
    exact(digest(Path(__file__).read_bytes()), sha(p["publication_validator_sha256"]),
          "pinned publication implementation")
    need(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", p["repository"]), "invalid repository")
    sha(p["source_commit"], 40)
    sha(p["subject"]["sha256"])
    sha(p["candidate_package"]["sha256"])
    positive(p["candidate_package"]["bytes"])
    positive(p["candidate_package"]["members"])
    need(isinstance(p["subject"]["id"], str) and p["subject"]["id"], "subject ID required")
    positive(p["sequence"])
    need(isinstance(p["publisher_actor"], str) and p["publisher_actor"], "publisher actor required")
    need(isinstance(p["publisher_base_ref"], str) and p["publisher_base_ref"], "publisher base required")
    relative(p["statement_path"])
    need(SOURCE_INDEX in p["payloads"], "TM-19 SourceIndex governed payload required")
    for path, expected in p["payloads"].items():
        relative(path)
        sha(expected)
    for kind in ("acceptance", "freeze"):
        ref = p[kind]
        relative(ref["path"])
        sha(ref["sha256"])
        need(ref["assertions"], f"{kind}: decision assertions required")
        need(ref["subject_pointer"].startswith("/"), f"{kind}: subject binding required")
    exact(set(p["workflows"]), {"four_gates", "naming"}, "exact workflow roles")
    for spec in p["workflows"].values():
        positive(spec["id"])
        relative(spec["path"])
        need(spec["path"].startswith(".github/workflows/"), "workflow path required")
        sha(spec["sha256"])
        relative(spec["receipt_path"])
        relative(spec["execution_path"])
        need(spec["job_name"] and spec["step_name"], "actual job/step selectors required")
        need(spec["trusted_sources"], "trusted verifier source hashes required")
        for path, expected in spec["trusted_sources"].items():
            relative(path)
            sha(expected)
    need(BASE_CORE <= set(p["additional_required_runs"]), "original BASE_CORE check set required")
    for name, spec in p["additional_required_runs"].items():
        positive(spec["id"])
        relative(spec["path"])
        need(spec["path"].startswith(".github/workflows/"), "additional workflow path required")
        sha(spec["sha256"])
        need(spec["job_names"] and len(spec["job_names"]) == len(set(spec["job_names"])), "exact job names required")
        positive(spec["app_id"])
        need(spec["app_slug"] and spec["events"], "check source app and event selection required")
        if name in BASE_CORE:
            exact(spec["path"], ".github/workflows/" + name + ".yml", "original BASE_CORE workflow")
        need(spec["trusted_sources"], "additional check implementation sources required")
        for path, expected in spec["trusted_sources"].items():
            relative(path)
            sha(expected)
    sha(p["naming_bindings_sha256"])
    sha(p["naming_validator_sha256"])
    return PinnedPolicy(p, independently_pinned_sha256)


class GitHubAPI(Protocol):
    provenance: str
    def get(self, endpoint: str) -> dict: ...
    def download(self, endpoint: str) -> bytes: ...


class LiveGitHub:
    """Only production adapter. No metadata-file, fixture, host or executable override."""
    provenance = "AUTHENTICATED_GITHUB_API"

    @staticmethod
    def request(endpoint):
        need(endpoint.startswith("/repos/") and ".." not in endpoint, "invalid GitHub endpoint")
        result = subprocess.run(
            ["gh", "api", "--hostname", "github.com", endpoint],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=120,
        )
        # Do not echo stderr, which may contain credential-bearing URLs.
        need(result.returncode == 0, f"GitHub API request failed ({result.returncode}) for {endpoint}")
        return result.stdout

    def get(self, endpoint):
        return strict_json(self.request(endpoint))

    def download(self, endpoint):
        return self.request(endpoint)


class Verifier:
    def __init__(self, policy: PinnedPolicy, api: GitHubAPI):
        need(isinstance(policy, PinnedPolicy), "independently pinned policy object required")
        self.p = policy.value
        self.policy_sha = policy.sha256
        self.api = api
        self.base = "/repos/" + self.p["repository"]
        self.observations = []
        self.blobs = {}
        self.artifact_downloads = {}
        self.signature_evidence = None

    def get(self, suffix):
        endpoint = self.base + suffix
        value = self.api.get(endpoint)
        self.observations.append({"endpoint": endpoint, "canonical_response_sha256": digest(canonical(value))})
        return value

    def blob(self, path, commit):
        relative(path)
        sha(commit, 40)
        key = (path, commit)
        if key not in self.blobs:
            obj = self.get("/contents/" + quote(path, safe="/") + "?ref=" + commit)
            exact(obj["type"], "file", "source type")
            exact(obj["encoding"], "base64", "source encoding")
            exact(obj["path"], path, "source path")
            try:
                raw = base64.b64decode("".join(obj["content"].split()), validate=True)
            except (ValueError, TypeError) as error:
                raise PublicationError("invalid GitHub blob encoding") from error
            actual_blob = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
            exact(obj["sha"], actual_blob, "Git blob object identity")
            self.blobs[key] = raw
        return self.blobs[key]

    def bound_json(self, reference):
        raw = self.blob(reference["path"], self.p["source_commit"])
        exact(digest(raw), reference["sha256"], "accepted source bytes")
        obj = strict_json(raw)
        for path, expected in reference["assertions"].items():
            exact(pointer(obj, path), expected, "decision " + path)
        exact(pointer(obj, reference["subject_pointer"]), self.p["subject"]["sha256"],
              "decision subject SHA")
        return obj

    def signed_statement(self, selector):
        commit_sha = sha(selector["attestation_commit"], 40)
        pr_number = positive(selector["publication_pr"])
        commit = self.get("/commits/" + commit_sha)
        exact(commit["sha"], commit_sha, "attestation commit")
        exact(commit["committer"]["login"], "web-flow", "GitHub service signing identity")
        v = commit["commit"]["verification"]
        need(v["verified"] is True and v["reason"] == "valid", "signature not verified by GitHub")
        need(isinstance(v["signature"], str) and
             v["signature"].startswith("-----BEGIN PGP SIGNATURE-----") and
             "-----END PGP SIGNATURE-----" in v["signature"], "missing GitHub GPG signature")
        need(isinstance(v["payload"], str) and v["payload"], "missing signed payload")
        tree = sha(commit["commit"]["tree"]["sha"], 40)
        need(v["payload"].startswith("tree " + tree + "\n"), "signature payload/tree mismatch")
        signed_parents = re.findall(r"^parent ([0-9a-f]{40})$", v["payload"].split("\n\n", 1)[0], re.M)
        exact(signed_parents, [row["sha"] for row in commit["parents"]], "signed parents")
        need(len(signed_parents) == 2, "publication requires actual merge commit")
        pr = self.get("/pulls/" + str(pr_number))
        need(pr["merged"] is True, "publication PR is not merged")
        exact(pr["merge_commit_sha"], commit_sha, "PR merge commit")
        exact(pr["merged_by"]["login"], self.p["publisher_actor"], "authorized publishing actor")
        exact(pr["base"]["repo"]["full_name"], self.p["repository"], "publication repository")
        exact(pr["base"]["ref"], self.p["publisher_base_ref"], "publication base")
        self.signature_evidence = {
            "commit_sha": commit_sha, "tree_sha": tree, "publication_pr": pr_number,
            "merged_by": pr["merged_by"]["login"],
            "verification": {key: v.get(key) for key in ("verified", "reason", "signature", "payload", "verified_at")},
            "verification_source": self.api.provenance,
        }
        statement = strict_json(self.blob(self.p["statement_path"], commit_sha))
        exact(statement["contract"], CONTRACT, "statement contract")
        for field in ("repository", "source_commit", "subject", "candidate_package", "payloads", "sequence"):
            exact(statement[field], self.p[field], "signed statement " + field)
        exact(statement["acceptance_sha256"], self.p["acceptance"]["sha256"], "accepted subject decision")
        exact(statement["freeze_sha256"], self.p["freeze"]["sha256"], "Freeze decision")
        # A valid old signature never authorizes a different current source/subject/sequence.
        return statement

    def receipt_bundle(self, role, evidence):
        spec = self.p["workflows"][role]
        run_id, attempt, artifact_id = map(positive, (evidence["run_id"], evidence["attempt"], evidence["artifact_id"]))
        source = self.p["source_commit"]
        run = self.get(f"/actions/runs/{run_id}/attempts/{attempt}")
        exact(run["id"], run_id, "CI run")
        exact(run["run_attempt"], attempt, "CI attempt")
        exact(run["repository"]["full_name"], self.p["repository"], "CI repository")
        exact(run["head_repository"]["full_name"], self.p["repository"], "CI source repository")
        exact(run["head_sha"], source, "CI source SHA")
        exact(run["workflow_id"], spec["id"], "CI workflow ID")
        exact(run["path"], spec["path"], "CI workflow path")
        exact(run["status"], "completed", "CI state")
        exact(run["conclusion"], "success", "CI conclusion")
        need(run["event"] in ("push", "workflow_dispatch"), "unsupported CI event/trust model")
        jobs = self.get(f"/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
        need(type(jobs["total_count"]) is int and jobs["total_count"] < 100 and
             len(jobs["jobs"]) == jobs["total_count"], "proof job pagination incomplete")
        selected_jobs = [job for job in jobs["jobs"] if job["name"] == spec["job_name"]]
        need(len(selected_jobs) == 1, "missing/ambiguous proof job")
        job = selected_jobs[0]
        exact(job["run_id"], run_id, "proof job run")
        exact(job["status"], "completed", "proof job state")
        exact(job["conclusion"], "success", "proof job result")
        steps = [step for step in job["steps"] if step["name"] == spec["step_name"]]
        need(len(steps) == 1, "missing/ambiguous proof step")
        step = steps[0]
        exact(step["status"], "completed", "proof step state")
        exact(step["conclusion"], "success", "proof step result")
        need(instant(step["started_at"]) <= instant(step["completed_at"]), "proof step timestamps")
        # The trusted workflow's actual source at the candidate SHA must be unchanged.
        exact(digest(self.blob(spec["path"], source)), spec["sha256"], "trusted workflow bytes")
        for path, expected in spec["trusted_sources"].items():
            exact(digest(self.blob(path, source)), expected, "trusted verifier/policy source")
        meta = self.get(f"/actions/artifacts/{artifact_id}")
        exact(meta["id"], artifact_id, "artifact ID")
        need(meta["expired"] is False, "artifact expired or missing expiry evidence")
        exact(meta["workflow_run"]["id"], run_id, "artifact run")
        exact(meta["workflow_run"]["head_sha"], source, "artifact source")
        exact(meta["digest"], "sha256:" + sha(evidence["zip_sha256"]), "platform artifact digest")
        need(instant(run["run_started_at"]) <= instant(meta["created_at"]) <= instant(run["updated_at"]),
             "artifact outside selected run attempt")
        need(instant(meta["created_at"]) >= instant(step["completed_at"]), "artifact predates actual proof step")
        need(type(meta["size_in_bytes"]) is int and 0 < meta["size_in_bytes"] <= 256 * 1024 * 1024,
             "artifact size unsupported")
        if artifact_id not in self.artifact_downloads:
            self.artifact_downloads[artifact_id] = self.api.download(self.base + f"/actions/artifacts/{artifact_id}/zip")
        raw = self.artifact_downloads[artifact_id]
        exact(len(raw), meta["size_in_bytes"], "artifact download size")
        exact(digest(raw), evidence["zip_sha256"], "downloaded artifact digest")
        self.observations.append({"artifact_id": artifact_id, "zip_sha256": digest(raw)})
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                names = z.namelist()
                need(len(names) == len(set(names)), "duplicate artifact ZIP members")
                objects = []
                for key in ("receipt", "execution"):
                    path = spec[key + "_path"]
                    info = z.getinfo(path)
                    need(not info.is_dir() and info.file_size <= 16 * 1024 * 1024,
                         "receipt member invalid/too large")
                    data = z.read(info)
                    exact(digest(data), evidence[key + "_sha256"], key + " byte binding")
                    objects.append(strict_json(data))
        except (zipfile.BadZipFile, KeyError, RuntimeError) as error:
            raise PublicationError("missing or invalid artifact receipt members") from error
        receipt, execution = objects
        exact(execution["contract"], EXECUTION_CONTRACT, "execution envelope")
        exact(execution["repository"], self.p["repository"], "execution repository")
        exact(execution["source_commit"], source, "execution source SHA")
        workflow_ref = self.p["repository"] + "/" + spec["path"] + "@refs/heads/" + run["head_branch"]
        exact(execution["workflow_ref"], workflow_ref,
              "execution workflow source")
        exact(execution["workflow_sha"], source, "execution immutable workflow SHA")
        exact(execution["run_id"], str(run_id), "execution run")
        exact(execution["run_attempt"], str(attempt), "execution attempt")
        exact(execution["negative_case"], "none", "positive execution required")
        if role == "four_gates":
            exact(receipt["schema"], "clued.phase2-v027-ci-gate-receipt/v1", "four-gate receipt schema")
            exact(receipt["repository"], self.p["repository"], "four-gate repository")
            exact(receipt["commit_sha"], source, "four-gate source")
            exact(receipt["run_id"], str(run_id), "four-gate run")
            exact(receipt["run_attempt"], str(attempt), "four-gate attempt")
            exact(receipt["workflow_ref"], workflow_ref, "four-gate workflow ref")
            exact(receipt["overall"], "PASS", "four-gate overall")
            exact(set(receipt["gates"]), set(GATES), "exact four-gate set")
            for gate in GATES:
                exact(receipt["gates"][gate]["status"], "PASS", "actual gate " + gate)
            for key in ("sha256", "bytes", "members"):
                exact(receipt["gates"]["candidate_identity"]["details"][key],
                      self.p["candidate_package"][key], "four-gate actual package " + key)
        else:
            exact(receipt["format"], "STEP8_BOUNDED_VALIDATION_RECEIPT", "Naming native receipt")
            exact(receipt["status"], "SCOPED_EVIDENCE_PASS", "Naming actual result")
            exact(receipt["exit_code"], 0, "Naming exit")
            need(receipt["fixture_only"] is False, "Naming fixture cannot publish")
            exact(receipt["subject"]["sha256"], self.p["naming_bindings_sha256"], "Naming input binding")
            exact(receipt["validator_sha256"], self.p["naming_validator_sha256"], "Naming validator")
            exact(receipt["errors"], [], "Naming errors")
            rows = receipt["checks"]
            need(len(rows) == len(NAMING_RULES), "Naming rule count")
            exact({row["rule"] for row in rows}, set(NAMING_RULES), "Naming required rules")
            for row in rows:
                exact(row["status"], "PASS", "actual Naming rule " + row["rule"])
        return {"run_id": run_id, "attempt": attempt, "artifact_id": artifact_id,
                "zip_sha256": evidence["zip_sha256"], "receipt_sha256": evidence["receipt_sha256"],
                "job_name": spec["job_name"], "step_name": spec["step_name"],
                "started_at": step["started_at"], "completed_at": step["completed_at"]}

    def additional_run(self, name, evidence):
        """Actual platform checks without inventing a native receipt for existing workflows."""
        spec = self.p["additional_required_runs"][name]
        run_id, attempt = positive(evidence["run_id"]), positive(evidence["attempt"])
        source = self.p["source_commit"]
        run = self.get(f"/actions/runs/{run_id}/attempts/{attempt}")
        for key, expected in (("id", run_id), ("run_attempt", attempt), ("head_sha", source),
                              ("workflow_id", spec["id"]), ("path", spec["path"]),
                              ("status", "completed"), ("conclusion", "success")):
            exact(run[key], expected, "additional " + name + " " + key)
        exact(run["repository"]["full_name"], self.p["repository"], "additional run repository")
        exact(run["head_repository"]["full_name"], self.p["repository"], "additional source repository")
        need(run["event"] in spec["events"], "additional event not accepted")
        exact(digest(self.blob(spec["path"], source)), spec["sha256"], "additional trusted workflow")
        for path, expected in spec["trusted_sources"].items():
            exact(digest(self.blob(path, source)), expected, "additional trusted source")
        listing = self.get(f"/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
        jobs = listing["jobs"]
        need(type(listing["total_count"]) is int and listing["total_count"] < 100 and
             len(jobs) == listing["total_count"], "additional job pagination incomplete")
        selected = []
        for job_name in spec["job_names"]:
            matches = [job for job in jobs if job["name"] == job_name]
            need(len(matches) == 1, "missing or duplicate required job: " + job_name)
            job = matches[0]
            exact(job["run_id"], run_id, "required job run")
            exact(job["status"], "completed", "required job state")
            exact(job["conclusion"], "success", "required job actual result")
            match = re.fullmatch(r"https://api\.github\.com" + re.escape(self.base) + r"/check-runs/([0-9]+)", job["check_run_url"])
            need(match is not None, "required job check URL identity")
            check = self.get("/check-runs/" + match.group(1))
            exact(check["id"], int(match.group(1)), "check ID")
            exact(check["name"], job_name, "check name")
            exact(check["head_sha"], source, "check source SHA")
            exact(check["check_suite"]["id"], run["check_suite_id"], "check/run suite association")
            exact(check["status"], "completed", "check state")
            exact(check["conclusion"], "success", "check result")
            exact(check["app"]["id"], spec["app_id"], "check source app ID")
            exact(check["app"]["slug"], spec["app_slug"], "check source app slug")
            selected.append({"job": job_name, "check_run_id": check["id"], "app_id": check["app"]["id"]})
        return {"run_id": run_id, "attempt": attempt, "checks": selected}

    def validate(self, selector):
        repo = self.get("")
        exact(repo["full_name"], self.p["repository"], "repository identity")
        need(repo["private"] is True and repo["owner"]["type"] == "User", "current access scope changed")
        exact(repo["owner"]["login"], self.p["publisher_actor"], "current owner/publisher")
        # Refuse incomplete pages and any newly granted ordinary writer.
        collaborators = self.get("/collaborators?per_page=100")
        need(isinstance(collaborators, list) and len(collaborators) < 100, "collaborator pagination unresolved")
        exact({row["login"] for row in collaborators}, {self.p["publisher_actor"]},
              "actor set changed; invalidate boundary")
        need(len(collaborators) == 1 and collaborators[0]["permissions"]["admin"] is True,
             "publisher is not current administrator")
        self.bound_json(self.p["acceptance"])
        self.bound_json(self.p["freeze"])
        statement = self.signed_statement(selector)
        for path, expected in self.p["payloads"].items():
            exact(digest(self.blob(path, self.p["source_commit"])), expected, "governed payload")
        exact(set(statement["evidence"]), {"four_gates", "naming"}, "required evidence roles")
        proof = {role: self.receipt_bundle(role, statement["evidence"][role])
                 for role in ("four_gates", "naming")}
        need(instant(proof["naming"]["completed_at"]) <= instant(proof["four_gates"]["started_at"]),
             "actual Step15 Naming must precede Step16 four gates")
        exact(set(statement["additional_required_runs"]), set(self.p["additional_required_runs"]),
              "exact additional required run set")
        additional = {name: self.additional_run(name, statement["additional_required_runs"][name])
                      for name in self.p["additional_required_runs"]}
        return {
            "contract": ACTIVATION_CONTRACT, "policy_sha256": self.policy_sha,
            "attestation_commit": selector["attestation_commit"], "publication_pr": selector["publication_pr"],
            "repository": self.p["repository"], "source_commit": self.p["source_commit"],
            "subject": self.p["subject"], "sequence": self.p["sequence"], "payloads": self.p["payloads"],
            "evidence": proof, "additional_required_runs": additional,
            "authority_effect": "DERIVED_ACCEPTED_REFERENCES_ONLY",
        }


def validate(policy, api, selector):
    verifier = Verifier(policy, api)
    try:
        activation = verifier.validate(selector)
    except (KeyError, TypeError, IndexError) as error:
        raise PublicationError(f"missing or malformed required evidence: {error}") from error
    live = type(api) is LiveGitHub
    return activation, {
        "validation": "PASS", "step18_pass": False,
        "evidence_class": "LIVE_PLATFORM_RESPONSE_VERIFICATION" if live else "INJECTED_TEST_API_PREDICATES_ONLY",
        "signature_verified_locally": False, "signature_evidence": verifier.signature_evidence,
        "publication_validator_sha256": digest(Path(__file__).read_bytes()),
        "api_provenance": api.provenance, "observations": verifier.observations,
    }


def target_path(repo_root, relative_path=TARGET):
    root = Path(repo_root).resolve(strict=True)
    target = root / relative_path
    for item in (target, *target.parents):
        if item == root:
            break
        need(not item.is_symlink() and not (hasattr(item, "is_junction") and item.is_junction()),
             "activation path has symlink/junction")
        need(item.resolve().is_relative_to(root), "activation path escape")
    return target


def read_activation(policy, api, repo_root):
    target = target_path(repo_root)
    obj = strict_json(target.read_bytes())
    exact(obj["contract"], ACTIVATION_CONTRACT, "activation contract; bare pointer rejected")
    exact(obj["policy_sha256"], policy.sha256, "activation policy pin")
    fresh, report = validate(policy, api, obj)
    exact(obj, fresh, "activation must be an exact current verified projection")
    return fresh, report


@contextmanager
def publication_directories(repo_root):
    """Hold Windows directory identities through verification and both writes.

    OPEN_REPARSE_POINT opens the directory entry itself; subsequent path checks
    reject links. Omitting FILE_SHARE_DELETE prevents rename/replacement while
    the handle is held. Each parent is held before creating/opening its child.
    No equivalent descriptor-relative writer exists here for other platforms.
    """
    need(os.name == "nt", "publication writes require Windows directory-handle protection")
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                       wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    close.restype = wintypes.BOOL
    invalid = ctypes.c_void_p(-1).value
    root = Path(repo_root).resolve(strict=True)
    handles, held = [], set()
    try:
        for relative_dir in (TARGET.parent, RECEIPTS):
            chain = [root]
            for part in relative_dir.parts:
                chain.append(chain[-1] / part)
            for directory in chain:
                if directory in held:
                    continue
                if directory != root:
                    # Its parent is already held against rename/replacement.
                    directory.mkdir(exist_ok=True)
                handle = create(str(directory), 0x80000000, 0x1 | 0x2, None, 3,
                                0x02000000 | 0x00200000, None)
                need(handle != invalid, "cannot retain publication directory identity")
                handles.append(handle)
                need(directory.is_dir() and not directory.is_symlink() and
                     not (hasattr(directory, "is_junction") and directory.is_junction()),
                     "publication directory has symlink/junction or invalid type")
                need(directory.resolve().is_relative_to(root), "publication directory escape")
                held.add(directory)
        # All ancestors are now stable, including both final output parents.
        target_path(root)
        target_path(root, RECEIPTS)
        yield root
    finally:
        for handle in reversed(handles):
            close(handle)


def publish(policy, api, repo_root, selector, expected_current):
    with publication_directories(repo_root) as root:
        return _publish_guarded(policy, api, root, selector, expected_current)


def _publish_guarded(policy, api, repo_root, selector, expected_current):
    # Explicit command only. Revalidate live facts here; no prior JSON PASS input.
    target = target_path(repo_root)
    target.parent.mkdir(parents=True, exist_ok=True)
    lock = target.parent / ".publication.lock"
    try:
        lock_fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise PublicationError("publication lock held") from error
    try:
        os.close(lock_fd)
        current_bytes = target.read_bytes() if target.exists() else None
        actual = digest(current_bytes) if current_bytes is not None else "NONE"
        exact(actual, expected_current, "expected-current CAS")
        activation, report = validate(policy, api, selector)
        if current_bytes is not None:
            current = strict_json(current_bytes)
            if current == activation:
                return activation, dict(report, activated=False, no_op=True)
            need(type(current.get("sequence")) is int and current["sequence"] < activation["sequence"],
                 "stale activation sequence; rollback requires separate authorized policy/event")
        raw = canonical(activation)
        # Record the derived event before the atomic switch. It has no independent approval authority.
        events = target_path(repo_root, RECEIPTS)
        need(not events.is_symlink() and not (hasattr(events, "is_junction") and events.is_junction()),
             "publication receipts path escape")
        events.mkdir(parents=True, exist_ok=True)
        event = {"previous_activation_sha256": actual, "activation_sha256": digest(raw),
                 "activation": activation, "verification": report}
        event_path = events / (digest(canonical(event)) + ".json")
        with event_path.open("xb") as stream:
            stream.write(canonical(event))
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            # Detect a writer that ignored the lock before switching.
            now = digest(target.read_bytes()) if target.exists() else "NONE"
            exact(now, actual, "activation changed during validation")
            os.replace(temporary, target)
            temporary = None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return activation, dict(report, activated=True, activation_sha256=digest(raw))
    finally:
        lock.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("validate", "read", "publish"), nargs="?", default="validate")
    parser.add_argument("--policy", type=Path, required=True)
    parser.add_argument("--policy-sha256", required=True, help="Independently pinned by the trusted caller, never copied from candidate JSON.")
    parser.add_argument("--repo-root", type=Path)
    parser.add_argument("--attestation-commit")
    parser.add_argument("--publication-pr", type=int)
    parser.add_argument("--expected-current", help="publish only: exact current Activation.json SHA-256, or NONE.")
    args = parser.parse_args(argv)
    try:
        policy = load_policy(args.policy.read_bytes(), args.policy_sha256)
        api = LiveGitHub()
        if args.command == "read":
            need(args.repo_root is not None, "read requires --repo-root")
            _, report = read_activation(policy, api, args.repo_root)
        else:
            selector = {"attestation_commit": args.attestation_commit, "publication_pr": args.publication_pr}
            if args.command == "publish":
                need(args.repo_root is not None and args.expected_current is not None,
                     "publish requires explicit --repo-root and --expected-current")
                if args.expected_current != "NONE":
                    sha(args.expected_current)
                _, report = publish(policy, api, args.repo_root, selector, args.expected_current)
            else:
                _, report = validate(policy, api, selector)
        print(json.dumps(report, ensure_ascii=False))
        return 0
    except (PublicationError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"validation": "FAIL", "step18_pass": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
