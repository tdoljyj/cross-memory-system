// bc982192 (replan §3.3, cause 甲): with push landing the poller proposes a head behind main on the merge base of the head and main
// (GitHub's merge_base_commit); github-merge (any other answer of the landing port, none, or a failed read) is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Poller, pushEligible, upToDate } from '../src/poller.mjs';
import { restPolls } from './gh-rest-stub.mjs';

const REPO = 'tdoljyj/cross-memory-system';
const MAIN = 'd'.repeat(40), HEAD = 'a'.repeat(40), MB = 'b'.repeat(40);
const pulls = [{ number: 884, headRefOid: HEAD, baseRefOid: MB, isDraft: false, updatedAt: '2026-11-22T01:00:00Z' }];
let main = MAIN;
const behind = (answer = { behind_by: 2, base: MAIN, merge_base: MB }) => async argv => argv.some(a => a.includes('/compare/'))
  ? { code: 0, stdout: JSON.stringify({ ...answer, base: main }) } : { code: 9, stdout: '' };
function poller(compare, landing) {
  const written = [], calls = [];
  const stub = restPolls(compare, { main: () => main, pulls: () => pulls });
  const p = new Poller({ repo: REPO, ghExe: 'gh', run: async (argv, o) => { calls.push(argv); return stub(argv, o); }, writeTrigger: async v => written.push(v), clock: () => 0,
    ...(landing === undefined ? {} : { landing }) });
  return { p, written, calls };
}

test('push landing: a head two commits behind main is proposed once on its merge base, with no hint', async () => {
  const { p, written, calls } = poller(behind(), async () => 'push');
  assert.equal(await p.pass(), 1);
  assert.deepEqual(written.map(w => [w.pr, w.headSha, w.baseSha]), [[884, HEAD, MB]]);
  assert.deepEqual(p.lastPass.pulls.map(x => [x.eligible, x.hint, x.behindBy, x.mainSha]), [[true, null, 2, MAIN]]);
  const cmp = calls.find(a => a.some(x => x.includes('/compare/')));
  assert.equal(cmp.at(-1), '{behind_by: .behind_by, base: .base_commit.sha, merge_base: .merge_base_commit.sha}');
  // main moves on: the merge base is the same, so the same head is not proposed again
  main = 'e'.repeat(40);
  try { assert.equal(await p.pass(), 0); assert.equal(p.lastPass.mainSha, main); } finally { main = MAIN; }
});

test('push landing, fail closed: no merge base in the answer, or no answer, proposes nothing', async () => {
  for (const answer of [{ behind_by: 2, base: MAIN }, { behind_by: 2, base: MAIN, merge_base: 'x' }, { behind_by: null, base: MAIN, merge_base: MB }]) {
    const { p, written } = poller(behind(answer), async () => 'push');
    assert.equal(await p.pass(), 0, JSON.stringify(answer));
    assert.deepEqual(written, []);
  }
  assert.equal(pushEligible({ behindBy: 0, mergeBase: MAIN }), true);
  assert.equal(pushEligible({ behindBy: -1, mergeBase: MAIN }), false);
});

test('github-merge (the default): a head behind main is told merge-main and proposed nowhere, whatever the landing port says or throws', async () => {
  for (const landing of [undefined, async () => 'github-merge', async () => 'PUSH', async () => { throw new Error('unreadable'); }]) {
    const { p, written } = poller(behind(), landing);
    assert.equal(await p.pass(), 0);
    assert.deepEqual(written, []);
    assert.deepEqual(p.lastPass.pulls.map(x => [x.eligible, x.hint]), [[false, 'merge-main']]);
  }
  // upToDate itself is unchanged
  assert.deepEqual(upToDate({ mainSha: MAIN, baseSha: MAIN, behindBy: 0 }), { eligible: true, hint: null });
  assert.deepEqual(upToDate({ mainSha: MAIN, baseSha: MB, behindBy: 2 }), { eligible: false, hint: 'merge-main' });
  // a head that contains main's tip is proposed on main's tip, as before
  const { p, written } = poller(behind({ behind_by: 0, base: MAIN, merge_base: MAIN }), async () => 'github-merge');
  pulls[0].baseRefOid = MAIN;
  try { assert.equal(await p.pass(), 1); } finally { pulls[0].baseRefOid = MB; }
  assert.deepEqual(written.map(w => w.baseSha), [MAIN]);
});
