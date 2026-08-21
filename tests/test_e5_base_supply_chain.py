#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""E5-base 供应链守卫（supply_chain.py）单元测试（R1A；纯标准库，可重放，
不依赖 torch / transformers / 模型权重）。

覆盖（产品所有者裁决 2026-08-22 R1A）：
- 候选锁 pin：真实锁整文件 SHA-256 == 50ab5689…（固定并验证）
- build_manifest 从锁生成：白名单逐字段 == 锁 files；不含 lock_discrepancy；
  trust_root 含锁路径 + 冻结提交 + 完整 SHA-256；candidate_lock_sha256 锚定
- 守卫链 = 修正后候选锁 ↔ manifest ↔ 磁盘（三方逐字段）
- 锁篡改拒绝（改 1 字节 → LOCK_DIGEST_MISMATCH）；锁模型字段错配拒绝
- 例外字段拒绝（lock_discrepancy 任意出现——含空列表——均拒绝）
- 文件不一致拒绝（manifest 白名单值 ≠ 锁 / 磁盘字节改动 / 缺文件 /
  额外文件 / candidate_lock_sha256 错值 / schema 版本过旧 / self_hash 错值）
- loader-before-verification（ast 结构证明：verify_model_manifest 与
  verify_backend_versions 均先于 AutoTokenizer/AutoModel 加载）
- embedder 兼容层 re-export（calibration.py 依赖的四个名字仍可从
  embedder 导入）；旧 LOCK_DISCREPANCY / AUTHORITATIVE_FILES 代码已移除

运行：python tests/test_e5_base_supply_chain.py
"""
import ast
import hashlib
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from memory_eval.e5_base import supply_chain as SC  # noqa: E402

EMBEDDER_SRC = os.path.join(ROOT, "memory_eval", "e5_base", "embedder.py")
SUPPLY_CHAIN_SRC = os.path.join(
    ROOT, "memory_eval", "e5_base", "supply_chain.py")

SYNTH_FILES = {
    "config.json": b'{"hidden_size": 768}',
    "tokenizer.json": b'{"version": "1.0"}',
    "tokenizer_config.json": b'{"do_lower_case": false}',
    "special_tokens_map.json": b'{"unk_token": "[UNK]"}',
    "sentencepiece.bpe.model": b"fake-spm",
    "model.safetensors": b"fake-safetensors-bytes",
}


def _sha(b):
    return hashlib.sha256(b).hexdigest()


class _PatchedPin(object):
    """临时将模块锁 pin 指向合成锁 digest（测试夹具用；生产路径不受影响）。"""

    def __init__(self, sha):
        self.sha = sha
        self.old = None

    def __enter__(self):
        self.old = SC.EXPECTED_LOCK_SHA256
        SC.EXPECTED_LOCK_SHA256 = self.sha
        return self

    def __exit__(self, *exc):
        SC.EXPECTED_LOCK_SHA256 = self.old
        return False


def _synth_lock(files):
    return {
        "lock_type": "e5-base-eval-candidate-lock",
        "lock_version": 2,
        "model": {
            "id": SC.MODEL_ID,
            "immutable_revision": SC.IMMUTABLE_REVISION,
        },
        "files": [
            {"path": fn, "size": len(data), "sha256": _sha(data)}
            for fn, data in sorted(files.items())
        ],
    }


def make_env(files=None):
    """合成锁 + 合成模型目录 + 由 build_manifest 生成的合法 manifest。

    返回 (base_dir, model_dir, lock_path, lock_sha)。base_dir 由调用者清理。
    """
    files = dict(SYNTH_FILES if files is None else files)
    base = tempfile.mkdtemp(prefix="e5r1-t-")
    lock_path = os.path.join(base, "candidate-lock.json")
    lock = _synth_lock(files)
    with open(lock_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(lock, f, ensure_ascii=False, sort_keys=True, indent=2)
        f.write("\n")
    lock_sha = _sha(open(lock_path, "rb").read())
    model_dir = os.path.join(base, "model")
    os.makedirs(model_dir)
    for fn, data in files.items():
        with open(os.path.join(model_dir, fn), "wb") as f:
            f.write(data)
    with _PatchedPin(lock_sha):
        manifest = SC.build_manifest(model_dir, "3.13.14", lock_path)
    with open(os.path.join(model_dir, SC.MANIFEST_FILENAME), "w",
              encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, ensure_ascii=False, sort_keys=True, indent=2)
        f.write("\n")
    return base, model_dir, lock_path, lock_sha


def expect_raise(fn, contains=None):
    try:
        fn()
    except Exception as e:
        if contains and contains not in str(e):
            raise AssertionError(
                "expected %r in error, got %r" % (contains, str(e)))
        return str(e)
    raise AssertionError("expected exception, none raised")


def _rewrite_manifest(model_dir, mutate):
    """读 manifest → mutate → 重算 self_hash 写回。"""
    p = os.path.join(model_dir, SC.MANIFEST_FILENAME)
    with open(p, encoding="utf-8") as f:
        m = json.load(f)
    mutate(m)
    m["self_hash"] = SC._manifest_self_hash(m)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(m, f, sort_keys=True, ensure_ascii=False)
    return m


# ---------------- 真实锁 pin ----------------

def test_real_lock_pinned():
    lock, lock_sha = SC.load_verified_lock()  # 默认路径 = 仓库真实候选锁
    assert lock_sha == "66e1ab241f98a92759844cefb329688cb6a9dbb19a04" \
        "fd28d4ad05dd904e2ed9", lock_sha
    assert lock["lock_type"] == "e5-base-eval-candidate-lock"
    assert lock["lock_version"] == 2
    assert lock["model"]["id"] == SC.MODEL_ID
    assert lock["model"]["immutable_revision"] == SC.IMMUTABLE_REVISION
    assert len(lock["files"]) == 6


def test_real_lock_pinned_in_code():
    source = open(SUPPLY_CHAIN_SRC, encoding="utf-8").read()
    assert "66e1ab241f98a92759844cefb329688cb6a9dbb19a04fd" \
        "28d4ad05dd904e2ed9" in source, "锁 digest 未在代码内 pin"
    # R2A 勘误：旧 digest 50ab5689… 不得残留在代码内（防回退到勘误前 pin）
    assert "50ab5689" not in source, "旧锁 digest 残留"
    assert SC.LOCK_FROZEN_COMMIT == \
        "baa9bb6faddfce633b5cfbfff17501ecb033676c"


# ---------------- build_manifest：锁驱动生成 ----------------

def test_build_manifest_from_lock():
    base, model_dir, lock_path, lock_sha = make_env()
    try:
        with _PatchedPin(lock_sha):
            m = SC.build_manifest(model_dir, "3.13.14", lock_path)
        lock = json.load(open(lock_path, encoding="utf-8"))
        assert "lock_discrepancy" not in m
        assert m["candidate_lock_sha256"] == lock_sha
        assert SC.LOCK_RELATIVE_PATH in m["trust_root"]
        assert SC.LOCK_FROZEN_COMMIT in m["trust_root"]
        assert lock_sha in m["trust_root"]
        wl = {e["filename"]: e for e in m["whitelist_files"]}
        assert set(wl) == set(e["path"] for e in lock["files"])
        for e in lock["files"]:
            assert wl[e["path"]]["size"] == e["size"]
            assert wl[e["path"]]["sha256"] == e["sha256"]
        assert m["self_hash"] == SC._manifest_self_hash(m)
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_manifest_verify_ok():
    base, model_dir, lock_path, lock_sha = make_env()
    try:
        with _PatchedPin(lock_sha):
            m = SC.verify_model_manifest(model_dir, lock_path)
        assert m["candidate_lock_sha256"] == lock_sha
    finally:
        shutil.rmtree(base, ignore_errors=True)


# ---------------- 锁篡改 ----------------

def test_lock_tampering_rejected():
    base, model_dir, lock_path, lock_sha = make_env()
    try:
        raw = open(lock_path, "rb").read()
        # 改 1 字节（首个 sha256 值中的一个 hex 字符）→ 锁 digest 变化
        idx = raw.find(b'"sha256": "') + len(b'"sha256": "')
        tampered = raw[:idx] + (b"0" if raw[idx:idx + 1] != b"0" else b"1") \
            + raw[idx + 1:]
        assert tampered != raw
        with open(lock_path, "wb") as f:
            f.write(tampered)
        with _PatchedPin(lock_sha):  # pin 仍指向原始合成锁 digest
            expect_raise(
                lambda: SC.build_manifest(model_dir, "3.13.14", lock_path),
                "LOCK_DIGEST_MISMATCH")
            expect_raise(
                lambda: SC.verify_model_manifest(model_dir, lock_path),
                "LOCK_DIGEST_MISMATCH")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_lock_model_mismatch_rejected():
    # 锁内模型 ID 与代码冻结常量不一致 → 生成与校验均拒绝
    # （make_env 会因 build_manifest 先失败，故此处手工构造锁）
    base = tempfile.mkdtemp(prefix="e5r1-t-")
    try:
        lock = _synth_lock(SYNTH_FILES)
        lock["model"]["id"] = "evil/model"
        lock_path = os.path.join(base, "candidate-lock.json")
        with open(lock_path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(lock, f, ensure_ascii=False, sort_keys=True, indent=2)
            f.write("\n")
        lock_sha = _sha(open(lock_path, "rb").read())
        model_dir = os.path.join(base, "model")
        os.makedirs(model_dir)
        with _PatchedPin(lock_sha):  # pin 指向该锁自身 digest
            expect_raise(
                lambda: SC.build_manifest(model_dir, "3.13.14", lock_path),
                "LOCK_MODEL_ID_MISMATCH")
            expect_raise(
                lambda: SC.verify_model_manifest(model_dir, lock_path),
                "LOCK_MODEL_ID_MISMATCH")
    finally:
        shutil.rmtree(base, ignore_errors=True)


# ---------------- 例外字段（lock_discrepancy）拒绝 ----------------

def test_lock_discrepancy_empty_list_rejected():
    base, model_dir, lock_path, lock_sha = make_env()
    try:
        _rewrite_manifest(model_dir, lambda m: m.__setitem__(
            "lock_discrepancy", []))
        with _PatchedPin(lock_sha):
            expect_raise(
                lambda: SC.verify_model_manifest(model_dir, lock_path),
                "LOCK_DISCREPANCY_FIELD_REJECTED")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_lock_discrepancy_nonempty_rejected():
    base, model_dir, lock_path, lock_sha = make_env()
    try:
        _rewrite_manifest(model_dir, lambda m: m.__setitem__(
            "lock_discrepancy", [{
                "path": "tokenizer_config.json",
                "note": "历史形态（baa9bb6 前生成器输出）"}]))
        with _PatchedPin(lock_sha):
            expect_raise(
                lambda: SC.verify_model_manifest(model_dir, lock_path),
                "LOCK_DISCREPANCY_FIELD_REJECTED")
    finally:
        shutil.rmtree(base, ignore_errors=True)


# ---------------- 文件不一致拒绝 ----------------

def test_whitelist_metadata_mismatch_rejected():
    base, model_dir, lock_path, lock_sha = make_env()
    try:
        def mutate(m):
            for e in m["whitelist_files"]:
                if e["filename"] == "tokenizer_config.json":
                    e["sha256"] = "0" * 64
        _rewrite_manifest(model_dir, mutate)
        with _PatchedPin(lock_sha):
            expect_raise(
                lambda: SC.verify_model_manifest(model_dir, lock_path),
                "WHITELIST_METADATA_MISMATCH")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_disk_file_tampered_rejected():
    base, model_dir, lock_path, lock_sha = make_env()
    try:
        p = os.path.join(model_dir, "tokenizer_config.json")
        data = open(p, "rb").read()
        with open(p, "wb") as f:
            f.write(data + b"x")  # 字节变化（size+sha 均变）
        with _PatchedPin(lock_sha):
            expect_raise(
                lambda: SC.verify_model_manifest(model_dir, lock_path),
                "SIZE_MISMATCH")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_missing_file_rejected():
    base, model_dir, lock_path, lock_sha = make_env()
    try:
        os.remove(os.path.join(model_dir, "special_tokens_map.json"))
        with _PatchedPin(lock_sha):
            expect_raise(
                lambda: SC.verify_model_manifest(model_dir, lock_path),
                "MISSING_WHITELIST_FILE")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_extra_file_rejected():
    base, model_dir, lock_path, lock_sha = make_env()
    try:
        with open(os.path.join(model_dir, "rogue.bin"), "wb") as f:
            f.write(b"rogue")
        with _PatchedPin(lock_sha):
            expect_raise(
                lambda: SC.verify_model_manifest(model_dir, lock_path),
                "UNEXPECTED_FILE_IN_MODEL_DIR")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_manifest_lock_anchor_mismatch_rejected():
    base, model_dir, lock_path, lock_sha = make_env()
    try:
        _rewrite_manifest(model_dir, lambda m: m.__setitem__(
            "candidate_lock_sha256", "f" * 64))
        with _PatchedPin(lock_sha):
            expect_raise(
                lambda: SC.verify_model_manifest(model_dir, lock_path),
                "MANIFEST_LOCK_ANCHOR_MISMATCH")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_old_schema_version_rejected():
    base, model_dir, lock_path, lock_sha = make_env()
    try:
        _rewrite_manifest(model_dir, lambda m: m.__setitem__(
            "manifest_schema_version", 1))  # baa9bb6 前的 v1 形态
        with _PatchedPin(lock_sha):
            expect_raise(
                lambda: SC.verify_model_manifest(model_dir, lock_path),
                "MANIFEST_SCHEMA_VERSION_MISMATCH")
    finally:
        shutil.rmtree(base, ignore_errors=True)


def test_self_hash_mismatch_rejected():
    base, model_dir, lock_path, lock_sha = make_env()
    try:
        p = os.path.join(model_dir, SC.MANIFEST_FILENAME)
        m = json.load(open(p, encoding="utf-8"))
        m["self_hash"] = "0" * 64
        with open(p, "w", encoding="utf-8") as f:
            json.dump(m, f, sort_keys=True, ensure_ascii=False)
        with _PatchedPin(lock_sha):
            expect_raise(
                lambda: SC.verify_model_manifest(model_dir, lock_path),
                "MANIFEST_SELF_HASH_MISMATCH")
    finally:
        shutil.rmtree(base, ignore_errors=True)


# ---------------- loader-before-verification（ast 结构证明）----------------

def _embedder_ast():
    return ast.parse(open(EMBEDDER_SRC, encoding="utf-8").read())


def _init_call_lines():
    """E5BaseEmbedder.__init__ 内关键调用 → (lineno, 名称) 列表。"""
    tree = _embedder_ast()
    init = None
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == "E5BaseEmbedder":
            for item in node.body:
                if isinstance(item, ast.FunctionDef) and \
                        item.name == "__init__":
                    init = item
    assert init is not None, "E5BaseEmbedder.__init__ 未找到"
    calls = []
    for node in ast.walk(init):
        if isinstance(node, ast.Call):
            func = node.func
            name = None
            if isinstance(func, ast.Name):
                name = func.id
            elif isinstance(func, ast.Attribute):
                name = ast.unparse(func)
            if name:
                calls.append((node.lineno, name))
    return calls


def test_loader_before_verification():
    calls = _init_call_lines()
    verify = [ln for ln, n in calls if n == "verify_model_manifest"]
    versions = [ln for ln, n in calls if n == "verify_backend_versions"]
    tok_load = [ln for ln, n in calls if n.endswith(
        "AutoTokenizer.from_pretrained")]
    model_load = [ln for ln, n in calls if n.endswith(
        "AutoModel.from_pretrained")]
    assert verify and versions and tok_load and model_load, calls
    assert max(verify) < min(tok_load), "manifest 校验必须先于 tokenizer 加载"
    assert max(verify) < min(model_load), "manifest 校验必须先于模型加载"
    assert max(versions) < min(tok_load), "backend 校验必须先于 tokenizer 加载"
    assert max(versions) < min(model_load), "backend 校验必须先于模型加载"


def test_embedder_reexports_guard():
    """embedder 兼容层：calibration.py 依赖的四个名字从 supply_chain re-export。"""
    tree = _embedder_ast()
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and \
                node.module == "memory_eval.e5_base.supply_chain":
            for alias in node.names:
                imported.add(alias.asname or alias.name)
    # calibration.py 从 embedder 导入的四个名字必须仍然可用（兼容层）
    for name in ("build_manifest", "verify_model_manifest",
                 "verify_backend_versions", "MANIFEST_FILENAME"):
        assert name in imported, "embedder 未 re-export %s" % name
    # 其余守卫常量 / 异常类型同样 re-export（历史导入面兼容）
    for name in ("EmbedderError", "CONTRACT_FIELDS", "BACKEND_PACKAGES",
                 "MODEL_ID", "IMMUTABLE_REVISION", "EXPECTED_LOCK_SHA256"):
        assert name in imported, "embedder 未 re-export %s" % name


def test_stale_discrepancy_code_removed():
    """旧 LOCK_DISCREPANCY / AUTHORITATIVE_FILES / 生成器内嵌信任根已移除。

    区分两种形态：生成路径（`"lock_discrepancy":` 字典字面量赋值 /
    LOCK_DISCREPANCY 常量）必须不存在；拒绝检查
    （`if "lock_discrepancy" in manifest`）是 R1A 要求的守卫行为，允许存在。
    """
    embedder_src = open(EMBEDDER_SRC, encoding="utf-8").read()
    assert "LOCK_DISCREPANCY" not in embedder_src, \
        "旧 LOCK_DISCREPANCY 常量未移除"
    assert "AUTHORITATIVE_FILES" not in embedder_src, \
        "旧 AUTHORITATIVE_FILES 硬编码真值源未移除"
    assert "@ 4e6cca1" not in embedder_src, "过期 trust_root 引用未移除"
    sc_src = open(SUPPLY_CHAIN_SRC, encoding="utf-8").read()
    assert "AUTHORITATIVE_FILES" not in sc_src
    assert '"lock_discrepancy":' not in sc_src, \
        "supply_chain 不得携带任何 discrepancy 生成路径"
    assert "LOCK_DISCREPANCY = " not in sc_src, (
        "旧 LOCK_DISCREPANCY 常量未移除（LOCK_DISCREPANCY_FIELD_REJECTED "
        "为守卫拒绝错误码，属预期存在）")


TESTS = [
    test_real_lock_pinned,
    test_real_lock_pinned_in_code,
    test_build_manifest_from_lock,
    test_manifest_verify_ok,
    test_lock_tampering_rejected,
    test_lock_model_mismatch_rejected,
    test_lock_discrepancy_empty_list_rejected,
    test_lock_discrepancy_nonempty_rejected,
    test_whitelist_metadata_mismatch_rejected,
    test_disk_file_tampered_rejected,
    test_missing_file_rejected,
    test_extra_file_rejected,
    test_manifest_lock_anchor_mismatch_rejected,
    test_old_schema_version_rejected,
    test_self_hash_mismatch_rejected,
    test_loader_before_verification,
    test_embedder_reexports_guard,
    test_stale_discrepancy_code_removed,
]


def main():
    failures = 0
    skipped = 0
    for fn in TESTS:
        name = fn.__name__
        try:
            fn()
            print("PASS %s" % name)
        except Exception as e:
            failures += 1
            print("FAIL %s: %s" % (name, e))
    print("----")
    print("%d test(s), %d failure(s), %d skipped"
          % (len(TESTS), failures, skipped))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
