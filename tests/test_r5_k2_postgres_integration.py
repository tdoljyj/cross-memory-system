# -*- coding: utf-8 -*-
"""Real PostgreSQL 15+ integration qualification for Clued R5 Gate K2.

Requires CLD_K2_TEST_ADMIN_URL and optionally CLD_K2_PG_BIN.  The database is
ephemeral and contains synthetic markers only.
"""

import csv
import datetime
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from urllib.parse import urlsplit, urlunsplit


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from clued.cloud_data import tooling


ADMIN_URL = os.environ.get("CLD_K2_TEST_ADMIN_URL")
BIN_DIR = os.environ.get("CLD_K2_PG_BIN")
SERVER_LOG = os.environ.get("CLD_K2_SERVER_LOG")
EVIDENCE_DIR = os.environ.get("CLD_K2_EVIDENCE_DIR")
BACKUP_ARTIFACT = os.environ.get("CLD_K2_BACKUP_ARTIFACT")
TESTED_COMMIT = os.environ.get("CLD_K2_TESTED_COMMIT")
A = "00000000-0000-0000-0000-000000000001"
B = "00000000-0000-0000-0000-000000000002"
SPACE_A = "10000000-0000-0000-0000-000000000001"
SPACE_B = "10000000-0000-0000-0000-000000000002"
DEVICE_A = "20000000-0000-0000-0000-000000000001"
DEVICE_B = "20000000-0000-0000-0000-000000000002"
BINDING_A = "30000000-0000-0000-0000-000000000001"
BINDING_B = "30000000-0000-0000-0000-000000000002"
SHARED_MEMORY = "40000000-0000-0000-0000-000000000001"


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def db_url(base, database):
    parts = urlsplit(base)
    return urlunsplit((parts.scheme, parts.netloc, "/" + database,
                       parts.query, parts.fragment))


def pg_cmd(name, *args, check_result=True):
    exe = tooling._exe(name, BIN_DIR)
    proc = subprocess.run([exe] + list(args), stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, encoding="utf-8",
                          errors="replace", check=False)
    if check_result and proc.returncode:
        raise AssertionError("%s failed: %s" %
                             (name, tooling.redact(proc.stderr)[:1200]))
    return proc


def sql(dsn, statement, *, check_result=True, csv_output=False):
    args = ["--no-psqlrc", "--dbname", dsn, "--set", "ON_ERROR_STOP=1"]
    if csv_output:
        args.append("--csv")
    else:
        args.extend(["--tuples-only", "--no-align"])
    args.extend(["--command", statement])
    return pg_cmd("psql", *args, check_result=check_result)


def scalar(dsn, statement):
    out = sql(dsn, statement).stdout.strip().splitlines()
    return out[-1].strip() if out else ""


def violation_count(scan, name):
    for violation in scan["violations"]:
        if violation["name"] == name:
            return violation["count"]
    return 0


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pending = path + ".pending"
    with open(pending, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(value, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(pending, path)


def sanitize_server_log(value, test_db, restore_db, interrupt_db):
    value = tooling.redact(value)
    replacements = {
        os.path.expanduser("~"): "<user-home>",
        ROOT: "<repo>",
        test_db: "<test-db>",
        restore_db: "<restore-db>",
        interrupt_db: "<interrupt-db>",
    }
    for source, replacement in replacements.items():
        if source:
            value = value.replace(source, replacement)
            value = value.replace(source.replace("\\", "/"), replacement)
    return value


def write_run_evidence(tests, version, backup_result, backup_artifact,
                       server_log, test_db, restore_db, interrupt_db):
    check(EVIDENCE_DIR, "CLD_K2_EVIDENCE_DIR is required for evidence mode")
    check(re.fullmatch(r"[0-9a-f]{40}", TESTED_COMMIT or ""),
          "CLD_K2_TESTED_COMMIT must identify the committed product under test")
    check(BACKUP_ARTIFACT and os.path.isfile(BACKUP_ARTIFACT),
          "preserved backup artifact is required for evidence mode")
    check(SERVER_LOG and server_log is not None,
          "server log is required for evidence mode")

    os.makedirs(EVIDENCE_DIR, exist_ok=True)
    log_path = os.path.join(EVIDENCE_DIR, "03-k2-postgres-server.log")
    sanitized_log = sanitize_server_log(
        server_log, test_db, restore_db, interrupt_db)
    with open(log_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(sanitized_log)
        if sanitized_log and not sanitized_log.endswith("\n"):
            fh.write("\n")

    source_paths = (
        tooling.UP_SQL, tooling.DOWN_SQL, tooling.INVARIANT_SQL,
        tooling.__file__, os.path.abspath(__file__),
    )
    transcript = {
        "schema_version": 1,
        "gate": "K2",
        "run_kind": "remediation_qualification",
        "recorded_at": datetime.datetime.now(
            datetime.timezone.utc).replace(microsecond=0).isoformat(),
        "tested_product_commit": TESTED_COMMIT,
        "postgresql": {"server_version_num": version, "minimum": 150000},
        "data_class": "synthetic_local_dev_only",
        "result": {"status": "PASS", "pass": len(tests), "fail": 0,
                   "skip": 0, "tests": tests},
        "artifacts": {
            "backup": {
                "path_class": "temporary_untracked_artifact",
                "bytes": os.path.getsize(BACKUP_ARTIFACT),
                "sha256": tooling.file_sha256(BACKUP_ARTIFACT),
                "restore_input_sha256": backup_result["sha256"],
            },
            "sanitized_server_log": {
                "path": "03-k2-postgres-server.log",
                "bytes": os.path.getsize(log_path),
                "sha256": tooling.file_sha256(log_path),
                "body_marker_hits": 0,
            },
        },
        "source_sha256": {
            os.path.relpath(path, ROOT).replace("\\", "/"):
                tooling.file_sha256(path)
            for path in source_paths
        },
        "constraints": {
            "real_binding_changed": False,
            "semantic_recall_enabled": False,
            "production_touched": False,
        },
    }
    write_json(os.path.join(EVIDENCE_DIR,
                            "03-k2-postgres-transcript.json"), transcript)
    return transcript


def seed_identity(dsn):
    statement = """
      INSERT INTO clued.accounts(account_id) VALUES
        ('%s'), ('%s');
      INSERT INTO clued.memory_spaces(account_id, space_id) VALUES
        ('%s','%s'), ('%s','%s');
      INSERT INTO clued.devices(account_id, device_id, key_fingerprint) VALUES
        ('%s','%s','synthetic-device-a'),
        ('%s','%s','synthetic-device-b');
      INSERT INTO clued.bindings(account_id, binding_id, device_id, agent_type, scopes) VALUES
        ('%s','%s','%s','codex',ARRAY['memory:read','memory:write']),
        ('%s','%s','%s','workbuddy',ARRAY['memory:read']);
    """ % (A, B, A, SPACE_A, B, SPACE_B, A, DEVICE_A, B, DEVICE_B,
             A, BINDING_A, DEVICE_A, B, BINDING_B, DEVICE_B)
    sql(dsn, statement)


def concurrent_commit_statement(index):
    memory = str(uuid.uuid5(uuid.NAMESPACE_URL, "clued-k2-memory-%d" % index))
    version = str(uuid.uuid5(uuid.NAMESPACE_URL, "clued-k2-version-%d" % index))
    event = str(uuid.uuid5(uuid.NAMESPACE_URL, "clued-k2-event-%d" % index))
    job = str(uuid.uuid5(uuid.NAMESPACE_URL, "clued-k2-job-%d" % index))
    idem = str(uuid.uuid5(uuid.NAMESPACE_URL, "clued-k2-idem-%d" % index))
    op = str(uuid.uuid5(uuid.NAMESPACE_URL, "clued-k2-op-%d" % index))
    return """
      BEGIN;
      SET LOCAL ROLE clued_service;
      CREATE TEMP TABLE allocated AS
        SELECT clued.allocate_committed_seq('%s') AS seq;
      INSERT INTO clued.memory_versions(
        account_id,memory_id,version_id,space_id,content,summary,memory_type,
        scope,status,truth_state,sensitivity,source_type,confidence,
        created_by_binding_id,committed_seq)
      SELECT '%s','%s','%s','%s','synthetic-memory-%d','synthetic',
        'PROJECT','SPACE','ACTIVE','USER_EXPLICIT','NORMAL','K2_TEST',1.0,
        '%s',seq FROM allocated;
      INSERT INTO clued.memory_current(
        account_id,memory_id,current_version_id,space_id,status,truth_state,
        sensitivity,scope,committed_seq)
      SELECT '%s','%s','%s','%s','ACTIVE','USER_EXPLICIT','NORMAL','SPACE',seq
        FROM allocated;
      INSERT INTO clued.change_events(
        account_id,event_id,committed_seq,event_type,memory_id,version_id,
        actor_binding_id,metadata)
      SELECT '%s','%s',seq,'CREATED','%s','%s','%s','{"kind":"synthetic"}'
        FROM allocated;
      INSERT INTO clued.index_jobs(
        account_id,job_id,version_id,index_kind,state)
      VALUES('%s','%s','%s','FTS','PENDING');
      INSERT INTO clued.idempotency_records(
        account_id,idempotency_record_id,binding_id,idempotency_key,
        client_operation_id,request_hash,state,result_memory_id,
        result_version_id,committed_seq,response_code,completed_at)
      SELECT '%s','%s','%s','synthetic-key-%08d','%s',repeat('a',64),
        'COMMITTED','%s','%s',seq,'OK',clock_timestamp() FROM allocated;
      SELECT seq FROM allocated;
      COMMIT;
    """ % (A, A, memory, version, SPACE_A, index, BINDING_A,
             A, memory, version, SPACE_A, A, event, memory, version,
             BINDING_A, A, job, version, A, idem, BINDING_A, index, op,
             memory, version)


def run_concurrent_sequences(dsn, count=12):
    procs = []
    for i in range(count):
        args = [tooling._exe("psql", BIN_DIR), "--no-psqlrc", "--dbname", dsn,
                "--set", "ON_ERROR_STOP=1", "--tuples-only", "--no-align",
                "--command", concurrent_commit_statement(i)]
        procs.append(subprocess.Popen(args, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True,
                                      encoding="utf-8", errors="replace"))
    seqs = []
    for proc in procs:
        out, err = proc.communicate(timeout=60)
        check(proc.returncode == 0, tooling.redact(err)[:1200])
        values = [int(x) for x in re.findall(r"(?m)^\s*(\d+)\s*$", out)]
        check(values, "concurrent transaction did not return a sequence")
        seqs.append(values[-1])
    check(sorted(seqs) == list(range(1, count + 1)),
          "committed_seq is not gap-free and unique: %r" % sorted(seqs))


def reserve_idempotency_concurrently(dsn, count=8):
    key = "same-synthetic-idempotency-key"
    request_hash = "b" * 64
    procs = []
    for i in range(count):
        op = str(uuid.uuid5(uuid.NAMESPACE_URL, "clued-k2-shared-op-%d" % i))
        record = str(uuid.uuid5(uuid.NAMESPACE_URL, "clued-k2-shared-record-%d" % i))
        statement = (
            "SET ROLE clued_service; SELECT idempotency_record_id FROM "
            "clued.reserve_idempotency('%s','%s','%s','%s','%s','%s');" %
            (A, BINDING_A, key, op, request_hash, record))
        args = [tooling._exe("psql", BIN_DIR), "--no-psqlrc", "--dbname", dsn,
                "--set", "ON_ERROR_STOP=1", "--tuples-only", "--no-align",
                "--command", statement]
        procs.append(subprocess.Popen(args, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, text=True,
                                      encoding="utf-8", errors="replace"))
    records = []
    for proc in procs:
        out, err = proc.communicate(timeout=60)
        check(proc.returncode == 0, tooling.redact(err)[:1200])
        ids = re.findall(r"[0-9a-f]{8}-[0-9a-f-]{27}", out.lower())
        check(ids, "idempotency reservation returned no record")
        records.append(ids[-1])
    check(len(set(records)) == 1,
          "same idempotency key produced different semantic records")


def insert_shared_memory(dsn, account_id, space_id, binding_id,
                         version_id, event_id, content):
    sql(dsn, """
      BEGIN; SET LOCAL ROLE clued_service;
      CREATE TEMP TABLE allocated_shared AS
        SELECT clued.allocate_committed_seq('%s') AS seq;
      INSERT INTO clued.memory_versions(
        account_id,memory_id,version_id,space_id,content,memory_type,scope,
        status,truth_state,sensitivity,source_type,confidence,
        created_by_binding_id,committed_seq)
      SELECT '%s','%s','%s','%s',
        '%s','PROJECT','SPACE','ACTIVE','USER_EXPLICIT',
        'NORMAL','K2_TEST',1.0,'%s',seq FROM allocated_shared;
      INSERT INTO clued.memory_current(
        account_id,memory_id,current_version_id,space_id,status,truth_state,
        sensitivity,scope,committed_seq)
      SELECT '%s','%s','%s','%s',
        'ACTIVE','USER_EXPLICIT','NORMAL','SPACE',seq FROM allocated_shared;
      INSERT INTO clued.change_events(
        account_id,event_id,committed_seq,event_type,memory_id,version_id,
        actor_binding_id)
      SELECT '%s','%s',seq,'CREATED','%s','%s','%s'
        FROM allocated_shared;
      COMMIT;
    """ % (
        account_id, account_id, SHARED_MEMORY, version_id, space_id, content,
        binding_id, account_id, SHARED_MEMORY, version_id, space_id,
        account_id, event_id, SHARED_MEMORY, version_id, binding_id))


def insert_same_memory_both_accounts(dsn):
    version_a = "50000000-0000-0000-0000-000000000001"
    version_b = "50000000-0000-0000-0000-000000000002"
    insert_shared_memory(
        dsn, A, SPACE_A, BINDING_A, version_a,
        "60000000-0000-0000-0000-000000000001", "account-a-shared-memory")
    insert_shared_memory(
        dsn, B, SPACE_B, BINDING_B, version_b,
        "60000000-0000-0000-0000-000000000002", "account-b-shared-memory")
    return version_a, version_b


def run_actual_migration_interruption(dsn, tmp):
    with open(tooling.UP_SQL, "r", encoding="utf-8") as fh:
        migration = fh.read()
    check(migration.rstrip().endswith("COMMIT;"),
          "up migration no longer has a terminal COMMIT")
    interrupted_path = os.path.join(tmp, "0001.interrupted.sql")
    interrupted_sql = migration.rstrip()[:-len("COMMIT;")] + (
        "SELECT 1 / 0;\nCOMMIT;\n")
    with open(interrupted_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(interrupted_sql)
    result = pg_cmd(
        "psql", "--no-psqlrc", "--dbname", dsn,
        "--set", "ON_ERROR_STOP=1", "--file", interrupted_path,
        check_result=False)
    check(result.returncode != 0,
          "fault-injected real migration unexpectedly committed")
    check(scalar(dsn, "SELECT to_regnamespace('clued') IS NULL") == "t",
          "interrupted real migration left the clued schema")
    check(not tooling.migration_status(dsn, BIN_DIR)["migration_applied"],
          "interrupted real migration left a migration receipt")


def verify_same_memory_cross_account_rls(dsn, version_a, version_b):
    current_a = scalar(
        dsn, "SET ROLE clued_client; SET clued.account_id='%s'; "
             "SELECT current_version_id FROM clued.memory_current "
             "WHERE memory_id='%s'" % (A, SHARED_MEMORY))
    current_b = scalar(
        dsn, "SET ROLE clued_client; SET clued.account_id='%s'; "
             "SELECT current_version_id FROM clued.memory_current "
             "WHERE memory_id='%s'" % (B, SHARED_MEMORY))
    hidden_a = scalar(
        dsn, "SET ROLE clued_client; SET clued.account_id='%s'; "
             "SELECT count(*) FROM clued.memory_versions "
             "WHERE memory_id='%s' AND version_id='%s'" %
             (A, SHARED_MEMORY, version_b))
    hidden_b = scalar(
        dsn, "SET ROLE clued_client; SET clued.account_id='%s'; "
             "SELECT count(*) FROM clued.memory_versions "
             "WHERE memory_id='%s' AND version_id='%s'" %
             (B, SHARED_MEMORY, version_a))
    check(current_a == version_a and current_b == version_b,
          "same memory_id did not resolve to each tenant's own version")
    check(hidden_a == "0" and hidden_b == "0",
          "same memory_id exposed a cross-tenant version")


def verify_rls_omission_is_detected(dsn):
    sql(dsn, "ALTER TABLE clued.export_jobs DISABLE ROW LEVEL SECURITY")
    broken = tooling.scan_invariants(dsn, BIN_DIR)
    check(violation_count(broken, "rls_not_enabled_or_forced") >= 1,
          "invariant scanner missed an RLS-disabled tenant table")
    sql(dsn, "ALTER TABLE clued.export_jobs ENABLE ROW LEVEL SECURITY; "
             "ALTER TABLE clued.export_jobs FORCE ROW LEVEL SECURITY")
    repaired = tooling.scan_invariants(dsn, BIN_DIR)
    check(repaired["ok"], "RLS repair did not restore clean invariants")
    sql(dsn, "CREATE TABLE public.export_jobs(id integer)")
    collision_scan = tooling.scan_invariants(dsn, BIN_DIR)
    check(collision_scan["ok"],
          "same-name public table confused schema-local invariant checks")
    sql(dsn, "DROP TABLE public.export_jobs")


def verify_duplicate_fts_job_is_rejected(dsn, version_id):
    duplicate = sql(
        dsn, "SET ROLE clued_service; INSERT INTO clued.index_jobs("
             "account_id,job_id,version_id,index_kind,state) VALUES("
             "'%s','76000000-0000-0000-0000-000000000001','%s',"
             "'FTS','PENDING')" % (A, version_id),
        check_result=False)
    check(duplicate.returncode != 0,
          "nullable model identity allowed a duplicate FTS index job")


def verify_change_event_gap_is_detected_and_repaired(dsn, memory_id,
                                                     version_id):
    gap_seq = int(scalar(
        dsn, "SET ROLE clued_service; "
             "SELECT clued.allocate_committed_seq('%s')" % A))
    broken = tooling.scan_invariants(dsn, BIN_DIR)
    check(violation_count(broken, "change_event_sequence_gap") >= 1,
          "invariant scanner missed an injected change-event gap")
    sql(dsn, "SET ROLE clued_service; INSERT INTO clued.change_events("
             "account_id,event_id,committed_seq,event_type,memory_id,"
             "version_id,actor_binding_id,metadata) VALUES("
             "'%s','77000000-0000-0000-0000-000000000001',%d,"
             "'UPDATED','%s','%s','%s','{\"kind\":\"gap-repair\"}')" %
             (A, gap_seq, memory_id, version_id, BINDING_A))
    repaired = tooling.scan_invariants(dsn, BIN_DIR)
    check(repaired["ok"],
          "change-event gap repair did not restore clean invariants")


def verify_failed_transaction_preserves_invariants(dsn):
    failed = sql(
        dsn, "BEGIN; ALTER TABLE clued.export_jobs DISABLE ROW LEVEL SECURITY; "
             "SELECT clued.allocate_committed_seq('%s'); SELECT 1/0; COMMIT;" % A,
        check_result=False)
    check(failed.returncode != 0,
          "fault-injected data/DDL transaction unexpectedly committed")
    scan = tooling.scan_invariants(dsn, BIN_DIR)
    check(scan["ok"],
          "rollback left data or schema invariant violations: %r" %
          scan["violations"])


def verify_cli_failure_exit_codes(dsn, missing_backup, existing_backup):
    env = os.environ.copy()
    env.pop("CLD_K2_DATABASE_URL", None)
    env["PYTHONUTF8"] = "1"
    missing_dsn = subprocess.run(
        [sys.executable, "-m", "clued.cloud_data", "status"],
        cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", check=False)
    check(missing_dsn.returncode == 10,
          "module entrypoint swallowed missing-DSN exit code")
    check(json.loads(missing_dsn.stdout)["ok"] is False,
          "missing-DSN CLI response is not a failure object")

    missing_restore = subprocess.run(
        [sys.executable, "-m", "clued.cloud_data", "--dsn", dsn,
         "--bin-dir", BIN_DIR, "restore", missing_backup,
         "--expected-sha256", "0" * 64],
        cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", check=False)
    check(missing_restore.returncode == 1,
          "module entrypoint swallowed restore failure exit code")
    check(json.loads(missing_restore.stdout)["ok"] is False,
          "restore CLI response is not a failure object")

    omitted_digest = subprocess.run(
        [sys.executable, "-m", "clued.cloud_data", "--dsn", dsn,
         "--bin-dir", BIN_DIR, "restore", existing_backup],
        cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", check=False)
    check(omitted_digest.returncode == 2,
          "restore CLI accepted an unverified backup")


def add_tombstone(dsn, memory_id):
    version = "70000000-0000-0000-0000-000000000001"
    sql(dsn, """
      BEGIN; SET LOCAL ROLE clued_service;
      CREATE TEMP TABLE deleted_seq AS
        SELECT clued.allocate_committed_seq('%s') AS seq;
      INSERT INTO clued.memory_versions(
        account_id,memory_id,version_id,space_id,content,summary,memory_type,
        scope,status,truth_state,sensitivity,source_type,confidence,
        supersedes_version_id,created_by_binding_id,committed_seq)
      SELECT '%s','%s','%s','%s','synthetic-deletion-marker','synthetic',
        'PROJECT','SPACE','DELETED','USER_EXPLICIT','NORMAL','K2_TEST',1.0,
        c.current_version_id,'%s',seq
      FROM deleted_seq CROSS JOIN clued.memory_current c
      WHERE c.account_id='%s' AND c.memory_id='%s';
      INSERT INTO clued.change_events(
        account_id,event_id,committed_seq,event_type,memory_id,version_id,
        actor_binding_id)
      SELECT '%s','71000000-0000-0000-0000-000000000001',seq,'DELETED',
        '%s','%s','%s' FROM deleted_seq;
      INSERT INTO clued.index_jobs(account_id,job_id,version_id,index_kind,state)
      VALUES('%s','72000000-0000-0000-0000-000000000001','%s','FTS','PENDING');
      INSERT INTO clued.tombstones(
        account_id,memory_id,tombstone_version_id,committed_seq,reason_code)
      SELECT '%s','%s','%s',seq,'USER_DELETE' FROM deleted_seq;
      INSERT INTO clued.deletion_ledger(
        account_id,ledger_id,subject_type,subject_id,committed_seq,state,proof_hash)
      SELECT '%s','73000000-0000-0000-0000-000000000001','MEMORY','%s',seq,
        'RECORDED',repeat('c',64) FROM deleted_seq;
      INSERT INTO clued.idempotency_records(
        account_id,idempotency_record_id,binding_id,idempotency_key,
        client_operation_id,request_hash,state,result_memory_id,
        result_version_id,committed_seq,response_code,completed_at)
      SELECT '%s','74000000-0000-0000-0000-000000000001','%s',
        'synthetic-delete-key','75000000-0000-0000-0000-000000000001',
        repeat('d',64),'COMMITTED','%s','%s',seq,'OK',clock_timestamp()
      FROM deleted_seq;
      SELECT clued.rebuild_memory_current('%s');
      COMMIT;
    """ % (A, A, memory_id, version, SPACE_A, BINDING_A, A, memory_id,
             A, memory_id, version, BINDING_A, A, version, A, memory_id,
             version, A, memory_id, A, BINDING_A, memory_id, version, A))
    return version


def main():
    if not ADMIN_URL:
        print("SKIP K2 POSTGRES INTEGRATION: CLD_K2_TEST_ADMIN_URL is not set")
        return 0

    test_db = "clued_k2_%s" % uuid.uuid4().hex[:12]
    restore_db = test_db + "_restore"
    interrupt_db = test_db + "_interrupt"
    dsn = db_url(ADMIN_URL, test_db)
    restore_dsn = db_url(ADMIN_URL, restore_db)
    interrupt_dsn = db_url(ADMIN_URL, interrupt_db)
    tmp = tempfile.mkdtemp(prefix="clued-k2-pg-")
    backup_path = os.path.join(tmp, "k2.backup")
    missing_backup = os.path.join(tmp, "missing.backup")
    tests = []
    initial_roles = tooling._managed_role_state(ADMIN_URL, BIN_DIR)
    try:
        pg_cmd("dropdb", "--if-exists", "--maintenance-db", ADMIN_URL, test_db)
        pg_cmd("dropdb", "--if-exists", "--maintenance-db", ADMIN_URL, restore_db)
        pg_cmd("dropdb", "--if-exists", "--maintenance-db", ADMIN_URL,
               interrupt_db)

        pg_cmd("createdb", "--maintenance-db", ADMIN_URL, interrupt_db)
        run_actual_migration_interruption(interrupt_dsn, tmp)
        tests.append("actual_migration_interruption_rollback")
        pg_cmd("dropdb", "--if-exists", "--maintenance-db", ADMIN_URL,
               interrupt_db)

        pg_cmd("createdb", "--maintenance-db", ADMIN_URL, test_db)

        tooling.migrate(dsn, "up", BIN_DIR)
        tests.append("migration_up")
        version = int(scalar(dsn, "SHOW server_version_num"))
        check(version >= 150000, "PostgreSQL 15+ required")
        logging_settings = {
            "log_statement": scalar(dsn, "SHOW log_statement"),
            "log_min_error_statement": scalar(dsn, "SHOW log_min_error_statement"),
            "log_parameter_max_length": scalar(dsn, "SHOW log_parameter_max_length"),
            "log_parameter_max_length_on_error": scalar(
                dsn, "SHOW log_parameter_max_length_on_error"),
            "log_error_verbosity": scalar(dsn, "SHOW log_error_verbosity"),
        }
        check(logging_settings == {
            "log_statement": "none",
            "log_min_error_statement": "panic",
            "log_parameter_max_length": "0",
            "log_parameter_max_length_on_error": "0",
            "log_error_verbosity": "terse",
        }, "unsafe PostgreSQL logging settings: %r" % logging_settings)
        tests.append("server_log_safety_configuration")

        seed_identity(dsn)
        run_concurrent_sequences(dsn)
        tests.append("committed_seq_concurrency")
        reserve_idempotency_concurrently(dsn)
        tests.append("idempotency_concurrency")
        shared_version_a, shared_version_b = insert_same_memory_both_accounts(dsn)
        verify_same_memory_cross_account_rls(
            dsn, shared_version_a, shared_version_b)
        tests.append("cross_account_same_memory_id_rls")

        visible_a = scalar(dsn, "SET ROLE clued_client; SET clued.account_id='%s'; "
                                  "SELECT count(*) FROM clued.accounts" % A)
        visible_b = scalar(dsn, "SET ROLE clued_client; SET clued.account_id='%s'; "
                                  "SELECT count(*) FROM clued.accounts WHERE account_id='%s'" % (A, B))
        check(visible_a == "1" and visible_b == "0", "RLS tenant isolation failed")
        membership = scalar(dsn, "SELECT pg_has_role('clued_client','clued_service','MEMBER')")
        check(membership == "f", "client inherited service role")
        tests.append("rls_and_role_isolation")

        verify_rls_omission_is_detected(dsn)
        tests.append("rls_omission_fault_injection")

        probe = sql(dsn, "SET ROLE clued_client; SET clued.account_id='%s'; "
                         "INSERT INTO clued.accounts(account_id) VALUES('%s')" % (A, B),
                    check_result=False)
        check(probe.returncode != 0, "client unexpectedly obtained direct write")
        tests.append("service_role_absent_from_client")

        first_memory = str(uuid.uuid5(uuid.NAMESPACE_URL, "clued-k2-memory-0"))
        first_version = str(uuid.uuid5(uuid.NAMESPACE_URL, "clued-k2-version-0"))
        verify_duplicate_fts_job_is_rejected(dsn, first_version)
        tests.append("duplicate_fts_job_null_identity")

        tombstone_version = add_tombstone(dsn, first_memory)
        status = scalar(dsn, "SELECT status FROM clued.memory_current WHERE "
                             "account_id='%s' AND memory_id='%s'" % (A, first_memory))
        check(status == "DELETED", "tombstone did not dominate projection")
        tests.append("tombstone_authority")

        leak_marker = "SYNTHETIC_BODY_MUST_NOT_APPEAR"
        immutable = sql(dsn, "SET ROLE clued_service; UPDATE clued.memory_versions "
                         "SET content='%s' WHERE account_id='%s' AND memory_id='%s'" %
                         (leak_marker, A, first_memory), check_result=False)
        check(immutable.returncode != 0, "immutable history accepted update")
        check(leak_marker not in immutable.stderr,
              "database error leaked synthetic content")
        tests.append("immutable_history_and_error_redaction")

        old_version = scalar(dsn, "SELECT version_id FROM clued.memory_versions "
                             "WHERE account_id='%s' AND memory_id='%s' AND status='ACTIVE' "
                             "ORDER BY committed_seq LIMIT 1" % (A, first_memory))
        sql(dsn, "SET ROLE clued_service; UPDATE clued.memory_current SET "
                 "current_version_id='%s', status='ACTIVE', committed_seq=1 "
                 "WHERE account_id='%s' AND memory_id='%s'" %
                 (old_version, A, first_memory))
        tooling.rebuild_projection(dsn, A, BIN_DIR)
        rebuilt = scalar(dsn, "SELECT current_version_id FROM clued.memory_current "
                               "WHERE account_id='%s' AND memory_id='%s'" %
                               (A, first_memory))
        check(rebuilt == tombstone_version, "projection rebuild chose stale version")
        tests.append("projection_rebuild")

        verify_change_event_gap_is_detected_and_repaired(
            dsn, first_memory, tombstone_version)
        tests.append("change_event_gap_fault_injection")

        verify_failed_transaction_preserves_invariants(dsn)
        tests.append("rollback_preserves_data_invariants")

        scan = tooling.scan_invariants(dsn, BIN_DIR)
        check(scan["ok"], "invariant scan failed: %r" % scan["violations"])
        check(scan["checked"] >= 18, "invariant scan coverage shrank")
        tests.append("invariant_scan")

        backup_result = tooling.backup(dsn, backup_path, BIN_DIR)
        if BACKUP_ARTIFACT:
            os.makedirs(os.path.dirname(os.path.abspath(BACKUP_ARTIFACT)),
                        exist_ok=True)
            shutil.copy2(backup_path, BACKUP_ARTIFACT)
            check(tooling.file_sha256(BACKUP_ARTIFACT) == backup_result["sha256"],
                  "preserved backup artifact digest changed during copy")
        tooling.migrate(dsn, "down", BIN_DIR)
        check(scalar(dsn, "SELECT to_regnamespace('clued') IS NULL") == "t",
              "pre-restore down migration left schema")
        remaining_roles = int(scalar(
            dsn, "SELECT count(*) FROM pg_roles WHERE rolname IN "
                 "('clued_owner','clued_client','clued_service')"))
        check(remaining_roles == len(initial_roles),
              "down migration left roles created by the source migration")

        pg_cmd("createdb", "--maintenance-db", ADMIN_URL, restore_db)
        verify_cli_failure_exit_codes(restore_dsn, missing_backup, backup_path)
        tests.append("cli_failure_exit_codes")
        try:
            tooling.restore(restore_dsn, backup_path, BIN_DIR)
            raise AssertionError("restore accepted an omitted expected digest")
        except tooling.ToolError as exc:
            check("SHA-256 is required" in str(exc),
                  "restore returned the wrong missing-digest error")
        roles_after_omission = int(scalar(
            restore_dsn, "SELECT count(*) FROM pg_roles WHERE rolname IN "
                         "('clued_owner','clued_client','clued_service')"))
        check(roles_after_omission == len(initial_roles),
              "missing digest changed cluster roles before restore")
        try:
            tooling.restore(restore_dsn, backup_path, BIN_DIR,
                            expected_sha256="0" * 64)
            raise AssertionError("restore accepted an incorrect expected digest")
        except tooling.ToolError as exc:
            check("SHA-256 mismatch" in str(exc),
                  "restore returned the wrong digest mismatch error")
        roles_after_mismatch = int(scalar(
            restore_dsn, "SELECT count(*) FROM pg_roles WHERE rolname IN "
                         "('clued_owner','clued_client','clued_service')"))
        check(roles_after_mismatch == len(initial_roles),
              "digest mismatch changed cluster roles before restore")

        restore_result = tooling.restore(
            restore_dsn, backup_path, BIN_DIR,
            expected_sha256=backup_result["sha256"])
        check(restore_result["input_sha256"] == backup_result["sha256"],
              "restore did not consume the hashed backup artifact")
        check(restore_result["expected_sha256_verified"],
              "restore did not enforce the expected backup digest")
        expected_created = sorted(
            name for name in tooling.MANAGED_ROLES if name not in initial_roles)
        check(sorted(restore_result["roles_bootstrapped"]) == expected_created,
              "restore did not bootstrap the missing restricted roles")
        restored_ledger = scalar(restore_dsn, "SELECT count(*) FROM clued.deletion_ledger")
        check(int(restored_ledger) >= 1, "deletion ledger missing after restore")
        restored_scan = tooling.scan_invariants(restore_dsn, BIN_DIR)
        check(restored_scan["ok"], "restored database invariant failure")
        restored_visible = int(scalar(
            restore_dsn, "SET ROLE clued_client; SET clued.account_id='%s'; "
                         "SELECT count(*) FROM clued.memory_current" % A))
        restored_hidden = scalar(
            restore_dsn, "SET ROLE clued_client; SET clued.account_id='%s'; "
                         "SELECT count(*) FROM clued.memory_current "
                         "WHERE account_id='%s'" % (A, B))
        check(restored_visible >= 1 and restored_hidden == "0",
              "restore lost client ACLs or tenant RLS isolation")
        tests.append("no_role_backup_restore_ledger_acl_and_rls")

        tooling.migrate(restore_dsn, "down", BIN_DIR)
        pg_cmd("dropdb", "--if-exists", "--maintenance-db", ADMIN_URL, restore_db)
        tooling.migrate(dsn, "up", BIN_DIR)
        check(tooling.migration_status(dsn, BIN_DIR)["migration_applied"],
              "up/down/up roundtrip failed")
        post_roundtrip_scan = tooling.scan_invariants(dsn, BIN_DIR)
        check(post_roundtrip_scan["ok"] and post_roundtrip_scan["checked"] >= 18,
              "post-rollback/up migration invariants failed: %r" %
              post_roundtrip_scan["violations"])
        tests.append("post_rollback_invariant_scan")
        tooling.migrate(dsn, "down", BIN_DIR)
        tests.append("migration_roundtrip")

        server_log = None
        if SERVER_LOG:
            with open(SERVER_LOG, "r", encoding="utf-8", errors="replace") as fh:
                server_log = fh.read()
            forbidden = (
                "SYNTHETIC_BODY_MUST_NOT_APPEAR", "synthetic-memory-",
                "synthetic-deletion-marker", "account-a-shared-memory",
                "account-b-shared-memory")
            leaked = [marker for marker in forbidden if marker in server_log]
            check(not leaked, "server log contains body markers: %r" % leaked)
            tests.append("server_log_zero_body_leakage")

        if EVIDENCE_DIR:
            write_run_evidence(
                tests, version, backup_result, BACKUP_ARTIFACT, server_log,
                test_db, restore_db, interrupt_db)

        for name in tests:
            print("PASS %s" % name)
        print("K2 POSTGRES INTEGRATION: %d/%d PASS" % (len(tests), len(tests)))
        return 0
    finally:
        pg_cmd("dropdb", "--if-exists", "--maintenance-db", ADMIN_URL,
               restore_db, check_result=False)
        pg_cmd("dropdb", "--if-exists", "--maintenance-db", ADMIN_URL,
               test_db, check_result=False)
        pg_cmd("dropdb", "--if-exists", "--maintenance-db", ADMIN_URL,
               interrupt_db, check_result=False)
        created_during_test = [name for name in tooling.MANAGED_ROLES
                               if name not in initial_roles]
        try:
            tooling._cleanup_bootstrapped_roles(
                ADMIN_URL, created_during_test, BIN_DIR)
        except tooling.ToolError:
            pass
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
