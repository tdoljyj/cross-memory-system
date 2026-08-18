# -*- coding: utf-8 -*-
"""python -m memory_eval [--out DIR] [--no-warmup]

固定语料 + 固定时钟的完整评测：输出 results.json + report.md。
全程只读真实记忆（夹具物化在临时目录，跑完校验真实 objects 零变化）。
"""
import argparse
import json
import os
import sys

from . import runner

DEFAULT_OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "memory_eval_baseline")


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="memory_eval",
        description="Memory Eval（MIV-001）固定评测")
    ap.add_argument("--out", default=DEFAULT_OUT,
                    help="输出目录（默认 memory_eval_baseline/）")
    ap.add_argument("--no-warmup", action="store_true")
    args = ap.parse_args(argv)

    os.makedirs(args.out, exist_ok=True)
    report = runner.run_all(warmup=not args.no_warmup)
    results_path = os.path.join(args.out, "results.json")
    md_path = os.path.join(args.out, "report.md")
    with open(results_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")
    with open(md_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(runner.render_markdown(report))
    print("results: %s" % results_path)
    print("report:  %s" % md_path)
    print("cases: %d  replay: %s  secret_leaks: %s" % (
        report["case_count"], report["replay_hash"][:16],
        report["secret_leaks"] or "0"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
