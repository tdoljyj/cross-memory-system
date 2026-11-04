// build-bundle.ps1 against stalled transfers (lesson #916, 2026-10-23: a fetch stalled at 47 MB and held the resident
// until the companion's 35-minute deadline). The behaviour is tested on Windows by
// src/resident-v2/windows/test-build-bundle.ps1 (real git against a silent loopback listener); this pins the fixed
// values on any host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const text = fs.readFileSync(new URL('../src/resident-v2/build-bundle.ps1', import.meta.url), 'utf8');

test('build-bundle: every git call aborts a transfer below 1000 bytes/s for 300 s', () => {
  const common = text.match(/^\$Common=@\(([\s\S]*?)\)\r?$/m)?.[1];
  assert.ok(common, 'the $Common assignment');
  assert.match(common, /'-c','http\.lowSpeedLimit=1000'/);
  assert.match(common, /'-c','http\.lowSpeedTime=300'/);
});

// 2026-11-04 (PR #992): behind a ~2.5 Mbit/s egress with stalls, 60 s was too short and the 64 MB fetch was restarted from
// zero twice. A stall that ends the first attempt must still leave a retry: the low-speed window fits twice into the retry
// window, and a retry still has at least the companion's wait minus that window (30 min deadline in companion.mjs).
test('build-bundle: the low-speed window leaves room for the retry inside the companion wait', () => {
  const low = Number(text.match(/'-c','http\.lowSpeedTime=(\d+)'/)[1]);
  const win = Number(text.match(/\$RetryWithinSeconds=(\d+)/)[1]);
  const companion = fs.readFileSync(new URL('../../../independent-ci-resident-v1/src/companion.mjs', import.meta.url), 'utf8');
  const wait = Number(companion.match(/case 'build-bundle':[\s\S]*?timeoutMs: (\d+) \* 60_000/)[1]) * 60;
  assert.equal(low, 300);
  assert.ok(low * 2 <= win, 'a dead first attempt is given up well inside the retry window');
  // the second attempt starts before `win`, so it has more than wait - win; at 120 KB/s one 64 MB transfer takes ~533 s
  assert.ok(wait - win >= 2 * 533, 'a retry can still finish one complete slowest-rate transfer with a stall in it');
});

test('build-bundle: one retry of the network steps, in a second fresh store, only in the first 10 minutes', () => {
  assert.ok(text.includes("$NetworkSteps=@('fetch','ls-remote','fetch-reviewed','fetch-test');$RetryWithinSeconds=600;$MaxStoreAttempts=3"));
  assert.ok(text.includes("$FetchDir2=Join-Path $Root 'fetch-2.git'"));
  assert.ok(text.includes('try{return Build-Store $dirs[$n]}'));
  assert.ok(text.includes("$dirs=@($FetchDir,$FetchDir2,$FetchDir3);$networkRetried=$false"));
  assert.ok(text.includes(" $script:stage='fresh-bare-repository';$script:refsDiffer=$null;Absent $Dir\n") || text.includes(" $script:stage='fresh-bare-repository';$script:refsDiffer=$null;Absent $Dir\r\n"));
  // The main block builds the store only through Fetch-Store, and still checks the bundle against it.
  assert.equal(text.match(/Build-Store \$/g).length, 1);
  assert.ok(text.includes(' $store=Fetch-Store\n') || text.includes(' $store=Fetch-Store\r\n'));
  assert.ok(text.includes("if(-not (Same-Map $header.formal $remote)){throw 'BUNDLE_REFS_DIFFER_FROM_LS_REMOTE'}"));
});

test('build-bundle: the main block reads no variable that only Build-Store sets (StrictMode would fail a written bundle)', () => {
  const main = text.slice(text.search(/^try\{/m));
  for (const name of ['fetchStartedAt', 'fetchCompletedAt', 'lsRemoteCompletedAt', 'reviewedFetchStartedAt', 'reviewedFetchCompletedAt', 'branchesAtHead', 'local', 'all', 'toml', 'final']) {
    assert.doesNotMatch(main, new RegExp(`\\$${name}\\b`), name);
  }
});

// 2026-11-04 (PR #990): a push between the fetch and the ls-remote made the fetched refs differ from ls-remote. Only that
// one check (right after the full fetch) may start a new attempt, at most two more, in the same first 10 minutes; the other
// FETCHED_REFS_DIFFER_FROM_LS_REMOTE checks and every other refusal stay final. Behaviour: test-build-bundle.ps1.
test('build-bundle: only the first refs-vs-ls-remote check can start a new attempt, at most 3 attempts in all', () => {
  const store = text.slice(text.indexOf('function Build-Store'), text.indexOf('function Retry-Allowed'));
  const racy = "if(-not (Same-Map $local $remote)){$script:refsDiffer=Ref-Diff $local $remote;throw 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE'}";
  assert.equal(text.split('$script:refsDiffer=Ref-Diff').length - 1, 1);
  assert.ok(store.includes(racy));
  assert.ok(store.includes("$script:refsDiffer=$null;Absent $Dir"));
  // the two later checks throw the same code without recording a difference
  assert.equal(store.split("throw 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE'").length - 1, 3);
  const retry = text.slice(text.indexOf('function Race-Retry-Allowed'), text.indexOf('try{\n $id='));
  assert.ok(retry.includes("$Reason -ceq 'FETCHED_REFS_DIFFER_FROM_LS_REMOTE' -and $null -ne $Differ -and $ElapsedSeconds -lt $RetryWithinSeconds"));
  assert.ok(retry.includes('$network=(-not $networkRetried) -and (Retry-Allowed $reason $script:lastGit $elapsed)'));
  assert.ok(retry.includes('if($n -ge ($MaxStoreAttempts-1) -or -not ($race -or $network)){throw}'));
  // the checks the retry must not touch
  for (const code of ['REMOTE_MAIN_BASE_CHANGED', 'HEAD_BASE_SOURCE_COMMIT_MISSING', 'REMOTE_REF_TARGET_TYPE_UNSUPPORTED', 'TRUSTED_REVIEW_SOURCE_CHANGED', 'EXACT_REVIEWED_REF_SET_REQUIRED']) {
    assert.ok(store.includes(`throw '${code}'`), code);
    assert.ok(!retry.includes(code), code);
  }
  // no new contract field: the receipt keeps storeAttempts and firstAttempt
  assert.ok(text.includes('storeAttempts=$attempts;firstAttempt=$firstAttempt'));
  assert.ok(text.includes("'fetch-3.git'"));
});

// Step 3c-2 (design v0.5 §5.2): a train front batch's S is fetched by SHA inside Build-Store (so the retry covers it),
// checked for parents [T, H], bundled under refs/clued-test/<S> and counted in the receipt that ws-prep binds.
test('build-bundle: S != H is fetched, checked and bundled; the S = H guard is gone', () => {
  assert.ok(!text.includes('TEST_COMMIT_NOT_HEAD'));
  const store = text.slice(text.indexOf('function Build-Store'), text.indexOf('function Retry-Allowed'));
  assert.ok(store.includes("$null=Invoke-Git 'fetch-test'"));
  assert.ok(store.includes("throw 'TEST_COMMIT_PARENTS_REQUIRED'"));
  assert.ok(text.includes("'--glob=refs/reviewed/*','--glob=refs/clued-test/*'"));
  for (const field of ['testSha=$Test', 'testRefCount=$header.test.Count', 'testRefListSha256=(Ref-List-Sha $header.test)']) assert.ok(text.includes(field), field);
});
