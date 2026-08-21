# -*- coding: utf-8 -*-
"""Canonical Oracle v3（E5-base 实施轮）。

独立实现 oracle-v3-spec.md 的 canonical 口径：

    canonical_survivors(case) =
        oracle_v3(frozen_fixture_metadata(case), frozen_hard_filter_contract)
    eligible_expected(case) = frozen_expected(case) ∩ canonical_survivors(case)

独立性硬约束（oracle-v3-spec §3 + frozen-hard-filter-contract
independence_rule）：
- 本模块不 import / 调用 / 复制 memory_engine 的任何过滤函数
  （_initial_exclusion_reasons / _scope_ok / _category_scope_ok /
  status_exclude_code / find_secret_in_object / is_valid_now 等）
- 输入只有冻结夹具元数据（含 __FAKE_TOKEN__ 替换，物化由调用方完成）
  与冻结合同 JSON 本体；不读取 Runtime Trace / 运行时状态 / 评分结果
- 语义分歧时以钉定源码为准并判合同失效（fail-closed 由调用方处理）
"""

import hashlib
import json
import os
import re
from datetime import datetime, timezone

ORACLE_SCHEMA_VERSION = "r4-gate0-oracle-v3-impl-1"

# ---- 硬过滤 Trace code 全集（A1–A6 + B1–B7；Trace 相等性比较域）----
HARD_FILTER_CODES = frozenset({
    # A1 status
    "STATUS_CANDIDATE", "STATUS_SUPERSEDED", "STATUS_ARCHIVED",
    "STATUS_REJECTED", "STATUS_EXPIRED", "STATUS_DEPRECATED",
    "STATUS_OTHER",
    # A2 scope + category
    "SCOPE_MISMATCH", "PROJECT_MISMATCH", "SESSION_MISMATCH",
    "CATEGORY_MISMATCH",
    # A3 temporal
    "TEMPORAL_EXPIRED", "TEMPORAL_NOT_YET_VALID",
    # A4/A5 selector
    "TAG_MISMATCH", "ENTITY_MISMATCH",
    # A6 light
    "PRIORITY_FILTERED",
    # B1/B3 object-validity
    "INVALID_OBJECT",
    # B2 permission
    "ACCESS_DENIED",
    # B4 temporary
    "TEMPORARY_OBJECT",
    # B5 status（预嵌入过滤可达）
    "STATUS_NOT_RECALLABLE",
    # B6 temporal（预嵌入过滤可达）
    "TEMPORAL_NOT_CURRENT",
    # B7 secret
    "SECRET_DETECTED",
})

# ---- B3 schema 校验枚举（合同 B3 predicate 文本逐条转写的常量）----
_B3_SOURCE_KINDS = {
    "user_explicit", "user_implicit", "observed",
    "ai_inferred", "migration", "system", "unknown",
}
_B3_CATEGORIES = {
    "identity", "preference", "negative_preference", "project", "state",
    "decision", "history", "event", "constraint", "workflow", "toolchain",
    "method", "todo", "other",
}
_B3_PRIORITIES = {"high", "medium", "low"}
_B3_EVIDENCES = {"explicit", "observed", "inferred"}
_B3_RECALL_LAYERS = {"L1", "L2", "L3", "L4", "L5", "L6"}
_ID_PATTERN = re.compile(r"^mem_[0-9a-z]{8,16}$")
_TS_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})?$")


class OracleError(RuntimeError):
    pass


def _parse_ts_contract(value):
    """合同 A3 note 的独立实现：ISO-8601、'Z'→+00:00、naive 按 UTC、
    不可解析按缺失（None）。"""
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _ts_field_ok(value):
    """合同 B3：严格时间戳格式且可解析（allow_null）。"""
    if value is None:
        return True
    if not isinstance(value, str) or not _TS_PATTERN.match(value):
        return False
    return _parse_ts_contract(value) is not None


def _temporal_bounds(fixture):
    temporal = fixture.get("temporal")
    if not isinstance(temporal, dict):
        return None, None
    return (_parse_ts_contract(temporal.get("valid_from")),
            _parse_ts_contract(temporal.get("valid_until")))


class CanonicalOracleV3(object):
    """消费冻结合同 + 冻结夹具元数据的 canonical oracle。"""

    def __init__(self, contract_path, expected_sha256=None):
        with open(contract_path, "rb") as fh:
            raw = fh.read()
        self.contract_bytes_sha256 = hashlib.sha256(raw).hexdigest()
        if expected_sha256 is not None and \
                self.contract_bytes_sha256 != expected_sha256:
            raise OracleError("CONTRACT_DIGEST_MISMATCH")
        contract = json.loads(raw.decode("utf-8"))
        if contract.get("contract_type") != "canonical-hard-filter-contract":
            raise OracleError("CONTRACT_TYPE_MISMATCH")
        if contract.get("status") != "FROZEN":
            raise OracleError("CONTRACT_NOT_FROZEN")
        self.contract = contract
        vocab = contract.get("vocabularies") or {}
        self.recallable_statuses = frozenset(vocab["recallable_statuses"])
        self.history_statuses = frozenset(vocab["history_statuses"])
        self.all_statuses = frozenset(vocab["all_statuses"])
        self.status_exclude_code_map = dict(
            vocab["status_exclude_code_map"])
        self.layer_categories = dict(vocab["layer_categories"])
        self.tier_layers = dict(vocab["tier_layers"])
        self.function_types = frozenset(vocab["function_types"])
        self.object_scopes = frozenset(vocab["object_scopes"])
        self.priorities = frozenset(vocab["priorities"])
        self.secret_patterns = list(vocab["secret_patterns"])
        self._secret_re = [re.compile(p) for p in self.secret_patterns]
        self.contract_sha_of_sha = None  # semantic_source.files 供审计读取

    # ---------- P5：want_categories ----------
    def _want_categories(self, case):
        categories = case.get("categories")
        if categories:
            return list(categories)
        layers = case.get("layers")
        if layers is None:
            layers = self.tier_layers.get(case.get("tier", "T2"), [])
        wanted = []
        for layer in layers:
            if layer in _B3_RECALL_LAYERS:
                wanted.extend(self.layer_categories.get(layer, []))
        return wanted

    # ---------- A2：scope 可见性（合同 scope_visibility_matrix）----------
    def _scope_visible(self, fixture, engine_scope, project_id):
        scope = fixture.get("scope")
        if engine_scope is None:
            return True
        if engine_scope == "project_only":
            if scope == "global":
                return True
            if scope != "project":
                return False
            return fixture.get("project_id") == project_id
        if engine_scope == "session_only":
            if scope == "global":
                return True
            if scope != "session":
                return False
            return (fixture.get("source") or {}).get(
                "session_id") == self._session_id
        if engine_scope == "global":
            return scope == "global"
        return scope in ("global", engine_scope)

    def _scope_code(self, fixture, engine_scope):
        scope = fixture.get("scope")
        if engine_scope == "project_only" and scope == "project":
            return "PROJECT_MISMATCH"
        if engine_scope == "session_only" and scope == "session":
            return "SESSION_MISMATCH"
        return "SCOPE_MISMATCH"

    # ---------- B3：schema 校验（合同 B3 predicate 完整转写）----------
    def _schema_invalid(self, fixture):
        if not isinstance(fixture, dict):
            return True
        if fixture.get("schema_version") != 1:
            return True
        oid = fixture.get("id")
        if not isinstance(oid, str) or not _ID_PATTERN.match(oid):
            return True
        if fixture.get("type") not in self.function_types:
            return True
        if fixture.get("scope") not in self.object_scopes:
            return True
        pid = fixture.get("project_id")
        if pid is not None and (not isinstance(pid, str) or not pid.strip()):
            return True
        if fixture.get("status") not in self.all_statuses:
            return True
        content = fixture.get("content")
        if not isinstance(content, str) or not content.strip():
            return True
        source = fixture.get("source")
        if not isinstance(source, dict):
            return True
        if source.get("kind") not in _B3_SOURCE_KINDS:
            return True
        for key in ("adapter", "session_id"):
            value = source.get(key)
            if value is not None and not isinstance(value, str):
                return True
        for key in ("created_at", "updated_at"):
            if not _ts_field_ok(source.get(key)):
                return True
        created = _parse_ts_contract(source.get("created_at"))
        updated = _parse_ts_contract(source.get("updated_at"))
        if created and updated and updated < created:
            return True
        temporal = fixture.get("temporal")
        if not isinstance(temporal, dict):
            return True
        for key in ("valid_from", "valid_until"):
            if not _ts_field_ok(temporal.get(key)):
                return True
        valid_from, valid_until = _temporal_bounds(fixture)
        if valid_from and valid_until and valid_until < valid_from:
            return True
        relations = fixture.get("relations")
        if not isinstance(relations, dict):
            return True
        for key in ("supersedes", "superseded_by", "contradicts", "related"):
            values = relations.get(key)
            if not isinstance(values, list) or not all(
                    isinstance(v, str) for v in values):
                return True
        classification = fixture.get("classification")
        if not isinstance(classification, dict):
            return True
        memory_layer = classification.get("memory_layer")
        if memory_layer is not None and \
                memory_layer not in self.function_types:
            return True
        if classification.get("category") not in _B3_CATEGORIES:
            return True
        if classification.get("priority") not in _B3_PRIORITIES:
            return True
        recall_layer = classification.get("recall_layer")
        if recall_layer is not None and \
                recall_layer not in _B3_RECALL_LAYERS:
            return True
        provenance = fixture.get("provenance")
        if not isinstance(provenance, dict):
            return True
        if provenance.get("evidence") not in _B3_EVIDENCES:
            return True
        source_ref = provenance.get("source_ref")
        if source_ref is not None and not isinstance(source_ref, str):
            return True
        for key in ("tags", "entities"):
            values = fixture.get(key)
            if values is not None and (
                    not isinstance(values, list) or not all(
                        isinstance(v, str) for v in values)):
                return True
        return False

    # ---------- B7：secret 扫描（合同 B7）----------
    def _secret_hit(self, fixture):
        text = json.dumps(fixture, ensure_ascii=False)
        for pattern in self._secret_re:
            if pattern.search(text):
                return True
        return False

    # ---------- 判定主入口 ----------
    def judge_case(self, case, fixtures):
        """对单个 case 的全部夹具给出 canonical verdict。

        fixtures: {fid: 物化后的夹具 dict（含 __FAKE_TOKEN__ 替换）}
        返回 dict：
          short_circuit: None | 'T0' | 'T4' | 'TEMPORARY' | 'NO_CATEGORIES'
          top_reason_codes: 短路时的顶层 reason codes
          verdicts: {fid: [code, ...]}（空列表 = SURVIVOR）
          survivors: [fid, ...]（ID 升序）
          path_meta: P5/P6/P7/P8 派生参数（审计用）
        """
        tier = (case.get("tier", "T2") or "T2").upper()
        scope_mode = (case.get("scope") or {}).get("mode", "current")
        project_id = (case.get("scope") or {}).get("project_id")
        engine_scope = None
        if scope_mode == "project_only":
            engine_scope = "project_only"
        elif scope_mode == "global":
            engine_scope = "global"
        self._session_id = None  # eval 语料无 session_only（P3 完备性保留）

        # P1/P2/P3：零读取短路（canonical_survivors = 空集）
        if tier == "T0":
            return self._short_circuit("T0", ["T0_ZERO_READ", "NO_MEMORY"])
        if tier == "T4":
            return self._short_circuit("T4", ["T4_IMMEDIATE_WRITE"])
        if engine_scope == "temporary":
            return self._short_circuit(
                "TEMPORARY", ["TEMPORARY_MODE", "NO_MEMORY"])

        # P4：project_only 缺 project_id → 引擎 ValueError（不可达防御）
        if engine_scope == "project_only" and not project_id:
            return {
                "short_circuit": "P4_FAIL_CLOSED",
                "top_reason_codes": ["ENGINE_EXCEPTION_VALUEERROR"],
                "verdicts": {},
                "survivors": [],
                "path_meta": {"engine_exception": True},
            }

        # P5：want_categories
        want_categories = self._want_categories(case)
        if not want_categories:
            return self._short_circuit("NO_CATEGORIES", ["NO_MEMORY"])

        # P6：statuses_admissible
        include_history = bool(case.get("include_history", False))
        admissible = set(self.recallable_statuses)
        if include_history:
            admissible |= set(self.history_statuses)

        # P7：light（被测路径从不显式传 light）
        light = (tier == "T3")
        limit = case.get("limit", 10)
        effective_limit = min(limit, 3) if light else limit

        # P8：boundary_active（E5-base 轮 semantic_mode='test' 恒真）
        boundary_active = (not include_history)

        now = _parse_ts_contract(case.get("now"))
        selector_tags = case.get("tags")
        selector_entities = case.get("entities")
        verdicts = {}
        for fid in case.get("fixtures", []):
            fixture = fixtures.get(fid)
            verdicts[fid] = self._judge_fixture(
                fixture, admissible, include_history, want_categories,
                engine_scope, project_id, light, boundary_active, now,
                selector_tags, selector_entities)

        survivors = sorted(
            fid for fid, codes in verdicts.items() if not codes)
        return {
            "short_circuit": None,
            "top_reason_codes": [],
            "verdicts": verdicts,
            "survivors": survivors,
            "path_meta": {
                "tier": tier,
                "engine_scope": engine_scope,
                "want_categories": list(want_categories),
                "include_history": include_history,
                "light": light,
                "effective_limit": effective_limit,
                "boundary_active": boundary_active,
            },
        }

    def _short_circuit(self, kind, codes):
        return {
            "short_circuit": kind,
            "top_reason_codes": list(codes),
            "verdicts": {},
            "survivors": [],
            "path_meta": {},
        }

    def _judge_fixture(self, fixture, admissible, include_history,
                       want_categories, engine_scope, project_id, light,
                       boundary_active, now, selector_tags,
                       selector_entities):
        """stage_order：A1→A2→A3→A4→A5→A6→B1→…→B7，first-hit-wins。"""
        # B1（合同：JSON 夹具恒 dict，防御性保留）
        if not isinstance(fixture, dict):
            return ["INVALID_OBJECT"]

        # A1 status
        status = fixture.get("status")
        if status not in admissible:
            key = status if status in self.status_exclude_code_map \
                else "*other_or_missing*"
            return [self.status_exclude_code_map[key]]

        # A2 scope + category（可双 code，scope code 在前）
        codes = []
        visible = self._scope_visible(fixture, engine_scope, project_id)
        if not visible:
            codes.append(self._scope_code(fixture, engine_scope))
        category = (fixture.get("classification") or {}).get("category")
        if want_categories and category not in want_categories:
            codes.append("CATEGORY_MISMATCH")
        if codes:
            return codes

        # A3 temporal（含 history bypass）
        valid_from, valid_until = _temporal_bounds(fixture)
        expired_now = bool(valid_until and now is not None and
                           now >= valid_until)
        history_bypass = include_history and (
            status in self.history_statuses or expired_now)
        if not history_bypass:
            temporal_valid = True
            if valid_from and now is not None and now < valid_from:
                temporal_valid = False
            if valid_until and now is not None and now >= valid_until:
                temporal_valid = False
            if not temporal_valid:
                return ["TEMPORAL_EXPIRED" if expired_now
                        else "TEMPORAL_NOT_YET_VALID"]

        # A4 tags selector
        if selector_tags and not (
                set(selector_tags) & set(fixture.get("tags") or [])):
            return ["TAG_MISMATCH"]

        # A5 entities selector
        if selector_entities and not (
                set(selector_entities) & set(fixture.get("entities") or [])):
            return ["ENTITY_MISMATCH"]

        # A6 light
        if light and (fixture.get("classification") or {}).get(
                "priority") != "high":
            return ["PRIORITY_FILTERED"]

        if not boundary_active:
            return []  # SURVIVOR（stage B 不执行：include_history 回退词法）

        # ---- stage B（boundary_active 时逐条执行）----
        # B2 permission（denied 标记；status=='denied' 已被 A1 STATUS_OTHER 排除）
        if fixture.get("denied") is True or fixture.get("status") == "denied":
            return ["ACCESS_DENIED"]
        # B3 schema validity
        if self._schema_invalid(fixture):
            return ["INVALID_OBJECT"]
        # B4 temporary type
        if fixture.get("type") == "temporary":
            return ["TEMPORARY_OBJECT"]
        # B5 status not recallable（无 history 扩展；recall 顺序内不可达，
        # 防御性保留——与合同判定顺序逐字一致）
        if fixture.get("status") not in self.recallable_statuses:
            return ["STATUS_NOT_RECALLABLE"]
        # B6 temporal not current（无 history 例外；recall 顺序内不可达）
        valid_from, valid_until = _temporal_bounds(fixture)
        temporal_valid = True
        if valid_from and now is not None and now < valid_from:
            temporal_valid = False
        if valid_until and now is not None and now >= valid_until:
            temporal_valid = False
        if not temporal_valid:
            return ["TEMPORAL_NOT_CURRENT"]
        # B7 secret（secret-first 不变量：任何命中即排除）
        if self._secret_hit(fixture):
            return ["SECRET_DETECTED"]
        return []  # SURVIVOR

    def judge_all(self, cases, fixtures):
        """批量判定全部 case。"""
        results = {}
        for case in cases:
            results[case["case_id"]] = self.judge_case(case, fixtures)
        return results


def extract_runtime_hard_filter_codes(trace):
    """从被测路径 Trace 的 excluded[] 提取硬过滤 code（比对域）。

    只收集 reason_codes 中归属于 A1–A6/B1–B7 的条目；CONFLICT_LOSER /
    BELOW_LEXICAL_AND_VECTOR_THRESHOLDS / LIMIT_TRUNCATED / 准入码 /
    NO_MEMORY 族顶层码不在比较域（合同 out_of_contract_stages）。
    """
    runtime_hard = {}
    for entry in (trace or {}).get("excluded", []):
        mid = entry.get("memory_id")
        if mid is None:
            continue
        codes = [c for c in (entry.get("reason_codes") or [])
                 if c in HARD_FILTER_CODES]
        if codes:
            runtime_hard[mid] = codes
    return runtime_hard


def compare_traces(oracle_results, case, runtime_hard):
    """逐 fixture 比对 canonical verdict 与 runtime 硬过滤 Trace。

    返回差异列表（空 = 一致）。短路 case 不产生逐对象条目。
    """
    oracle = oracle_results[case["case_id"]]
    verdicts = oracle["verdicts"]
    diffs = []
    for fid, expected_codes in sorted(verdicts.items()):
        got_codes = runtime_hard.get(fid)
        if not expected_codes:
            if got_codes:
                diffs.append({
                    "case_id": case["case_id"], "memory_id": fid,
                    "canonical": [], "runtime": got_codes,
                    "kind": "SURVIVOR_CARRIES_HARD_FILTER_CODE",
                })
        else:
            if got_codes is None:
                diffs.append({
                    "case_id": case["case_id"], "memory_id": fid,
                    "canonical": expected_codes, "runtime": None,
                    "kind": "RUNTIME_MISSING_HARD_FILTER_EXCLUSION",
                })
            elif list(got_codes) != list(expected_codes):
                diffs.append({
                    "case_id": case["case_id"], "memory_id": fid,
                    "canonical": expected_codes, "runtime": list(got_codes),
                    "kind": "TRACE_CODE_MISMATCH",
                })
    extra = set(runtime_hard) - set(verdicts)
    for fid in sorted(extra):
        diffs.append({
            "case_id": case["case_id"], "memory_id": fid,
            "canonical": "NOT_IN_CASE_FIXTURES",
            "runtime": runtime_hard[fid],
            "kind": "RUNTIME_HARD_FILTER_ON_UNKNOWN_OBJECT",
        })
    return diffs
