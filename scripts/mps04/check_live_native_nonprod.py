"""Bounded same-host D-007 read probe; only clued-auth-test and PR #274.

The workflow supplies a short-lived contents:read GitHub token. The database
password stays in the existing Windows credential store and child environments;
neither credential is printed, written to evidence, or passed in argv.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[2]
CLIENT = Path(r"C:\Users\Windows\Documents\Codex\2026-09-20\referenced-chatgpt-conversation-this-is-an\work")
PROJECT = "uscrdifznmlvczcekqpw"
HOST = "aws-0-ap-northeast-2.pooler.supabase.com"
OBJECT = "obj_cc84df9e10c748ef9ac853526aed1ac9"
A = "39d7f32c9362d1ddad94202fb8ae6500b0e3c2a8"
REPOSITORY = "tdoljyj/cross-memory-system"


def _port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _http(url: str, *, body: dict | None = None, token: str = "") -> dict:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    request = Request(url, headers=headers,
                      data=None if body is None else json.dumps(body).encode(),
                      method="POST" if body is not None else "GET")
    try:
        with urlopen(request, timeout=45) as response:
            return json.loads(response.read(1_048_577))
    except HTTPError as error:
        # No request headers, credential values, or server body in CI output.
        raise RuntimeError(f"NONPROD_GATEWAY_HTTP_{error.code}") from None


def _query(password: str, sql: str) -> list[str]:
    env = os.environ.copy()
    env["PGPASSWORD"] = password
    env["PYTHONPATH"] = str(CLIENT / "mps03_psql_bin") + os.pathsep + env.get("PYTHONPATH", "")
    env.pop("MPS03_TEST_PSQL_ERROR_LOG", None)
    uri = f"postgresql://postgres.{PROJECT}@{HOST}:5432/postgres?sslmode=verify-full"
    result = subprocess.run(
        [str(CLIENT / "mps03_psql_bin" / "psql.exe"), uri,
         "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1"],
        input="begin transaction read only;\n" + sql + "\ncommit;\n",
        text=True, capture_output=True, env=env, timeout=45,
    )
    if result.returncode:
        raise RuntimeError("NONPROD_DATABASE_READ_FAILED")
    return [row.strip() for row in result.stdout.splitlines() if row.strip()]


def _current(password: str) -> list[str]:
    rows = _query(password,
        "select o.user_id::text,h.current_revision_id,h.current_adoption_id,"
        "r.content->>'repository',r.content->>'adopted_exact_commit' "
        "from clued_private.mps_objects o "
        "join clued_private.mps_state_heads h on h.object_id=o.object_id "
        "join clued_private.mps_revisions r on r.object_id=o.object_id "
        "and r.revision_id=h.current_revision_id "
        f"where o.object_id='{OBJECT}';")
    if len(rows) != 1:
        raise RuntimeError("NONPROD_CURRENT_NOT_UNIQUE")
    current = rows[0].split("|")
    if len(current) != 5 or current[3:] != [REPOSITORY, A]:
        raise RuntimeError("NONPROD_CURRENT_A_BINDING_MISMATCH")
    return current


def main() -> None:
    if os.name != "nt" or not CLIENT.is_dir():
        raise RuntimeError("NAMED_WINDOWS_NONPROD_HOST_REQUIRED")
    ref = os.environ.get("MPS04_GITHUB_REF", "")
    expected_b = os.environ.get("MPS04_CI_HEAD_SHA", "")
    if (os.environ.get("GITHUB_REPOSITORY") != REPOSITORY
            or os.environ.get("GITHUB_EVENT_NAME") != "pull_request"
            or os.environ.get("MPS04_CI_ADOPTED_SHA") != A
            or not ref.startswith("codex/mps04-d007-")
            or len(expected_b) != 40 or not os.environ.get("MPS04_GITHUB_TOKEN")):
        raise RuntimeError("OWNER_PR_AND_EXACT_A_B_REQUIRED")
    sys.path.insert(0, str(CLIENT))
    from mps03_test_db_credential import read_password

    password = read_password()
    if not password:
        raise RuntimeError("NAMED_NONPROD_CREDENTIAL_MISSING")
    before = _current(password)
    gateway_secret = "mps03-native-gw-" + secrets.token_hex(20)
    agent_secret = "mps03-agent-gw-" + secrets.token_hex(20)
    gateway_port = _port()
    base = f"http://127.0.0.1:{gateway_port}"
    env = os.environ.copy()
    env["PATH"] = str(CLIENT / "mps03_psql_bin") + os.pathsep + env["PATH"]
    env["PYTHONPATH"] = os.pathsep.join((str(CLIENT / "mps03_psql_bin"),
                                        str(ROOT / "development" / "mps"), str(ROOT)))
    env["MPS03_DATABASE_URL"] = (f"postgresql://postgres.{PROJECT}:{quote(password, safe='')}"
                                 f"@{HOST}:5432/postgres?sslmode=verify-full")
    env["MPS03_TARGET_ID"] = f"clued-auth-test/{PROJECT}"
    env["MPS03_TEST_USER_ID"] = before[0]
    env["MPS03_ALLOW_NONPROD_WRITE"] = "MPS03_NONPROD_WRITE_APPROVED"
    env["MPS03_NATIVE_ENTRY_SECRET"] = gateway_secret
    env["MPS03_AGENT_ENTRY_SECRET"] = agent_secret
    env["MPS04_PROVIDER_MODE"] = "GITHUB_READ_ONLY"
    env.pop("MPS03_TEST_PSQL_ERROR_LOG", None)
    process = subprocess.Popen(
        [sys.executable, "-m", "mps03.mps02b_pg_gateway", "--port", str(gateway_port)],
        cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    try:
        for _ in range(40):
            if process.poll() is not None:
                raise RuntimeError("NONPROD_GATEWAY_START_FAILED")
            try:
                if _http(base + "/health").get("ok"):
                    break
            except (URLError, TimeoutError, ConnectionError):
                time.sleep(0.5)
        else:
            raise RuntimeError("NONPROD_GATEWAY_HEALTH_TIMEOUT")
        session = _http(base + "/v1/sessions", body={
            "entry_kind": "NATIVE", "entry_secret": gateway_secret,
        })
        token = session["session_token"]
        observation = _http(base + f"/v1/objects/{OBJECT}/provider-observation", token=token)
        after = _current(password)
        if (after != before or observation.get("ok") is not True
                or observation.get("clued_adopted_exact_commit") != A
                or observation.get("provider_exact_commit") != expected_b
                or observation.get("repository") != REPOSITORY
                or observation.get("ref") != ref
                or observation.get("ancestry") != "ahead"
                or observation.get("drift") is not True
                or observation.get("clued_revision_id") != before[1]
                or observation.get("clued_adoption_id") != before[2]
                or observation.get("clued_current_changed") is not False
                or observation.get("persistence") != "NOT_REGISTERED_CANDIDATE_ONLY"):
            raise RuntimeError("LIVE_D007_IDENTITY_OR_CURRENT_GUARD_FAILED")
        print("LIVE_NONPROD_NATIVE_D007_READ_PASS", "object=" + OBJECT,
              "A=" + A, "B=" + expected_b,
              "revision=" + before[1], "adoption=" + before[2],
              "observation_digest=" + observation["observation_digest"],
              "Current_unchanged=true", "candidate_only=true")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if process.stderr:
            process.stderr.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("LIVE_NONPROD_NATIVE_D007_READ_FAILED", type(error).__name__,
              # Errors from our guards only; never include the underlying stderr.
              str(error)[:120] if type(error) is RuntimeError else "redacted")
        raise SystemExit(1) from None
