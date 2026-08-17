#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Markdown → Memory Object 迁移（Phase 11 / 执行计划 §22）。

    python migrate-memory.py --dry-run    # 扫描并输出迁移计划（零写入）
    python migrate-memory.py --validate   # 校验计划候选与既有对象
    python migrate-memory.py --migrate    # 生成 memory/objects/*.json（幂等）
    python migrate-memory.py --rollback   # 回滚最近一次 migrate（仅删本次创建对象）

原则（§22）：
- 不把所有 Markdown 行都转成记忆：只识别
  identity / preference / project / decision / constraint / history
- 不能确定 → status=candidate + tag manual-review
- 绝对不把推测自动升级成事实：
  画像.md（用户自述）与决策.md「已确认/已否决」（用户决策）→ evidence=explicit → active
  状态.md / 归档.md / 待办.md（AI 记录）→ evidence=observed → candidate + manual-review
- 幂等：id 由 source_ref+content 哈希派生，重跑不产生重复
- 旧 Markdown 五文件与 L1-L6 映射原样保留（§16 双写）
"""

import argparse
import hashlib
import json
import os
import re
import sys

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from memory_engine import audit
from memory_engine import object_index
from memory_engine import paths
from memory_engine import schema as S
from memory_engine import store

MIGRATION_FILES = ["画像.md", "状态.md", "决策.md", "待办.md", "归档.md"]

# 文件+段名 → (type, category, recall_layer, evidence)
SECTION_RULES = {
    # 画像.md：用户自述 → explicit → active
    "画像.md##一句话": ("foundational", "identity", "L1", "explicit"),
    "画像.md##身份轨迹": ("foundational", "identity", "L1", "explicit"),
    "画像.md##技术能力": ("semantic", "identity", "L1", "explicit"),
    "画像.md##真正想做的事（游戏）": ("semantic", "preference", "L2", "explicit"),
    "画像.md##审美": ("semantic", "preference", "L2", "explicit"),
    "画像.md##工作室命名": ("semantic", "preference", "L2", "explicit"),
    "画像.md##工作方式（对 AI / 工具的要求）": ("semantic", "preference", "L2", "explicit"),
    "画像.md##软件工程态度": ("semantic", "preference", "L2", "explicit"),
    "画像.md##产品思维": ("semantic", "preference", "L2", "explicit"),
    "画像.md##学习方式": ("semantic", "preference", "L2", "explicit"),
    "画像.md##游戏偏好（研究型玩家）": ("semantic", "preference", "L2", "explicit"),
    "画像.md##决策风格": ("semantic", "preference", "L2", "explicit"),
    "画像.md##性格与风险": ("semantic", "preference", "L2", "explicit"),
    "画像.md##优势与最终形态": ("semantic", "preference", "L2", "explicit"),
    "画像.md##核心结论": ("semantic", "preference", "L2", "explicit"),
    "画像.md##雷区（不要触碰）": ("semantic", "constraint", "L5", "explicit"),
    # 状态.md：AI 记录的项目状态 → observed → candidate
    "状态.md##一句话": ("state", "state", "L3", "observed"),
    "状态.md##主线一：游戏原型（UE）": ("state", "project", "L3", "observed"),
    "状态.md##主线二：剧情编剧": ("state", "project", "L3", "observed"),
    "状态.md##工作室": ("state", "project", "L3", "observed"),
    "状态.md##记忆系统与工具链": ("episodic", "history", "L4", "observed"),
    "状态.md##当前最重要的一件事": ("state", "state", "L3", "observed"),
    # 决策.md：用户决策 → explicit → active
    "决策.md##已确认": ("semantic", "decision", "L3", "explicit"),
    "决策.md##已否决（不要重复推荐）": ("semantic", "constraint", "L5", "explicit"),
    "决策.md##搁置 / 待定": ("state", "decision", "L3", "explicit"),
    # 待办/归档：AI 记录 → observed → candidate + manual-review
    "待办.md##最高优先级": ("state", "todo", None, "observed"),
    "待办.md##记忆系统": ("state", "todo", None, "observed"),
    "待办.md##Sprint 3 清单（代码级 Gap Audit 2026-08-16 产出）——**已全部闭环（2026-08-16，DSH@TURING，封版）**": ("episodic", "history", "L4", "observed"),
    "待办.md##游戏原型": ("state", "todo", None, "observed"),
    "待办.md##剧情": ("state", "todo", None, "observed"),
    "待办.md##工作室": ("state", "todo", None, "observed"),
    "归档.md": ("episodic", "history", "L4", "observed"),
}

DEFAULT_RULE = (None, None, None, "observed")  # 未识别段 → 跳过

# 段内条目内容修剪：去掉 markdown 列表/加粗/行内代码
_CLEAN_RE = re.compile(r"`|\*\*|~~")
_TODO_RE = re.compile(r"^- \[( |x)\] ")


def clean_line(text):
    text = _TODO_RE.sub("", text)
    return _CLEAN_RE.sub("", text).strip()


def section_rules_for(file):
    """返回该文件的段匹配规则列表 [(section_or_None, rule)]。"""
    out = []
    for key, rule in SECTION_RULES.items():
        f, _, sec = key.partition("##")
        if f == file:
            out.append((sec, rule))
    return out


def _match_rule(file, section):
    rules = section_rules_for(file)
    for sec, rule in rules:
        if sec == section:
            return rule
        if sec == "" and file == "归档.md":
            return rule
    return None


def parse_markdown(file):
    """解析文件为 [(section, [(条目文本, 是否已完成待办)])]。"""
    path = os.path.join(paths.MEMORY_DIR, file)
    if not os.path.isfile(path):
        return []
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    sections = []
    current = None
    for line in text.splitlines():
        m = re.match(r"^##\s+(.*)$", line)
        if m:
            current = m.group(1).strip()
            sections.append([current, []])
            continue
        if current is None:
            continue
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith(">"):
            continue  # 引用头/说明行不入库
        if stripped.startswith("#"):
            continue
        if stripped.startswith("|"):
            continue  # 表格行（标签速查等）不做单条记忆
        done = bool(re.match(r"^- \[x\]", stripped))
        sections[-1][1].append((clean_line(stripped), done))
    return sections


# 纯命令/链接行：不是记忆，是操作记录（留在 Markdown/git 历史即可）
_COMMAND_RE = re.compile(
    r"^(git |powershell|python |node |dsh |winget |pip |https?://)")


def _worth_migrating(line):
    """§22：不把所有行都转成记忆。"""
    if len(line) < 8:
        return False
    if _COMMAND_RE.match(line):
        return False
    return True


def derive_id(source_ref, content):
    digest = hashlib.sha1(
        (source_ref + "\x00" + content).encode("utf-8")).hexdigest()[:8]
    return "mem_" + digest


def build_plan():
    """扫描五个 Markdown 文件 → 迁移计划。

    返回 {"candidates": [...], "skipped": [...], "stats": {...}}。
    """
    candidates = []
    skipped = []
    stats = {"per_file": {}, "per_rule": {}}
    for file in MIGRATION_FILES:
        sections = parse_markdown(file)
        n = 0
        for section, lines in sections:
            if not lines:
                continue
            for line, done in lines:
                if not line:
                    continue
                # 已完成待办：价值在 git 历史，不做长期记忆对象
                if done:
                    skipped.append({"file": file, "section": section,
                                    "line": line, "reason": "已完成待办"})
                    continue
                if not _worth_migrating(line):
                    skipped.append({"file": file, "section": section,
                                    "line": line, "reason": "短行/命令/链接"})
                    continue
                if "（superseded" in line:
                    # 已标 superseded 的历史结论：保留为 history 而非当前约束
                    rule = ("episodic", "history", "L4", "observed")
                    source_ref = "%s##%s" % (file, section)
                else:
                    rule = _match_rule(file, section)
                    source_ref = "%s##%s" % (file, section)
                if rule is None:
                    skipped.append({"file": file, "section": section,
                                    "line": line, "reason": "未识别段"})
                    continue
                type_, category, layer, evidence = rule
                oid = derive_id(source_ref, line)
                status = ("active" if evidence == "explicit"
                          else "candidate")
                tags = ["manual-review"] if status == "candidate" else []
                if file == "归档.md" or (file == "待办.md" and
                                         category == "history"):
                    tags = ["manual-review"]
                candidate = S.new_object(
                    oid=oid, type_=type_, content=line, scope="global",
                    status=status, category=category, evidence=evidence,
                    priority="medium", recall_layer=layer,
                    adapter="migrate-memory.py", session_id=None,
                    tags=tags, source_kind="migration",
                    source_ref=source_ref)
                candidates.append(candidate)
                n += 1
        stats["per_file"][file] = n
        if n == 0 and file == "待办.md":
            pass
    stats["per_rule"] = {
        "active": sum(1 for c in candidates if c["status"] == "active"),
        "candidate": sum(1 for c in candidates
                         if c["status"] == "candidate"),
        "skipped": len(skipped),
    }
    return {"candidates": candidates, "skipped": skipped, "stats": stats}


def cmd_dry_run(_args):
    plan = build_plan()
    print("== migrate --dry-run（零写入）==")
    print("candidates: %d（active=%d candidate=%d） skipped=%d"
          % (len(plan["candidates"]), plan["stats"]["per_rule"]["active"],
             plan["stats"]["per_rule"]["candidate"],
             plan["stats"]["per_rule"]["skipped"]))
    for f in MIGRATION_FILES:
        print("  %s: %d" % (f, plan["stats"]["per_file"][f]))
    existing = set(store.list_object_ids())
    new_count = sum(1 for c in plan["candidates"] if c["id"] not in existing)
    print("已存在（幂等跳过）: %d，新增: %d"
          % (len(plan["candidates"]) - new_count, new_count))
    print("---- 候选样例（前 12 条）----")
    for c in plan["candidates"][:12]:
        print("[%s] %s | %s/%s | %s | %s"
              % (c["status"], c["id"], c["type"],
                 (c["classification"] or {}).get("category"),
                 c["provenance"]["evidence"],
                 c["content"][:60]))
    return 0


def cmd_validate(_args):
    plan = build_plan()
    bad = []
    for c in plan["candidates"]:
        ok, errors = S.validate_object(c)
        if not ok:
            bad.append((c["id"], errors))
    existing = store.load_all_objects(include_invalid=True)
    for o in existing:
        ok, errors = S.validate_object(o)
        if not ok:
            bad.append((o.get("id", "?"), errors))
    if bad:
        print("== migrate --validate：%d 项非法 ==" % len(bad))
        for oid, errors in bad[:20]:
            print("  %s: %s" % (oid, "; ".join(errors)))
        return 1
    print("== migrate --validate：全部候选与既有对象 schema 合法 ==")
    return 0


def _backup_dir():
    d = os.path.join(paths.REPO, ".migration-backups")
    os.makedirs(d, exist_ok=True)
    return d


def cmd_migrate(_args):
    plan = build_plan()
    existing = set(store.list_object_ids())
    created, skipped_existing = [], 0
    for c in plan["candidates"]:
        if c["id"] in existing:
            skipped_existing += 1
            continue
        if store.find_secret_in_object(c):
            print("[!] 候选含密钥样值，拒绝: %s" % c["id"])
            continue
        store.save_object(c)
        created.append(c["id"])
        audit.append(audit.make_entry(
            memory_id=c["id"], operation="MIGRATE",
            adapter="migrate-memory.py",
            reason=(c.get("provenance") or {}).get("source_ref") or "",
            previous_status=None, new_status=c["status"]))
    object_index.rebuild()
    manifest = {
        "timestamp": S.now_iso(),
        "created_ids": created,
        "source": "migrate-memory.py",
    }
    manifest_path = os.path.join(
        _backup_dir(), "manifest-" + S.now_iso().replace(":", "") + ".json")
    with open(manifest_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
    print("== migrate 完成：新建 %d、幂等跳过 %d；manifest=%s =="
          % (len(created), skipped_existing,
             os.path.basename(manifest_path)))
    return 0


def cmd_rollback(_args):
    d = _backup_dir()
    manifests = sorted(
        [f for f in os.listdir(d) if f.startswith("manifest-")])
    if not manifests:
        print("无迁移 manifest，无法回滚")
        return 1
    latest = os.path.join(d, manifests[-1])
    with open(latest, "r", encoding="utf-8") as fh:
        manifest = json.load(fh)
    removed = 0
    for oid in manifest.get("created_ids") or []:
        p = store.object_path(oid)
        if os.path.isfile(p):
            os.remove(p)
            removed += 1
    object_index.rebuild()
    audit.append(audit.make_entry(
        memory_id="-", operation="ROLLBACK",
        adapter="migrate-memory.py",
        reason="rollback manifest %s" % manifests[-1],
        previous_status=None, new_status=None,
        extra={"removed": removed}))
    print("== rollback 完成：删除本次迁移创建的 %d 个对象（manifest=%s）=="
          % (removed, manifests[-1]))
    return 0


def build_parser():
    p = argparse.ArgumentParser(
        prog="migrate-memory.py",
        description="Markdown → Memory Object 迁移（vNext-2.0）")
    p.add_argument("--dry-run", action="store_true",
                   help="扫描并输出计划，零写入")
    p.add_argument("--validate", action="store_true",
                   help="校验候选与既有对象 schema")
    p.add_argument("--migrate", action="store_true",
                   help="生成对象（幂等）+ 审计 + 重建索引")
    p.add_argument("--rollback", action="store_true",
                   help="回滚最近一次 migrate（仅删本次创建对象）")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    selected = [k for k in ("dry_run", "validate", "migrate", "rollback")
                if getattr(args, k)]
    if len(selected) != 1:
        print("必须且只能指定 --dry-run / --validate / --migrate / --rollback 之一")
        return 2
    if args.dry_run:
        return cmd_dry_run(args)
    if args.validate:
        return cmd_validate(args)
    if args.migrate:
        return cmd_migrate(args)
    return cmd_rollback(args)


if __name__ == "__main__":
    sys.exit(main())
