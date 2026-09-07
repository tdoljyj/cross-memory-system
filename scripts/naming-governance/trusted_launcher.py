"""Independently installed local TM-19 launcher, not a Git-main write guard.

Install exact reviewed bytes under .git/clued-phase2 using a separately issued
Bootstrap.json. This template cannot bootstrap itself or accept candidate pins.
Run with the pinned absolute Python executable and -I.
"""
# Check isolation before importing any module that a caller's cwd could shadow.
import sys
if not sys.flags.isolated:
    print('{"status":"FAIL","error":"trusted launcher requires Python -I","step18_pass":false}', file=sys.stderr)
    raise SystemExit(1)

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

CONFIG = "trust-config.json"
BOOTSTRAP = "Bootstrap.json"
PUBLICATION = "publication.py"
POST_MIGRATION = "post_migration.py"
POLICY = "policy.json"
CONTRACT = "clued.phase2.local-trust-config/v1"
BOOTSTRAP_TYPE = "Phase2TrustedLauncherBootstrap"


class TrustError(ValueError):
    def __init__(self, detail, evidence=None):
        super().__init__(detail)
        self.evidence = evidence


def require(ok, detail):
    if not ok:
        raise TrustError(detail)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def load_json(raw):
    def unique(pairs):
        output = {}
        for key, value in pairs:
            require(key not in output, "duplicate trust JSON field")
            output[key] = value
        return output
    def invalid_constant(value):
        raise TrustError("nonfinite trust JSON value")
    try:
        return json.loads(raw.decode("utf-8-sig"), object_pairs_hook=unique, parse_constant=invalid_constant)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise TrustError("invalid trust JSON") from error


def expected_sha(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value), "exact SHA256 required")
    return value


def no_links(path):
    path = Path(path)
    require(path.is_absolute(), "absolute trusted path required")
    require(".." not in path.parts, "parent traversal rejected")
    for component in (path, *path.parents):
        require(not component.is_symlink() and
                not (hasattr(component, "is_junction") and component.is_junction()),
                "linked trusted path rejected")
    return path


def file_bytes(path, expected):
    path = no_links(path)
    require(path.is_file(), "required trusted file missing")
    raw = path.read_bytes()
    require(sha(raw) == expected_sha(expected), "trusted file bytes drift: " + path.name)
    return raw


def repo_file(root, name):
    require(isinstance(name, str) and name and not name.startswith("/") and
            "\\" not in name and ":" not in name and
            all(part not in ("", ".", "..") for part in name.split("/")), "unsafe repository reference")
    path = no_links(root.joinpath(*name.split("/")))
    require(path.resolve().is_relative_to(root), "repository reference escape")
    return path


def trust():
    # Do not resolve before rejecting lexical symlink/junction components.
    launcher = Path(__file__)
    if not launcher.is_absolute():
        launcher = Path.cwd() / launcher
    no_links(launcher)
    directory = launcher.parent
    require(launcher.name == "trusted_launcher.py" and directory.name == "clued-phase2" and
            directory.parent.name == ".git" and directory.parent.is_dir(),
            "launcher is not independently installed under .git/clued-phase2")
    root = directory.parent.parent.resolve(strict=True)
    config_path = no_links(directory / CONFIG)
    config = load_json(config_path.read_bytes())
    require(config["contract"] == CONTRACT, "unsupported trust config")
    pins = config["pins"]
    require(Path(pins["repository_root"]).is_absolute() and
            Path(pins["repository_root"]).resolve(strict=True) == root, "wrong trusted repository root")
    raw = {
        "launcher": file_bytes(launcher, pins["launcher_sha256"]),
        "publication": file_bytes(directory / PUBLICATION, pins["publication_sha256"]),
        "post_migration": file_bytes(directory / POST_MIGRATION, pins["post_migration_sha256"]),
        "policy": file_bytes(directory / POLICY, pins["policy_sha256"]),
    }
    policy = load_json(raw["policy"])
    require(policy["publication_validator_sha256"] == pins["publication_sha256"],
            "policy and installed publication implementation disagree")
    python = no_links(Path(pins["python"]["path"]))
    require(python.resolve(strict=True) == Path(sys.executable).resolve(strict=True),
            "launcher Python is not the pinned runtime")
    file_bytes(python, pins["python"]["sha256"])
    gh = no_links(Path(pins["gh"]["path"]))
    require(gh.name.lower() == ("gh.exe" if os.name == "nt" else "gh"), "unexpected gh executable name")
    file_bytes(gh, pins["gh"]["sha256"])
    freeze = repo_file(root, pins["freeze"]["path"])
    file_bytes(freeze, pins["freeze"]["sha256"])
    bootstrap_raw = file_bytes(directory / BOOTSTRAP, config["bootstrap_sha256"])
    bootstrap = load_json(bootstrap_raw)
    require(bootstrap["type"] == BOOTSTRAP_TYPE and bootstrap["state"] == "AUTHORIZED" and
            bootstrap["scope"] == "TM19_GOVERNANCE_READ_PUBLISH", "explicit delegated bootstrap required")
    require(isinstance(bootstrap["actor"], str) and bootstrap["actor"], "named bootstrap actor required")
    require(bootstrap["pins_sha256"] == sha(canonical(pins)), "bootstrap does not bind these installed pins")
    authority = bootstrap["authorization_ref"]
    file_bytes(repo_file(root, authority["path"]), authority["sha256"])
    return root, directory, pins, raw, config, bootstrap, python, gh, freeze


# This code is part of the pinned launcher, not a candidate-provided bootstrap.
# It forces the current publication core's unqualified ["gh", ...] call to the
# pinned absolute binary, independent of Windows executable search precedence.
CORE_ENTRY = r"""
import hashlib, pathlib, runpy, subprocess, sys
gh, gh_sha, core = sys.argv[1:4]
original_run = subprocess.run
def fixed_run(command, *args, **kwargs):
    if isinstance(command, (list, tuple)) and command and command[0] == "gh":
        target = pathlib.Path(gh)
        for component in (target, *target.parents):
            if component.is_symlink() or (hasattr(component, "is_junction") and component.is_junction()):
                raise RuntimeError("pinned gh path became a link")
        if hashlib.sha256(target.read_bytes()).hexdigest() != gh_sha:
            raise RuntimeError("pinned gh bytes changed before execution")
        command = [gh, *command[1:]]
    return original_run(command, *args, **kwargs)
subprocess.run = fixed_run
sys.argv = [core, *sys.argv[4:]]
runpy.run_path(core, run_name="__main__")
"""


def environment(gh):
    env = {key: value for key, value in os.environ.items()
           if not key.upper().startswith("PYTHON") and key.upper() not in ("GH_HOST", "GH_DEBUG")}
    env["PATH"] = str(gh.parent)
    if os.name == "nt":
        env["PATHEXT"] = ".EXE"
    env["GH_HOST"] = "github.com"
    env["GH_PROMPT_DISABLED"] = "1"
    return env


def execute(args):
    root, directory, pins, raw, config, bootstrap, python, gh, freeze = trust()
    if args.command == "read":
        require(args.attestation_commit is None and args.publication_pr is None and args.expected_current is None,
                "read uses only the installed activation selector")
    else:
        require(isinstance(args.attestation_commit, str) and
                re.fullmatch(r"[0-9a-f]{40}", args.attestation_commit), "exact attestation SHA required")
        require(type(args.publication_pr) is int and args.publication_pr > 0, "publication PR required")
        if args.command == "publish":
            require(args.expected_current == "NONE" or
                    (isinstance(args.expected_current, str) and re.fullmatch(r"[0-9a-f]{64}", args.expected_current)),
                    "publish requires exact expected-current SHA or NONE")
        else:
            require(args.expected_current is None, "validate does not accept a write CAS")
    run_parent = no_links(directory / ".runs")
    run_parent.mkdir(exist_ok=True)
    env = environment(gh)
    # Verified byte snapshots prevent later source replacement from changing the
    # code/policy executed in this invocation. Same-UID admin compromise is not
    # claimed to be blocked by this local trust store.
    with tempfile.TemporaryDirectory(prefix="request-", dir=run_parent) as temporary:
        run_dir = no_links(Path(temporary))
        core = run_dir / PUBLICATION
        post = run_dir / POST_MIGRATION
        policy = run_dir / POLICY
        for path, content in ((core, raw["publication"]), (post, raw["post_migration"]), (policy, raw["policy"])):
            path.write_bytes(content)
        guard_path = run_dir / "PostMigrationGuard.json"
        checked = subprocess.run(
            [str(python), "-I", "-B", "-X", "utf8", str(post), "--repo", str(root), "--freeze", str(freeze),
             "--expected-freeze-sha", pins["freeze"]["sha256"], "--report", str(guard_path)],
            cwd=run_dir, env=env, capture_output=True, timeout=120,
        )
        require(not guard_path.is_symlink() and guard_path.is_file(), "local guard evidence missing")
        guard = load_json(guard_path.read_bytes())
        if checked.returncode != 0:
            raise TrustError("local post-migration guard rejected before publication", {"local_post_migration_guard": guard})
        require(guard.get("type") == "Phase2PostMigrationFileBoundaryEvidence" and
                guard.get("status") == "PASS" and type(guard.get("exit_code")) is int and guard["exit_code"] == 0 and
                guard.get("freeze_sha256") == pins["freeze"]["sha256"] and
                guard.get("authority_effect") == "NONE", "local guard evidence does not qualify")
        selectors = [args.command, "--policy", str(policy), "--policy-sha256", pins["policy_sha256"]]
        if args.command in ("read", "publish"):
            selectors.extend(["--repo-root", str(root)])
        if args.command in ("validate", "publish"):
            selectors.extend(["--attestation-commit", args.attestation_commit, "--publication-pr", str(args.publication_pr)])
        if args.command == "publish":
            selectors.extend(["--expected-current", args.expected_current])
        result = subprocess.run(
            [str(python), "-I", "-B", "-X", "utf8", "-c", CORE_ENTRY, str(gh), pins["gh"]["sha256"], str(core), *selectors],
            cwd=run_dir, env=env, capture_output=True, timeout=900,
        )
        core_report = load_json(result.stdout)
        if result.returncode != 0:
            raise TrustError("trusted publication core rejected (exit " + str(result.returncode) + ")", {"core": core_report})
        require(core_report.get("validation") == "PASS", "trusted publication result missing")
        return {
            "type": "Phase2TrustedLauncherExecution", "status": "PASS", "mode": args.command,
            "step15_pass": False, "step18_pass": False,
            "fixture_only": bootstrap.get("fixture_only") is True,
            "bootstrap_sha256": config["bootstrap_sha256"], "pins_sha256": bootstrap["pins_sha256"],
            "local_post_migration_guard": guard, "core": core_report,
            "scope": "Configured local TM19 governance publication/read; not Git-main protection.",
            "administrator_exception": "Same-UID owner/admin replacement of the trust store is outside this boundary and must be separately audited.",
        }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", default="read", choices=("read", "validate", "publish"))
    parser.add_argument("--attestation-commit")
    parser.add_argument("--publication-pr", type=int)
    parser.add_argument("--expected-current")
    args = parser.parse_args(argv)
    try:
        report = execute(args)
        print(json.dumps(report, ensure_ascii=True))
        return 0
    except (TrustError, ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"type": "Phase2TrustedLauncherExecution", "status": "FAIL",
                          "step15_pass": False, "step18_pass": False, "error": str(error),
                          "evidence": getattr(error, "evidence", None)}, ensure_ascii=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
