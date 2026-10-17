"""Regression tests for Windows-compatible ZIP names and packaging boundaries."""

import contextlib
import importlib.util
import io
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock
import zipfile


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts/storage/package_zip.py"
SPEC = importlib.util.spec_from_file_location("storage_package_zip", MODULE_PATH)
packaging = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(packaging)


class StorageZipTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.archive = self.root / "package.zip"

    def write_member(self, name="中文😀.txt", data=b"content", comment=b""):
        member = zipfile.ZipInfo(name)
        member.comment = comment
        with zipfile.ZipFile(self.archive, "w", compression=zipfile.ZIP_STORED) as package:
            package.writestr(member, data)

    def patch_headers(self, *, local_flags=None, central_flags=None,
                      local_name=None, central_name=None):
        data = bytearray(self.archive.read_bytes())
        central = data.index(b"PK\x01\x02")
        if local_flags is not None:
            struct.pack_into("<H", data, 6, local_flags)
        if central_flags is not None:
            struct.pack_into("<H", data, central + 8, central_flags)
        if local_name is not None:
            length = struct.unpack_from("<H", data, 26)[0]
            self.assertEqual(len(local_name), length)
            data[30:30 + length] = local_name
        if central_name is not None:
            length = struct.unpack_from("<H", data, central + 28)[0]
            self.assertEqual(len(central_name), length)
            data[central + 46:central + 46 + length] = central_name
        self.archive.write_bytes(data)

    def test_create_roundtrip_chinese_emoji_nested_and_empty_directory(self):
        (self.source / "主标😀").mkdir()
        (self.source / "主标😀" / "定稿.txt").write_bytes(b"logo bytes")
        (self.source / "空目录").mkdir()
        (self.source / "ascii.txt").write_bytes(b"ascii")
        result = packaging.create_archive(self.source, self.archive)
        self.assertEqual(result, {"entries": 4, "files": 2, "utf8_names": 3})
        with zipfile.ZipFile(self.archive) as package:
            self.assertEqual(set(package.namelist()),
                             {"主标😀/", "主标😀/定稿.txt", "空目录/", "ascii.txt"})
            self.assertEqual(package.read("主标😀/定稿.txt"), b"logo bytes")
            self.assertIn("空目录/", package.namelist())
            self.assertTrue(package.getinfo("主标😀/定稿.txt").flag_bits & 0x800)
            self.assertFalse(package.getinfo("ascii.txt").flag_bits & 0x800)
        self.assertEqual(packaging.check_archive(self.archive), result)

    def test_missing_utf8_markers_rejected_even_when_bytes_are_valid(self):
        self.write_member()
        self.patch_headers(local_flags=0, central_flags=0)
        with self.assertRaisesRegex(packaging.PackageError, "lacks the UTF-8 flag"):
            packaging.check_archive(self.archive)

    def test_local_utf8_marker_must_match_central(self):
        self.write_member()
        self.patch_headers(local_flags=0)
        with self.assertRaisesRegex(packaging.PackageError, "UTF-8 flags differ"):
            packaging.check_archive(self.archive)

    def test_ascii_local_utf8_marker_must_match_central(self):
        self.write_member("file.txt")
        self.patch_headers(local_flags=0x800)
        with self.assertRaisesRegex(packaging.PackageError, "UTF-8 flags differ"):
            packaging.check_archive(self.archive)

    def test_local_filename_bytes_must_match_central(self):
        self.write_member("file.txt")
        self.patch_headers(local_name=b"evil.txt")
        with self.assertRaisesRegex(packaging.PackageError, "names differ"):
            packaging.check_archive(self.archive)

    def test_local_compression_method_must_match_central(self):
        self.write_member("file.txt")
        data = bytearray(self.archive.read_bytes())
        struct.pack_into("<H", data, 8, zipfile.ZIP_DEFLATED)
        self.archive.write_bytes(data)
        original = self.archive.read_bytes()
        with self.assertRaisesRegex(packaging.PackageError, "compression methods differ"):
            packaging.check_archive(self.archive)
        self.assertEqual(self.archive.read_bytes(), original)

    def test_invalid_utf8_is_rejected(self):
        self.write_member("file.txt")
        self.patch_headers(local_flags=0x800, central_flags=0x800,
                           local_name=b"bad\xff.txt", central_name=b"bad\xff.txt")
        with self.assertRaises(packaging.PackageError):
            packaging.check_archive(self.archive)

    def test_invalid_utf8_entry_comment_is_rejected_without_changing_bytes(self):
        self.write_member(comment=b"invalid\xffcomment")
        original = self.archive.read_bytes()
        with self.assertRaises(packaging.PackageError):
            packaging.check_archive(self.archive)
        self.assertEqual(self.archive.read_bytes(), original)

    def test_valid_unicode_entry_comment_is_preserved(self):
        comment = "定稿说明😀".encode("utf-8")
        self.write_member(comment=comment)
        original = self.archive.read_bytes()
        self.assertEqual(packaging.check_archive(self.archive),
                         {"entries": 1, "files": 1, "utf8_names": 1})
        self.assertEqual(self.archive.read_bytes(), original)
        with zipfile.ZipFile(self.archive) as package:
            self.assertEqual(package.infolist()[0].comment, comment)

    def test_truncated_entry_comment_is_rejected_before_footer_can_fill_it(self):
        self.write_member(comment=b"note")
        data = bytearray(self.archive.read_bytes())
        central = data.index(b"PK\x01\x02")
        struct.pack_into("<H", data, central + 32, len(b"note") + 1)
        self.archive.write_bytes(data)
        original = self.archive.read_bytes()
        with self.assertRaisesRegex(packaging.PackageError, "Truncated central ZIP comment"):
            packaging.check_archive(self.archive)
        self.assertEqual(self.archive.read_bytes(), original)

    def test_crc_corruption_is_rejected(self):
        self.write_member("file.txt", b"content")
        data = bytearray(self.archive.read_bytes())
        data[30 + len("file.txt")] ^= 1
        self.archive.write_bytes(data)
        with self.assertRaisesRegex(packaging.PackageError, "CRC check failed"):
            packaging.check_archive(self.archive)

    def test_existing_output_is_never_overwritten(self):
        self.archive.write_bytes(b"original package")
        with self.assertRaises(FileExistsError):
            packaging.create_archive(self.source, self.archive)
        self.assertEqual(self.archive.read_bytes(), b"original package")

    def test_output_within_input_is_rejected_before_creation(self):
        inside = self.source / "self.zip"
        with self.assertRaisesRegex(packaging.PackageError, "outside the source"):
            packaging.create_archive(self.source, inside)
        self.assertFalse(inside.exists())

    def test_link_appearing_after_inventory_aborts_creation(self):
        path = self.source / "file.txt"
        path.write_bytes(b"content")
        original_is_link = packaging._is_link
        visits = 0

        def changed_to_link(candidate):
            nonlocal visits
            if candidate == path:
                visits += 1
                return visits > 1
            return original_is_link(candidate)

        with mock.patch.object(packaging, "_is_link", side_effect=changed_to_link):
            with self.assertRaisesRegex(packaging.PackageError, "Source changed to a link"):
                packaging.create_archive(self.source, self.archive)
        self.assertFalse(self.archive.exists())

    def test_linked_input_file_is_rejected_without_reading_target(self):
        target = self.root / "external.txt"
        target.write_bytes(b"outside")
        link = self.source / "link.txt"
        try:
            link.symlink_to(target)
        except OSError as error:
            self.skipTest(f"Host cannot create symlinks: {error}")
        with self.assertRaisesRegex(packaging.PackageError, "symbolic link or junction"):
            packaging.create_archive(self.source, self.archive)
        self.assertFalse(self.archive.exists())

    def test_linked_input_directory_is_rejected(self):
        linked = self.root / "source-link"
        try:
            linked.symlink_to(self.source, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"Host cannot create symlinks: {error}")
        with self.assertRaisesRegex(packaging.PackageError, "symbolic link or junction"):
            packaging.create_archive(linked, self.archive)
        self.assertFalse(self.archive.exists())

    @unittest.skipUnless(sys.platform == "win32", "Windows junction regression")
    def test_windows_junction_is_rejected_without_visiting_target(self):
        import _winapi

        external = self.root / "external"
        external.mkdir()
        (external / "outside.txt").write_bytes(b"outside")
        junction = self.source / "linked-folder"
        _winapi.CreateJunction(str(external), str(junction))
        with self.assertRaisesRegex(packaging.PackageError, "symbolic link or junction"):
            packaging.create_archive(self.source, self.archive)
        self.assertFalse(self.archive.exists())

    def test_unsafe_archive_paths_are_rejected(self):
        for name in ("../escape.txt", "/absolute.txt", "C:/drive.txt", "back\\slash.txt", "dir//"):
            with self.subTest(name=name):
                self.write_member("x" * len(name))
                self.patch_headers(local_name=name.encode(), central_name=name.encode())
                with self.assertRaisesRegex(packaging.PackageError, "Unsafe archive name"):
                    packaging.check_archive(self.archive)

    def test_windows_incompatible_names_are_rejected_without_changing_bytes(self):
        for name in ("AUX.txt", "con", "COM1.log", "lpt².txt", "NUL .txt",
                     "a?.txt", "a*.txt", 'a".txt', "a|.txt", "a<.txt", "a>.txt",
                     "trailing ", "trailing.", "dir./file.txt", "dir /file.txt",
                     "control\x01.txt", "control\x7f.txt"):
            with self.subTest(name=name):
                encoded = name.encode("utf-8")
                self.write_member("x" * len(encoded))
                self.patch_headers(local_flags=0x800, central_flags=0x800,
                                   local_name=encoded, central_name=encoded)
                original = self.archive.read_bytes()
                with self.assertRaisesRegex(packaging.PackageError, "Unsafe Windows archive name"):
                    packaging.check_archive(self.archive)
                self.assertEqual(self.archive.read_bytes(), original)

    def test_duplicate_archive_names_are_rejected(self):
        with zipfile.ZipFile(self.archive, "w") as package:
            package.writestr("file.txt", b"first")
            with self.assertWarns(UserWarning):
                package.writestr("file.txt", b"second")
        with self.assertRaisesRegex(packaging.PackageError, "Duplicate archive name"):
            packaging.check_archive(self.archive)

    def test_utf16_component_length_boundaries_for_ascii_chinese_and_emoji(self):
        for name, accepted in (("a" * 251 + ".txt", True),
                               ("a" * 252 + ".txt", False),
                               ("a" * 256 + ".txt", False),
                               ("中" * 251 + ".txt", True),
                               ("中" * 252 + ".txt", False),
                               ("😀" * 125 + "a.txt", True),
                               ("😀" * 126 + ".txt", False),
                               ("中" * 255 + "/file.txt", True),
                               ("😀" * 128 + "/file.txt", False)):
            with self.subTest(name=name, accepted=accepted):
                self.write_member(name)
                original = self.archive.read_bytes()
                if accepted:
                    self.assertEqual(packaging.check_archive(self.archive)["entries"], 1)
                else:
                    with self.assertRaisesRegex(packaging.PackageError, "exceeds 255 UTF-16 code units"):
                        packaging.check_archive(self.archive)
                self.assertEqual(self.archive.read_bytes(), original)

    def test_casefold_and_file_directory_layout_collisions_are_rejected(self):
        for names in (("file", "file/"), ("file/", "file"),
                      ("file", "file/child.txt"), ("file/child.txt", "file"),
                      ("FILE", "file/child.txt"), ("file/child.txt", "FILE"),
                      ("File.txt", "file.txt"), ("file.txt", "File.txt"),
                      ("Dir/file.txt", "dir/FILE.txt")):
            with self.subTest(names=names):
                with zipfile.ZipFile(self.archive, "w") as package:
                    for name in names:
                        package.writestr(name, b"" if name.endswith("/") else b"content")
                original = self.archive.read_bytes()
                with self.assertRaisesRegex(packaging.PackageError, "collision|ancestor"):
                    packaging.check_archive(self.archive)
                self.assertEqual(self.archive.read_bytes(), original)

    def test_shared_directory_and_implicit_directory_layouts_remain_valid(self):
        for names in (("dir/first.txt", "dir/", "dir/second.txt"),
                      ("dir/first.txt", "dir/second.txt")):
            with self.subTest(names=names):
                with zipfile.ZipFile(self.archive, "w") as package:
                    for name in names:
                        package.writestr(name, b"" if name.endswith("/") else b"content")
                self.assertEqual(packaging.check_archive(self.archive),
                                 {"entries": len(names), "files": 2, "utf8_names": 0})

    def test_failed_creation_removes_only_its_own_new_output(self):
        (self.source / "file.txt").write_bytes(b"content")
        with mock.patch.object(packaging, "check_archive", side_effect=packaging.PackageError("bad")):
            with self.assertRaisesRegex(packaging.PackageError, "bad"):
                packaging.create_archive(self.source, self.archive)
        self.assertFalse(self.archive.exists())
        self.assertEqual((self.source / "file.txt").read_bytes(), b"content")

    def test_check_never_changes_a_package(self):
        self.write_member()
        original = self.archive.read_bytes()
        packaging.check_archive(self.archive)
        self.assertEqual(self.archive.read_bytes(), original)

    def test_cli_create_check_and_invalid_archive_exit_status(self):
        (self.source / "中文😀.txt").write_bytes(b"content")
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(packaging.main(["create", str(self.source), "--output", str(self.archive)]), 0)
            self.assertEqual(packaging.main(["check", str(self.archive)]), 0)
        self.assertEqual(output.getvalue().count("headers and CRC verified"), 2)
        self.patch_headers(local_flags=0, central_flags=0)
        with contextlib.redirect_stderr(io.StringIO()) as errors:
            self.assertEqual(packaging.main(["check", str(self.archive)]), 1)
        self.assertIn("lacks the UTF-8 flag", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
