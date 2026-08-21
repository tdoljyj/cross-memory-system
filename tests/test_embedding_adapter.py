#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Embedding adapter / manifest 守卫 单元测试（纯标准库，可重放，不依赖 torch/模型权重）。

覆盖（R4-G0-B R1 + R2 + R3）：
- manifest 验证：schema / self-hash / 白名单 / 大小 / 文件 SHA / 模型 ID / revision / 合同字段
- fail-closed：缺文件 / 可解析文件改 1 byte / manifest 篡改 / 错误维度 / 额外模型文件
- R2 反例（三类绕过）：白名单集合额外/缺失文件、query_prefix/passage_prefix 错值、
  backend.packages={}
- R3 可信根反例：artifact+manifest+self_hash 联合篡改、非空但不完整的 packages、
  wheel hash 漂移均拒绝；生产可信根与仓库证据逐字段一致
- canonical hash 算法（排除 self_hash 字段）
- hidden_size 缺失或 != 384 拒绝
- batch 固定（embed_query / embed_passages 签名禁止 batch_size 参数）
- verify_embedding_output：ndim==2 前置（[1,1,384] 拒绝 / [n,384] 通过）

运行：python tests/test_embedding_adapter.py
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

from memory_engine.manifest_guard import (  # noqa: E402
    verify_model_manifest, _verify_model_manifest,
    manifest_canonical_hash, canonical_json,
    verify_hidden_size, DIM, CONTRACT,
    EXPECTED_MODEL_ID, EXPECTED_REVISION,
    MANIFEST_FILENAME, MANIFEST_SCHEMA_VERSION,
    FROZEN_FILES, QUERY_PREFIX, PASSAGE_PREFIX, MODEL_TRUST_ROOT,
)

BASE_FILES = {
    "config.json": b'{"hidden_size": 384}',
    "tokenizer.json": b'{"version": "1.0"}',
    "tokenizer_config.json": b'{"do_lower_case": false}',
    "special_tokens_map.json": b'{"unk_token": "[UNK]"}',
    "sentencepiece.bpe.model": b"fake-spm",
    "model.safetensors": b"fake-safetensors-bytes",
}


def _sha256(b):
    return hashlib.sha256(b).hexdigest()


TEST_PACKAGES = {
    "torch": "2.13.0+cpu",
    "transformers": "5.15.1",
}
TEST_WHEEL_SHA256 = {
    "torch": _sha256(b"torch-wheel"),
    "transformers": _sha256(b"transformers-wheel"),
}
TEST_TRUST_ROOT = {
    "files": {
        fn: {"size": len(data), "sha256": _sha256(data)}
        for fn, data in BASE_FILES.items()
    },
    "backend": {
        "name": "transformers",
        "runtime": "torch-cpu",
        "packages": TEST_PACKAGES,
        "wheel_sha256": TEST_WHEEL_SHA256,
    },
}


def verify_test_manifest(model_dir):
    """用合成 fixture 的带外可信根调用内部验证器。"""
    return _verify_model_manifest(model_dir, None, TEST_TRUST_ROOT)


def make_dir(files=None, manifest_mut=None, extra_files=None):
    """创建合成模型目录 + 合法 manifest。返回 (dir, manifest)。

    files: 覆盖白名单文件内容；manifest_mut: 覆盖 manifest 字段（重算 self_hash 前）；
    extra_files: 白名单外的额外文件。
    """
    files = dict(BASE_FILES if files is None else files)
    tmp = tempfile.mkdtemp(prefix="g0b-t-")
    whitelist = []
    for fn, data in files.items():
        with open(os.path.join(tmp, fn), "wb") as f:
            f.write(data)
        whitelist.append({"filename": fn, "size": len(data),
                          "sha256": _sha256(data)})
    manifest = {
        "manifest_schema_version": MANIFEST_SCHEMA_VERSION,
        "model": {"id": EXPECTED_MODEL_ID,
                  "immutable_revision": EXPECTED_REVISION,
                  "license": "MIT",
                  "source": "https://huggingface.co/intfloat/multilingual-e5-small"},
        "backend": {"name": "transformers", "runtime": "torch-cpu",
                    "packages": dict(TEST_PACKAGES),
                    "wheel_sha256": dict(TEST_WHEEL_SHA256)},
        "contract": dict(CONTRACT),
        "whitelist_files": whitelist,
    }
    if manifest_mut:
        manifest.update(manifest_mut)
    manifest["self_hash"] = manifest_canonical_hash(manifest)
    with open(os.path.join(tmp, MANIFEST_FILENAME), "w", encoding="utf-8") as f:
        json.dump(manifest, f, sort_keys=True, ensure_ascii=False)
    if extra_files:
        for fn, data in extra_files.items():
            with open(os.path.join(tmp, fn), "wb") as f:
                f.write(data)
    return tmp, manifest


def expect_raise(fn, contains=None):
    try:
        fn()
    except Exception as e:
        if contains and contains not in str(e):
            raise AssertionError("expected %r in error, got %r" % (contains, str(e)))
        return str(e)
    raise AssertionError("expected exception, none raised")


def _rewrite_manifest(tmp, mutate):
    """读取 manifest → mutate(m) → 重算 self_hash 并写回。返回改写后的 dict。"""
    p = os.path.join(tmp, MANIFEST_FILENAME)
    with open(p, encoding="utf-8") as f:
        m = json.load(f)
    mutate(m)
    m["self_hash"] = manifest_canonical_hash(m)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(m, f, sort_keys=True, ensure_ascii=False)
    return m


# ---------------- 单元测试 ----------------


def test_manifest_verify_ok():
    tmp, _ = make_dir()
    try:
        verify_test_manifest(tmp)  # 不应抛异常
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_schema_mismatch():
    tmp, _ = make_dir(manifest_mut={"manifest_schema_version": 999})
    try:
        expect_raise(lambda: verify_test_manifest(tmp), "schema")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_missing_self_hash():
    tmp, _ = make_dir()
    try:
        p = os.path.join(tmp, MANIFEST_FILENAME)
        m = json.load(open(p, encoding="utf-8"))
        del m["self_hash"]
        json.dump(m, open(p, "w", encoding="utf-8"), sort_keys=True)
        expect_raise(lambda: verify_test_manifest(tmp), "self_hash")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_self_hash_mismatch():
    # 篡改 model.id 但不重算 self_hash → canonical hash 不一致
    tmp, _ = make_dir()
    try:
        p = os.path.join(tmp, MANIFEST_FILENAME)
        m = json.load(open(p, encoding="utf-8"))
        m["model"]["id"] = "attacker/evil-model"
        json.dump(m, open(p, "w", encoding="utf-8"), sort_keys=True)
        expect_raise(lambda: verify_test_manifest(tmp), "self_hash")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_model_id_mismatch():
    tmp, _ = make_dir(manifest_mut={"model": {"id": "attacker/evil-model",
                                              "immutable_revision": EXPECTED_REVISION}})
    try:
        expect_raise(lambda: verify_test_manifest(tmp), "model id")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_revision_mismatch():
    tmp, _ = make_dir(manifest_mut={"model": {"id": EXPECTED_MODEL_ID,
                                              "immutable_revision": "deadbeef" * 5}})
    try:
        expect_raise(lambda: verify_test_manifest(tmp), "revision")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_contract_dimension_mismatch():
    c = dict(CONTRACT)
    c["dimension"] = 768
    tmp, _ = make_dir(manifest_mut={"contract": c})
    try:
        expect_raise(lambda: verify_test_manifest(tmp), "dimension")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_missing_whitelist_file():
    tmp, _ = make_dir()
    try:
        os.remove(os.path.join(tmp, "model.safetensors"))
        expect_raise(lambda: verify_test_manifest(tmp), "missing whitelist file")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_tampered_file_sha():
    # 改 config.json 1 字节（保持 JSON 可解析）：hidden_size 384 -> 385
    files = dict(BASE_FILES)
    files["config.json"] = b'{"hidden_size": 385}'
    tmp, _ = make_dir()  # manifest 记录的是 384 版本的 sha
    try:
        # 覆盖磁盘上的 config.json 为篡改版
        with open(os.path.join(tmp, "config.json"), "wb") as f:
            f.write(b'{"hidden_size": 385}')
        expect_raise(lambda: verify_test_manifest(tmp), "sha256 mismatch")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_size_mismatch():
    tmp, _ = make_dir()
    try:
        with open(os.path.join(tmp, "tokenizer.json"), "ab") as f:
            f.write(b"extra")
        expect_raise(lambda: verify_test_manifest(tmp), "size mismatch")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_unexpected_extra_file():
    tmp, _ = make_dir(extra_files={"pytorch_model.bin": b"duplicate-format"})
    try:
        expect_raise(lambda: verify_test_manifest(tmp), "unexpected file")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_frozen_files_matches_base():
    # 代码内冻结的 6 文件集合必须与合成夹具 BASE_FILES 完全一致（防漂移）
    assert set(BASE_FILES) == FROZEN_FILES


def test_contract_prefixes_frozen():
    # CONTRACT 内的 query_prefix/passage_prefix 必须等于冻结精确值（防漂移）
    assert CONTRACT["query_prefix"] == QUERY_PREFIX == "query: "
    assert CONTRACT["passage_prefix"] == PASSAGE_PREFIX == "passage: "


def test_whitelist_extra_file_rejected():
    # 绕过类型①：白名单多声明一个非冻结文件（evil.py）→ 集合不完全相等 → 拒绝
    tmp, _ = make_dir()
    try:
        _rewrite_manifest(tmp, lambda m: m["whitelist_files"].append(
            {"filename": "evil.py", "size": 0, "sha256": _sha256(b"")}))
        expect_raise(lambda: verify_test_manifest(tmp),
                     "whitelist file set mismatch")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_whitelist_missing_file_rejected():
    # 绕过类型①：白名单少声明一个冻结文件（model.safetensors）→ 缺失 → 拒绝
    tmp, _ = make_dir()
    try:
        _rewrite_manifest(tmp, lambda m: m.__setitem__(
            "whitelist_files",
            [w for w in m["whitelist_files"]
             if w["filename"] != "model.safetensors"]))
        expect_raise(lambda: verify_test_manifest(tmp),
                     "whitelist file set mismatch")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_query_prefix_mismatch():
    # 绕过类型②：contract query_prefix 被改成非预期值 → 拒绝
    c = dict(CONTRACT)
    c["query_prefix"] = "doc: "
    tmp, _ = make_dir(manifest_mut={"contract": c})
    try:
        expect_raise(lambda: verify_test_manifest(tmp), "query_prefix")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_passage_prefix_mismatch():
    # 绕过类型②：contract passage_prefix 被改成非预期值 → 拒绝
    c = dict(CONTRACT)
    c["passage_prefix"] = "text: "
    tmp, _ = make_dir(manifest_mut={"contract": c})
    try:
        expect_raise(lambda: verify_test_manifest(tmp), "passage_prefix")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_backend_packages_empty_rejected():
    # 绕过类型③：backend.packages={} → 明确拒绝（防未锁定依赖的供应链绕过）
    tmp, _ = make_dir(manifest_mut={
        "backend": {"name": "transformers", "runtime": "torch-cpu",
                    "packages": {}}})
    try:
        expect_raise(lambda: verify_test_manifest(tmp), "packages")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_backend_packages_incomplete_rejected():
    # 非空但缺 transformers 仍必须失败；"非空"不是完整依赖锁。
    tmp, _ = make_dir()
    try:
        _rewrite_manifest(tmp, lambda m: m["backend"]["packages"].pop(
            "transformers"))
        expect_raise(lambda: verify_test_manifest(tmp),
                     "packages mismatch trusted dependency lock")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_backend_wheel_hash_mismatch_rejected():
    tmp, _ = make_dir()
    try:
        _rewrite_manifest(tmp, lambda m: m["backend"]["wheel_sha256"].__setitem__(
            "torch", "0" * 64))
        expect_raise(lambda: verify_test_manifest(tmp),
                     "wheel_sha256 mismatch trusted dependency lock")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_joint_artifact_manifest_tamper_rejected():
    """artifact + manifest metadata + self_hash 联合改写仍被带外可信根拒绝。"""
    tmp, _ = make_dir()
    try:
        attacker = b"attacker-controlled-weights"
        target = os.path.join(tmp, "model.safetensors")
        with open(target, "wb") as f:
            f.write(attacker)

        def mutate(manifest):
            wf = next(w for w in manifest["whitelist_files"]
                      if w["filename"] == "model.safetensors")
            wf["size"] = len(attacker)
            wf["sha256"] = _sha256(attacker)

        _rewrite_manifest(tmp, mutate)
        expect_raise(lambda: verify_test_manifest(tmp),
                     "metadata mismatch trusted root")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_production_trust_root_matches_evidence():
    """代码可信根必须逐字段等于已审计的仓库证据，防手工复制漂移。"""
    path = os.path.join(ROOT, "docs", "r4-gate0", "evidence",
                        "model-manifest.redacted.json")
    with open(path, encoding="utf-8") as f:
        evidence = json.load(f)
    files = {
        wf["filename"]: {"size": wf["size"], "sha256": wf["sha256"]}
        for wf in evidence["whitelist_files"]
    }
    assert MODEL_TRUST_ROOT["files"] == files
    for key in ("name", "runtime", "packages", "wheel_sha256"):
        assert MODEL_TRUST_ROOT["backend"][key] == evidence["backend"][key]


def test_public_verifier_uses_production_trust_root():
    # 合成 fixture 只有测试可信根；生产入口不得接受调用方/目录自选的 root。
    tmp, _ = make_dir()
    try:
        expect_raise(lambda: verify_model_manifest(tmp), "trusted dependency lock")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_hidden_size_none_rejected():
    expect_raise(lambda: verify_hidden_size(None), "384")


def test_hidden_size_wrong_rejected():
    expect_raise(lambda: verify_hidden_size(768), "384")


def test_hidden_size_ok():
    verify_hidden_size(384)  # 不抛异常


def test_canonical_hash_excludes_self_hash():
    tmp, manifest = make_dir()
    try:
        m1 = dict(manifest)
        m2 = dict(manifest)
        m2["self_hash"] = "0" * 64
        # self_hash 字段被排除，两个 manifest 的 canonical hash 应一致
        assert manifest_canonical_hash(m1) == manifest_canonical_hash(m2)
        assert manifest_canonical_hash(m1) == manifest["self_hash"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_batch_args_frozen():
    # embed_query / embed_passages 签名不得接受 batch_size 参数
    src = open(os.path.join(ROOT, "memory_engine", "embedding_adapter.py"),
               encoding="utf-8").read()
    tree = ast.parse(src)
    sigs = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name in (
                "embed_query", "embed_passages"):
            args = [a.arg for a in node.args.args]
            sigs[node.name] = args
    assert "embed_query" in sigs, "embed_query not found"
    assert "embed_passages" in sigs, "embed_passages not found"
    assert "batch_size" not in sigs["embed_query"], "embed_query exposes batch_size"
    assert "batch_size" not in sigs["embed_passages"], "embed_passages exposes batch_size"


# torch 依赖的测试（无 torch 时 SKIP）
def _has_torch():
    try:
        import torch  # noqa: F401
        return True
    except Exception:
        return False


def test_embedding_output_guard():
    if not _has_torch():
        raise _Skip("torch 不可用")
    import torch
    from memory_engine.embedding_adapter import verify_embedding_output
    # 合法：L2 归一化 [2,384]
    v = torch.randn(2, 384)
    v = v / v.norm(p=2, dim=1, keepdim=True)
    verify_embedding_output(v)
    # 错误维度（2-D 但最后一维 != 384）
    expect_raise(lambda: verify_embedding_output(torch.randn(2, 768)), "dim")
    # 3-D [1,1,384]（即使 L2 归一化）必须失败：先判 ndim==2，最后一维是 384
    # 也不能放行
    v3 = torch.randn(1, 1, 384)
    v3 = v3 / v3.norm(p=2, dim=1, keepdim=True)
    expect_raise(lambda: verify_embedding_output(v3), "2-D")
    # 合法单条 [1,384] 继续通过（n=1 仍属 [n,384]）
    v1 = torch.randn(1, 384)
    v1 = v1 / v1.norm(p=2, dim=1, keepdim=True)
    verify_embedding_output(v1)
    # 非 float32
    expect_raise(lambda: verify_embedding_output(
        (v / v.norm(p=2, dim=1, keepdim=True)).double()), "dtype")
    # 非 finite
    v2 = torch.randn(1, 384)
    v2[0, 0] = float("nan")
    expect_raise(lambda: verify_embedding_output(v2), "finite")
    # L2 != 1
    expect_raise(lambda: verify_embedding_output(torch.randn(1, 384)), "norm")


class _Skip(Exception):
    pass


TESTS = [
    test_manifest_verify_ok,
    test_schema_mismatch,
    test_missing_self_hash,
    test_self_hash_mismatch,
    test_model_id_mismatch,
    test_revision_mismatch,
    test_contract_dimension_mismatch,
    test_missing_whitelist_file,
    test_tampered_file_sha,
    test_size_mismatch,
    test_unexpected_extra_file,
    test_frozen_files_matches_base,
    test_contract_prefixes_frozen,
    test_whitelist_extra_file_rejected,
    test_whitelist_missing_file_rejected,
    test_query_prefix_mismatch,
    test_passage_prefix_mismatch,
    test_backend_packages_empty_rejected,
    test_backend_packages_incomplete_rejected,
    test_backend_wheel_hash_mismatch_rejected,
    test_joint_artifact_manifest_tamper_rejected,
    test_production_trust_root_matches_evidence,
    test_public_verifier_uses_production_trust_root,
    test_hidden_size_none_rejected,
    test_hidden_size_wrong_rejected,
    test_hidden_size_ok,
    test_canonical_hash_excludes_self_hash,
    test_batch_args_frozen,
    test_embedding_output_guard,
]


def main():
    failures = 0
    skipped = 0
    for fn in TESTS:
        name = fn.__name__
        try:
            fn()
            print("PASS %s" % name)
        except _Skip as e:
            print("SKIP %s (%s)" % (name, e))
            skipped += 1
        except Exception as e:
            failures += 1
            print("FAIL %s: %s" % (name, e))
    print("----")
    print("%d test(s), %d failure(s), %d skipped" % (len(TESTS), failures, skipped))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
