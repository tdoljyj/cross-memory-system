# -*- coding: utf-8 -*-
"""CLI（协议 §13 内部命令与工具合同）。

命令：
    clued install --agent-type codex --agent-instance <label> [--session-id] --json
    clued auth check --binding-id <id> [--session-id] --json
    clued status [--binding-id <id>] --json
    clued memory recall --query <q> [--tier T2] --binding-id <id> --session-id <id> --json
    clued memory add|update|supersede|delete --content <c> [--id mem_x] --binding-id --session-id --json
    clued sync --binding-id <id> --session-id <id> --json
    clued uninstall --binding-id <id> [--mode detach-current-agent] [--discard-pending]
                    [--confirm-shared-cleanup] [--session-id] --json
    clued doctor --json

合同要求：
- JSON 模式 stdout 只输出一个有效 JSON 对象；诊断写 stderr；
- ok=false → 非零退出码（§13.2）；
- message 不含秘密（经 redact）；本地成功但未同步不得使用 SYNCED 字样。
"""

import argparse
import os
import sys

from . import PROTOCOL_VERSION, __version__
from .auth.policy import POLICY_PROFILES
from .controller import Controller
from .envelope import dumps, envelope_fail, envelope_ok
from .errors import CluedError, UsageError

EXIT_USAGE = 10


class _Parser(argparse.ArgumentParser):
    """参数错误 → UsageError → 退出码 10（§13.2），而非 argparse 默认 2。"""

    def error(self, message):
        self.print_usage(sys.stderr)
        raise UsageError(message)


def build_parser():
    p = _Parser(
        prog="clued", description="Clued v0.2.0 agent lifecycle CLI")
    # --json 可出现在子命令前后（协议 §13 示例：clued install ... --json）
    common = _Parser(add_help=False)
    common.add_argument("--json", action="store_true",
                        help="stdout 只输出一个 JSON 对象")
    p.add_argument("--json", action="store_true",
                   help="stdout 只输出一个 JSON 对象")
    sub = p.add_subparsers(dest="command")

    ins = sub.add_parser("install", parents=[common],
                         help="为当前智能体安装 Clued")
    ins.add_argument("--agent-type", required=True)
    ins.add_argument("--agent-instance", required=True)
    ins.add_argument("--session-id")
    ins.add_argument("--committer-name")
    ins.add_argument("--committer-email")

    auth = sub.add_parser("auth", parents=[common], help="会话在线认证")
    auth_sub = auth.add_subparsers(dest="auth_command")
    ac = auth_sub.add_parser("check", parents=[common], help="执行一次在线认证")
    ac.add_argument("--binding-id", required=True)
    ac.add_argument("--session-id")
    ap = auth_sub.add_parser(
        "policy", parents=[common],
        help="查看或显式切换 LKG 策略（ADR-CLD-003：balanced=6h / strict=1h；"
             "仅经本命令可切换到 balanced，未知策略 fail closed）")
    ap.add_argument("--binding-id", required=True)
    ap.add_argument("--set", dest="policy",
                    choices=sorted(POLICY_PROFILES),
                    help="显式切换策略（必须为已知策略名）")

    st = sub.add_parser("status", parents=[common], help="本地健康摘要（不含私有内容）")
    st.add_argument("--binding-id")

    mem = sub.add_parser("memory", parents=[common], help="记忆访问（读/写）")
    mem_sub = mem.add_subparsers(dest="memory_command")
    for op in ("recall", "add", "update", "supersede", "delete"):
        m = mem_sub.add_parser(op, parents=[common])
        if op == "recall":
            m.add_argument("--query", required=True)
            m.add_argument("--tier", default="T2")
        else:
            m.add_argument("--content", required=True)
            if op in ("update", "supersede", "delete"):
                m.add_argument("--id", dest="memory_id", required=True)
            m.add_argument("--category")
            if op == "add":
                m.add_argument("--remember", action="store_true")
        m.add_argument("--binding-id", required=True)
        m.add_argument("--session-id", required=True)
        m.add_argument("--committer-name")
        m.add_argument("--committer-email")

    sy = sub.add_parser("sync", parents=[common], help="手动恢复触发（受单飞与速率限制）")
    sy.add_argument("--binding-id", required=True)
    sy.add_argument("--session-id")
    sy.add_argument("--committer-name")
    sy.add_argument("--committer-email")

    un = sub.add_parser("uninstall", parents=[common], help="卸载当前智能体 Binding")
    un.add_argument("--binding-id", required=True)
    un.add_argument("--mode", default="detach-current-agent",
                    choices=("detach-current-agent", "remove-node",
                             "delete-cloud-account"))
    un.add_argument("--discard-pending", action="store_true")
    un.add_argument("--confirm-shared-cleanup", action="store_true")
    un.add_argument("--session-id")

    doc = sub.add_parser("doctor", parents=[common], help="Clued + sync + 引擎体检")
    return p


def run(argv=None, controller_factory=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    emit_json = "--json" in argv
    args = None
    try:
        args = parser.parse_args(argv)
        if not args.command:
            parser.print_help(sys.stderr)
            return EXIT_USAGE
        if not getattr(args, "json", False):
            # 人读模式：stdout 打摘要文本（诊断一律 stderr）
            result = _dispatch(args, controller_factory)
            print(_human_summary(result))
            return 0
        # JSON 模式：stdout 只输出一个 JSON 对象
        request_id = None
        result = _dispatch(args, controller_factory, request_id=request_id)
        envelope = envelope_ok(
            state=result.get("state"), code=result.get("code"),
            message=result.get("summary", ""),
            data=result,
            actions=result.get("actions"),
            retry_after_seconds=result.get("retry_after_seconds"),
            request_id=request_id)
        sys.stdout.write(dumps(envelope))
        return 0
    except UsageError as exc:
        if emit_json:
            sys.stdout.write(dumps(envelope_fail(
                None, message=exc.message)))
        else:
            print("参数错误: %s" % exc.message, file=sys.stderr)
        return EXIT_USAGE
    except CluedError as exc:
        env = envelope_fail(
            exc.code or "CLD-INSTALL-001", message=exc.message,
            state=exc.state, data=exc.data)
        if emit_json:
            sys.stdout.write(dumps(env))
        else:
            print("错误 [%s]: %s" % (env["code"], env["message"]),
                  file=sys.stderr)
        return exc.exit_code
    except Exception as exc:  # 意外错误：兜底（不含秘密）
        from .redact import redact
        env = envelope_fail("CLD-INSTALL-001",
                            message="内部错误: %s" % redact(str(exc))[:300])
        if emit_json:
            sys.stdout.write(dumps(env))
        else:
            print("内部错误: %s" % env["message"], file=sys.stderr)
        return 60


def _dispatch(args, controller_factory, request_id=None):
    ctrl = (controller_factory() if controller_factory
            else Controller.create())
    cmd = args.command
    if cmd == "install":
        return ctrl.install(args.agent_type, args.agent_instance,
                            session_id=args.session_id,
                            committer_name=args.committer_name,
                            committer_email=args.committer_email)
    if cmd == "auth" and args.auth_command == "check":
        return ctrl.auth_check(args.binding_id, session_id=args.session_id)
    if cmd == "auth" and args.auth_command == "policy":
        return ctrl.auth_policy(args.binding_id,
                                set_policy=getattr(args, "policy", None))
    if cmd == "status":
        return ctrl.status(args.binding_id)
    if cmd == "memory":
        op = args.memory_command
        op_map = {"add": "CREATE", "update": "UPDATE",
                  "supersede": "SUPERSEDE", "delete": "DELETE"}
        if op == "recall":
            return ctrl.memory_recall(args.binding_id, args.session_id,
                                      args.query, tier=args.tier)
        return ctrl.memory_write(
            args.binding_id, args.session_id, op_map[op],
            args.content, memory_id=getattr(args, "memory_id", None),
            category=getattr(args, "category", None),
            remember=getattr(args, "remember", False),
            committer_name=getattr(args, "committer_name", None),
            committer_email=getattr(args, "committer_email", None))
    if cmd == "sync":
        return ctrl.sync(args.binding_id, session_id=args.session_id,
                         committer_name=args.committer_name,
                         committer_email=args.committer_email)
    if cmd == "uninstall":
        return ctrl.uninstall(
            args.binding_id, mode=args.mode, session_id=args.session_id,
            discard_pending=args.discard_pending,
            confirm_shared_cleanup=args.confirm_shared_cleanup)
    if cmd == "doctor":
        return ctrl.doctor()
    raise UsageError("未知命令: %s" % cmd)


def _human_summary(result):
    return str(result.get("summary") or json_dump(result))


def json_dump(obj):
    import json
    return json.dumps(obj, ensure_ascii=False, indent=2)


def main(argv=None):
    sys.exit(run(argv))


if __name__ == "__main__":
    main()
