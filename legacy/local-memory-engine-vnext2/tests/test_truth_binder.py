#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R3-T03 EvidenceBinder 测试（ADR-R3-002 §5 四 HEAD 绑定）。

运行：python tests/test_truth_binder.py
"""

import os
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine.truth import EvidenceBinder, EvidenceBindingError  # noqa: E402

TESTS = []
GIT = "git"


def _make_chain(n=3):
    """建 c1→c2→c3 提交链。返回 (tmp, repo, [h1,h2,h3])。"""
    tmp = tempfile.mkdtemp(prefix="truth-binder-")
    repo = os.path.join(tmp, "repo")
    os.makedirs(repo)
    _git = lambda *a: subprocess.run([GIT, "-C", repo] + list(a),
                                     capture_output=True, text=True, check=True,
                                     encoding="utf-8", timeout=60)
    _git("init", "-b", "main")
    _git("config", "user.email", "t@t")
    _git("config", "user.name", "t")
    heads = []
    for i in range(1, n + 1):
        with open(os.path.join(repo, "f%d.txt" % i), "w") as f:
            f.write(str(i))
        _git("add", ".")
        _git("commit", "-qm", "c%d" % i)
        heads.append(_git("rev-parse", "HEAD").stdout.strip())
    return tmp, repo, heads


def register(fn):
    TESTS.append(fn)
    return fn


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


@register
def test_bind_valid_four_heads():
    tmp, repo, (h1, h2, h3) = _make_chain()
    try:
        b = EvidenceBinder()
        binding = b.bind(target_head=h3, tested_head=h3, evidence_head=h1,
                         final_report_head=h3, git=GIT, repo=repo,
                         test_inventory={"file_count": 3},
                         test_result={"PASS": 3, "FAIL": 0, "SKIP": 0, "ERROR": 0})
        _check(binding["tested_head"] == h3, "tested=head")
        _check("binding_digest" in binding, "应有 digest")
        _check(b.validate(binding, git=GIT, repo=repo) is True, "复核应通过")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_bind_tested_must_equal_target():
    tmp, repo, (h1, h2, h3) = _make_chain()
    try:
        b = EvidenceBinder()
        try:
            b.bind(target_head=h3, tested_head=h2, evidence_head=h1,
                   final_report_head=h3, git=GIT, repo=repo)
            raise AssertionError("tested!=target 应拒绝")
        except EvidenceBindingError:
            pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_bind_evidence_must_be_ancestor():
    tmp, repo, (h1, h2, h3) = _make_chain()
    try:
        b = EvidenceBinder()
        # evidence 晚于 tested（非法：evidence 不是 tested 的祖先）
        try:
            b.bind(target_head=h1, tested_head=h1, evidence_head=h3,
                   final_report_head=h3, git=GIT, repo=repo)
            raise AssertionError("evidence 晚于 tested 应拒绝")
        except EvidenceBindingError:
            pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_bind_final_report_not_before_tested():
    tmp, repo, (h1, h2, h3) = _make_chain()
    try:
        b = EvidenceBinder()
        # final_report 早于 tested（非法）
        try:
            b.bind(target_head=h3, tested_head=h3, evidence_head=h1,
                   final_report_head=h2, git=GIT, repo=repo)
            raise AssertionError("final_report 早于 tested 应拒绝")
        except EvidenceBindingError:
            pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_validate_detects_tampered_digest():
    tmp, repo, (h1, h2, h3) = _make_chain()
    try:
        b = EvidenceBinder()
        binding = b.bind(target_head=h3, tested_head=h3, evidence_head=h1,
                         final_report_head=h3, git=GIT, repo=repo)
        binding["tested_head"] = h2  # 篡改
        try:
            b.validate(binding, git=GIT, repo=repo)
            raise AssertionError("篡改后应拒绝")
        except EvidenceBindingError:
            pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_bind_without_repo_skips_ancestry():
    # 无 repo 时（纯结构校验）也强制 tested==target
    b = EvidenceBinder()
    binding = b.bind(target_head="a" * 40, tested_head="a" * 40,
                     evidence_head="a" * 40, final_report_head="a" * 40)
    _check(binding["target_head"] == "a" * 40, "无 repo 亦可绑定（结构层）")
    try:
        b.bind(target_head="a" * 40, tested_head="b" * 40,
               evidence_head="a" * 40, final_report_head="a" * 40)
        raise AssertionError("tested!=target 必须拒绝")
    except EvidenceBindingError:
        pass


def main():
    failures = 0
    for fn in TESTS:
        try:
            fn()
            print("PASS %s" % fn.__name__)
        except Exception as e:
            failures += 1
            print("FAIL %s: %s" % (fn.__name__, e))
    print("----")
    print("%d test(s), %d failure(s)" % (len(TESTS), failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
