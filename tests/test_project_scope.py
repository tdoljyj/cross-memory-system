#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Project-only Scope 硬隔离测试（MIV-006 / Gate 2R 第一阶段新增测试）。

覆盖执行计划 §MIV-006 强制测试 + ADR-MIV-006-001 §7 测试计划：
 1. A 项目不可读 B 项目（硬过滤 + Trace PROJECT_MISMATCH）
 2. B 项目内容不可影响 global recall
 3. project-only 切换不静默复制对象
 4. temporary / session-only 不产生长期写入（fail-closed 零副作用）
 5. 管理员 / Adapter 不能绕过硬过滤（含约束附着防泄漏）
 6. Trace 对越界候选仅显示安全元数据（零内容、零秘密）
 7. legacy mode（global/project/session）行为逐字节不变
 8. session_only 可见性（session_id 匹配 / 不匹配 / global 可见）
 9. temporary 查询零长期读取（炸弹探针）
 10. 缺失 project_id / session_id fail-closed
 11. project_id schema 校验（类型 / 缺失兼容）
 12. supersede 继承 project_id（分区标记不丢失）
 13. candidate_lookup 项目分区去重（跨项目不串扰）
 14. 新 mode 下 explain=False/True 等价 + Trace scope 合同

运行：python tests/test_project_scope.py
"""

import functools
import json
import os
import shutil
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from adapters.cli_adapter import CLIAdapter  # noqa: E402
from memory_engine import paths as engine_paths  # noqa: E402
from memory_engine import recall_engine  # noqa: E402
from memory_engine import recall_trace as RT  # noqa: E402
from memory_engine import schema as S  # noqa: E402
from memory_engine import store  # noqa: E402
from memory_engine import write_engine  # noqa: E402


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def tok(prefix="ghp_"):
    """运行时拼接凭据样值（防测试文件自命中扫描模式）。"""
    return prefix + "A" * 32


def make_repo():
    """建临时引擎仓库（内存对象夹具 + 空 markdown 召回索引 + guards）。"""
    tmp = tempfile.mkdtemp(prefix="scope-test-")
    memdir = os.path.join(tmp, "memory")
    os.makedirs(os.path.join(memdir, "objects"), exist_ok=True)
    os.makedirs(os.path.join(memdir, "audit"), exist_ok=True)
    idx = {
        "schema_version": 1,
        "files": ["画像.md"],
        "recall": {
            "L1": [{"file": "画像.md", "sections": ["身份轨迹"]}],
            "L2": [{"file": "画像.md", "sections": ["审美"]}],
            "L3": [{"file": "画像.md", "sections": ["技术能力"]}],
            "L4": [], "L5": [], "L6": [],
        },
    }
    with open(os.path.join(memdir, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(idx, fh, ensure_ascii=False)
    with open(os.path.join(memdir, "画像.md"), "w", encoding="utf-8") as fh:
        fh.write("# 夹具\n## 身份轨迹\n## 审美\n## 技术能力\n")
    guards = os.path.join(REPO_ROOT, "guards.json")
    if os.path.isfile(guards):
        shutil.copy(guards, os.path.join(tmp, "guards.json"))
    return tmp


def sandboxed(fn):
    @functools.wraps(fn)
    def wrapper():
        repo = make_repo()
        engine_paths.set_repo(repo)
        store.ensure_dirs()
        try:
            fn(repo)
        finally:
            engine_paths.set_repo(REPO_ROOT)
            shutil.rmtree(repo, ignore_errors=True)
    return wrapper


def put(obj):
    """写对象夹具（不经过 write_engine，直接落盘，保证确定性）。"""
    store.save_object(obj)
    return obj["id"]


def cand(content, category="preference", evidence="explicit", scope="global",
         status="active", priority="medium", tags=None, entities=None,
         oid=None, project_id=None):
    return S.new_object(
        oid=oid or store.new_id(), type_="semantic", content=content,
        scope=scope, status=status, category=category, evidence=evidence,
        priority=priority, recall_layer="L2", adapter="scope-test",
        tags=tags, entities=entities, project_id=project_id)


def pcand(content, project_id, category="project", oid=None, **kw):
    """project 分区对象夹具。"""
    return cand(content, scope="project", category=category, oid=oid,
                project_id=project_id, **kw)


def scand(content, session_id, oid=None, category="preference"):
    """session 对象夹具（复用 source.session_id，不新增同义字段）。"""
    obj = cand(content, scope="session", oid=oid, category=category)
    obj["source"]["session_id"] = session_id
    return obj


def ids(result):
    return [o["id"] for o in result.objects]


def excluded_codes(trace, oid):
    for e in (trace or {}).get("excluded", []):
        if e.get("memory_id") == oid:
            return list(e.get("reason_codes") or [])
    return []


# ============ 1. A 项目不可读 B 项目 ============
@sandboxed
def test_project_a_cannot_read_project_b(_repo):
    a = put(pcand("项目 A 使用 UE 5.6 引擎", "p-alpha"))
    b = put(pcand("项目 B 使用 Unity 引擎", "p-beta"))
    g = put(cand("所有项目统一使用 git", category="project"))
    r = recall_engine.recall("引擎", tier="T2", layers=["L3"],
                             scope="project_only", project_id="p-alpha",
                             explain=True)
    got = set(ids(r))
    check(a in got, "p-alpha 对象必须可见: %r" % got)
    check(g in got, "global 对象在 project_only 视图可见: %r" % got)
    check(b not in got, "p-beta 对象不得泄漏进 p-alpha: %r" % got)
    check(RT.RC_PROJECT_MISMATCH in excluded_codes(r.trace, b),
          "越界排除必须带 PROJECT_MISMATCH: %r" % r.trace)


# ============ 2. B 项目内容不可影响 global recall ============
@sandboxed
def test_project_content_does_not_affect_global_recall(_repo):
    b = put(pcand("项目 B 预算上限五万", "p-beta", category="constraint"))
    g = put(cand("所有项目统一使用 git", category="constraint"))
    r = recall_engine.recall("预算 git", tier="T2", layers=["L5"],
                             scope="global", explain=True)
    got = set(ids(r))
    check(g in got, "global 约束可见: %r" % got)
    check(b not in got, "项目对象不得影响 global recall: %r" % got)
    check(RT.RC_SCOPE_MISMATCH in excluded_codes(r.trace, b),
          "global 视图排除项目对象必须带 SCOPE_MISMATCH")


# ============ 3. project-only 切换不静默复制对象 ============
@sandboxed
def test_project_switch_does_not_copy_objects(_repo):
    a = put(pcand("项目 A 独有美术风格水墨", "p-alpha"))
    before = set(store.list_object_ids())
    r = recall_engine.recall("美术风格", tier="T2", layers=["L3"],
                             scope="project_only", project_id="p-beta",
                             explain=True)
    check(ids(r) == [], "p-beta 视图不得返回 p-alpha 对象")
    after = set(store.list_object_ids())
    check(before == after, "切换项目不得复制/生成任何对象文件")
    check(a in before, "原始对象保持不变")


# ============ 4. temporary / session-only 不产生长期写入 ============
@sandboxed
def test_session_only_and_temporary_no_long_term_write(_repo):
    before_ids = set(store.list_object_ids())
    audit_path = os.path.join(engine_paths.AUDIT_DIR, "audit.log")
    idx_path = engine_paths.OBJECT_INDEX_PATH
    audit_before = open(audit_path, "rb").read() \
        if os.path.isfile(audit_path) else None
    idx_before = open(idx_path, "rb").read() \
        if os.path.isfile(idx_path) else None
    for scope in ("session_only", "temporary"):
        c = cand("本会话临时结论", scope=scope)
        try:
            write_engine.perform_write(c)
            check(False, "scope=%s 必须被拒绝持久化" % scope)
        except ValueError as e:
            check("EPHEMERAL_SCOPE_NOT_PERSISTED" in str(e),
                  "拒绝须带 EPHEMERAL_SCOPE_NOT_PERSISTED: %r" % e)
    check(set(store.list_object_ids()) == before_ids,
          "对象文件不得新增")
    audit_after = open(audit_path, "rb").read() \
        if os.path.isfile(audit_path) else None
    check(audit_before == audit_after, "审计日志不得变化")
    idx_after = open(idx_path, "rb").read() \
        if os.path.isfile(idx_path) else None
    check(idx_before == idx_after, "object-index 不得变化")


# ============ 5. Adapter 不能绕过硬过滤 ============
@sandboxed
def test_adapter_cannot_bypass_hard_filter(_repo):
    a = put(pcand("项目 A 预算上限三万", "p-alpha", category="constraint",
                  entities=["预算"]))
    b = put(pcand("项目 B 预算上限五万", "p-beta", category="constraint",
                  entities=["预算"]))
    adapter = CLIAdapter()
    r = adapter.recall("预算", tier="T2", layers=["L5"],
                       scope="project_only", project_id="p-alpha",
                       explain=True)
    got = set(ids(r))
    check(a in got and b not in got,
          "经 Adapter 调用不得绕过项目硬过滤: %r" % got)
    constraint_ids = [c["id"] for c in r.constraints]
    check(a in constraint_ids, "本分区约束应附着: %r" % constraint_ids)
    check(b not in constraint_ids, "B 项目约束不得附着 A 项目召回: %r"
          % constraint_ids)
    check(RT.RC_PROJECT_MISMATCH in excluded_codes(r.trace, b),
          "越界排除须带 PROJECT_MISMATCH")


# ============ 6. Trace 对越界候选仅显示安全元数据 ============
@sandboxed
def test_trace_out_of_scope_only_safe_metadata(_repo):
    secret = tok()
    b = put(pcand("项目 B 内部令牌 " + secret, "p-beta"))
    put(pcand("项目 A 正常内容", "p-alpha"))
    r = recall_engine.recall("令牌", tier="T2", layers=["L3"],
                             scope="project_only", project_id="p-alpha",
                             explain=True)
    check(b not in ids(r), "越界对象不得进入结果")
    blob = json.dumps(r.trace, ensure_ascii=False)
    check(secret not in blob, "Trace 不得泄漏越界对象内容/秘密")
    check("项目 B" not in blob, "Trace 不得携带越界对象内容")
    for e in r.trace["excluded"]:
        check(set(e.keys()) <= {"memory_id", "reason_codes"},
              "excluded 条目只允许 memory_id + reason_codes: %r" % e)


# ============ 7. legacy mode 行为不变 ============
@sandboxed
def test_legacy_scope_modes_unchanged(_repo):
    p1 = put(pcand("legacy 项目对象一", "p-alpha"))
    p2 = put(pcand("legacy 项目对象二", "p-beta"))
    s1 = put(scand("会话对象", "s1", category="project"))
    g = put(cand("全局对象", category="project"))
    r_proj = recall_engine.recall("对象", tier="T2", layers=["L3"],
                                  scope="project")
    got_proj = set(ids(r_proj))
    check(p1 in got_proj and p2 in got_proj,
          "legacy project 模式仍返回全部 project 对象（含已分区）")
    check(g in got_proj, "legacy project 模式仍含 global")
    check(s1 not in got_proj, "legacy project 模式仍排除 session")
    r_glob = recall_engine.recall("对象", tier="T2", layers=["L3"],
                                  scope="global")
    check(ids(r_glob) == [g], "legacy global 模式仅返回 global")
    r_sess = recall_engine.recall("对象", tier="T2", layers=["L3"],
                                  scope="session")
    got_sess = set(ids(r_sess))
    check(s1 in got_sess and g in got_sess,
          "legacy session 模式仍返回 session + global")
    check(p1 not in got_sess, "legacy session 模式仍排除 project")


# ============ 8. session_only 可见性 ============
@sandboxed
def test_session_only_visibility(_repo):
    s1 = put(scand("会话一记忆", "s1"))
    s2 = put(scand("会话二记忆", "s2"))
    s0 = put(scand("无会话 ID 记忆", None))
    g = put(cand("全局记忆"))
    r1 = recall_engine.recall("记忆", tier="T2", layers=["L2"],
                              scope="session_only", session_id="s1",
                              explain=True)
    got1 = set(ids(r1))
    check(s1 in got1 and g in got1,
          "session_only(s1) 应含本会话 + global: %r" % got1)
    check(s2 not in got1 and s0 not in got1,
          "他会话/无 ID 会话对象不得泄漏: %r" % got1)
    check(RT.RC_SESSION_MISMATCH in excluded_codes(r1.trace, s2),
          "他会话排除须带 SESSION_MISMATCH")
    r2 = recall_engine.recall("记忆", tier="T2", layers=["L2"],
                              scope="session_only", session_id="s2")
    got2 = set(ids(r2))
    check(s2 in got2 and s1 not in got2,
          "session_only(s2) 视角正确: %r" % got2)


# ============ 9. temporary 查询零长期读取 ============
@sandboxed
def test_temporary_mode_zero_reads(_repo):
    put(cand("普通长期对象"))
    orig_load = store.load_all_objects
    orig_plan = recall_engine.load_markdown_plan

    def boom(*_a, **_k):
        raise AssertionError("temporary 查询不得读取长期记忆")

    store.load_all_objects = boom
    recall_engine.load_markdown_plan = boom
    try:
        r = recall_engine.recall("任意查询", tier="T2", scope="temporary",
                                 explain=True)
    finally:
        store.load_all_objects = orig_load
        recall_engine.load_markdown_plan = orig_plan
    check(r.access == "TEMPORARY", "temporary 查询 access 应为 TEMPORARY")
    check(ids(r) == [], "temporary 查询不得返回任何长期对象")
    check(r.trace is not None and RT.RC_TEMPORARY_MODE in
          r.trace.get("reason_codes", []),
          "trace 须带 TEMPORARY_MODE")


# ============ 10. 缺失 ID fail-closed ============
@sandboxed
def test_fail_closed_missing_ids(_repo):
    try:
        recall_engine.recall("q", tier="T2", scope="project_only")
        check(False, "project_only 缺 project_id 必须抛 ValueError")
    except ValueError:
        pass
    try:
        recall_engine.recall("q", tier="T2", scope="project_only",
                             project_id="")
        check(False, "空 project_id 必须抛 ValueError")
    except ValueError:
        pass
    try:
        recall_engine.recall("q", tier="T2", scope="session_only")
        check(False, "session_only 缺 session_id 必须抛 ValueError")
    except ValueError:
        pass


# ============ 11. project_id schema 校验 ============
@sandboxed
def test_project_id_validation(_repo):
    ok, _ = S.validate_object(pcand("合法分区对象", "p-alpha"))
    check(ok, "合法 project_id 必须通过校验")
    ok_null, _ = S.validate_object(cand("缺失 project_id 的对象"))
    check(ok_null, "缺失 project_id（legacy）必须通过校验")
    bad = cand("非法类型 project_id")
    bad["project_id"] = 123
    ok1, _ = S.validate_object(bad)
    check(not ok1, "非字符串 project_id 必须被拒绝")
    bad2 = cand("空字符串 project_id")
    bad2["project_id"] = "  "
    ok2, _ = S.validate_object(bad2)
    check(not ok2, "空白 project_id 必须被拒绝")


# ============ 12. supersede 继承 project_id ============
@sandboxed
def test_supersede_inherits_project_id(_repo):
    a = put(pcand("项目 A 引擎 UE 5", "p-alpha"))
    c = cand("项目 A 引擎 UE 5.6", scope="project", category="project")
    res = write_engine.perform_write(c, supersede_target=a)
    check(res.decision == "SUPERSEDE_MEMORY", "应触发 SUPERSEDE: %r" % res)
    new_obj = store.load_object(res.memory_id)
    check(new_obj.get("project_id") == "p-alpha",
          "supersede 新对象必须继承 project_id: %r" % new_obj)
    r = recall_engine.recall("引擎", tier="T2", layers=["L3"],
                             scope="project_only", project_id="p-alpha")
    check(ids(r) == [res.memory_id],
          "p-alpha 只看到新版本: %r" % ids(r))
    r2 = recall_engine.recall("引擎", tier="T2", layers=["L3"],
                              scope="project_only", project_id="p-beta")
    check(ids(r2) == [], "p-beta 视图不受影响")


# ============ 13. candidate_lookup 项目分区去重 ============
@sandboxed
def test_candidate_lookup_project_partitioned(_repo):
    a = put(pcand("项目 A 使用 UE 5.6", "p-alpha"))
    b = put(pcand("项目 B 使用 UE 5.6", "p-beta"))
    c = cand("项目 B 使用 UE 5.6", scope="project", category="project",
             project_id="p-beta")
    res = write_engine.perform_write(c)
    check(res.decision == "NO_CHANGE",
          "同分区同内容应 NO_CHANGE: %r" % res)
    check(res.target_id == b, "必须命中 p-beta 对象而非 p-alpha: %r" % res)
    c2 = cand("项目 A 使用 UE 5.6 新版本", scope="project",
              category="project", project_id="p-alpha")
    res2 = write_engine.perform_write(c2)
    check(res2.target_id == a, "p-alpha 候选必须只与 p-alpha 分区去重: %r"
          % res2)


# ============ 14. 新 mode 下 explain 等价 + Trace scope 合同 ============
@sandboxed
def test_explain_equivalence_new_modes(_repo):
    put(pcand("项目 A 预算三万", "p-alpha", category="constraint"))
    put(pcand("项目 B 预算五万", "p-beta", category="constraint"))
    r1 = recall_engine.recall("预算", tier="T2", layers=["L5"],
                              scope="project_only", project_id="p-alpha")
    r2 = recall_engine.recall("预算", tier="T2", layers=["L5"],
                              scope="project_only", project_id="p-alpha",
                              explain=True)
    r3 = recall_engine.recall("预算", tier="T2", layers=["L5"],
                              scope="project_only", project_id="p-alpha",
                              explain=True)
    check(ids(r1) == ids(r2) == ids(r3),
          "explain 开关不得改变新 mode 结果与顺序")
    check("trace" not in r1.to_dict(), "explain=False 无 trace")
    check(r2.trace["scope"] == {"mode": "project_only",
                                "project_id": "p-alpha"},
          "trace scope 须携带真实 mode + project_id: %r" % r2.trace["scope"])
    check(RT.trace_digest(r2.trace) == RT.trace_digest(r3.trace),
          "同输入 trace digest 须稳定")
    sel = r2.trace["selected"]
    check(sel and all(RT.RC_PROJECT_OK in e["reason_codes"] for e in sel),
          "project_only 选中对象须带 PROJECT_OK")
    s_r = recall_engine.recall("预算", tier="T2", layers=["L5"],
                               scope="session_only", session_id="s9",
                               explain=True)
    check(s_r.trace["scope"] == {"mode": "session_only", "project_id": None,
                                 "session_id": "s9"},
          "session_only trace scope 合同: %r" % s_r.trace["scope"])


TESTS = [
    test_project_a_cannot_read_project_b,
    test_project_content_does_not_affect_global_recall,
    test_project_switch_does_not_copy_objects,
    test_session_only_and_temporary_no_long_term_write,
    test_adapter_cannot_bypass_hard_filter,
    test_trace_out_of_scope_only_safe_metadata,
    test_legacy_scope_modes_unchanged,
    test_session_only_visibility,
    test_temporary_mode_zero_reads,
    test_fail_closed_missing_ids,
    test_project_id_validation,
    test_supersede_inherits_project_id,
    test_candidate_lookup_project_partitioned,
    test_explain_equivalence_new_modes,
]


def main():
    failures = 0
    skipped = 0
    for fn in TESTS:
        try:
            fn()
            print("PASS %s" % fn.__name__)
        except Exception as e:  # noqa: BLE001
            failures += 1
            print("FAIL %s: %s" % (fn.__name__, e))
    print("----")
    print("%d test(s), %d failure(s), %d skipped" % (len(TESTS), failures, skipped))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
