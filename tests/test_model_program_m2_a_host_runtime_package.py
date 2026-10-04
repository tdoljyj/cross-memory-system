"""Finite public ZIP fixtures; no downloaded runtime extraction or execution."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import warnings
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("host_runtime_builder", ROOT / "scripts/model-program/build_m2_a_host_runtime_package.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def fixture(members, mode=0o100444):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED) as archive, warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        for name, data in members:
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = mode << 16
            archive.writestr(info, data)
    return stream.getvalue()


class HostRuntimePackageTests(unittest.TestCase):
    def test_contract_pins_independent_official_source_identity_and_exact_37_members(self):
        contract = builder.load_contract()
        self.assertEqual(contract["archive_sha256"], builder.SOURCE_SHA256)
        self.assertEqual(contract["archive_size"], 12601679)
        self.assertEqual(contract["version"], "3.14.8")
        self.assertEqual(contract["source_url"], "https://www.python.org/ftp/python/3.14.8/python-3.14.8-embed-amd64.zip")
        self.assertEqual(contract["source_verification"]["identity"], "hugo@python.org")
        self.assertEqual(contract["source_verification"]["issuer"], "https://github.com/login/oauth")
        self.assertTrue(contract["source_verification"]["independent_receipt_required"])
        self.assertEqual(contract["qualification"], "NOT_ISSUED")
        self.assertEqual(len(contract["files"]), 37)
        self.assertTrue({"python.exe", "python314.dll", "python314.zip", "python314._pth"} <= set(contract["files"]))

    def test_finite_fixture_validation_and_deterministic_two_member_envelope(self):
        # Internal finite validator seam only; production build() and CLI remain
        # bound to the independent official contract and cannot take these pins.
        raw = fixture([("public.exe", b"public inert executable fixture"), ("public.zip", b"public inert library fixture")])
        files = {"public.exe": builder.sha(b"public inert executable fixture"), "public.zip": builder.sha(b"public inert library fixture")}
        manifest = builder.validate_archive(raw, files, builder.sha(raw), len(raw))
        self.assertEqual(set(manifest), {"schema", "archive_sha256", "runtime_directory", "files"})
        self.assertEqual(manifest["schema"], "m2-a-fault-runtime-v1")
        output = builder.package_bytes(raw, manifest)
        self.assertEqual(output, builder.package_bytes(raw, manifest))
        with zipfile.ZipFile(io.BytesIO(output)) as archive:
            self.assertEqual(archive.namelist(), [builder.ARCHIVE, "runtime-manifest.json"])
            self.assertEqual(archive.read(builder.ARCHIVE), raw)
            self.assertEqual(json.loads(archive.read("runtime-manifest.json")), manifest)
            for info in archive.infolist():
                self.assertEqual(info.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual(info.compress_type, zipfile.ZIP_STORED)
                self.assertEqual(info.external_attr >> 16, 0o100444)

    def test_invalid_archive_shapes_links_and_hashes_are_rejected(self):
        data = b"public inert fixture"
        files = {"public.exe": builder.sha(data)}
        cases = {
            "duplicate": fixture([("public.exe", data), ("public.exe", data)]),
            "extra": fixture([("public.exe", data), ("extra.txt", data)]),
            "nonflat": fixture([("../public.exe", data)]),
            "directory": fixture([("public.exe/", b"")], 0o040755),
            "symlink": fixture([("public.exe", data)], 0o120777),
            "special": fixture([("public.exe", data)], 0o020600),
            "content": fixture([("public.exe", b"changed inert fixture")]),
        }
        for name, raw in cases.items():
            with self.subTest(case=name), self.assertRaises(ValueError):
                builder.validate_archive(raw, files, builder.sha(raw), len(raw))
        valid = fixture([("public.exe", data)])
        with self.assertRaisesRegex(ValueError, "SOURCE_MISMATCH"):
            builder.validate_archive(valid, files, "0" * 64, len(valid))
        with self.assertRaisesRegex(ValueError, "SOURCE_MISMATCH"):
            builder.validate_archive(valid, files, builder.sha(valid), len(valid) + 1)
        with self.assertRaisesRegex(ValueError, "FILE_PIN_INVALID"):
            builder.validate_archive(valid, {"../public.exe": builder.sha(data)}, builder.sha(valid), len(valid))
        with mock.patch.object(builder, "MAX_MEMBER", len(data) - 1), self.assertRaisesRegex(ValueError, "MEMBER_INVALID"):
            builder.validate_archive(valid, files, builder.sha(valid), len(valid))
        with mock.patch.object(builder, "MAX_TOTAL", len(data) - 1), self.assertRaisesRegex(ValueError, "SHAPE_INVALID"):
            builder.validate_archive(valid, files, builder.sha(valid), len(valid))

    def test_changed_contract_and_unapproved_source_fail_before_output_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            contract = root / "changed.json"
            contract.write_bytes(builder.CONTRACT.read_bytes() + b" ")
            source = root / "inert.zip"
            source.write_bytes(fixture([("public.exe", b"public inert fixture")]))
            output = root / "candidate.zip"
            with mock.patch.object(builder, "CONTRACT", contract), self.assertRaisesRegex(ValueError, "CONTRACT_CHANGED"):
                builder.build(source, output)
            self.assertFalse(output.exists())
            with self.assertRaisesRegex(ValueError, "SOURCE_MISMATCH"):
                builder.build(source, output)
            self.assertFalse(output.exists())
            self.assertFalse(Path(str(output) + ".sha256").exists())

    def test_cli_has_no_source_identity_or_contract_override(self):
        with mock.patch.object(builder, "build") as build, self.assertRaises(SystemExit):
            builder.main(["--source", "inert", "--output", "out", "--expected-sha256", "0" * 64])
        build.assert_not_called()


if __name__ == "__main__":
    unittest.main()
