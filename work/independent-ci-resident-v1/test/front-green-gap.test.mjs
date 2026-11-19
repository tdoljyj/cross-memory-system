// Task 6be83331 T-B (E2, E5 and the review rework): the front PR's "green, wait for merge" words come from main's own required checks
// (with their App pins) and this head's own observations. No count of checks and no list of them lives in the words.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as prStatus from '../src/pr-status.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { trainPageLine, trainSummary } from '../src/train.mjs';
import { tempRoot } from './helpers.mjs';

const { LocalStore, PrStatusReporter } = prStatus;
const REPO = 'tdoljyj/cross-memory-system';
const MAIN = 'd'.repeat(40);
const H = n => String(n).repeat(40).slice(0, 40);
const RESIDENT = ['gitleaks', 'trivy', 'kooyumi-work-admission', 'kooyumi-admission-verified', 'kooyumi-merge-slot', 'contract-placement'];
const ACTIONS = ['ci-suites', 'clued-cloud-tests', 'migration-verify', 'ci-suites-windows'];
const APP = 5368905, GHA = 15368;
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const RULES = [...RESIDENT.map(context => ({ context, integrationId: APP })), ...ACTIONS.map(context => ({ context, integrationId: GHA }))];
const ok = (names, appId) => names.map(name => ({ name, appId, status: 'completed', conclusion: 'success' }));
const GREEN = [...ok(RESIDENT, APP), ...ok(ACTIONS, GHA)];

const front = (pr, at) => ({ at: new Date(at).toISOString(), mode: 'shadow', onDuty: true, mainSha: MAIN, rules: { strict: true, mergeOnly: true },
  front: { claimId: 'c', pr, headSha: H(pr) }, wouldDo: 'FRONT_GREEN_WAIT_MERGE', wouldRevoke: [], wouldRevokeCount: 0, contract: 'clued.independent-ci.train-facts/1' });
const board = (at, pr) => { const b = new StatusBoard({ clock: () => at }); b.setState('IDLE');
  b.update({ backfill: { complete: true, published: 0, unreadable: 0 } }); b.setPending([{ pr, headSha: H(pr), baseSha: MAIN, position: 1 }]);
  b.update({ train: { enabled: 'shadow', last: JSON.parse(JSON.stringify(trainSummary(front(pr, at)))) } });
  return parseStatus(Buffer.from(JSON.stringify(b.snapshot()))); };

// A fake GitHub for one head. It answers both reading styles (the plain --jq text of the first version and the REST JSON of the shared reader),
// so the same case runs against either implementation.
function fake({ rules = RULES, runs = GREEN, statuses = [], head = H(7) } = {}) {
  const calls = [];
  const run = async argv => {
    calls.push(argv);
    const jq = argv.includes('--jq'), route = argv.find(a => a.startsWith('repos/')) ?? '', json = v => ({ code: 0, stdout: JSON.stringify(v) });
    if (route.includes('/rules/branches/main')) return jq ? { code: 0, stdout: [...new Set(rules.map(r => r.context))].join('\n') + '\n' }
      : json([{ type: 'required_status_checks', parameters: { required_status_checks: rules.map(r => ({ context: r.context, ...(r.integrationId ? { integration_id: r.integrationId } : {}) })) } }]);
    if (route.includes('/check-runs?')) return jq ? { code: 0, stdout: runs.map(r => `${r.name}\t${r.status}\t${r.conclusion ?? ''}`).join('\n') + '\n' }
      : json({ total_count: runs.length, check_runs: runs.map(r => ({ name: r.name, head_sha: head, app: { id: r.appId }, status: r.status, conclusion: r.conclusion ?? null })) });
    if (route.includes('/statuses?') && !jq) return json(statuses.map(s => ({ context: s.context, state: s.state })));
    if (route.includes('/statuses?') && argv.includes('--paginate')) return { code: 0, stdout: statuses.map(s => `${s.context}\t${s.state}`).join('\n') + '\n' };
    if (route.includes('/statuses?')) return { code: 0, stdout: '[]' };
    if (argv[4] === 'user') return { code: 0, stdout: 'tdoljyj\n' };
    return { code: 0, stdout: '{}' };
  };
  return { calls, run };
}
const texts = calls => calls.filter(a => a.includes('POST')).map(a => a.find(x => x.startsWith('description=')).slice('description='.length));
async function reporter(t, run, now, extra = {}) {
  const root = await tempRoot(t);
  return new PrStatusReporter({ node: 'node-b', repo: REPO, ghExe: 'C:\\gh.exe', powershellExe: PS, run, clock: () => now.v,
    store: await LocalStore.open(path.join(root, 's.json'), () => now.v), notifications: false, writeRequest: async () => {}, ...extra });
}
const pulls = [{ pr: 7, headSha: H(7), eligible: true, hint: null, behindBy: 0 }];
const lastText = async (t, spec, extra) => {
  const now = { v: Date.parse('2026-11-19T04:00:00Z') };
  const g = fake(spec);
  const r = await reporter(t, g.run, now, extra);
  await r.pass({ pulls, status: board(now.v, 7) });
  return texts(g.calls).at(-1);
};

test('E2: a front head missing a required Actions check is not called green; the words name it, and turn to "all green" when it arrives', async t => {
  const without = GREEN.filter(r => r.name !== 'ci-suites-windows');
  const first = await lastText(t, { runs: without });
  assert.match(first, /缺 1 项：ci-suites-windows（未出现）/);
  assert.ok(!first.includes('六项') && !first.includes('全部必需检查已绿'), first);
  assert.match(await lastText(t, { runs: [...without, { name: 'ci-suites-windows', appId: GHA, status: 'in_progress', conclusion: null }] }), /缺 1 项：ci-suites-windows（进行中）/);
  assert.match(await lastText(t, { runs: GREEN }), /全部必需检查已绿，等合并/);
});

test('review high 1: the right App must have posted the check; a same-name success from another App, or a commit status, is missing', async t => {
  const wrongApp = [...GREEN.filter(r => r.name !== 'ci-suites-windows'), { name: 'ci-suites-windows', appId: 9999, status: 'completed', conclusion: 'success' }];
  assert.match(await lastText(t, { runs: wrongApp }), /缺 1 项：ci-suites-windows（未出现）/, 'wrong App');
  const onlyStatus = GREEN.filter(r => r.name !== 'ci-suites-windows');
  assert.match(await lastText(t, { runs: onlyStatus, statuses: [{ context: 'ci-suites-windows', state: 'success' }] }), /缺 1 项：ci-suites-windows（未出现）/, 'a status is not the pinned check');
  // a status never hides a failed or running check-run of the same name
  const failedRun = [...onlyStatus, { name: 'ci-suites-windows', appId: GHA, status: 'completed', conclusion: 'failure' }];
  assert.match(await lastText(t, { runs: failedRun, statuses: [{ context: 'ci-suites-windows', state: 'success' }] }), /缺 1 项：ci-suites-windows（未通过）/, 'same name, run and status');
  // an unpinned rule is met by any App's check or by a status
  const unpinned = RULES.map(r => r.context === 'ci-suites-windows' ? { context: r.context, integrationId: null } : r);
  assert.match(await lastText(t, { rules: unpinned, runs: onlyStatus, statuses: [{ context: 'ci-suites-windows', state: 'success' }] }), /全部必需检查已绿/, 'unpinned: status counts');
});

test('review high 2: a required check that completed as skipped is missing, never green', async t => {
  const skipped = [...GREEN.filter(r => r.name !== 'ci-suites-windows'), { name: 'ci-suites-windows', appId: GHA, status: 'completed', conclusion: 'skipped' }];
  const text = await lastText(t, { runs: skipped });
  assert.match(text, /缺 1 项：ci-suites-windows（已跳过）/);
  assert.ok(!text.includes('全部必需检查已绿'), text);
});

test('review medium 4: the missing names come first and survive a long text and the watchdog tail; a long list says how many', async t => {
  const long = 'x'.repeat(120);
  const now = { v: Date.parse('2026-11-19T04:00:00Z') };
  const many = [...RESIDENT, ...ACTIONS].map(n => `${n}-with-a-long-check-name-suffix`);
  const rules = [{ context: 'ci-suites-windows-with-a-long-check-name', integrationId: GHA }, ...many.map(context => ({ context, integrationId: GHA }))];
  const g = fake({ rules, runs: [] });
  const r = await reporter(t, g.run, now, { rerunLine: () => long, watchdogStale: () => true });
  await r.pass({ pulls, status: board(now.v, 7) });
  const text = texts(g.calls).at(-1);
  assert.ok(text.length <= 140, text);
  assert.match(text, new RegExp(`缺 ${rules.length} 项：ci-suites-windows-with-a-long-check-name（未出现）`), text);
  assert.ok(text.endsWith('自动接班看门狗未运行'), text);
  // a single missing check with the long text in front
  const one = await lastText(t, { runs: GREEN.filter(x => x.name !== 'ci-suites-windows') }, { rerunLine: () => long });
  assert.match(one, /缺 1 项：ci-suites-windows（未出现）/);
});

test('E5: no count or list in the words: rulesets of 9 and 11 checks, a new required check is covered without a code change', async t => {
  const nine = RULES.filter(r => r.context !== 'ci-suites-windows');
  const eleven = [...RULES, { context: 'brand-new-workflow', integrationId: GHA }];
  const seen = GREEN.map(r => ({ name: r.name, appId: r.appId, source: 'run', state: 'pass' }));
  assert.deepEqual(prStatus.requiredGap(nine, seen), []);
  assert.deepEqual(prStatus.requiredGap(eleven, seen), ['brand-new-workflow（未出现）']);
  assert.match(await lastText(t, { rules: eleven }), /缺 1 项：brand-new-workflow（未出现）/);
  assert.match(await lastText(t, { rules: nine }), /全部必需检查已绿/);
  assert.equal(prStatus.requiredGap(null, seen), null);
  assert.equal(prStatus.requiredGap(nine, null), null);
  const s = trainSummary(front(7, Date.parse('2026-11-19T04:00:00Z')));
  for (const gap of [null, []]) assert.ok(!/六|[0-9]+\s*项|[一二三四五六七八九十]项/.test(trainPageLine(s, 7, gap)));
  assert.match(trainPageLine(s, 7, null), /合并位已绿，等合并/);
  const src = await fs.readFile(new URL('../src/train.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes('六项'), 'train.mjs keeps no hard-coded count of checks');
});

test('integration_id -1 (any source, allowed by Source v2) is an unpinned rule, not an unreadable ruleset', async t => {
  const anySource = RULES.map(r => r.context === 'ci-suites-windows' ? { context: r.context, integrationId: -1 } : r);
  const other = [...GREEN.filter(r => r.name !== 'ci-suites-windows'), { name: 'ci-suites-windows', appId: 9999, status: 'completed', conclusion: 'success' }];
  assert.match(await lastText(t, { rules: anySource, runs: other }), /全部必需检查已绿，等合并/);
  assert.match(await lastText(t, { rules: anySource, runs: GREEN.filter(r => r.name !== 'ci-suites-windows') }), /缺 1 项：ci-suites-windows（未出现）/);
});

const REPORT_AFTER = prStatus.RULES_UNREADABLE_REPORT_AFTER_MS ?? 10 * 60_000;
const failingRules = (g, state) => async (argv, o) => (argv.find(a => a.startsWith('repos/')) ?? '').includes('/rules/branches/main') && state.failing ? { code: 1, stdout: '', stderr: 'dial tcp: i/o timeout' } : g.run(argv, o);

test('an unreadable ruleset: a flap is not reported; one that lasts writes one clear status', async t => {
  const now = { v: Date.parse('2026-11-19T04:00:00Z') };
  const g = fake({ runs: GREEN });
  const state = { failing: true };
  const r = await reporter(t, failingRules(g, state), now);
  assert.equal((await r.pass({ pulls, status: board(now.v, 7) })).posted, 0, 'first failure: nothing said');
  now.v += 5 * 60_000;
  assert.equal((await r.pass({ pulls, status: board(now.v, 7) })).posted, 0, 'five minutes: still a flap');
  now.v += REPORT_AFTER;
  assert.equal((await r.pass({ pulls, status: board(now.v, 7) })).posted, 1, 'lasting: said');
  assert.match(texts(g.calls).at(-1), /无法读取 main 规则集/);
  assert.ok(!texts(g.calls).at(-1).includes('已绿'));
  now.v += 60_000;
  assert.equal((await r.pass({ pulls, status: board(now.v, 7) })).posted, 0, 'once');
});

test('a flap after a good read keeps the last known rules; a recovery restarts the clock', async t => {
  const now = { v: Date.parse('2026-11-19T04:00:00Z') };
  const g = fake({ runs: GREEN.filter(r => r.name !== 'ci-suites-windows') });
  const state = { failing: false };
  const r = await reporter(t, failingRules(g, state), now);
  await r.pass({ pulls, status: board(now.v, 7) });
  assert.match(texts(g.calls).at(-1), /缺 1 项：ci-suites-windows/);
  state.failing = true;
  now.v += 31 * 60_000; // the cache of the rules is old, the read fails
  await r.pass({ pulls, status: board(now.v, 7) });
  assert.match(texts(g.calls).at(-1), /缺 1 项：ci-suites-windows/, 'the last known rules still speak during a flap');
  assert.ok(!texts(g.calls).some(x => /无法读取/.test(x)));
  state.failing = false;
  now.v += 60_000;
  await r.pass({ pulls, status: board(now.v, 7) });
  state.failing = true;
  now.v += 31 * 60_000;
  await r.pass({ pulls, status: board(now.v, 7) });
  now.v += 6 * 60_000;
  await r.pass({ pulls, status: board(now.v, 7) });
  assert.ok(!texts(g.calls).some(x => /无法读取/.test(x)), 'two spells of 6 minutes are not one of 12');
});
