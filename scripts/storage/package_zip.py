#!/usr/bin/env python3
"""Create and check UTF-8 ZIP names with conservative Windows path rules."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import struct
import sys
import zipfile
import zlib


UTF8_FLAG = 1 << 11
CENTRAL_HEADER = struct.Struct("<4s6H3I5H2I")
LOCAL_HEADER = struct.Struct("<4s5H3I2H")
WINDOWS_FORBIDDEN = frozenset('<>:"\\|?*')
WINDOWS_DEVICES = frozenset({"con", "prn", "aux", "nul"} | {
    f"{prefix}{number}" for prefix in ("com", "lpt")
    for number in (*"123456789", "¹", "²", "³")
})


class PackageError(ValueError):
    """An archive or its source does not satisfy the packaging contract."""


def _safe_name(name: str) -> None:
    parts = name.removesuffix("/").split("/")
    if (not name or name.startswith("/") or "\\" in name or ":" in name
            or "\0" in name or any(part in ("", ".", "..") for part in parts)):
        raise PackageError(f"Unsafe archive name: {name!r}")
    for part in parts:
        # Non-BMP characters occupy two UTF-16 code units in a Windows path.
        if sum(2 if ord(character) > 0xFFFF else 1 for character in part) > 255:
            raise PackageError(f"Archive name component exceeds 255 UTF-16 code units: {name!r}")
        device = part.partition(".")[0].rstrip(" ").casefold()
        if (part.endswith((".", " ")) or device in WINDOWS_DEVICES
                or any(character in WINDOWS_FORBIDDEN or ord(character) < 32
                       or 0x7F <= ord(character) <= 0x9F for character in part)):
            raise PackageError(f"Unsafe Windows archive name: {name!r}")


def _is_link(path: Path) -> bool:
    # is_junction is available on Python 3.12+; links are rejected, never followed.
    return path.is_symlink() or getattr(path, "is_junction", lambda: False)()


def _source_entries(source: Path) -> list[tuple[Path, str]]:
    entries: list[tuple[Path, str]] = []

    def visit(directory: Path) -> None:
        with os.scandir(directory) as iterator:
            children = sorted(iterator, key=lambda entry: entry.name)
        for child in children:
            path = Path(child.path)
            if _is_link(path):
                raise PackageError(f"Source contains a symbolic link or junction: {path}")
            name = path.relative_to(source).as_posix()
            _safe_name(name)
            if child.is_dir(follow_symlinks=False):
                entries.append((path, name + "/"))
                visit(path)
            elif child.is_file(follow_symlinks=False):
                entries.append((path, name))
            else:
                raise PackageError(f"Source contains a non-regular file: {path}")

    visit(source)
    return entries


def check_archive(archive: str | Path) -> dict[str, int]:
    """Check raw header names/UTF-8 markers, safe paths and every member CRC."""
    try:
        with Path(archive).open("rb") as raw, zipfile.ZipFile(raw) as package:
            central_position = package.start_dir
            names: set[str] = set()
            paths: dict[tuple[str, ...], bool] = {}
            utf8_names = 0
            files = 0
            for member in package.infolist():
                raw.seek(central_position)
                header = raw.read(CENTRAL_HEADER.size)
                if len(header) != CENTRAL_HEADER.size:
                    raise PackageError("Truncated central ZIP header")
                central = CENTRAL_HEADER.unpack(header)
                if central[0] != b"PK\x01\x02":
                    raise PackageError("Invalid central ZIP header")
                flags, name_length, extra_length, comment_length = (
                    central[3], central[10], central[11], central[12]
                )
                name_bytes = raw.read(name_length)
                if len(name_bytes) != name_length:
                    raise PackageError("Truncated central ZIP name")
                extra_bytes = raw.read(extra_length)
                comment_bytes = raw.read(comment_length)
                # ZipFile bounds its parsed metadata to the central-directory block.
                # Its lengths also prevent raw reads from consuming an EOCD footer
                # as if it were a truncated entry's extra data or comment.
                if len(extra_bytes) != extra_length or len(member.extra) != extra_length:
                    raise PackageError("Truncated central ZIP extra data")
                if len(comment_bytes) != comment_length or len(member.comment) != comment_length:
                    raise PackageError("Truncated central ZIP comment")
                if flags & UTF8_FLAG:
                    comment_bytes.decode("utf-8", errors="strict")
                central_position += CENTRAL_HEADER.size + name_length + extra_length + comment_length

                name = name_bytes.decode("utf-8", errors="strict")
                _safe_name(name)
                if any(byte >= 0x80 for byte in name_bytes):
                    if not flags & UTF8_FLAG:
                        raise PackageError(f"Non-ASCII name lacks the UTF-8 flag: {name!r}")
                    utf8_names += 1
                if name in names:
                    raise PackageError(f"Duplicate archive name: {name!r}")
                names.add(name)
                # Conservative portability check, not Windows' full Unicode comparison.
                key = tuple(part.casefold() for part in name.removesuffix("/").split("/"))
                if key in paths:
                    raise PackageError(f"Archive path collision: {name!r}")
                paths[key] = name.endswith("/")
                files += not name.endswith("/")

                raw.seek(member.header_offset)
                header = raw.read(LOCAL_HEADER.size)
                if len(header) != LOCAL_HEADER.size:
                    raise PackageError(f"Truncated local ZIP header: {name!r}")
                local = LOCAL_HEADER.unpack(header)
                if local[0] != b"PK\x03\x04":
                    raise PackageError(f"Invalid local ZIP header: {name!r}")
                if (local[2] ^ flags) & UTF8_FLAG:
                    raise PackageError(f"Local/central UTF-8 flags differ: {name!r}")
                if local[3] != central[4]:
                    raise PackageError(f"Local/central compression methods differ: {name!r}")
                if raw.read(local[9]) != name_bytes:
                    raise PackageError(f"Local/central names differ: {name!r}")

            # Check the complete inventory so reverse archive order cannot hide a file
            # used as another member's parent. An explicit directory is optional.
            for key in paths:
                if any(paths.get(key[:length]) is False for length in range(1, len(key))):
                    raise PackageError(f"Archive file used as an ancestor: {'/'.join(key)!r}")

            corrupt = package.testzip()
            if corrupt is not None:
                raise PackageError(f"CRC check failed: {corrupt!r}")
            return {"entries": len(names), "files": files, "utf8_names": utf8_names}
    except (OSError, UnicodeError, zipfile.BadZipFile, RuntimeError,
            NotImplementedError, struct.error, zlib.error) as error:
        raise PackageError(f"Cannot validate ZIP: {error}") from error


def create_archive(source: str | Path, output: str | Path) -> dict[str, int]:
    """Create a new verified archive, refusing existing outputs and linked input."""
    source = Path(source).absolute()
    output = Path(output).absolute()
    for component in (source, *source.parents):
        if _is_link(component):
            raise PackageError(f"Source path contains a symbolic link or junction: {component}")
    if not source.is_dir():
        raise PackageError(f"Source is not a directory: {source}")
    if output.resolve().is_relative_to(source.resolve()):
        raise PackageError("Output must be outside the source directory")
    if output.suffix.lower() != ".zip":
        raise PackageError("Output filename must end with .zip")
    entries = _source_entries(source)
    # Exclusive creation also refuses an existing symlink; no package is overwritten.
    with output.open("xb") as stream:
        try:
            with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as package:
                for path, name in entries:
                    # Recheck immediately before use in case the source changed.
                    for component in (path, *path.parents):
                        if _is_link(component):
                            raise PackageError(f"Source changed to a link: {component}")
                    package.write(path, arcname=name)
            stream.flush()
            result = check_archive(output)
        except BaseException:
            stream.close()
            output.unlink()
            raise
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create", help="Create a new Unicode-safe ZIP")
    create.add_argument("source", type=Path)
    create.add_argument("--output", required=True, type=Path)
    check = commands.add_parser("check", help="Verify names, encoding flags and CRC")
    check.add_argument("archive", type=Path)
    args = parser.parse_args(argv)
    try:
        result = (create_archive(args.source, args.output) if args.command == "create"
                  else check_archive(args.archive))
    except (PackageError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"OK: {result['entries']} entries, {result['files']} files, "
          f"{result['utf8_names']} UTF-8 names; headers and CRC verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
