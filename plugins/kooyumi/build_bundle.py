"""Build/check the exact private BeamingFace bundle from canonical repository sources."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import zipfile


__version__ = "1.0.2"
REPOSITORY_ROOT = Path(__file__).absolute().parents[2]
APP_ID = "asdk_app_6ad0cb1db0c48191a97bd2bd158836e3"
PACKAGE_NAME = "dev-6ad0cb1db0c48191a97bd2bd158836e3"
PACKAGE_VERSION = "1.0.3"
SKILL_VERSION = "1.0.25"
DESCRIPTION = "BeamingFace：授权的个人与项目上下文服务"
INTERFACE = {
    "capabilities": [], "category": "Other", "defaultPrompt": None,
    "developerName": "App developer", "displayName": "BeamingFace",
    "longDescription": DESCRIPTION, "shortDescription": DESCRIPTION,
}
SKILL_FILES = (
    "SKILL.md", "agents/openai.yaml", "references/connection-repair.md",
    "references/engineering.md", "references/memory-operations.md",
)
METADATA_FILES = ("plugin.json", ".codex-plugin/plugin.json", ".app.json")
ARCHIVE_FILES = tuple(sorted((*METADATA_FILES, *("skills/clued/" + p for p in SKILL_FILES))))
TIMESTAMP = (1980, 1, 1, 0, 0, 0)
MODE = (stat.S_IFREG | 0o644) << 16
MAX_FILE_BYTES = 1024 * 1024
MAX_ARCHIVE_BYTES = 9 * MAX_FILE_BYTES


class BundleError(ValueError):
    """Closed diagnostic codes; never include source contents or credentials."""


def require(condition, code):
    if not condition:
        raise BundleError(code)


def plain_stat(path):
    info = path.lstat()
    require(not stat.S_ISLNK(info.st_mode) and not (
        getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    ), "linked_path_rejected")
    return info


def plain_ancestors(path):
    for parent in reversed((path, *path.parents)):
        require(stat.S_ISDIR(plain_stat(parent).st_mode), "directory_required")


def tree_files(folder, *, ignore_python_cache=False):
    plain_ancestors(folder)
    result = []
    for entry in sorted(folder.iterdir(), key=lambda p: p.name):
        info = plain_stat(entry)
        if stat.S_ISDIR(info.st_mode):
            if ignore_python_cache and entry.name == "__pycache__":
                continue
            result.extend(entry.name + "/" + child for child in
                          tree_files(entry, ignore_python_cache=ignore_python_cache))
        else:
            require(stat.S_ISREG(info.st_mode), "regular_file_required")
            result.append(entry.name)
    return sorted(result)


def read_regular(path, limit=MAX_FILE_BYTES):
    plain_ancestors(path.parent)
    before = plain_stat(path)
    require(stat.S_ISREG(before.st_mode) and before.st_size <= limit, "source_file_invalid")
    with path.open("rb") as stream:
        opened = os.fstat(stream.fileno())
        require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino), "source_changed")
        raw = stream.read(limit + 1)
    after = plain_stat(path)
    require(len(raw) <= limit and
            (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), "source_changed")
    return raw


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate_json_key")
        result[key] = value
    return result


def metadata(raw):
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise BundleError("metadata_json_invalid") from error


def validate_metadata(files):
    common = {"name": PACKAGE_NAME, "version": PACKAGE_VERSION,
              "description": DESCRIPTION, "author": {"name": "App developer"}}
    root = {**common, "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
            "extensions": {"com.openai": {"apps": "./.app.json", "interface": INTERFACE}}}
    compatibility = {**common, "apps": "./.app.json", "interface": INTERFACE, "skills": "./skills/"}
    require(metadata(files["plugin.json"]) == root, "portable_manifest_mismatch")
    require(metadata(files[".codex-plugin/plugin.json"]) == compatibility, "compatibility_manifest_mismatch")
    require(metadata(files[".app.json"]) == {"apps": {PACKAGE_NAME: {"id": APP_ID}}}, "registered_app_mismatch")


def source_files():
    """No source override: the sole Skill root is this checkout's skills/clued."""
    repository = REPOSITORY_ROOT
    plugin = repository / "plugins/kooyumi"
    skill = repository / "skills/clued"
    found = tree_files(plugin, ignore_python_cache=True)
    require(set(METADATA_FILES) <= set(found) <=
            set((*METADATA_FILES, "build_bundle.py", "test_build_bundle.py")), "plugin_inventory_invalid")
    require(tree_files(skill) == sorted(SKILL_FILES), "skill_inventory_invalid")
    files = {name: read_regular(plugin / name) for name in METADATA_FILES}
    files.update({"skills/clued/" + name: read_regular(skill / name) for name in SKILL_FILES})
    validate_metadata(files)
    try:
        text = files["skills/clued/SKILL.md"].decode("utf-8")
        for name in SKILL_FILES:
            files["skills/clued/" + name].decode("utf-8")
    except UnicodeError as error:
        raise BundleError("skill_utf8_invalid") from error
    require(text.startswith("---\n") or text.startswith("---\r\n"), "skill_header_invalid")
    header = re.split(r"\r?\n---(?:\r?\n|$)", text, maxsplit=1)[0]
    require(re.search(r"^name: clued\r?$", header, re.M) is not None and
            re.search(r'^  version: "' + re.escape(SKILL_VERSION) + r'"\r?$', header, re.M) is not None,
            "skill_identity_mismatch")
    return files


def zip_bytes(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, TIMESTAMP)
            info.create_system = 3
            info.external_attr = MODE
            info.compress_type = zipfile.ZIP_STORED
            archive.writestr(info, files[name])
    return output.getvalue()


def archive_path(value, *, must_exist):
    path = Path(value)
    require(path.is_absolute() and ".." not in path.parts and path.suffix.lower() == ".zip",
            "archive_path_invalid")
    plain_ancestors(path.parent)
    resolved = path.parent.resolve() / path.name
    repository = REPOSITORY_ROOT.resolve()
    temporary = Path(tempfile.gettempdir()).resolve()
    require(resolved.is_relative_to(temporary) and not resolved.is_relative_to(repository),
            "archive_must_be_in_temp_outside_repository")
    if must_exist:
        require(stat.S_ISREG(plain_stat(path).st_mode), "archive_file_invalid")
    else:
        require(not os.path.lexists(path), "archive_already_exists")
    return path


def validate_zip(raw, expected):
    require(len(raw) <= MAX_ARCHIVE_BYTES, "archive_size_invalid")
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            require([entry.filename for entry in entries] == list(ARCHIVE_FILES), "archive_inventory_invalid")
            actual = {}
            for entry in entries:
                require(not entry.is_dir() and entry.file_size <= MAX_FILE_BYTES and
                        entry.compress_type == zipfile.ZIP_STORED and entry.date_time == TIMESTAMP and
                        entry.create_system == 3 and entry.external_attr == MODE and
                        not entry.extra and not entry.comment and not entry.flag_bits,
                        "archive_entry_invalid")
                actual[entry.filename] = archive.read(entry)
            require(not archive.comment and actual == expected, "archive_source_mismatch")
        require(raw == zip_bytes(expected), "archive_not_deterministic")
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as error:
        raise BundleError("archive_invalid") from error


def summary(path, raw, files):
    hashes = {name: hashlib.sha256(files[name]).hexdigest() for name in sorted(files)}
    return {"status": "bundle_verified", "archive": str(path), "name": PACKAGE_NAME,
            "version": PACKAGE_VERSION, "skill_version": SKILL_VERSION,
            "app_ids": [APP_ID], "file_count": len(files), "files_sha256": hashes,
            "skill_files_sha256": {name: digest for name, digest in hashes.items() if name.startswith("skills/clued/")},
            "zip_sha256": hashlib.sha256(raw).hexdigest()}


def check_archive(value):
    path = archive_path(value, must_exist=True)
    files = source_files()
    raw = read_regular(path, MAX_ARCHIVE_BYTES)
    validate_zip(raw, files)
    require(source_files() == files, "source_changed")
    return summary(path, raw, files)


def build_archive(value):
    path = archive_path(value, must_exist=False)
    files = source_files()
    raw = zip_bytes(files)
    validate_zip(raw, files)
    require(source_files() == files, "source_changed")
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    return check_archive(path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--out", type=Path, help="New absolute ZIP path under Temp, outside the repository")
    mode.add_argument("--check", type=Path, help="Verify an existing absolute ZIP against canonical sources")
    args = parser.parse_args(argv)
    try:
        result = build_archive(args.out) if args.out is not None else check_archive(args.check)
    except (BundleError, OSError, ValueError):
        print(json.dumps({"status": "bundle_rejected"}))
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
