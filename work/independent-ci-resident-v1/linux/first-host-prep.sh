#!/bin/bash
# First install, host preparation of the resident distribution (CluedResident-Linux), ROOT, idempotent: every step that is already
# as wanted is only checked. Run by windows/first-install-host.ps1 (elevated, P1) through
#   wsl.exe -d CluedResident-Linux -u root --exec /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=C LC_ALL=C HOME=/root \
#       /usr/bin/bash --noprofile --norc <this file> <debs dir> <debs list> <toolchain node tarball> <toolchain node sha256>
# It makes the host reinstall/linux/first-install.py's phase A expects (host_ready): systemd as PID 1, cgroup v2, docker.service active
# with the CLASSIC image store, /usr/bin/python3.12 and /usr/bin/git, the toolchain node at its fixed path with the pinned sha256.
# It does NOT make the result key (reinstall/linux/tools/make-result-key.sh, run next by P1) and installs nothing of the Linux CI itself.
#
#   <debs dir>, <debs list>  the docker closure as .deb files (the prerequisite manifest's `debs`, the drill VM's set), staged and held to
#                     their sha256 by P1, and the list "<sha256>  <file name>" per line. Nothing is resolved or downloaded: the list is
#                     checked with sha256sum -c in that directory, then dpkg -i installs exactly those files (apt-get, even with
#                     --no-download, resolved against the image's lists and wanted the network: drill VM, 2026-11-16 12:58). python3.12
#                     and git are the pinned Ubuntu image's own packages.
#   <toolchain node tarball>  the official node-v<ver>-linux-x64.tar.xz as P1 staged it (its sha256 checked by P1 against the manifest);
#                     its bin/node must have <toolchain node sha256> (the template role policies' nodeExecutableSha256, from the kit).
#
# Docker's image store: Docker Engine 29 makes the containerd image store the default of a NEW install. There the image ID of a local
# image is its manifest digest, not its config digest, so the role policies' `image: sha256:<config id>` (contract-placement, loaded
# from the release asset role-image-<id>.tar.gz) would not resolve and `docker image inspect sha256:<id>` would not be that image.
# The classic store is pinned here (/etc/docker/daemon.json "features": {"containerd-snapshotter": false}) and checked afterwards:
# `docker info` must report the overlay2 graph driver and no containerd snapshotter in its driver status.
#
# Exit 0 and last line {"status":"LINUX_HOST_READY",...}; exit 2 and {"status":"RESTART_THIS_DISTRIBUTION"} when systemd was just
# enabled (P1 then restarts ONLY this distribution, `wsl -t CluedResident-Linux`, never `wsl --shutdown`, and runs this again);
# exit 1 and {"status":"REFUSED","code":...,"tail":...} otherwise (tail: the last lines the failing command wrote, JSON-escaped).
set -euo pipefail
umask 022
refuse() { echo "{\"status\":\"REFUSED\",\"code\":\"$1\"}"; exit 1; }
# a refusal with the failing command's output tail (stderr and stdout, 25 lines), escaped for JSON
refuse_tail() {
  local t
  t=$(tail -n 25 "$2" 2>/dev/null | /usr/bin/python3.12 -I -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""')
  echo "{\"status\":\"REFUSED\",\"code\":\"$1\",\"tail\":$t}"; exit 1
}
[ "$(id -u)" = 0 ] || refuse ROOT_REQUIRED
[ "$#" = 4 ] || refuse USAGE
DEBS=$1; LIST=$2; NODE_TGZ=$3; NODE_SHA=$4
[[ "$NODE_SHA" =~ ^[0-9a-f]{64}$ ]] || refuse TOOLCHAIN_NODE_SHA_SHAPE
[ -d "$DEBS" ] && [ ! -L "$DEBS" ] || refuse DEBS_DIRECTORY_MISSING
[ -f "$LIST" ] && [ ! -L "$LIST" ] || refuse DEBS_LIST_MISSING
[ -f "$NODE_TGZ" ] && [ ! -L "$NODE_TGZ" ] || refuse TOOLCHAIN_NODE_TARBALL_MISSING
export DEBIAN_FRONTEND=noninteractive
NODE=/var/lib/clued-independent-ci/toolchain-build-legacy-v1/node
DAEMON=/etc/docker/daemon.json
LOG=$(mktemp /root/clued-first-host-prep-XXXX.log)

# 1. systemd as PID 1 (the WSL boot setting; a change needs a restart of this distribution only)
if [ "$(cat /proc/1/comm)" != systemd ]; then
  if ! grep -qxE 'systemd=true' /etc/wsl.conf 2>/dev/null; then
    if [ -e /etc/wsl.conf ]; then
      grep -qE '^\[boot\]' /etc/wsl.conf && refuse WSL_CONF_HAS_A_BOOT_SECTION_WITHOUT_SYSTEMD_TRUE
      printf '\n[boot]\nsystemd=true\n' >> /etc/wsl.conf
    else
      printf '[boot]\nsystemd=true\n' > /etc/wsl.conf
    fi
  fi
  echo '{"status":"RESTART_THIS_DISTRIBUTION","windows":"wsl -t CluedResident-Linux","never":"wsl --shutdown"}'; exit 2
fi
# 2. cgroup v2 (unified hierarchy)
[ -e /sys/fs/cgroup/cgroup.controllers ] || refuse CGROUP_V2_REQUIRED

# 3. the pinned docker closure: every listed file exactly as pinned, then dpkg -i of exactly those files (once; found installed at the
#    listed versions, only checked). The list's names are plain .deb file names; nothing else in the directory is used.
grep -qvE '^[0-9a-f]{64}  [A-Za-z0-9][A-Za-z0-9._+~-]{0,200}\.deb$' "$LIST" && refuse DEBS_LIST_SHAPE
[ "$(grep -c . "$LIST")" -ge 1 ] || refuse DEBS_LIST_EMPTY
(cd "$DEBS" && sha256sum --quiet --strict -c "$LIST") >"$LOG" 2>&1 || refuse_tail DEBS_NOT_THE_PINNED_FILES "$LOG"
mapfile -t FILES < <(cut -d' ' -f3- "$LIST")
missing=0
for f in "${FILES[@]}"; do
  pkg=$(dpkg-deb -f "$DEBS/$f" Package) || refuse_tail "DEB_UNREADABLE:$f" "$LOG"
  ver=$(dpkg-deb -f "$DEBS/$f" Version) || refuse_tail "DEB_UNREADABLE:$f" "$LOG"
  have=$(dpkg-query -W -f='${Status} ${Version}' "$pkg" 2>/dev/null || true)
  [ "$have" = "install ok installed $ver" ] || missing=1
done
if [ "$missing" = 1 ]; then
  paths=(); for f in "${FILES[@]}"; do paths+=("$DEBS/$f"); done
  dpkg -i --force-confold "${paths[@]}" >"$LOG" 2>&1 || refuse_tail DPKG_INSTALL_FAILED "$LOG"
  [ -z "$(dpkg --audit 2>&1)" ] || { dpkg --audit >"$LOG" 2>&1; refuse_tail DPKG_AUDIT_NOT_CLEAN "$LOG"; }
  for f in "${FILES[@]}"; do
    pkg=$(dpkg-deb -f "$DEBS/$f" Package); ver=$(dpkg-deb -f "$DEBS/$f" Version)
    [ "$(dpkg-query -W -f='${Status} ${Version}' "$pkg")" = "install ok installed $ver" ] || refuse "DEB_NOT_THE_PINNED_VERSION:$pkg"
  done
  apt-mark -o DPkg::Lock::Timeout=120 hold docker.io containerd runc >"$LOG" 2>&1 || refuse_tail APT_MARK_HOLD_FAILED "$LOG"   # local selections only: no network
fi
[ -x /usr/bin/python3.12 ] && [ -x /usr/bin/git ] && [ -x /usr/bin/docker ] || refuse EXECUTABLES_MISSING

# 4. docker: the classic image store, then enabled and active
want_daemon='{"features":{"containerd-snapshotter":false}}'
if [ -e "$DAEMON" ]; then
  /usr/bin/python3.12 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("features",{}).get("containerd-snapshotter") is False else 1)' "$DAEMON" \
    || refuse DOCKER_DAEMON_JSON_NOT_THE_CLASSIC_STORE
else
  install -d -o root -g root -m 0755 /etc/docker
  printf '%s\n' "$want_daemon" > "$DAEMON"
  systemctl restart docker.service >"$LOG" 2>&1 || true
fi
systemctl enable docker.service >"$LOG" 2>&1 || refuse_tail DOCKER_ENABLE_FAILED "$LOG"
[ "$(systemctl is-active docker.service)" = active ] || systemctl start docker.service >"$LOG" 2>&1 || refuse_tail DOCKER_START_FAILED "$LOG"
driver=$(docker info --format '{{.Driver}}' 2>"$LOG") || refuse_tail DOCKER_INFO_FAILED "$LOG"
status=$(docker info --format '{{json .DriverStatus}}' 2>"$LOG") || refuse_tail DOCKER_INFO_FAILED "$LOG"
[ "$driver" = overlay2 ] || refuse "DOCKER_NOT_THE_CLASSIC_STORE:$driver"
case "$status" in *io.containerd.snapshotter*) refuse DOCKER_CONTAINERD_SNAPSHOTTER_ACTIVE ;; esac

# 5. the toolchain node at its fixed path (root-owned, not writable by others), with the pinned sha256
if [ -e "$NODE" ]; then
  [ "$(sha256sum "$NODE" | cut -d' ' -f1)" = "$NODE_SHA" ] || refuse TOOLCHAIN_NODE_PRESENT_NOT_THE_PINNED_ONE
else
  T=$(mktemp -d /root/clued-first-host-node-XXXX)
  tar -xJf "$NODE_TGZ" -C "$T" --wildcards --no-anchored 'bin/node' >"$LOG" 2>&1 || { rm -rf "$T"; refuse_tail TOOLCHAIN_NODE_EXTRACT_FAILED "$LOG"; }
  found=$(find "$T" -path '*/bin/node' -type f)
  [ "$(printf '%s\n' "$found" | grep -c .)" = 1 ] || { rm -rf "$T"; refuse TOOLCHAIN_NODE_NOT_ONE_IN_THE_TARBALL; }
  [ "$(sha256sum "$found" | cut -d' ' -f1)" = "$NODE_SHA" ] || { rm -rf "$T"; refuse TOOLCHAIN_NODE_NOT_THE_PINNED_ONE; }
  [ -e /var/lib/clued-independent-ci ] || install -d -o root -g root -m 0700 /var/lib/clued-independent-ci
  install -d -o root -g root -m 0755 /var/lib/clued-independent-ci/toolchain-build-legacy-v1
  install -o root -g root -m 0755 "$found" "$NODE"
  rm -rf "$T"
fi
for d in /var/lib/clued-independent-ci /var/lib/clued-independent-ci/toolchain-build-legacy-v1; do
  [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -c %u "$d")" = 0 ] && [ $(( 0$(stat -c %a "$d") & 022 )) = 0 ] || refuse "TOOLCHAIN_DIRECTORY_NOT_ROOT_PROTECTED:$d"
done
[ ! -L "$NODE" ] && [ "$(stat -c %u "$NODE")" = 0 ] && [ $(( 0$(stat -c %a "$NODE") & 022 )) = 0 ] || refuse TOOLCHAIN_NODE_NOT_ROOT_PROTECTED
rm -f "$LOG"

echo "{\"status\":\"LINUX_HOST_READY\",\"dockerDriver\":\"$driver\",\"toolchainNodeSha256\":\"$NODE_SHA\",\"debs\":${#FILES[@]},\"python\":\"$(/usr/bin/python3.12 -c 'import platform; print(platform.python_version())')\",\"git\":\"$(git --version | cut -d' ' -f3)\"}"
