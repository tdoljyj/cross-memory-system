# -*- coding: utf-8 -*-
"""Memory Eval Case Schema v1（MIV-001）。

版本化评测用例合同。字段可扩展、不可删除语义。
fixture 只允许使用合成或脱敏内容；case 不得包含秘密。
"""

SCHEMA_VERSION = 1

# 8 类固定类别（与执行计划 §MIV-001 场景最低配额一致）
CATEGORIES = [
    "explicit_preference",
    "implicit_observed",
    "project_scope",
    "negative_no_memory",
    "temporal",
    "conflict_superseded",
    "paraphrase",
    "security_adversarial",
]

# 每类最低配额
CATEGORY_MIN_QUOTA = {
    "explicit_preference": 15,
    "implicit_observed": 15,
    "project_scope": 15,
    "negative_no_memory": 15,
    "temporal": 10,
    "conflict_superseded": 10,
    "paraphrase": 10,
    "security_adversarial": 10,
}

SCOPE_MODES = ["current", "project_only", "global"]

# 可选 critical assertion 枚举（报告分类统计用）
CRITICAL_ASSERTIONS = [
    "no_scope_leak",             # 既有 global/project/session 边界（current-scope，须为 0）
    "project_only_isolation",    # project_id 硬隔离（MIV-006 能力，尚未实现）
    "no_superseded_leak",
    "no_stale_recall",
    "no_fabrication",
    "no_secret_leak",
    "explicit_wins",
    "deterministic_replay",
    "paraphrase_hit_top5",
]

_TIER_VALUES = ["T0", "T1", "T2", "T3", "T4"]


def validate_case(case, case_index=None):
    """校验一个 Eval Case。返回 (ok, errors)。"""
    errors = []
    label = "case[%s]" % case_index if case_index is not None else "case"

    def err(msg):
        errors.append("%s: %s" % (label, msg))

    if not isinstance(case, dict):
        return False, ["%s 必须是 object" % label]

    # case_id
    cid = case.get("case_id")
    if not isinstance(cid, str) or not cid.strip():
        err("case_id 必须为非空字符串")

    # category
    if case.get("category") not in CATEGORIES:
        err("category 不在枚举: %r" % (case.get("category"),))

    # now：必须可解析（UTC 优先）
    now = case.get("now")
    from memory_engine.schema import parse_ts
    if not isinstance(now, str) or parse_ts(now) is None:
        err("now 必须为可解析时间戳: %r" % (now,))

    # agent_id
    if not isinstance(case.get("agent_id"), str) or not case["agent_id"].strip():
        err("agent_id 必须为非空字符串")

    # scope
    scope = case.get("scope")
    if not isinstance(scope, dict):
        err("scope 必须是 object")
    else:
        mode = scope.get("mode")
        if mode not in SCOPE_MODES:
            err("scope.mode 不在枚举: %r" % (mode,))
        pid = scope.get("project_id")
        if pid is not None and not isinstance(pid, str):
            err("scope.project_id 必须为字符串或 null")

    # fixtures
    fixtures = case.get("fixtures")
    if not isinstance(fixtures, list) or not fixtures:
        err("fixtures 必须为非空数组")
    elif not all(isinstance(f, str) for f in fixtures):
        err("fixtures 必须全部为字符串")

    # query
    if not isinstance(case.get("query"), str):
        err("query 必须为字符串")

    # expected / forbidden
    for key in ("expected_relevant_ids", "forbidden_ids"):
        v = case.get(key)
        if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
            err("%s 必须为字符串数组" % key)

    # expected_no_memory
    if not isinstance(case.get("expected_no_memory", False), bool):
        err("expected_no_memory 必须为 bool")

    # critical_assertions
    ca = case.get("critical_assertions", [])
    if not isinstance(ca, list):
        err("critical_assertions 必须为数组")
    else:
        unknown = [c for c in ca if c not in CRITICAL_ASSERTIONS]
        if unknown:
            err("critical_assertions 含未知项: %r" % (unknown,))

    # secret_markers（禁止出现在 case 中）
    sm = case.get("secret_markers", [])
    if not isinstance(sm, list):
        err("secret_markers 必须为数组")

    # 可选 tier（默认 T2）
    tier = case.get("tier", "T2")
    if tier not in _TIER_VALUES:
        err("tier 不在枚举: %r" % (tier,))

    return (len(errors) == 0), errors


def assert_case_has_no_secrets(case):
    """case 文本中不得包含秘密样值（扫描 guards.json 模式）。"""
    from memory_engine import store
    import json as _json
    text = _json.dumps(case, ensure_ascii=False)
    for pat in store.load_secret_patterns():
        import re
        if re.search(pat, text):
            return False
    return True


def scope_to_engine(scope):
    """case scope → v2.0 引擎 scope 参数。

    current      → None（无 scope 过滤，适配器当前上下文）
    project_only → "project"
    global       → "global"
    """
    mode = (scope or {}).get("mode", "current")
    if mode == "project_only":
        return "project"
    if mode == "global":
        return "global"
    return None
