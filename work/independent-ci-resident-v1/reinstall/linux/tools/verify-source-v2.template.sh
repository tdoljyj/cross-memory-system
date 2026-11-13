#!/bin/bash
# Read-only verification of the Linux Source v2 install (after clued-ci-install-source-v2 --apply). Run as root.
# Prints one JSON verdict; exit 0 only when every check passes. Writes nothing (git runs with no optional locks).
set -uo pipefail
export PATH=/usr/bin:/bin LANG=C LC_ALL=C GIT_OPTIONAL_LOCKS=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
TRUSTED=/opt/clued-independent-ci/source-v2
ETC=/etc/clued-independent-ci
COMMIT=90392be5a7018450fd4c58f93b430de8ec439276
MANIFEST_SHA=03a75f76bf0f076e5b57a5feb6ca9d187fe308407801f3b3e05770e56180dcf7
SIGNED=${1:?signed roles dir (the reviewed roles-signed copy)}
ok=1; out=()
chk() { if eval "$2" >/dev/null 2>&1; then out+=("\"$1\":true"); else out+=("\"$1\":false"); ok=0; fi; }
chk root '[ "$(id -u)" = 0 ]'
chk trusted-head '[ "$(git --git-dir=$TRUSTED/.git rev-parse HEAD)" = $COMMIT ]'
chk trusted-clean '[ -z "$(git --no-optional-locks --git-dir=$TRUSTED/.git --work-tree=$TRUSTED status --porcelain=v1 --untracked-files=all)" ]'
chk trusted-owner 'stat -c %U:%G:%a $TRUSTED | grep -qx root:root:755'
chk manifest-sha '[ "$(sha256sum $ETC/formal-source-manifest-v2.json | cut -d" " -f1)" = $MANIFEST_SHA ]'
chk manifest-mode 'stat -c %U:%G:%a $ETC/formal-source-manifest-v2.json | grep -qx root:root:644'
chk roles-dir 'stat -c %U:%G:%a $ETC/roles-v3 | grep -qx root:root:700'
for r in gitleaks trivy contract-placement; do
  for s in .json .qualification.json; do
    chk "$r$s" "cmp -s $ETC/roles-v3/$r$s $SIGNED/$r$s && stat -c %U:%G:%a $ETC/roles-v3/$r$s | grep -qx root:root:600"
  done
done
chk receipt 'grep -q "\"status\":\"INSTALLED_READINESS_CONFIRMED_NOT_EXECUTED\"" /var/lib/clued-independent-ci/resident/source-v2-install-receipt.json'
# Source v1 is retired: a reinstall's phase A moved any leftover aside (prep.py), a first install never had one.
chk no-v1 '[ ! -e /opt/clued-independent-ci/source-first-formal-v1 ] && [ ! -e $ETC/roles ] && [ ! -e $ETC/formal-source-manifest-v1.json ]'
# The installed qualification module loads every role read-only (shape, pins, signature), as the installer's readiness did.
chk readiness "[ \"\$(/usr/bin/env -i /var/lib/clued-independent-ci/toolchain-build-legacy-v1/node --input-type=module -e 'const m=await import(\"file://$TRUSTED/work/actions-hosted-migration/independent-ci-v1/worker/qualification-v2.mjs\");const o=[];for(const r of [\"gitleaks\",\"trivy\",\"contract-placement\"]){try{await m.loadQualifiedPolicyV2(\"/etc/clued-independent-ci/roles-v3/\"+r+\".json\");o.push(r)}catch(e){}}process.stdout.write(o.join(\",\"))')\" = gitleaks,trivy,contract-placement ]"
status=$([ $ok = 1 ] && echo LINUX_SOURCE_V2_VERIFIED || echo LINUX_SOURCE_V2_VERIFICATION_FAILED)
echo "{\"status\":\"$status\",$(IFS=,; echo "${out[*]}")}"
[ $ok = 1 ]
