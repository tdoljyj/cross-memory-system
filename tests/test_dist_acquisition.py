#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R3-D02 ArtifactAcquisition 测试（ADR-R3-003 §3）。

覆盖：受限下载（URL 前缀门禁）/ staging / 单飞锁 / 全量校验 /
失败清理（不留可消费半成品）/ 脱敏日志。

全部离线：fetcher 注入从本地文件读取，不访问网络。

运行：python tests/test_dist_acquisition.py
"""

import hashlib
import json
import os
import shutil
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine.dist import (  # noqa: E402
    Allowlist, ArtifactAcquisition, AcquisitionError, ManifestError,
)

TESTS = []


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _file_fetcher(root):
    """注入 fetcher：从本地目录读取（模拟受控 artifact 源）。"""
    def fetcher(url, offset=0):
        # url 形如 file:///abs/path
        path = url.replace("file://", "")
        with open(path, "rb") as f:
            if offset:
                f.seek(offset)
            return f.read()
    return fetcher


def _setup():
    """建 artifact 源目录 + manifest + allowlist + acquisition。"""
    tmp = tempfile.mkdtemp(prefix="dist-acq-")
    src = os.path.join(tmp, "src")
    os.makedirs(src)
    # 两个 artifact
    for name, data in (("a.py", b"aaa"), ("b/b.py", b"bbb")):
        p = os.path.join(src, name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)
    a_sha = _sha(b"aaa")
    b_sha = _sha(b"bbb")
    manifest = {
        "schema_version": 1, "manifest_type": "product",
        "release_id": "r1", "revision": "r1",
        "artifacts": [
            {"path": "a.py", "sha256": a_sha, "size_bytes": 3, "max_size_bytes": 100},
            {"path": "b/b.py", "sha256": b_sha, "size_bytes": 3, "max_size_bytes": 100},
        ],
    }
    allowlist = Allowlist({"r1": {"a.py": a_sha, "b/b.py": b_sha}})
    staging_root = os.path.join(tmp, "staging")
    cache_root = os.path.join(tmp, "cache")
    acq = ArtifactAcquisition(
        allowed_prefixes=("file://" + src + "/",),
        staging_root=staging_root, cache_root=cache_root,
        fetcher=_file_fetcher(src),
    )
    return tmp, src, manifest, allowlist, acq


def _url_for(src):
    def url_for(path):
        return "file://" + os.path.join(src, path)
    return url_for


def register(fn):
    TESTS.append(fn)
    return fn


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


@register
def test_stage_success_verified_receipt():
    tmp, src, manifest, al, acq = _setup()
    try:
        staging = acq.stage(manifest, al, _url_for(src))
        _check(os.path.isdir(staging), "staging 目录存在")
        _check(os.path.isfile(os.path.join(staging, "a.py")), "a.py 落盘")
        _check(os.path.isfile(os.path.join(staging, "b", "b.py")), "b/b.py 落盘")
        _check(os.path.isfile(os.path.join(staging, ".verified.json")),
               "verified receipt 落盘")
        with open(os.path.join(staging, ".verified.json"), encoding="utf-8") as f:
            receipt = json.load(f)
        _check(receipt["revision"] == "r1", "receipt revision")
        _check("a.py" in receipt["files"], "receipt files")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_url_not_allowed_rejected_and_cleaned():
    tmp, src, manifest, al, acq = _setup()
    try:
        # 注入一个越界 url
        def evil_url(path):
            return "http://evil.example/" + path
        try:
            acq.stage(manifest, al, evil_url)
            raise AssertionError("非白名单 URL 应拒绝")
        except AcquisitionError as e:
            _check(e.code == "CLD-DIST-002", "错误码 CLD-DIST-002")
        # staging 必须被清理（不留半成品）
        leftovers = [d for d in os.listdir(acq.staging_root)]
        _check(all(not d.startswith("stage-") or not os.listdir(
            os.path.join(acq.staging_root, d)) for d in leftovers),
            "staging 不应留下可消费文件")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_hash_mismatch_cleans_staging():
    tmp, src, manifest, al, acq = _setup()
    try:
        # 篡改源内容 → actual hash ≠ allowlist 期望 → verify 失败
        with open(os.path.join(src, "a.py"), "wb") as f:
            f.write(b"TAMPERED")
        try:
            acq.stage(manifest, al, _url_for(src))
            raise AssertionError("hash 不符应拒绝")
        except (AcquisitionError, ManifestError):
            pass
        # 校验失败后 staging 不得残留已验证标记
        for d in os.listdir(acq.staging_root):
            v = os.path.join(acq.staging_root, d, ".verified.json")
            _check(not os.path.isfile(v), "失败后不得有 verified 标记")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_single_fly_lock_busy():
    tmp, src, manifest, al, acq = _setup()
    try:
        lock = os.path.join(acq.staging_root, ".lock-r1")
        os.makedirs(lock)
        try:
            acq.stage(manifest, al, _url_for(src))
            raise AssertionError("单飞锁占用应拒绝")
        except AcquisitionError as e:
            _check(e.code == "CLD-DIST-002", "单飞锁错误码")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_retry_bounded_then_fail():
    tmp, src, manifest, al, acq = _setup()
    try:
        calls = {"n": 0}

        def flaky(url, offset=0):
            calls["n"] += 1
            path = url.replace("file://", "")
            with open(path, "rb") as f:
                data = f.read()
            if calls["n"] <= 2:
                raise OSError("transient")
            return data

        acq.fetcher = flaky
        staging = acq.stage(manifest, al, _url_for(src))
        _check(os.path.isfile(os.path.join(staging, "a.py")), "重试后成功")
        _check(calls["n"] >= 2, "发生重试")
        # 一直失败 → 有界重试后抛错并清理
        calls["n"] = 0

        def always_fail(url, offset=0):
            raise OSError("always")
        acq.fetcher = always_fail
        try:
            acq.stage(manifest, al, _url_for(src))
            raise AssertionError("持续失败应最终抛错")
        except AcquisitionError:
            pass
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_partial_download_resume():
    """断点续传：_download_one 对已有 .part 从 offset 续传。"""
    tmp, src, manifest, al, acq = _setup()
    try:
        dest = os.path.join(tmp, "out", "a.py")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        part = dest + ".part"
        with open(part, "wb") as f:
            f.write(b"a")  # 已下载 1 字节
        calls = {"offset": None}

        def resuming(url, offset=0):
            calls["offset"] = offset
            with open(url.replace("file://", ""), "rb") as f:
                if offset:
                    f.seek(offset)
                return f.read()

        acq.fetcher = resuming
        acq._download_one("file://" + os.path.join(src, "a.py"), dest)
        _check(calls["offset"] == 1, "应从 offset=1 续传（.part 长度 1）")
        with open(dest, "rb") as f:
            _check(f.read() == b"aaa", "完整内容")
        _check(not os.path.exists(part), ".part 应转为正式文件")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_redacted_log_url():
    from memory_engine.dist.acquisition import _redact_url
    url = "https://user:secret@host/x?token=abc123&sig=xyz"
    out = _redact_url(url)
    _check("secret@" not in out, "密码脱敏")
    _check("abc123" not in out, "token 脱敏")
    _check("xyz" not in out, "sig 脱敏")


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
