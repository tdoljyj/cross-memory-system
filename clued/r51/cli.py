# -*- coding: utf-8 -*-
"""R5.1 CLI adapter over the same KernelService used by conversations."""

from __future__ import annotations

import argparse
import json
import sys

from .activation import ActivationError
from .service import KernelService


COMMANDS = (
    "install", "update", "repair", "disable", "enable", "uninstall",
    "recover", "doctor",
)


def build_parser():
    parser = argparse.ArgumentParser(prog="python -m clued.r51")
    parser.add_argument("--root", required=True)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("command", choices=COMMANDS)
    return parser


def run(argv=None, service_factory=KernelService):
    args = build_parser().parse_args(argv)
    try:
        result = service_factory(args.root).dispatch(args.command)
        envelope = {"ok": True, "result": result}
        code = 0
    except ActivationError as exc:
        envelope = {"ok": False, "code": exc.code}
        code = 1
    if args.json:
        sys.stdout.write(json.dumps(
            envelope, ensure_ascii=False, sort_keys=True))
    else:
        print(envelope)
    return code


def main(argv=None):
    raise SystemExit(run(argv))


if __name__ == "__main__":
    main()
