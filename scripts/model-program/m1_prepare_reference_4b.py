"""Fixed official 4B materials only; caller owns real authorization/currentness.

No effect runs at import, and no CLI effect/permission switch exists. Root calls
one of three phases after its actual approval checks. Hashes here bind bytes;
they do not authenticate a grant, resource observer, process runner or receipt.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import math
import os
import re
import time
import urllib.parse
import ssl
import struct
from dataclasses import dataclass
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

MODEL = "Qwen/Qwen3.5-4B"
REVISION = "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"
SOURCE_BYTES = 9342907469
NETWORK_MAX = 10 * 1024**3
STORAGE_MAX = 32 * 1024**3
RAM_MIN = 16 * 1024**3
AUXILIARY_MAX = 16 * 1024**2
CAPTURE_MAX = 1024**2
PHASE_SECONDS = {"download_verify": 21600, "convert_bf16_text": 1800, "hash_artifact": 600}
CATALOG = Path(__file__).resolve().parents[2] / "development/contracts/model-program/m1/reference4b-preparation/fixed-source-materials.json"
WORKSPACE = Path(__file__).resolve().parents[3]
MATERIAL_PARENT = WORKSPACE / "m1-4b-reference-preparation"
EXPECTED_NAMES = frozenset((
    ".gitattributes", "LICENSE", "README.md", "chat_template.jinja", "config.json",
    "merges.txt", "model.safetensors-00001-of-00002.safetensors",
    "model.safetensors-00002-of-00002.safetensors", "model.safetensors.index.json",
    "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json",
    "video_preprocessor_config.json", "vocab.json",
))


class Hold(RuntimeError):
    """A concrete unproved precondition; never converted into success."""


class Failed(RuntimeError):
    """A consumed phase failure. Its lock/partial/raw evidence is retained."""


def require(ok, code, exc=Hold):
    if not ok:
        raise exc(code)


def integer(value, minimum=0):
    return type(value) is int and value >= minimum


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def strict_json(raw):
    def pairs(rows):
        result = {}
        for key, value in rows:
            require(key not in result, "DUPLICATE_JSON_KEY")
            result[key] = value
        return result
    result = json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=pairs,
                        parse_constant=lambda _: (_ for _ in ()).throw(Hold("NONFINITE_JSON")))
    canonical(result).decode("utf-8").encode("utf-8", "strict")
    return result


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def fixed_catalog(raw, expected_sha256):
    require(type(expected_sha256) is str and re.fullmatch(r"[0-9a-f]{64}", expected_sha256)
            and digest(raw) == expected_sha256, "CATALOG_BYTE_BINDING")
    spec = strict_json(raw)
    require(spec.get("model_id") == MODEL and spec.get("revision") == REVISION
            and spec.get("license") == "apache-2.0" and spec.get("gated") is False,
            "OFFICIAL_SOURCE_IDENTITY")
    rows = spec.get("files")
    require(type(rows) is list and len(rows) == 14 and all(type(x) is dict for x in rows)
            and {x.get("path") for x in rows} == EXPECTED_NAMES,
            "EXACT_FOURTEEN_MEMBERS")
    require(all(type(x) is dict and integer(x.get("bytes"), 1)
                and re.fullmatch(r"[0-9a-f]{40}", x.get("git_blob_sha1", ""))
                and (x.get("lfs_sha256") is None or re.fullmatch(r"[0-9a-f]{64}", x["lfs_sha256"]))
                and (x.get("small_text_sha256") is None or re.fullmatch(r"[0-9a-f]{64}", x["small_text_sha256"]))
                for x in rows), "SOURCE_MEMBER_TYPES")
    require(sum(x["bytes"] for x in rows) == SOURCE_BYTES
            and spec.get("source_bytes") == SOURCE_BYTES, "SOURCE_SIZE")
    require(spec.get("conversion") == {"outtype": "bf16", "model_type": "TEXT", "use_temp_file": True,
            "remote": False, "mmproj": False, "other_precisions": False}, "BF16_TEXT_ONLY")
    caps = spec.get("ceilings", {})
    require(caps == {"network_response_body_bytes": NETWORK_MAX, "new_storage_high_water_bytes": STORAGE_MAX,
            "download_verify_seconds": 21600, "convert_seconds": 1800, "artifact_hash_seconds": 600,
            "minimum_available_ram_bytes": RAM_MIN}, "FIXED_CEILINGS")
    return spec


def safe_directory_chain(path):
    """Check every existing ancestor, including the named directory itself.

    Rechecked before effects; Root still owns exclusive namespace/TOCTOU
    qualification since ordinary pathname checks are not an atomic openat seal.
    """
    for directory in reversed((path, *path.parents)):
        try:
            st = directory.lstat()
        except FileNotFoundError:
            continue
        require(directory.is_dir() and not directory.is_symlink()
                and not getattr(st, "st_file_attributes", 0) & 0x400, "DIRECTORY_REPARSE")


def safe_file(path):
    safe_directory_chain(path.parent)
    st = path.lstat()
    require(path.is_file() and not path.is_symlink() and not getattr(st, "st_file_attributes", 0) & 0x400,
            "FILE_REPARSE_OR_TYPE")
    require(getattr(st, "st_nlink", 1) == 1, "FILE_LINK_COUNT")
    return st


def target_boundary(root):
    require(root.is_absolute() and root.parent.resolve() == MATERIAL_PARENT.resolve()
            and re.fullmatch(r"reference4b-[a-z0-9][a-z0-9-]{0,63}", root.name), "FIXED_MATERIAL_NAMESPACE")
    for directory in (root, *(root / name for name in ("source", "tmp", "outputs", "evidence"))):
        safe_directory_chain(directory)


def source_url(name):
    require(name in EXPECTED_NAMES, "UNKNOWN_SOURCE_MEMBER")
    return f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{urllib.parse.quote(name, safe='')}?download=true"


def tree_size(root):
    total = 0
    safe_directory_chain(root)
    if root.exists():
        for directory, dirs, files in os.walk(root, followlinks=False):
            for name in dirs:
                p = Path(directory) / name
                st = p.lstat()
                require(not p.is_symlink() and not getattr(st, "st_file_attributes", 0) & 0x400, "TREE_REPARSE")
            for name in files:
                p = Path(directory) / name
                total += safe_file(p).st_size
    return total


@dataclass
class Context:
    """Root supplies original callbacks, not caller-supplied 'approved' flags.

    check_current(phase, request_digest) raises on lost approval/currentness.
    observe(root) returns fresh actual resource facts. Its origin and Host I/O
    qualification are Root's responsibility, not authenticated by this module.
    owned_runner is Root's already-reviewed bounded process composition.
    """
    root: Path
    catalog_raw: bytes
    catalog_sha256: str
    request_digest: str
    stop_at_utc: str
    check_current: Callable
    observe: Callable
    owned_runner: Callable | None = None
    clock: Callable = time.monotonic
    phase: str = ""
    deadline: float = 0.0
    network_body_bytes: int = 0
    high_water_bytes: int = 0

    def enter(self, phase):
        require(phase in PHASE_SECONDS and not self.phase, "CLOSED_PHASE_DISPATCH")
        require(callable(self.check_current) and callable(self.observe), "ORIGINAL_CALLER_CALLBACKS_REQUIRED")
        require(type(self.request_digest) is str and re.fullmatch(r"[0-9a-f]{64}", self.request_digest), "REQUEST_BINDING")
        target_boundary(self.root)
        spec = fixed_catalog(self.catalog_raw, self.catalog_sha256)
        self.phase = phase
        self.deadline = self.clock() + PHASE_SECONDS[phase]
        self.tick()
        return spec

    def tick(self):
        require(self.clock() < self.deadline, "PHASE_DEADLINE", Failed)
        try:
            stop = datetime.fromisoformat(self.stop_at_utc.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            raise Hold("UTC_STOP_UNBOUND") from None
        require(stop.tzinfo is not None and datetime.now(timezone.utc) < stop, "UTC_STOP", Failed)
        self.check_current(self.phase, self.request_digest)
        require(self.clock() < self.deadline, "DEADLINE_AFTER_CURRENTNESS", Failed)

    def resources(self, *, ram=False, reserve=0):
        self.tick()
        facts = self.observe(self.root)
        require(type(facts) is dict and set(facts) == {"captured_monotonic_seconds", "available_ram_bytes", "free_disk_bytes", "new_storage_high_water_bytes"}, "RESOURCE_FACT_FIELDS")
        captured = facts["captured_monotonic_seconds"]
        require(type(captured) in (int, float) and math.isfinite(captured)
                and 0 <= self.clock() - captured <= 5, "RESOURCE_FACT_FRESHNESS")
        require(all(integer(facts[k]) for k in ("available_ram_bytes", "free_disk_bytes", "new_storage_high_water_bytes")), "RESOURCE_FACT_TYPES")
        observed = max(tree_size(self.root), facts["new_storage_high_water_bytes"])
        self.high_water_bytes = max(self.high_water_bytes, observed)
        require(self.high_water_bytes + reserve <= STORAGE_MAX, "STORAGE_HIGH_WATER", Failed)
        require(facts["free_disk_bytes"] >= reserve, "FREE_DISK_HOLD")
        if ram:
            require(facts["available_ram_bytes"] >= RAM_MIN, "AVAILABLE_RAM_BELOW_16_GIB")
        self.tick()
        return facts


def create_json(path, value):
    raw = canonical(value) + b"\n"
    require(len(raw) <= AUXILIARY_MAX, "EVIDENCE_BOUND", Failed)
    safe_directory_chain(path.parent)
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


def lock_phase(ctx):
    path = ctx.root / ("." + ctx.phase + ".attempt.json")
    create_json(path, {"phase": ctx.phase, "state": "STARTED_NO_AUTOMATIC_RETRY", "request_digest": ctx.request_digest,
                       "catalog_sha256": ctx.catalog_sha256, "authority_effect": "NONE"})


def hash_file(path, ctx, row=None):
    before = safe_file(path)
    h = hashlib.sha256()
    git = hashlib.sha1(b"blob " + str(before.st_size).encode() + b"\0")
    size = 0
    with path.open("rb") as stream:
        while True:
            ctx.tick()
            block = stream.read(1024 * 1024)
            if not block:
                break
            size += len(block)
            h.update(block)
            git.update(block)
    after = safe_file(path)
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) and size == before.st_size,
            "FILE_CHANGED_DURING_HASH", Failed)
    result = {"path": path.name, "bytes": size, "sha256": h.hexdigest(), "git_blob_sha1": git.hexdigest()}
    if row is not None:
        require(size == row["bytes"] and (h.hexdigest() == row["lfs_sha256"] if row["lfs_sha256"] else git.hexdigest() == row["git_blob_sha1"]), "ORIGINAL_SOURCE_HASH", Failed)
        if row["small_text_sha256"]:
            require(h.hexdigest() == row["small_text_sha256"], "SMALL_SOURCE_SHA256", Failed)
    return result


def receive_member(response, target, row, ctx):
    """No retry, no overwrite, no partial deletion; body bytes charged first."""
    safe_directory_chain(target.parent)
    require(not target.exists() and not target.with_suffix(target.suffix + ".partial").exists(), "MEMBER_EXISTS")
    part = target.with_suffix(target.suffix + ".partial")
    expected = row["bytes"]
    h = hashlib.sha256()
    git = hashlib.sha1(b"blob " + str(expected).encode() + b"\0")
    size = 0
    with part.open("xb") as stream:
        while size < expected:
            ctx.resources(reserve=min(1024 * 1024, expected - size))
            remaining = NETWORK_MAX - ctx.network_body_bytes
            require(remaining > 0, "CUMULATIVE_NETWORK_BODY_LIMIT", Failed)
            incomplete = False
            try:
                block = response.read(min(1024 * 1024, expected - size, remaining))
            except http.client.IncompleteRead as error:
                block, incomplete = error.partial, True
            require(type(block) is bytes, "HTTP_BODY_TYPE", Failed)
            ctx.network_body_bytes += len(block)
            require(ctx.network_body_bytes <= NETWORK_MAX and size + len(block) <= expected,
                    "CUMULATIVE_NETWORK_BODY_LIMIT", Failed)
            require(bool(block), "TRUNCATED_HTTP_BODY", Failed)
            size += len(block)
            h.update(block)
            git.update(block)
            stream.write(block)
            if incomplete:
                stream.flush()
                raise Failed("TRUNCATED_HTTP_BODY")
        stream.flush()
        os.fsync(stream.fileno())
    require(size == expected and (h.hexdigest() == row["lfs_sha256"] if row["lfs_sha256"] else git.hexdigest() == row["git_blob_sha1"]), "DOWNLOADED_SOURCE_HASH", Failed)
    if row["small_text_sha256"]:
        require(h.hexdigest() == row["small_text_sha256"], "SMALL_SOURCE_SHA256", Failed)
    # Caller uses the fixed Windows owned workspace. rename is not replace;
    # Windows refuses an existing target, and the independent rehash follows.
    require(os.name == "nt", "WINDOWS_NEW_ONLY_RENAME_REQUIRED")
    safe_directory_chain(target.parent)
    require(not target.exists(), "TARGET_ALREADY_EXISTS", Failed)
    os.rename(part, target)
    return {"path": row["path"], "bytes": size, "sha256": h.hexdigest(), "git_blob_sha1": git.hexdigest()}


OFFICIAL_REDIRECT_HOSTS = frozenset(("huggingface.co", "cdn-lfs.huggingface.co", "cdn-lfs.hf.co",
    "cdn-lfs-us-1.hf.co", "cdn-lfs-eu-1.hf.co", "cas-bridge.xethub.hf.co", "us.aws.cdn.hf.co", "eu.aws.cdn.hf.co"))


@contextmanager
def official_response(url, timeout, ctx):
    """One body stream; at most three official HTTPS redirects, no retry.

    Redirect/error bodies are never read. Unknown redirect hosts HOLD. Headers
    and TLS overhead are not response-body bytes and are not called wire usage.
    OS/TLS blocking cancellation belongs to Root's qualified owned phase host.
    """
    connection = None
    response = None
    try:
        for hop in range(4):
            ctx.tick()
            parsed = urllib.parse.urlsplit(url)
            require(parsed.scheme == "https" and parsed.hostname in OFFICIAL_REDIRECT_HOSTS
                    and parsed.port in (None, 443) and parsed.username is None and parsed.password is None
                    and not parsed.fragment, "OFFICIAL_HTTPS_REDIRECT_ONLY")
            connection = http.client.HTTPSConnection(parsed.hostname, timeout=min(timeout, ctx.deadline - ctx.clock()),
                                                      context=ssl.create_default_context())
            connection.request("GET", urllib.parse.urlunsplit(("", "", parsed.path, parsed.query, "")),
                               headers={"User-Agent": "Clued-fixed-reference4b-materials", "Accept-Encoding": "identity"})
            response = connection.getresponse()
            ctx.tick()
            if response.status not in (301, 302, 303, 307, 308):
                require(not response.getheader("Transfer-Encoding")
                        and response.getheader("Content-Encoding", "identity") == "identity", "HTTP_IDENTITY_LENGTH_REQUIRED", Failed)
                yield response
                return
            require(hop < 3, "OFFICIAL_REDIRECT_LIMIT", Failed)
            location = response.getheader("Location")
            require(type(location) is str and len(location) <= 16384, "REDIRECT_LOCATION", Failed)
            url = urllib.parse.urljoin(url, location)
            response.close()  # No redirect body consumption, including failures.
            connection.close()
        raise Failed("OFFICIAL_REDIRECT_LIMIT")
    finally:
        if response is not None:
            response.close()
        if connection is not None:
            connection.close()


def download_verify(ctx, *, opener=None):
    spec = ctx.enter("download_verify")
    require(opener is None, "CUSTOM_HTTP_OPENER_NOT_ACCEPTED")
    require(not ctx.root.exists(), "NEW_MATERIAL_ROOT_REQUIRED")
    ctx.resources(reserve=SOURCE_BYTES + AUXILIARY_MAX)
    target_boundary(ctx.root)
    ctx.root.mkdir(exist_ok=False)
    for name in ("source", "tmp", "outputs", "evidence"):
        (ctx.root / name).mkdir()
    lock_phase(ctx)
    try:
        rows = []
        for row in spec["files"]:
            ctx.tick()
            with official_response(source_url(row["path"]), min(30.0, ctx.deadline - ctx.clock()), ctx) as response:
                require(response.status == 200 and int(response.headers.get("Content-Length", "-1")) == row["bytes"], "HTTP_STATUS_OR_LENGTH", Failed)
                rows.append(receive_member(response, ctx.root / "source" / row["path"], row, ctx))
        verified = [hash_file(ctx.root / "source" / row["path"], ctx, row) for row in spec["files"]]
        require(rows == verified, "INDEPENDENT_SOURCE_REHASH", Failed)
        result = {"phase": ctx.phase, "outcome": "SOURCE_INTEGRITY_VERIFIED_ONLY", "model_id": MODEL, "revision": REVISION,
                  "files": rows, "network_response_body_bytes": ctx.network_body_bytes, "wire_network_bytes": None,
                  "new_storage_high_water_bytes": ctx.high_water_bytes, "authority_effect": "NONE", "runtime_model_loaded": False}
        ctx.resources(reserve=AUXILIARY_MAX)
        create_json(ctx.root / "evidence/download-verified.json", result)
        return result
    except BaseException as error:
        failure_evidence(ctx, error)
        raise


def source_verified(ctx, spec):
    target_boundary(ctx.root)
    safe_file(ctx.root / "evidence/download-verified.json")
    manifest = strict_json((ctx.root / "evidence/download-verified.json").read_bytes())
    require(manifest.get("outcome") == "SOURCE_INTEGRITY_VERIFIED_ONLY" and manifest.get("model_id") == MODEL
            and manifest.get("revision") == REVISION and manifest.get("authority_effect") == "NONE", "SOURCE_PHASE_INCOMPLETE")
    require(set(p.name for p in (ctx.root / "source").iterdir()) == EXPECTED_NAMES, "SOURCE_MEMBER_DRIFT")
    actual = [hash_file(ctx.root / "source" / row["path"], ctx, row) for row in spec["files"]]
    require(actual == manifest.get("files"), "SOURCE_PHASE_BYTES_CHANGED", Failed)


def tree_pin(root, excluded=(), checkpoint=lambda: None):
    rows = []
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(name for name in dirs if (Path(directory) / name).relative_to(root).as_posix() not in excluded)
        for name in dirs:
            p = Path(directory) / name
            st = p.lstat()
            require(not p.is_symlink() and not getattr(st, "st_file_attributes", 0) & 0x400, "TOOLCHAIN_REPARSE")
        for name in sorted(files):
            checkpoint()
            p = Path(directory) / name
            st = safe_file(p)
            require(p.suffix.lower() not in (".gguf", ".safetensors", ".pt", ".ckpt"), "MODEL_ASSET_NOT_TOOLCHAIN")
            h = hashlib.sha256()
            with p.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    checkpoint()
                    h.update(block)
            rows.append({"path": p.relative_to(root).as_posix(), "bytes": st.st_size, "sha256": h.hexdigest()})
    rows.sort(key=lambda row: row["path"])
    return {"files": len(rows), "bytes": sum(x["bytes"] for x in rows), "tree_sha256": digest(canonical(rows))}


def verify_toolchain(spec, ctx):
    tool = spec["toolchain"]
    closure = tool.get("closure")
    require(type(closure) is dict and closure.get("bootstrap") == "ISOLATED_NO_SITE_FIXED_SOURCE_AND_VENV_PATHS", "COMPLETE_TOOLCHAIN_CLOSURE_UNBOUND")
    for row in closure["roots"]:
        ctx.tick()
        actual = tree_pin(Path(row["path"]), tuple(row["excluded_relative_directories"]), ctx.tick)
        require(all(actual[k] == row[k] for k in actual), "TOOLCHAIN_TREE_CHANGED")
    for row in closure["files"]:
        actual = hash_file(Path(row["path"]), ctx)
        require(actual["bytes"] == row["bytes"] and actual["sha256"] == row["sha256"], "TOOLCHAIN_FILE_CHANGED")


def tensor_storage_bound(headers):
    """Pure upper bound, not tensor/tokenizer execution or a quality result.

    Fixed Qwen3.5 TEXT transformations split/permute/add in place in element
    count. No generated tensors, quantized input, MoE or MTP are admitted here.
    Count even vision tensors that TEXT drops. Only known ordinary 2-D dense
    projection/embedding names use BF16; everything else is charged F32.
    """
    total = count = 0
    safe_bf16 = re.compile(r"(?:model\.embed_tokens|lm_head|model\.layers\.[0-9]+\.(?:mlp\.(?:gate|up|down)_proj|self_attn\.(?:q|k|v|o)_proj|linear_attn\.(?:in_proj_qkv|in_proj_qkvz|in_proj_z|out_proj)))\.weight")
    for name, row in headers.items():
        require(type(name) is str and type(row) is dict and set(row) == {"dtype", "shape", "data_offsets"}, "TENSOR_HEADER_FIELDS")
        require("experts" not in name and "mtp." not in name and "scale" not in name, "UNSUPPORTED_CONVERSION_TENSOR")
        shape = row["shape"]
        require(type(shape) is list and 1 <= len(shape) <= 4 and all(integer(x, 1) for x in shape)
                and row["dtype"] in ("BF16", "F16", "F32"), "UNSUPPORTED_TENSOR_DTYPE_SHAPE")
        normalized = name.replace("language_model.", "")
        elements = math.prod(shape)
        unit = 2 if len(shape) == 2 and safe_bf16.fullmatch(normalized) else 4
        total += elements * unit
        count += 2 if "in_proj_qkvz.weight" in name else 1
    # Each tensor has <=31B alignment; use 64B per output tensor. Header/KV
    # allowance is 16x all non-weight source bytes +16B/vocab entry +1MiB,
    # covering UTF8 tokens/merges, per-entry lengths/types/scores, config and
    # template. Fixed vocab size and source hashes are checked before this.
    nonweight = SOURCE_BYTES - 5329398688 - 3990429408
    metadata = nonweight * 16 + 248320 * 16 + 1024**2
    temporary = total + count * 64
    output = temporary + metadata
    bound = SOURCE_BYTES + temporary + output + AUXILIARY_MAX
    require(bound <= STORAGE_MAX, "PROVEN_NEW_STORAGE_EXCEEDS_32_GIB")
    return {"source_bytes": SOURCE_BYTES, "output_bytes_max": output, "temp_bytes_max": temporary,
            "auxiliary_bytes_max": AUXILIARY_MAX, "simultaneous_peak_bytes_max": bound,
            "derivation": "FIXED_QWEN35_HEADER_ELEMENTS_BF16_OR_CONSERVATIVE_F32_SINGLE_TEMP_PLUS_OUTPUT"}


def conversion_space_bound(spec, ctx):
    require(spec.get("space_proof", {}).get("algorithm") == "FIXED_QWEN35_HEADER_ELEMENTS_V1", "SPACE_PROOF_ALGORITHM_UNBOUND")
    index = strict_json((ctx.root / "source/model.safetensors.index.json").read_bytes())
    headers = {}
    payload_bytes = 0
    for row in spec["files"]:
        if not row["path"].endswith(".safetensors"):
            continue
        ctx.tick()
        path = ctx.root / "source" / row["path"]
        with path.open("rb") as stream:
            length_raw = stream.read(8)
            require(len(length_raw) == 8, "SAFETENSORS_HEADER_LENGTH")
            length = struct.unpack("<Q", length_raw)[0]
            require(2 <= length <= 8 * 1024**2 and 8 + length < row["bytes"], "SAFETENSORS_HEADER_BOUND")
            raw = stream.read(length)
            require(len(raw) == length, "SAFETENSORS_HEADER_PARTIAL")
        members = strict_json(raw)
        require(type(members) is dict, "SAFETENSORS_HEADER_OBJECT")
        end = 0
        ranges = []
        for name, tensor in members.items():
            if name == "__metadata__":
                require(type(tensor) is dict, "SAFETENSORS_METADATA")
                continue
            require(name not in headers and index["weight_map"].get(name) == row["path"], "SAFETENSORS_INDEX_BINDING")
            # Validate the complete shape/dtype before using arithmetic.
            tensor_storage_bound({name: tensor})
            offset = tensor["data_offsets"]
            unit = {"BF16": 2, "F16": 2, "F32": 4}[tensor["dtype"]]
            require(type(offset) is list and len(offset) == 2 and all(integer(x) for x in offset)
                    and offset[1] - offset[0] == math.prod(tensor["shape"]) * unit, "SAFETENSORS_OFFSETS")
            ranges.append(tuple(offset))
            headers[name] = tensor
        for start, stop in sorted(ranges):
            require(start == end and stop > start, "SAFETENSORS_PAYLOAD_COVERAGE")
            end = stop
        require(end == row["bytes"] - 8 - length, "SAFETENSORS_FILE_SIZE")
        payload_bytes += end
    require(set(headers) == set(index["weight_map"]) and len(headers) == 738
            and payload_bytes == index["metadata"]["total_size"] == 9319737856, "EXACT_TENSOR_INDEX_AND_SIZE")
    config = strict_json((ctx.root / "source/config.json").read_bytes())
    require(config.get("architectures") == ["Qwen3_5ForConditionalGeneration"]
            and config.get("model_type") == "qwen3_5" and not config.get("quantization_config")
            and config["text_config"].get("vocab_size") == 248320
            and not config["text_config"].get("mtp_num_hidden_layers"), "FIXED_TEXT_CONFIGURATION")
    proof = tensor_storage_bound(headers)
    proof["converter_closure_sha256"] = digest(canonical(spec["toolchain"]["closure"]))
    proof["header_facts_sha256"] = digest(canonical(headers))
    return proof


def install_writer_guard(writer_class, output, proof):
    """Installed only in the new converter process; never at module import.

    The fixed writer's actual tensor sizes are checked before each temp write;
    exact serialized KV/tensor-info size is checked before final create-only open.
    This turns the reserved allowance into a write-before-effect bound, without
    changing tensor values/dtypes, tokenizer behavior or the existing code files.
    """
    original_init = writer_class.__init__
    original_add = writer_class.add_tensor
    original_header = writer_class.write_header_to_file
    made = 0
    used = 0

    def initialize(self, *args, **kwargs):
        nonlocal made
        require(made == 0, "MULTIPLE_CONVERTER_WRITERS", Failed)
        made += 1
        original_init(self, *args, **kwargs)

    def add(self, name, tensor, *args, **kwargs):
        nonlocal used
        require(self.use_temp_file is True and self.data_alignment == 32
                and self.split_max_tensors == 0 and self.split_max_size == 0
                and not self.small_first_shard, "FIXED_SINGLE_TEMP_WRITER", Failed)
        size = tensor.nbytes
        require(type(size) is int and size >= 0, "ACTUAL_TENSOR_BYTES", Failed)
        aligned = (size + 31) // 32 * 32
        require(used + aligned <= proof["temp_bytes_max"], "TEMP_WRITE_BEFORE_CAP", Failed)
        used += aligned
        return original_add(self, name, tensor, *args, **kwargs)

    def header(self, path=None):
        require(len(self.tensors) == 1 and len(self.kv_data) == 1
                and self.fout is None and self.path in (None, output) and path == output, "FIXED_OUTPUT_WRITER", Failed)
        # Existing frozen _pack_val is used to count actual UTF8/array encoding,
        # rather than trusting a multiplier estimate for tokenizer metadata.
        string_type = __import__(writer_class.__module__, fromlist=["GGUFValueType"]).GGUFValueType.STRING
        size = 24
        for key, val in self.kv_data[0].items():
            size += len(self._pack_val(key, string_type, add_vtype=False))
            size += len(self._pack_val(val.value, val.type, add_vtype=True, sub_type=val.sub_type))
        actual_tensor_bytes = 0
        for name, ti in self.tensors[0].items():
            size += len(self._pack_val(name, string_type, add_vtype=False)) + 4 + len(ti.shape) * 8 + 4 + 8
            actual_tensor_bytes += (ti.nbytes + 31) // 32 * 32
        require(actual_tensor_bytes == used and (size + 31) // 32 * 32 + used <= proof["output_bytes_max"],
                "OUTPUT_WRITE_BEFORE_CAP", Failed)
        # The existing writer otherwise uses wb. Reserve the sole target with
        # xb and present its expected EMPTY state before the old header method.
        safe_directory_chain(output.parent)
        self.fout = [output.open("xb")]
        self.path = output
        self.state = type(self.state).EMPTY
        return original_header(self, path)

    writer_class.__init__ = initialize
    writer_class.add_tensor = add
    writer_class.write_header_to_file = header


def guarded_converter(converter, output, proof):
    import gguf  # Only inside future actually approved conversion process.
    import runpy
    install_writer_guard(gguf.GGUFWriter, Path(output), proof)
    runpy.run_path(converter, run_name="__main__")


def conversion_recipe(spec, root, proof):
    tool = spec["toolchain"]
    converter = str(Path(tool["converter_root"]) / "convert_hf_to_gguf.py")
    venv = tool["venv_root"]
    # -I -S bypasses user/site/.pth execution. Only these fixed source and venv
    # paths are added. Base interpreter/std-library/DLL identity is in closure.
    bootstrap = ("import sys,runpy;sys.prefix=sys.exec_prefix=" + repr(venv) + ";"
                 "sys.path[:0]=" + repr([tool["converter_root"], str(Path(tool["converter_root"]) / "gguf-py"), str(Path(venv) / "Lib/site-packages")]) + ";"
                 "sys.argv=" + repr([converter, str(root / "source"), "--outfile", str(root / "outputs/Qwen3.5-4B-BF16.gguf.partial"), "--outtype", "bf16", "--use-temp-file"]) + ";"
                 "runpy.run_path(" + repr(str(Path(__file__).resolve())) + ")[\"guarded_converter\"]("
                 + repr(converter) + "," + repr(str(root / "outputs/Qwen3.5-4B-BF16.gguf.partial")) + "," + repr(proof) + ")")
    argv = [str(Path(venv) / "Scripts/python.exe"), "-I", "-S", "-B", "-c", bootstrap]
    env = {"SystemRoot": r"C:\Windows", "WINDIR": r"C:\Windows", "PATH": r"C:\Windows\System32",
           "TEMP": str(root / "tmp"), "TMP": str(root / "tmp"), "TMPDIR": str(root / "tmp"),
           "HF_HOME": str(root / "tmp/hf"), "XDG_CACHE_HOME": str(root / "tmp/cache"), "TORCH_HOME": str(root / "tmp/torch"),
           "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_DATASETS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
           "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1", "CUDA_VISIBLE_DEVICES": "",
           "OMP_NUM_THREADS": "8", "MKL_NUM_THREADS": "8"}
    return {"argv": argv, "cwd": tool["converter_root"], "env": env, "outtype": "bf16", "model_type": "TEXT", "use_temp_file": True}


def convert_bf16_text(ctx):
    spec = ctx.enter("convert_bf16_text")
    ctx.resources(ram=True)
    require(callable(ctx.owned_runner), "REVIEWED_OWNED_RUNNER_REQUIRED")
    source_verified(ctx, spec)
    verify_toolchain(spec, ctx)
    proof = conversion_space_bound(spec, ctx)
    ctx.resources(ram=True, reserve=proof["output_bytes_max"] + proof["temp_bytes_max"] + AUXILIARY_MAX)
    output = ctx.root / "outputs/Qwen3.5-4B-BF16.gguf.partial"
    require(not output.exists(), "CONVERSION_OUTPUT_EXISTS")
    lock_phase(ctx)
    try:
        target_boundary(ctx.root)
        recipe = conversion_recipe(spec, ctx.root, proof)
        recipe["proven_new_storage_bound"] = proof
        result = ctx.owned_runner(recipe, ctx.deadline, {"stdout_bytes": CAPTURE_MAX, "stderr_bytes": CAPTURE_MAX},
                                  lambda: ctx.resources(ram=False))
        require(type(result) is dict, "RUNNER_RESULT_UNVERIFIED", Failed)
        for name in ("stdout_raw", "stderr_raw"):
            raw = result.get(name)
            require(type(raw) is bytes and len(raw) <= CAPTURE_MAX, "RAW_CAPTURE_UNVERIFIED", Failed)
            safe_directory_chain(ctx.root / "evidence")
            with (ctx.root / "evidence" / (name + ".bin")).open("xb") as stream:
                stream.write(raw)
        require(result.get("outcome") == "PROCESS_EXIT" and type(result.get("returncode")) is int
                and result["returncode"] == 0 and result.get("owned_cleanup_verified") is True
                and result.get("captures_complete") is True, "CONVERTER_FAILED_OR_PARTIAL", Failed)
        ctx.tick()
        require(safe_file(output).st_size <= proof["output_bytes_max"], "CONVERTER_OUTPUT_BOUND", Failed)
        ctx.resources()
        evidence = {"phase": ctx.phase, "outcome": "CONVERTER_EXIT_ZERO_AWAITING_INDEPENDENT_HASH", "authority_effect": "NONE",
                    "output_path": str(output), "output_bytes": output.stat().st_size,
                    "recipe_sha256": digest(canonical(recipe)), "owned_cleanup_verified": True,
                    "runtime_model_loaded": False, "inference_performed": False, "quality_evaluated": False}
        create_json(ctx.root / "evidence/converter-completed.json", evidence)
        return evidence
    except BaseException as error:
        failure_evidence(ctx, error)
        raise


def hash_artifact(ctx):
    spec = ctx.enter("hash_artifact")
    source_verified(ctx, spec)
    conversion_space_bound(spec, ctx)
    safe_file(ctx.root / "evidence/converter-completed.json")
    previous = strict_json((ctx.root / "evidence/converter-completed.json").read_bytes())
    part = ctx.root / "outputs/Qwen3.5-4B-BF16.gguf.partial"
    require(previous.get("outcome") == "CONVERTER_EXIT_ZERO_AWAITING_INDEPENDENT_HASH"
            and previous.get("owned_cleanup_verified") is True and previous.get("output_path") == str(part), "CONVERSION_PHASE_INCOMPLETE")
    ctx.resources()
    lock_phase(ctx)
    try:
        safe_file(part)
        with part.open("rb") as stream:
            require(stream.read(4) == b"GGUF", "GGUF_MAGIC", Failed)
        row = hash_file(part, ctx)
        ctx.resources()
        evidence = {"phase": ctx.phase, "outcome": "BF16_TEXT_ARTIFACT_IDENTITY_OBSERVED_ONLY", "artifact": row,
                    "request_digest": ctx.request_digest, "catalog_sha256": ctx.catalog_sha256,
                    "authority_effect": "NONE", "permission_issued": False, "qualification": "NOT_ISSUED",
                    "actual_m1_binding_created_here": False, "inference_performed": False}
        create_json(ctx.root / "evidence/artifact-identity.json", evidence)
        return evidence  # Root binds this actual hash in real M1 before any invocation.
    except BaseException as error:
        failure_evidence(ctx, error)
        raise


def failure_evidence(ctx, error):
    # Preserve the attempt lock, every partial and raw capture. Do not serialize
    # arbitrary callback exception messages or invent a successful terminal.
    code = str(error) if type(error) in (Hold, Failed) else "UNEXPECTED_PHASE_FAILURE"
    if not re.fullmatch(r"[A-Z0-9_]{1,100}", code):
        code = "UNEXPECTED_PHASE_FAILURE"
    path = ctx.root / "evidence" / (ctx.phase + ".failure.json")
    if path.parent.is_dir() and not path.exists():
        create_json(path, {"phase": ctx.phase, "outcome": "FAILED_OR_PARTIAL_NO_RETRY", "code": code,
                           "network_response_body_bytes": ctx.network_body_bytes, "wire_network_bytes": None,
                           "observed_new_storage_high_water_bytes": ctx.high_water_bytes, "authority_effect": "NONE"})


def run_phase(phase, ctx, **kwargs):
    require(type(phase) is str and phase in PHASE_SECONDS, "CLOSED_PHASE_DISPATCH")
    if phase == "download_verify":
        return download_verify(ctx, **kwargs)
    require(not kwargs, "UNKNOWN_PHASE_ARGUMENTS")
    return convert_bf16_text(ctx) if phase == "convert_bf16_text" else hash_artifact(ctx)
