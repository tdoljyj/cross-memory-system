// Fable 11-21 T4: the push-landing precheck (rollout/landing-precheck.mjs) against a fixture GitHub, node and checkout. Read-only: the
// gh port only ever runs `gh api <route>` (a GET), and the one file written is the --before snapshot.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { ghPort, landingPrecheck, MAIN_RULESET_ID, SNAPSHOT_CONTRACT } from '../landing-precheck.mjs';

const REPO = 'o/r', APP = 5368905, GHA = 15368, FF = 27500001;
const sha = n => n.toString(16).padStart(40, '0');
const hash = b => createHash('sha256').update(b).digest('hex');
const NOW = Date.parse('2026-11-21T08:00:00Z'), iso = ms => new Date(ms).toISOString();
const RESIDENT = ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot'];
const FOUR = ['ci-suites', 'clued-cloud-tests', 'migration-verify', 'ci-suites-windows'];
const CLOSURE = 'work/actions-hosted-migration/independent-ci-v1/src/resident-v2/source-closure.json';
const RECEIPTS = 'R:\\receipts';

function world() {
  const required = [...RESIDENT.map(context => ({ context, integration_id: APP })), ...FOUR.map(context => ({ context, integration_id: GHA }))];
  const main = { id: MAIN_RULESET_ID, name: 'main write policy', target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, bypass_actors: [], current_user_can_bypass: 'never',
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'pull_request', parameters: { allowed_merge_methods: ['merge'] } },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: true, required_status_checks: required } }] };
  const ff = { id: FF, name: 'main fast-forward only', target: 'branch', enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, bypass_actors: [], rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }] };
  const w = { rulesets: new Map([[MAIN_RULESET_ID, main], [FF, ff]]), runs: [], checks: new Map(), annotations: new Map(), mainSha: sha(0xabc),
    files: new Map(), checkoutFiles: new Map(), head: sha(0xabc), snapshot: null, calls: [], nextId: 1 };
  // three S on staging, newest first: S1 and S2 all four green (S2 pending at stage 8's moment, green after), S3 Windows refused by the hook
  const S = [sha(0x51), sha(0x52), sha(0x53)];
  S.forEach((s, i) => w.runs.push({ id: 900 - i, head_sha: s, created_at: iso(NOW - (i + 1) * 3_600_000) }));
  const add = (s, name, o = {}) => { const id = w.nextId++; (w.checks.get(s) ?? w.checks.set(s, []).get(s)).push({ id, name, app: { id: GHA }, status: 'completed', conclusion: 'success', ...o }); return id; };
  for (const n of FOUR) add(S[0], n);
  for (const n of FOUR) add(S[1], n, { status: 'in_progress', conclusion: null });
  for (const n of FOUR) add(S[1], n);
  for (const n of FOUR.filter(n => n !== 'ci-suites-windows')) add(S[2], n);
  const refused = add(S[2], 'ci-suites-windows', { conclusion: 'failure', output: { title: 'Job refused', summary: 'staging admission: member PR moved or closed' } });
  w.annotations.set(refused, [{ message: 'clued-runner-job-started: staging admission refused: main moved' }]);
  add(S[2], 'ci-suites-windows-skipped', { name: 'ci-suites-windows-skipped' });
  w.S = S;
  // this node and the checkout: one Source
  const pins = [['x/a.mjs', 'A'], ['x/b.mjs', 'B']];
  for (const [p, body] of pins) w.checkoutFiles.set(p, Buffer.from(body));
  w.checkoutFiles.set(CLOSURE, Buffer.from(JSON.stringify({ contract: 'clued.independent-ci.source-closure/2', paths: pins.map(p => p[0]) })));
  const sourceFiles = pins.map(([p, b]) => ({ path: p, sha256: hash(Buffer.from(b)) }));
  w.record = Buffer.from(JSON.stringify({ schema: 'x', sourceSha: w.head, roles: { scanner: { sourceFiles }, control: { sourceFiles } } }));
  w.source = hash(w.record);
  w.status = { node: { name: 'TURING', mode: 'ACTIVE' }, versions: { windows: { ciSourceManifestSha256: w.source } },
    train: { nodes: { at: iso(NOW - 60_000), sourceManifestSha256: w.source, dropped: 0, nodes: [
      { node: 'TURING', sourceManifestSha256: w.source, state: 'online', lastHeartbeatAt: iso(NOW - 60_000) },
      { node: 'DESK', sourceManifestSha256: w.source, state: 'online', lastHeartbeatAt: iso(NOW - 120_000) }] },
    last: { at: iso(NOW - 60_000), mode: 'on', wouldDo: 'NO_FRONT', decision: 'NO_FRONT', onDuty: true, landing: { route: 'github-merge' } } } };
  w.receipts = new Map([
    ['outcome-1.json', { at: iso(NOW - 7_200_000), rehearsal: { testSha: S[2], missing: ['independent_ruleset'], bypass: { main: 'never', independent: 'absent' } } }],
    ['outcome-2.json', { at: iso(NOW - 3_600_000), rehearsal: { testSha: S[0], missing: ['train_landed_required'], bypass: { main: 'never', independent: 'never' } } }],
    ['outcome-3.json', { at: iso(NOW - 60_000), status: 'BLOCKED' }]]);
  return w;
}
// The fixture gh: the routes the precheck reads, by path; there is no write route at all.
function ports(w) {
  const route = r => r.replace(/[?&]per_page=100&page=\d+$/, '');
  const answer = r => {
    w.calls.push(r);
    let m;
    if (r === `repos/${REPO}/rules/branches/main`) return [...w.rulesets.values()].flatMap(rs => rs.enforcement === 'active' && rs.conditions.ref_name.include.includes('~DEFAULT_BRANCH')
      ? rs.rules.map(x => ({ ...x, ruleset_id: rs.id })) : []);
    if (r === `repos/${REPO}/rulesets?includes_parents=true`) return [...w.rulesets.values()].map(({ id, name, target, enforcement }) => ({ id, name, target, enforcement }));
    if ((m = /^repos\/o\/r\/rulesets\/(\d+)$/.exec(r))) return structuredClone(w.rulesets.get(Number(m[1])));
    if (r.startsWith(`repos/${REPO}/actions/runs?branch=clued-train%2Fstaging&event=push`)) return { workflow_runs: w.runs };
    if ((m = /^repos\/o\/r\/commits\/([0-9a-f]{40})\/check-runs\?filter=all$/.exec(r))) return { check_runs: w.checks.get(m[1]) ?? [] };
    if ((m = /^repos\/o\/r\/check-runs\/(\d+)\/annotations$/.exec(r))) return w.annotations.get(Number(m[1])) ?? [];
    if (r === `repos/${REPO}/branches/main`) return { commit: { sha: w.mainSha } };
    throw new Error(`unexpected route ${r}`);
  };
  const gh = { get: async r => answer(route(r)), paged: async (r, key) => { const b = answer(route(r)); return key ? b[key] : b; } };
  const files = { receipts: RECEIPTS, status: 'N:\\state\\status.json', sourceManifest: 'N:\\record\\source-manifest.json',
    read: async f => f === 'N:\\state\\status.json' ? Buffer.from(JSON.stringify(w.status)) : f === 'N:\\record\\source-manifest.json' ? w.record
      : w.receipts.has(path.basename(f)) ? Buffer.from(JSON.stringify(w.receipts.get(path.basename(f)))) : (() => { throw new Error(`ENOENT ${f}`); })(),
    list: async () => [...w.receipts.keys()],
    readSnapshot: async () => { if (!w.snapshot) throw new Error('ENOENT'); return structuredClone(w.snapshot); },
    writeSnapshot: async v => { w.snapshot = structuredClone(v); } };
  const checkout = { head: async () => w.head, read: async p => { if (!w.checkoutFiles.has(p)) throw new Error(`ENOENT ${p}`); return w.checkoutFiles.get(p); } };
  return { gh, files, checkout };
}
const run = (w, mode, o = {}) => landingPrecheck({ mode, repo: REPO, clock: () => o.now ?? NOW, only: o.only ?? null, ...ports(w) });
const failedOf = (r, i) => r.items[i].failed ?? [];
// The Owner's one save (C): the App on main's bypass list (always), kooyumi-train-landed pinned to it.
const saveC = w => { const m = w.rulesets.get(MAIN_RULESET_ID); m.bypass_actors = [{ actor_id: APP, actor_type: 'Integration', bypass_mode: 'always' }];
  m.rules.find(r => r.type === 'required_status_checks').parameters.required_status_checks.push({ context: 'kooyumi-train-landed', integration_id: APP }); };

test('T4 --before: GO on today\'s fixture; P1 counts the Actions checks of the live rules on the newest S of staging; the snapshot is written', async () => {
  const w = world();
  const r = await run(w, 'before');
  assert.equal(r.verdict, 'GO', JSON.stringify(r));
  assert.deepEqual(Object.keys(r.items), ['P1', 'P2', 'P3', 'P4', 'P5']);
  assert.deepEqual(r.items.P1.names, [...FOUR].sort());
  assert.deepEqual(r.items.P1.fullyGreen, [w.S[0], w.S[1]], 'S2: pending at the moment stage 8 published, green after: counted');
  assert.equal(r.items.P1.successes['ci-suites-windows'], 2);
  assert.equal(r.items.P3.newest.file, 'outcome-2.json');
  assert.equal(r.items.P4.id, FF);
  assert.deepEqual([w.snapshot.contract, w.snapshot.readAt, w.snapshot.required.length], [SNAPSHOT_CONTRACT, iso(NOW), 10]);
  // read-only: only reads, and no rehearsal is asked about S's checks
  assert.ok(w.calls.every(c => !/\/(merges|git\/refs|pulls\/\d+\/merge)/.test(c)), JSON.stringify(w.calls));
});

test('T4 P1: a required check never seen on any S -> NO-GO naming it, every S listed; all on 2 S but never all on one -> NO-GO with the hook\'s refusal', async () => {
  let w = world();
  for (const [s, list] of w.checks) w.checks.set(s, list.filter(c => c.name !== 'migration-verify'));
  let r = await run(w, 'before');
  assert.equal(r.verdict, 'NO-GO');
  assert.deepEqual(r.items.P1.fewerThanTwo, ['migration-verify']);
  assert.equal(r.items.P1.perS.length, 3);
  assert.deepEqual(r.items.P1.perS.map(s => s.checks['migration-verify'].state), ['absent', 'absent', 'absent']);
  assert.equal(w.snapshot, null, 'no snapshot from a NO-GO');
  // b: every check green on 2 S, no S with all four
  w = world();
  w.checks.set(w.S[0], w.checks.get(w.S[0]).map(c => c.name === 'ci-suites' ? { ...c, conclusion: 'failure' } : c));
  w.checks.set(w.S[1], w.checks.get(w.S[1]).map(c => c.name === 'ci-suites-windows' ? { ...c, conclusion: 'cancelled' } : c));
  w.checks.get(w.S[2]).push({ id: 99, name: 'ci-suites-windows', app: { id: GHA }, status: 'completed', conclusion: 'success' });
  w.checks.set(w.S[2], w.checks.get(w.S[2]).map(c => c.name === 'clued-cloud-tests' ? { ...c, conclusion: 'failure' } : c));
  r = await run(w, 'before');
  assert.equal(r.verdict, 'NO-GO', JSON.stringify(r.items.P1));
  assert.deepEqual(r.items.P1.fullyGreen, []);
  assert.equal(r.items.P1.fewerThanTwo, undefined, 'a holds');
  // the detail: the hook refusal of the S3 Windows job is not shown (S3 got a later success); a failure's annotations are
  const s1 = r.items.P1.perS.find(s => s.testSha === w.S[0]).checks['ci-suites'];
  assert.equal(s1.state, 'failure');
  assert.ok(Array.isArray(s1.annotations));
  // a check named *-skipped never counts, and another App's check of the same name never does
  w = world();
  for (const s of w.S) w.checks.set(s, w.checks.get(s).map(c => c.name === 'ci-suites' ? { ...c, app: { id: APP } } : c));
  r = await run(w, 'before', { only: ['P1'] });
  assert.deepEqual(r.items.P1.fewerThanTwo, ['ci-suites']);
  w = world();
  const s3 = w.checks.get(w.S[2]).find(c => c.name === 'ci-suites-windows');
  assert.deepEqual(w.annotations.get(s3.id), [{ message: 'clued-runner-job-started: staging admission refused: main moved' }]);
  w.checks.set(w.S[1], w.checks.get(w.S[1]).filter(c => c.name !== 'ci-suites-windows'));
  r = await run(w, 'before', { only: ['P1'] });
  assert.deepEqual(r.items.P1.fewerThanTwo, ['ci-suites-windows']);
  const refusal = r.items.P1.perS.find(s => s.testSha === w.S[2]).checks['ci-suites-windows'];
  assert.deepEqual([refusal.state, refusal.summary, refusal.annotations], ['failure', 'staging admission: member PR moved or closed',
    ['clued-runner-job-started: staging admission refused: main moved']]);
});

test('T4 P4: no independent ruleset, a second one, a bypass actor on it, other rules on it, not active, or a list the identity cannot read -> NO-GO', async () => {
  const cases = [
    ['no independent ruleset', w => w.rulesets.delete(FF), 'NO_INDEPENDENT_RULESET'],
    ['two', w => w.rulesets.set(FF + 1, { ...structuredClone(w.rulesets.get(FF)), id: FF + 1 }), 'MORE_THAN_ONE_INDEPENDENT_RULESET'],
    ['a bypass actor', w => { w.rulesets.get(FF).bypass_actors = [{ actor_id: 1, actor_type: 'RepositoryRole', bypass_mode: 'always' }]; }, 'BYPASS_ACTORS_NOT_EMPTY'],
    ['bypass list not shown (not an administrator)', w => { delete w.rulesets.get(FF).bypass_actors; }, 'BYPASS_ACTORS_UNREADABLE'],
    ['another rule', w => { w.rulesets.get(FF).rules.push({ type: 'creation' }); }, 'RULES_NOT_EXACTLY_DELETION_AND_NON_FAST_FORWARD'],
    ['evaluate only', w => { w.rulesets.get(FF).enforcement = 'evaluate'; }, 'NOT_ACTIVE'],
  ];
  for (const [label, change, code] of cases) {
    const w = world(); change(w);
    const r = await run(w, 'before', { only: ['P4'] });
    assert.equal(r.verdict, 'NO-GO', label);
    assert.ok(failedOf(r, 'P4').includes(code), `${label}: ${JSON.stringify(r.items.P4)}`);
    assert.equal(w.snapshot, null);
  }
  const w = world();
  assert.equal((await run(w, 'before', { only: ['P4'] })).verdict, 'GO');
  assert.equal(w.snapshot, null, 'a subset (R1) writes no snapshot');
});

test('T4 P2: a node heard within 24 hours on another Source, a record of another checkout, a checkout that is not main -> NO-GO', async () => {
  const cases = [
    ['another node on another Source', w => { w.status.train.nodes.nodes[1].sourceManifestSha256 = 'e'.repeat(64); }, 'FLEET_MISMATCH'],
    ['this checkout changed a Source file', w => { w.checkoutFiles.set('x/b.mjs', Buffer.from('B2')); }, 'SOURCE_RECORD_NOT_THIS_CHECKOUT'],
    ['this checkout is not origin main', w => { w.mainSha = sha(0xdef); }, 'CHECKOUT_NOT_MAIN'],
    ['the status names another installed Source', w => { w.status.versions.windows.ciSourceManifestSha256 = 'f'.repeat(64); }, 'SOURCE_RECORD_NOT_THIS_NODE'],
    ['this node not on duty', w => { w.status.node.mode = 'STANDBY'; }, 'FLEET_UNVERIFIED_NOT_ON_DUTY'],
  ];
  for (const [label, change, code] of cases) {
    const w = world(); change(w);
    const r = await run(w, 'before', { only: ['P2'] });
    assert.equal(r.verdict, 'NO-GO', label);
    assert.ok(failedOf(r, 'P2').includes(code), `${label}: ${JSON.stringify(r.items.P2)}`);
  }
  // a node last heard more than 24 hours ago is not compared (as stage 10)
  const w = world();
  Object.assign(w.status.train.nodes.nodes[1], { sourceManifestSha256: 'e'.repeat(64), lastHeartbeatAt: iso(NOW - 25 * 3_600_000) });
  assert.equal((await run(w, 'before', { only: ['P2'] })).verdict, 'GO');
});

test('T4 P3: the newest rehearsal without bypass, or with a state read as unreadable or absent -> NO-GO with the record', async () => {
  const cases = [
    ['no bypass', r => { delete r.rehearsal.bypass; }],
    ['main unreadable', r => { r.rehearsal.bypass.main = 'unreadable'; }],
    ['independent absent', r => { r.rehearsal.bypass.independent = 'absent'; }],
    ['independent not read', r => { r.rehearsal.bypass.independent = 'not_read'; }],
  ];
  for (const [label, change] of cases) {
    const w = world(); change(w.receipts.get('outcome-2.json'));
    const r = await run(w, 'before', { only: ['P3'] });
    assert.equal(r.verdict, 'NO-GO', label);
    assert.equal(r.items.P3.newest.file, 'outcome-2.json', label);
  }
  const w = world(); w.receipts.delete('outcome-1.json'); w.receipts.delete('outcome-2.json');
  assert.deepEqual(failedOf(await run(w, 'before', { only: ['P3'] }), 'P3'), ['NO_REHEARSAL']);
});

test('T4 P5 and P6: --before refuses a main ruleset already changed; --after takes exactly the one save against the snapshot and a push round after it', async () => {
  // --before: an actor on main, or kooyumi-train-landed already there
  let w = world(); w.rulesets.get(MAIN_RULESET_ID).bypass_actors = [{ actor_id: 7, actor_type: 'User', bypass_mode: 'always' }];
  assert.deepEqual(failedOf(await run(w, 'before', { only: ['P5'] }), 'P5'), ['BYPASS_ACTORS_NOT_EMPTY']);
  w = world(); saveC(w); w.rulesets.get(MAIN_RULESET_ID).bypass_actors = [];
  assert.deepEqual(failedOf(await run(w, 'before', { only: ['P5'] }), 'P5'), ['TRAIN_LANDED_ALREADY_REQUIRED']);
  // the R2 -> R3 path: --before GO writes the snapshot; the Owner saves C; stage 10's next round reads push
  const after = async (change, status = s => { s.train.last = { ...s.train.last, at: iso(NOW + 600_000), landing: { route: 'push' } }; }) => {
    const v = world();
    assert.equal((await run(v, 'before')).verdict, 'GO');
    saveC(v); change(v); status(v.status);
    return run(v, 'after', { now: NOW + 660_000 });
  };
  let r = await after(() => {});
  assert.equal(r.verdict, 'GO', JSON.stringify(r.items));
  assert.deepEqual(Object.keys(r.items), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
  assert.deepEqual(r.items.P5.added, [{ context: 'kooyumi-train-landed', integration_id: APP }]);
  const cases = [
    ['a second bypass actor', v => { v.rulesets.get(MAIN_RULESET_ID).bypass_actors.push({ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }); }, 'P5', 'BYPASS_ACTORS_NOT_EXACTLY_THE_APP_ALWAYS'],
    ['the App for pull requests only', v => { v.rulesets.get(MAIN_RULESET_ID).bypass_actors[0].bypass_mode = 'pull_request'; }, 'P5', 'BYPASS_ACTORS_NOT_EXACTLY_THE_APP_ALWAYS'],
    ['train-landed from any source', v => { v.rulesets.get(MAIN_RULESET_ID).rules.at(-1).parameters.required_status_checks.at(-1).integration_id = null; }, 'P5', 'REQUIRED_CHECKS_NOT_SNAPSHOT_PLUS_TRAIN_LANDED'],
    ['a required check dropped', v => { v.rulesets.get(MAIN_RULESET_ID).rules.at(-1).parameters.required_status_checks.shift(); }, 'P5', 'REQUIRED_CHECKS_NOT_SNAPSHOT_PLUS_TRAIN_LANDED'],
    ['strict turned off', v => { v.rulesets.get(MAIN_RULESET_ID).rules.at(-1).parameters.strict_required_status_checks_policy = false; }, 'P5', 'OTHER_RULES_CHANGED'],
    ['squash allowed', v => { v.rulesets.get(MAIN_RULESET_ID).rules[2].parameters.allowed_merge_methods.push('squash'); }, 'P5', 'OTHER_RULES_CHANGED'],
    ['an actor on the independent ruleset', v => { v.rulesets.get(FF).bypass_actors = [{ actor_id: APP, actor_type: 'Integration', bypass_mode: 'always' }]; }, 'P4', 'BYPASS_ACTORS_NOT_EMPTY'],
  ];
  for (const [label, change, item, code] of cases) {
    r = await after(change);
    assert.equal(r.verdict, 'NO-GO', label);
    assert.ok(failedOf(r, item).includes(code), `${label}: ${JSON.stringify(r.items[item])}`);
  }
  r = await after(() => {}, s => { s.train.last = { ...s.train.last, at: iso(NOW + 600_000), landing: { route: 'park' } }; });
  assert.deepEqual(failedOf(r, 'P6'), ['ROUTE_NOT_PUSH']);
  r = await after(() => {}, () => {});
  assert.deepEqual(failedOf(r, 'P6'), ['NO_ROUND_AFTER_THE_SNAPSHOT', 'ROUTE_NOT_PUSH']);
  // --after without the snapshot of a --before GO
  w = world(); saveC(w);
  r = await run(w, 'after');
  assert.deepEqual([r.verdict, failedOf(r, 'P5')], ['NO-GO', ['SNAPSHOT_MISSING']]);
});

test('T4: the real gh port only runs `gh api <route>`: no method, no field, no input (never a write)', async () => {
  const seen = [];
  const gh = ghPort({ run: async args => { seen.push(args); return { stdout: args.at(-1).includes('rulesets/') ? '{"id":1}' : '[]' }; } });
  await gh.get(`repos/${REPO}/rulesets/1`);
  await gh.paged(`repos/${REPO}/rules/branches/main`, null);
  await gh.paged(`repos/${REPO}/actions/runs?branch=x`, 'workflow_runs').catch(() => {});
  for (const args of seen) {
    assert.equal(args[0], 'api');
    assert.ok(!args.some(a => /^(-X|--method|-f|-F|--field|--raw-field|--input)$/.test(a)), JSON.stringify(args));
  }
  assert.ok(seen.some(a => a.at(-1) === `repos/${REPO}/rules/branches/main?per_page=100&page=1`));
});
