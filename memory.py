#!/usr/bin/env python3
"""Compatibility entry; implementation lives in scripts. No new command or authority."""
from pathlib import Path as _CluedPath
_clued_implementation = _CluedPath(__file__).resolve().parent / "scripts" / "memory.py"
__file__ = str(_clued_implementation)
# Execute in this module namespace so import identity and monkeypatch globals survive.
exec(compile(_clued_implementation.read_bytes(), __file__, "exec"), globals(), globals())
