#!/bin/sh
# Run a Claude Code hook script with the first working Python 3 interpreter.
#
# .claude/settings.json used to call `python3` directly. On Windows `python3`
# is often the Microsoft Store App Execution Alias stub: it exits 49 (9009)
# without running anything, so every hook failed as a silent non-blocking
# error. Each candidate is probed before use. The hook replaces this shell
# (exec), so its stdin, output and exit status pass through unchanged.
#
# Usage: sh run_python.sh <script.py> [args...]
# CLUED_HOOK_PYTHON names an interpreter to use instead of probing.
# Version: 1.0.3

probe() {
  "$@" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' </dev/null >/dev/null 2>&1
}

if [ -n "${CLUED_HOOK_PYTHON:-}" ]; then
  exec "$CLUED_HOOK_PYTHON" "$@"
fi

case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*) candidates="py python python3" ;;
  *) candidates="python3 python" ;;
esac

for candidate in $candidates; do
  command -v "$candidate" >/dev/null 2>&1 || continue
  if [ "$candidate" = py ]; then
    probe py -3 && exec py -3 "$@"
  else
    probe "$candidate" && exec "$candidate" "$@"
  fi
done

echo "BeamingFace hook: no working Python 3.8+ interpreter (tried: $candidates); $1 did not run." >&2
exit 1
