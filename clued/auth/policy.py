# -*- coding: utf-8 -*-
"""LKG 策略配置文件（ADR-CLD-003 / 协议 v0.3.0）。

- 固定语义策略名，禁止 Adapter 自行传任意秒数；
- balanced = 6h（建议默认，仅新安装自动采用；个人跨端、GitHub/代理偶发不可达）；
- strict = 1h（从 clued-v0.1.0 升级的既有安装保守迁移，绝不静默扩大权限）；
- 未知策略、任意自定义秒数、超过 6 小时的最大年龄 → 全部 fail closed；
- 单次 degraded session TTL 保持 30 分钟（engine.DEGRADED_SESSION_TTL_S）；
- 有效降级截止时间 = min(LKG 到期, 降级会话到期)（engine 计算）。
"""

# 唯一权威策略注册表（协议 §7.5 / ADR-CLD-003）；其它模块不得重复硬编码秒数。
POLICY_PROFILES = {
    "balanced": {"lkg_max_age_s": 6 * 3600.0},   # 6 小时
    "strict":   {"lkg_max_age_s": 1 * 3600.0},   # 1 小时
}

# 合法策略名（manifest 校验用）
AUTH_POLICIES = tuple(sorted(POLICY_PROFILES))

# 新安装默认策略（installer 写入 binding manifest）
DEFAULT_POLICY = "balanced"

# 从 clued-v0.1.0 升级的既有安装（binding manifest 无 auth_policy 字段）
# 保守迁移策略：strict（不得静默从 1h 放宽到 6h）
UPGRADE_POLICY = "strict"

# 任何策略/配置的 LKG 最大年龄上限：不得超过 6 小时（fail closed）
MAX_LKG_MAX_AGE_S = 6 * 3600.0


def resolve_lkg_max_age(policy):
    """策略名 → LKG 最大年龄（秒）。未知策略抛 CLD-AUTH-006（fail closed）。"""
    from ..errors import CluedError
    profile = POLICY_PROFILES.get(policy)
    if profile is None:
        raise CluedError(
            "CLD-AUTH-006",
            "未知认证策略 %r（仅允许 balanced/strict，fail closed）" % (policy,))
    return profile["lkg_max_age_s"]
