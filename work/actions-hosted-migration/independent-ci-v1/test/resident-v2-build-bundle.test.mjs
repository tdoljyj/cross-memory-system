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
  // at 120 KB/s one 64 MB transfer takes ~533 s. A first attempt that stalls at the very end of it is given up `low` seconds
  // later and must still be inside the window (review of gen7: with 600 it was not, and no retry followed).
  assert.ok(533 + low <= win, 'a stall at the end of the slowest complete transfer still leaves a retry');
  // the second attempt starts before `win`, so it has more than wait - win: one complete slowest-rate transfer plus one stall
  assert.ok(wait - win >= 533 + low, 'a retry can still finish one complete slowest-rate transfer with a stall in it');
});

test('build-bundle: one retry of the network steps, in a second fresh store, only in the first 15 minutes', () => {
  assert.ok(text.includes("$NetworkSteps=@('fetch','ls-remote','fetch-reviewed','fetch-test');$RetryWithinSeconds=900;$MaxStoreAttempts=3"));
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
// one check (right after the full fetch) may start a new attempt, at most two more, in the same first 15 minutes; the other
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
  assert.ok(retry.includes('if($n -ge ($MaxStoreAttempts-1) -or -not ($race -or $network -or $seedFell)){throw}'));
  // the checks the retry must not touch
  for (const code of ['REMOTE_MAIN_BASE_CHANGED', 'HEAD_BASE_SOURCE_COMMIT_MISSING', 'REMOTE_REF_TARGET_TYPE_UNSUPPORTED', 'TRUSTED_REVIEW_SOURCE_CHANGED', 'EXACT_REVIEWED_REF_SET_REQUIRED']) {
    assert.ok(store.includes(`throw '${code}'`), code);
    assert.ok(!retry.includes(code), code);
  }
  // the receipt keeps storeAttempts and firstAttempt and lists every retried attempt in failedAttempts (readers take the keys they need)
  assert.equal(text.split('storeAttempts=$attempts;firstAttempt=$firstAttempt;failedAttempts=@($failedAttempts)').length - 1, 2, 'the receipt and the refusal answer');
  // (the refusal answer also carries the seed report, between failedAttempts and credentialsPrinted: both keys were added by different branches)
  assert.ok(text.includes('storeAttempts=$attempts;firstAttempt=$firstAttempt;failedAttempts=@($failedAttempts);seed=$seedReport;credentialsPrinted=$false'));
  assert.ok(text.includes("$given=[ordered]@{attempt=($n+1);reason=$reason;stage=$script:stage;git=$script:lastGit;failedAfterSeconds=[int]$elapsed}"));
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

// The persistent seed (DESIGN 10.1, tier 2). Behaviour: test-build-bundle.ps1 (damaged, hostile and busy seeds, the update, the
// whole script as a process). This pins what makes it safe on any host: the seed is a cache that can add an attempt and never a
// refusal, it is only ever read through a local fetch into a new bare repository, and it never reaches the receipt or the bundle.
test('build-bundle: the seed lives under bundles (bundles ACL, no install change) and its numbers are fixed', () => {
  assert.ok(text.includes("$SeedRoot=Join-Path $Resident 'bundles\\_seed';$SeedDir=Join-Path $SeedRoot 'seed.git'"));
  assert.ok(text.includes('$SeedMinFullFetchSeconds=90;$SeedMetaMaxAgeSeconds=86400;$SeedLockStaleSeconds=1800;$SeedMaxPacks=12;$SeedMaxBytes=1073741824'));
  assert.ok(text.includes("$SeedConfigKeys=@('core.repositoryformatversion','core.filemode','core.bare','core.symlinks','core.ignorecase','core.logallrefupdates')"));
});

test('build-bundle: a seeded attempt is a fresh bare repository primed by a local fetch, the seed refs are dropped, and every check follows unchanged', () => {
  const store = text.slice(text.indexOf('function Build-Store'), text.indexOf('function Retry-Allowed'));
  // fresh store first, then the seed, then GitHub, then the seed's refs are gone, then the (unchanged) ref/ls-remote checks
  const order = ["init','--bare'", 'Seed-Prime $gd', "Invoke-Git 'fetch'", 'Seed-Drop-Refs $Dir $gd', "Invoke-Git 'ls-remote'", 'Same-Map $local $remote'].map(k => store.indexOf(k));
  assert.ok(order.every(i => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), String(order));
  assert.ok(text.includes("'+refs/heads/*:'+$SeedNs+'heads/*'") && text.includes("$SeedNs='refs/clued-seed/'"));
  // the seed is fetched as a local path with the local protocol allowed for that one call only, never added to $Common
  const common = text.match(/^\$Common=@\(([\s\S]*?)\)\r?$/m)[1];
  assert.doesNotMatch(common, /protocol\.file/);
  assert.ok(text.includes("'-c','protocol.file.allow=always',$Gd,'fetch'"));
  // no alternates, no clone --local, no hard links, no shared objects: objects only arrive through fetch
  for (const bad of ['--shared', '--local', '--reference', 'alternates=', 'objects/info/alternates', 'core.sharedRepository']) assert.ok(!text.includes(bad), bad);
  // the seed is never trusted for its config, location type or contents of hooks
  for (const k of ['SEED_PATH_NOT_REAL_DIRECTORY', 'SEED_UNEXPECTED_ENTRY', 'SEED_HOOKS_PRESENT', 'SEED_CONFIG_REFUSED', 'SEED_LAYOUT_REFUSED']) assert.ok(text.includes(`'${k}'`), k);
});

test('build-bundle: a seed can add an attempt but never a refusal: no seeded last attempt, SEED_UNUSABLE is retried unseeded, a network retry is seeded (gen 10)', () => {
  assert.ok(text.includes('$script:seedAttempt=($script:seedUse -and $n -le ($MaxStoreAttempts-2))'));
  assert.equal(text.match(/Build-Store \$/g).length, 1);
  assert.ok(text.includes("if($Reason -ceq 'SEED_UNUSABLE'){"));
  // Generation 10 (resident DESIGN 53.2): a network failure no longer turns the seed off for the retry; the retry may turn it ON (a seed
  // that passed its shape check), and every network failure of a GitHub step is noted in the meta for the next builds.
  assert.ok(!text.includes("if($Reason -ceq 'GIT_STEP_FAILED'){$script:seedUse=$false;"));
  assert.ok(text.includes("if($network){$networkRetried=$true;Seed-After-Network-Failure}"));
  assert.ok(text.includes("if(Network-Step-Failed $reason $script:lastGit){Seed-Note-Network-Failure}"));
  const after = text.slice(text.indexOf('function Seed-After-Network-Failure'), text.indexOf('# Inside a seeded attempt'));
  assert.ok(after.includes('-not $script:seedAvailable -or $script:seedBusy -or -not (Test-Path -LiteralPath $SeedDir)'), 'only a seed that passed its shape check, not busy, still there');
  assert.ok(text.includes('$SeedAfterNetworkFailureSeconds=21600'));
  // the note is advisory and best effort: never a refusal (its own try/catch, the lock not waited for)
  const note = text.slice(text.indexOf('function Seed-Note-Network-Failure'), text.indexOf('function Seed-After-Network-Failure'));
  assert.ok(note.includes('}catch{}finally{if($locked){Seed-Unlock}}') && note.includes('$locked=Seed-Lock;if(-not $locked){return}') && !/throw/.test(note));
  // SEED_UNUSABLE is thrown only from the seed's own steps
  const thrown = [...text.matchAll(/throw 'SEED_UNUSABLE'/g)].length;
  assert.equal(thrown, 2);
  // not a network step: a seed step is never retried as one
  assert.ok(!/NetworkSteps=@\([^)]*seed/.test(text));
  // the seed update runs after the receipt, is wrapped, and its failure discards the seed instead of failing the bundle
  const main = text.slice(text.search(/^try\{/m));
  assert.ok(main.indexOf('$created+=$ReceiptPath') < main.indexOf('Seed-Update $store'));
  assert.ok(text.includes("}catch{$r.updated=$false;$r.error=Seed-Error-Text $_;Seed-Discard 'SEED_UPDATE_FAILED'}"));
  assert.ok(main.indexOf('Seed-Begin') < main.indexOf('$store=Fetch-Store'));
});

test('build-bundle: the receipt and the bundle are unchanged by the seed; the answer carries a seed object and the companion reads nothing new', () => {
  assert.ok(text.includes('storeAttempts=$attempts;firstAttempt=$firstAttempt'));
  const receipt = text.slice(text.indexOf('$receipt=[ordered]@{'), text.indexOf('$json=($receipt'));
  assert.doesNotMatch(receipt, /[Ss]eed/);
  assert.ok(text.includes("'bundle','create','--quiet','--version=2',$Bundle,'--branches','--tags','--glob=refs/reviewed/*','--glob=refs/clued-test/*'"));
  assert.ok(text.includes('seed=$seedReport}|ConvertTo-Json -Depth 4 -Compress'));
  const companion = fs.readFileSync(new URL('../../../independent-ci-resident-v1/src/companion.mjs', import.meta.url), 'utf8');
  const bundle = companion.slice(companion.indexOf("case 'build-bundle'"), companion.indexOf("case 'rebuild-bundle'"));
  assert.ok(!bundle.includes('seed'));
});

test('build-bundle: removals of seed trees never follow a link and clear read-only object files', () => {
  const rm = text.slice(text.indexOf('function Remove-Tree'), text.indexOf('function Test-RealDir'));
  assert.ok(rm.includes('ReparsePoint') && rm.includes('SetAttributes'));
  assert.ok(!/Remove-Item[^\n]*-Recurse/.test(text.slice(text.indexOf('# ---- The persistent seed'), text.indexOf('function Build-Store'))), 'no Remove-Item -Recurse on a seed tree');
  assert.ok(!text.includes('[IO.Directory]::Delete($SeedDir,$true)'));
});
