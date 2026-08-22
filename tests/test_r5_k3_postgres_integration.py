# -*- coding: utf-8 -*-
"""Real PostgreSQL 15+ qualification for Clued R5 Gate K3.

Requires ``CLD_K3_TEST_ADMIN_URL`` and optionally ``CLD_K3_PG_BIN``.  The
suite creates and removes one synthetic database and never prints its DSN or
memory content.
"""

import os
import re
import subprocess
import sys
import uuid
from urllib.parse import urlsplit, urlunsplit


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from clued.cloud_data import tooling


ADMIN_URL = os.environ.get("CLD_K3_TEST_ADMIN_URL")
BIN_DIR = os.environ.get("CLD_K3_PG_BIN")

A = "00000000-0000-0000-0000-000000000001"
B = "00000000-0000-0000-0000-000000000002"
SPACE_A = "10000000-0000-0000-0000-000000000001"
SPACE_B = "10000000-0000-0000-0000-000000000002"
DEVICE_A = "20000000-0000-0000-0000-000000000001"
DEVICE_B = "20000000-0000-0000-0000-000000000002"
WRITE_A = "30000000-0000-0000-0000-000000000001"
READ_A = "30000000-0000-0000-0000-000000000002"
WRITE_B = "30000000-0000-0000-0000-000000000003"


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def db_url(base, database):
    parts = urlsplit(base)
    return urlunsplit((parts.scheme, parts.netloc, "/" + database,
                       parts.query, parts.fragment))


def pg_cmd(name, *args, check_result=True):
    proc = subprocess.run(
        [tooling._exe(name, BIN_DIR)] + list(args),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", check=False)
    if check_result and proc.returncode:
        raise AssertionError("%s failed: %s" %
                             (name, tooling.redact(proc.stderr)[:1000]))
    return proc


def sql(dsn, statement, check_result=True):
    return pg_cmd("psql", "--no-psqlrc", "--dbname", dsn,
                  "--set", "ON_ERROR_STOP=1", "--set", "VERBOSITY=verbose",
                  "--tuples-only", "--no-align",
                  "--field-separator", "|", "--command", statement,
                  check_result=check_result)


def scalar(dsn, statement):
    lines = [line.strip() for line in sql(dsn, statement).stdout.splitlines()
             if line.strip() and line.strip() not in ("SET", "RESET")]
    return lines[-1] if lines else ""


def q(value, cast="text"):
    if value is None:
        return "NULL::%s" % cast
    return "'%s'::%s" % (str(value).replace("'", "''"), cast)


def mutation_sql(*, account=A, binding=WRITE_A, operation, key, op_id,
                 memory_id, base_version=None, new_version, event_id,
                 conflict_id, content=None, space_id=None, memory_type=None,
                 scope=None, truth_state=None, request_hash=None,
                 reason_code=None):
    values = (
        q(account, "uuid"), q(binding, "uuid"), q(operation), q(key),
        q(op_id, "uuid"), q(request_hash or ("a" * 64)),
        q(memory_id, "uuid"), q(base_version, "uuid"),
        q(new_version, "uuid"), q(event_id, "uuid"),
        q(conflict_id, "uuid"), q(space_id, "uuid"), q(content),
        q(memory_type), q(scope), q("{}", "jsonb"), q(truth_state),
        q("NORMAL"), q("K3_TEST"), q(None),
        q("1.0" if operation == "CREATE" else None, "numeric"),
        q(None, "timestamptz"), q(None, "timestamptz"), q(reason_code),
    )
    return ("SET ROLE clued_service; SELECT * FROM "
            "clued.apply_memory_mutation(%s);" % ",".join(values))


def call_mutation(dsn, **kwargs):
    result = scalar(dsn, mutation_sql(**kwargs)).split("|")
    check(len(result) == 6, "mutation result shape invalid: %r" % result)
    return {
        "code": result[0], "memory_id": result[1], "version_id": result[2],
        "seq": int(result[3]), "conflict_id": result[4] or None,
        "replayed": result[5] == "t",
    }


def resolve_sql(*, key, op_id, memory_id, conflict_id, winner_version,
                resolution_version, event_id, request_hash=None):
    values = (
        q(A, "uuid"), q(WRITE_A, "uuid"), q(key), q(op_id, "uuid"),
        q(request_hash or ("b" * 64)), q(memory_id, "uuid"),
        q(conflict_id, "uuid"), q(winner_version, "uuid"),
        q(resolution_version, "uuid"), q(event_id, "uuid"),
    )
    return ("SET ROLE clued_service; SELECT * FROM "
            "clued.resolve_memory_conflict(%s);" % ",".join(values))


def seed(dsn):
    sql(dsn, """
      INSERT INTO clued.accounts(account_id) VALUES
        ('%s'), ('%s');
      INSERT INTO clued.memory_spaces(account_id, space_id) VALUES
        ('%s','%s'), ('%s','%s');
      INSERT INTO clued.devices(account_id, device_id, key_fingerprint) VALUES
        ('%s','%s','synthetic-device-a'),
        ('%s','%s','synthetic-device-b');
      INSERT INTO clued.bindings(
        account_id,binding_id,device_id,agent_type,scopes) VALUES
        ('%s','%s','%s','codex',ARRAY['memory:read','memory:write']),
        ('%s','%s','%s','readonly',ARRAY['memory:read']),
        ('%s','%s','%s','other-account',ARRAY['memory:read','memory:write']);
    """ % (A, B, A, SPACE_A, B, SPACE_B, A, DEVICE_A, B, DEVICE_B,
             A, WRITE_A, DEVICE_A, A, READ_A, DEVICE_A,
             B, WRITE_B, DEVICE_B))


def uid(label):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "clued-k3-" + label))


def run():
    check(ADMIN_URL, "CLD_K3_TEST_ADMIN_URL is required")
    database = "clued_k3_%s_%s" % (os.getpid(), uuid.uuid4().hex[:8])
    dsn = db_url(ADMIN_URL, database)
    tests = []

    def passed(name):
        tests.append(name)
        print("PASS %s" % name)

    pg_cmd("createdb", "--maintenance-db", ADMIN_URL, database)
    migrated_k2 = False
    migrated_k3 = False
    try:
        tooling.migrate(dsn, "up", BIN_DIR)
        migrated_k2 = True
        tooling.migrate_lifecycle(dsn, "up", BIN_DIR)
        migrated_k3 = True
        seed(dsn)

        version = int(scalar(dsn, "SHOW server_version_num"))
        check(version >= 150000, "PostgreSQL 15+ required")
        check(scalar(dsn, "SELECT count(*) FROM clued.schema_migrations") == "2",
              "migration ledger mismatch")
        passed("migration_chain")

        execute_acl = scalar(dsn, """
          SELECT has_function_privilege('clued_service',
            'clued.apply_memory_mutation(uuid,uuid,text,text,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,text,numeric,timestamptz,timestamptz,text)', 'EXECUTE')
            AND NOT has_function_privilege('clued_client',
            'clued.apply_memory_mutation(uuid,uuid,text,text,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,text,numeric,timestamptz,timestamptz,text)', 'EXECUTE')
            AND NOT has_function_privilege('public',
            'clued.apply_memory_mutation(uuid,uuid,text,text,uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,jsonb,text,text,text,text,numeric,timestamptz,timestamptz,text)', 'EXECUTE');
        """)
        check(execute_acl == "t", "function ACL boundary failed")
        passed("function_acl_boundary")

        denied = sql(dsn, "SET ROLE clued_service; INSERT INTO clued.audit_events(account_id,audit_event_id,event_type,actor_type) VALUES('%s','%s','BYPASS','SERVICE');" % (A, uid("bypass")), check_result=False)
        check(denied.returncode != 0 and
              ("42501" in denied.stderr or
               "permission denied" in denied.stderr.lower()),
              "service direct DML bypass was not denied")
        passed("direct_dml_denied")

        m1, v1 = uid("m1"), uid("m1-v1")
        create_args = dict(
            operation="CREATE", key="create-m1-key", op_id=uid("m1-op1"),
            memory_id=m1, base_version=None, new_version=v1,
            event_id=uid("m1-e1"), conflict_id=uid("m1-g1"),
            content="synthetic-create", space_id=SPACE_A,
            memory_type="PROJECT", scope="SPACE", truth_state="USER_EXPLICIT")
        created = call_mutation(dsn, **create_args)
        check(created["code"] == "CREATED" and created["seq"] == 1,
              "create result invalid")
        check(scalar(dsn, "SELECT status||'|'||current_version_id FROM clued.memory_current WHERE account_id='%s' AND memory_id='%s'" % (A, m1)) == "ACTIVE|" + v1,
              "create projection invalid")
        passed("create_atomic_projection")

        replay = call_mutation(dsn, **create_args)
        check(replay["replayed"] and replay["seq"] == 1 and replay["version_id"] == v1,
              "exact replay was not idempotent")
        check(scalar(dsn, "SELECT committed_seq FROM clued.accounts WHERE account_id='%s'" % A) == "1",
              "replay consumed a sequence")
        passed("exact_replay_zero_side_effect")

        mismatched = dict(create_args)
        mismatched["request_hash"] = "c" * 64
        proc = sql(dsn, mutation_sql(**mismatched), check_result=False)
        check(proc.returncode != 0 and "CLD-K3-IDEMPOTENCY-CONFLICT" in proc.stderr,
              "same key with changed request was not rejected")
        check(scalar(dsn, "SELECT committed_seq FROM clued.accounts WHERE account_id='%s'" % A) == "1",
              "idempotency rejection changed sequence")
        passed("idempotency_payload_conflict")

        v2 = uid("m1-v2")
        updated = call_mutation(
            dsn, operation="UPDATE", key="update-m1-key", op_id=uid("m1-op2"),
            memory_id=m1, base_version=v1, new_version=v2,
            event_id=uid("m1-e2"), conflict_id=uid("m1-g2"),
            content="synthetic-update")
        check(updated["code"] == "UPDATED" and updated["seq"] == 2,
              "optimistic update failed")
        passed("optimistic_update")

        v3, g3 = uid("m1-v3"), uid("m1-g3")
        conflicted = call_mutation(
            dsn, operation="UPDATE", key="stale-m1-key", op_id=uid("m1-op3"),
            memory_id=m1, base_version=v1, new_version=v3,
            event_id=uid("m1-e3"), conflict_id=g3,
            content="synthetic-stale")
        check(conflicted["code"] == "CONFLICT_REVIEW" and
              conflicted["conflict_id"] == g3 and conflicted["seq"] == 3,
              "stale update did not enter conflict review")
        check(scalar(dsn, "SELECT status FROM clued.memory_current WHERE account_id='%s' AND memory_id='%s'" % (A, m1)) == "CONFLICT",
              "conflict projection missing")
        passed("stale_write_conflict")

        blocked = sql(dsn, mutation_sql(
            operation="UPDATE", key="blocked-m1", op_id=uid("m1-op4"),
            memory_id=m1, base_version=v3, new_version=uid("m1-v4-blocked"),
            event_id=uid("m1-e4-blocked"), conflict_id=uid("m1-g4"),
            content="synthetic-blocked"), check_result=False)
        check(blocked.returncode != 0 and "CLD-K3-CONFLICT-OPEN" in blocked.stderr,
              "open conflict did not block mutation")
        check(scalar(dsn, "SELECT committed_seq FROM clued.accounts WHERE account_id='%s'" % A) == "3",
              "blocked conflict write consumed sequence")
        passed("open_conflict_blocks_writes")

        resolution = uid("m1-v4")
        resolved = scalar(dsn, resolve_sql(
            key="resolve-m1", op_id=uid("m1-op5"), memory_id=m1,
            conflict_id=g3, winner_version=v2, resolution_version=resolution,
            event_id=uid("m1-e5"))).split("|")
        check(resolved[0] == "RESOLVED" and int(resolved[3]) == 4,
              "explicit conflict resolution failed")
        check(scalar(dsn, "SELECT status||'|'||winner_version_id FROM clued.conflict_groups WHERE account_id='%s' AND conflict_group_id='%s'" % (A, g3)) == "RESOLVED|" + v2,
              "conflict group resolution invalid")
        passed("explicit_conflict_resolution")

        m2, v5 = uid("m2"), uid("m2-v1")
        call_mutation(
            dsn, operation="CREATE", key="create-m2-key", op_id=uid("m2-op1"),
            memory_id=m2, base_version=None, new_version=v5,
            event_id=uid("m2-e1"), conflict_id=uid("m2-g1"),
            content="synthetic-m2", space_id=SPACE_A, memory_type="PROJECT",
            scope="SPACE", truth_state="OBSERVED")
        v6 = uid("m2-v2")
        call_mutation(
            dsn, operation="UPDATE", key="update-m2-key", op_id=uid("m2-op2"),
            memory_id=m2, base_version=v5, new_version=v6,
            event_id=uid("m2-e2"), conflict_id=uid("m2-g2"),
            content="synthetic-m2-update")
        v7, g7 = uid("m2-v3"), uid("m2-g3")
        stale_delete = call_mutation(
            dsn, operation="DELETE", key="delete-stale-m2", op_id=uid("m2-op3"),
            memory_id=m2, base_version=v5, new_version=v7,
            event_id=uid("m2-e3"), conflict_id=g7, reason_code="USER_REQUEST")
        check(stale_delete["code"] == "CONFLICT_REVIEW" and
              scalar(dsn, "SELECT count(*) FROM clued.tombstones WHERE account_id='%s' AND memory_id='%s'" % (A, m2)) == "0",
              "stale delete overwrote a newer update")
        passed("update_then_stale_delete_conflicts")

        v8 = uid("m2-v4")
        scalar(dsn, resolve_sql(
            key="resolve-m2", op_id=uid("m2-op4"), memory_id=m2,
            conflict_id=g7, winner_version=v6, resolution_version=v8,
            event_id=uid("m2-e4")))
        v9 = uid("m2-v5-delete")
        deleted = call_mutation(
            dsn, operation="DELETE", key="delete-m2-key", op_id=uid("m2-op5"),
            memory_id=m2, base_version=v8, new_version=v9,
            event_id=uid("m2-e5"), conflict_id=uid("m2-g5"),
            reason_code="USER_REQUEST")
        late = call_mutation(
            dsn, operation="UPDATE", key="late-update-m2", op_id=uid("m2-op6"),
            memory_id=m2, base_version=v8, new_version=uid("m2-v6"),
            event_id=uid("m2-e6"), conflict_id=uid("m2-g6"),
            content="synthetic-late")
        check(deleted["code"] == "DELETED" and late["code"] == "ALREADY_DELETED",
              "delete did not win against late update")
        check(late["seq"] == deleted["seq"] and
              scalar(dsn, "SELECT count(*) FROM clued.tombstones WHERE account_id='%s' AND memory_id='%s'" % (A, m2)) == "1",
              "late update changed tombstone state")
        passed("delete_then_late_update_no_resurrection")

        read_denied = sql(dsn, mutation_sql(
            account=A, binding=READ_A, operation="CREATE", key="read-denied",
            op_id=uid("denied-op1"), memory_id=uid("denied-m1"),
            new_version=uid("denied-v1"), event_id=uid("denied-e1"),
            conflict_id=uid("denied-g1"), content="synthetic-denied",
            space_id=SPACE_A, memory_type="PROJECT", scope="SPACE",
            truth_state="OBSERVED"), check_result=False)
        check(read_denied.returncode != 0 and "CLD-K3-WRITE-DENIED" in read_denied.stderr,
              "read-only binding wrote memory")
        passed("scope_denied")

        cross_denied = sql(dsn, mutation_sql(
            account=A, binding=WRITE_B, operation="CREATE", key="cross-denied",
            op_id=uid("denied-op2"), memory_id=uid("denied-m2"),
            new_version=uid("denied-v2"), event_id=uid("denied-e2"),
            conflict_id=uid("denied-g2"), content="synthetic-cross",
            space_id=SPACE_A, memory_type="PROJECT", scope="SPACE",
            truth_state="OBSERVED"), check_result=False)
        check(cross_denied.returncode != 0 and "CLD-K3-WRITE-DENIED" in cross_denied.stderr,
              "cross-account binding wrote memory")
        passed("cross_account_denied")

        before_seq = int(scalar(dsn, "SELECT committed_seq FROM clued.accounts WHERE account_id='%s'" % A))
        invalid = sql(dsn, mutation_sql(
            operation="CREATE", key="rollback-invalid", op_id=uid("rollback-op1"),
            memory_id=uid("rollback-m1"), new_version=uid("rollback-v1"),
            event_id=uid("rollback-e1"), conflict_id=uid("rollback-g1"),
            content="synthetic-invalid", space_id=SPACE_A,
            memory_type="INVALID", scope="SPACE", truth_state="OBSERVED"),
            check_result=False)
        check(invalid.returncode != 0, "invalid mutation unexpectedly succeeded")
        after_seq = int(scalar(dsn, "SELECT committed_seq FROM clued.accounts WHERE account_id='%s'" % A))
        check(before_seq == after_seq, "failed transaction consumed sequence")
        passed("transaction_rollback_gap_free")

        concurrent_args = dict(
            operation="CREATE", key="concurrent-same", op_id=uid("concurrent-op"),
            memory_id=uid("concurrent-m"), new_version=uid("concurrent-v"),
            event_id=uid("concurrent-e"), conflict_id=uid("concurrent-g"),
            content="synthetic-concurrent", space_id=SPACE_A,
            memory_type="PROJECT", scope="SPACE", truth_state="OBSERVED")
        command = mutation_sql(**concurrent_args)
        argv = [tooling._exe("psql", BIN_DIR), "--no-psqlrc", "--dbname", dsn,
                "--set", "ON_ERROR_STOP=1", "--tuples-only", "--no-align",
                "--field-separator", "|", "--command", command]
        procs = [subprocess.Popen(argv, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True,
                                  encoding="utf-8", errors="replace")
                 for _ in range(2)]
        outputs = [proc.communicate(timeout=30) + (proc.returncode,) for proc in procs]
        check(all(item[2] == 0 for item in outputs),
              "concurrent idempotent call failed")
        rows = [[line for line in item[0].splitlines() if "|" in line][-1]
                for item in outputs]
        check(len(set(row.split("|")[3] for row in rows)) == 1 and
              sorted(row.split("|")[5] for row in rows) == ["f", "t"],
              "concurrent duplicate was not exactly-once")
        passed("concurrent_exactly_once")

        scan = tooling.scan_invariants(dsn, BIN_DIR)
        check(scan["ok"], "foundation invariants failed: %r" % scan["violations"])
        lifecycle_scan = tooling.scan_lifecycle_invariants(dsn, BIN_DIR)
        check(lifecycle_scan["ok"], "lifecycle invariants failed: %r" %
              lifecycle_scan["violations"])
        check(lifecycle_scan["checked"] == 11,
              "lifecycle invariant coverage changed")
        passed("post_lifecycle_invariants")

        tooling.migrate_lifecycle(dsn, "down", BIN_DIR)
        migrated_k3 = False
        check(scalar(dsn, "SELECT count(*) FROM clued.schema_migrations") == "1",
              "lifecycle down migration ledger mismatch")
        check(scalar(dsn, "SELECT has_table_privilege('clued_service','clued.memory_current','INSERT')") == "t",
              "down migration did not restore K2 service ACL")
        passed("down_migration_roundtrip")

        print("K3_POSTGRES_PASS=%d" % len(tests))
        return tests
    finally:
        if migrated_k3:
            try:
                tooling.migrate_lifecycle(dsn, "down", BIN_DIR)
            except Exception:
                pass
        if migrated_k2:
            try:
                tooling.migrate(dsn, "down", BIN_DIR)
            except Exception:
                pass
        pg_cmd("dropdb", "--maintenance-db", ADMIN_URL, "--if-exists",
               "--force", database, check_result=False)


if __name__ == "__main__":
    try:
        run()
    except Exception as exc:
        print("K3_POSTGRES_FAIL=%s" % tooling.redact(str(exc)), file=sys.stderr)
        raise
