#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R3-D01 Artifact Manifest & Trust 测试（ADR-R3-003 §2）。

覆盖：分类 / 固定 revision（禁 latest）/ hash 格式 / 大小上限 /
平台·Agent·协议兼容 / allowlist 根信任 / 模型隔离（model 条目入
product manifest 必须拒绝）。

运行：python tests/test_dist_manifest.py
"""

import hashlib
import json
import os
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from memory_engine.dist import (  # noqa: E402
    Allowlist, ManifestValidator, ManifestError, sha256_file, build_manifest,
)

TESTS = []


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _manifest(artifacts=None, revision="r1", mtype="product"):
    return {
        "schema_version": 1,
        "manifest_type": mtype,
        "release_id": "vNext-2.1-R3-G1",
        "revision": revision,
        "artifacts": artifacts or [
            {"path": "clued/controller.py", "sha256": _sha(b"c"),
             "size_bytes": 1, "max_size_bytes": 65536,
             "platforms": ["win32"], "agent_types": ["workbuddy"],
             "protocol_min": "0.3.0", "protocol_max": "0.3.x"},
        ],
        "trust": {"root": "local-allowlist", "signature": None},
    }


def register(fn):
    TESTS.append(fn)
    return fn


@register
def test_valid_manifest_passes():
    m = _manifest()
    _check(ManifestValidator().validate(m) == m, "合法 manifest 应通过")


@register
def test_latest_revision_rejected():
    m = _manifest(revision="latest")
    try:
        ManifestValidator().validate(m)
        raise AssertionError("latest 应拒绝")
    except ManifestError as e:
        _check(e.code == "CLD-DIST-001", "错误码")


@register
def test_bad_sha_format_rejected():
    arts = [{"path": "x.py", "sha256": "zz", "size_bytes": 1}]
    try:
        ManifestValidator().validate(_manifest(artifacts=arts))
        raise AssertionError("坏 hash 应拒绝")
    except ManifestError:
        pass


@register
def test_size_over_limit_rejected():
    arts = [{"path": "x.py", "sha256": _sha(b"x"), "size_bytes": 100,
             "max_size_bytes": 10}]
    try:
        ManifestValidator().validate(_manifest(artifacts=arts))
        raise AssertionError("超大小应拒绝")
    except ManifestError:
        pass


@register
def test_path_traversal_rejected():
    arts = [{"path": "../evil.py", "sha256": _sha(b"x"), "size_bytes": 1}]
    try:
        ManifestValidator().validate(_manifest(artifacts=arts))
        raise AssertionError("路径穿越应拒绝")
    except ManifestError:
        pass


@register
def test_protocol_range_rejected():
    arts = [{"path": "x.py", "sha256": _sha(b"x"), "size_bytes": 1,
             "protocol_min": "1.0", "protocol_max": "0.1"}]
    try:
        ManifestValidator().validate(_manifest(artifacts=arts))
        raise AssertionError("protocol min>max 应拒绝")
    except ManifestError:
        pass


@register
def test_model_artifact_in_product_manifest_rejected():
    arts = [
        {"path": "clued/controller.py", "sha256": _sha(b"c"), "size_bytes": 1,
         "class": "product"},
        {"path": "model/weights.bin", "sha256": _sha(b"w"), "size_bytes": 2,
         "class": "model"},
    ]
    try:
        ManifestValidator().validate(_manifest(artifacts=arts))
        raise AssertionError("product manifest 混入 model 必须拒绝")
    except ManifestError as e:
        _check(e.code == "CLD-DIST-001", "错误码")
        _check("model" in e.detail.lower(), "detail 说明 model 混入")


@register
def test_model_manifest_separate_ok():
    arts = [{"path": "weights.bin", "sha256": _sha(b"w"), "size_bytes": 2,
             "class": "model"}]
    m = _manifest(artifacts=arts, mtype="model")
    _check(ManifestValidator().validate(m) == m, "独立 model manifest 可校验")


@register
def test_allowlist_root_trust():
    al = Allowlist({"r1": {"clued/controller.py": _sha(b"c")}})
    _check(al.verify("r1", "clued/controller.py", _sha(b"c")) is True, "白名单匹配")
    try:
        al.verify("r1", "clued/controller.py", _sha(b"OTHER"))
        raise AssertionError("hash 不符应拒绝")
    except ManifestError as e:
        _check(e.code == "CLD-DIST-002", "不在白名单=CLD-DIST-002")
    try:
        al.verify("rev-9", "clued/controller.py", _sha(b"c"))
        raise AssertionError("revision 不在白名单应拒绝")
    except ManifestError:
        pass
    try:
        al.verify("r1", "other.py", _sha(b"c"))
        raise AssertionError("path 不在白名单应拒绝")
    except ManifestError:
        pass


@register
def test_manifest_allowlist_link():
    al = Allowlist({"r1": {"clued/controller.py": _sha(b"c")}})
    m = _manifest()  # sha 与白名单一致
    ManifestValidator().validate(m, allowlist=al)
    bad = _manifest()
    bad["artifacts"][0]["sha256"] = _sha(b"DIFF")
    try:
        ManifestValidator().validate(bad, allowlist=al)
        raise AssertionError("allowlist 链断裂应拒绝")
    except ManifestError:
        pass


@register
def test_allowlist_load_json():
    tmp = tempfile.mkdtemp(prefix="dist-al-")
    try:
        path = os.path.join(tmp, "allowlist.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"schema_version": 1,
                       "allowlist": {"r1": {"x.py": _sha(b"x")}}}, f)
        al = Allowlist.load(path)
        _check(al.verify("r1", "x.py", _sha(b"x")) is True, "load+verify")
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


@register
def test_sha256_file_helper():
    tmp = tempfile.mkdtemp(prefix="dist-sha-")
    try:
        path = os.path.join(tmp, "f.bin")
        with open(path, "wb") as f:
            f.write(b"hello")
        _check(sha256_file(path) == hashlib.sha256(b"hello").hexdigest(), "文件 sha256")
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)


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
