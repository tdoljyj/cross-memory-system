# -*- coding: utf-8 -*-
"""Clued v0.1 仓库根命令入口（协议 §13：扩展现有入口，语义与 JSON 合同等价）。

用法：python clued.py <command> ... --json
"""

import sys

from clued.cli import main

if __name__ == "__main__":
    sys.exit(main())
