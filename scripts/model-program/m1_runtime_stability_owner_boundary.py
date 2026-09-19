"""Legacy launch-shape lint only. No Python function is an owner gate in r5.
The production Python module always denies execution, even if this helper is
replaced. The native executable owns all runtime state; it imports no Python.
"""
from __future__ import annotations
from pathlib import Path

class OwnerBoundaryError(RuntimeError):
    pass

def validate_native_owner_command(image: str, argv: list[str], script_path: Path) -> None:
    """Validate the fixed launch form. Returning None does not confer authority."""
    # Deliberately do not accept -c/-m, runpy, -i, callbacks, test modes, or a
    # caller-provided PID/process/registry. A mutable Python flag is not proof.
    if len(argv) != 9 or argv[1:3] != ["-I", "-S"]:
        raise OwnerBoundaryError("OWNER_DIRECT_ISOLATED_LAUNCH_REQUIRED")
    if argv[4:6] != ["--execute", "--profile"] or argv[7] != "--output-dir":
        raise OwnerBoundaryError("OWNER_FIXED_ARGUMENT_SCHEMA_REQUIRED")
    if not Path(argv[0]).is_absolute() or not Path(argv[3]).is_absolute():
        raise OwnerBoundaryError("OWNER_ABSOLUTE_PATHS_REQUIRED")
    try:
        if not Path(image).samefile(Path(argv[0])):
            raise OwnerBoundaryError("OWNER_NATIVE_EXECUTABLE_MISMATCH")
        if not script_path.samefile(Path(argv[3])):
            raise OwnerBoundaryError("OWNER_NATIVE_SCRIPT_MISMATCH")
    except (OSError, ValueError) as exc:
        raise OwnerBoundaryError("OWNER_NATIVE_PATH_UNVERIFIED") from exc
    if not Path(argv[6]).is_absolute() or not Path(argv[8]).is_absolute():
        raise OwnerBoundaryError("OWNER_ABSOLUTE_PATHS_REQUIRED")
    if not Path(argv[6]).is_file():
        raise OwnerBoundaryError("OWNER_PROFILE_FILE_REQUIRED")


def require_owner_process(script_path: Path) -> None:
    raise OwnerBoundaryError("NATIVE_OWNER_REQUIRED / PYTHON_IS_NOT_AN_AUTHORITY_BOUNDARY")
