#!/bin/bash
# Owner uninstall of the Linux half (DRAFT). Run as root. Keeps all evidence.
#   uninstall-resident-linux.sh --plan
#   uninstall-resident-linux.sh --apply PLAN_SHA256 [--restore-wsl-conf]
# Refuses while any clued-ci unit is active. Unit files and the tool are renamed into
# /var/lib/clued-independent-ci/resident-uninstalled-<UTC>/ (never deleted); state, receipts and
# archives stay where they are. /etc/wsl.conf is restored from the saved copy only with
# --restore-wsl-conf (the current file is renamed, not removed), followed by an Owner wsl --shutdown.
#
# Upgrade channel (task 018da927): a full reinstall is the only way the frozen channel changes, and it numbers the
# generations from 1 again on both halves. So the uninstall also moves, never deletes, into the same evidence directory:
#   /opt/clued-independent-ci/upgrade-v1           -> <kept>/upgrade-v1      (the frozen tool, signer and manifest)
#   /opt/clued-independent-ci/generations          -> <kept>/generations     (parked generations)
#   /opt/clued-independent-ci/archive              -> <kept>/opt-archive     (retention archive)
#   /opt/clued-independent-ci/.next-*              -> <kept>/next/           (leftover staging)
#   /var/lib/clued-independent-ci/resident/upgrade -> <kept>/upgrade-state   (current.json, g<N>.json, given-up/)
#   /var/lib/clued-independent-ci/resident/{install-plan.json,upgrade-v1-install-plan.json} -> <kept>/  (the install
#     writes its saved plans create-only, so a reinstall needs them out of the way)
# The live Source (source-v2, roles-v3, formal-source-manifest-v2.json) stays: it belongs to the Source v2 install.
# After a reinstall, install-resident-linux.sh --apply-upgrade-v1 and --adopt-generation 1 record what is live as g1.
set -euo pipefail
export PATH=/usr/bin:/bin LANG=C LC_ALL=C
CI_OPT=/opt/clued-independent-ci
OPT=$CI_OPT/resident-v1
STATE=/var/lib/clued-independent-ci
UNIT_DIR=/etc/systemd/system
UNITS="clued-ci-worker@.service clued-ci-wsprep@.service clued-ci-archive@.service"
UPG=$CI_OPT/upgrade-v1
GENS=$CI_OPT/generations
ARCH=$CI_OPT/archive
UPG_STATE=$STATE/resident/upgrade
SAVED_PLANS="$STATE/resident/install-plan.json $STATE/resident/upgrade-v1-install-plan.json"

staging_dirs() { (cd "$CI_OPT" 2>/dev/null && ls -1d .next-* 2>/dev/null) || true; }

# What the upgrade channel left, bound into the plan.
upgrade_channel_text() {
  local f saved=
  for f in $SAVED_PLANS; do if [ -e "$f" ]; then saved="$saved ${f##*/}"; fi; done
  printf 'upgrade-v1=%s\ngenerations=%s\narchive=%s\nstaging=%s\nupgrade-state=%s\nsaved-plans=%s\n' \
    "$([ -e "$UPG" ] && echo yes)" "$([ -d "$GENS" ] && ls -1 "$GENS" | tr '\n' ' ')" "$([ -e "$ARCH" ] && echo yes)" \
    "$(staging_dirs | tr '\n' ' ')" "$([ -d "$UPG_STATE" ] && ls -1 "$UPG_STATE" | tr '\n' ' ')" "$saved"
}

# Move (mv -n: never over an existing name) the upgrade channel into $1; every source must be gone afterwards.
keep_upgrade_channel() {
  local keep=$1 d f
  mkdir -p "$keep/next"; chmod 0700 "$keep" "$keep/next"
  if [ -e "$UPG" ]; then mv -n "$UPG" "$keep/upgrade-v1"; fi
  if [ -e "$GENS" ]; then mv -n "$GENS" "$keep/generations"; fi
  if [ -e "$ARCH" ]; then mv -n "$ARCH" "$keep/opt-archive"; fi
  for d in $(staging_dirs); do mv -n "$CI_OPT/$d" "$keep/next/"; done
  if [ -e "$UPG_STATE" ]; then mv -n "$UPG_STATE" "$keep/upgrade-state"; fi
  for f in $SAVED_PLANS; do if [ -e "$f" ]; then mv -n "$f" "$keep/"; fi; done
  [ ! -e "$UPG" ] && [ ! -e "$GENS" ] && [ ! -e "$ARCH" ] && [ ! -e "$UPG_STATE" ] && [ -z "$(staging_dirs)" ] || return 1
  for f in $SAVED_PLANS; do [ ! -e "$f" ] || return 1; done
}

main() {
  [ "$(id -u)" = 0 ] || { echo '{"status":"REFUSED","code":"ROOT_REQUIRED"}'; exit 1; }
  local active saved plan_text plan_sha keep u
  active=$(systemctl list-units --plain --no-legend --state=active,activating 'clued-ci-*@*.service' || true)
  saved=$(ls -1 /etc/wsl.conf.before-resident-* 2>/dev/null | tail -1 || true)
  plan_text=$(printf 'active=%s\nopt=%s\nunits=%s\nsaved-wsl-conf=%s\n%s\n' "$active" "$([ -e $OPT ] && echo yes)" "$(cd $UNIT_DIR && ls $UNITS 2>/dev/null | tr '\n' ' ')" "$saved" "$(upgrade_channel_text)")
  plan_sha=$(printf '%s' "$plan_text" | sha256sum | cut -d' ' -f1)
  if [ "${1:-}" = --plan ]; then printf '%s\n' "$plan_text"; echo "{\"status\":\"DRY_RUN_PLAN_ONLY_NOTHING_WRITTEN\",\"planSha256\":\"$plan_sha\"}"; exit 0; fi
  [ "${1:-}" = --apply ] && [ "${2:-}" = "$plan_sha" ] || { echo '{"status":"REFUSED","code":"PLAN_CHANGED_SINCE_REVIEW"}'; exit 1; }
  [ -z "$active" ] || { echo '{"status":"REFUSED","code":"CLUED_CI_UNIT_ACTIVE"}'; exit 1; }
  keep=$STATE/resident-uninstalled-$(date -u +%Y%m%dT%H%M%SZ)
  install -d -o root -g root -m 0700 "$keep" "$keep/units"
  for u in $UNITS; do
    if [ -e "$UNIT_DIR/$u" ]; then mv -n "$UNIT_DIR/$u" "$keep/units/$u"; fi
  done
  if [ -e "$OPT" ]; then mv -n "$OPT" "$keep/resident-v1"; fi
  keep_upgrade_channel "$keep" || { echo '{"status":"REFUSED","code":"UPGRADE_CHANNEL_NOT_KEPT","kept":"'"$keep"'"}'; exit 1; }
  systemctl daemon-reload
  if [ "${3:-}" = --restore-wsl-conf ] && [ -n "$saved" ]; then
    mv -n /etc/wsl.conf "$keep/wsl.conf.resident"
    cp -p "$saved" /etc/wsl.conf
    echo '{"status":"RESIDENT_LINUX_UNINSTALLED_WSL_CONF_RESTORED_NEEDS_WSL_RESTART","kept":"'"$keep"'"}'
    exit 0
  fi
  echo '{"status":"RESIDENT_LINUX_UNINSTALLED_EVIDENCE_KEPT","kept":"'"$keep"'"}'
}

# Sourcing (the offline tests) defines the functions only; running parses this whole file first.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; exit $?; fi
