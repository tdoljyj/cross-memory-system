#!/bin/bash
# One-time Owner install of the Linux half of the resident executor (DRAFT, not yet reviewed).
# Run as root inside Ubuntu-24.04 (wsl -d Ubuntu-24.04 -u root -- bash <this> ...).
#
#   install-resident-linux.sh --plan PACKAGE_DIR                         read-only: plan + sha256
#   install-resident-linux.sh --apply PACKAGE_DIR PLAN_SHA256            install exactly that plan
#   install-resident-linux.sh --continue-after-boot PLAN_SHA256          finish after the WSL restart
#
# Changes (all create-only; nothing existing is deleted or rewritten except /etc/wsl.conf, whose
# original bytes are first copied to /etc/wsl.conf.before-resident-<UTC> and which is then replaced
# atomically by rename):
#   /opt/clued-independent-ci/resident-v1/{bin/clued-ci-resident-linux,manifest.json}  root 0755/0644
#   /etc/systemd/system/clued-ci-{worker,wsprep,archive}@.service                     root 0644, never enabled
#   /var/lib/clued-independent-ci/resident/install-plan.json                          the reviewed plan
#   /etc/wsl.conf: only when systemd is not enabled yet. If a [boot] section already exists without
#     systemd=true, the script refuses (the Owner edits it); it never merges sections.
# After a wsl.conf change the Owner runs `wsl --shutdown` once; --continue-after-boot then checks
# the SAVED plan (not a recomputed one: the host necessarily changed), cgroup v2, docker.service and
# every pin. No WSL restart is needed when systemd is already enabled.
set -euo pipefail
set -o noclobber
umask 022
export PATH=/usr/bin:/bin LANG=C LC_ALL=C

mode=${1:-}
[ "$(id -u)" = 0 ] || { echo '{"status":"REFUSED","code":"ROOT_REQUIRED"}'; exit 1; }
OPT=/opt/clued-independent-ci/resident-v1
UNITS="clued-ci-worker@.service clued-ci-wsprep@.service clued-ci-archive@.service"
SAVED=/var/lib/clued-independent-ci/resident/install-plan.json
refuse() { echo "{\"status\":\"REFUSED\",\"code\":\"$1\"}"; exit 1; }

boot_state() {  # enabled | absent | conflict
  [ -e /etc/wsl.conf ] || { echo absent; return; }
  awk 'BEGIN{s="";st="absent"} /^[[:space:]]*\[/{s=$0; gsub(/[[:space:]\[\]]/,"",s); if(s=="boot" && st=="absent") st="boot-without-systemd"; next}
       s=="boot" && /^[[:space:]]*systemd[[:space:]]*=[[:space:]]*true[[:space:]]*$/{st="enabled"} END{print st}' /etc/wsl.conf \
    | sed 's/^boot-without-systemd$/conflict/'
}

plan_text() {
  pkg=$1
  (cd "$pkg" && sha256sum bin/clued-ci-resident-linux systemd/*.service manifest.json)
  echo "wsl.conf.boot=$(boot_state)"
  echo "pid1=$(cat /proc/1/comm)"
  echo "cgroup2=$([ -e /sys/fs/cgroup/cgroup.controllers ] && echo yes || echo no)"
  echo "opt.exists=$([ -e "$OPT" ] && echo yes || echo no)"
  for u in $UNITS; do echo "unit.$u.exists=$([ -e "/etc/systemd/system/$u" ] && echo yes || echo no)"; done
}

case "$mode" in
  --plan)
    pkg=${2:?}; t=$(plan_text "$pkg"); printf '%s\n' "$t"
    echo "{\"status\":\"DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN\",\"planSha256\":\"$(printf '%s' "$t" | sha256sum | cut -d' ' -f1)\"}"
    ;;
  --apply)
    pkg=${2:?}; want=${3:?}; t=$(plan_text "$pkg"); sha=$(printf '%s' "$t" | sha256sum | cut -d' ' -f1)
    [ "$want" = "$sha" ] || refuse PLAN_CHANGED_SINCE_REVIEW
    [ ! -e "$OPT" ] || refuse FRESH_INSTALL_REQUIRED
    for u in $UNITS; do [ ! -e "/etc/systemd/system/$u" ] || refuse UNIT_EXISTS; done
    [ "$(boot_state)" != conflict ] || refuse WSL_CONF_BOOT_SECTION_WITHOUT_SYSTEMD_OWNER_EDITS
    # The live CI state must be idle: same preconditions as today's ws-prep and archive scripts.
    [ ! -e /var/lib/clued-independent-ci/formal-role.lock ] || refuse ROLE_LOCK_PRESENT
    [ -z "$(ls -A /var/lib/clued-independent-ci/runs 2>/dev/null)" ] || refuse RUNS_NOT_EMPTY
    install -d -o root -g root -m 0700 /var/lib/clued-independent-ci/resident
    printf '{"planSha256":"%s","boot":"%s","manifestSha256":"%s"}\n' "$sha" "$(boot_state)" "$(sha256sum "$pkg/manifest.json" | cut -d' ' -f1)" > "$SAVED"   # noclobber: create-only
    install -d -o root -g root -m 0755 "$OPT" "$OPT/bin"
    install -o root -g root -m 0755 "$pkg/bin/clued-ci-resident-linux" "$OPT/bin/clued-ci-resident-linux"
    install -o root -g root -m 0644 "$pkg/manifest.json" "$OPT/manifest.json"
    for u in $UNITS; do install -o root -g root -m 0644 "$pkg/systemd/$u" "/etc/systemd/system/$u"; done
    if [ "$(boot_state)" != enabled ]; then
      stamp=$(date -u +%Y%m%dT%H%M%SZ)
      new=/etc/wsl.conf.resident-new-$stamp
      if [ -e /etc/wsl.conf ]; then cp -p --no-clobber /etc/wsl.conf "/etc/wsl.conf.before-resident-$stamp"; cat /etc/wsl.conf > "$new"; else : > "$new"; fi
      printf '\n[boot]\nsystemd=true\n' >> "$new"
      mv -f "$new" /etc/wsl.conf   # atomic replace; the original bytes are kept in the .before-resident copy
      echo '{"status":"INSTALLED_NEEDS_WSL_RESTART","next":"Owner: wsl --shutdown, then --continue-after-boot <planSha256>"}'
      exit 0
    fi
    exec "$0" --continue-after-boot "$sha"
    ;;
  --continue-after-boot)
    want=${2:?}
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
    ;;
  *) refuse MODE_REQUIRED ;;
esac
