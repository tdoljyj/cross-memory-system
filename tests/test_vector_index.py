#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R4 Gate 0-C: safe vector-index contract and failure injection.

Runs without torch, transformers, a model download, or network access.  The
production index builder receives a deterministic test embedder through the
same narrow interface used by E5Embedder.
"""

import hashlib
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from memory_engine import paths  # noqa: E402
from memory_engine import schema as S  # noqa: E402
from memory_engine import store  # noqa: E402
from memory_engine import vector_index as VI  # noqa: E402


MODEL_DIGEST = "a" * 64
REVISION = "919cfbe11fbf4f1b9bb321007c46c14feaf84227"


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def expect_raise(fn, contains=None, exc_type=Exception):
    try:
        fn()
    except exc_type as exc:
        if contains is not None:
            check(contains in str(exc),
                  "异常不含 %r: %s" % (contains, exc))
        return exc
    raise AssertionError("预期异常但未抛出")


def obj(oid, content="稳定记忆", status="active", type_="semantic",
        scope="global", category="preference", evidence="explicit",
        valid_until=None, tags=None, entities=None, **extra):
    value = S.new_object(
        oid, type_, content, scope=scope, status=status,
        category=category, evidence=evidence, recall_layer="L2",
        valid_until=valid_until, tags=tags or ["偏好"],
        entities=entities or ["用户"],
        created_at="2026-08-20T00:00:00Z")
    value.update(extra)
    return value


class FakeEmbedder(object):
    dim = VI.DIMENSION

    def __init__(self, malformed=None):
        self.calls = []
        self.malformed = malformed

    def embed_passages(self, texts):
        self.calls.append(list(texts))
        if self.malformed == "dimension":
            return [[1.0] + [0.0] * 382 for _ in texts]
        if self.malformed == "norm":
            return [[2.0] + [0.0] * 383 for _ in texts]
        rows = []
        for text in texts:
            pos = int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:8], 16)
            pos %= VI.DIMENSION
            row = [0.0] * VI.DIMENSION
            row[pos] = 1.0
            rows.append(row)
        return rows


def build(objects, cache, embedder=None, **kw):
    kw.setdefault("harden_permissions", False)
    return VI.build_index(
        objects, embedder or FakeEmbedder(), cache, MODEL_DIGEST,
        model_revision=REVISION, **kw)


def test_passage_serializer_is_deterministic_and_visible_only():
    a = obj("mem_00000001", "  全角Ａ\r\n  喜欢   留白 ",
            tags=[" 美学 ", "留白", "留白"], entities=[" 用户 "])
    b = obj("mem_00000001", "全角A 喜欢 留白",
            tags=["留白", "美学"], entities=["用户"])
    b["source"]["updated_at"] = "2026-08-21T23:59:59Z"
    b["provenance"]["source_ref"] = "C:/private/path"
    pa = VI.serialize_passage(a)
    pb = VI.serialize_passage(b)
    check(pa == pb, "NFKC/空白/集合顺序归一化后 passage 应相同")
    check(VI.content_hash(a) == VI.content_hash(b), "content hash 应稳定")
    check("private/path" not in pa, "source_ref 不得进入 passage")
    check("updated_at" not in pa, "时间元数据不得进入 passage")
    changed = dict(b)
    changed["content"] = "全角A 喜欢高饱和"
    check(VI.content_hash(changed) != VI.content_hash(b),
          "可见正文变化必须改变 content hash")


def test_pre_embedding_filter_exact_allowed_set_and_reason_codes():
    winner = obj("mem_00000010", "当前方案", entities=["方案"])
    loser = obj("mem_00000011", "旧方案", entities=["方案"])
    winner["relations"]["contradicts"] = [loser["id"]]
    cases = [
        obj("mem_00000001"),
        obj("mem_00000002", status="candidate"),
        obj("mem_00000003", type_="temporary"),
        obj("mem_00000004", status="rejected"),
        obj("mem_00000005", valid_until="2026-08-01T00:00:00Z"),
        obj("mem_00000006", denied=True),
        obj("mem_00000007", "Bearer " + "a" * 26),
        winner, loser,
        {"id": "mem_00000012", "content": "invalid"},
    ]
    included, excluded = VI.eligible_objects(
        cases, when=datetime(2026, 8, 21, tzinfo=timezone.utc))
    check([o["id"] for o in included] == ["mem_00000001", "mem_00000010"],
          "included IDs 必须精确等于硬过滤允许集合")
    expected = {
        "mem_00000002": VI.RC_STATUS_NOT_RECALLABLE,
        "mem_00000003": VI.RC_TEMPORARY_OBJECT,
        "mem_00000004": VI.RC_STATUS_NOT_RECALLABLE,
        "mem_00000005": VI.RC_TEMPORAL_NOT_CURRENT,
        "mem_00000006": VI.RC_ACCESS_DENIED,
        "mem_00000007": VI.RC_SECRET_DETECTED,
        "mem_00000011": VI.RC_CONFLICT_LOSER,
        "mem_00000012": VI.RC_INVALID_OBJECT,
    }
    for oid, reason in expected.items():
        check(excluded.get(oid) == [reason], "%s 排除原因错误: %r" % (
            oid, excluded.get(oid)))


def test_build_writes_no_passage_secret_query_or_home_path():
    with tempfile.TemporaryDirectory() as tmp:
        cache = os.path.join(tmp, "cache")
        secret = "Bearer " + "a" * 26
        good = obj("mem_00000001", "用户喜欢留白")
        bad = obj("mem_00000002", secret)
        emb = FakeEmbedder()
        result = build([bad, good], cache, emb)
        check(result["status"] == "BUILT", "首次构建必须 BUILT")
        check([r["object_id"] for r in result["rows"]] == [good["id"]],
              "secret 对象不得产生 row")
        inputs = "\n".join(text for call in emb.calls for text in call)
        check(secret not in inputs, "secret 不得进入模型输入")
        check("用户喜欢留白" in inputs, "允许对象 passage 应进入模型输入")
        for root, _, files in os.walk(cache):
            for name in files:
                data = open(os.path.join(root, name), "rb").read()
                check(secret.encode("utf-8") not in data,
                      "secret 不得写入派生缓存")
                check("用户喜欢留白".encode("utf-8") not in data,
                      "passage 正文不得写入派生缓存")
                check(tmp.encode("utf-8") not in data,
                      "用户/缓存绝对路径不得写入 manifest")
        manifest, rows = VI.load_current_index(cache, MODEL_DIGEST)
        check(manifest["included_object_count"] == 1, "included count 错误")
        check(manifest["excluded_reason_counts"] == {
            VI.RC_SECRET_DETECTED: 1}, "排除计数错误")
        vector_path = os.path.join(
            cache, "indexes", manifest["generation_id"], "vectors.f32")
        check(os.path.getsize(vector_path) == VI.DIMENSION * 4,
              "vectors.f32 大小必须严格等于 rows*384*4")
        check(len(rows) == 1, "row 数错误")


def test_fixed_batch_32_and_float_contract_guards():
    with tempfile.TemporaryDirectory() as tmp:
        objects = [obj("mem_%08x" % i, "内容 %d" % i) for i in range(65)]
        emb = FakeEmbedder()
        build(objects, os.path.join(tmp, "cache"), emb)
        check([len(call) for call in emb.calls] == [32, 32, 1],
              "索引调用必须固定按 32/32/1 分批")
    with tempfile.TemporaryDirectory() as tmp:
        expect_raise(lambda: build(
            [obj("mem_00000001")], os.path.join(tmp, "cache"),
            FakeEmbedder("dimension")), "EMBEDDING_DIMENSION")
    with tempfile.TemporaryDirectory() as tmp:
        expect_raise(lambda: build(
            [obj("mem_00000001")], os.path.join(tmp, "cache"),
            FakeEmbedder("norm")), "L2_NORMALIZED")


def test_generation_is_idempotent_and_self_checked():
    with tempfile.TemporaryDirectory() as tmp:
        cache = os.path.join(tmp, "cache")
        emb = FakeEmbedder()
        first = build([obj("mem_00000001")], cache, emb)
        second = build([obj("mem_00000001")], cache, emb)
        check(second["status"] == "REUSED", "相同输入应复用有效 generation")
        check(second["generation_id"] == first["generation_id"],
              "重复构建不得无意义切换 generation")
        check(len(emb.calls) == 1, "复用不得再次调用模型")
        VI.verify_generation(cache, first["generation_id"], MODEL_DIGEST)


def test_interrupted_build_preserves_previous_current():
    with tempfile.TemporaryDirectory() as tmp:
        cache = os.path.join(tmp, "cache")
        first = build([obj("mem_00000001", "旧内容")], cache)
        VI.mark_dirty(cache, "TEST_CHANGE", ["mem_00000001"])

        def fail(stage, context):
            if stage == "before_current_switch":
                raise RuntimeError("simulated power loss")

        expect_raise(lambda: build(
            [obj("mem_00000001", "新内容")], cache,
            FakeEmbedder(), fault_hook=fail), "simulated power loss")
        manifest, _ = VI.load_current_index(cache, MODEL_DIGEST)
        check(manifest["generation_id"] == first["generation_id"],
              "中断不得切换 CURRENT")
        staging = [name for name in os.listdir(os.path.join(cache, "indexes"))
                   if name.startswith(".staging-")]
        check(staging == [], "中断后不得遗留半 generation")
        check(os.path.isfile(os.path.join(cache, "DIRTY.json")),
              "失败后 dirty marker 必须保留")


def test_tamper_old_manifest_and_model_mismatch_fail_closed():
    with tempfile.TemporaryDirectory() as tmp:
        cache = os.path.join(tmp, "cache")
        result = build([obj("mem_00000001")], cache)
        gp = os.path.join(cache, "indexes", result["generation_id"])
        with open(os.path.join(gp, "vectors.f32"), "ab") as fh:
            fh.write(b"x")
        expect_raise(lambda: VI.load_current_index(cache, MODEL_DIGEST),
                     "INDEX_FILE_SIZE_MISMATCH")
    with tempfile.TemporaryDirectory() as tmp:
        cache = os.path.join(tmp, "cache")
        build([obj("mem_00000001")], cache)
        expect_raise(lambda: VI.load_current_index(cache, "b" * 64),
                     "MODEL_MANIFEST_DIGEST_MISMATCH")


def test_old_serializer_manifest_is_rejected_even_with_valid_self_hash():
    with tempfile.TemporaryDirectory() as tmp:
        cache = os.path.join(tmp, "cache")
        result = build([obj("mem_00000001")], cache)
        path = os.path.join(
            cache, "indexes", result["generation_id"], "INDEX-MANIFEST.json")
        manifest = json.load(open(path, "r", encoding="utf-8"))
        manifest["passage_serializer_version"] = "legacy-passage-v0"
        manifest["self_hash"] = VI._manifest_self_hash(manifest)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(
                manifest, ensure_ascii=False, sort_keys=True,
                separators=(",", ":")) + "\n")
        expect_raise(lambda: VI.verify_generation(
            cache, result["generation_id"], MODEL_DIGEST),
            "SERIALIZER_VERSION_MISMATCH")


def test_dirty_marker_full_rebuild_and_cache_recovery():
    with tempfile.TemporaryDirectory() as tmp:
        cache = os.path.join(tmp, "cache")
        first = build([obj("mem_00000001")], cache)
        VI.mark_dirty(cache, "SUPERSEDE", ["mem_00000001"])
        check(os.path.isfile(os.path.join(cache, "DIRTY.json")),
              "对象变化须标记 dirty")
        second = build([obj("mem_00000001")], cache)
        check(second["status"] == "BUILT", "dirty 后必须全量重建")
        check(second["generation_id"] != first["generation_id"],
              "dirty 后必须切换新 generation")
        check(not os.path.exists(os.path.join(cache, "DIRTY.json")),
              "成功切换后才可清 dirty")
        shutil.rmtree(cache)
        third = build([obj("mem_00000001")], cache)
        check(third["status"] == "BUILT", "删除全部缓存后须可从对象重建")


def test_store_write_marks_only_explicitly_configured_external_cache():
    old_repo = paths.REPO
    with tempfile.TemporaryDirectory() as tmp:
        repo = os.path.join(tmp, "repo")
        cache = os.path.join(tmp, "cache")
        os.makedirs(os.path.join(repo, "memory", "objects"))
        for name in ("index.json", "object-index.json"):
            with open(os.path.join(repo, "memory", name), "w", encoding="utf-8") as fh:
                json.dump({}, fh)
        with open(os.path.join(repo, "sync.config.json"), "w", encoding="utf-8") as fh:
            json.dump({"repo": repo, "vector_cache_dir": cache}, fh)
        try:
            paths.set_repo(repo)
            store.save_object(obj("mem_00000001"))
            marker = json.load(open(
                os.path.join(cache, "DIRTY.json"), "r", encoding="utf-8"))
            check(marker["object_ids"] == ["mem_00000001"],
                  "canonical 写入必须标记对应对象 dirty")
        finally:
            paths.set_repo(old_repo)


def test_canonical_write_is_blocked_while_index_build_lock_is_held():
    old_repo = paths.REPO
    with tempfile.TemporaryDirectory() as tmp:
        repo = os.path.join(tmp, "repo")
        cache = os.path.join(tmp, "cache")
        os.makedirs(os.path.join(repo, "memory", "objects"))
        os.makedirs(cache)
        for name in ("index.json", "object-index.json"):
            with open(os.path.join(repo, "memory", name), "w",
                      encoding="utf-8") as fh:
                json.dump({}, fh)
        with open(os.path.join(repo, "sync.config.json"), "w",
                  encoding="utf-8") as fh:
            json.dump({"repo": repo, "vector_cache_dir": cache}, fh)
        open(os.path.join(cache, "BUILD.lock"), "w").close()
        try:
            paths.set_repo(repo)
            expect_raise(lambda: store.save_object(obj("mem_00000001")),
                         "ALREADY_RUNNING", VI.VectorIndexBusy)
            check(not os.path.exists(os.path.join(
                repo, "memory", "objects", "mem_00000001.json")),
                "构建锁期间 canonical 写入必须在落盘前 fail-closed")
        finally:
            paths.set_repo(old_repo)


def test_concurrent_build_and_forbidden_cache_fail_closed():
    with tempfile.TemporaryDirectory() as tmp:
        cache = os.path.join(tmp, "cache")
        os.makedirs(cache)
        open(os.path.join(cache, "BUILD.lock"), "w").close()
        expect_raise(lambda: build([obj("mem_00000001")], cache),
                     "ALREADY_RUNNING", VI.VectorIndexBusy)
    forbidden = os.path.join(paths.REPO, "memory", "vector-cache")
    expect_raise(lambda: build([obj("mem_00000001")], forbidden),
                 "INSIDE_REPOSITORY", VI.VectorIndexError)


def test_dead_pid_build_lock_is_auto_healed_but_malformed_is_not():
    with tempfile.TemporaryDirectory() as tmp:
        cache = os.path.join(tmp, "cache")
        os.makedirs(cache)
        with open(os.path.join(cache, "BUILD.lock"), "w",
                  encoding="ascii") as fh:
            fh.write("pid=2147483647\nstarted=2000-01-01T00:00:00Z\n")
        result = build([obj("mem_00000001")], cache)
        check(result["status"] == "BUILT", "死亡 PID 锁应自动修复")
    with tempfile.TemporaryDirectory() as tmp:
        cache = os.path.join(tmp, "cache")
        os.makedirs(cache)
        with open(os.path.join(cache, "BUILD.lock"), "w",
                  encoding="ascii") as fh:
            fh.write("malformed\n")
        expect_raise(lambda: build([obj("mem_00000001")], cache),
                     "ALREADY_RUNNING", VI.VectorIndexBusy)


def test_cache_permission_hardening_keeps_current_identity_usable():
    with tempfile.TemporaryDirectory() as tmp:
        cache = os.path.join(tmp, "cache")
        os.makedirs(cache)
        probe = os.path.join(cache, "probe.txt")
        with open(probe, "w", encoding="utf-8") as fh:
            fh.write("ok")
        report = VI.harden_cache_permissions(cache)
        check(report["mode"] in (
            "posix-0700-0600", "windows-protected-dacl"),
            "权限模式报告错误")
        check(open(probe, "r", encoding="utf-8").read() == "ok",
              "收紧权限后执行主体必须仍可读")
        with open(os.path.join(cache, "write-probe"), "w",
                  encoding="utf-8") as fh:
            fh.write("ok")


def test_build_does_not_modify_canonical_objects_or_indexes():
    with tempfile.TemporaryDirectory() as tmp:
        repo = os.path.join(tmp, "repo")
        cache = os.path.join(tmp, "cache")
        objects_dir = os.path.join(repo, "memory", "objects")
        os.makedirs(objects_dir)
        memory_obj = obj("mem_00000001")
        with open(os.path.join(objects_dir, "mem_00000001.json"), "w",
                  encoding="utf-8") as fh:
            json.dump(memory_obj, fh, ensure_ascii=False)
        for name in ("index.json", "object-index.json"):
            with open(os.path.join(repo, "memory", name), "w", encoding="utf-8") as fh:
                json.dump({"sentinel": name}, fh)
        before = VI.canonical_object_snapshot(repo)
        build([memory_obj], cache)
        after = VI.canonical_object_snapshot(repo)
        check(after == before, "派生索引构建不得修改 canonical 文件")


TESTS = [
    test_passage_serializer_is_deterministic_and_visible_only,
    test_pre_embedding_filter_exact_allowed_set_and_reason_codes,
    test_build_writes_no_passage_secret_query_or_home_path,
    test_fixed_batch_32_and_float_contract_guards,
    test_generation_is_idempotent_and_self_checked,
    test_interrupted_build_preserves_previous_current,
    test_tamper_old_manifest_and_model_mismatch_fail_closed,
    test_old_serializer_manifest_is_rejected_even_with_valid_self_hash,
    test_dirty_marker_full_rebuild_and_cache_recovery,
    test_store_write_marks_only_explicitly_configured_external_cache,
    test_canonical_write_is_blocked_while_index_build_lock_is_held,
    test_concurrent_build_and_forbidden_cache_fail_closed,
    test_dead_pid_build_lock_is_auto_healed_but_malformed_is_not,
    test_cache_permission_hardening_keeps_current_identity_usable,
    test_build_does_not_modify_canonical_objects_or_indexes,
]


def main():
    failures = 0
    for fn in TESTS:
        try:
            fn()
            print("PASS %s" % fn.__name__)
        except Exception as exc:
            failures += 1
            print("FAIL %s: %s" % (fn.__name__, exc))
    print("----")
    print("%d test(s), %d failure(s)" % (len(TESTS), failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
