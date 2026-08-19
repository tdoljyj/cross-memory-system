# -*- coding: utf-8 -*-
"""Recall Trace（MIV-002）：只读观测层，回答「为什么召回」。

合同 v1.0（Gate 1）：
{
  "trace_version": "1.0",
  "query_id": "q-uuid",
  "operation_id": "op-uuid",
  "scope": {"mode": "current", "project_id": null},
  "route": "T2",
  "selected": [
    {"memory_id": "mem-xxx", "version": 3, "source_ref": "...",
     "status": "active", "temporal_state": "current",
     "rank_components": {"deterministic": 1.0, "priority": 3,
                         "evidence": 3, "updated_at": "..."},
     "reason_codes": ["SCOPE_OK", "STATUS_ACTIVE", "QUERY_MATCH"]}
  ],
  "excluded": [{"memory_id": "mem-yyy", "reason_codes": ["SCOPE_MISMATCH"]}],
  "budget": {"estimated_tokens": 312, "truncated": false},
  "degraded": false
}

硬约束：
1. 只读观测——不改变召回集合、顺序、token 截断或任何状态；
2. 默认（explain=False）不生成、不注入模型 prompt；
3. 审计视图只含稳定 ID / 版本 / 来源定位，不含记忆内容与秘密；
4. 每个排除动作必须携带稳定 reason code（禁止只有自由文本）；
5. 完全离线可生成；
6. Trace 构建失败 → degraded=true + TRACE_BUILD_FAILED，绝不静默。
"""

import hashlib
import json
import math
import re
import uuid
from datetime import datetime, timezone

from . import audit as audit_mod
from . import schema as S
from . import store as store_mod

TRACE_VERSION = "1.0"

# ---- token 估算器（固定版本，报告须带名称+版本）----
TOKEN_ESTIMATOR_NAME = "cms-cjk1-ascii4"
TOKEN_ESTIMATOR_VERSION = "1.0"


def estimator_ref():
    return {"name": TOKEN_ESTIMATOR_NAME, "version": TOKEN_ESTIMATOR_VERSION}


# ---- 稳定 reason code（集中定义，禁止自由文本替代）----
# 选中类
RC_SCOPE_OK = "SCOPE_OK"
RC_PROJECT_OK = "PROJECT_OK"          # MIV-006：project_only 命中本分区
RC_SESSION_OK = "SESSION_OK"          # MIV-006：session_only 命中本会话
RC_STATUS_ACTIVE = "STATUS_ACTIVE"
RC_STATUS_REINFORCED = "STATUS_REINFORCED"
RC_HISTORY_ALLOWED = "HISTORY_ALLOWED"
RC_TEMPORAL_CURRENT = "TEMPORAL_CURRENT"
RC_TEMPORAL_PERMANENT = "TEMPORAL_PERMANENT"
RC_CATEGORY_MATCH = "CATEGORY_MATCH"
RC_TAG_MATCH = "TAG_MATCH"
RC_ENTITY_MATCH = "ENTITY_MATCH"
RC_QUERY_MATCH = "QUERY_MATCH"
RC_CONFLICT_WINNER = "CONFLICT_WINNER"
RC_LIMIT_WITHIN = "LIMIT_WITHIN"

# 排除类
RC_SCOPE_MISMATCH = "SCOPE_MISMATCH"
RC_PROJECT_MISMATCH = "PROJECT_MISMATCH"  # MIV-006：project_only 下 project_id 不同
RC_SESSION_MISMATCH = "SESSION_MISMATCH"  # MIV-006：session_only 下 session_id 不同
RC_PERMISSION_DENIED = "PERMISSION_DENIED"  # 预留：scope 是引擎授权边界
RC_STATUS_CANDIDATE = "STATUS_CANDIDATE"
RC_STATUS_SUPERSEDED = "STATUS_SUPERSEDED"
RC_STATUS_ARCHIVED = "STATUS_ARCHIVED"
RC_STATUS_REJECTED = "STATUS_REJECTED"
RC_STATUS_EXPIRED = "STATUS_EXPIRED"
RC_STATUS_DEPRECATED = "STATUS_DEPRECATED"
RC_STATUS_OTHER = "STATUS_OTHER"
RC_TEMPORAL_NOT_YET_VALID = "TEMPORAL_NOT_YET_VALID"
RC_TEMPORAL_EXPIRED = "TEMPORAL_EXPIRED"
RC_CATEGORY_MISMATCH = "CATEGORY_MISMATCH"
RC_TAG_MISMATCH = "TAG_MISMATCH"
RC_ENTITY_MISMATCH = "ENTITY_MISMATCH"
RC_PRIORITY_FILTERED = "PRIORITY_FILTERED"
RC_CONFLICT_LOSER = "CONFLICT_LOSER"
RC_LIMIT_TRUNCATED = "LIMIT_TRUNCATED"
RC_LOAD_LIMIT_TRUNCATED = "LOAD_LIMIT_TRUNCATED"

# 全局
RC_NO_MEMORY = "NO_MEMORY"
RC_T0_ZERO_READ = "T0_ZERO_READ"
RC_T4_IMMEDIATE_WRITE = "T4_IMMEDIATE_WRITE"
RC_TEMPORARY_MODE = "TEMPORARY_MODE"  # MIV-006：temporary 查询零长期读取
RC_TRACE_BUILD_FAILED = "TRACE_BUILD_FAILED"

# 状态 → 排除 reason code（status 过滤第一道）
_STATUS_EXCLUDE_CODE = {
    "candidate": RC_STATUS_CANDIDATE,
    "superseded": RC_STATUS_SUPERSEDED,
    "archived": RC_STATUS_ARCHIVED,
    "rejected": RC_STATUS_REJECTED,
    "expired": RC_STATUS_EXPIRED,
    "deprecated": RC_STATUS_DEPRECATED,
}

# ---- 基础工具 ----
_CJK_RE = re.compile(
    r"[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]")
_WORD_RE = re.compile(r"[A-Za-z0-9_]+")


def estimate_tokens(text):
    """固定估算器：CJK/全角字符 = 1 token；ASCII 字母数字串每 4 字符 ≈ 1 token。

    报告引用时带 estimator_ref()。
    """
    if not text:
        return 0
    cjk = len(_CJK_RE.findall(text))
    ascii_chars = sum(len(m) for m in _WORD_RE.findall(text))
    return cjk + math.ceil(ascii_chars / 4)


def new_query_id():
    return "q-" + uuid.uuid4().hex


def new_operation_id():
    return "op-" + uuid.uuid4().hex


def _redact(text):
    """轻量脱敏（复用 guards.json 秘密模式）。不泄漏令牌样值。"""
    if not text:
        return text
    try:
        pats = store_mod.load_secret_patterns()
    except Exception:
        pats = []
    out = text
    for p in pats:
        try:
            out = re.sub(p, "***", out)
        except re.error:
            continue
    return out


def status_exclude_code(status):
    """status 过滤排除时的稳定 reason code（未知状态 → STATUS_OTHER）。"""
    return _STATUS_EXCLUDE_CODE.get(status, RC_STATUS_OTHER)


def source_ref_of(obj):
    """审计视图来源定位：provenance.source_ref（脱敏）→ 对象文件路径。

    绝不复制记忆内容；不虚构来源。
    """
    prov = (obj or {}).get("provenance") or {}
    ref = prov.get("source_ref")
    if isinstance(ref, str) and ref.strip():
        return _redact(ref.strip())
    oid = (obj or {}).get("id")
    if oid:
        return "memory/objects/" + str(oid) + ".json"
    return None


def temporal_state(obj, when):
    """对象时间状态：current / past / future / permanent / unknown。

    只读推导，不修改对象。
    """
    temporal = (obj or {}).get("temporal") or {}
    vf = S.parse_ts(temporal.get("valid_from"))
    vu = S.parse_ts(temporal.get("valid_until"))
    has_bound = bool(vf or vu)
    if not has_bound:
        return "permanent"
    if vf is None and vu is None:
        return "unknown"
    if vu and when >= vu:
        return "past"
    if vf and when < vf:
        return "future"
    return "current"


def _audit_version_map(oids):
    """审计条目数 → 对象版本（无审计条目 = 1）。只读。"""
    version = {oid: 1 for oid in oids}
    try:
        for entry in audit_mod.read_all():
            mid = entry.get("memory_id")
            if mid in version:
                version[mid] = version.get(mid, 0) + 1
    except Exception:
        pass
    return version


def trace_digest(trace):
    """确定性回放哈希：排除 query_id / operation_id 后稳定。

    用于「同输入重复运行 Trace 哈希一致」验收与 Eval 回放校验。
    """
    if not isinstance(trace, dict):
        return None
    d = json.loads(json.dumps(trace, ensure_ascii=False, sort_keys=True))
    d.pop("query_id", None)
    d.pop("operation_id", None)
    return hashlib.sha256(
        json.dumps(d, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def packed_token_estimate(markdown_plan, objects, constraints):
    """召回上下文打包 token 估算（markdown 计划 + 对象内容 + 约束）。"""
    parts = []
    for entry in markdown_plan or []:
        parts.append("## %s (%s)" % (
            ", ".join(entry.get("sections") or []), entry.get("file") or ""))
    for o in objects or []:
        parts.append(o.get("content") or "")
        tags = o.get("tags") or []
        if tags:
            parts.append("tags:" + ",".join(tags))
    for c in constraints or []:
        parts.append(c.get("content") or "")
    return estimate_tokens("\n".join(parts))


class TraceRecorder(object):
    """只读观测记录器：recall() 在 explain=True 时创建。

    记录动作全部为追加；不参与任何过滤/排序决策。
    """

    def __init__(self, query, tier, layers, scope, valid_at,
                 include_history=False, limit=10, project_id=None,
                 session_id=None):
        self.trace_version = TRACE_VERSION
        self.query_id = new_query_id()
        self.operation_id = new_operation_id()
        # MIV-006：scope 输出真实 mode + project_id；session_id 仅非空时输出
        # （legacy 调用两者为空 → 与 v1.0 输出字节一致）
        self.scope = {"mode": scope or "current", "project_id": project_id}
        if session_id:
            self.scope["session_id"] = session_id
        self.project_id = project_id
        self.session_id = session_id
        self.route = tier or "T0"
        self.valid_at = valid_at or datetime.now(timezone.utc)
        self.include_history = include_history
        self.limit = limit
        self.selected_log = []       # (obj, score, rank_key)
        self.excluded = []           # (oid, [codes])
        self.degraded = False
        self.build_error = None
        self.load_truncated = False

    # ---- 记录（只追加）----
    def exclude(self, oid, *codes):
        if oid is None:
            return
        self.excluded.append((str(oid), [c for c in codes if c]))

    def record_candidate(self, obj, score, rank_key):
        self.selected_log.append((obj, score, rank_key))

    def mark_load_truncated(self):
        self.load_truncated = True

    def mark_degraded(self, error):
        self.degraded = True
        self.build_error = (str(error)[:200] if error else
                            RC_TRACE_BUILD_FAILED)

    # ---- finalize ----
    def finalize(self, result_objects, survivor_count, losers,
                 markdown_plan=None, constraints=None):
        """把记录渲染为合同 JSON。失败不抛——标记 degraded。"""
        try:
            return self._finalize_inner(
                result_objects, survivor_count, losers,
                markdown_plan, constraints)
        except Exception as e:  # noqa: BLE001 —— trace 失败必须显式降级
            self.mark_degraded(e)
            return {
                "trace_version": TRACE_VERSION,
                "query_id": self.query_id,
                "operation_id": self.operation_id,
                "scope": dict(self.scope),
                "route": self.route,
                "selected": [],
                "excluded": [
                    {"memory_id": oid, "reason_codes": codes}
                    for oid, codes in self.excluded
                ],
                "budget": {"estimated_tokens": 0, "truncated": False},
                "degraded": True,
                "build_error": self.build_error,
                "token_estimator": estimator_ref(),
            }

    def _finalize_inner(self, result_objects, survivor_count, losers,
                        markdown_plan, constraints):
        rank_by_id = {}
        for obj, score, rank_key in self.selected_log:
            oid = (obj or {}).get("id")
            if oid:
                rank_by_id[oid] = (score, rank_key)

        sel_ids = [o["id"] for o in result_objects]
        versions = _audit_version_map(sel_ids) if sel_ids else {}

        selected = []
        for o in result_objects:
            oid = o["id"]
            score, rank_key = rank_by_id.get(oid, (0.0, None))
            codes = [RC_SCOPE_OK]
            if self.project_id:
                codes.append(RC_PROJECT_OK)
            if self.session_id:
                codes.append(RC_SESSION_OK)
            st = o.get("status")
            if st == "reinforced":
                codes.append(RC_STATUS_REINFORCED)
            else:
                codes.append(RC_STATUS_ACTIVE)
            if self.include_history:
                codes.append(RC_HISTORY_ALLOWED)
            ts = temporal_state(o, self.valid_at)
            if ts == "permanent":
                codes.append(RC_TEMPORAL_PERMANENT)
            elif ts == "current":
                codes.append(RC_TEMPORAL_CURRENT)
            if score > 0:
                codes.append(RC_QUERY_MATCH)
            codes.append(RC_CONFLICT_WINNER)
            codes.append(RC_LIMIT_WITHIN)
            cls = o.get("classification") or {}
            prov = o.get("provenance") or {}
            src = o.get("source") or {}
            components = {
                "deterministic": round(float(score), 6),
                "priority": S.PRIORITY_WEIGHT.get(cls.get("priority"), 0),
                "evidence": S.EVIDENCE_PRIORITY.get(prov.get("evidence"), 0),
                "updated_at": src.get("updated_at") or "",
            }
            if rank_key is not None:
                components["rank_key_prefix"] = [str(x) for x in rank_key[:3]]
            selected.append({
                "memory_id": oid,
                "version": versions.get(oid, 1),
                "source_ref": source_ref_of(o),
                "status": o.get("status"),
                "temporal_state": ts,
                "rank_components": components,
                "reason_codes": codes,
            })

        excluded = [
            {"memory_id": oid, "reason_codes": codes}
            for oid, codes in self.excluded
        ]

        truncated = (survivor_count > self.limit) or self.load_truncated
        budget_tokens = packed_token_estimate(
            markdown_plan or [], result_objects, constraints or [])

        return {
            "trace_version": TRACE_VERSION,
            "query_id": self.query_id,
            "operation_id": self.operation_id,
            "scope": dict(self.scope),
            "route": self.route,
            "selected": selected,
            "excluded": excluded,
            "budget": {
                "estimated_tokens": budget_tokens,
                "truncated": truncated,
            },
            "degraded": self.degraded,
            "token_estimator": estimator_ref(),
        }


def build_empty_trace(query, tier, scope, valid_at, reason_codes,
                      degraded=False, build_error=None, project_id=None,
                      session_id=None):
    """无对象召回路径（T0 / T4 / temporary / 无类别）的合法空 Trace。

    不得触发任何记忆文件读取。MIV-006：project_id/session_id 可选透传。
    """
    rec = TraceRecorder(query or "", tier or "T0", [], scope, valid_at,
                        project_id=project_id, session_id=session_id)
    if degraded:
        rec.mark_degraded(build_error)
    d = rec.finalize([], 0, set())
    d["reason_codes"] = [c for c in reason_codes if c]
    return d
