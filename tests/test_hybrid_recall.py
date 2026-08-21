#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""R4 Gate 0-D: incremental OR, deterministic rank, trace and fallback."""

import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from memory_engine import hybrid_recall as HR  # noqa: E402
from memory_engine import paths  # noqa: E402
from memory_engine import recall_engine  # noqa: E402
from memory_engine import schema as S  # noqa: E402
from memory_engine import store  # noqa: E402
from memory_engine import vector_index as VI  # noqa: E402


MODEL_DIGEST = "c" * 64


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def expect_raise(fn, contains=None):
    try:
        fn()
    except Exception as exc:
        if contains:
            check(contains in str(exc), "异常不含 %s: %s" % (contains, exc))
        return exc
    raise AssertionError("预期异常但未抛出")


def make_obj(oid, content, category="preference", layer="L2",
             scope="global", project_id=None, priority="medium",
             evidence="explicit", updated="2026-08-21T00:00:00Z"):
    value = S.new_object(
        oid, "semantic", content, scope=scope, status="active",
        category=category, evidence=evidence, priority=priority,
        recall_layer=layer, created_at=updated, project_id=project_id,
        tags=[], entities=[])
    return value


class RepoFixture(object):
    def __init__(self, objects):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.tmp.name, "repo")
        self.cache = os.path.join(self.tmp.name, "vector-cache")
        self.old_repo = paths.REPO
        os.makedirs(os.path.join(self.root, "memory", "objects"))
        os.makedirs(os.path.join(self.root, "memory", "audit"))
        with open(os.path.join(self.root, "memory", "index.json"), "w",
                  encoding="utf-8") as fh:
            json.dump({
                "schema_version": 1,
                "files": [],
                "recall": {"L1": [], "L2": [], "L3": [],
                           "L4": [], "L5": [], "L6": []},
            }, fh)
        with open(os.path.join(self.root, "memory", "object-index.json"), "w",
                  encoding="utf-8") as fh:
            json.dump({"schema_version": 1, "objects": []}, fh)
        paths.set_repo(self.root)
        for value in objects:
            store.save_object(value)

    def close(self):
        paths.set_repo(self.old_repo)
        self.tmp.cleanup()


class FakeRuntime(object):
    def __init__(self, scores=None, error=None):
        self.scores = dict(scores or {})
        self.error = error
        self.calls = []

    def score(self, query, candidate_ids, canonical_objects, valid_at=None):
        self.calls.append({
            "query": query,
            "candidate_ids": list(candidate_ids),
            "canonical_count": len(canonical_objects),
        })
        if self.error:
            raise self.error
        return {oid: self.scores[oid] for oid in candidate_ids}

    def trace_model(self):
        return {
            "id": "test/e5",
            "immutable_revision": "f" * 40,
            "manifest_digest": MODEL_DIGEST,
        }


class BombRuntime(FakeRuntime):
    def score(self, *args, **kwargs):
        raise AssertionError("vector runtime must not be called")


def recall(**kw):
    args = {
        "query": "query",
        "tier": "T2",
        "layers": ["L2"],
        "limit": 10,
    }
    args.update(kw)
    return recall_engine.recall(**args)


def test_default_off_is_byte_equivalent_and_never_calls_runtime():
    fx = RepoFixture([make_obj("mem_00000001", "喜欢 蓝色")])
    try:
        baseline = recall(query="喜欢 蓝色").to_dict()
        off = recall(query="喜欢 蓝色", semantic_mode="off",
                     vector_runtime=BombRuntime()).to_dict()
        check(json.dumps(off, ensure_ascii=False, sort_keys=True) ==
              json.dumps(baseline, ensure_ascii=False, sort_keys=True),
              "默认 off 必须与原 MIV-005A 字节等价")
    finally:
        fx.close()


def test_t0_t4_and_temporary_skip_model_and_cache():
    fx = RepoFixture([make_obj("mem_00000001", "anything")])
    runtime = BombRuntime()
    try:
        t0 = recall_engine.recall(
            "math", tier="T0", semantic_mode="test",
            vector_runtime=runtime, alpha=0.5, tau=0.2)
        t4 = recall_engine.recall(
            "remember", tier="T4", semantic_mode="test",
            vector_runtime=runtime, alpha=0.5, tau=0.2)
        temp = recall_engine.recall(
            "temp", tier="T2", scope="temporary", semantic_mode="test",
            vector_runtime=runtime, alpha=0.5, tau=0.2)
        check(t0.objects == [] and t4.objects == [] and temp.objects == [],
              "零读取路径必须保持空召回")
    finally:
        fx.close()


def test_incremental_or_and_strict_tau_equality():
    exact = make_obj("mem_00000001", "完全无关甲")
    above = make_obj("mem_00000002", "完全无关乙")
    fx = RepoFixture([exact, above])
    runtime = FakeRuntime({exact["id"]: 0.20, above["id"]: 0.200001})
    try:
        result = recall(
            query="不存在的词", semantic_mode="test", vector_runtime=runtime,
            alpha=0.5, tau=0.20, explain=True)
        check([o["id"] for o in result.objects] == [above["id"]],
              "cosine==tau 必须排除，严格大于才准入")
        check(result.trace["selected"][0]["admission_source"] == "VECTOR",
              "向量独立准入来源错误")
    finally:
        fx.close()


def test_lexical_admission_cannot_be_cancelled_by_low_cosine():
    lexical = make_obj("mem_00000001", "用户 喜欢 蓝色")
    vector = make_obj("mem_00000002", "完全不同")
    fx = RepoFixture([lexical, vector])
    runtime = FakeRuntime({lexical["id"]: -0.8, vector["id"]: 0.95})
    try:
        result = recall(
            query="喜欢 蓝色", semantic_mode="test", vector_runtime=runtime,
            alpha=0.5, tau=0.9, explain=True)
        ids = [o["id"] for o in result.objects]
        check(lexical["id"] in ids, "词法准入不得被低 cosine 取消")
        trace = {e["memory_id"]: e for e in result.trace["selected"]}
        check(trace[lexical["id"]]["admission_source"] == "LEXICAL",
              "词法保留来源错误")
    finally:
        fx.close()


def test_scope_and_conflict_filter_before_vector_scoring():
    winner = make_obj(
        "mem_00000001", "项目 A 当前方案", category="project", layer="L3",
        scope="project", project_id="A")
    loser = make_obj(
        "mem_00000002", "项目 A 旧方案", category="project", layer="L3",
        scope="project", project_id="A", evidence="inferred")
    other = make_obj(
        "mem_00000003", "项目 B 相似方案", category="project", layer="L3",
        scope="project", project_id="B")
    winner["relations"]["contradicts"] = [loser["id"]]
    fx = RepoFixture([winner, loser, other])
    runtime = FakeRuntime({winner["id"]: 0.8})
    try:
        result = recall_engine.recall(
            "方案", tier="T2", layers=["L3"], scope="project_only",
            project_id="A", semantic_mode="test", vector_runtime=runtime,
            alpha=0.5, tau=0.2, explain=True)
        check(runtime.calls[0]["candidate_ids"] == [winner["id"]],
              "跨项目对象和 conflict loser 均不得进入 cosine")
        encoded = json.dumps(result.trace, ensure_ascii=False)
        check(HR.RC_CONFLICT_LOSER in encoded, "Trace 必须记录 conflict loser")
    finally:
        fx.close()


def test_secret_denied_and_temporary_are_excluded_before_any_scoring():
    good = make_obj("mem_00000001", "safe memory")
    secret = make_obj("mem_00000002", "Bearer " + "z" * 26)
    denied = make_obj("mem_00000003", "denied memory")
    denied["denied"] = True
    temporary = make_obj("mem_00000004", "temporary memory")
    temporary["type"] = "temporary"
    fx = RepoFixture([good, secret, denied, temporary])
    runtime = FakeRuntime({good["id"]: 0.8})
    try:
        result = recall(
            query="unmatched", semantic_mode="test", vector_runtime=runtime,
            alpha=0.5, tau=0.2, explain=True)
        check(runtime.calls[0]["candidate_ids"] == [good["id"]],
              "secret/denied/temporary 不得进入任何语义评分")
        encoded = json.dumps(result.trace, ensure_ascii=False)
        check(VI.RC_SECRET_DETECTED in encoded and
              VI.RC_ACCESS_DENIED in encoded and
              VI.RC_TEMPORARY_OBJECT in encoded,
              "去正文 Trace 必须保留稳定排除 reason code")
        check("Bearer " not in encoded and "temporary memory" not in encoded,
              "排除对象正文/secret 不得进入 Trace")
    finally:
        fx.close()


def test_hybrid_tie_break_is_exact_and_deterministic():
    values = [
        make_obj("mem_00000004", "none 4", priority="medium",
                 evidence="explicit", updated="2026-08-20T00:00:00Z"),
        make_obj("mem_00000003", "none 3", priority="medium",
                 evidence="explicit", updated="2026-08-21T00:00:00Z"),
        make_obj("mem_00000002", "none 2", priority="medium",
                 evidence="explicit", updated="2026-08-21T00:00:00Z"),
        make_obj("mem_00000001", "none 1", priority="high",
                 evidence="inferred", updated="2026-08-19T00:00:00Z"),
    ]
    fx = RepoFixture(values)
    runtime = FakeRuntime({value["id"]: 0.9 for value in values})
    try:
        result = recall(
            query="unmatched", semantic_mode="test", vector_runtime=runtime,
            alpha=0.5, tau=0.2)
        check([o["id"] for o in result.objects] == [
            "mem_00000001", "mem_00000002", "mem_00000003", "mem_00000004"],
            "tie-break 必须 hybrid/priority/evidence/updated DESC, id ASC")
    finally:
        fx.close()


def test_runtime_failure_falls_back_byte_exact_and_trace_is_sanitized():
    value = make_obj("mem_00000001", "用户 喜欢 蓝色")
    fx = RepoFixture([value])
    broken = FakeRuntime(error=RuntimeError("private path and query leaked"))
    query = "PRIVATE_QUERY_MARKER 喜欢 蓝色"
    try:
        baseline = recall(query=query).to_dict()
        result = recall(
            query=query, semantic_mode="shadow", vector_runtime=broken,
            alpha=0.5, tau=0.2)
        check(result.to_dict() == baseline,
              "explain=False fallback 必须与 MIV-005A 字节等价")
        check(result.semantic_status == HR.FB_MODEL_ERROR,
              "fallback reason code 错误")
        traced = recall(
            query=query, semantic_mode="shadow", vector_runtime=broken,
            alpha=0.5, tau=0.2, explain=True)
        encoded = json.dumps(traced.trace, ensure_ascii=False)
        check(traced.trace["fallback_code"] == HR.FB_MODEL_ERROR,
              "Trace 必须给稳定 fallback code")
        check(query not in encoded and "用户 喜欢 蓝色" not in encoded,
              "Hybrid Trace 不得含 query 或正文")
        check("source_ref" not in encoded and "vector" not in encoded.lower(),
              "Hybrid Trace 不得含来源路径或向量")
    finally:
        fx.close()


class UnitEmbedder(object):
    dim = VI.DIMENSION
    manifest_digest = MODEL_DIGEST
    manifest = {"model": {
        "id": "intfloat/multilingual-e5-small",
        "immutable_revision": "f" * 40,
    }}

    @staticmethod
    def _row(text):
        row = [0.0] * VI.DIMENSION
        row[0 if "alpha" in text else 1] = 1.0
        return row

    def embed_passages(self, texts):
        return [self._row(text) for text in texts]

    def embed_query(self, text):
        return [self._row(text)]


def test_safe_runtime_validates_index_and_scores_bruteforce():
    alpha = make_obj("mem_00000001", "alpha memory")
    beta = make_obj("mem_00000002", "beta memory")
    fx = RepoFixture([alpha, beta])
    try:
        objects = store.load_all_objects(include_invalid=True)
        VI.build_index(
            objects, UnitEmbedder(), fx.cache, MODEL_DIGEST,
            model_revision="f" * 40, harden_permissions=False)
        runtime = HR.SafeVectorRuntime(fx.cache, UnitEmbedder(), MODEL_DIGEST)
        result = recall(
            query="alpha", semantic_mode="test", vector_runtime=runtime,
            alpha=0.0, tau=0.5)
        check([o["id"] for o in result.objects] == [alpha["id"]],
              "安全 runtime cosine 结果错误")
    finally:
        fx.close()


def test_dirty_corrupt_and_source_mismatch_all_fallback():
    value = make_obj("mem_00000001", "alpha memory")
    fx = RepoFixture([value])
    try:
        objects = store.load_all_objects(include_invalid=True)
        built = VI.build_index(
            objects, UnitEmbedder(), fx.cache, MODEL_DIGEST,
            model_revision="f" * 40, harden_permissions=False)
        runtime = HR.SafeVectorRuntime(fx.cache, UnitEmbedder(), MODEL_DIGEST)
        VI.mark_dirty(fx.cache, "TEST")
        dirty = recall(
            query="alpha", semantic_mode="test", vector_runtime=runtime,
            alpha=0.5, tau=0.2)
        check(dirty.semantic_status == HR.FB_INDEX_DIRTY,
              "dirty 必须整体 fallback")
        os.remove(os.path.join(fx.cache, "DIRTY.json"))
        changed = dict(value)
        changed["content"] = "changed memory"
        store.save_object(changed)
        mismatch = recall(
            query="alpha", semantic_mode="test", vector_runtime=runtime,
            alpha=0.5, tau=0.2)
        check(mismatch.semantic_status == HR.FB_SOURCE_MISMATCH,
              "canonical/index fingerprint 不同必须 fallback")
        # 恢复对象后篡改 vectors；完整 index 自检必须拒绝。
        store.save_object(value)
        vector_path = VI._generation_paths(
            fx.cache, built["generation_id"])["vectors"]
        with open(vector_path, "ab") as fh:
            fh.write(b"x")
        corrupt = recall(
            query="alpha", semantic_mode="test", vector_runtime=runtime,
            alpha=0.5, tau=0.2)
        check(corrupt.semantic_status == HR.FB_INDEX_UNAVAILABLE,
              "index 篡改必须整体 fallback")
    finally:
        fx.close()


def test_embedder_manifest_identity_mismatch_falls_back_as_model_error():
    value = make_obj("mem_00000001", "alpha memory")
    fx = RepoFixture([value])
    try:
        objects = store.load_all_objects(include_invalid=True)
        VI.build_index(
            objects, UnitEmbedder(), fx.cache, MODEL_DIGEST,
            model_revision="f" * 40, harden_permissions=False)
        wrong = UnitEmbedder()
        wrong.manifest_digest = "d" * 64
        runtime = HR.SafeVectorRuntime(fx.cache, wrong, MODEL_DIGEST)
        baseline = recall(query="alpha").to_dict()
        result = recall(
            query="alpha", semantic_mode="test", vector_runtime=runtime,
            alpha=0.5, tau=0.2)
        check(result.semantic_status == HR.FB_MODEL_ERROR,
              "embedder digest 不符必须归因 model fallback")
        check(result.to_dict() == baseline, "模型身份不符 fallback 必须字节等价")
    finally:
        fx.close()


def test_invalid_mode_or_parameters_fail_closed():
    fx = RepoFixture([make_obj("mem_00000001", "alpha")])
    try:
        expect_raise(lambda: recall(
            semantic_mode="production", vector_runtime=FakeRuntime(),
            alpha=0.5, tau=0.2), "semantic_mode")
        expect_raise(lambda: recall(
            semantic_mode="test", vector_runtime=FakeRuntime(),
            alpha=1.1, tau=0.2), "alpha")
        expect_raise(lambda: recall(
            semantic_mode="test", vector_runtime=FakeRuntime(),
            alpha=0.5, tau=1.1), "tau")
    finally:
        fx.close()


TESTS = [
    test_default_off_is_byte_equivalent_and_never_calls_runtime,
    test_t0_t4_and_temporary_skip_model_and_cache,
    test_incremental_or_and_strict_tau_equality,
    test_lexical_admission_cannot_be_cancelled_by_low_cosine,
    test_scope_and_conflict_filter_before_vector_scoring,
    test_secret_denied_and_temporary_are_excluded_before_any_scoring,
    test_hybrid_tie_break_is_exact_and_deterministic,
    test_runtime_failure_falls_back_byte_exact_and_trace_is_sanitized,
    test_safe_runtime_validates_index_and_scores_bruteforce,
    test_dirty_corrupt_and_source_mismatch_all_fallback,
    test_embedder_manifest_identity_mismatch_falls_back_as_model_error,
    test_invalid_mode_or_parameters_fail_closed,
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
