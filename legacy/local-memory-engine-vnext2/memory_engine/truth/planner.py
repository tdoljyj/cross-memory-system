# -*- coding: utf-8 -*-
"""R3-T01 Truth Requirement Planner（ADR-R3-002 §1/§2）。

职责：
- 从请求推导需要的 claim types；
- 为每个 claim type 给出事实类别（stable/historical/current/mixed）与来源优先级；
- 保守升级：默认全部按 current 现场核验；只有显式历史引用（HISTORICAL_STATUS、
  VALIDATION_DECISION、TEST_RESULT 等 mixed/historical 类）才允许引用历史来源；
- 脱敏 Trace：记录计划推导过程，脱敏路径/token/凭据。
"""

from . import schema


class TruthPlanner(object):
    """把"需要回答的问题"规划为带类别与来源约束的 claim 清单。"""

    def __init__(self):
        self._default_kind = dict(schema.DEFAULT_FACT_KIND)

    # ---- 规划 ----
    def plan(self, claim_types, mode="verify", allow_historical=False):
        """返回规划结果 list[dict]。

        每项：
          claim_type, kind, source, allow_unverified_fallback
        mode: "verify"（全部现场核验）/ "verify_or_record"
        allow_historical: 是否允许 mixed/historical 类引用历史 receipt（默认 False，
                          即保守：一律现场重取）。
        """
        out = []
        for ct in claim_types:
            if ct not in schema.CLAIM_TYPES:
                raise ValueError("unknown claim type: %s" % ct)
            kind = self._default_kind[ct]
            # 来源优先级：current → live；historical → receipt/report（仍须锚定 HEAD）
            if kind == "current":
                source = "live"
                fallback = False
            elif kind == "historical":
                source = "receipt" if allow_historical else "live"
                fallback = not allow_historical
            else:  # mixed
                source = "live"
                fallback = not allow_historical
            out.append({
                "claim_type": ct,
                "kind": kind,
                "source": source,
                "allow_unverified_fallback": fallback,
            })
        return out

    def classify(self, claim_type):
        return self._default_kind.get(claim_type)

    # ---- 保守升级规则 ----
    @staticmethod
    def conservative_fallback(plan_item):
        """升级规则：任何无法现场核验的 current 项 → UNVERIFIED，禁止降级为记忆/报告。"""
        return schema.VERDICT_UNVERIFIED

    # ---- 脱敏 Trace ----
    @staticmethod
    def redact(text):
        """脱敏：token / bearer / gh_pat / URL 查询串 / 绝对路径细节。"""
        import re
        s = text or ""
        s = re.sub(r"gh[op]_[A-Za-z0-9]{20,}", "<gh-token>", s)
        s = re.sub(r"github_pat_[A-Za-z0-9_]{20,}", "<gh-pat>", s)
        s = re.sub(r"(?i)bearer\s+[A-Za-z0-9._-]{20,}", "bearer <redacted>", s)
        s = re.sub(r"https?://[^\s\"']*@", "https://<user>@", s)
        s = re.sub(r"([?&](?:token|key|secret|signature|sig)=)[^&\s\"']*", r"\1<redacted>", s)
        return s

    def trace(self, plan_items, request_id=""):
        """生成脱敏推导记录（供证据留存/审计）。"""
        return {
            "schema_version": schema.RECEIPT_SCHEMA_VERSION,
            "component": "truth-planner",
            "request_id": request_id,
            "plan": [
                {k: v for k, v in it.items() if k in ("claim_type", "kind", "source",
                                                       "allow_unverified_fallback")}
                for it in plan_items
            ],
        }
