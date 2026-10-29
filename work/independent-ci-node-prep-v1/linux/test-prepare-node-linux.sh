#!/bin/bash
# Offline tests for prepare-node-linux.sh, as a normal user under a fresh /tmp directory (CLUED_NODEPREP_TEST_ROOT).
# Run inside any WSL distribution or Linux host:  bash test-prepare-node-linux.sh
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOOL="$HERE/prepare-node-linux.sh"
pass=0; fail=0
ok() { if [ "$1" = 0 ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $2"; fi; }
check() { local name=$1; shift; "$@" >/dev/null 2>&1; ok $? "$name"; }
fresh() { R=$(mktemp -d /tmp/nodeprep-linux-test.XXXXXXXX); mkdir -p "$R/var/lib" "$R/opt" "$R/etc" "$R/home/u"; }
run() { CLUED_NODEPREP_TEST_ROOT=$R WSL_DISTRO_NAME=${DIST:-Fixture-Linux} bash "$TOOL" "$@" 2>/dev/null; }
sha_of() { sed -n 's/.*"planSha256":"\([0-9a-f]\{64\}\)".*/\1/p'; }
DIRS="/var/lib/clued-independent-ci /var/lib/clued-independent-ci/formal-spool /var/lib/clued-independent-ci/runs /var/lib/clued-independent-ci/workspaces /var/lib/clued-independent-ci-trivy-cache /opt/clued-independent-ci /etc/clued-independent-ci"

[ "$(id -u)" != 0 ] || { echo "run as a normal user"; exit 1; }

fresh
out=$(run --plan --distribution Fixture-Linux); sha=$(printf '%s' "$out" | sha_of)
check 'plan prints a sha256' test -n "$sha"
check 'plan lists every directory absent' test "$(printf '%s\n' "$out" | grep -c '^dir .* absent$')" = 7
check 'plan wrote nothing' test -z "$(find "$R/var/lib" "$R/opt" "$R/etc" -mindepth 1)"
out2=$(run --plan --distribution Fixture-Linux); check 'plan deterministic' test "$(printf '%s' "$out2" | sha_of)" = "$sha"
out=$(run --apply --distribution Fixture-Linux "$(printf '0%.0s' {1..64})"); check 'wrong hash refused' grep -q PLAN_CHANGED_SINCE_REVIEW <<<"$out"
check 'wrong hash wrote nothing' test -z "$(find "$R/var/lib" "$R/opt" "$R/etc" -mindepth 1)"
out=$(run --apply --distribution Fixture-Linux); check 'apply needs the hash' grep -q EXPECTED_PLAN_SHA256_REQUIRED <<<"$out"
out=$(run --apply --distribution Fixture-Linux "$sha"); check 'apply completes' grep -q NODE_PREPARED_LINUX <<<"$out"
for p in $DIRS; do check "created 0700: $p" test "$(stat -c %a "$R$p")" = 700; done
out=$(run --plan --distribution Fixture-Linux); sha2=$(printf '%s' "$out" | sha_of)
check 'second plan: all present' test "$(printf '%s\n' "$out" | grep -c '^dir .* present$')" = 7
check 'second plan has another hash' test "$sha2" != "$sha"
out=$(run --apply --distribution Fixture-Linux "$sha"); check 'old plan refused after apply' grep -q PLAN_CHANGED_SINCE_REVIEW <<<"$out"
out=$(run --apply --distribution Fixture-Linux "$sha2"); check 'apply of an all-present plan creates nothing' bash -c "grep -q NODE_PREPARED_LINUX <<<'$out' && ! grep -q '^created' <<<'$out'"
rm -rf "$R"

fresh; mkdir -m 0755 "$R/var/lib/clued-independent-ci"
out=$(run --plan --distribution Fixture-Linux); check 'existing 0755 refused' grep -q 'DIRECTORY_EXISTS_DIFFERENT:/var/lib/clued-independent-ci:mode' <<<"$out"
rm -rf "$R"
fresh; ln -s /tmp "$R/opt/clued-independent-ci"
out=$(run --plan --distribution Fixture-Linux); check 'symlink refused' grep -q 'DIRECTORY_EXISTS_DIFFERENT:/opt/clued-independent-ci:link' <<<"$out"
rm -rf "$R"
fresh; : > "$R/etc/clued-independent-ci"
out=$(run --plan --distribution Fixture-Linux); check 'file in place refused' grep -q 'DIRECTORY_EXISTS_DIFFERENT:/etc/clued-independent-ci:not-a-directory' <<<"$out"
rm -rf "$R"
fresh; mkdir -p "$R/home/u/actions-runner"; : > "$R/home/u/actions-runner/.runner"
out=$(run --plan --distribution Fixture-Linux); check 'distribution with a GitHub runner refused' grep -q DISTRIBUTION_HOSTS_GITHUB_RUNNERS <<<"$out"
rm -rf "$R"
fresh
out=$(DIST=Other run --plan --distribution Fixture-Linux); check 'other distribution refused' grep -q WRONG_DISTRIBUTION <<<"$out"
out=$(run --plan); check 'distribution argument required' grep -q DISTRIBUTION_ARGUMENT_REQUIRED <<<"$out"
out=$(run --plan --distribution 'bad name'); check 'bad distribution name refused' grep -q DISTRIBUTION_ARGUMENT_REQUIRED <<<"$out"
out=$(CLUED_NODEPREP_TEST_ROOT=/var/tmp WSL_DISTRO_NAME=Fixture-Linux bash "$TOOL" --plan --distribution Fixture-Linux 2>/dev/null); check 'test root outside /tmp refused' grep -q TEST_ROOT_OUTSIDE_TMP_REFUSED <<<"$out"
out=$(WSL_DISTRO_NAME=Fixture-Linux bash "$TOOL" --plan --distribution Fixture-Linux 2>/dev/null); check 'real mode needs root' grep -q ROOT_REQUIRED <<<"$out"
rm -rf "$R"

# Static: never deletes, moves or re-owns anything existing; creates without -p.
for w in 'rm ' 'mv ' 'rmdir' 'chmod' 'mkdir -p' 'install -d' 'ln '; do check "tool never uses '$w'" bash -c "! grep -v '^#' '$TOOL' | grep -q -- '$w'"; done

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
