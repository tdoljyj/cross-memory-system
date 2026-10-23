#!/bin/bash
# One-time Owner install of the Linux half of the resident executor (DRAFT, not yet reviewed).
# Run as root inside the node's WSL distribution, its node profile's wslDistribution (TURING: Ubuntu-24.04):
#   wsl -d <wslDistribution> -u root -- bash <this> ...
#
#   install-resident-linux.sh --plan PACKAGE_DIR                         read-only: plan + sha256
#   install-resident-linux.sh --apply PACKAGE_DIR PLAN_SHA256            install exactly that plan
#   install-resident-linux.sh --continue-after-boot PLAN_SHA256          finish after the WSL restart
#
# Changes (all create-only; nothing existing is deleted or rewritten except /etc/wsl.conf, whose
# original bytes are first copied to /etc/wsl.conf.before-resident-<UTC> and which is then replaced
# atomically by rename):
#   /var/lib/clued-independent-ci/resident-staging.<random>/            root 0700, the copy that is installed (kept)
#   /opt/clued-independent-ci/resident-v1/{bin/clued-ci-resident-linux,manifest.json}  root 0755/0644
#   /etc/systemd/system/clued-ci-{worker,wsprep,archive}@.service                     root 0644, never enabled
#   /var/lib/clued-independent-ci/resident/install-plan.json                          the reviewed plan
#   /etc/wsl.conf: only when systemd is not enabled yet. If a [boot] section already exists without
#     systemd=true, the script refuses (the Owner edits it); it never merges sections.
# After a wsl.conf change the Owner runs `wsl --shutdown` once; --continue-after-boot then checks
# the SAVED plan (not a recomputed one: the host necessarily changed), cgroup v2, docker.service and
# every pin. No WSL restart is needed when systemd is already enabled.
#
# Review MINOR-6 (independent review of PR-A):
#   - --apply first copies the exact package files into a NEW root-owned 0700 staging directory and
#     computes the plan from THAT copy; it installs only from the staging copy, so a package directory that
#     the Owner's user (or Windows, through /mnt/c) can still change is read once and never again;
#   - the plan binds this script's own bytes, every package file including manifest.json, and the host facts;
#     the saved plan repeats the manifest hash it was computed with;
#   - nothing re-executes the script from disk: the whole program is one function that bash parses
#     completely before running it, and --apply continues in the same process.
set -euo pipefail
set -o noclobber
umask 022
export PATH=/usr/bin:/bin LANG=C LC_ALL=C

OPT=/opt/clued-independent-ci/resident-v1
STATE=/var/lib/clued-independent-ci
UNITS="clued-ci-worker@.service clued-ci-wsprep@.service clued-ci-archive@.service"
FILES="bin/clued-ci-resident-linux manifest.json systemd/clued-ci-worker@.service systemd/clued-ci-wsprep@.service systemd/clued-ci-archive@.service"
SAVED=$STATE/resident/install-plan.json
SELF_SHA256=$(sha256sum "${BASH_SOURCE[0]}" | cut -d' ' -f1)
refuse() { echo "{\"status\":\"REFUSED\",\"code\":\"$1\"}"; exit 1; }

boot_state() {  # enabled | absent | conflict
  [ -e /etc/wsl.conf ] || { echo absent; return; }
  awk 'BEGIN{s="";st="absent"} /^[[:space:]]*\[/{s=$0; gsub(/[[:space:]\[\]]/,"",s); if(s=="boot" && st=="absent") st="boot-without-systemd"; next}
       s=="boot" && /^[[:space:]]*systemd[[:space:]]*=[[:space:]]*true[[:space:]]*$/{st="enabled"} END{print st}' /etc/wsl.conf \
    | sed 's/^boot-without-systemd$/conflict/'
}

# Every package file must be a regular, single-link file (no symlink is followed into the plan or the copy).
package_files_ok() {
  local f
  for f in $FILES; do
    [ -f "$1/$f" ] && [ ! -L "$1/$f" ] && [ "$(stat -c %h "$1/$f")" = 1 ] || return 1
  done
}

plan_text() {
  local pkg=$1
  echo "install-script.sha256=$SELF_SHA256"
  (cd "$pkg" && sha256sum $FILES)
  echo "wsl.conf.boot=$(boot_state)"
  echo "pid1=$(cat /proc/1/comm)"
  echo "cgroup2=$([ -e /sys/fs/cgroup/cgroup.controllers ] && echo yes || echo no)"
  echo "opt.exists=$([ -e "$OPT" ] && echo yes || echo no)"
  for u in $UNITS; do echo "unit.$u.exists=$([ -e "/etc/systemd/system/$u" ] && echo yes || echo no)"; done
}
plan_sha() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }

# A NEW root-owned 0700 directory holding exactly the package files, copied once (the only read of PACKAGE_DIR).
stage_copy() {
  local pkg=$1 st f
  st=$(mktemp -d "$STATE/resident-staging.XXXXXXXXXX")
  chown root:root "$st"; chmod 0700 "$st"
  for f in $FILES; do
    install -D -o root -g root -m 0600 "$pkg/$f" "$st/$f"
  done
  echo "$st"
}

continue_after_boot() {
  local want=$1
  grep -q "\"planSha256\":\"$want\"" "$SAVED" || refuse SAVED_PLAN_MISMATCH
  grep -q "\"manifestSha256\":\"$(sha256sum "$OPT/manifest.json" | cut -d' ' -f1)\"" "$SAVED" || refuse INSTALLED_MANIFEST_NOT_THE_REVIEWED_ONE
  [ "$(cat /proc/1/comm)" = systemd ] || refuse SYSTEMD_NOT_PID1_RESTART_WSL
  [ -e /sys/fs/cgroup/cgroup.controllers ] || refuse CGROUP_V2_REQUIRED_OWNER_DECISION
  systemctl is-active --quiet docker.service || refuse DOCKER_NOT_A_SYSTEMD_SERVICE_OWNER_DECISION
  systemctl daemon-reload
  for u in $UNITS; do systemd-analyze verify "/etc/systemd/system/$u" >/dev/null; done
  python3.12 -I -c 'import json,hashlib,sys
m=json.load(open("/opt/clued-independent-ci/resident-v1/manifest.json"))
sys.exit(any(hashlib.sha256(open(f["installedPath"],"rb").read()).hexdigest()!=f["sha256"] for f in m["files"]))' || refuse RESIDENT_LINUX_PIN_CHANGED
  echo "{\"status\":\"RESIDENT_LINUX_INSTALLED\",\"planSha256\":\"$want\"}"
}

main() {
  local mode=${1:-} pkg want t sha st
  [ "$(id -u)" = 0 ] || refuse ROOT_REQUIRED
  case "$mode" in
    --plan)
      pkg=${2:?}; package_files_ok "$pkg" || refuse PACKAGE_FILE_SHAPE_REFUSED
      t=$(plan_text "$pkg"); printf '%s\n' "$t"
      echo "{\"status\":\"DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN\",\"planSha256\":\"$(plan_sha "$t")\"}"
      ;;
    --apply)
      pkg=${2:?}; want=${3:?}
      [ ! -e "$OPT" ] || refuse FRESH_INSTALL_REQUIRED
      for u in $UNITS; do [ ! -e "/etc/systemd/system/$u" ] || refuse UNIT_EXISTS; done
      [ "$(boot_state)" != conflict ] || refuse WSL_CONF_BOOT_SECTION_WITHOUT_SYSTEMD_OWNER_EDITS
      # The live CI state must be idle: same preconditions as today's ws-prep and archive scripts.
      [ ! -e $STATE/formal-role.lock ] || refuse ROLE_LOCK_PRESENT
      [ -z "$(ls -A $STATE/runs 2>/dev/null)" ] || refuse RUNS_NOT_EMPTY
      package_files_ok "$pkg" || refuse PACKAGE_FILE_SHAPE_REFUSED
      st=$(stage_copy "$pkg")
      # The plan is computed from the staged copy: what was reviewed is exactly what is installed.
      t=$(plan_text "$st"); sha=$(plan_sha "$t")
      [ "$want" = "$sha" ] || refuse PLAN_CHANGED_SINCE_REVIEW
      install -d -o root -g root -m 0700 $STATE/resident
      printf '{"planSha256":"%s","boot":"%s","manifestSha256":"%s","installScriptSha256":"%s","staging":"%s"}\n' "$sha" "$(boot_state)" "$(sha256sum "$st/manifest.json" | cut -d' ' -f1)" "$SELF_SHA256" "$st" > "$SAVED"   # noclobber: create-only
      install -d -o root -g root -m 0755 "$OPT" "$OPT/bin"
      install -o root -g root -m 0755 "$st/bin/clued-ci-resident-linux" "$OPT/bin/clued-ci-resident-linux"
      install -o root -g root -m 0644 "$st/manifest.json" "$OPT/manifest.json"
      for u in $UNITS; do install -o root -g root -m 0644 "$st/systemd/$u" "/etc/systemd/system/$u"; done
      if [ "$(boot_state)" != enabled ]; then
        stamp=$(date -u +%Y%m%dT%H%M%SZ)
        new=/etc/wsl.conf.resident-new-$stamp
        if [ -e /etc/wsl.conf ]; then cp -p --no-clobber /etc/wsl.conf "/etc/wsl.conf.before-resident-$stamp"; cat /etc/wsl.conf > "$new"; else : > "$new"; fi
        printf '\n[boot]\nsystemd=true\n' >> "$new"
        mv -f "$new" /etc/wsl.conf   # atomic replace; the original bytes are kept in the .before-resident copy
        echo '{"status":"INSTALLED_NEEDS_WSL_RESTART","next":"Owner: wsl --shutdown, then --continue-after-boot <planSha256>"}'
        return 0
      fi
      continue_after_boot "$sha"   # same process; the script is never re-read from disk
      ;;
    --continue-after-boot)
      continue_after_boot "${2:?}"
      ;;
    *) refuse MODE_REQUIRED ;;
  esac
}

# Sourcing (the offline tests) defines the functions only; running parses this whole file first.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; exit $?; fi
