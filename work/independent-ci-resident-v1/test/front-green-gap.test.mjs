// Task 6be83331 T-B (E2, E5): the front PR's "green, wait for merge" words come from main's own required checks and this head's checks.
// No count and no list of checks lives in the words: a ruleset of 9, 10 or 11 checks gives the same kind of text.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as prStatus from '../src/pr-status.mjs';
const { LocalStore, PrStatusReporter } = prStatus;
const requiredGap = (...a) => prStatus.requiredGap(...a);
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { trainPageLine, trainSummary } from '../src/train.mjs';
import { tempRoot } from './helpers.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const MAIN = 'd'.repeat(40);
const H = n => String(n).repeat(40).slice(0, 40);
const RESIDENT = ['gitleaks', 'trivy', 'kooyumi-work-admission', 'kooyumi-admission-verified', 'kooyumi-merge-slot', 'contract-placement'];
const ACTIONS = ['ci-suites', 'clued-cloud-tests', 'migration-verify', 'ci-suites-windows'];
const PS = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';

const front = (pr, at) => ({ at: new Date(at).toISOString(), mode: 'shadow', onDuty: true, mainSha: MAIN, rules: { strict: true, mergeOnly: true },
  front: { claimId: 'c', pr, headSha: H(pr) }, wouldDo: 'FRONT_GREEN_WAIT_MERGE', wouldRevoke: [], wouldRevokeCount: 0, contract: 'clued.independent-ci.train-facts/1' });
const board = (at, pr) => { const b = new StatusBoard({ clock: () => at }); b.setState('IDLE');
  b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); b.setPending([{ pr, headSha: H(pr), baseSha: MAIN, position: 1 }]);
  b.update({ train: { enabled: 'shadow', last: JSON.parse(JSON.stringify(trainSummary(front(pr, at)))) } });
  return parseStatus(Buffer.from(JSON.stringify(b.snapshot()))); };

// A fake GitHub: main's ruleset, and the head's check runs / statuses.
function fake({ required, runs }) {
  const calls = [];
  const run = async argv => {
    calls.push(argv);
    if (argv.some(a => a.includes('/rules/branches/main'))) return { code: 0, stdout: required.join('\n') + '\n' };
    if (argv.some(a => a.includes('/check-runs?'))) return { code: 0, stdout: runs.map(([n, s, c]) => `${n}\t${s}\t${c ?? ''}`).join('\n') + '\n' };
    if (argv[4] === 'user') return { code: 0, stdout: 'tdoljyj\n' };
    if (argv.some(a => a.includes('/statuses?'))) return { code: 0, stdout: '' };
    return { code: 0, stdout: '{}' };
  };
  return { calls, run };
}
const texts = calls => calls.filter(a => a.includes('POST')).map(a => a.find(x => x.startsWith('description=')).slice('description='.length));
async function reporter(t, run, now) {
  const root = await tempRoot(t);
  return new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\gh.exe', powershellExe: PS, run, clock: () => now.v,
    store: await LocalStore.open(path.join(root, 's.json'), () => now.v), notifications: false, writeRequest: async () => {} });
}
const ok = names => names.map(n => [n, 'completed', 'success']);

test('E2: a front head missing a required Actions check is not called green; the words name it, and turn to "all green" when it arrives', async t => {
  const now = { v: Date.parse('2026-11-19T04:00:00Z') };
  const g = fake({ required: [...RESIDENT, ...ACTIONS], runs: ok([...RESIDENT, 'ci-suites', 'clued-cloud-tests', 'migration-verify']) });
  const r = await reporter(t, g.run, now);
  const pulls = [{ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 }];
  await r.pass({ pulls, status: board(now.v, 7) });
  const first = texts(g.calls).at(-1);
  assert.match(first, /还缺 ci-suites-windows（未出现）/);
  assert.ok(!first.includes('六项') && !first.includes('全部必需检查已绿'), first);
  // the Windows run is in progress: still not green, and it says so
  g.calls.length = 0; now.v += 2 * 60_000;
  const g2 = fake({ required: [...RESIDENT, ...ACTIONS], runs: [...ok([...RESIDENT, 'ci-suites', 'clued-cloud-tests', 'migration-verify']), ['ci-suites-windows', 'in_progress', '']] });
  const r2 = await reporter(t, g2.run, now);
  await r2.pass({ pulls, status: board(now.v, 7) });
  assert.match(texts(g2.calls).at(-1), /还缺 ci-suites-windows（进行中）/);
  // everything there: green words
  const g3 = fake({ required: [...RESIDENT, ...ACTIONS], runs: ok([...RESIDENT, ...ACTIONS]) });
  const r3 = await reporter(t, g3.run, now);
  await r3.pass({ pulls, status: board(now.v, 7) });
  assert.match(texts(g3.calls).at(-1), /全部必需检查已绿，等合并/);
});

test('E5: no count or list in the words: rulesets of 9 and 11 checks, a new required check is covered without a code change', async () => {
  const nine = [...RESIDENT, 'ci-suites', 'clued-cloud-tests', 'migration-verify'];
  const eleven = [...RESIDENT, ...ACTIONS, 'brand-new-workflow'];
  const have = new Map([...RESIDENT, 'ci-suites', 'clued-cloud-tests', 'migration-verify', 'ci-suites-windows'].map(n => [n, 'pass']));
  assert.deepEqual(requiredGap(nine, have), []);
  assert.deepEqual(requiredGap(eleven, have), ['brand-new-workflow（未出现）']);
  have.set('ci-suites', 'fail');
  assert.deepEqual(requiredGap(nine, have), ['ci-suites（未通过）']);
  assert.equal(requiredGap(null, have), null);
  assert.equal(requiredGap(nine, null), null);
  const s = trainSummary(front(7, Date.parse('2026-11-19T04:00:00Z')));
  for (const gap of [null, [], ['x（未出现）'], ['a（未出现）', 'b（进行中）']]) {
    const line = trainPageLine(s, 7, gap);
    assert.ok(!/六|[0-9]+\s*项|[一二三四五六七八九十]项/.test(line), line);
  }
  assert.match(trainPageLine(s, 7, ['a（未出现）', 'b（进行中）']), /还缺 a（未出现）、b（进行中）/);
  assert.match(trainPageLine(s, 7, null), /合并位已绿，等合并/);
  const src = await fs.readFile(new URL('../src/train.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes('六项'), 'train.mjs keeps no hard-coded count of checks');
});
