#!/bin/bash
# New-node preparation, Linux half (Task 25ac6c5f; design v0.4 section 10 P2). Run as root inside the WSL distribution the
# Owner chose for the resident's Linux side (the node-prep profile's wslDistribution), never in one that hosts GitHub runners:
#   wsl -d <dist> -u root -- bash /root/clued-nodeprep/prepare-node-linux.sh --plan  --distribution <dist>               read-only
#   wsl -d <dist> -u root -- bash /root/clued-nodeprep/prepare-node-linux.sh --apply --distribution <dist> <PLAN_SHA256>
# As root it runs only from a root-only copy outside /mnt (SCRIPT_LOCATION_REFUSED); the field guide makes that copy and checks its hash.
#
# Creates only the base directories the resident and Source v2 expect, each root:root 0700 (as on TURING):
#   /var/lib/clued-independent-ci{,/formal-spool,/runs,/workspaces}, /var/lib/clued-independent-ci-trivy-cache,
#   /opt/clued-independent-ci, /etc/clued-independent-ci
# Create-only: an existing directory is accepted only when it already is exactly that (root:root, 0700, not a link);
# anything else refuses. Nothing is deleted, moved or re-owned. The plan binds this script's bytes, the distribution and
# every directory's state; the apply recomputes it and refuses a different hash.
# Refuses outright in a distribution where GitHub runners are seen (units, runner directories, listener processes): the
# resident's Linux side must not share a distribution with PR code.
# The other prerequisites of install-resident-linux.sh and clued-ci-install-source-v2 (systemd, cgroup v2, docker.service,
# python3.12, git, the pinned toolchain node, the trusted Source checkout) are reported, not installed.
set -euo pipefail
set -o noclobber
umask 077
export PATH=/usr/bin:/bin LANG=C LC_ALL=C

SELF_SHA256=$(sha256sum "${BASH_SOURCE[0]}" | cut -d' ' -f1)
DIRS="/var/lib/clued-independent-ci /var/lib/clued-independent-ci/formal-spool /var/lib/clued-independent-ci/runs /var/lib/clued-independent-ci/workspaces /var/lib/clued-independent-ci-trivy-cache /opt/clued-independent-ci /etc/clued-independent-ci"
# Offline tests only: every path is placed under this /tmp directory, run as a normal user, owner = that user, no chown.
ROOT=${CLUED_NODEPREP_TEST_ROOT:-}
refuse() { echo "{\"status\":\"REFUSED\",\"code\":\"$1\"}"; exit 2; }

want_uid() { if [ -n "$ROOT" ]; then id -u; else echo 0; fi; }
want_gid() { if [ -n "$ROOT" ]; then id -g; else echo 0; fi; }

# absent | present | refused-<why>
dir_state() {
  local p=$ROOT$1
  if [ -L "$p" ]; then echo refused-link; return; fi
  if [ ! -e "$p" ]; then echo absent; return; fi
  if [ ! -d "$p" ]; then echo refused-not-a-directory; return; fi
  [ "$(stat -c %u:%g "$p")" = "$(want_uid):$(want_gid)" ] || { echo refused-owner; return; }
  [ "$(stat -c %a "$p")" = 700 ] || { echo refused-mode; return; }
  echo present
}

# Lines naming GitHub runners in this distribution (empty when none is seen): any `.runner` registration file under the usual roots,
# any actions.runner.* unit (loaded or only installed), any Runner.Listener process (review r1 MINOR-4).
runners_seen() {
  local d
  for d in "$ROOT"/home "$ROOT"/opt "$ROOT"/srv "$ROOT"/root "$ROOT"/usr/local "$ROOT"/var/lib; do
    [ -d "$d" ] || continue
    { find "$d" -maxdepth 4 -name .runner -type f 2>/dev/null || true; } | sed "s|^$ROOT||; s|^|runnerfile=|"
  done
  if [ -z "$ROOT" ]; then
    { systemctl list-units --all --no-legend --plain 'actions.runner.*' 2>/dev/null || true; } | awk '{print "unit="$1}'
    { systemctl list-unit-files --no-legend 'actions.runner.*' 2>/dev/null || true; } | awk '{print "unitfile="$1}'
    { ps -eo comm= 2>/dev/null || true; } | { grep '^Runner.Listener' || true; } | sed 's/^/process=/'
  fi
  return 0
}

# Review r1 MAJOR-2: as root, run only a copy only root can change: not under /mnt (Windows paths stay writable from Windows), the
# file and every folder above it owned by root and writable by nobody else. The field guide copies it to /root/clued-nodeprep and
# checks its sha256 against KooYomi first.
script_location_ok() {
  local p
  p=$(readlink -f -- "${BASH_SOURCE[0]}") || return 1
  case "$p" in /mnt/*) return 1 ;; esac
  while [ -n "$p" ]; do
    [ ! -L "$p" ] || return 1
    [ "$(stat -c %u "$p")" = 0 ] || return 1
    [ $(( 0$(stat -c %a "$p") & 022 )) = 0 ] || return 1
    [ "$p" = / ] && break
    p=$(dirname -- "$p")
  done
  return 0
}

# /var/lib, /opt and /etc themselves: real folders owned by root (review r1 NIT-3).
parents_ok() {
  local d
  for d in /var/lib /opt /etc; do
    [ -d "$ROOT$d" ] && [ ! -L "$ROOT$d" ] && [ "$(stat -c %u "$ROOT$d")" = "$(want_uid)" ] || return 1
  done
}

plan_text() {
  local dist=$1 p
  echo "contract=clued.independent-ci.node-prep-linux-plan/1"
  echo "script.sha256=$SELF_SHA256"
  echo "distribution=$dist"
  for p in $DIRS; do echo "dir $p $(dir_state "$p")"; done
}
plan_sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

# Informational only (not hashed): what install-resident-linux.sh and the Source install still need.
facts() {
  local t
  [ -n "$ROOT" ] && return 0
  echo "fact pid1=$(cat /proc/1/comm 2>/dev/null || echo unknown)"
  echo "fact cgroup2=$([ -e /sys/fs/cgroup/cgroup.controllers ] && echo yes || echo no)"
  echo "fact wsl.conf.systemd=$(grep -Eiq '^[[:space:]]*systemd[[:space:]]*=[[:space:]]*true' /etc/wsl.conf 2>/dev/null && echo yes || echo no)"
  echo "fact wsl.conf.interop=$(awk 'BEGIN{s=""} /^[[:space:]]*\[/{s=tolower($0)} s ~ /interop/ && /enabled/{gsub(/[[:space:]]/,""); print}' /etc/wsl.conf 2>/dev/null | tr '\n' ' ')"
  echo "fact run.WSL=$([ -e /run/WSL ] && echo present || echo absent)"
  echo "fact docker.service=$(systemctl is-active docker.service 2>/dev/null || true)"
  for t in python3.12 git docker; do echo "fact $t=$(command -v $t || echo missing)"; done
  echo "fact toolchain.node=$([ -x /var/lib/clued-independent-ci/toolchain-build-legacy-v1/node ] && echo present || echo missing)"
  echo "fact trusted-source=$([ -d /var/lib/clued-independent-ci/trusted-source ] && echo present || echo missing)"
}

main() {
  local mode=${1:-} dist t sha p s seen
  [ "${2:-}" = --distribution ] || refuse DISTRIBUTION_ARGUMENT_REQUIRED
  dist=${3:-}
  [[ "$dist" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$ ]] || refuse DISTRIBUTION_ARGUMENT_REQUIRED
  if [ -n "$ROOT" ]; then
    [ "$(id -u)" != 0 ] || refuse TEST_ROOT_AS_ROOT_REFUSED
    case "$ROOT" in /tmp/*) ;; *) refuse TEST_ROOT_OUTSIDE_TMP_REFUSED ;; esac
    [ -d "$ROOT" ] && [ ! -L "$ROOT" ] || refuse TEST_ROOT_REFUSED
  else
    [ "$(id -u)" = 0 ] || refuse ROOT_REQUIRED
    script_location_ok || refuse SCRIPT_LOCATION_REFUSED
  fi
  [ "${WSL_DISTRO_NAME:-}" = "$dist" ] || refuse WRONG_DISTRIBUTION
  parents_ok || refuse PARENT_DIRECTORY_REFUSED
  seen=$(runners_seen)
  [ -z "$seen" ] || { printf '%s\n' "$seen" >&2; refuse DISTRIBUTION_HOSTS_GITHUB_RUNNERS; }
  t=$(plan_text "$dist")
  for p in $DIRS; do s=$(dir_state "$p"); case "$s" in absent|present) ;; *) printf '%s\n' "$t"; refuse "DIRECTORY_EXISTS_DIFFERENT:$p:${s#refused-}" ;; esac; done
  sha=$(plan_sha "$t")
  case "$mode" in
    --plan)
      printf '%s\n' "$t"; facts
      echo "{\"status\":\"DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN\",\"planSha256\":\"$sha\"}"
      ;;
    --apply)
      [[ "${4:-}" =~ ^[0-9a-f]{64}$ ]] || refuse EXPECTED_PLAN_SHA256_REQUIRED
      [ "$4" = "$sha" ] || refuse PLAN_CHANGED_SINCE_REVIEW
      for p in $DIRS; do
        [ "$(dir_state "$p")" = absent ] || continue
        mkdir -m 0700 -- "$ROOT$p" || refuse "DIRECTORY_CREATE_FAILED:$p"     # no -p: the parent (/var/lib, /opt, /etc) must exist
        [ -n "$ROOT" ] || chown root:root -- "$p"
        [ "$(dir_state "$p")" = present ] || refuse "DIRECTORY_READBACK_MISMATCH:$p"
        echo "created $p"
      done
      echo "{\"status\":\"NODE_PREPARED_LINUX\",\"planSha256\":\"$sha\"}"
      ;;
    *) refuse MODE_REQUIRED ;;
  esac
}

# Sourcing (the offline tests) defines the functions only; running parses this whole file first.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; exit $?; fi
