// build-bundle.ps1 against stalled transfers (lesson #916, 2026-10-23: a fetch stalled at 47 MB and held the resident
// until the companion's 35-minute deadline). The behaviour is tested on Windows by
// src/resident-v2/windows/test-build-bundle.ps1 (real git against a silent loopback listener); this pins the fixed
// values on any host.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const text = fs.readFileSync(new URL('../src/resident-v2/build-bundle.ps1', import.meta.url), 'utf8');

test('build-bundle: every git call aborts a transfer below 1000 bytes/s for 60 s', () => {
  const common = text.match(/^\$Common=@\(([\s\S]*?)\)\r?$/m)?.[1];
  assert.ok(common, 'the $Common assignment');
  assert.match(common, /'-c','http\.lowSpeedLimit=1000'/);
  assert.match(common, /'-c','http\.lowSpeedTime=60'/);
});

test('build-bundle: one retry of the network steps, in a second fresh store, only in the first 10 minutes', () => {
  assert.ok(text.includes("$NetworkSteps=@('fetch','ls-remote','fetch-reviewed');$RetryWithinSeconds=600"));
  assert.ok(text.includes("$FetchDir2=Join-Path $Root 'fetch-2.git'"));
  assert.ok(text.includes('try{return Build-Store $FetchDir}'));
  assert.ok(text.includes('return Build-Store $FetchDir2'));
  assert.ok(text.includes(" $script:stage='fresh-bare-repository';Absent $Dir\n") || text.includes(" $script:stage='fresh-bare-repository';Absent $Dir\r\n"));
  // The main block builds the store only through Fetch-Store, and still checks the bundle against it.
  assert.equal(text.match(/Build-Store \$/g).length, 2);
  assert.ok(text.includes(' $store=Fetch-Store\n') || text.includes(' $store=Fetch-Store\r\n'));
  assert.ok(text.includes("if(-not (Same-Map $header.formal $remote)){throw 'BUNDLE_REFS_DIFFER_FROM_LS_REMOTE'}"));
});

test('build-bundle: the main block reads no variable that only Build-Store sets (StrictMode would fail a written bundle)', () => {
  const main = text.slice(text.search(/^try\{/m));
  for (const name of ['fetchStartedAt', 'fetchCompletedAt', 'lsRemoteCompletedAt', 'reviewedFetchStartedAt', 'reviewedFetchCompletedAt', 'branchesAtHead', 'local', 'all', 'toml']) {
    assert.doesNotMatch(main, new RegExp(`\\$${name}\\b`), name);
  }
});
