#!/bin/bash
# Read-only verification of the Linux half (DRAFT). Run as root in the node's WSL distribution (node profile
# wslDistribution; TURING: Ubuntu-24.04): wsl -d <wslDistribution> -u root -- bash <this>
# Prints one JSON verdict; exit 0 only when every check passes. Writes nothing.
set -uo pipefail
export PATH=/usr/bin:/bin LANG=C LC_ALL=C
OPT=/opt/clued-independent-ci/resident-v1
ok=1; out=()
chk() { if eval "$2" >/dev/null 2>&1; then out+=("\"$1\":true"); else out+=("\"$1\":false"); ok=0; fi; }
chk root '[ "$(id -u)" = 0 ]'
chk systemd-pid1 '[ "$(cat /proc/1/comm)" = systemd ]'
chk docker-service 'systemctl is-active --quiet docker.service'
chk opt-owner 'stat -c %U:%G:%a "$OPT" | grep -qx root:root:755'
chk cgroup-v2 '[ -e /sys/fs/cgroup/cgroup.controllers ]'
chk pins 'python3.12 -I -c "import json,hashlib,sys;m=json.load(open(\"$OPT/manifest.json\"));sys.exit(any(hashlib.sha256(open(f[\"installedPath\"],\"rb\").read()).hexdigest()!=f[\"sha256\"] for f in m[\"files\"]))"'
for u in clued-ci-worker@.service clued-ci-wsprep@.service clued-ci-archive@.service; do
  chk "unit:$u" "stat -c %U:%G:%a /etc/systemd/system/$u | grep -qx root:root:644 && systemd-analyze verify /etc/systemd/system/$u"
  # The template units have no [Install] section, so systemd reports them "static" (exit 0); not enabled
  # means static (or disabled) and no enablement link anywhere under /etc/systemd.
  chk "not-enabled:$u" "case \"\$(systemctl is-enabled $u 2>/dev/null)\" in static|disabled) [ -z \"\$(find /etc/systemd -name '${u%@.service}@*' -type l)\" ];; *) false;; esac"
done
chk no-active-job '[ -z "$(systemctl list-units --plain --no-legend --state=active,activating clued-ci-*@*.service)" ]'
chk old-runner-disabled '! systemctl is-enabled --quiet actions.runner.tdoljyj-cross-memory-system.clued-ci-home-linux-01.service'
status=$([ $ok = 1 ] && echo RESIDENT_LINUX_VERIFIED || echo RESIDENT_LINUX_VERIFICATION_FAILED)
echo "{\"status\":\"$status\",$(IFS=,; echo "${out[*]}")}"
[ $ok = 1 ]
