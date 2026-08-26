# -*- coding: utf-8 -*-
"""Truth Integrity Schema（ADR-R3-002 冻结，Gate 1 落地）。

单一事实源：四类事实模型（fact kinds）、claim types、reason codes、
receipt 结构约束。Planner/Provider/Binder/Receipt/Gate 共用本模块常量。

设计约束（ADR-R3-002）：
- current 事实不得从记忆/旧报告/会话历史推导，只能由现场证据产生；
- 无法现场核验时输出 CURRENT_STATE_UNVERIFIED + reason code，不得输出猜测值；
- 无有效 receipt 的 current claim 成功返回必须为 0（§18 成功定义）。
"""

RECEIPT_SCHEMA_VERSION = 1

# ---- 四类事实模型（§1） ----
FACT_KINDS = ("stable", "historical", "current", "mixed")

# ---- Claim Types（§2.1，与 ADR-R3-002 表对齐） ----
CLAIM_TYPES = (
    "REPO_LOCAL_HEAD",
    "REPO_REMOTE_HEAD",
    "REPO_BASELINE",
    "REPO_TOPOLOGY",
    "REPO_WORKTREE",
    "REPO_PUSH_STATUS",
    "PRODUCT_VERSION",
    "VALIDATION_DECISION",
    "TEST_INVENTORY",
    "TEST_RESULT",
    "IMPLEMENTATION_PHASE",
    "LIFECYCLE_STATE",
    "INSTALLED_ARTIFACT_VERSION",
    "CAPABILITY_ENFORCEMENT",
    "HISTORICAL_STATUS",
)

# claim type → 默认事实类别（当前无显式上下文时的保守分类）
# 规则：一切可变状态按 current 处理；历史引用只能走 HISTORICAL_STATUS / 报告锚定。
DEFAULT_FACT_KIND = {
    "REPO_LOCAL_HEAD": "current",
    "REPO_REMOTE_HEAD": "current",
    "REPO_BASELINE": "mixed",          # 基线 = 当时 head(current 快照) + 时间(stable 语义)
    "REPO_TOPOLOGY": "current",
    "REPO_WORKTREE": "current",
    "REPO_PUSH_STATUS": "current",
    "PRODUCT_VERSION": "mixed",        # 版本号 stable + 所在 HEAD current
    "VALIDATION_DECISION": "mixed",    # 决策 historical + 其绑定的 HEAD current
    "TEST_INVENTORY": "historical",
    "TEST_RESULT": "mixed",            # 结果 historical + 运行环境 current
    "IMPLEMENTATION_PHASE": "mixed",
    "LIFECYCLE_STATE": "current",
    "INSTALLED_ARTIFACT_VERSION": "current",
    "CAPABILITY_ENFORCEMENT": "current",
    "HISTORICAL_STATUS": "historical",
}

# ---- Reason Codes（稳定错误码，§2.2 / §3.2） ----
REASON_CODES = (
    "REMOTE_UNREACHABLE",
    "NO_LOCAL_REPO",
    "NO_REMOTE",
    "GIT_FAILED",
    "NO_VALID_RECEIPT",
    "RECEIPT_STALE",
    "RECEIPT_TAMPERED",
    "CAPABILITY_MISMATCH",
    "EVIDENCE_CONFLICT",
    "DOCTOR_FAIL",
    "UNKNOWN",
)

# ---- Verdict ----
VERDICT_VERIFIED = "CURRENT_STATE_VERIFIED"
VERDICT_UNVERIFIED = "CURRENT_STATE_UNVERIFIED"

# ---- 回答状态区分（R3-T05，裁决要求） ----
# 禁止把"无法核验"误报成"没有记忆"：
#   NO_MEMORY       = 真实查无记忆（引擎确认无匹配对象），与核验无关
#   UNVERIFIED      = 有内容但无有效 receipt / 无法现场核验（≠ 没有记忆）
#   TAMPERED        = receipt 被篡改（digest 不符）
#   STALE           = receipt 过期（超过 max_age）
#   DENIED          = 授权/能力拒绝（capability 不足、认证拒绝）
#   ENV_UNAVAILABLE = 环境不可用（远端不可达、git 故障、doctor FAIL）
ANSWER_STATES = (
    "NO_MEMORY",
    "UNVERIFIED",
    "TAMPERED",
    "STALE",
    "DENIED",
    "ENV_UNAVAILABLE",
    "VERIFIED",
)

# ---- Source Precedence（§2.2） ----
# 现场证据 > 本 Gate receipt > 代码内 ADR/报告（锚定声明 HEAD） > 注入记忆（仅线索）
SOURCE_PRECEDENCE = ("live", "receipt", "report", "memory")

# ---- Gate 默认参数 ----
DEFAULT_CURRENT_CLAIM_MAX_AGE_SECONDS = 60
DEFAULT_REUSE_WINDOW_SECONDS = 5  # same-operation reuse（ADR-R3-002 §3.2）
