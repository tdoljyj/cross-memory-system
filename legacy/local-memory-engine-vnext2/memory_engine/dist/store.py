# -*- coding: utf-8 -*-
"""R3-D03 Atomic Artifact Store（ADR-R3-003 §3 原子切换）。

- verified staged receipt：仅接受带 .verified.json 的 staging 目录；
- 原子切换：staging → 正式区（先落 verified receipt，再 rename，最后发布标记）；
- 旧版本保留：正式区保留最近 N 个 revision，可回滚；
- 失败回滚：切换中断 → 恢复旧版本（发布标记回退）；
- residue 报告：切换失败后的残留文件与处置记录。
"""

import json
import os
import shutil
import time


class StoreError(Exception):
    def __init__(self, code, detail=""):
        super(StoreError, self).__init__("%s: %s" % (code, detail))
        self.code = code
        self.detail = detail


class AtomicArtifactStore(object):

    def __init__(self, store_root, retain_versions=2):
        self.store_root = store_root
        self.retain_versions = retain_versions
        os.makedirs(store_root, exist_ok=True)

    # ---- 内部路径 ----
    def _version_dir(self, revision):
        return os.path.join(self.store_root, "rev-%s" % revision)

    def _receipt_path(self, revision):
        return os.path.join(self.store_root, "receipt-%s.json" % revision)

    def _current_link(self):
        return os.path.join(self.store_root, "current")

    # ---- 提交（staging → 正式区，原子） ----
    def commit(self, staging_dir, revision):
        """把已验证 staging 提交为正式版本并原子切换 current。

        失败回滚：切换前记录 previous revision；rename 失败时恢复。
        """
        receipt_path = os.path.join(staging_dir, ".verified.json")
        if not os.path.isfile(receipt_path):
            raise StoreError("CLD-DIST-001", "staging 缺 .verified.json，拒绝提交")
        with open(receipt_path, "r", encoding="utf-8") as f:
            receipt = json.load(f)
        if receipt.get("revision") != revision:
            raise StoreError("CLD-DIST-001", "staging revision 与目标不符")

        dest = self._version_dir(revision)
        if os.path.isdir(dest):
            raise StoreError("CLD-DIST-001", "版本已存在: %s" % revision)
        previous = self.current_revision()

        # 1) 复制进正式区（copy + fsync 语义：跨目录 rename 不可靠时用拷贝）
        shutil.copytree(staging_dir, dest, dirs_exist_ok=False)
        # 2) 持久化 receipt
        with open(self._receipt_path(revision), "w", encoding="utf-8") as f:
            json.dump({"revision": revision, "committed_at": time.time(),
                       "release_id": receipt.get("release_id"),
                       "files": receipt.get("files")}, f, ensure_ascii=False, indent=1)
        # 3) 原子切换 current 标记
        try:
            self._switch_current(revision)
        except Exception as e:
            # 回滚：删除新版本目录 + 恢复 previous 标记
            shutil.rmtree(dest, ignore_errors=True)
            if os.path.exists(self._receipt_path(revision)):
                os.remove(self._receipt_path(revision))
            if previous:
                self._switch_current(previous)
            raise StoreError("CLD-DIST-001", "原子切换失败已回滚: %s" % e)

        self._prune()
        return {"revision": revision, "previous": previous,
                "residue": self.residue()}

    def _switch_current(self, revision):
        """current 标记用 原子写（write tmp → os.replace）。"""
        link = self._current_link()
        tmp = link + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(revision + "\n")
            f.flush()
        os.replace(tmp, link)

    def current_revision(self):
        link = self._current_link()
        if not os.path.isfile(link):
            return None
        with open(link, "r", encoding="utf-8") as f:
            return f.read().strip() or None

    # ---- 回滚 ----
    def rollback(self, target_revision=None):
        """回滚到指定（或 previous）revision。"""
        cur = self.current_revision()
        if not cur:
            raise StoreError("CLD-DIST-001", "无 current 可回滚")
        if target_revision is None:
            versions = self.versions()
            others = [v for v in versions if v != cur]
            if not others:
                raise StoreError("CLD-DIST-001", "无其他版本可回滚")
            target_revision = sorted(others)[-1]
        if not os.path.isdir(self._version_dir(target_revision)):
            raise StoreError("CLD-DIST-001", "目标版本不存在: %s" % target_revision)
        self._switch_current(target_revision)
        return {"rolled_back_to": target_revision, "from": cur}

    # ---- 查询 ----
    def versions(self):
        if not os.path.isdir(self.store_root):
            return []
        return sorted(n[4:] for n in os.listdir(self.store_root)
                      if n.startswith("rev-"))

    def artifact_path(self, revision, rel):
        """只允许访问已存在版本的目录内路径（防 traversal）。"""
        base = os.path.realpath(self._version_dir(revision))
        p = os.path.realpath(os.path.join(base, rel))
        if not p.startswith(base + os.sep) and p != base:
            raise StoreError("CLD-DIST-001", "路径越界: %s" % rel)
        return p

    def residue(self):
        """residue 报告：staging 残留 / .tmp 文件。"""
        found = []
        for root, _dirs, files in os.walk(self.store_root):
            for f in files:
                if f.endswith(".tmp") or f.endswith(".part"):
                    found.append(os.path.join(root, f))
        return found

    def _prune(self):
        """保留最近 N 个版本（含 current）。"""
        versions = sorted(self.versions())
        cur = self.current_revision()
        keep = set(versions[-self.retain_versions:]) if versions else set()
        if cur:
            keep.add(cur)
        for v in versions:
            if v not in keep:
                shutil.rmtree(self._version_dir(v), ignore_errors=True)
                if os.path.exists(self._receipt_path(v)):
                    os.remove(self._receipt_path(v))
