# -*- coding: utf-8 -*-
"""Real PostgreSQL 15+ integration qualification for Clued R5 Gate K2.

Requires CLD_K2_TEST_ADMIN_URL and optionally CLD_K2_PG_BIN.  The database is
ephemeral and contains synthetic markers only.
"""

import csv
import io
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


def insert_same_memory_other_account(dsn):
    sql(dsn, """
      BEGIN; SET LOCAL ROLE clued_service;
      CREATE TEMP TABLE allocated_b AS
        SELECT clued.allocate_committed_seq('%s') AS seq;
      INSERT INTO clued.memory_versions(
        account_id,memory_id,version_id,space_id,content,memory_type,scope,
        status,truth_state,sensitivity,source_type,confidence,
        created_by_binding_id,committed_seq)
      SELECT '%s','%s','50000000-0000-0000-0000-000000000002','%s',
        'other-account-synthetic','PROJECT','SPACE','ACTIVE','USER_EXPLICIT',
        'NORMAL','K2_TEST',1.0,'%s',seq FROM allocated_b;
      INSERT INTO clued.memory_current(
        account_id,memory_id,current_version_id,space_id,status,truth_state,
        sensitivity,scope,committed_seq)
      SELECT '%s','%s','50000000-0000-0000-0000-000000000002','%s',
        'ACTIVE','USER_EXPLICIT','NORMAL','SPACE',seq FROM allocated_b;
      INSERT INTO clued.change_events(
        account_id,event_id,committed_seq,event_type,memory_id,version_id,
        actor_binding_id)
      SELECT '%s','60000000-0000-0000-0000-000000000002',seq,'CREATED',
        '%s','50000000-0000-0000-0000-000000000002','%s' FROM allocated_b;
      COMMIT;
    """ % (B, B, SHARED_MEMORY, SPACE_B, BINDING_B, B, SHARED_MEMORY,
             SPACE_B, B, SHARED_MEMORY, BINDING_B))


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
    dsn = db_url(ADMIN_URL, test_db)
    restore_dsn = db_url(ADMIN_URL, restore_db)
    tmp = tempfile.mkdtemp(prefix="clued-k2-pg-")
    backup_path = os.path.join(tmp, "k2.backup")
    tests = []
    try:
        pg_cmd("dropdb", "--if-exists", "--maintenance-db", ADMIN_URL, test_db)
        pg_cmd("dropdb", "--if-exists", "--maintenance-db", ADMIN_URL, restore_db)
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
        }
        check(logging_settings == {
            "log_statement": "none",
            "log_min_error_statement": "panic",
            "log_parameter_max_length": "0",
            "log_parameter_max_length_on_error": "0",
        }, "unsafe PostgreSQL logging settings: %r" % logging_settings)
        tests.append("server_log_safety_configuration")

        seed_identity(dsn)
        run_concurrent_sequences(dsn)
        tests.append("committed_seq_concurrency")
        reserve_idempotency_concurrently(dsn)
        tests.append("idempotency_concurrency")
        insert_same_memory_other_account(dsn)

        visible_a = scalar(dsn, "SET ROLE clued_client; SET clued.account_id='%s'; "
                                  "SELECT count(*) FROM clued.accounts" % A)
        visible_b = scalar(dsn, "SET ROLE clued_client; SET clued.account_id='%s'; "
                                  "SELECT count(*) FROM clued.accounts WHERE account_id='%s'" % (A, B))
        check(visible_a == "1" and visible_b == "0", "RLS tenant isolation failed")
        membership = scalar(dsn, "SELECT pg_has_role('clued_client','clued_service','MEMBER')")
        check(membership == "f", "client inherited service role")
        tests.append("rls_and_role_isolation")

        probe = sql(dsn, "SET ROLE clued_client; SET clued.account_id='%s'; "
                         "INSERT INTO clued.accounts(account_id) VALUES('%s')" % (A, B),
                    check_result=False)
        check(probe.returncode != 0, "client unexpectedly obtained direct write")
        tests.append("service_role_absent_from_client")

        first_memory = str(uuid.uuid5(uuid.NAMESPACE_URL, "clued-k2-memory-0"))
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

        interrupted = sql(dsn, "BEGIN; CREATE TABLE clued.interrupted_probe(id int); "
                               "SELECT 1/0; COMMIT;", check_result=False)
        check(interrupted.returncode != 0, "interrupted migration probe did not fail")
        exists = scalar(dsn, "SELECT to_regclass('clued.interrupted_probe') IS NOT NULL")
        check(exists == "f", "failed transactional migration left residue")
        tests.append("migration_interruption_rollback")

        scan = tooling.scan_invariants(dsn, BIN_DIR)
        check(scan["ok"], "invariant scan failed: %r" % scan["violations"])
        check(scan["checked"] >= 18, "invariant scan coverage shrank")
        tests.append("invariant_scan")

        tooling.backup(dsn, backup_path, BIN_DIR)
        pg_cmd("createdb", "--maintenance-db", ADMIN_URL, restore_db)
        tooling.restore(restore_dsn, backup_path, BIN_DIR)
        restored_ledger = scalar(restore_dsn, "SELECT count(*) FROM clued.deletion_ledger")
        check(int(restored_ledger) >= 1, "deletion ledger missing after restore")
        restored_scan = tooling.scan_invariants(restore_dsn, BIN_DIR)
        check(restored_scan["ok"], "restored database invariant failure")
        tests.append("backup_restore_deletion_ledger")

        pg_cmd("dropdb", "--if-exists", "--maintenance-db", ADMIN_URL, restore_db)
        tooling.migrate(dsn, "down", BIN_DIR)
        check(scalar(dsn, "SELECT to_regnamespace('clued') IS NULL") == "t",
              "down migration left schema")
        tooling.migrate(dsn, "up", BIN_DIR)
        check(tooling.migration_status(dsn, BIN_DIR)["migration_applied"],
              "up/down/up roundtrip failed")
        tooling.migrate(dsn, "down", BIN_DIR)
        tests.append("migration_roundtrip")

        if SERVER_LOG:
            with open(SERVER_LOG, "r", encoding="utf-8", errors="replace") as fh:
                server_log = fh.read()
            forbidden = (
                "SYNTHETIC_BODY_MUST_NOT_APPEAR", "synthetic-memory-",
                "synthetic-deletion-marker", "other-account-synthetic")
            leaked = [marker for marker in forbidden if marker in server_log]
            check(not leaked, "server log contains body markers: %r" % leaked)
            tests.append("server_log_zero_body_leakage")

        for name in tests:
            print("PASS %s" % name)
        print("K2 POSTGRES INTEGRATION: %d/%d PASS" % (len(tests), len(tests)))
        return 0
    finally:
        pg_cmd("dropdb", "--if-exists", "--maintenance-db", ADMIN_URL,
               restore_db, check_result=False)
        pg_cmd("dropdb", "--if-exists", "--maintenance-db", ADMIN_URL,
               test_db, check_result=False)
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
