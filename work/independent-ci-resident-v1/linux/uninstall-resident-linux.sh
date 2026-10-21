#!/bin/bash
# Owner uninstall of the Linux half (DRAFT). Run as root. Keeps all evidence.
#   uninstall-resident-linux.sh --plan
#   uninstall-resident-linux.sh --apply PLAN_SHA256 [--restore-wsl-conf]
# Refuses while any clued-ci unit is active. Unit files and the tool are renamed into
# /var/lib/clued-independent-ci/resident-uninstalled-<UTC>/ (never deleted); state, receipts and
# archives stay where they are. /etc/wsl.conf is restored from the saved copy only with
# --restore-wsl-conf (the current file is renamed, not removed), followed by an Owner wsl --shutdown.
set -euo pipefail
export PATH=/usr/bin:/bin LANG=C LC_ALL=C
[ "$(id -u)" = 0 ] || { echo '{"status":"REFUSED","code":"ROOT_REQUIRED"}'; exit 1; }
OPT=/opt/clued-independent-ci/resident-v1
UNITS="clued-ci-worker@.service clued-ci-wsprep@.service clued-ci-archive@.service"
active=$(systemctl list-units --plain --no-legend --state=active,activating 'clued-ci-*@*.service' || true)
saved=$(ls -1 /etc/wsl.conf.before-resident-* 2>/dev/null | tail -1 || true)
plan_text=$(printf 'active=%s\nopt=%s\nunits=%s\nsaved-wsl-conf=%s\n' "$active" "$([ -e $OPT ] && echo yes)" "$(cd /etc/systemd/system && ls $UNITS 2>/dev/null | tr '\n' ' ')" "$saved")
plan_sha=$(printf '%s' "$plan_text" | sha256sum | cut -d' ' -f1)
if [ "${1:-}" = --plan ]; then printf '%s\n' "$plan_text"; echo "{\"status\":\"DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN\",\"planSha256\":\"$plan_sha\"}"; exit 0; fi
[ "${1:-}" = --apply ] && [ "${2:-}" = "$plan_sha" ] || { echo '{"status":"REFUSED","code":"PLAN_CHANGED_SINCE_REVIEW"}'; exit 1; }
[ -z "$active" ] || { echo '{"status":"REFUSED","code":"CLUED_CI_UNIT_ACTIVE"}'; exit 1; }
keep=/var/lib/clued-independent-ci/resident-uninstalled-$(date -u +%Y%m%dT%H%M%SZ)
install -d -o root -g root -m 0700 "$keep" "$keep/units"
for u in $UNITS; do [ -e "/etc/systemd/system/$u" ] && mv -n "/etc/systemd/system/$u" "$keep/units/$u"; done
[ -e "$OPT" ] && mv -n "$OPT" "$keep/resident-v1"
systemctl daemon-reload
if [ "${3:-}" = --restore-wsl-conf ] && [ -n "$saved" ]; then
  mv -n /etc/wsl.conf "$keep/wsl.conf.resident"
  cp -p "$saved" /etc/wsl.conf
  echo '{"status":"RESIDENT_LINUX_UNINSTALLED_WSL_CONF_RESTORED_NEEDS_WSL_RESTART","kept":"'"$keep"'"}'
  exit 0
fi
echo '{"status":"RESIDENT_LINUX_UNINSTALLED_EVIDENCE_KEPT","kept":"'"$keep"'"}'
