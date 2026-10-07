"""Repository-relative, request-local M2 scoped metadata consumer.

Frozen v0.1 source/fixtures are immutable inputs. No sys.modules/sys.path writes,
global monkeypatch, model, generator, live backend or domain issuer is provided.
"""
from __future__ import annotations
import argparse
import builtins
import copy
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re
import types

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_RELATIVE = "development/contracts/model-program/stage-admission/m2-scoped-successor"
FIXTURE_RELATIVE = "tests/fixtures/model-stage-admission/pr441-e76a7"
SOURCE_LOCK_SHA = "8780055e39f00ba8308d4ecdc00f5523186d0803e466baf371105cb1c863f472"
PREPARER_SHA = "42b8be9f088592d1042801ffc667f1a10a09d70d6f15dbb14b1071d3ace2b7f6"
PREPARATION_SHA = "636c7add97638235859163ff880339ed9090a7b8211628ea5ad18cc970d19291"
OWNER_RULE = {"decision_id": "07696647-1557-4b0d-9eed-c1f698f4b011", "version": 1,
              "receipt_id": "7313df9c-b97f-4d90-beb6-f43d32cf469c"}
SCHEMA = "clued.model-m2-scoped-consumer-envelope/1"
CONSUMERS = ("split_mapping", "dataset_split", "dataset_foundation", "adopted_definition")
MAX_BYTES = 262144
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
FIXED_KEYS = ("candidate_revision_sha256", "calibrator_revision", "threshold_policy_revision",
              "workflow_revision", "scorer_revision", "prompt_revision", "schema_revision")
USE_KEYS = {"weight_learning", "prompt_or_architecture_tuning", "calibration_fit", "selection"}
PURPOSE_USES = {"training": {"weight_learning"}, "development": {"prompt_or_architecture_tuning", "selection"},
                "calibration_fit": {"calibration_fit"}, "selection_policy_validation": {"selection"},
                "qualification": set(), "final_holdout": set()}


class ScopedError(ValueError):
    def __init__(self, code):
        self.code = "CLUED_MODEL_M2_SCOPED_" + code
        super().__init__(self.code)


def require(condition, code):
    if not condition:
        raise ScopedError(code)


def exact(value, keys, code):
    require(type(value) is dict and set(value) == set(keys), code)
    return value


def checked(path, pin):
    raw = path.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == pin, "SOURCE_BYTE_DRIFT")
    return raw


def strict_json(raw):
    require(type(raw) is bytes and len(raw) <= MAX_BYTES, "JSON_BYTE_BOUND")
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "DUPLICATE_JSON_KEY")
            result[key] = value
        return result
    def nonfinite(_value):
        raise ScopedError("NONFINITE_JSON")
    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=nonfinite)


class VerificationContext:
    """One invocation's frozen bytes and module graph; never registered globally.

    A private builtins dictionary resolves only the original intra-M2 imports.
    External library imports use Python's ordinary import lock, unchanged. Every
    old function body and import statement is compiled from its exact raw bytes.
    """
    def __init__(self, repo_root=REPO_ROOT):
        self.root = Path(repo_root).resolve()
        self.fixture = self.root / FIXTURE_RELATIVE
        self.contract_dir = self.root / CONTRACT_RELATIVE
        try:
            require(importlib.metadata.version("jsonschema") == "4.25.1", "SCHEMA_LIBRARY_VERSION")
        except importlib.metadata.PackageNotFoundError:
            raise ScopedError("SCHEMA_LIBRARY_UNAVAILABLE") from None
        lock = strict_json(checked(self.contract_dir / "SourceLock.e76a7.json", SOURCE_LOCK_SHA))
        require(lock["commit"] == "e76a7db7edc6b47b5a719e165f688621efa9580a" and
                lock["source_role"] == "SourceCopiedRead" and lock["authority_effect"] == "NONE", "FROZEN_SOURCE_SCOPE")
        self.sources, self.paths, self.modules, self.loading = {}, {}, {}, set()
        for row in lock["files"]:
            relative = Path(row["path"])
            require(not relative.is_absolute() and ".." not in relative.parts, "LOCK_PATH")
            path = self.fixture / relative
            require(path.resolve().is_relative_to(self.fixture.resolve()), "LOCK_PATH")
            raw = checked(path, row["sha256"])
            require(len(raw) == row["bytes"] and
                    hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest() == row["git_blob_sha1"],
                    "FROZEN_GIT_BLOB_IDENTITY")
            self.sources[row["path"]] = raw
            if row["path"].startswith("scripts/model-program/"):
                self.paths[path.stem] = path
        preparer_path = self.root / "scripts/model-program/prepare_m2_stage_binding.py"
        self.preparer = self._compile("prepare_m2_stage_binding", preparer_path, checked(preparer_path, PREPARER_SHA))
        self.preparation = strict_json(checked(self.root / "development/contracts/model-program/stage-admission/M2StageBindingPreparation.v0.1.json", PREPARATION_SHA))
        self.contract = strict_json((self.contract_dir / "M2ScopedSuccessor.v0.2.json").read_bytes())
        self.validate_contract()

    def validate_contract(self):
        value = exact(self.contract, ("schema", "version", "status", "owner_rule", "consumers", "envelope_schema",
            "source_lock_sha256", "preparation_contract_sha256", "preparer_sha256", "fixture_root", "jsonschema_version",
            "authority_effect", "live_backend_configured", "domain_authority_receipt", "m2_verdict", "m3_verdict"), "CONTRACT_SHAPE")
        require(value["schema"] == "clued.model-m2-scoped-successor-contract/1" and value["version"] == "v0.2" and
                value["status"] == "ENGINEERING_CONSUMER_NOT_FORMAL_ACCEPTANCE" and value["owner_rule"] == OWNER_RULE and
                type(value["owner_rule"].get("version")) is int and value["consumers"] == list(CONSUMERS) and
                value["envelope_schema"] == SCHEMA and value["source_lock_sha256"] == SOURCE_LOCK_SHA and
                value["preparation_contract_sha256"] == PREPARATION_SHA and value["preparer_sha256"] == PREPARER_SHA and
                value["fixture_root"] == FIXTURE_RELATIVE and value["jsonschema_version"] == "4.25.1", "CONTRACT_IDENTITY")
        require(value["authority_effect"] == "NONE" and value["live_backend_configured"] is False and
                all(value[key] == "NOT_ISSUED" for key in ("domain_authority_receipt", "m2_verdict", "m3_verdict")),
                "CONTRACT_AUTHORITY_FORBIDDEN")

    def _import(self, name, globals=None, locals=None, fromlist=(), level=0):
        if level == 0 and name in self.paths:
            return self.module(name)
        return builtins.__import__(name, globals, locals, fromlist, level)

    def _compile(self, name, path, raw):
        module = types.ModuleType("request_local_m2." + name)
        module.__file__ = str(path)
        module.__package__ = ""
        local_builtins = dict(vars(builtins))
        local_builtins["__import__"] = self._import
        module.__dict__["__builtins__"] = local_builtins
        exec(compile(raw, str(path), "exec"), module.__dict__)
        return module

    def module(self, name):
        require(name in self.paths, "UNKNOWN_LEGACY_MODULE")
        if name not in self.modules:
            require(name not in self.loading, "LEGACY_IMPORT_CYCLE")
            path = self.paths[name]
            relative = "scripts/model-program/" + name + ".py"
            self.loading.add(name)
            try:
                self.modules[name] = self._compile(name, path, self.sources[relative])
            finally:
                self.loading.remove(name)
        return self.modules[name]

    def stage_binding(self, split, binding, scope_id):
        exact(binding, ("scope_id", "request"), "STAGE_BINDING_SHAPE")
        require(binding["scope_id"] == scope_id, "POOL_OR_CANDIDATE_SCOPE_MISMATCH")
        request = binding["request"]
        source_bytes = {path: self.sources[path] for path in self.preparer.PINS}
        result = self.preparer.prepare_binding(request, source_bytes, self.preparation)
        if split is not None:
            purpose = request["purpose_id"]
            require(split.get("experiment_scope") == scope_id, "SPLIT_EXPERIMENT_SCOPE")
            require(split.get("purpose_id") == purpose and split.get("parent_boundary") == request["parent_boundary"],
                    "SPLIT_PURPOSE_OR_PARENT")
            uses = split.get("allowed_uses")
            require(type(uses) is dict and set(uses) == USE_KEYS and all(type(v) is bool for v in uses.values()) and
                    {key for key, value in uses.items() if value} == PURPOSE_USES[purpose], "PURPOSE_USE_CROSS_BINDING")
            require(split.get("final_holdout") is (purpose == "final_holdout"), "FINAL_HOLDOUT_CROSS_BINDING")
            old_fixed, fixed = split.get("fixed_candidate_binding"), request["fixed_candidate_binding"]
            if fixed is None:
                require(old_fixed is None, "NON_FIXED_PURPOSE_CANDIDATE_BINDING")
            else:
                require(all(fixed[key] is not None for key in FIXED_KEYS), "FIXED_CANDIDATE_REFERENCE_REQUIRED")
                require(type(old_fixed) is dict and set(old_fixed) == set(FIXED_KEYS) and
                        old_fixed == {key: fixed[key] for key in FIXED_KEYS}, "CANDIDATE_SNAPSHOT_CROSS_BINDING")
        return result

    def scoped_inputs(self, envelope, consumer):
        exact(envelope, ("schema_version", "version", "consumer", "payload", "owner_rule",
            "preparation_contract_sha256", "scope_id", "stage_bindings"), "V02_ENVELOPE_SHAPE")
        require(envelope["schema_version"] == SCHEMA and envelope["version"] == "v0.2" and
                envelope["consumer"] == consumer, "V02_DISPATCH_IDENTITY")
        require(type(envelope["owner_rule"]) is dict and envelope["owner_rule"] == OWNER_RULE and
                type(envelope["owner_rule"].get("version")) is int and
                envelope["preparation_contract_sha256"] == PREPARATION_SHA, "OWNER_RULE_OR_PREPARATION_BINDING")
        scope = envelope["scope_id"]
        require(type(scope) is str and ID.fullmatch(scope), "SCOPE_ID")
        bindings, payload = envelope["stage_bindings"], envelope["payload"]
        require(type(bindings) is dict and 0 < len(bindings) <= 64, "STAGE_BINDINGS_BOUND")
        if consumer in ("dataset_foundation", "adopted_definition"):
            require(type(payload) is dict and type(payload.get("manifest")) is dict and
                    type(payload["manifest"].get("splits")) is list, "LEGACY_BUNDLE_SHAPE")
            splits = payload["manifest"]["splits"]
            require(0 < len(splits) <= 64 and all(type(s) is dict and type(s.get("split_id")) is str for s in splits), "SPLIT_LIST_BOUND")
            by_id = {s["split_id"]: s for s in splits}
            require(len(by_id) == len(splits) and set(bindings) == set(by_id), "EXACT_SPLIT_STAGE_COVERAGE")
        elif consumer == "dataset_split":
            require(type(payload) is dict and type(payload.get("split_id")) is str and
                    set(bindings) == {payload["split_id"]}, "EXACT_SINGLE_SPLIT_COVERAGE")
            by_id = {payload["split_id"]: payload}
        else:
            require(set(bindings) == {"mapping_scope"}, "EXACT_MAPPING_SCOPE")
            by_id = {"mapping_scope": None}
        return {split_id: self.stage_binding(by_id[split_id], value, scope) for split_id, value in bindings.items()}

    def legacy_validate(self, consumer, payload):
        if consumer == "split_mapping":
            self.module("validate_m2_split_mapping").validate_candidate(payload)
        elif consumer == "dataset_split":
            split = self.module("validate_m2_dataset_split")
            reference, definition = split.validate_domain_candidate()
            self.module("validate_m2_dataset_foundation").validate_schema("DatasetSplit.candidate.schema.json", payload)
            split.validate_split_binding(payload, reference, definition)
        elif consumer == "dataset_foundation":
            self.module("validate_m2_dataset_foundation").validate_bundle(payload)
        else:
            self.module("validate_m2_adopted_definition").validate_adopted_bundle(payload)


def validate_envelope(envelope, consumer, *, repo_root=REPO_ROOT, require_domain_authority=False, require_live_currentness=False):
    require(type(consumer) is str and consumer in CONSUMERS, "UNKNOWN_CONSUMER")
    require(type(require_domain_authority) is bool and type(require_live_currentness) is bool, "AUTHORITY_OPTION_TYPE")
    require(not require_domain_authority, "DOMAIN_AUTHORITY_CAPABILITY_UNAVAILABLE")
    require(not require_live_currentness, "LIVE_CURRENTNESS_CAPABILITY_UNAVAILABLE")
    require(type(envelope) is dict, "ENVELOPE_SHAPE")
    version = envelope.get("version")
    if version == "v0.1":
        exact(envelope, ("schema_version", "version", "consumer", "payload"), "V01_ENVELOPE_SHAPE")
        require(envelope["schema_version"] == SCHEMA and envelope["consumer"] == consumer, "V01_DISPATCH_IDENTITY")
    elif version != "v0.2":
        raise ScopedError("UNKNOWN_VERSION_NO_FALLBACK")
    try:
        context = VerificationContext(repo_root)
        scoped = context.scoped_inputs(envelope, consumer) if version == "v0.2" else {}
        context.legacy_validate(consumer, copy.deepcopy(envelope["payload"]))
    except ScopedError:
        raise
    except (OSError, ImportError):
        raise ScopedError("SOURCE_OR_SCHEMA_DEPENDENCY_UNAVAILABLE") from None
    except (KeyError, TypeError, ValueError, RecursionError) as exc:
        code = getattr(exc, "code", "INVALID_INPUT").removeprefix("CLUED_MODEL_M2_")
        raise ScopedError("LEGACY_OR_SCOPED_GUARD_REJECTED_" + code) from None
    return {"status": "SCOPED_OFFLINE_CANDIDATE_CHECKS_ONLY", "consumer": consumer, "version": version,
            "legacy_guards": "UNCHANGED_ORIGINAL_CONSUMER_COMPLETED", "scoped_bindings": scoped,
            "execution_ready": False, "actual_execution": "NONE", "authority_effect": "NONE",
            "domain_authority_receipt": "NOT_ISSUED", "data_gate": "NOT_ISSUED", "m2_verdict": "NOT_ISSUED",
            "m3_verdict": "NOT_ISSUED", "actual_pool_freeze_verified": False, "question_generation": False}


def main(consumer, argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("envelope", type=Path)
    parser.add_argument("--require-domain-authority", action="store_true")
    parser.add_argument("--require-live-currentness", action="store_true")
    args = parser.parse_args(argv)
    try:
        with args.envelope.open("rb") as stream:
            raw = stream.read(MAX_BYTES + 1)
        result = validate_envelope(strict_json(raw), consumer,
            require_domain_authority=args.require_domain_authority, require_live_currentness=args.require_live_currentness)
    except (ScopedError, OSError, ValueError, KeyError, TypeError, ImportError, RecursionError) as exc:
        print(json.dumps({"status": "SCOPED_CANDIDATE_REJECTED", "error": exc.code if isinstance(exc, ScopedError) else
            "CLUED_MODEL_M2_SCOPED_INVALID_INPUT", "execution_ready": False, "actual_execution": "NONE",
            "authority_effect": "NONE", "domain_authority_receipt": "NOT_ISSUED", "m2_verdict": "NOT_ISSUED", "m3_verdict": "NOT_ISSUED"}, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0
