# -*- coding: utf-8 -*-
"""稳定错误码与退出码（协议 §13.2 / §14）。

错误码只能细化，不能在 v0.1.x 中改变既有语义（§14）。
"""

# ---- 退出码（§13.2）----
EXIT_OK = 0                 # 请求成功，包括明确标注的降级本地成功
EXIT_USAGE = 10             # 用户输入或参数错误
EXIT_CAPABILITY = 20        # 能力或依赖不可用
EXIT_DENIED = 30            # 授权明确拒绝
EXIT_UNAVAILABLE = 31       # 网络不可用且不能降级
EXIT_SYNC_FAIL = 40         # 同步或 doctor 失败
EXIT_CONFLICT = 41          # 冲突待处理
EXIT_TXN_FAIL = 50          # 安装/卸载事务失败
EXIT_SECURITY = 60          # 数据完整性或安全错误

# ---- 稳定错误码（§14）----
ERROR_CODES = {
    "CLD-CAP-001":        "当前智能体缺少安装所需工具能力",
    "CLD-INSTALL-001":    "安装预检失败",
    "CLD-INSTALL-002":    "安装事务回滚完成",
    "CLD-INSTALL-003":    "安装回滚不完整",
    "CLD-BIND-001":       "Agent Binding 不存在",
    "CLD-BIND-002":       "同 Agent 存在冲突 Binding",
    "CLD-AUTH-001":       "在线授权明确拒绝",
    "CLD-AUTH-002":       "在线认证暂时不可用",
    "CLD-AUTH-003":       "LKG 不存在或过期，禁止降级",
    "CLD-AUTH-004":       "Binding/证明完整性失败",
    "CLD-AUTH-005":       "scope 不足",
    "CLD-AUTH-006":       "认证策略非法或未知（fail closed）",
    "CLD-NET-001":        "网络预算耗尽，熔断器打开",
    "CLD-SYNC-001":       "doctor FAIL",
    "CLD-SYNC-002":       "pull 失败",
    "CLD-SYNC-003":       "push 失败",
    "CLD-SYNC-004":       "远端确认失败",
    "CLD-PEND-001":       "Pending Journal 损坏",
    "CLD-PEND-002":       "Pending Operation 被拒绝",
    "CLD-CONFLICT-001":   "乐观锁或内容冲突",
    "CLD-UNINSTALL-001":  "存在未同步操作",
    "CLD-UNINSTALL-002":  "远端撤销待完成",
    "CLD-UNINSTALL-003":  "Artifact 校验不符，停止删除",
    "CLD-SEC-001":        "凭据或秘密泄漏风险",
    "CLD-SEC-002":        "TLS、签名或信任链安全失败",
}

# 协议要求的状态/结果码（非 CLD-* 表内，但协议正文点名，§1.4/§6.5/§12.6）
RESULT_CODES = (
    "ALREADY_INSTALLED", "ALREADY_UNINSTALLED", "BINDING_CONFLICT",
    "CAPABILITY_UNAVAILABLE", "AUTHORIZED", "DENIED", "UNAVAILABLE",
)


def exit_code_for(code):
    """错误码 → 退出码（§13.2 语义映射）。"""
    if code is None:
        return EXIT_OK
    if code.startswith("CLD-CAP") or code == "CAPABILITY_UNAVAILABLE":
        return EXIT_CAPABILITY
    if code.startswith("CLD-INSTALL") or code.startswith("CLD-UNINSTALL") \
            or code == "BINDING_CONFLICT":
        return EXIT_TXN_FAIL
    if code.startswith("CLD-AUTH") or code == "DENIED":
        return EXIT_DENIED
    if code.startswith("CLD-NET") or code == "UNAVAILABLE":
        return EXIT_UNAVAILABLE
    if code.startswith("CLD-SYNC"):
        return EXIT_SYNC_FAIL
    if code.startswith("CLD-PEND") or code.startswith("CLD-CONFLICT"):
        return EXIT_CONFLICT
    if code.startswith("CLD-SEC"):
        return EXIT_SECURITY
    return EXIT_TXN_FAIL


class CluedError(Exception):
    """带稳定错误码的异常。message 已经过脱敏。"""

    def __init__(self, code, message, state=None, data=None, exit_code=None):
        super(CluedError, self).__init__(code)
        self.code = code
        self.message = message or ERROR_CODES.get(code, code)
        self.state = state
        self.data = data or {}
        self.exit_code = exit_code if exit_code is not None else exit_code_for(code)


class UsageError(CluedError):
    def __init__(self, message):
        super(UsageError, self).__init__(
            None, message, exit_code=EXIT_USAGE)
