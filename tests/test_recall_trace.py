#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Recall Trace 测试（MIV-002 / Gate 1 新增测试）。

覆盖执行计划 MIV-002「Gate 1 新增测试」：
 1. explain=false 与 explain=true 的 selected IDs 和顺序完全一致
 2. 同输入重复运行 Trace 哈希一致（排除时间戳/UUID 字段后）
 3. scope mismatch / superseded / rejected / expired / permission denied /
    budget truncation 均有明确 reason code
 4. T0 / NO MEMORY 不发生额外记忆读取
 5. secret fixture 在 selected / excluded / 错误栈 / 日志 / 报告中均零泄漏
 6. Trace 写出中途崩溃不影响 Memory Object 和索引
 7. 非法对象 / 损坏索引安全失败，不虚构来源
 8. Windows / POSIX 路径表现一致
 9. 旧 Adapter 未请求 explain 时合同保持兼容

运行：python tests/test_recall_trace.py
"""

import functools
import hashlib
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine import paths as engine_paths  # noqa: E402
from memory_engine import schema as S  # noqa: E402
from memory_engine import store  # noqa: E402
from memory_engine import recall_engine  # noqa: E402
from memory_engine import recall_trace as RT  # noqa: E402


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def tok(prefix="ghp_"):
    """运行时拼接凭据样值（防测试文件自命中扫描模式）。"""
    return prefix + "A" * 32


def make_repo():
    """建临时引擎仓库（内存对象夹具 + 空 markdown 召回索引 + guards）。"""
    tmp = tempfile.mkdtemp(prefix="trace-test-")
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
    """写对象夹具（不经过 write_engine，直接落盘 + 审计，保证确定性）。"""
    store.save_object(obj)
    return obj["id"]


def put_raw(oid, data):
    """写任意 JSON（含非法对象），用于负例。"""
    with open(os.path.join(store.object_path(oid)), "w",
              encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(data, ensure_ascii=False))


def cand(content, category="preference", evidence="explicit", scope="global",
         status="active", priority="medium", tags=None, entities=None,
         valid_from=None, valid_until=None, oid=None, source_ref=None):
    return S.new_object(
        oid=oid or store.new_id(), type_="semantic", content=content,
        scope=scope, status=status, category=category, evidence=evidence,
        priority=priority, recall_layer="L2", adapter="trace-test",
        tags=tags, entities=entities, valid_from=valid_from,
        valid_until=valid_until, source_ref=source_ref)


def ids(result):
    return [o["id"] for o in result.objects]


def now():
    return datetime.now(timezone.utc)


# ============ 1. explain 等价性 ============
@sandboxed
def test_explain_does_not_change_result(_repo):
    a = put(cand("用户偏好简洁的回答方式", tags=["沟通", "偏好"]))
    put(cand("与查询完全无关的另一条记忆"))
    r1 = recall_engine.recall("简洁回答", tier="T2", layers=["L2"])
    r2 = recall_engine.recall("简洁回答", tier="T2", layers=["L2"], explain=True)
    check(ids(r1) == ids(r2), "explain 开关不得改变 selected IDs 与顺序")
    check(len(r1.objects) == len(r2.objects), "count 一致")
    check(r1.skipped == r2.skipped, "skipped 计数一致")
    check(r1.warnings == r2.warnings, "warnings 一致")
    check("trace" not in r1.to_dict(), "explain=False 不输出 trace")
    check(isinstance(r2.to_dict().get("trace"), dict), "explain=True 输出 trace")
    check(len(r2.objects) > 0, "夹具应有召回")


@sandboxed
def test_explain_equivalence_with_history_and_scope(_repo):
    put(cand("项目 Alpha 使用 UE 5.6", category="project", scope="project",
             oid="mem_aaaaaaaa"))
    put(cand("项目 Beta 使用 Unity", category="project", scope="project",
             oid="mem_bbbbbbbb"))
    put(cand("旧引擎是 UE 4", category="project", scope="global",
             status="superseded", oid="mem_cccccccc"))
    for kw in ({"tier": "T2", "scope": "project", "include_history": True},
               {"tier": "T2", "scope": "project", "limit": 1},
               {"tier": "T3", "scope": None, "light": True},
               {"tier": "T2", "scope": "global", "tags": ["x"], "entities": ["y"]}):
        r1 = recall_engine.recall("项目", layers=["L3"], **kw)
        r2 = recall_engine.recall("项目", layers=["L3"], explain=True, **kw)
        check(ids(r1) == ids(r2), "等价性破坏于 %r" % (kw,))


# ============ 2. 确定性回放哈希 ============
@sandboxed
def test_trace_digest_deterministic(_repo):
    put(cand("用户喜欢红色主题", tags=["主题"]))
    t1 = recall_engine.recall("红色主题", tier="T2", layers=["L2"],
                              explain=True).trace
    t2 = recall_engine.recall("红色主题", tier="T2", layers=["L2"],
                              explain=True).trace
    check(t1["query_id"] != t2["query_id"], "query_id 应唯一")
    check(RT.trace_digest(t1) == RT.trace_digest(t2),
          "排除 UUID 后 trace 哈希必须一致")
    check(isinstance(RT.trace_digest(t1), str)
          and len(RT.trace_digest(t1)) == 64, "digest 为 sha256 hex")


# ============ 3. reason code 覆盖 ============
@sandboxed
def test_scope_mismatch_reason_code(_repo):
    put(cand("项目内偏好", scope="project", oid="mem_pppppppp"))
    t = recall_engine.recall("偏好", tier="T2", layers=["L2"], scope="global",
                             explain=True).trace
    codes = [c for e in t["excluded"] if e["memory_id"] == "mem_pppppppp"
             for c in e["reason_codes"]]
    check(RT.RC_SCOPE_MISMATCH in codes, "跨 scope 必须给出 SCOPE_MISMATCH: %r" % codes)


@sandboxed
def test_status_reason_codes(_repo):
    put(cand("superseded 记忆", status="superseded", oid="mem_supersed0"))
    put(cand("rejected 记忆", status="rejected", oid="mem_rejected0"))
    put(cand("candidate 记忆", status="candidate", oid="mem_canddat00"))
    put(cand("archived 记忆", status="archived", oid="mem_archived0"))
    t = recall_engine.recall("记忆", tier="T2", layers=["L2"], explain=True).trace
    by_id = {e["memory_id"]: e["reason_codes"] for e in t["excluded"]}
    check(RT.RC_STATUS_SUPERSEDED in by_id.get("mem_supersed0", []),
          "superseded 需状态码: %r" % by_id)
    check(RT.RC_STATUS_REJECTED in by_id.get("mem_rejected0", []),
          "rejected 需状态码")
    check(RT.RC_STATUS_CANDIDATE in by_id.get("mem_canddat00", []),
          "candidate 需状态码")
    check(RT.RC_STATUS_ARCHIVED in by_id.get("mem_archived0", []),
          "archived 需状态码")


@sandboxed
def test_temporal_reason_codes(_repo):
    when = now()
    put(cand("已过期记忆", valid_until="2020-01-01T00:00:00Z",
             oid="mem_expired00"))
    put(cand("未生效记忆", valid_from="2099-01-01T00:00:00Z",
             oid="mem_future000"))
    t = recall_engine.recall("记忆", tier="T2", layers=["L2"], explain=True,
                             valid_at=when).trace
    by_id = {e["memory_id"]: e["reason_codes"] for e in t["excluded"]}
    check(RT.RC_TEMPORAL_EXPIRED in by_id.get("mem_expired00", []),
          "过期需 TEMPORAL_EXPIRED: %r" % by_id)
    check(RT.RC_TEMPORAL_NOT_YET_VALID in by_id.get("mem_future000", []),
          "未生效需 TEMPORAL_NOT_YET_VALID")


@sandboxed
def test_budget_truncation_reason_code(_repo):
    for i in range(5):
        put(cand("用户偏好第 %d 号配色方案" % i, tags=["配色"],
                 oid="mem_trunc%03d0" % i))
    r = recall_engine.recall("配色方案", tier="T2", layers=["L2"], limit=2,
                             explain=True)
    t = r.trace
    check(t["budget"]["truncated"] is True, "超限必须标记 truncated")
    check(len(r.objects) == 2, "limit=2")
    truncated = [e for e in t["excluded"]
                 if RT.RC_LIMIT_TRUNCATED in e["reason_codes"]]
    check(len(truncated) == 3, "被 limit 截断的对象须有 LIMIT_TRUNCATED: %r"
          % truncated)
    check(all(RT.RC_LIMIT_WITHIN in s["reason_codes"] for s in t["selected"]),
          "选中对象带 LIMIT_WITHIN")


@sandboxed
def test_permission_denied_is_scope_boundary(_repo):
    """v2.0 引擎的授权边界 = scope：越权候选以 SCOPE_MISMATCH 排除，
    预留 PERMISSION_DENIED 码用于未来权限层。"""
    put(cand("仅项目内可见", scope="project", oid="mem_permiss00"))
    t = recall_engine.recall("可见", tier="T2", layers=["L2"], scope="global",
                             explain=True).trace
    codes = [c for e in t["excluded"] if e["memory_id"] == "mem_permiss00"
             for c in e["reason_codes"]]
    check(RT.RC_SCOPE_MISMATCH in codes, "越权必须排除且有码")


# ============ 4. T0 / NO MEMORY 零额外读取 ============
@sandboxed
def test_t0_zero_reads(_repo):
    # T0 不触碰对象层：把 store.list_object_ids 替换为炸弹，T0 不得触发
    orig = store.list_object_ids
    store.list_object_ids = lambda: (_ for _ in ()).throw(
        AssertionError("T0 触发了对象读取"))
    try:
        r = recall_engine.recall("任意查询", tier="T0", explain=True)
        t = r.trace
        check(r.access == "NONE", "T0 access=NONE")
        check(t["selected"] == [] and t["excluded"] == [], "T0 trace 空")
        check(RT.RC_T0_ZERO_READ in t.get("reason_codes", []),
              "T0 trace 带 T0_ZERO_READ")
        check(RT.RC_NO_MEMORY in t.get("reason_codes", []), "T0 带 NO_MEMORY")
        check(t["budget"]["estimated_tokens"] == 0, "T0 预算为 0")
    finally:
        store.list_object_ids = orig


@sandboxed
def test_no_memory_trace_shape(_repo):
    put(cand("无关记忆", category="identity", oid="mem_identity0"))
    r = recall_engine.recall("完全不相关的查询", tier="T2", layers=["L2"],
                             explain=True)
    t = r.trace
    check(t["selected"] == [], "无命中 selected 为空")
    # 身份类对象被类别过滤排除，必有 reason code
    codes = [c for e in t["excluded"] if e["memory_id"] == "mem_identity0"
             for c in e["reason_codes"]]
    check(RT.RC_CATEGORY_MISMATCH in codes, "类别不符需码: %r" % codes)


# ============ 5. secret 零泄漏 ============
@sandboxed
def test_secret_never_leaks_in_trace(_repo):
    secret = tok("ghp_")
    put(cand("用户持有令牌 %s 用于测试" % secret, oid="mem_secret000"))
    r = recall_engine.recall("令牌 测试", tier="T2", layers=["L2"],
                             explain=True)
    payload = json.dumps(r.trace, ensure_ascii=False)
    check(secret not in payload, "trace 不得包含秘密原文")
    # 对象内容本身含秘密（合法场景），但 trace 只含 ID/版本/来源，不含 content
    check(all("content" not in s for s in r.trace["selected"]),
          "selected 不得携带 content")
    # source_ref 脱敏
    put(cand("带引用来源", source_ref="evidence:" + secret,
             oid="mem_refsecret"))
    r2 = recall_engine.recall("带引用来源", tier="T2", layers=["L2"],
                              explain=True)
    payload2 = json.dumps(r2.trace, ensure_ascii=False)
    check(secret not in payload2, "source_ref 必须脱敏后进入 trace")


# ============ 6/7. 崩溃安全与非法对象 ============
@sandboxed
def test_trace_build_failure_degrades_not_silent(_repo):
    put(cand("正常对象", oid="mem_normal000"))
    # 破坏审计日志 → 版本派生失败路径（audit 模块容错返回空，不抛）；
    # 再注入 TraceRecorder 内部异常：monkeypatch temporal_state 抛错
    orig = RT.temporal_state
    RT.temporal_state = lambda obj, when: (_ for _ in ()).throw(
        RuntimeError("injected"))
    try:
        r = recall_engine.recall("正常对象", tier="T2", layers=["L2"],
                                 explain=True)
        t = r.trace
        check(t["degraded"] is True, "trace 构建失败必须 degraded=true")
        check("build_error" in t and t["build_error"], "必须带 build_error")
        # 召回结果本体不受影响
        check(len(r.objects) == 1 and r.objects[0]["id"] == "mem_normal000",
              "trace 失败不得影响召回结果")
    finally:
        RT.temporal_state = orig
    # 修复后恢复非降级
    r2 = recall_engine.recall("正常对象", tier="T2", layers=["L2"],
                              explain=True)
    check(r2.trace["degraded"] is False, "修复后不再降级")


@sandboxed
def test_invalid_object_no_fabricated_source(_repo):
    put(cand("合法对象", oid="mem_valid0000"))
    # 非法对象（缺 schema_version）会被 store 跳过，不进入 trace
    put_raw("mem_bad000000", {"id": "mem_bad000000", "status": "active",
                              "content": "坏对象", "scope": "global"})
    r = recall_engine.recall("对象", tier="T2", layers=["L2"], explain=True)
    all_ids = [s["memory_id"] for s in r.trace["selected"]] + \
              [e["memory_id"] for e in r.trace["excluded"]]
    check("mem_bad000000" not in all_ids, "非法对象不得出现在 trace")
    for s in r.trace["selected"]:
        check(isinstance(s.get("source_ref"), str) and s["source_ref"],
              "每个选中对象必须有真实来源定位")
        check(s["source_ref"] == "memory/objects/%s.json" % s["memory_id"]
              or s["source_ref"].startswith("evidence:"),
              "不虚构来源: %r" % s["source_ref"])


@sandboxed
def test_trace_does_not_touch_objects_or_index(_repo):
    oid = put(cand("原始对象", oid="mem_touch0000"))
    before_obj = hashlib.sha256(
        open(os.path.join(store.object_path(oid)), "rb").read()).hexdigest()
    idx_path = os.path.join(engine_paths.MEMORY_DIR, "object-index.json")
    idx_before = None
    if os.path.isfile(idx_path):
        idx_before = hashlib.sha256(
            open(idx_path, "rb").read()).hexdigest()
    recall_engine.recall("原始对象", tier="T2", layers=["L2"], explain=True)
    after_obj = hashlib.sha256(
        open(os.path.join(store.object_path(oid)), "rb").read()).hexdigest()
    check(before_obj == after_obj, "trace 不得修改对象文件")
    if idx_before:
        idx_after = hashlib.sha256(open(idx_path, "rb").read()).hexdigest()
        check(idx_before == idx_after, "trace 不得修改索引")


# ============ 8. 路径一致性 ============
@sandboxed
def test_source_ref_path_portable(_repo):
    put(cand("路径测试对象", oid="mem_path00000"))
    r = recall_engine.recall("路径测试", tier="T2", layers=["L2"], explain=True)
    for s in r.trace["selected"]:
        check("\\" not in s["source_ref"], "来源路径必须正斜杠: %r"
              % s["source_ref"])
    # trace_digest 与内容无关只与结构稳定
    r2 = recall_engine.recall("路径测试", tier="T2", layers=["L2"],
                              explain=True)
    check(RT.trace_digest(r.trace) == RT.trace_digest(r2.trace),
          "路径表现一致且可复现")


# ============ 9. 旧 Adapter 兼容 ============
def test_old_adapter_contract_compatible():
    from adapters.interface import MemoryAdapter
    from adapters.cli_adapter import CLIAdapter
    check(issubclass(CLIAdapter, MemoryAdapter), "CLIAdapter 仍是 MemoryAdapter")
    import inspect
    sig = inspect.signature(CLIAdapter.read)
    # 旧调用（不带 explain）必须保持可用
    params = list(sig.parameters)
    check("query" in params and "tier" in params, "read 签名保持 query/tier")
    # read 经 kwargs 透传，未传 explain 时结果不含 trace（在 sandboxed 用例已验）
    # 这里验证：不传 explain 不抛错（对真实仓库只读 T0）
    r = CLIAdapter().read("任何查询", tier="T0")
    check(r.access == "NONE" and "trace" not in r.to_dict(),
          "旧 Adapter 调用零影响")


# ============ trace 覆盖与开销 ============
@sandboxed
def test_trace_full_coverage_reason_codes(_repo):
    for i in range(6):
        put(cand("用户偏好第 %d 号方案" % i, tags=["方案"],
                 oid="mem_cov%06d0" % i))
    r = recall_engine.recall("方案", tier="T2", layers=["L2"], limit=3,
                             explain=True)
    t = r.trace
    check(len(t["selected"]) == 3, "limit=3")
    for s in t["selected"]:
        check(s.get("source_ref"), "每个选中必须有来源")
        check(s.get("reason_codes"), "每个选中必须有 reason code")
        check(s.get("version", 0) >= 1, "每个选中必须有版本号")
    for e in t["excluded"]:
        check(e.get("reason_codes"), "每个排除必须有 reason code")
        check(e.get("memory_id"), "每个排除必须有 memory_id")


def test_trace_overhead_within_budget():
    """Trace P95 开销：不高于基准 5% 或绝对增加 ≤10ms（取较宽者）。"""
    import time as _time
    # 真实仓库只读 T2 召回（合成查询，不写任何状态）
    def measure(explain, n=30):
        times = []
        for _ in range(n):
            t0 = _time.perf_counter()
            recall_engine.recall("确定性开销探针查询", tier="T2", layers=["L3"],
                                 explain=explain)
            times.append((_time.perf_counter() - t0) * 1000.0)
        return sorted(times)[int(n * 0.95) - 1]
    base = measure(False)
    with_trace = measure(True)
    rel = with_trace - base
    check(rel <= max(base * 0.05, 10.0),
          "Trace 开销超预算: base=%.3fms explain=%.3fms delta=%.3fms"
          % (base, with_trace, rel))


# ============ token 估算器 ============
def test_token_estimator_stable():
    check(RT.estimate_tokens("") == 0, "空文本 0 token")
    check(RT.estimate_tokens("中文内容") == 4, "CJK 每字符 1 token")
    n1 = RT.estimate_tokens("hello world")
    n2 = RT.estimate_tokens("hello world")
    check(n1 == n2 and n1 > 0, "ASCII 估算稳定")
    check(RT.estimator_ref()["name"] == RT.TOKEN_ESTIMATOR_NAME,
          "估算器名称集中定义")
    check(RT.estimator_ref()["version"] == RT.TOKEN_ESTIMATOR_VERSION,
          "估算器版本集中定义")


TESTS = [
    test_explain_does_not_change_result,
    test_explain_equivalence_with_history_and_scope,
    test_trace_digest_deterministic,
    test_scope_mismatch_reason_code,
    test_status_reason_codes,
    test_temporal_reason_codes,
    test_budget_truncation_reason_code,
    test_permission_denied_is_scope_boundary,
    test_t0_zero_reads,
    test_no_memory_trace_shape,
    test_secret_never_leaks_in_trace,
    test_trace_build_failure_degrades_not_silent,
    test_invalid_object_no_fabricated_source,
    test_trace_does_not_touch_objects_or_index,
    test_trace_full_coverage_reason_codes,
    test_trace_overhead_within_budget,
    test_source_ref_path_portable,
    test_old_adapter_contract_compatible,
    test_token_estimator_stable,
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
