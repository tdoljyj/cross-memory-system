#!/usr/bin/env bash
# Serialize jobs that bind fixed host ports when several runners share one host.
#
# Usage: host-port-lock.sh acquire|release NAME
#
# acquire starts a background holder that keeps an flock on /tmp/clued-ci-NAME.lock
# until release (or until the runner's orphan-process cleanup at job end kills it),
# so the lock spans several workflow steps and is never left behind by a cancelled job.
set -euo pipefail

action="${1:-}"
name="${2:-}"
[[ "$name" =~ ^[a-z0-9-]+$ ]] || { echo "Usage: $0 acquire|release NAME" >&2; exit 2; }

lock="/tmp/clued-ci-${name}.lock"
holder="${RUNNER_TEMP:?RUNNER_TEMP is required}/clued-ci-${name}.lock-holder"
ready="${holder}.ready"
timeout_seconds="${HOST_PORT_LOCK_TIMEOUT_SECONDS:-3600}"

case "$action" in
  acquire)
    rm -f "$ready"
    nohup bash -c 'exec 9>>"$1"; flock 9; : > "$2"; exec sleep 86400' _ "$lock" "$ready" >/dev/null 2>&1 &
    echo "$!" > "$holder"
    waited=0
    until [ -f "$ready" ]; do
      if ! kill -0 "$(cat "$holder")" 2>/dev/null; then
        echo "Host lock holder for $lock exited before acquiring the lock." >&2
        exit 1
      fi
      if [ "$waited" -ge "$timeout_seconds" ]; then
        kill "$(cat "$holder")" 2>/dev/null || true
        echo "Timed out after ${waited}s waiting for host lock $lock." >&2
        exit 1
      fi
      if [ "$waited" -gt 0 ] && [ $((waited % 60)) -eq 0 ]; then
        echo "Waiting for host lock $lock (${waited}s)..."
      fi
      sleep 2
      waited=$((waited + 2))
    done
    echo "Acquired host lock $lock after ${waited}s."
    ;;
  release)
    if [ -f "$holder" ]; then
      kill "$(cat "$holder")" 2>/dev/null || true
    fi
    rm -f "$holder" "$ready"
    ;;
  *)
    echo "Usage: $0 acquire|release NAME" >&2
    exit 2
    ;;
esac
