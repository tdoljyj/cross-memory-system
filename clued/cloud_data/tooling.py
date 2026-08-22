# -*- coding: utf-8 -*-
"""PostgreSQL migration, invariant, projection and recovery tooling for K2.

Only synthetic local/dev databases are in scope.  Commands never print a DSN,
password, SQL body, memory content or query text.  PostgreSQL executables are
resolved explicitly and invoked without a shell.
"""

import argparse
import csv
import io
import json
import os
import re
import shutil
import subprocess
import sys

from . import MIGRATION_ID


ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PG_ROOT = os.path.join(ROOT, "cloud", "postgres")
MIGRATIONS = os.path.join(PG_ROOT, "migrations")
SQL_DIR = os.path.join(PG_ROOT, "sql")
UP_SQL = os.path.join(MIGRATIONS, MIGRATION_ID + ".up.sql")
DOWN_SQL = os.path.join(MIGRATIONS, MIGRATION_ID + ".down.sql")
INVARIANT_SQL = os.path.join(SQL_DIR, "scan_invariants.sql")

_DSN_RE = re.compile(r"(?i)(postgres(?:ql)?://)([^\s/@:]+)(?::[^\s/@]*)?@")
_PASSWORD_RE = re.compile(r"(?i)(password\s*[=:]\s*)[^\s]+")


class ToolError(RuntimeError):
    pass


def redact(text):
    text = _DSN_RE.sub(r"\1<redacted>@", text or "")
    return _PASSWORD_RE.sub(r"\1<redacted>", text)


def _exe(name, bin_dir=None):
    if bin_dir:
        candidate = os.path.join(bin_dir, name + (".exe" if os.name == "nt" else ""))
        if os.path.isfile(candidate):
            return candidate
        raise ToolError("required PostgreSQL executable is missing: %s" % name)
    found = shutil.which(name)
    if not found:
        raise ToolError("required PostgreSQL executable is unavailable: %s" % name)
    return found


def _run(argv, env=None, input_text=None, check=True):
    merged = os.environ.copy()
    if env:
        merged.update(env)
    proc = subprocess.run(
        argv, input=input_text, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", env=merged,
        check=False)
    if check and proc.returncode != 0:
        detail = redact(proc.stderr.strip())
        if len(detail) > 1200:
            detail = detail[:1200] + "..."
        raise ToolError("PostgreSQL command failed (%d): %s" %
                        (proc.returncode, detail or "no diagnostic"))
    return proc


def psql(dsn, *, bin_dir=None, file_path=None, command=None, csv_output=False,
         check=True):
    argv = [_exe("psql", bin_dir), "--no-psqlrc", "--dbname", dsn,
            "--set", "ON_ERROR_STOP=1"]
    if csv_output:
        argv.append("--csv")
    if file_path:
        argv.extend(["--file", file_path])
    if command:
        argv.extend(["--command", command])
    return _run(argv, check=check)


def migrate(dsn, direction, bin_dir=None):
    path = UP_SQL if direction == "up" else DOWN_SQL
    if not os.path.isfile(path):
        raise ToolError("migration file is missing")
    psql(dsn, bin_dir=bin_dir, file_path=path)
    return {"ok": True, "operation": "migrate_%s" % direction,
            "migration_id": MIGRATION_ID}


def migration_status(dsn, bin_dir=None):
    sql = (
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables "
        "WHERE table_schema='clued' AND table_name='schema_migrations') "
        "AS schema_present, "
        "COALESCE((SELECT bool_or(migration_id='%s') FROM "
        "clued.schema_migrations), false) AS migration_applied;" % MIGRATION_ID)
    proc = psql(dsn, bin_dir=bin_dir, command=sql, csv_output=True,
                check=False)
    if proc.returncode != 0:
        return {"ok": True, "schema_present": False,
                "migration_applied": False}
    rows = list(csv.DictReader(io.StringIO(proc.stdout)))
    if not rows:
        raise ToolError("migration status returned no row")
    return {
        "ok": True,
        "schema_present": rows[0]["schema_present"] == "t",
        "migration_applied": rows[0]["migration_applied"] == "t",
    }


def scan_invariants(dsn, bin_dir=None):
    proc = psql(dsn, bin_dir=bin_dir, file_path=INVARIANT_SQL,
                csv_output=True)
    rows = list(csv.DictReader(io.StringIO(proc.stdout)))[0:]
    violations = []
    for row in rows:
        count = int(row["violation_count"])
        if count:
            violations.append({"name": row["invariant_name"], "count": count})
    return {"ok": not violations, "checked": len(rows),
            "violations": violations}


def rebuild_projection(dsn, account_id, bin_dir=None):
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", account_id or ""):
        raise ToolError("account_id must be a UUID")
    sql = "SELECT clued.rebuild_memory_current('%s'::uuid) AS rebuilt_rows;" % account_id
    proc = psql(dsn, bin_dir=bin_dir, command=sql, csv_output=True)
    rows = list(csv.DictReader(io.StringIO(proc.stdout)))
    return {"ok": True, "rebuilt_rows": int(rows[0]["rebuilt_rows"])}


def backup(dsn, output_path, bin_dir=None):
    output_path = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    argv = [_exe("pg_dump", bin_dir), "--dbname", dsn, "--format", "custom",
            "--no-owner", "--no-privileges", "--file", output_path]
    _run(argv)
    return {"ok": True, "operation": "backup",
            "bytes": os.path.getsize(output_path)}


def restore(dsn, input_path, bin_dir=None):
    input_path = os.path.abspath(input_path)
    if not os.path.isfile(input_path):
        raise ToolError("backup file is missing")
    argv = [_exe("pg_restore", bin_dir), "--dbname", dsn, "--no-owner",
            "--no-privileges", "--exit-on-error", input_path]
    _run(argv)
    return {"ok": True, "operation": "restore"}


def build_parser():
    parser = argparse.ArgumentParser(prog="python -m clued.cloud_data")
    parser.add_argument("--dsn", default=os.environ.get("CLD_K2_DATABASE_URL"))
    parser.add_argument("--bin-dir", default=os.environ.get("CLD_K2_PG_BIN"))
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    mig = sub.add_parser("migrate")
    mig.add_argument("direction", choices=("up", "down"))
    scan = sub.add_parser("scan")
    rebuild = sub.add_parser("rebuild-projection")
    rebuild.add_argument("account_id")
    dump = sub.add_parser("backup")
    dump.add_argument("path")
    load = sub.add_parser("restore")
    load.add_argument("path")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if not args.dsn:
        print(json.dumps({"ok": False, "code": "CLD-K2-DB-CONFIG",
                          "message": "CLD_K2_DATABASE_URL is required"}))
        return 10
    try:
        if args.command == "status":
            result = migration_status(args.dsn, args.bin_dir)
        elif args.command == "migrate":
            result = migrate(args.dsn, args.direction, args.bin_dir)
        elif args.command == "scan":
            result = scan_invariants(args.dsn, args.bin_dir)
        elif args.command == "rebuild-projection":
            result = rebuild_projection(args.dsn, args.account_id, args.bin_dir)
        elif args.command == "backup":
            result = backup(args.dsn, args.path, args.bin_dir)
        else:
            result = restore(args.dsn, args.path, args.bin_dir)
    except ToolError as exc:
        print(json.dumps({"ok": False, "code": "CLD-K2-DB-ERROR",
                          "message": redact(str(exc))}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
