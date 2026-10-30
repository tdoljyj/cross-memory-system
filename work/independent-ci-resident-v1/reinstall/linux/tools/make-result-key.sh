#!/bin/bash
# First install (README section 8c), field step 1, root in the new node's CI distribution: make this node's Ed25519 result key.
# Create-only: an existing key is never replaced (KEY_EXISTS_PRESERVE). The private key stays in this distribution and is never printed;
# the output is the public key PEM and its SHA-256 only, which go into the node's facts (first-install-facts.py) and config.
#   wsl -d <distribution> -u root -- /usr/bin/env -i PATH=/usr/bin:/bin LANG=C LC_ALL=C /usr/bin/bash --noprofile --norc make-result-key.sh
set -euo pipefail
umask 077
D=/etc/clued-independent-ci
K=$D/verify-result-key.pem
P=$D/verify-result-public.pem
refuse() { echo "{\"status\":\"REFUSED\",\"code\":\"$1\"}"; exit 1; }
[ "$(id -u)" = 0 ] || refuse ROOT_REQUIRED
[ ! -e "$K" ] && [ ! -e "$P" ] || refuse KEY_EXISTS_PRESERVE
install -d -o root -g root -m 0755 "$D"
[ "$(stat -c %U:%G "$D")" = root:root ] && [ ! -L "$D" ] || refuse KEY_DIRECTORY_NOT_ROOT
openssl genpkey -algorithm ed25519 -out "$K" 2>/dev/null
chown root:root "$K"; chmod 0600 "$K"
openssl pkey -in "$K" -pubout -out "$P" 2>/dev/null
chown root:root "$P"; chmod 0644 "$P"
openssl pkey -pubin -in "$P" -noout -text_pub 2>/dev/null | head -1 | grep -q ED25519 || refuse NOT_AN_ED25519_KEY
cat "$P"
sha256sum "$P"
