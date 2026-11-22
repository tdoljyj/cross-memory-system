#!/usr/bin/env bash
# gitleaks over the commits <base>..<head> of one repository, merge commits included, failing closed
# (FABLE-cicd-simplify-20261122 §3.1, R1). The required gitleaks job of clued-required-tests.yml runs it;
# the push entry (hooks/push.sh) runs the same three steps and can call this file instead of its own copy.
#
#   bash scripts/ci/gitleaks-range.sh <repository> <base> <head> -- <gitleaks command> git <source> [options...]
#
# The command after -- is the whole gitleaks invocation up to its log options (a local binary, or a docker run
# whose source is this repository mounted elsewhere); this script appends "--log-opts=--remerge-diff <base>..<head>".
# Exit 0 only when all three hold, 1 otherwise:
#   1. No octopus merge in the range. --remerge-diff skips a merge of three or more parents (git 2.55 prints
#      "Skipping remerge-diff" on stdout, gitleaks then exits 0 having scanned none of its resolved lines), so one is
#      refused here; a failed rev-list is a refusal too.
#   2. gitleaks exits 0 with --remerge-diff: a two-parent merge shows only what its author wrote over the automatic
#      merge (the conflict resolution), so a secret written while resolving a conflict is a finding.
#   3. Its output has no ERR line. gitleaks 8.30.1 reports a failed git log as ERR, "0 commits scanned" and
#      "no leaks found", and still exits 0: not scanned is not clean.
set -uo pipefail

fail() { printf 'gitleaks-range: %s\n' "$*" >&2; exit 1; }
[ $# -ge 5 ] && [ "$4" = -- ] || fail "usage: gitleaks-range.sh <repository> <base> <head> -- <gitleaks command> git <source> [options...]"
repo=$1 base=$2 head=$3
shift 4
for sha in "$base" "$head"; do
  [[ $sha =~ ^[0-9a-f]{40}$ ]] && [[ ! $sha =~ ^0+$ ]] || fail "not a full commit id: $sha"
  git -C "$repo" cat-file -e "$sha^{commit}" 2>/dev/null || fail "commit $sha is not in $repo"
done

octopus=$(git -C "$repo" rev-list --min-parents=3 -1 "$base..$head" 2>&1) || fail "cannot list the merges of $base..$head: $octopus"
[ -z "$octopus" ] || fail "octopus merge $octopus (three or more parents) in $base..$head: --remerge-diff skips it, so its resolved lines would not be scanned; merge one branch at a time"

output=$("$@" "--log-opts=--remerge-diff $base..$head" 2>&1)
status=$?
plain=$(printf '%s\n' "$output" | sed 's/\x1b\[[0-9;]*m//g')
printf '%s\n' "$plain"
[ "$status" -eq 0 ] || fail "gitleaks exited $status over $base..$head: a finding, or the scan did not finish"
if printf '%s\n' "$plain" | grep -qE '(^|[[:space:]])ERR[[:space:]]'; then
  fail "gitleaks logged an error over $base..$head, so the history was not scanned (exit 0 with ERR is not clean)"
fi
printf 'gitleaks-range: %s..%s scanned, no finding\n' "$base" "$head"
