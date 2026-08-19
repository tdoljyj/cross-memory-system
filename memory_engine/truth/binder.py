# -*- coding: utf-8 -*-
"""R3-T03 Validation Evidence Binder（ADR-R3-002 §5 验收证据绑定）。

目标：任何"测试通过/验收通过"结论必须绑定四个 HEAD 且关系合法：
  tested_head == target_head（测试必须运行在干净 worktree）
  evidence_head 指向 tested_head 所在历史
  final_report_head 晚于 tested_head 且报告内自述
非法组合一律拒绝（fail-closed）。
"""

import hashlib
import os


class EvidenceBindingError(Exception):
    """绑定不合法（携带原因）。"""


class EvidenceBinder(object):

    @staticmethod
    def _is_ancestor(git, repo, ancestor, descendant):
        """ancestor 是否是 descendant 的祖先（用 git merge-base --is-ancestor）。"""
        import subprocess
        cmd = [git, "-C", repo, "merge-base", "--is-ancestor", ancestor, descendant]
        p = subprocess.run(cmd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=30)
        return p.returncode == 0

    @staticmethod
    def _sha256_file(path):
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()

    def bind(self, target_head, tested_head, evidence_head, final_report_head,
             test_inventory=None, test_result=None, git="git", repo=None):
        """四 HEAD 绑定。非法组合抛 EvidenceBindingError。"""
        if tested_head != target_head:
            raise EvidenceBindingError(
                "tested_head != target_head（测试必须运行在被验收提交上）")
        if not all(isinstance(h, str) and len(h) == 40 for h in
                   (target_head, tested_head, evidence_head, final_report_head)):
            raise EvidenceBindingError("HEAD 必须为 40 位 SHA")
        if repo:
            if not self._is_ancestor(git, repo, evidence_head, tested_head):
                raise EvidenceBindingError("evidence_head 不在 tested_head 历史中")
            if not self._is_ancestor(git, repo, tested_head, final_report_head):
                raise EvidenceBindingError("final_report_head 不晚于 tested_head")

        binding = {
            "target_head": target_head,
            "tested_head": tested_head,
            "evidence_head": evidence_head,
            "final_report_head": final_report_head,
            "test_inventory": test_inventory,
            "test_result": test_result,
        }
        binding["binding_digest"] = self._digest(binding)
        return binding

    @staticmethod
    def _digest(binding):
        canonical = {
            k: binding[k] for k in ("target_head", "tested_head", "evidence_head",
                                    "final_report_head")
        }
        if binding.get("test_result"):
            canonical["test_result"] = {
                k: binding["test_result"].get(k)
                for k in ("PASS", "FAIL", "SKIP", "ERROR")
                if binding["test_result"].get(k) is not None
            }
        raw = hashlib.sha256()
        for k in sorted(canonical):
            raw.update(k.encode())
            raw.update(str(canonical[k]).encode())
        return raw.hexdigest()

    def validate(self, binding, git="git", repo=None):
        """对已存在的 binding 复核（含 digest 校验）。"""
        if not binding or "binding_digest" not in binding:
            raise EvidenceBindingError("缺 binding_digest")
        if binding.get("tested_head") != binding.get("target_head"):
            raise EvidenceBindingError("tested_head != target_head")
        if self._digest(binding) != binding["binding_digest"]:
            raise EvidenceBindingError("binding_digest 不匹配（被篡改或字段漂移）")
        if repo:
            ev = binding["evidence_head"]
            th = binding["tested_head"]
            fr = binding["final_report_head"]
            if not self._is_ancestor(git, repo, ev, th):
                raise EvidenceBindingError("evidence_head 不在 tested_head 历史中")
            if not self._is_ancestor(git, repo, th, fr):
                raise EvidenceBindingError("final_report_head 不晚于 tested_head")
        return True
