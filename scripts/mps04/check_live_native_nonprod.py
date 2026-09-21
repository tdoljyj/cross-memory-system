"""Bounded same-host MPS-04/G6 probe; only clued-auth-test and PR #274.

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


def _expect_http_error(url: str, *, body: dict, token: str, status: int) -> None:
    try:
        _http(url, body=body, token=token)
    except RuntimeError as error:
        if str(error) == f"NONPROD_GATEWAY_HTTP_{status}":
            return
        raise
    raise RuntimeError("NONPROD_GATEWAY_EXPECTED_REJECTION_MISSING")


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


def _create_provider_object(base: str, token: str, suffix: str) -> dict:
    created = _http(base + "/v1/objects", token=token, body={
        "title": "MPS-04 G6 " + suffix,
        "body": {
            "details": "Bounded non-production G6 evidence object",
            "repository": REPOSITORY,
            "adopted_exact_commit": A,
        },
        "request_id": "req_mps04_g6_create_" + suffix,
    })
    if created.get("ok") is not True or not created.get("object_id"):
        raise RuntimeError("LIVE_G6_CREATE_FAILED")
    return created


def _assert_open_observation(observation: dict, object_id: str,
                             expected_b: str, ref: str) -> None:
    if (observation.get("ok") is not True
            or observation.get("object_id") != object_id
            or observation.get("clued_adopted_exact_commit") != A
            or observation.get("provider_exact_commit") != expected_b
            or observation.get("repository") != REPOSITORY
            or observation.get("ref") != ref
            or observation.get("ancestry") != "ahead"
            or observation.get("drift") is not True
            or observation.get("clued_current_changed") is not False
            or observation.get("persistence") != "REGISTERED_CANONICAL_OBSERVATION"
            or observation.get("status") != "OPEN"
            or observation.get("adoptable") is not True
            or not str(observation.get("observation_id", "")).startswith("pob_")
            or not isinstance(observation.get("confirmation_state_stamp"), dict)):
        raise RuntimeError("LIVE_G6_CANONICAL_OBSERVATION_FAILED")


def main() -> None:
    if os.name != "nt" or not CLIENT.is_dir():
        raise RuntimeError("NAMED_WINDOWS_NONPROD_HOST_REQUIRED")
    ref = os.environ.get("MPS04_GITHUB_REF", "")
    expected_b = os.environ.get("MPS04_CI_HEAD_SHA", "")
    run_key = (os.environ.get("GITHUB_RUN_ID", "") + "_"
               + os.environ.get("GITHUB_RUN_ATTEMPT", ""))
    if (os.environ.get("GITHUB_REPOSITORY") != REPOSITORY
            or os.environ.get("GITHUB_EVENT_NAME") != "pull_request"
            or os.environ.get("MPS04_CI_ADOPTED_SHA") != A
            or not ref.startswith("codex/mps04-d007-")
            or len(expected_b) != 40 or not os.environ.get("MPS04_GITHUB_TOKEN")
            or not run_key.replace("_", "").isdigit()):
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
                or observation.get("persistence") != "REGISTERED_CANONICAL_OBSERVATION"):
            raise RuntimeError("LIVE_D007_IDENTITY_OR_CURRENT_GUARD_FAILED")
        _assert_open_observation(observation, OBJECT, expected_b, ref)

        ignored_object = _create_provider_object(base, token, "ignore_" + run_key)
        ignored_id = ignored_object["object_id"]
        ignored_observation = _http(
            base + f"/v1/objects/{ignored_id}/provider-observation", token=token)
        _assert_open_observation(ignored_observation, ignored_id, expected_b, ref)

        adopted_object = _create_provider_object(base, token, "adopt_" + run_key)
        adopted_id = adopted_object["object_id"]
        adopted_observation = _http(
            base + f"/v1/objects/{adopted_id}/provider-observation", token=token)
        _assert_open_observation(adopted_observation, adopted_id, expected_b, ref)

        mismatch_ignore_request = "req_mps04_g6_mismatch_ignore_" + run_key
        _expect_http_error(
            base + f"/v1/objects/{adopted_id}/provider-observations/"
                   f"{ignored_observation['observation_id']}/ignore",
            token=token, body={"request_id": mismatch_ignore_request}, status=404)
        mismatch_adopt_request = "req_mps04_g6_mismatch_adopt_" + run_key
        _expect_http_error(
            base + f"/v1/objects/{ignored_id}/provider-observations/"
                   f"{adopted_observation['observation_id']}/adopt",
            token=token, body={
                "request_id": mismatch_adopt_request,
                "state_stamp": adopted_observation["confirmation_state_stamp"],
            }, status=404)
        mismatch_currents = (
            _http(base + f"/v1/objects/{ignored_id}", token=token),
            _http(base + f"/v1/objects/{adopted_id}", token=token),
        )
        mismatch_rows = _query(password,
            "select observation_id,status from clued_private.mps_provider_observations "
            "where observation_id in ("
            f"'{ignored_observation['observation_id']}',"
            f"'{adopted_observation['observation_id']}') order by observation_id;")
        if (any(current.get("body", {}).get("adopted_exact_commit") != A
                for current in mismatch_currents)
                or any(current.get("revision_id") != created.get("revision_id")
                       or current.get("adoption_id") != created.get("adoption_id")
                       for current, created in zip(
                           mismatch_currents, (ignored_object, adopted_object)))
                or len(mismatch_rows) != 2
                or any(not row.endswith("|OPEN") for row in mismatch_rows)):
            raise RuntimeError("LIVE_G6_OBJECT_OBSERVATION_MISMATCH_CHANGED_STATE")

        ignore_request = "req_mps04_g6_ignore_" + run_key
        ignored = _http(
            base + f"/v1/objects/{ignored_id}/provider-observations/"
                   f"{ignored_observation['observation_id']}/ignore",
            token=token, body={"request_id": ignore_request})
        ignored_retry = _http(
            base + f"/v1/objects/{ignored_id}/provider-observations/"
                   f"{ignored_observation['observation_id']}/ignore",
            token=token, body={"request_id": ignore_request})
        ignored_current = _http(base + f"/v1/objects/{ignored_id}", token=token)
        if (ignored.get("ok") is not True or ignored.get("status") != "IGNORED"
                or ignored.get("object_id") != ignored_id
                or ignored.get("clued_current_changed") is not False
                or ignored_retry != ignored
                or ignored_current.get("body", {}).get("adopted_exact_commit") != A
                or ignored_current.get("revision_id") != ignored_object.get("revision_id")
                or ignored_current.get("adoption_id") != ignored_object.get("adoption_id")):
            raise RuntimeError("LIVE_G6_IGNORE_OR_RETRY_FAILED")

        adopt_request = "req_mps04_g6_adopt_" + run_key
        adopt_body = {
            "request_id": adopt_request,
            "state_stamp": adopted_observation["confirmation_state_stamp"],
        }
        adopted = _http(
            base + f"/v1/objects/{adopted_id}/provider-observations/"
                   f"{adopted_observation['observation_id']}/adopt",
            token=token, body=adopt_body)
        adopted_retry = _http(
            base + f"/v1/objects/{adopted_id}/provider-observations/"
                   f"{adopted_observation['observation_id']}/adopt",
            token=token, body=adopt_body)
        adopted_current = _http(base + f"/v1/objects/{adopted_id}", token=token)
        if (adopted.get("ok") is not True or adopted.get("status") != "committed"
                or adopted.get("object_id") != adopted_id
                or not adopted.get("receipt_id")
                or adopted_retry != adopted
                or adopted_current.get("body", {}).get("adopted_exact_commit") != expected_b
                or adopted_current.get("revision_id") != adopted.get("result_revision_id")
                or adopted_current.get("adoption_id") != adopted.get("result_adoption_id")):
            raise RuntimeError("LIVE_G6_ADOPT_OR_IDEMPOTENT_RETRY_FAILED")

        decision_rows = _query(password,
            "select observation_id,status,coalesce(adoption_receipt_id,'') "
            "from clued_private.mps_provider_observations where observation_id in ("
            f"'{ignored_observation['observation_id']}',"
            f"'{adopted_observation['observation_id']}') order by status;")
        if (len(decision_rows) != 2
                or not any("|IGNORED|" in row for row in decision_rows)
                or not any(("|ADOPTED|" in row and row.rsplit("|", 1)[-1])
                           for row in decision_rows)):
            raise RuntimeError("LIVE_G6_CANONICAL_DECISION_RECORD_FAILED")

        print("LIVE_NONPROD_MPS04_G6_PASS", "source_object=" + OBJECT,
              "A=" + A, "B=" + expected_b,
              "revision=" + before[1], "adoption=" + before[2],
              "observation_digest=" + observation["observation_digest"],
              "source_Current_unchanged=true",
              "object_observation_mismatch_rejected=true",
              "ignore_observation=" + ignored_observation["observation_id"],
              "ignore_Current_unchanged=true",
              "adopt_observation=" + adopted_observation["observation_id"],
              "adopt_revision=" + adopted["result_revision_id"],
              "adopt_adoption=" + adopted["result_adoption_id"],
              "receipt=" + adopted["receipt_id"],
              "idempotent_retry=true")
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
        print("LIVE_NONPROD_MPS04_G6_FAILED", type(error).__name__,
              # Errors from our guards only; never include the underlying stderr.
              str(error)[:120] if type(error) is RuntimeError else "redacted")
        raise SystemExit(1) from None
