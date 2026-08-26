# -*- coding: utf-8 -*-
"""规范状态机（协议 §11）。

- 不得以多个互不一致的布尔值代替该状态机；
- 状态转换必须经过单一控制器并写入审计事件。
"""

# §11.1 规范状态
UNINSTALLED = "UNINSTALLED"
INSTALLING = "INSTALLING"
AUTH_REQUIRED = "AUTH_REQUIRED"
ONLINE_SYNCED = "ONLINE_SYNCED"
ONLINE_DIRTY = "ONLINE_DIRTY"
DEGRADED_LOCAL = "DEGRADED_LOCAL"
RECOVERING = "RECOVERING"
CONFLICT_REVIEW = "CONFLICT_REVIEW"
LOCKED = "LOCKED"
UNINSTALLING = "UNINSTALLING"
INSTALL_ERROR = "INSTALL_ERROR"

STATES = (
    UNINSTALLED, INSTALLING, AUTH_REQUIRED, ONLINE_SYNCED, ONLINE_DIRTY,
    DEGRADED_LOCAL, RECOVERING, CONFLICT_REVIEW, LOCKED, UNINSTALLING,
    INSTALL_ERROR,
)

INSTALLED_STATES = (
    AUTH_REQUIRED, ONLINE_SYNCED, ONLINE_DIRTY, DEGRADED_LOCAL, RECOVERING,
    CONFLICT_REVIEW, LOCKED,
)

# §11.2 关键转换 + 实现补充（LOCKED → AUTH_REQUIRED 为文档化扩展：
# 在线重新认证成功且账户/scope/Binding 恢复时解锁，审计记录）
ALLOWED_TRANSITIONS = {
    UNINSTALLED:    (INSTALLING,),
    INSTALLING:     (AUTH_REQUIRED, ONLINE_SYNCED, UNINSTALLED, INSTALL_ERROR),
    AUTH_REQUIRED:  (ONLINE_SYNCED, DEGRADED_LOCAL, LOCKED, UNINSTALLING),
    ONLINE_SYNCED:  (ONLINE_DIRTY, DEGRADED_LOCAL, LOCKED, UNINSTALLING),
    ONLINE_DIRTY:   (ONLINE_SYNCED, DEGRADED_LOCAL, LOCKED, RECOVERING,
                     CONFLICT_REVIEW, UNINSTALLING),
    DEGRADED_LOCAL: (RECOVERING, LOCKED, UNINSTALLING),
    RECOVERING:     (ONLINE_SYNCED, CONFLICT_REVIEW, DEGRADED_LOCAL, LOCKED,
                     ONLINE_DIRTY),
    CONFLICT_REVIEW: (ONLINE_SYNCED, UNINSTALLING, LOCKED, DEGRADED_LOCAL),
    LOCKED:         (AUTH_REQUIRED, UNINSTALLING),
    UNINSTALLING:   (UNINSTALLED, INSTALL_ERROR, AUTH_REQUIRED, ONLINE_SYNCED,
                     ONLINE_DIRTY, DEGRADED_LOCAL, CONFLICT_REVIEW, LOCKED),
    INSTALL_ERROR:  (INSTALLING, UNINSTALLED, UNINSTALLING),
}

# 状态 → 事件名（审计 event_type）
TRANSITION_EVENTS = {
    (UNINSTALLED, INSTALLING): "install_begin",
    (INSTALLING, ONLINE_SYNCED): "install_success",
    (INSTALLING, AUTH_REQUIRED): "install_success_auth_required",
    (INSTALLING, UNINSTALLED): "install_rollback_complete",
    (INSTALLING, INSTALL_ERROR): "install_failure",
    (AUTH_REQUIRED, ONLINE_SYNCED): "auth_authorized",
    (AUTH_REQUIRED, DEGRADED_LOCAL): "degraded_enter",
    (AUTH_REQUIRED, LOCKED): "auth_denied",
    (ONLINE_SYNCED, ONLINE_DIRTY): "pending_create",
    (ONLINE_SYNCED, DEGRADED_LOCAL): "degraded_enter",
    (ONLINE_SYNCED, LOCKED): "auth_denied",
    (ONLINE_DIRTY, ONLINE_SYNCED): "sync_success",
    (ONLINE_DIRTY, DEGRADED_LOCAL): "degraded_enter",
    (ONLINE_DIRTY, RECOVERING): "recovery_begin",
    (ONLINE_DIRTY, CONFLICT_REVIEW): "conflict_review",
    (DEGRADED_LOCAL, RECOVERING): "recovery_begin",
    (RECOVERING, ONLINE_SYNCED): "sync_success",
    (RECOVERING, CONFLICT_REVIEW): "conflict_review",
    (RECOVERING, DEGRADED_LOCAL): "recovery_unavailable",
    (RECOVERING, LOCKED): "auth_denied",
    (RECOVERING, ONLINE_DIRTY): "sync_partial",
    (CONFLICT_REVIEW, ONLINE_SYNCED): "conflict_resolved",
    (LOCKED, AUTH_REQUIRED): "auth_recovered",
    (UNINSTALLING, UNINSTALLED): "uninstall_success",
    (INSTALL_ERROR, INSTALLING): "install_repair_begin",
    (INSTALL_ERROR, UNINSTALLED): "install_error_cleared",
}


class InvalidTransition(Exception):
    pass


def check_transition(from_state, to_state):
    if from_state not in STATES or to_state not in STATES:
        raise InvalidTransition("unknown state: %r -> %r" % (from_state, to_state))
    if to_state not in ALLOWED_TRANSITIONS.get(from_state, ()):
        raise InvalidTransition(
            "illegal transition %r -> %r" % (from_state, to_state))
    return True
