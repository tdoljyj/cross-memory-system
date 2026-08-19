#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cross Memory System vNext-2.0 · Memory Engine CLI

    python memory.py status                     # 对象库统计
    python memory.py doctor [--fix]             # 引擎体检（17 项检查，FAIL → exit 1）
    python memory.py recall "query" [--tier T0..T4] [--history] [--scope S] ...
    python memory.py add --content "..." --type semantic --category preference ...
    python memory.py update --id mem_xxx --content "..."
    python memory.py supersede --id mem_xxx --content "..."
    python memory.py consolidate --from mem_a,mem_b --content "..." [--confirm]
    python memory.py procedural --content "..." --category workflow
    python memory.py rebuild-index
    python memory.py migrate --dry-run          # 委托 migrate-memory.py
    python memory.py delete --id mem_xxx        # 归档（不物理删除）
    python memory.py reject --id mem_xxx        # candidate → rejected
    python memory.py audit [--id mem_xxx]

分层纪律：本 CLI 只做 Memory Engine（对象/生命周期/召回/写入），
commit/push 仍走 Git Sync Layer（sync-memory.py / sync-memory.ps1），
引擎不代执行 git 写操作。
"""

import argparse
import json
import os
import sys

# 控制台 UTF-8（Windows GBK 控制台下不崩）
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from adapters.cli_adapter import CLIAdapter
from memory_engine import audit as audit_mod
from memory_engine import doctor_v2
from memory_engine import object_index
from memory_engine import paths
from memory_engine import schema as S
from memory_engine import store
from memory_engine import write_engine

ADAPTER = CLIAdapter()


def _out(payload):
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def cmd_status(_args):
    stats = ADAPTER.status()
    _out(stats)
    return 0


def cmd_doctor(args):
    rep = doctor_v2.run_doctor(fix=args.fix)
    for kind, name, detail in rep.lines:
        print("[%s] %s%s" % (kind, name, ("（%s）" % detail) if detail else ""))
    if rep.failures:
        print("engine doctor: %d FAILURE(S)" % len(rep.failures))
        return 1
    print("engine doctor: ALL PASS（%d WARN）" % len(rep.warnings))
    return 0


def cmd_recall(args):
    result = ADAPTER.recall(
        query=args.query, tier=args.tier, include_history=args.history,
        scope=args.scope, limit=args.limit,
        categories=args.categories.split(",") if args.categories else None,
        tags=args.tags.split(",") if args.tags else None,
        entities=args.entities.split(",") if args.entities else None,
        project_id=args.project_id, session_id=args.session_id,
        explain=args.explain)
    _out(result.to_dict())
    return 0


def _split(v):
    return [x.strip() for x in v.split(",") if x.strip()] if v else None


def cmd_add(args):
    oid = args.id or store.new_id()
    candidate = S.new_object(
        oid=oid, type_=args.type, content=args.content, scope=args.scope,
        status="active" if args.remember else args.status,
        category=args.category, evidence=args.evidence,
        priority=args.priority,
        recall_layer=args.layer, adapter="memory.py",
        valid_from=args.valid_from, valid_until=args.valid_until,
        tags=_split(args.tags), entities=_split(args.entities),
        source_kind=args.source_kind, project_id=args.project_id)
    result = write_engine.perform_write(
        candidate, explicit_remember=args.remember, confirm=args.confirm,
        dry_run=args.dry_run)
    _out(result.to_dict())
    return 0


def cmd_update(args):
    result = ADAPTER.update(args.id, args.content)
    _out(result.to_dict())
    return 0


def cmd_supersede(args):
    result = ADAPTER.supersede(args.id, args.content)
    _out(result.to_dict())
    return 0


def cmd_consolidate(args):
    ids = _split(args.sources) or []
    action, oid, entries = _consolidate(args, ids)
    _out({"action": action, "memory_id": oid,
          "audit_entries": [e for e in entries]})
    return 0


def _consolidate(args, ids):
    from memory_engine import consolidation
    return consolidation.consolidate(
        ids, args.content, category=args.category, scope=args.scope,
        priority=args.priority, confirm=args.confirm, dry_run=args.dry_run)


def cmd_procedural(args):
    from memory_engine import procedural
    oid = procedural.create_procedural(
        args.content, category=args.category, scope=args.scope,
        priority=args.priority, evidence=args.evidence,
        tags=_split(args.tags), entities=_split(args.entities))
    _out({"memory_id": oid, "status": "active"})
    return 0


def cmd_rebuild_index(_args):
    idx = object_index.rebuild()
    print("object-index.json 已重建：%d 个对象" % len(idx["objects"]))
    return 0


def cmd_migrate(args):
    import subprocess
    script = os.path.join(paths.REPO, "migrate-memory.py")
    cmd = [sys.executable, script]
    if args.dry_run:
        cmd.append("--dry-run")
    if args.migrate:
        cmd.append("--migrate")
    if args.validate:
        cmd.append("--validate")
    if args.rollback:
        cmd.append("--rollback")
    p = subprocess.run(cmd, cwd=paths.REPO)
    return p.returncode


def cmd_delete(args):
    result = write_engine.archive_object(
        args.id, reason=args.reason or "CLI delete")
    _out({"memory_id": args.id, "status": "archived",
          "reason": args.reason or "CLI delete"})
    return 0


def cmd_reject(args):
    write_engine.reject_candidate(args.id, reason=args.reason or "CLI reject")
    _out({"memory_id": args.id, "status": "rejected"})
    return 0


def cmd_audit(args):
    entries = (audit_mod.entries_for(args.id)
               if args.id else audit_mod.read_all())
    _out(entries)
    return 0


def build_parser():
    p = argparse.ArgumentParser(
        prog="memory.py",
        description="Cross Memory System vNext-2.0 Memory Engine CLI")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("status", help="对象库统计").set_defaults(func=cmd_status)

    d = sub.add_parser("doctor", help="引擎体检（17 项检查）")
    d.add_argument("--fix", action="store_true",
                   help="重建派生索引（仅安全派生修复）")
    d.set_defaults(func=cmd_doctor)

    r = sub.add_parser("recall", help="确定性混合召回")
    r.add_argument("query")
    r.add_argument("--tier", default="T2", choices=["T0", "T1", "T2", "T3", "T4"])
    r.add_argument("--history", action="store_true",
                   help="包含 superseded/archived（历史查询）")
    r.add_argument("--scope", default=None,
                   help="global/project/session（legacy）或 project_only/"
                        "session_only/temporary（MIV-006）")
    r.add_argument("--project-id", default=None,
                   help="scope=project_only 时的项目分区 ID")
    r.add_argument("--session-id", default=None,
                   help="scope=session_only 时的会话 ID")
    r.add_argument("--limit", type=int, default=10)
    r.add_argument("--categories")
    r.add_argument("--tags")
    r.add_argument("--entities")
    r.add_argument("--explain", action="store_true",
                   help="生成只读 Recall Trace（为什么召回；不影响召回结果）")
    r.set_defaults(func=cmd_recall)

    a = sub.add_parser("add", help="写入新记忆（决策由引擎裁决）")
    a.add_argument("--content", required=True)
    a.add_argument("--type", default="semantic", choices=S.FUNCTION_TYPES)
    a.add_argument("--scope", default="global", choices=S.SCOPES)
    a.add_argument("--project-id", default=None,
                   help="scope=project 时的项目分区 ID（MIV-006）")
    a.add_argument("--category", default="other", choices=S.CATEGORIES)
    a.add_argument("--evidence", default="observed", choices=S.EVIDENCES)
    a.add_argument("--priority", default="medium", choices=S.PRIORITIES)
    a.add_argument("--layer", default=None, choices=[None] + S.RECALL_LAYERS)
    a.add_argument("--status", default=None,
                   choices=[None] + S.STATUSES,
                   help="显式指定状态（默认按 evidence/remember 判定）")
    a.add_argument("--id", default=None)
    a.add_argument("--tags")
    a.add_argument("--entities")
    a.add_argument("--source-kind", default=None, choices=S.SOURCE_KINDS)
    a.add_argument("--valid-from")
    a.add_argument("--valid-until")
    a.add_argument("--remember", action="store_true",
                   help="T4 明确记忆：直接 active")
    a.add_argument("--confirm", action="store_true",
                   help="candidate 确认升级为 active")
    a.add_argument("--dry-run", action="store_true", help="只决策不落盘")
    a.set_defaults(func=cmd_add)

    u = sub.add_parser("update", help="同对象细化更新（UPDATE_MEMORY）")
    u.add_argument("--id", required=True)
    u.add_argument("--content", required=True)
    u.set_defaults(func=cmd_update)

    s = sub.add_parser("supersede", help="明确推翻旧记忆（旧→superseded，新→active）")
    s.add_argument("--id", required=True)
    s.add_argument("--content", required=True)
    s.set_defaults(func=cmd_supersede)

    c = sub.add_parser("consolidate", help="Episodic → Semantic 巩固")
    c.add_argument("--from", dest="sources", required=True,
                   help="逗号分隔的 episode id")
    c.add_argument("--content", required=True)
    c.add_argument("--category", default="preference")
    c.add_argument("--scope", default="global")
    c.add_argument("--priority", default="medium", choices=S.PRIORITIES)
    c.add_argument("--confirm", action="store_true")
    c.add_argument("--dry-run", action="store_true")
    c.set_defaults(func=cmd_consolidate)

    pr = sub.add_parser("procedural", help="写入 Procedural 记忆")
    pr.add_argument("--content", required=True)
    pr.add_argument("--category", default="workflow",
                    choices=["workflow", "toolchain", "method"])
    pr.add_argument("--scope", default="global")
    pr.add_argument("--priority", default="medium", choices=S.PRIORITIES)
    pr.add_argument("--evidence", default="explicit", choices=S.EVIDENCES)
    pr.add_argument("--tags")
    pr.add_argument("--entities")
    pr.set_defaults(func=cmd_procedural)

    sub.add_parser("rebuild-index",
                   help="重建 object-index.json（派生索引）"
                   ).set_defaults(func=cmd_rebuild_index)

    m = sub.add_parser("migrate", help="Markdown → Object 迁移（委托 migrate-memory.py）")
    m.add_argument("--dry-run", action="store_true")
    m.add_argument("--migrate", action="store_true")
    m.add_argument("--validate", action="store_true")
    m.add_argument("--rollback", action="store_true")
    m.set_defaults(func=cmd_migrate)

    de = sub.add_parser("delete", help="删除=归档（不物理删除，§6.7）")
    de.add_argument("--id", required=True)
    de.add_argument("--reason", default="")
    de.set_defaults(func=cmd_delete)

    rj = sub.add_parser("reject", help="候选拒绝（candidate → rejected）")
    rj.add_argument("--id", required=True)
    rj.add_argument("--reason", default="")
    rj.set_defaults(func=cmd_reject)

    au = sub.add_parser("audit", help="审计日志")
    au.add_argument("--id", default=None)
    au.set_defaults(func=cmd_audit)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
