#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R3-D03 AtomicArtifactStore 测试（ADR-R3-003 §3 原子切换）。

覆盖：verified staging 提交 / current 原子切换 / 旧版本保留 /
失败回滚 / residue 报告 / 路径越界拒绝。

运行：python tests/test_dist_store.py
"""

import json
import os
import shutil
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine.dist import AtomicArtifactStore, StoreError  # noqa: E402

TESTS = []


def _staging(root, revision, files=None, verified=True):
    """构造一个带 .verified.json 的 staging 目录。"""
    d = os.path.join(root, "stage-%s" % revision)
    os.makedirs(d)
    for name, data in (files or {"f.txt": b"hello"}).items():
        p = os.path.join(d, name)
        os.makedirs(os.path.dirname(p), exist_ok=True) if "/" in name else None
        with open(p, "wb") as f:
            f.write(data)
    if verified:
        with open(os.path.join(d, ".verified.json"), "w", encoding="utf-8") as f:
            json.dump({"revision": revision, "release_id": "r1",
                       "files": {k: "x" for k in (files or {"f.txt": b"hello"})}},
                      f)
    return d


def register(fn):
    TESTS.append(fn)
    return fn


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


@register
def test_commit_and_current_switch():
    tmp = tempfile.mkdtemp(prefix="dist-store-")
    try:
        store = AtomicArtifactStore(os.path.join(tmp, "store"))
        s1 = _staging(tmp, "r1")
        out = store.commit(s1, "r1")
        _check(store.current_revision() == "r1", "current=r1")
        _check(store.versions() == ["r1"], "versions")
        _check(out["previous"] is None, "无 previous")
        # 再提交 r2 → current 切换 + 旧版本保留
        s2 = _staging(tmp, "r2", {"g.txt": b"world"})
        out2 = store.commit(s2, "r2")
        _check(store.current_revision() == "r2", "current=r2")
        _check(out2["previous"] == "r1", "previous=r1")
        _check(set(store.versions()) == {"r1", "r2"}, "旧版本保留")
        _check(os.path.isfile(store.artifact_path("r1", "f.txt")), "旧版文件可读")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_commit_rejects_unverified_staging():
    tmp = tempfile.mkdtemp(prefix="dist-store-")
    try:
        store = AtomicArtifactStore(os.path.join(tmp, "store"))
        s = _staging(tmp, "r1", verified=False)
        try:
            store.commit(s, "r1")
            raise AssertionError("缺 .verified.json 应拒绝提交")
        except StoreError:
            pass
        _check(store.current_revision() is None, "不得有 current")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_commit_revision_mismatch_rejected():
    tmp = tempfile.mkdtemp(prefix="dist-store-")
    try:
        store = AtomicArtifactStore(os.path.join(tmp, "store"))
        s = _staging(tmp, "r1")
        try:
            store.commit(s, "r999")
            raise AssertionError("staging revision 与目标不符应拒绝")
        except StoreError:
            pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_duplicate_revision_rejected():
    tmp = tempfile.mkdtemp(prefix="dist-store-")
    try:
        store = AtomicArtifactStore(os.path.join(tmp, "store"))
        store.commit(_staging(tmp, "r1"), "r1")
        try:
            store.commit(_staging(tmp, "r1-dup", verified=False), "r1")
            raise AssertionError("重复 revision 应拒绝")
        except StoreError:
            pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_rollback():
    tmp = tempfile.mkdtemp(prefix="dist-store-")
    try:
        store = AtomicArtifactStore(os.path.join(tmp, "store"))
        store.commit(_staging(tmp, "r1"), "r1")
        store.commit(_staging(tmp, "r2", {"g": b"2"}), "r2")
        out = store.rollback()
        _check(store.current_revision() == "r1", "回滚到 r1")
        _check(out["rolled_back_to"] == "r1", "rolled_back_to")
        _check(out["from"] == "r2", "from=r2")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_residue_report():
    tmp = tempfile.mkdtemp(prefix="dist-store-")
    try:
        store = AtomicArtifactStore(os.path.join(tmp, "store"))
        store.commit(_staging(tmp, "r1"), "r1")
        # 制造残留
        with open(os.path.join(store.store_root, "junk.tmp"), "w") as f:
            f.write("x")
        with open(os.path.join(store.store_root, "rev-r1", "left.part"), "w") as f:
            f.write("x")
        res = store.residue()
        _check(any("junk.tmp" in r for r in res), "residue 含 .tmp")
        _check(any("left.part" in r for r in res), "residue 含 .part")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_path_traversal_rejected():
    tmp = tempfile.mkdtemp(prefix="dist-store-")
    try:
        store = AtomicArtifactStore(os.path.join(tmp, "store"))
        store.commit(_staging(tmp, "r1"), "r1")
        try:
            store.artifact_path("r1", "../outside")
            raise AssertionError("路径越界应拒绝")
        except StoreError:
            pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_retention_prunes_old():
    tmp = tempfile.mkdtemp(prefix="dist-store-")
    try:
        store = AtomicArtifactStore(os.path.join(tmp, "store"), retain_versions=2)
        for rev in ("r1", "r2", "r3"):
            store.commit(_staging(tmp, rev, {"%s.txt" % rev: rev.encode()}), rev)
        versions = store.versions()
        _check("r1" not in versions, "r1 应被清理")
        _check("r3" in versions and store.current_revision() == "r3",
               "最新保留且 current")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


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
