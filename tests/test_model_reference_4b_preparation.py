"""Technical fixtures only: no remote reads, model bytes, imports or processes."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "scripts/model-program/m1_prepare_reference_4b.py"
_spec = importlib.util.spec_from_file_location("reference4b_preparation", SOURCE)
m = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = m
_spec.loader.exec_module(m)


class PreparationTests(unittest.TestCase):
    def setUp(self):
        self.raw = m.CATALOG.read_bytes()
        self.sha = m.digest(self.raw)
        self.catalog = m.fixed_catalog(self.raw, self.sha)

    def test_exact_source_and_template_binding(self):
        self.assertEqual(sum(x["bytes"] for x in self.catalog["files"]), 9342907469)
        template = next(x for x in self.catalog["files"] if x["path"] == "chat_template.jinja")
        self.assertEqual((template["bytes"], template["small_text_sha256"]),
                         (7756, "a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715"))
        with self.assertRaisesRegex(m.Hold, "CATALOG_BYTE_BINDING"):
            m.fixed_catalog(self.raw + b" ", self.sha)
        for mutation in (lambda x: x["files"].pop(), lambda x: x["files"][0].update(bytes=True),
                         lambda x: x.update(revision="main")):
            value = copy.deepcopy(self.catalog)
            mutation(value)
            raw = m.canonical(value)
            with self.assertRaises(m.Hold):
                m.fixed_catalog(raw, m.digest(raw))

    def test_strict_json_duplicate_nonfinite_and_utf8(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":"\\ud800"}', b'"\xff"'):
            with self.subTest(raw=raw), self.assertRaises((m.Hold, ValueError, UnicodeError)):
                m.strict_json(raw)

    def test_recipe_is_existing_isolated_bf16_text_only(self):
        recipe = m.conversion_recipe(self.catalog, Path("C:/fixture/reference4b-technical"),
                                     m.tensor_storage_bound({}))
        self.assertEqual(recipe["argv"][1:5], ["-I", "-S", "-B", "-c"])
        code = recipe["argv"][5]
        for text in ("--outtype", "bf16", "--use-temp-file", "runpy.run_path"):
            self.assertIn(text, code)
        self.assertIn(repr(str(Path(self.catalog["toolchain"]["venv_root"]) / "Lib/site-packages")), code)
        for text in ("--remote", "--mmproj", "--trust-remote-code", "--outtype', 'f32", "pip"):
            self.assertNotIn(text, code)
        self.assertEqual(recipe["env"]["HF_HUB_OFFLINE"], "1")
        self.assertEqual(recipe["env"]["CUDA_VISIBLE_DEVICES"], "")
        self.assertEqual(recipe["env"]["OMP_NUM_THREADS"], "8")
        self.assertEqual(recipe["env"]["MKL_NUM_THREADS"], "8")

    def test_space_counts_source_temp_and_output_simultaneously(self):
        row = {"dtype": "BF16", "shape": [100, 100], "data_offsets": [0, 20000]}
        known = m.tensor_storage_bound({"model.layers.0.mlp.up_proj.weight": row})
        unknown = m.tensor_storage_bound({"model.visual.unknown.weight": row})
        self.assertEqual(unknown["temp_bytes_max"] - known["temp_bytes_max"], 20000)
        self.assertEqual(known["simultaneous_peak_bytes_max"], sum(known[k] for k in
                         ("source_bytes", "output_bytes_max", "temp_bytes_max", "auxiliary_bytes_max")))
        self.assertLessEqual(known["simultaneous_peak_bytes_max"], m.STORAGE_MAX)
        huge = dict(row, shape=[200000, 200000])
        with self.assertRaisesRegex(m.Hold, "EXCEEDS_32_GIB"):
            m.tensor_storage_bound({"model.unknown.weight": huge})
        for value in (dict(row, dtype="F8_E4M3"), dict(row, shape=[True, 2]), dict(row, extra=1)):
            with self.assertRaises(m.Hold):
                m.tensor_storage_bound({"model.unknown.weight": value})

    def context(self, root, clock=lambda: 100.0, facts=None):
        facts = facts or {"captured_monotonic_seconds": 100.0, "available_ram_bytes": m.RAM_MIN,
                          "free_disk_bytes": m.STORAGE_MAX * 2, "new_storage_high_water_bytes": 0}
        return m.Context(root, self.raw, self.sha, "a" * 64, "2099-01-01T00:00:00Z",
                         lambda *_: None, lambda _: facts, clock=clock)

    def test_fresh_ram_and_no_phase_deadline_reset(self):
        ctx = self.context(Path("C:/technical"))
        with patch.object(m, "target_boundary"):
            ctx.enter("convert_bf16_text")
        deadline = ctx.deadline
        ctx.resources(ram=True)
        with self.assertRaisesRegex(m.Hold, "CLOSED_PHASE_DISPATCH"):
            ctx.enter("convert_bf16_text")
        self.assertEqual(ctx.deadline, deadline)
        ctx.observe = lambda _: {"captured_monotonic_seconds": 100, "available_ram_bytes": m.RAM_MIN - 1,
                                "free_disk_bytes": m.STORAGE_MAX, "new_storage_high_water_bytes": 0}
        with self.assertRaisesRegex(m.Hold, "BELOW_16_GIB"):
            ctx.resources(ram=True)
        ctx.observe = lambda _: {"captured_monotonic_seconds": 90, "available_ram_bytes": m.RAM_MIN,
                                "free_disk_bytes": m.STORAGE_MAX, "new_storage_high_water_bytes": 0}
        with self.assertRaisesRegex(m.Hold, "FRESHNESS"):
            ctx.resources()

    def test_partial_network_failure_keeps_bytes_and_shared_count(self):
        class C:
            network_body_bytes = m.NETWORK_MAX - 3
            def resources(self, **_): pass
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "technical.txt"
            ctx = C()
            row = {"path": target.name, "bytes": 5, "lfs_sha256": None, "small_text_sha256": None,
                   "git_blob_sha1": hashlib.sha1(b"blob 5\0abcde").hexdigest()}
            with self.assertRaisesRegex(m.Failed, "CUMULATIVE_NETWORK_BODY_LIMIT"):
                m.receive_member(io.BytesIO(b"abcde"), target, row, ctx)
            self.assertEqual(ctx.network_body_bytes, m.NETWORK_MAX)
            self.assertEqual(target.with_suffix(".txt.partial").read_bytes(), b"abc")
            self.assertFalse(target.exists())
            with self.assertRaisesRegex(m.Hold, "MEMBER_EXISTS"):
                m.receive_member(io.BytesIO(b"abcde"), target, row, ctx)

    def test_create_only_lock_and_failure_no_private_exception(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "evidence").mkdir()
            ctx = self.context(root)
            ctx.phase = "download_verify"
            m.lock_phase(ctx)
            with self.assertRaises(FileExistsError):
                m.lock_phase(ctx)
            m.failure_evidence(ctx, RuntimeError("private URL/token is never evidence"))
            evidence = (root / "evidence/download_verify.failure.json").read_bytes()
            self.assertIn(b"UNEXPECTED_PHASE_FAILURE", evidence)
            self.assertNotIn(b"private", evidence)
            self.assertIn(b'"authority_effect":"NONE"', evidence)

    def test_unknown_redirect_rejected_before_connection(self):
        ctx = self.context(Path("C:/technical"))
        ctx.phase, ctx.deadline = "download_verify", 200
        with patch.object(m.http.client, "HTTPSConnection") as connection:
            with self.assertRaisesRegex(m.Hold, "OFFICIAL_HTTPS"):
                with m.official_response("https://example.invalid/weights", 1, ctx):
                    self.fail("must not yield")
            connection.assert_not_called()

    def test_tree_fingerprint_detects_code_changes_without_import(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "module.py").write_text("raise RuntimeError('must not import')", encoding="utf-8")
            before = m.tree_pin(root)
            (root / "module.py").write_text("changed", encoding="utf-8")
            self.assertNotEqual(before["tree_sha256"], m.tree_pin(root)["tree_sha256"])
            (root / "forbidden.gguf").write_bytes(b"technical only")
            with self.assertRaisesRegex(m.Hold, "NOT_TOOLCHAIN"):
                m.tree_pin(root)

    def test_existing_root_source_and_output_reparse_parents_refuse(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "reference4b-technical"
            root.mkdir()
            for name in ("source", "tmp", "outputs", "evidence"):
                (root / name).mkdir()
            leaf = root / "source/technical.txt"
            leaf.write_bytes(b"fixture")
            original = Path.lstat
            for bad in (root, root / "source", root / "outputs"):
                def lstat(path, *args, **kwargs):
                    value = original(path, *args, **kwargs)
                    return types.SimpleNamespace(st_file_attributes=0x400, st_mode=value.st_mode) if path == bad else value
                with self.subTest(parent=bad.name), patch.object(m, "MATERIAL_PARENT", Path(folder)), patch.object(Path, "lstat", lstat):
                    with self.assertRaisesRegex(m.Hold, "DIRECTORY_REPARSE"):
                        m.target_boundary(root)
                    if bad == root or bad.name == "source":
                        with self.assertRaisesRegex(m.Hold, "DIRECTORY_REPARSE"):
                            m.safe_file(leaf)
                    if bad == root or bad.name == "outputs":
                        with self.assertRaisesRegex(m.Hold, "DIRECTORY_REPARSE"):
                            m.create_json(root / "outputs/new.json", {"technical": True})
                        self.assertFalse((root / "outputs/new.json").exists())

    def writer_fixture(self, output):
        class State:
            EMPTY = "EMPTY"
        class Writer:
            def __init__(self):
                self.use_temp_file, self.data_alignment = True, 32
                self.split_max_tensors = self.split_max_size = 0
                self.small_first_shard = False
                # Actual converter base.py:196 initializes writer path=None;
                # write_header_to_file later supplies its fixed fname_out.
                self.path, self.fout, self.state = None, None, State()
                self.tensors, self.kv_data, self.writes = [{}], [{}], []
            def add_tensor(self, name, tensor):
                self.writes.append(tensor.nbytes)
                self.tensors[0][name] = types.SimpleNamespace(nbytes=tensor.nbytes, shape=(2, 2))
            def _pack_val(self, value, *_args, **_kwargs):
                return str(value).encode()
            def write_header_to_file(self, path=None):
                self.fout[0].write(b"GGUF")
        return Writer

    def test_actual_temp_guard_refuses_before_tensor_write(self):
        writer = self.writer_fixture(Path("C:/technical-only"))
        m.install_writer_guard(writer, Path("C:/technical-only"),
                               {"temp_bytes_max": 32, "output_bytes_max": 1024})
        instance = writer()
        instance.add_tensor("x", types.SimpleNamespace(nbytes=16))
        with self.assertRaisesRegex(m.Failed, "TEMP_WRITE_BEFORE_CAP"):
            instance.add_tensor("y", types.SimpleNamespace(nbytes=1))
        self.assertEqual(instance.writes, [16])
        with self.assertRaisesRegex(m.Failed, "MULTIPLE_CONVERTER_WRITERS"):
            writer()

    def test_actual_metadata_guard_and_final_open_are_before_effect(self):
        fake_module = types.SimpleNamespace(GGUFValueType=types.SimpleNamespace(STRING="string"))
        with tempfile.TemporaryDirectory() as folder, patch.dict(sys.modules, technical_writer=fake_module):
            output = Path(folder) / "fixture.gguf.partial"
            writer = self.writer_fixture(output)
            writer.__module__ = "technical_writer"
            m.install_writer_guard(writer, output, {"temp_bytes_max": 32, "output_bytes_max": 64})
            instance = writer()
            instance.kv_data[0]["key"] = types.SimpleNamespace(value="x" * 100, type="str", sub_type=None)
            with self.assertRaisesRegex(m.Failed, "OUTPUT_WRITE_BEFORE_CAP"):
                instance.write_header_to_file(output)
            self.assertFalse(output.exists())
            instance.kv_data[0].clear()
            output.write_bytes(b"existing sentinel")
            with self.assertRaises(FileExistsError):
                instance.write_header_to_file(output)
            self.assertEqual(output.read_bytes(), b"existing sentinel")


if __name__ == "__main__":
    unittest.main()
