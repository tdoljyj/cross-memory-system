// DESIGN §80 end to end over GitHub and Native (both simulated by their HTTP answers): the train front is behind main; the workflow
// brings main in as the clued-admission App and attests it; the admission of the merge commit then keeps the holder's authorization
// of the earlier head, so the commit is ADMITTED with no person, no authorize_head and no push. Before §80 the same admission
// answered REJECTED pr_task_binding_head_not_authorized and the front waited for the holder (11-15: #1123 three times).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as admission from './clued-work-admission.mjs';
import { ADMISSION_APP_ID, APP_CHECK_NAME, INDEPENDENT_ADMISSION_APP_ID, INDEPENDENT_ADMISSION_CHECK, MAIN_MERGE_CHECK, OWNER_REVIEW_RPC, evaluate, gate, mainMergeExternalId, parseMainMergeExternalId, resolvePublicSupabaseConfig } from './clued-work-admission.mjs';
import { GITHUB_ACTIONS_APP_ID, main as frontMergeMain, pendingAuthorizationLine, renderSummary, runFrontMainMerge } from './clued-front-main-merge.mjs';
import { ciWorkflows } from './clued-merge-slot-ci.mjs';
import { NON_PR_CONTROL_FILES, NON_PR_CONTROL_SOURCE_PATH, classifyNonPrControlWorkflowSource, parseNonPrControlCatalogue } from './clued-non-pr-control-source.mjs';
import { recognizeCatalogueWorkflow } from './clued-source-only-workflow.mjs';
import { parseWorkflowProfiles, roleDefinitionDigest, workflowBlob } from './clued-workflow-profile.mjs';
import { TARGETS } from './clued-tree-reuse.mjs';
import { describe as describePrStatus } from '../../work/independent-ci-resident-v1/src/pr-status.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RPC_URL = `${resolvePublicSupabaseConfig({}, ROOT).url}/rest/v1/rpc/clued_work_verify_v1`;
const DOOR_URL = `${resolvePublicSupabaseConfig({}, ROOT).url}/rest/v1/rpc/${OWNER_REVIEW_RPC}`;
const API = 'https://api.test';
const PROTECTED = 'scripts/ci/x.mjs';
const PR = 1125, H = 'a'.repeat(40), T = '7'.repeat(40), X = 'e'.repeat(40), BASE = 'b'.repeat(40);
const CLAIM = '0f3d9c6a-1b2e-4c5d-8e7f-9a0b1c2d3e4f', TASK = '00000000-0000-4000-8000-000000000452';
const AUTH = '00000000-0000-4000-8000-000000000453', CARRIED = '00000000-0000-4000-8000-000000000454';
// The heads later update-branch calls make (after X), and the commits main moves to after T.
const FRESH = Array.from({ length: 12 }, (_, i) => (i + 1).toString(16).padStart(2, '0').repeat(20));
const MAINS = Array.from({ length: 12 }, (_, i) => `c${(i + 1).toString(16)}`.repeat(20));
// One GitHub repository and one Native, as their HTTP answers. world.pr is the PR; world.commits the commits GitHub knows.
function world({ updateMakes = 'web-flow', updateStatus = 202, behind = 3, file = 'docs/front.md',
  mainTouches = ['docs/other.md'], boundPR = true } = {}) {
  const w = {
    pr: { number: PR, state: 'open', draft: false, body: 'Body', changed_files: 1, head: { sha: H, ref: 'claude/x', repo: { full_name: 'o/r' } },
      base: { sha: BASE, ref: 'main', repo: { full_name: 'o/r', default_branch: 'main' } } },
    tip: T, mainTouches, checks: [], authorized: new Set([H]), granted: new Set([H]), asked: [], carries: [], updates: [], calls: [],
    commits: new Map([[H, { sha: H, parents: [{ sha: BASE }] }]]),
    // main's history, oldest first, and the newest main commit each head the PR had contains; update-branch makes the next of fresh.
    mains: [BASE, T], contains: new Map([[H, behind > 0 ? BASE : T]]), fresh: [X, ...FRESH],
  };
  // main moves: a new commit lands on it.
  w.moveMain = sha => { w.mains.push(sha); w.tip = sha; };
  const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null },
    json: async () => body, text: async () => JSON.stringify(body) });
  w.fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET', u = String(url), body = init.body ? JSON.parse(init.body) : null;
    w.calls.push({ method, url: u, body });
    if (u === DOOR_URL) {
      // The Owner review door: an Owner Grant exists only for the heads in w.granted; any other head is asked about and stays pending.
      const head = body.p_input.resources[0].split('/').pop();
      w.asked.push(head);
      return w.granted.has(head) ? reply({ status: 'ok', admitted: true, grant: { grant_id: `grant-${head.slice(0, 4)}` } })
        : reply({ status: 'ok', admitted: false, owner_request: { request_id: 'r1', status: 'pending', confirm_path: '/confirm/r1' } });
    }
    if (u === RPC_URL) {
      const input = body.p_input;
      if (input.action === 'resolve_pr_claim') {
        if (!boundPR) return reply({ status: 'ok', binding_status: 'unbound', reason: 'head_authorization_required',
          repository: 'o/r', pr_number: PR, pr_ref: `o/r#${PR}`, head_sha: input.head_sha, base_sha: input.base_sha,
          target_branch: input.target_branch, scope: input.scope ?? null, task_id: null, claim: null,
          head_authorization_id: null, auto_bound: false, receipt_id: null });
        const bound = w.authorized.has(input.head_sha);
        return reply({ status: 'ok', binding_status: bound ? 'bound' : 'head_not_authorized', reason: bound ? null : 'head_authorization_required',
          repository: 'o/r', pr_number: PR, pr_ref: `o/r#${PR}`, head_sha: input.head_sha, base_sha: input.base_sha, target_branch: input.target_branch,
          scope: 'global', task_id: TASK, claim: { claim_id: CLAIM, task_id: TASK, context_key: 'global', fence: 1, execution_epoch: 1, lease_version: 1,
            status: 'ACTIVE', expires_at: '2099-01-01T00:00:00.000Z', execution_handover_pending: false },
          head_authorization_id: bound ? (input.head_sha === H ? AUTH : CARRIED) : null, auto_bound: false, receipt_id: null });
      }
      if (input.action === 'carry_main_merge') {
        w.carries.push(input);
        if (!w.authorized.has(input.from_head_sha)) return reply({ status: 'rejected', error_code: 'source_head_not_authorized' });
        // Migration 20261116090000: a head the claim already authorized is answered committed, replayed, and nothing is written.
        if (w.authorized.has(input.head_sha)) return reply({ status: 'committed', replayed: true, authorization_id: CARRIED, carried_from: AUTH, head_sha: input.head_sha });
        w.authorized.add(input.head_sha);
        boundPR = true;
        return reply({ status: 'committed', replayed: false, authorization_id: CARRIED, carried_from: AUTH, head_sha: input.head_sha });
      }
      if (input.action === 'execution_current') return reply({ status: 'ok', guard_required: false, epoch_current: null });
      // The ordinary verify: Native admits only an authorized head (its exact-head authorization rule).
      if (!w.authorized.has(input.head_sha)) return reply({ status: 'ok', verdict: 'REJECTED', reasons: ['head_authorization_required'] });
      return reply({ status: 'ok', verdict: 'ADMITTED', reasons: [], paths_outside_write_set: [], current_fence: 1, execution_epoch: 1,
        claim: { claim_id: CLAIM, task_id: TASK, context_key: 'global', status: 'ACTIVE', fence: 1, execution_epoch: 1, lease_version: 1,
          expires_at: '2099-01-01T00:00:00Z', base_commit: BASE, write_set: ['docs/**'] } });
    }
    const route = u.slice(API.length);
    // main's rules as today (#292 in force): every run reads them first (FABLE-scaffold-s5-pre §1).
    if (method === 'GET' && route === '/repos/o/r') return reply({ full_name: 'o/r', default_branch: 'main' });
    if (method === 'GET' && route.startsWith('/repos/o/r/rules/branches/main')) return reply([{ type: 'required_status_checks',
      parameters: { required_status_checks: [{ context: INDEPENDENT_ADMISSION_CHECK, integration_id: INDEPENDENT_ADMISSION_APP_ID }] } }]);
    // The train a named run reads first (open-qs 2): nobody brought up and stranded, so the named run goes on.
    if (method === 'POST' && route === '/graphql') return reply({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    if (method === 'GET' && route === `/repos/o/r/pulls/${PR}`) return reply(structuredClone(w.pr));
    if (method === 'GET' && route.startsWith(`/repos/o/r/pulls/${PR}/files`)) return reply([{ filename: file, status: 'modified' }]);
    if (method === 'GET' && route === '/repos/o/r/branches/main') return reply({ name: 'main', commit: { sha: w.tip } });
    if (method === 'GET' && route.startsWith('/repos/o/r/compare/')) {
      const [from, to] = route.slice('/repos/o/r/compare/'.length).split('?')[0].split('...');
      if (from === to) return reply({ status: 'identical', behind_by: 0, files: [] });
      // main against one of the PR's heads: behind by the main commits the head does not contain; their merge base is the newest
      // main commit the head contains.
      if (w.mains.includes(from) && w.contains.has(to)) {
        const behindBy = w.mains.indexOf(from) - w.mains.indexOf(w.contains.get(to));
        return reply(behindBy > 0 ? { status: 'diverged', behind_by: behindBy, ahead_by: 1, merge_base_commit: { sha: w.contains.get(to) }, files: [{ filename: file }] }
          : { status: 'ahead', behind_by: 0, ahead_by: 2, files: [{ filename: file }] });
      }
      if (from === w.tip && to === X) return reply({ status: 'ahead', behind_by: 0, ahead_by: 2, files: [{ filename: file }] });
      // What main changed since this branch forked (also what the merge brought into the head).
      if ((from === BASE && to === w.tip) || (from === H && to === X)) return reply({ status: 'ahead', behind_by: 0, files: w.mainTouches.map(filename => ({ filename })) });
      // A commit main never had is not contained by main's tip.
      if (!w.mains.includes(from) && w.mains.includes(to)) return reply({ status: 'diverged', behind_by: 1, ahead_by: 1, files: [] });
      return reply({ status: 'ahead', behind_by: 0, files: [] });
    }
    const checkList = /^\/repos\/o\/r\/commits\/([0-9a-f]{40})\/check-runs/.exec(route);
    if (method === 'GET' && checkList && w.unreadable?.has(checkList[1])) return reply({ message: 'Server Error' }, 502);
    if (method === 'GET' && checkList) return reply({ check_runs: w.checks.filter(c => c.head_sha === checkList[1] && (!route.includes('check_name=') || route.includes(`check_name=${c.name}`))) });
    const commit = /^\/repos\/o\/r\/commits\/([0-9a-f]{40})$/.exec(route);
    if (method === 'GET' && commit) return w.commits.has(commit[1]) ? reply(w.commits.get(commit[1])) : reply({ message: 'Not Found' }, 404);
    if (method === 'GET' && route === '/repos/o/r/installation') return reply({ id: 42 });
    if (method === 'POST' && route === '/app/installations/42/access_tokens') return reply({ token: 'ghs_app', permissions: body.permissions }, 201);
    if (method === 'PUT' && route === `/repos/o/r/pulls/${PR}/update-branch`) {
      w.updates.push(body);
      if (updateStatus !== 202) return reply({ message: 'merge conflict' }, updateStatus);
      if (body.expected_head_sha !== w.pr.head.sha) return reply({ message: 'expected head sha didn’t match current head ref.' }, 422);
      // GitHub merges main into the branch itself: parents [head, main], committed and signed by web-flow.
      const made = w.fresh.shift();
      w.commits.set(made, { sha: made, parents: [{ sha: body.expected_head_sha }, { sha: w.tip }], committer: { login: updateMakes },
        commit: { verification: { verified: updateMakes === 'web-flow', reason: updateMakes === 'web-flow' ? 'valid' : 'unsigned' } } });
      w.contains.set(made, w.tip);
      w.pr.head.sha = made;
      return reply({ message: 'Updating pull request branch.' }, 202);
    }
    if (method === 'POST' && route === '/repos/o/r/check-runs') {
      const check = { id: w.checks.length + 1, ...body, app: { id: init.headers.authorization === 'Bearer ghs_app' ? ADMISSION_APP_ID : 0 } };
      w.checks.push(check);
      return reply(check, 201);
    }
    return reply({ message: `unscripted ${method} ${route}` }, 599);
  };
  return w;
}

const KEY = (process.getBuiltinModule('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const env = (extra = {}) => ({ GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'ghs_workflow', GITHUB_API_URL: API, CLUED_CONTEXT_READ_TOKEN: 'clued_bnd_test',
  GITHUB_RUN_ID: '9001', GITHUB_WORKSPACE: ROOT, CLUED_ADMISSION_APP_ID: String(ADMISSION_APP_ID), CLUED_ADMISSION_APP_PRIVATE_KEY: KEY, ...extra });
const merge = (w, input = { pr: String(PR), head: H }, extra = {}) =>
  runFrontMainMerge({ env: env(extra), fetchImpl: w.fetchImpl, workspace: ROOT, input, sleep: async () => {} });
const admit = (w, head = w.pr.head.sha, extra = {}) =>
  evaluate({ env: env(extra), event: { pull_request: { ...structuredClone(w.pr), head: { ...w.pr.head, sha: head } } }, eventName: 'pull_request',
    fetchImpl: w.fetchImpl, workspace: ROOT, withSummary: false });

test('a train front behind main is merged with main by the App and its merge commit is admitted without the holder', async () => {
  const w = world();
  const before = await admit(w, H);
  assert.equal(before.verdict, 'ADMITTED', 'the holder authorized this head');
  const result = await merge(w);
  assert.equal(result.result, 'merged', JSON.stringify(result));
  assert.deepEqual(w.updates, [{ expected_head_sha: H }], 'one update-branch, bound to the authorized head');
  assert.equal(w.pr.head.sha, X);
  const check = w.checks.find(c => c.name === MAIN_MERGE_CHECK);
  assert.equal(check.name, MAIN_MERGE_CHECK); assert.equal(check.head_sha, X); assert.equal(check.conclusion, 'success');
  assert.deepEqual(parseMainMergeExternalId(check.external_id), { pr: PR, from: H, main: T });
  // The node on duty admits the merge commit: Native carries the authorization of H, nobody authorized X.
  const after = await admit(w, X);
  assert.equal(after.verdict, 'ADMITTED', JSON.stringify({ reasons: after.reasons, notices: after.notices }));
  assert.deepEqual(w.carries.map(c => [c.from_head_sha, c.head_sha, c.main_sha, c.pr_ref, c.scope, c.target_branch]),
    [[H, X, T, `o/r#${PR}`, 'global', 'main']]);
  assert.equal(after.claim_binding.head_authorization_id, CARRIED);
});

test('an unbound PR carries an attested main merge and resolves again with its discovered Task', async () => {
  const w = world({ boundPR: false });
  assert.equal((await merge(w)).result, 'merged');
  const out = await admit(w, X);
  const actions = w.calls.filter(c => c.url === RPC_URL).map(c => c.body.p_input);
  assert.deepEqual(actions.slice(0, 3).map(a => [a.action, a.head_sha, a.scope]), [
    ['resolve_pr_claim', X, undefined], ['carry_main_merge', X, undefined], ['resolve_pr_claim', X, undefined],
  ]);
  assert.deepEqual(w.carries.map(c => [c.from_head_sha, c.head_sha, c.main_sha, c.pr_ref, c.target_branch]),
    [[H, X, T, `o/r#${PR}`, 'main']]);
  assert.equal(out.verdict, 'ADMITTED', JSON.stringify({ reasons: out.reasons, notices: out.notices }));
  assert.equal(out.claim_binding.binding_status, 'bound');
  assert.equal(out.claim_binding.task_id, TASK);
  assert.equal(out.claim_binding.head_authorization_id, CARRIED);
});

test('the admission keeps the authorization only for an attested GitHub merge of main into the authorized head', async () => {
  // No attestation (a person merged main and pushed): unchanged, the holder's own authorize_head is needed.
  let w = world();
  w.commits.set(X, { sha: X, parents: [{ sha: H }, { sha: T }] }); w.pr.head.sha = X;
  let out = await admit(w, X);
  assert.equal(out.verdict, 'REJECTED'); assert.ok(out.reasons.includes('pr_task_binding_head_not_authorized'), out.reasons.join());
  assert.equal(w.carries.length, 0);
  // An attestation check from any other App counts for nothing.
  w.checks.push({ id: 1, name: MAIN_MERGE_CHECK, head_sha: X, status: 'completed', conclusion: 'success', app: { id: 5368905 },
    external_id: mainMergeExternalId({ pr: PR, from: H, main: T }) });
  out = await admit(w, X); assert.equal(out.verdict, 'REJECTED'); assert.equal(w.carries.length, 0);
  // The App's attestation, but the commit's parents are not [H, T]: nothing carried.
  w = world();
  w.commits.set(X, { sha: X, parents: [{ sha: H }, { sha: 'f'.repeat(40) }] }); w.pr.head.sha = X;
  w.checks.push({ id: 2, name: MAIN_MERGE_CHECK, head_sha: X, status: 'completed', conclusion: 'success', app: { id: ADMISSION_APP_ID },
    external_id: mainMergeExternalId({ pr: PR, from: H, main: T }) });
  out = await admit(w, X); assert.equal(out.verdict, 'REJECTED'); assert.equal(w.carries.length, 0);
  // Attested for another PR: nothing carried.
  w.commits.set(X, { sha: X, parents: [{ sha: H }, { sha: T }] });
  w.checks[0].external_id = mainMergeExternalId({ pr: PR + 1, from: H, main: T });
  out = await admit(w, X); assert.equal(out.verdict, 'REJECTED'); assert.equal(w.carries.length, 0);
  // Native refuses a source it did not authorize (another claim's head): REJECTED as before, never an error.
  w = world(); w.authorized = new Set();
  await merge(w);
  out = await admit(w, X); assert.equal(out.verdict, 'REJECTED'); assert.equal(w.carries.length, 1);
  assert.ok(out.notices.some(n => n.startsWith('main_merge_not_carried: source_head_not_authorized')), out.notices.join());
});

// Task 30643342 (FABLE-botmerge-auth-carry-20261122 §1.3, §2 step 2, T2): main moved twice before the node on duty ever looked at the
// first merge commit (#1220: 61eab1c0 -> 85624825 -> def14fe1, 18 minutes apart). The newest attestation names the middle merge commit,
// which never got an authorization row, so the one-hop carry was refused (source_head_not_authorized) and the PR waited for the holder.
// The admission now follows the chain of attested main merges back (each hop checked as before, at most MAIN_MERGE_CHAIN_DEPTH) and
// carries it oldest hop first.
const [Y] = FRESH, T2 = MAINS[0], MAIN_MERGE_CHAIN_DEPTH = 8;
// The holder authorized H; the robot merged main T into it (X), main moved to T2, and the robot merged it again (Y): nobody admitted X.
async function mergedTwice() {
  const w = world();
  assert.equal((await admit(w, H)).verdict, 'ADMITTED', 'the holder authorized H');
  assert.equal((await merge(w)).result, 'merged');
  w.moveMain(T2);
  const again = await merge(w, { pr: String(PR), head: X });
  assert.equal(again.result, 'merged', JSON.stringify(again));
  assert.equal(w.pr.head.sha, Y);
  assert.deepEqual(w.checks.map(c => parseMainMergeExternalId(c.external_id)), [{ pr: PR, from: H, main: T }, { pr: PR, from: X, main: T2 }]);
  assert.equal(w.authorized.has(X), false, 'X was never admitted');
  return w;
}
const carried = w => w.carries.map(c => [c.from_head_sha, c.head_sha, c.main_sha]);

test('T2a: main merged twice with the middle head never admitted: the chain is carried oldest first and the newest head is admitted', async () => {
  const w = await mergedTwice();
  const out = await admit(w, Y);
  assert.equal(out.verdict, 'ADMITTED', JSON.stringify({ reasons: out.reasons, notices: out.notices }));
  assert.deepEqual(carried(w), [[H, X, T], [X, Y, T2]], 'H -> X first, then X -> Y');
  assert.equal(out.claim_binding.binding_status, 'bound');
  assert.equal(out.claim_binding.head_authorization_id, CARRIED);
  // Carrying again is idempotent: a later admission of Y finds it authorized and carries nothing.
  const again = await admit(w, Y);
  assert.equal(again.verdict, 'ADMITTED'); assert.equal(w.carries.length, 2);
});

test('T2b: a hop that is unreadable or does not qualify cuts the chain there: the holder is needed as before', async () => {
  const OTHER = 'd'.repeat(40);
  for (const [name, spoil] of [
    ['middle head has no attestation', w => { w.checks = w.checks.filter(c => c.head_sha !== X); }],
    ['middle attestation from another App', w => { w.checks.find(c => c.head_sha === X).app.id = 5368905; }],
    ['middle attestation for another PR', w => { w.checks.find(c => c.head_sha === X).external_id = mainMergeExternalId({ pr: PR + 1, from: H, main: T }); }],
    ['middle parents are not [from, main]', w => { w.commits.get(X).parents = [{ sha: H }, { sha: OTHER }]; }],
    ['middle main is not contained by the tip', w => {
      w.commits.get(X).parents = [{ sha: H }, { sha: OTHER }];
      w.checks.find(c => c.head_sha === X).external_id = mainMergeExternalId({ pr: PR, from: H, main: OTHER }); }],
    ['middle attestation unreadable', w => { w.unreadable = new Set([X]); }],
  ]) {
    const w = await mergedTwice();
    spoil(w);
    const out = await admit(w, Y);
    assert.equal(out.verdict, 'REJECTED', name);
    assert.ok(out.reasons.includes('pr_task_binding_head_not_authorized'), `${name}: ${out.reasons.join()}`);
    assert.ok(!w.carries.some(c => c.from_head_sha === H), `${name}: nothing is carried from H past a hop that does not qualify`);
    assert.equal(w.authorized.has(Y), false, name);
  }
});

test('T2c: the chain is followed at most MAIN_MERGE_CHAIN_DEPTH hops', async () => {
  for (const hops of [MAIN_MERGE_CHAIN_DEPTH, MAIN_MERGE_CHAIN_DEPTH + 1]) {
    const w = world();
    const heads = [H];
    for (let i = 0; i < hops; i++) {
      if (i) w.moveMain(MAINS[i - 1]);
      const r = await merge(w, { pr: String(PR), head: heads.at(-1) });
      assert.equal(r.result, 'merged', JSON.stringify(r));
      heads.push(w.pr.head.sha);
    }
    const out = await admit(w, heads.at(-1));
    if (hops === MAIN_MERGE_CHAIN_DEPTH) {
      assert.equal(out.verdict, 'ADMITTED', JSON.stringify({ reasons: out.reasons, notices: out.notices }));
      assert.deepEqual(w.carries.map(c => [c.from_head_sha, c.head_sha]), heads.slice(1).map((h, i) => [heads[i], h]));
    } else {
      assert.equal(out.verdict, 'REJECTED', `${hops} hops`);
      assert.ok(!w.carries.some(c => c.from_head_sha === H), 'the ninth hop back (to H) is never followed');
      assert.equal(w.authorized.has(heads.at(-1)), false);
    }
  }
  assert.equal(admission.MAIN_MERGE_CHAIN_DEPTH, MAIN_MERGE_CHAIN_DEPTH, 'the bound is the one the admission exports');
});

test('T2d: frozen admission follows no chain', async () => {
  const w = await mergedTwice();
  const out = await admit(w, Y, { CLUED_MERGE_ADMISSION_STATE: 'frozen' });
  assert.notEqual(out.verdict, 'ADMITTED');
  assert.equal(w.carries.length, 0);
  assert.equal(w.authorized.has(Y), false);
});

test('T2e: a middle head the holder authorized directly still carries to the newest head when the oldest hop is refused', async () => {
  const w = await mergedTwice();
  w.authorized = new Set([X]);
  const out = await admit(w, Y);
  assert.equal(out.verdict, 'ADMITTED', JSON.stringify({ reasons: out.reasons, notices: out.notices }));
  assert.deepEqual(carried(w).at(-1), [X, Y, T2]);
});

test('the workflow changes nothing that is no longer true', async () => {
  for (const [name, w, input, extra, want] of [
    ['frozen', world(), undefined, { CLUED_MERGE_ADMISSION_STATE: 'frozen' }, 'none'],
    ['moved', world(), { pr: String(PR), head: 'c'.repeat(40) }, {}, 'none'],
    ['up to date', world({ behind: 0 }), undefined, {}, 'none'],
    ['conflict', world({ updateStatus: 422 }), undefined, {}, 'refused'],
    ['bad input', world(), { pr: 'x', head: H }, {}, 'refused'],
    ['frozen, protected layer', world({ file: PROTECTED }), undefined, { CLUED_MERGE_ADMISSION_STATE: 'frozen' }, 'none'],
  ]) {
    const r = await merge(w, input, extra);
    assert.equal(r.result, want, `${name}: ${JSON.stringify(r)}`);
    assert.equal(w.checks.length, 0, name);
    if (want === 'none' || name === 'bad input') assert.equal(w.updates.length, 0, name);
  }
  const draft = world(); draft.pr.draft = true;
  assert.equal((await merge(draft)).result, 'none'); assert.equal(draft.updates.length, 0);
  // A new head that is not GitHub's own merge commit is never attested.
  const other = world({ updateMakes: 'someone' });
  const r = await merge(other);
  assert.equal(r.result, 'unattested'); assert.equal(other.checks.length, 0);
});

// Owner 11-22 (replaces 78a3052f item 2, "protected-layer PRs are not updated yet"): the protected layer is brought up to main too.
// Its admission needs an Owner Grant of the head; the grant of the earlier head carries over (Decision a0d93cd0) only while main
// did not touch the protected files this PR changes.
test('a protected-layer front behind main is merged with main; its Owner Grant carries when main left the protected files of the PR alone', async () => {
  const w = world({ file: PROTECTED, mainTouches: ['scripts/ci/other.mjs', 'docs/other.md'] });
  const admittedBefore = () => w.checks.push({ id: 900, name: APP_CHECK_NAME, head_sha: H, status: 'completed', conclusion: 'success', app: { id: ADMISSION_APP_ID } });
  // H was admitted and granted while it contained main's older tip; main moved on since (so H alone is no longer admissible).
  admittedBefore();
  const result = await merge(w);
  assert.equal(result.result, 'merged', JSON.stringify(result));
  assert.deepEqual(w.updates, [{ expected_head_sha: H }]);
  assert.equal(w.pr.head.sha, X);
  assert.equal(w.checks.find(c => c.name === MAIN_MERGE_CHECK)?.head_sha, X);
  w.asked.length = 0;
  const after = await admit(w, X);
  assert.equal(after.verdict, 'ADMITTED', JSON.stringify({ reasons: after.reasons, notices: after.notices }));
  assert.equal(after.owner_review.carried_from, H);
  assert.deepEqual(w.asked, [H], 'only the earlier head is asked at the door; the merge commit gets no new request');
});

test('a protected-layer front whose PR-changed protected file main also touched needs a new Grant for the merge commit', async () => {
  const w = world({ file: PROTECTED, mainTouches: [PROTECTED] });
  const admittedBefore = () => w.checks.push({ id: 900, name: APP_CHECK_NAME, head_sha: H, status: 'completed', conclusion: 'success', app: { id: ADMISSION_APP_ID } });
  // H was admitted and granted while it contained main's older tip; main moved on since (so H alone is no longer admissible).
  admittedBefore();
  assert.equal((await merge(w)).result, 'merged');
  w.asked.length = 0;
  const after = await admit(w, X);
  assert.equal(after.verdict, 'REJECTED', JSON.stringify(after.notices));
  assert.ok(after.reasons.some(r => r.startsWith('owner_review_pending') || r.startsWith('owner_review')), after.reasons.join());
  assert.equal(after.owner_review.carried_from, undefined, 'the old Grant is not carried');
  assert.deepEqual(w.asked, [X], 'the Owner is asked about the new head');
});

// The workflow has no pull_request trigger, so it can never be a registered PR CI Source (compileRegisteredWorkflow
// needs one). Unregistered, the PR CI enumeration counted it (it has an admission-gate) and its bytes had no catalogue
// identity (CATALOGUE_SOURCE_NOT_IDENTIFIED), as ci-proof-profiles.test.mjs requires for every counted workflow. It is an
// exact non-PR control Source like clued-native617-admission-dispatch.yml: its whole bytes and every job, the gate included, pinned.
test('the workflow is an exact non-PR control Source; every counted CI workflow keeps its catalogue identity', () => {
  const file = '.github/workflows/clued-front-main-merge.yml';
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const catalogue = parseNonPrControlCatalogue(fs.readFileSync(path.join(ROOT, NON_PR_CONTROL_SOURCE_PATH)));
  const pin = NON_PR_CONTROL_FILES[file], entry = catalogue.workflows[file];
  assert.ok(pin && entry, `${file} is not a registered non-PR control Source`);
  // The pins are the digests of the current Git bytes and of the registered definition, computed here.
  const definition = entry.workflow_definition;
  assert.deepEqual(Object.keys(definition.jobs).sort(), ['admission-gate', 'merge-main']);
  assert.deepEqual({ workflow_blob: pin.workflow_blob, source_sha256: pin.source_sha256, workflow_definition_sha256: pin.workflow_definition_sha256,
    triggers: [...pin.triggers], roles: { ...pin.roles } }, { workflow_blob: workflowBlob(text), source_sha256: createHash('sha256').update(text).digest('hex'),
    workflow_definition_sha256: roleDefinitionDigest(definition), triggers: ['push', 'schedule', 'workflow_dispatch'],
    roles: Object.fromEntries(Object.entries(definition.jobs).map(([id, job]) => [id, roleDefinitionDigest(job)])) });
  const selected = classifyNonPrControlWorkflowSource(catalogue, file, text);
  assert.equal(selected.passed, true, selected.reason);
  assert.equal(selected.pull_request_ci, false); assert.equal(selected.execution_authority, false);
  const counted = ciWorkflows(ROOT);
  const registry = parseWorkflowProfiles(fs.readFileSync(path.join(ROOT, 'scripts/ci/clued-gated-proof-profiles.json'), 'utf8'));
  const roleSpecs = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/ci/clued-gated-proof-role-specs.json'), 'utf8'));
  for (const [name, blob] of counted)
    assert.equal(recognizeCatalogueWorkflow({ registry, roleSpecs, file: name, blob }).source_identified, true, `${name}: no catalogue identity`);
  assert.equal(counted.has(file), false, 'a workflow without a pull_request trigger is not counted PR CI');
});

// Task ea22e734 (FABLE-front-merge-stale-summary-20261122 §2.1, §2.2): who gets main is decided by this workflow from GitHub's
// own records, on every push to main, every 10 minutes and on a dispatch without inputs. The train is the open pull requests
// with auto-merge on; its front is the one that contains main's tip and is under way; with no front, the earliest-enabled
// candidate is brought up to main. Before, the decision hung on the node's stage-10 summary, which is empty after every merge
// and stale during every long batch: the PR page then told every holder to merge main by hand (33 manual merges).
const MIN = 60_000, NOW = Date.UTC(2026, 10, 22, 0, 23, 42);   // 11-22 08:23:42 Beijing time
const REQUIRED = ['ci-suites', 'clued-cloud-tests'];
const sha = n => n.toString(16).padStart(40, '0');
const iso = ms => new Date(ms).toISOString();
// One repository with several pull requests, as GitHub's HTTP answers. w.now is the clock; w.tip is main.
function train() {
  const w = { now: NOW, tip: T, prs: new Map(), heads: new Map(), updates: [], calls: [], required: REQUIRED, failing: null, made: 0, ruleFiller: 0, endless: false,
    pins: {}, comments: [] };
  // A commit GitHub knows: which main tip it contains, when it appeared, and what ran on it.
  w.head = (id, { contains = BASE, behind = 3, at = w.now - 600 * MIN, checks = [], statuses = [], runs = [], parents = [BASE] } = {}) => {
    w.heads.set(id, { sha: id, contains, behind, at, checks, statuses, runs, parents }); return id; };
  w.open = (number, { head, auto = null, draft = false, mergeable = 'MERGEABLE', fork = false, base = 'main', ...rest }) => {
    w.head(head, rest); w.prs.set(number, { number, head, auto, draft, mergeable, fork, base, updatedAt: rest.at ?? w.now - 600 * MIN }); return w; };
  w.check = (id, name, conclusion = 'success', app = 15368, extra = {}) => w.heads.get(id).checks.push({ id: ++w.made, name, head_sha: id,
    status: conclusion === null ? 'in_progress' : 'completed', conclusion, started_at: iso(w.now), app: { id: app }, output: { title: null }, ...extra });
  w.green = id => { for (const name of REQUIRED) w.check(id, name); w.check(id, INDEPENDENT_ADMISSION_CHECK, 'success', INDEPENDENT_ADMISSION_APP_ID); };
  w.headOf = number => w.prs.get(number).head;
  w.merged = number => { w.prs.delete(number); w.tip = sha(0x7000 + ++w.made); };   // GitHub merged it: main moved
  const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null },
    json: async () => body, text: async () => JSON.stringify(body) });
  w.fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET', route = String(url).slice(API.length), body = init.body ? JSON.parse(init.body) : null;
    w.calls.push({ method, route, body });
    if (w.failing && route.includes(w.failing)) return reply({ message: 'Server Error' }, 502);
    if (method === 'POST' && route === '/graphql') return reply({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: w.endless, endCursor: w.endless ? 'more' : null },
      nodes: [...w.prs.values()].map(p => ({ number: p.number, isDraft: p.draft, baseRefName: p.base, headRefOid: p.head, mergeable: p.mergeable,
        updatedAt: iso(p.updatedAt), autoMergeRequest: p.auto === null ? null : { enabledAt: p.auto },
        headRepository: { nameWithOwner: p.fork ? 'someone/r' : 'o/r' } })) } } } });
    // The branch's rules, 100 a page: w.ruleFiller full pages of other rules come before the page with the required checks.
    // A required check is a name (pinned as w.pins says) or a { context, integration_id } pair: one name may be pinned twice.
    const rules = /^\/repos\/o\/r\/rules\/branches\/main(?:\?(?:.*&)?page=([0-9]+))?/.exec(route);
    if (method === 'GET' && rules) {
      const page = Number(rules[1] ?? 1);
      if (page <= w.ruleFiller) return reply(Array.from({ length: 100 }, () => ({ type: 'deletion' })));
      return reply(page > w.ruleFiller + 1 ? [] : [{ type: 'deletion' },
        ...(w.required.length ? [{ type: 'required_status_checks', parameters: { required_status_checks: w.required.map(context =>
          (typeof context === 'object' ? context : w.pins[context] === undefined ? { context } : { context, integration_id: w.pins[context] })) } }] : [])]);
    }
    if (method === 'GET' && route === '/repos/o/r') return reply({ full_name: 'o/r', default_branch: 'main' });
    const comment = /^\/repos\/o\/r\/issues\/([0-9]+)\/comments$/.exec(route);
    if (method === 'POST' && comment) {
      w.comments.push({ pr: Number(comment[1]), body: body.body, app: init.headers.authorization === 'Bearer ghs_app' });
      return reply({ id: w.comments.length }, 201);
    }
    // A pull request's comments, 100 a page, as GitHub answers (a plain list, no count).
    const comments = /^\/repos\/o\/r\/issues\/([0-9]+)\/comments\?(?:.*&)?page=([0-9]+)/.exec(route);
    if (method === 'GET' && comments) return reply(w.comments.filter(c => c.pr === Number(comments[1])).map((c, i) => ({ id: i + 1, body: c.body }))
      .slice((Number(comments[2]) - 1) * 100).slice(0, 100));
    if (method === 'GET' && route === '/repos/o/r/branches/main') return reply({ name: 'main', commit: { sha: w.tip } });
    const pull = /^\/repos\/o\/r\/pulls\/([0-9]+)$/.exec(route), p = pull && w.prs.get(Number(pull[1]));
    if (method === 'GET' && pull) return p ? reply({ number: p.number, state: 'open', draft: p.draft, updated_at: iso(p.updatedAt),
      head: { sha: p.head, repo: { full_name: p.fork ? 'someone/r' : 'o/r' } }, base: { ref: p.base, repo: { full_name: 'o/r', default_branch: 'main' } } })
      : reply({ message: 'Not Found' }, 404);
    const compare = /^\/repos\/o\/r\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})/.exec(route);
    if (method === 'GET' && compare) {
      const head = w.heads.get(compare[2]);
      return reply({ behind_by: head?.contains === compare[1] ? 0 : head?.behind ?? 3, ahead_by: 1 });
    }
    const of = /^\/repos\/o\/r\/commits\/([0-9a-f]{40})(\/check-runs|\/status)?(?:\?|$)/.exec(route), h = of && w.heads.get(of[1]);
    if (method === 'GET' && of && !h) return reply({ message: 'Not Found' }, 404);
    if (method === 'GET' && of?.[2] === '/check-runs') return reply({ total_count: h.checks.length, check_runs: h.checks });
    // Lists come 100 a page with the count of all of them, as GitHub answers.
    const paged = list => list.slice((Number(/[?&]page=([0-9]+)/.exec(route)?.[1] ?? 1) - 1) * 100).slice(0, 100);
    if (method === 'GET' && of?.[2] === '/status') return reply({ state: 'pending', total_count: h.statuses.length, statuses: paged(h.statuses) });
    if (method === 'GET' && of) return reply({ sha: h.sha, parents: h.parents.map(s => ({ sha: s })), committer: { login: h.parents.length === 2 ? 'web-flow' : 'holder' },
      commit: { committer: { date: iso(h.at) }, verification: { verified: h.parents.length === 2 } } });
    const runs = /^\/repos\/o\/r\/actions\/runs\?.*head_sha=([0-9a-f]{40})/.exec(route);
    if (method === 'GET' && runs) {
      const all = w.heads.get(runs[1])?.runs ?? [];
      return reply({ total_count: all.length, workflow_runs: all.slice((Number(/[?&]page=([0-9]+)/.exec(route)?.[1] ?? 1) - 1) * 100).slice(0, 100) });
    }
    // The git commit object: its parents, no diff.
    const object = /^\/repos\/o\/r\/git\/commits\/([0-9a-f]{40})$/.exec(route), g = object && w.heads.get(object[1]);
    if (method === 'GET' && object) return g ? reply({ sha: g.sha, parents: g.parents.map(s => ({ sha: s })) }) : reply({ message: 'Not Found' }, 404);
    if (method === 'GET' && route === '/repos/o/r/installation') return reply({ id: 42 });
    if (method === 'POST' && route === '/app/installations/42/access_tokens') return reply({ token: 'ghs_app', permissions: body.permissions }, 201);
    const update = /^\/repos\/o\/r\/pulls\/([0-9]+)\/update-branch$/.exec(route), u = update && w.prs.get(Number(update[1]));
    if (method === 'PUT' && update) {
      if (!u || u.mergeable === 'CONFLICTING') return reply({ message: 'merge conflict between base and head' }, 422);
      if (body.expected_head_sha !== u.head) return reply({ message: 'expected head sha did not match current head ref.' }, 422);
      // GitHub merges main into the branch itself; the new head appears now and nothing has run on it yet.
      const merged = sha(0xe000 + ++w.made);
      w.head(merged, { contains: w.tip, at: w.now, parents: [u.head, w.tip] });
      w.updates.push({ pr: u.number, from: u.head, to: merged, main: w.tip });
      u.head = merged; u.updatedAt = w.now;
      return reply({ message: 'Updating pull request branch.' }, 202);
    }
    if (method === 'POST' && route === '/repos/o/r/check-runs') {
      const check = { id: ++w.made, ...body, started_at: iso(w.now), app: { id: init.headers.authorization === 'Bearer ghs_app' ? ADMISSION_APP_ID : 0 } };
      w.heads.get(body.head_sha).checks.push(check);
      return reply(check, 201);
    }
    return reply({ message: `unscripted ${method} ${route}` }, 599);
  };
  w.run = (input = {}, extra = {}) => runFrontMainMerge({ env: env(extra), fetchImpl: w.fetchImpl, workspace: ROOT, input, now: () => w.now, sleep: async () => {} });
  w.brought = () => w.updates.map(u => u.pr);
  return w;
}
// 11-22 08:23 as GitHub had it: #1223 merged at 08:16 and main moved; every open pull request is behind.
//   #1156 auto-merge on since 11-17, nobody working on it     #1217 auto-merge on since 11-21, its head tested and admitted
//   #1224, #1225 auto-merge on since 11-22, never admitted    #1190 behind as well, auto-merge off
function scene0823() {
  const w = train();
  w.open(1156, { head: sha(0x1156), auto: '2026-11-17T03:00:00Z' });
  w.open(1217, { head: sha(0x1217), auto: '2026-11-21T10:00:00Z' }); w.green(sha(0x1217));
  w.open(1224, { head: sha(0x1224), auto: '2026-11-22T00:02:00Z' });
  w.open(1225, { head: sha(0x1225), auto: '2026-11-22T00:02:00Z' });
  w.open(1190, { head: sha(0x1190) });
  for (const p of w.prs.values()) w.heads.get(p.head).statuses.push({ context: 'resident-queue/turing', state: 'pending', description: '落后 main 3 个提交；请合入最新 main 并推送' });
  return w;
}

test('11-22 08:23: main moved and nobody is the front; a run without inputs brings exactly one pull request up to main, in auto-merge order', async () => {
  const w = scene0823();
  const before = new Map([...w.prs.values()].map(p => [p.number, p.head]));
  const first = await w.run();
  assert.equal(first.result, 'merged', JSON.stringify(first));
  assert.equal(first.pr, 1156, 'the earliest auto-merge request among the candidates');
  assert.deepEqual(w.brought(), [1156], 'exactly one update-branch');
  assert.deepEqual(w.updates[0], { pr: 1156, from: sha(0x1156), to: w.headOf(1156), main: T });
  const attested = w.heads.get(w.headOf(1156)).checks.find(c => c.name === MAIN_MERGE_CHECK);
  assert.deepEqual(parseMainMergeExternalId(attested.external_id), { pr: 1156, from: sha(0x1156), main: T }, 'the same attestation as a named run');
  assert.equal(attested.app.id, ADMISSION_APP_ID);
  for (const number of [1217, 1224, 1225, 1190]) assert.equal(w.headOf(number), before.get(number), `#${number} is left as it is`);
  assert.equal(w.calls.filter(c => c.method !== 'GET' && c.route !== '/graphql' && !c.route.includes('/access_tokens')).length, 2, 'one update-branch and one check, nothing else is written');

  // 10 minutes later (the schedule): #1156 contains main and its head is young: it is the front, nothing is done.
  w.now += 10 * MIN;
  const second = await w.run();
  assert.equal(second.result, 'none', JSON.stringify(second)); assert.deepEqual(w.brought(), [1156]);
  // Nobody works on #1156: 15 minutes after its head appeared nothing runs on it and its required checks are not green.
  // It is idle, so not under way; the next one is brought. #1156 costs one merge commit and holds nobody up.
  w.now += 6 * MIN;
  const third = await w.run();
  assert.equal(third.result, 'merged', JSON.stringify(third)); assert.equal(third.pr, 1217);
  assert.deepEqual(w.brought(), [1156, 1217]);
  // #1217 is admitted and its checks run: it is the front. A push to main and the schedule both find nothing to do.
  w.heads.get(w.headOf(1217)).runs.push({ id: 1, status: 'in_progress', conclusion: null });
  w.now += 10 * MIN;
  assert.equal((await w.run()).result, 'none'); assert.deepEqual(w.brought(), [1156, 1217]);
  // Its required checks are green and GitHub is about to merge it (nothing runs any more, older than 15 minutes): still the front.
  w.heads.get(w.headOf(1217)).runs[0] = { id: 1, status: 'completed', conclusion: 'success' }; w.green(w.headOf(1217));
  w.now += 30 * MIN;
  assert.equal((await w.run()).result, 'none'); assert.deepEqual(w.brought(), [1156, 1217]);
  // GitHub merges #1217 and main moves (the push event). #1156's head is the one the App made and the admission never
  // admitted: it is brought again only after every other candidate (PLAN-train-held-deadlock §2.1). The next in order is #1224
  // (enabled with #1225: lower number).
  w.merged(1217);
  const fourth = await w.run();
  assert.equal(fourth.result, 'merged', JSON.stringify(fourth)); assert.equal(fourth.pr, 1224);
  assert.deepEqual(w.brought(), [1156, 1217, 1224]);
  assert.equal(w.headOf(1190), sha(0x1190), 'a pull request without auto-merge is never touched');
  assert.equal(w.headOf(1225), sha(0x1225));
  // #1156's holder pushes a new head (behind main again): it counts again, earliest request first, once the front is gone.
  w.merged(1224);
  w.prs.get(1156).head = w.head(sha(0x11560), { at: w.now }); w.prs.get(1156).updatedAt = w.now;
  const fifth = await w.run();
  assert.equal(fifth.pr, 1156, JSON.stringify(fifth)); assert.equal(fifth.result, 'merged');
});

test('a front that is under way keeps the train as it is; a red or idle front is passed over', async () => {
  // Under way: contains main, something queued. Nothing is brought, whoever enabled auto-merge earlier.
  let w = scene0823();
  w.heads.get(sha(0x1225)).contains = T; w.check(sha(0x1225), 'ci-suites', null);
  let r = await w.run();
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.deepEqual(w.brought(), []);
  assert.equal(w.calls.some(c => c.route.includes('/access_tokens')), false, 'no App token is minted when nothing is to be done');
  // Under way: contains main, the resident's pending status says it is queued (no check yet), head older than 15 minutes.
  w = scene0823();
  w.heads.get(sha(0x1225)).contains = T; w.heads.get(sha(0x1225)).statuses = [{ context: 'resident-queue/turing', state: 'pending', description: '排队中' }];
  assert.equal((await w.run()).result, 'none'); assert.deepEqual(w.brought(), []);
  // Red: a required check failed on the front's head. It is not under way; the next candidate is brought.
  w = scene0823();
  w.heads.get(sha(0x1225)).contains = T; w.check(sha(0x1225), 'ci-suites', 'failure'); w.check(sha(0x1225), 'clued-cloud-tests', null);
  r = await w.run();
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.deepEqual(w.brought(), [1156]);
  // A failed check that is not required does not make it red.
  w = scene0823();
  w.heads.get(sha(0x1225)).contains = T; w.check(sha(0x1225), 'optional-lint', 'failure'); w.check(sha(0x1225), 'clued-cloud-tests', null);
  assert.equal((await w.run()).result, 'none'); assert.deepEqual(w.brought(), []);
  // Idle: contains main for 15 minutes, nothing queued, running or pending, required checks not all green (the resident
  // said it stopped: that pending status is not something that will finish).
  w = scene0823();
  Object.assign(w.heads.get(sha(0x1225)), { contains: T, at: w.now - 15 * MIN, statuses: [{ context: 'resident-queue/turing', state: 'pending', description: '必需检查失败，已停止入队和延长；等待检查重跑' }] });
  w.prs.get(1225).updatedAt = w.now - 15 * MIN; w.check(sha(0x1225), 'ci-suites');
  r = await w.run();
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.deepEqual(w.brought(), [1156]);
  // The same head one minute younger is not idle yet.
  w = scene0823();
  Object.assign(w.heads.get(sha(0x1225)), { contains: T, at: w.now - 14 * MIN, statuses: [] }); w.prs.get(1225).updatedAt = w.now - 14 * MIN;
  assert.equal((await w.run()).result, 'none'); assert.deepEqual(w.brought(), []);
  // A front without auto-merge is not on the train: it does not hold the others.
  w = scene0823();
  w.heads.get(sha(0x1190)).contains = T; w.check(sha(0x1190), 'ci-suites', null);
  assert.deepEqual([(await w.run()).result, w.brought()], ['merged', [1156]]);
});

test('only candidates are brought: not a conflict, a red head, a head the App brought that was never admitted, a draft, a fork, another base', async () => {
  // GitHub reports the conflict: skipped without an update-branch; the holder resolves it.
  let w = scene0823();
  w.prs.get(1156).mergeable = 'CONFLICTING';
  let r = await w.run();
  assert.equal(r.pr, 1217, JSON.stringify(r)); assert.deepEqual(w.brought(), [1217]);
  assert.equal(w.calls.filter(c => c.method === 'PUT').length, 1, 'no update-branch for the conflicting one');
  // GitHub has not computed mergeability yet (main just moved) and update-branch refuses: the next in order is brought in the same run.
  w = scene0823();
  const refuse = w.fetchImpl;
  w.fetchImpl = async (url, init = {}) => (init.method === 'PUT' && String(url).endsWith('/pulls/1156/update-branch'))
    ? { ok: false, status: 422, headers: { get: () => null }, json: async () => ({ message: 'merge conflict between base and head' }), text: async () => '' } : refuse(url, init);
  w.prs.get(1156).mergeable = 'UNKNOWN';
  r = await w.run();
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.equal(r.pr, 1217); assert.deepEqual(w.brought(), [1217]);
  // A required check failed on the behind head, the author's own: brought once, main may carry the fix (§3.1, #1258).
  w = scene0823();
  w.check(sha(0x1156), 'clued-cloud-tests', 'failure');
  r = await w.run();
  assert.equal(r.pr, 1156, JSON.stringify(r)); assert.deepEqual(w.brought(), [1156]);
  // The admission failed on the behind head (#292 requires it): main does not change that, not brought (its holder has to push anyway).
  w = rulesOf(scene0823(), 'framework');
  w.check(sha(0x1156), INDEPENDENT_ADMISSION_CHECK, 'failure', INDEPENDENT_ADMISSION_APP_ID);
  r = await w.run();
  assert.equal(r.pr, 1217, JSON.stringify(r)); assert.deepEqual(w.brought(), [1217]);
  assert.match(r.train.members.find(m => m.pr === 1156).state, /^red \(kooyumi-work-admission\)$/);
  // Red on a head the App brought up (its first parent the author's, BASE): brought again only after every candidate that is
  // not red (第二轮规划 A, 任务 2fb32dc7).
  w = scene0823(); w.head(BASE);
  w.check(sha(0x1156), MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID); w.check(sha(0x1156), INDEPENDENT_ADMISSION_CHECK, 'success', INDEPENDENT_ADMISSION_APP_ID);
  w.check(sha(0x1156), 'clued-cloud-tests', 'failure');
  r = await w.run();
  assert.equal(r.pr, 1217, JSON.stringify(r)); assert.deepEqual(w.brought(), [1217]);
  assert.match(r.train.members.find(m => m.pr === 1156).state, /^candidate, red \(clued-cloud-tests\) on a head the App brought/, JSON.stringify(r.train.members));
  // The App brought this head earlier and the admission never admitted it: brought again after every other candidate
  // (PLAN-train-held-deadlock §2.1), not before them.
  w = scene0823(); w.head(BASE);
  w.check(sha(0x1156), MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID);
  r = await w.run();
  assert.equal(r.pr, 1217); assert.deepEqual(w.brought(), [1217]);
  assert.match(r.train.members.find(m => m.pr === 1156).state, /^candidate, not admitted on a head the App brought: main is merged in again, after the others$/);
  // Its first parent the App brought as well: two in a row, not brought a third time.
  w = scene0823(); w.head(BASE); w.check(BASE, MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID);
  w.check(sha(0x1156), MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID);
  r = await w.run();
  assert.equal(r.pr, 1217); assert.match(r.train.members.find(m => m.pr === 1156).state, /^not admitted on a head the App brought: 连带 2 次仍未通过，不再带$/);
  // The same head, admitted by the independent CI (it ran, then main moved): brought again.
  w = scene0823();
  w.check(sha(0x1156), MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID); w.check(sha(0x1156), INDEPENDENT_ADMISSION_CHECK, 'success', INDEPENDENT_ADMISSION_APP_ID);
  assert.equal((await w.run()).pr, 1156);
  // A same-name attestation of another App does not mark the head; a same-name admission of another App does not clear it.
  w = scene0823();
  w.check(sha(0x1156), MAIN_MERGE_CHECK, 'success', 15368);
  assert.equal((await w.run()).pr, 1156);
  w = scene0823();
  w.check(sha(0x1156), MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID); w.check(sha(0x1156), INDEPENDENT_ADMISSION_CHECK, 'success', 15368);
  assert.equal((await w.run()).pr, 1217);
  // Drafts, forks and pull requests into another branch are not on the train, auto-merge or not.
  w = scene0823();
  w.prs.get(1156).draft = true; w.prs.get(1217).fork = true; w.prs.get(1224).base = 'release';
  r = await w.run();
  assert.equal(r.pr, 1225, JSON.stringify(r)); assert.deepEqual(w.brought(), [1225]);
  // Nobody on the train: nothing to do.
  w = scene0823();
  for (const p of w.prs.values()) p.auto = null;
  r = await w.run();
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.deepEqual(w.brought(), []);
});

test('a run without inputs changes nothing while merge admission is frozen or GitHub cannot be read', async () => {
  let w = scene0823();
  let r = await w.run({}, { CLUED_MERGE_ADMISSION_STATE: 'frozen' });
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.deepEqual(w.brought(), []); assert.equal(w.calls.length, 0, 'nothing is read either');
  for (const failing of ['/graphql', '/rules/branches/main', '/branches/main', '/compare/', '/check-runs', '/status', '/actions/runs']) {
    w = scene0823(); w.failing = failing;
    // a front that needs every read: it contains main and is old enough to be idle
    Object.assign(w.heads.get(sha(0x1225)), { contains: T, at: w.now - 20 * MIN }); w.prs.get(1225).updatedAt = w.now - 20 * MIN;
    r = await w.run();
    assert.equal(r.result, 'skipped', `${failing}: ${JSON.stringify(r)}`);
    assert.deepEqual(w.brought(), [], failing);
  }
  // The App is not configured: the choice is made and nothing is written.
  w = scene0823();
  r = await w.run({}, { CLUED_ADMISSION_APP_ID: '' });
  assert.equal(r.result, 'skipped', JSON.stringify(r)); assert.deepEqual(w.brought(), []);
});

test('a run with pr and head handles only the named pull request, as before', async () => {
  // The node's dispatch names #1225 while #1156 is earlier and #1224 is under way: only #1225 is read and brought.
  const w = scene0823();
  w.heads.get(sha(0x1224)).contains = T; w.check(sha(0x1224), 'ci-suites', null);
  const r = await w.run({ pr: '1225', head: sha(0x1225) });
  assert.deepEqual(r, { result: 'merged', reason: `main ${T.slice(0, 12)} merged into ${sha(0x1225).slice(0, 12)} -> ${w.headOf(1225).slice(0, 12)}`,
    pr: 1225, head_sha: sha(0x1225), merged_head_sha: w.headOf(1225), main_sha: T });
  assert.deepEqual(w.brought(), [1225]);
  const calls = w.calls.map(c => `${c.method} ${c.route}`), named = calls.indexOf('GET /repos/o/r/pulls/1225');
  // which copy brings the front (FABLE-scaffold-s5-pre §1): the rules in force, read first; then the named pull request only,
  // the train is not read (no hold, PLAN-train-held-deadlock §2.1)
  assert.deepEqual(calls.slice(0, 2), ['GET /repos/o/r', 'GET /repos/o/r/rules/branches/main?per_page=100&page=1']);
  assert.equal(named, 2, JSON.stringify(calls)); assert.equal(calls.includes('POST /graphql'), false);
  assert.deepEqual(calls.slice(named), [
    'GET /repos/o/r/pulls/1225', 'GET /repos/o/r/branches/main', `GET /repos/o/r/compare/${T}...${sha(0x1225)}`,
    'GET /repos/o/r/installation', 'POST /app/installations/42/access_tokens', 'PUT /repos/o/r/pulls/1225/update-branch',
    'GET /repos/o/r/pulls/1225', `GET /repos/o/r/commits/${w.headOf(1225)}`, 'GET /repos/o/r/branches/main', 'POST /repos/o/r/check-runs']);
  assert.equal(renderSummary(r), `## clued-front-main-merge\n\n- #1225 \`${sha(0x1225).slice(0, 12)}\`: **merged**: ${r.reason}\n`);
  // Half an input is a mistake, not a run without inputs: refused, nothing read.
  for (const input of [{ pr: '1225' }, { head: sha(0x1225) }, { pr: '1225', head: '' }, { pr: 'x', head: sha(0x1225) }]) {
    const half = scene0823();
    const refused = await half.run(input);
    assert.deepEqual([refused.result, refused.reason, half.calls.length], ['refused', 'input needs pr (number) and head (full SHA)', 0], JSON.stringify(input));
  }
});

test('push to main, the schedule and a dispatch without inputs all reach the choice; the summary says what was decided', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMPDIR ?? '.', 'front-merge-'));
  try {
    for (const [name, payload] of [['push', { ref: 'refs/heads/main', after: T }], ['schedule', { schedule: '*/10 * * * *' }],
      ['workflow_dispatch', { inputs: null }], ['workflow_dispatch', { inputs: { pr: '', head: '' } }]]) {
      const w = scene0823();
      const eventPath = path.join(dir, 'event.json'), summary = path.join(dir, 'summary.md');
      fs.writeFileSync(eventPath, JSON.stringify(payload)); fs.writeFileSync(summary, '');
      const code = await frontMergeMain(env({ GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: summary }), w.fetchImpl,
        { now: () => w.now, sleep: async () => {} });
      assert.equal(code, 0, name); assert.deepEqual(w.brought(), [1156], `${name} ${JSON.stringify(payload)}`);
      const text = fs.readFileSync(summary, 'utf8');
      assert.match(text, /#1156 .*\*\*merged\*\*/, text);
      for (const number of [1217, 1224, 1225]) assert.match(text, new RegExp(`#${number}\\b`), `the summary names every pull request on the train: ${text}`);
      assert.doesNotMatch(text, /#1190\b/, 'not the one without auto-merge');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const text = fs.readFileSync(path.join(ROOT, '.github/workflows/clued-front-main-merge.yml'), 'utf8');
  const on = text.slice(text.indexOf('\non:\n'), text.indexOf('\npermissions:\n'));
  assert.match(on, /\n  push:\n    branches: \[main\]\n/, 'every advance of main');
  assert.match(on, /\n  schedule:\n    - cron: "\*\/10 \* \* \* \*"\n/, 'every 10 minutes');
  assert.match(on, /\n  workflow_dispatch:\n/);
  assert.equal((on.match(/required: false/g) ?? []).length, 2, 'pr and head are optional: a dispatch without them chooses');
  assert.doesNotMatch(on, /required: true|pull_request/);
  // The job with the App key runs for the three triggers, on main only (the environment's deployment branches say the same).
  assert.match(text, /\n    if: needs\.admission-gate\.outputs\.admitted == 'true' && \(github\.ref == 'refs\/heads\/main'\)\n/);
});

// Independent review of e37e3a33: with a required list read as empty every failure counted as red. The resident's info-only
// status is a failure on every head for good, so the front under way was passed over and one more pull request was brought
// up every 10 minutes: two under way at once. An empty or incomplete reading decides nothing.
test('a run without inputs decides nothing when the required checks or the train cannot be read in full', async () => {
  // The front under way, with the resident's info-only status failed as it is on every head.
  const front = () => {
    const w = scene0823();
    w.heads.get(sha(0x1225)).contains = T; w.check(sha(0x1225), 'ci-suites', null);
    w.heads.get(sha(0x1225)).statuses.unshift({ context: 'resident-queue/turing (info only)', state: 'failure', description: 'info only' });
    return w;
  };
  let w = front();
  assert.equal((await w.run()).result, 'none', 'with the required list read, an optional failure leaves the front as it is'); assert.deepEqual(w.brought(), []);
  // The rules name no required check (or the token does not see them).
  w = front(); w.required = [];
  let r = await w.run();
  assert.equal(r.result, 'skipped', JSON.stringify(r)); assert.match(r.reason, /required/); assert.deepEqual(w.brought(), []);
  // No front at all and no required list: nobody is brought up either.
  w = scene0823(); w.required = [];
  r = await w.run();
  assert.equal(r.result, 'skipped', JSON.stringify(r)); assert.deepEqual(w.brought(), []);
  assert.equal(w.calls.some(c => c.method === 'PUT' || c.route.includes('/access_tokens')), false);
  // The required checks are on the second page of the rules: read.
  w = front(); w.ruleFiller = 1;
  assert.equal((await w.run()).result, 'none'); assert.deepEqual(w.brought(), []);
  w = scene0823(); w.ruleFiller = 9;
  assert.equal((await w.run()).pr, 1156, 'ten pages are read');
  // More rules than ten pages: the list is not known to be complete.
  w = front(); w.ruleFiller = 10;
  r = await w.run();
  assert.equal(r.result, 'skipped', JSON.stringify(r)); assert.match(r.reason, /rules/); assert.deepEqual(w.brought(), []);
  w = scene0823(); w.ruleFiller = 10;
  r = await w.run();
  assert.equal(r.result, 'skipped', JSON.stringify(r)); assert.deepEqual(w.brought(), []);
  // More open pull requests than ten pages: the train is not known in full.
  w = scene0823(); w.endless = true;
  r = await w.run();
  assert.equal(r.result, 'skipped', JSON.stringify(r)); assert.match(r.reason, /pull requests/); assert.deepEqual(w.brought(), []);
});

// The first link (design step 0): merge-main needs the gate's admitted=true. The gate admits these events without reading anything.
test('the admission gate admits this workflow on a push to main, on the schedule and on a dispatch without inputs', async () => {
  for (const [eventName, event] of [['push', { ref: 'refs/heads/main', after: T }], ['schedule', { schedule: '*/10 * * * *' }],
    ['workflow_dispatch', { inputs: null }], ['workflow_dispatch', { inputs: { pr: '', head: '' } }], ['workflow_dispatch', { inputs: { pr: '1225', head: H } }]]) {
    const calls = [];
    const outcome = await gate({ env: env({ GITHUB_EVENT_NAME: eventName, GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main', GITHUB_SHA: T, GITHUB_RUN_ATTEMPT: '1',
      GITHUB_WORKFLOW_REF: 'o/r/.github/workflows/clued-front-main-merge.yml@refs/heads/main', CLUED_ADMISSION_GATE_SOURCE: 'independent-ci-native-work-admission' }),
      event, eventName, fetchImpl: async url => { calls.push(String(url)); throw new Error('the gate reads nothing for this event'); }, sleep: async () => {} });
    assert.equal(outcome.admitted, true, `${eventName}: ${JSON.stringify(outcome.reasons)}`);
    assert.equal(outcome.verdict, 'NOT_APPLICABLE', eventName);
    assert.deepEqual(calls, [], eventName);
  }
});

// Second review of c1062091: statuses and workflow runs were read one page of 100. With more on one head and the one still
// under way beyond the first page, the front was judged idle early and one more pull request was brought up.
test('what is under way on the front is read to the end: beyond 100 statuses or workflow runs, and nothing is decided beyond ten pages', async () => {
  // The front: contains main for 20 minutes, required checks not green yet; whether it is idle hangs on what is still under way.
  const front = () => {
    const w = scene0823();
    Object.assign(w.heads.get(sha(0x1225)), { contains: T, at: w.now - 20 * MIN, statuses: [] }); w.prs.get(1225).updatedAt = w.now - 20 * MIN;
    return w;
  };
  let w = front();
  assert.deepEqual([(await w.run()).result, w.brought()], ['merged', [1156]], 'with nothing under way it is idle');
  // 100 finished workflow runs, then the one still running.
  w = front();
  w.heads.get(sha(0x1225)).runs = [...Array.from({ length: 100 }, (_, i) => ({ id: i + 1, status: 'completed', conclusion: 'success' })), { id: 101, status: 'in_progress', conclusion: null }];
  let r = await w.run();
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.deepEqual(w.brought(), []);
  // 100 settled statuses, then the resident's pending one.
  w = front();
  w.heads.get(sha(0x1225)).statuses = [...Array.from({ length: 100 }, (_, i) => ({ context: `info-${i}`, state: 'success', description: '' })),
    { context: 'resident-queue/turing', state: 'pending', description: '排队中' }];
  r = await w.run();
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.deepEqual(w.brought(), []);
  // Exactly ten pages are read to the end; one more than ten pages is not known in full.
  for (const [list, make] of [['runs', i => ({ id: i + 1, status: 'completed', conclusion: 'success' })], ['statuses', i => ({ context: `info-${i}`, state: 'success', description: '' })]]) {
    w = front(); w.heads.get(sha(0x1225))[list] = Array.from({ length: 1000 }, (_, i) => make(i));
    assert.deepEqual([(await w.run()).result, w.brought()], ['merged', [1156]], `${list}: ten full pages, all settled, idle`);
    w = front(); w.heads.get(sha(0x1225))[list] = Array.from({ length: 1001 }, (_, i) => make(i));
    r = await w.run();
    assert.equal(r.result, 'skipped', `${list}: ${JSON.stringify(r)}`); assert.deepEqual(w.brought(), [], list);
  }
});

// The hosted copy (framework v1 §2.3, hosted scaffold report §1.4, Decision 85effa31). While the hosted scaffold ruleset is in force
// (#292 disabled) GitHub's auto-merge lands with strict on and nobody brings the next front up: this copy does, with the same entry.
const HOSTED = ['hosted-ci-suites', 'hosted-clued-cloud-tests', 'hosted-migration-verify', 'hosted-ci-suites-windows', 'hosted-gitleaks',
  'hosted-trivy', 'hosted-contract-placement'];
const FRAMEWORK = ['gitleaks', 'trivy', INDEPENDENT_ADMISSION_CHECK, 'kooyumi-admission-verified', 'kooyumi-merge-slot', 'contract-placement'];
// main's rules in force: 'framework' (#292 only, today), 'scaffold' (the scaffold ruleset only), 'both' (the trial switch), 'loose' (unpinned).
function rulesOf(w, phase) {
  w.pins = {};
  if (phase === 'framework') for (const name of FRAMEWORK) w.pins[name] = INDEPENDENT_ADMISSION_APP_ID;
  if (phase === 'scaffold' || phase === 'loose') for (const name of HOSTED) w.pins[name] = phase === 'loose' ? undefined : GITHUB_ACTIONS_APP_ID;
  // The scaffold ruleset's eighth check is the clued-admission App's kooyumi-admission-verified (scaffold open-qs 1.3: App 5164952
  // never posts a check named kooyumi-work-admission; that is the job name of its workflow, a GitHub Actions check).
  if (phase === 'scaffold') w.pins[APP_CHECK_NAME] = ADMISSION_APP_ID;
  // The trial switch (S7) is both rulesets as they are: #292's six of App 5368905 (kooyumi-admission-verified among them, its
  // merge-slot control), the scaffold's seven hosted- of GitHub Actions and kooyumi-admission-verified of App 5164952. One name, two pins.
  w.required = phase === 'framework' ? FRAMEWORK : phase === 'both' ? BOTH : [...HOSTED, APP_CHECK_NAME];
  return w;
}
const BOTH = [...FRAMEWORK.map(context => ({ context, integration_id: INDEPENDENT_ADMISSION_APP_ID })),
  ...HOSTED.map(context => ({ context, integration_id: GITHUB_ACTIONS_APP_ID })), { context: APP_CHECK_NAME, integration_id: ADMISSION_APP_ID }];
const SCAFFOLD = { CLUED_FRONT_MERGE_PHASE: 'scaffold' };

function scene1344({ hostedChecks = HOSTED } = {}) {
  const w = train();
  w.now = Date.parse('2026-11-25T12:20:43Z');
  w.required = SCAFFOLD_R6;
  w.tip = '2c8197ebac8b81cfc0c68d6695c842e4ba6bf4b5';
  const head = 'a8cb467661c35b0e81033a89feceb5d14312b00a';
  const parent = 'cf361dec2b8e403d4ebd826793298ac989414df5';
  const later = 'a5dce4192d59565843361fb77451d600aae97c5b';
  w.open(1344, { head, behind: 25, parents: [parent, BASE], auto: '2026-11-25T09:26:28Z' });
  w.head(parent);
  for (const sha of [head, parent]) w.check(sha, MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID);
  for (const name of hostedChecks) w.check(head, name);
  w.heads.get(head).statuses.push({ context: 'resident-queue/turing (info only)', state: 'pending', description: residentSays(25) });
  w.open(1349, { head: later, contains: w.tip, auto: '2026-11-25T10:00:00Z' });
  w.heads.get(later).runs.push({ status: 'in_progress' });
  w.open(1350, { head: '678dbce8c6d55c03f6fc2e6aad9640e53a6b614f', behind: 25, auto: '2026-11-25T11:00:00Z' });
  return w;
}

test('3576b29c: #1344 with green hosted checks gets main before the later #1349, even after two updates', async () => {
  const w = scene1344();
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'merged', JSON.stringify(r));
  assert.deepEqual(w.brought(), [1344]);
  assert.equal(r.main_sha, w.tip);
  assert.equal(w.heads.get(w.headOf(1344)).checks.some(check => check.name === MAIN_MERGE_CHECK), true);
});

test('3576b29c: the third update needs all hosted checks green when admission is missing', async () => {
  const green = scene1344();
  const refreshed = await green.run({}, SCAFFOLD);
  assert.equal(refreshed.result, 'merged', statesOf(refreshed));
  assert.deepEqual(green.brought(), [1344]);

  const missing = scene1344({ hostedChecks: HOSTED.slice(1) });
  const blocked = await missing.run({}, SCAFFOLD);
  assert.equal(blocked.result, 'none', statesOf(blocked));
  assert.deepEqual(missing.brought(), []);
  assert.match(blocked.train.members.find(m => m.pr === 1344).state, /连带 2 次仍未通过，不再带$/);
});

test('3576b29c: the earlier safe and green candidate wins if all eight required checks passed', async () => {
  const w = scene1344();
  w.check(w.headOf(1344), INDEPENDENT_ADMISSION_CHECK, 'success', INDEPENDENT_ADMISSION_APP_ID);
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'merged', JSON.stringify(r));
  assert.deepEqual(w.brought(), [1344]);
});

test('3576b29c: the hosted copy annotates none with the reason and runs no branch update', async t => {
  const w = scene1344();
  w.prs.get(1344).mergeable = 'CONFLICTING';
  t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  assert.equal(await frontMergeMain(env({ ...SCAFFOLD, GITHUB_WORKSPACE: ROOT }), w.fetchImpl,
    { now: () => w.now, sleep: async () => {} }, []), 0);
  assert.deepEqual(w.brought(), []);
  assert.match(error.mock.calls.map(call => call.arguments[0]).join('\n'), /::notice .*none: #1349 contains main and is under way.*#1344.*conflict/);
});

const frameworkRequiredWorkflows = ['clued-required-tests.yml', 'clued-required-tests-windows.yml'];
const requiredWorkflow = file => fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
const concurrencyLine = (source, key) =>
  new RegExp(`^  ${key}: .+$`, 'm').exec(/^concurrency:\n(?:[ \t].*\n)*/m.exec(source)?.[0] ?? '')?.[0];
const cancelOnPr = "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}";

test('Q1: 树复用的 ancestry 工作流不触发 closed', () => {
  const ancestryWorkflows = Object.keys(TARGETS).filter(file => TARGETS[file].proof === 'ancestry');
  const closedWorkflows = ancestryWorkflows.filter(file => {
    const source = requiredWorkflow(file).replace(/\s+#.*$/gm, '');
    const triggers = /^on:\n(?:[ \t].*\n|\n)*/m.exec(source)?.[0] ?? '';
    const pullRequest = /^  ['"]?pull_request['"]?:[^\n]*(?:\n {4}[^\n]*)*/m.exec(triggers);
    assert.ok(pullRequest, `${file} 必须在 on 下声明 pull_request`);
    const types = /(?:^ {4}|[{,][ \t]*)['"]?types['"]?:\s*(\[[^\]]*\]|(?:-[^\n]+(?:\n[ \t]+-[^\n]+)*))/m.exec(pullRequest[0])?.[1];
    return /(?:^|[\s[,'"])closed(?=$|[\s\],'"])/.test(types ?? '');
  });
  assert.deepEqual(closedWorkflows, [], '树复用按 run_number 取该 head 最新的 PR 运行；closed 运行建在合入之后，会被当成最新运行，甲2 的让位就走不到');
});

test('Q2: 框架门没有作业级 if，并发组和 PR 取消条件符合约定', () => {
  const sources = frameworkRequiredWorkflows.map(requiredWorkflow);
  const group = "(github.ref == 'refs/heads/clued-train/staging' && github.sha) || github.ref }}";
  assert.deepEqual(sources.map(source => concurrencyLine(source, 'group')), [
    '  group: ${{ github.workflow }}-${{ github.event.pull_request.number || inputs.pr || ' + group,
    '  group: ${{ github.workflow }}-${{ github.event.pull_request.number || ' + group,
  ]);
  assert.deepEqual(sources.map(source => {
    const gateJob = admission.workflowJobs(source).find(job => job.name === 'admission-gate');
    assert.ok(gateJob, '框架工作流必须有 admission-gate');
    return {
      gateHasIf: gateJob.lines.some(line => /^    ['"]?if['"]?:/.test(line)),
      cancel: concurrencyLine(source, 'cancel-in-progress'),
    };
  }), frameworkRequiredWorkflows.map(() => ({ gateHasIf: false, cancel: cancelOnPr })));
});

test('R3: hosted-required still cancels PR runs and skips all jobs on close', () => {
  const source = requiredWorkflow('hosted-required.yml');
  assert.match(source, /^  group: \$\{\{ github.workflow \}\}-\$\{\{ github.event.pull_request.number \|\| /m);
  assert.equal(concurrencyLine(source, 'cancel-in-progress'), cancelOnPr);
  assert.match(source.slice(source.indexOf('\non:\n'), source.indexOf('\npermissions:')), /^  pull_request:\n    types: \[opened, synchronize, reopened, closed\]/m);
  const jobs = [...source.split('\njobs:\n')[1].matchAll(/^  ([a-z0-9-]+):\n([\s\S]*?)(?=^  [a-z0-9-]+:\n|(?![\s\S]))/gm)];
  assert.ok(jobs.length > 1);
  for (const [, id, job] of jobs) {
    assert.match(job, /^    if: (?:always\(\) && )?github.event.action != 'closed'$/m, id);
  }
});

const minted = w => w.calls.filter(c => c.route?.startsWith('/app/installations/')).length;
const phaseOutput = async (w) => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMPDIR ?? '.', 'front-merge-phase-'));
  try {
    const output = path.join(dir, 'output'), summary = path.join(dir, 'summary.md');
    fs.writeFileSync(output, ''); fs.writeFileSync(summary, '');
    // The first job holds no App key.
    const { CLUED_ADMISSION_APP_ID: _id, CLUED_ADMISSION_APP_PRIVATE_KEY: _key, ...keyless } = env({ GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary });
    const code = await frontMergeMain(keyless, w.fetchImpl, {}, ['--phase']);
    return { code, output: fs.readFileSync(output, 'utf8'), summary: fs.readFileSync(summary, 'utf8') };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test('hosted copy: while the scaffold ruleset is not in force it changes nothing, named or not, and holds no App token', async () => {
  for (const phase of ['framework', 'both', 'loose']) {
    const w = rulesOf(scene0823(), phase);
    for (const input of [{}, { pr: '1156', head: sha(0x1156) }]) {
      const r = await w.run(input, SCAFFOLD);
      assert.equal(r.result, 'none', `${phase} ${JSON.stringify(r)}`);
      assert.match(r.reason, phase === 'both' ? /#292 in force/ : /not in force/);
    }
    assert.deepEqual(w.brought(), [], phase); assert.equal(minted(w), 0, `${phase}: no App token`);
    assert.equal(w.calls.filter(c => c.method !== 'GET').length, 0, `${phase}: reads only`); assert.deepEqual(w.comments, []);
    const out = await phaseOutput(w);
    assert.equal(out.code, 0); assert.equal(out.output, 'in_force=false\n', phase); assert.match(out.summary, /not in force/);
  }
  // The rules cannot be read: nothing is decided, nothing is changed.
  const w = rulesOf(scene0823(), 'scaffold');
  w.failing = '/rules/branches/main';
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'skipped', JSON.stringify(r)); assert.deepEqual(w.brought(), []); assert.equal(minted(w), 0);
  assert.equal((await phaseOutput(w)).output, 'in_force=false\n');
  // Another phase value is not a switch that could be on.
  assert.equal((await rulesOf(scene0823(), 'scaffold').run({}, { CLUED_FRONT_MERGE_PHASE: 'always' })).result, 'refused');
  // Without the phase (the self-hosted workflow) the train path is as before: the same scene is brought up.
  const before = rulesOf(scene0823(), 'framework');
  assert.equal((await before.run()).result, 'merged'); assert.deepEqual(before.brought(), [1156]); assert.deepEqual(before.comments, []);
});

test('hosted copy: with the scaffold ruleset in force only the pull request about to be the front gets main, and the new head is named for DESK', async () => {
  const w = rulesOf(scene0823(), 'scaffold');
  assert.equal((await phaseOutput(w)).output, 'in_force=true\n');
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.deepEqual(w.brought(), [1156], 'one pull request, the first enabled');
  const { to } = w.updates[0];
  assert.equal(r.merged_head_sha, to);
  assert.equal(w.calls.filter(c => c.method === 'PUT').length, 1, 'one update-branch, no other write to the branch');
  // GitHub's merge of main into the head: two parents, the head first; no rebase, no force push.
  assert.deepEqual(w.heads.get(to).parents, [sha(0x1156), w.tip]);
  // The pending authorization on the pull request and in the summary; nothing authorizes it here.
  assert.deepEqual(w.comments.map(c => [c.pr, c.body.split('\n')[0], c.app]), [[1156, `新 head ${to}，待补授权`, true]]);
  assert.equal(pendingAuthorizationLine(to), `新 head ${to}，待补授权`);
  const summary = renderSummary(r);
  assert.match(summary, new RegExp(`#1156 新 head ${to}，待补授权（PR 评论 posted）`), summary);
  assert.equal(w.calls.some(c => /rpc|authoriz/i.test(c.route ?? '')), false, 'no authorization call');
  // Now the front contains main and is under way: the next run (a push, the schedule) leaves the train as it is.
  const again = await w.run({}, SCAFFOLD);
  assert.equal(again.result, 'none', JSON.stringify(again)); assert.match(again.reason, /#1156 contains main and is under way/);
  assert.deepEqual(w.brought(), [1156]); assert.equal(w.comments.length, 1);
  // A comment GitHub refuses is reported; the merge stands.
  const refused = rulesOf(scene0823(), 'scaffold'), fetch = refused.fetchImpl;
  refused.fetchImpl = async (url, init = {}) => String(url).endsWith('/issues/1156/comments')
    ? { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}), text: async () => '' } : fetch(url, init);
  const r2 = await refused.run({}, SCAFFOLD);
  assert.equal(r2.result, 'merged'); assert.equal(r2.comment, 'not posted (HTTP 403)');
  assert.match(renderSummary(r2), /待补授权（PR 评论 not posted \(HTTP 403\)）/);
  // A network failure while posting the comment, or while minting its token, is only reported too: a helper that fails
  // does nothing; it never turns the merge run red.
  const offline = rulesOf(scene0823(), 'scaffold'), fetch3 = offline.fetchImpl;
  offline.fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/issues/1156/comments')) throw new TypeError('fetch failed');
    return fetch3(url, init);
  };
  const r3 = await offline.run({}, SCAFFOLD);
  assert.equal(r3.result, 'merged', JSON.stringify(r3)); assert.equal(r3.pending_authorization, true);
  assert.equal(r3.comment, 'not posted (fetch failed)');
  assert.match(renderSummary(r3), /待补授权（PR 评论 not posted \(fetch failed\)）/);
  const tokenless = rulesOf(scene0823(), 'scaffold'), fetch4 = tokenless.fetchImpl;
  let merged = false;
  tokenless.fetchImpl = async (url, init = {}) => {
    if ((init.method ?? 'GET') === 'PUT' && /\/update-branch$/.test(String(url))) merged = true;
    if (merged && /\/installation$/.test(String(url))) throw new TypeError('fetch failed');
    return fetch4(url, init);
  };
  const r4 = await tokenless.run({}, SCAFFOLD);
  assert.equal(r4.result, 'merged', JSON.stringify(r4)); assert.equal(r4.comment, 'not posted (fetch failed)');
});

test('hosted copy: the admission that counts is the one the rules in force pin', async () => {
  // A head the App brought up earlier, admitted by the scaffold's admission App 5164952 only: brought again under the scaffold.
  let w = rulesOf(scene0823(), 'scaffold');
  w.check(sha(0x1156), MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID); w.check(sha(0x1156), APP_CHECK_NAME, 'success', ADMISSION_APP_ID);
  assert.equal((await w.run({}, SCAFFOLD)).pr, 1156);
  // Admitted only by the independent CI (its shadow): under the scaffold that is not the admission, so it is passed over.
  w = rulesOf(scene0823(), 'scaffold');
  w.check(sha(0x1156), MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID); w.check(sha(0x1156), INDEPENDENT_ADMISSION_CHECK, 'success', INDEPENDENT_ADMISSION_APP_ID);
  assert.equal((await w.run({}, SCAFFOLD)).pr, 1217);
  // And under #292 the other way round, as before.
  w = rulesOf(scene0823(), 'framework');
  w.check(sha(0x1156), MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID); w.check(sha(0x1156), APP_CHECK_NAME, 'success', ADMISSION_APP_ID);
  assert.equal((await w.run()).pr, 1217);
});

test('hosted copy: a merge conflict stops it for that pull request and is reported, never retried', async () => {
  // Named: update-branch refuses (422), one attempt, nothing else is written, the run says why.
  let w = rulesOf(scene0823(), 'scaffold');
  w.prs.get(1156).mergeable = 'CONFLICTING';
  let r = await w.run({ pr: '1156', head: sha(0x1156) }, SCAFFOLD);
  assert.equal(r.result, 'refused', JSON.stringify(r)); assert.match(r.reason, /HTTP 422: merge conflict/);
  assert.equal(w.calls.filter(c => c.method === 'PUT').length, 1); assert.deepEqual(w.brought(), []); assert.deepEqual(w.comments, []);
  assert.equal(w.calls.filter(c => c.method === 'POST' && c.route === '/repos/o/r/check-runs').length, 0);
  assert.match(renderSummary(r), /\*\*refused\*\*: update-branch answered HTTP 422/);
  // Chosen: a conflict GitHub reports is not attempted; one it has not computed yet is attempted once, then the next in order.
  w = rulesOf(scene0823(), 'scaffold');
  w.prs.get(1156).mergeable = 'CONFLICTING';
  r = await w.run({}, SCAFFOLD);
  assert.equal(r.pr, 1217); assert.equal(w.calls.filter(c => c.method === 'PUT' && c.route.includes('/1156/')).length, 0);
  assert.match(renderSummary(r), /#1156 .*conflict/);
  w = rulesOf(scene0823(), 'scaffold');
  const fetch = w.fetchImpl;
  let attempts = 0;
  w.fetchImpl = async (url, init = {}) => (init.method === 'PUT' && String(url).endsWith('/pulls/1156/update-branch') && ++attempts)
    ? { ok: false, status: 422, headers: { get: () => null }, json: async () => ({ message: 'merge conflict between base and head' }), text: async () => '' } : fetch(url, init);
  w.prs.get(1156).mergeable = 'UNKNOWN';
  r = await w.run({}, SCAFFOLD);
  assert.equal(attempts, 1, 'tried once, not again');
  assert.match(renderSummary(r), /#1156 .*refused: update-branch answered HTTP 422: merge conflict/);
  assert.deepEqual(w.comments.map(c => c.pr), [1217]);
});

test('hosted copy: the workflow runs the same entry on a hosted machine, only from main, the App key only after the phase', () => {
  const read = file => fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
  const text = read('clued-front-main-merge-hosted.yml'), original = read('clued-front-main-merge.yml');
  const on = text.slice(text.indexOf('\non:\n'), text.indexOf('\npermissions:\n'));
  // The same triggers and inputs as the self-hosted workflow, and hosted-required completing (§3.3, PLAN-train-held-deadlock).
  assert.equal(on.replace('\n  workflow_run:\n    workflows: [hosted-required]\n    types: [completed]\n', '\n'),
    original.slice(original.indexOf('\non:\n'), original.indexOf('\npermissions:\n')), 'the self-hosted triggers and inputs, and workflow_run');
  assert.doesNotMatch(on, /pull_request/);
  const jobs = text.slice(text.indexOf('\njobs:\n'));
  const [phase, merge] = jobs.split('\n  merge-main:\n');
  assert.equal((jobs.match(/\n    runs-on: ubuntu-slim\n/g) ?? []).length, 2, 'both jobs on a GitHub-hosted machine');
  const uncommented = part => part.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(uncommented(jobs), /self-hosted/);
  assert.match(phase, /\n        run: node scripts\/ci\/clued-front-main-merge\.mjs --phase\n/);
  assert.doesNotMatch(phase, /secrets\.|environment:/, 'the phase job has no App key');
  assert.match(merge, /^    needs: scaffold-phase\n    if: needs\.scaffold-phase\.outputs\.in_force == 'true' && github\.ref == 'refs\/heads\/main'\n/);
  assert.match(merge, /\n    environment: clued-admission\n/);
  assert.match(merge, /\n          CLUED_FRONT_MERGE_PHASE: scaffold\n/);
  assert.match(merge, /\n        run: node scripts\/ci\/clued-front-main-merge\.mjs\n/, 'the same entry as the self-hosted workflow');
  assert.match(original, /\n        run: node scripts\/ci\/clued-front-main-merge\.mjs\n/);
  // Each copy has its own group (task 2fb32dc7): the copies take turns by phase, not by a group, so the self-hosted no-op that
  // waits for a Linux node during the scaffold can neither hold the hosted copy back nor push its waiting run out.
  assert.match(merge, /\n    concurrency:\n      group: clued-front-main-merge-hosted\n      cancel-in-progress: false\n/, 'one at a time within the hosted workflow');
  assert.match(original, /\n      group: clued-front-main-merge\n/);
  assert.notEqual(mergeMainGroup(text), mergeMainGroup(original), 'the two copies never share a group');
  // Default-branch code, no credential left in the checkout, nothing written with this run's token, no push of any kind.
  assert.equal((jobs.match(/\n          ref: \$\{\{ github\.event\.repository\.default_branch \|\| 'main' \}\}\n          persist-credentials: false\n/g) ?? []).length, 2);
  const code = text.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(code, /: write\b|git push|rebase|--force|CLUED_ADMISSION_CLUED_TOKEN|CLUED_CONTEXT_READ_TOKEN/);
});

// The concurrency group of a workflow's merge-main job, read from the file.
function mergeMainGroup(text) {
  const found = text.slice(text.indexOf('\n  merge-main:\n')).match(/\n    concurrency:\n      group: ([^\n#]+)\n/);
  assert.ok(found, 'merge-main has a literal concurrency group');
  return found[1].trim();
}

// GitHub's concurrency group: one request runs, one waits, and a new waiting request cancels the one already waiting. Each
// request holds its group for `holds` seconds once it gets it. Returns, per request, when it got its group or who cancelled it.
function replayConcurrency(requests, groupOf) {
  const groups = new Map(), outcome = new Map();
  const advance = (group, now) => {
    while (group.running && group.running.end <= now) {
      const next = group.waiting, start = group.running.end;
      group.running = null, group.waiting = null;
      if (next) { outcome.set(next.id, { started: start }); group.running = { id: next.id, end: start + next.holds }; }
    }
  };
  for (const request of [...requests].sort((a, b) => a.at - b.at)) {
    const name = groupOf(request.copy);
    if (!groups.has(name)) groups.set(name, { running: null, waiting: null });
    const group = groups.get(name);
    advance(group, request.at);
    if (!group.running) {
      outcome.set(request.id, { started: request.at });
      group.running = { id: request.id, end: request.at + request.holds };
      continue;
    }
    if (group.waiting) outcome.set(group.waiting.id, { cancelledBy: request.id });
    group.waiting = request;
  }
  for (const group of groups.values()) advance(group, Infinity);
  return outcome;
}

// Task 2fb32dc7 (PLAN-front-bot-concurrency-20261125 §4 T3): the night of 11-25 (Beijing) from the cancelled-run diagnosis. At
// 02:56:53 the self-hosted copy's merge-main (a no-op during the scaffold) took the group and waited for a Linux node until
// 03:14:14; every self-hosted request after it waits as long. A hosted run holds the group about a minute (28-80 s before 02:55).
test('replay of 11-25 02:56: each copy has its own group, so no hosted request waits behind or is cancelled by the self-hosted no-op', () => {
  const read = file => fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
  const groups = { hosted: mergeMainGroup(read('clued-front-main-merge-hosted.yml')), 'self-hosted': mergeMainGroup(read('clued-front-main-merge.yml')) };
  const at = clock => { const [h, m, s] = clock.split(':').map(Number); return h * 3600 + m * 60 + s; };
  const SELF_HOLDS = at('03:14:14') - at('02:56:53'), HOSTED_HOLDS = 60;
  const night = [
    ['45460908558', 'self-hosted', '02:56:53'], ['45464948504', 'hosted', '02:57:21'], ['45462209918', 'self-hosted', '03:00:24'],
    ['45465890520', 'hosted', '03:02:49'], ['45463563123', 'self-hosted', '03:05:50'], ['45466539575', 'hosted', '03:06:09'],
    ['45467487837', 'hosted', '03:11:31'], ['45463925866', 'self-hosted', '03:12:20'],
  ].map(([id, copy, clock]) => ({ id, copy, at: at(clock), holds: copy === 'hosted' ? HOSTED_HOLDS : SELF_HOLDS }));
  // The model is the one GitHub ran that night: one shared group gives exactly the recorded cancellations.
  const shared = replayConcurrency(night, () => 'one group');
  assert.deepEqual(Object.fromEntries([...shared].filter(([, o]) => o.cancelledBy)), {
    45464948504: { cancelledBy: '45462209918' }, 45462209918: { cancelledBy: '45465890520' },
    45465890520: { cancelledBy: '45463563123' }, 45463563123: { cancelledBy: '45466539575' },
    45466539575: { cancelledBy: '45467487837' }, 45467487837: { cancelledBy: '45463925866' },
  });
  assert.deepEqual(shared.get('45463925866'), { started: at('03:14:14') });
  // The groups the two workflow files name: every hosted request runs or is cancelled by another hosted one, never by the
  // self-hosted copy, and the first hosted request runs within a minute of asking.
  const replay = replayConcurrency(night, copy => groups[copy]);
  const copyOf = new Map(night.map(r => [r.id, r.copy]));
  for (const request of night.filter(r => r.copy === 'hosted')) {
    const o = replay.get(request.id);
    assert.ok(o, `hosted ${request.id} has an outcome`);
    if (o.cancelledBy) assert.equal(copyOf.get(o.cancelledBy), 'hosted', `hosted ${request.id} cancelled by the self-hosted ${o.cancelledBy}`);
    else assert.ok(o.started >= request.at, `hosted ${request.id} started`);
  }
  const first = night.find(r => r.copy === 'hosted');
  assert.ok(replay.get(first.id).started !== undefined && replay.get(first.id).started - first.at <= 60,
    `the first hosted request runs within 60 s of asking: ${JSON.stringify(replay.get(first.id))}`);
});

// FABLE-scaffold-s5-pre §3: the clued-admission App 5164952 had no workflows permission, so update-branch answered 403 for every
// candidate once main changed a workflow file and nobody was brought up. The token asks for workflows: write exactly when the
// installation has it (read from the installation, so the code may land before or after the Owner grants it).
const WORKFLOW_403 = 'refusing to allow a GitHub App to create or update workflow `.github/workflows/x.yml` without `workflows` permission';
function mainChangedAWorkflow(w, installed) {
  const fetch = w.fetchImpl;
  w.minted = [];
  w.fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET', route = String(url).slice(API.length), body = init.body ? JSON.parse(init.body) : null;
    const reply = (b, status) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => b, text: async () => JSON.stringify(b) });
    if (method === 'GET' && route === '/repos/o/r/installation') { w.calls.push({ method, route, body }); return reply({ id: 42, permissions: installed }, 200); }
    if (method === 'POST' && route === '/app/installations/42/access_tokens') w.minted.push(body.permissions);
    // main changed a workflow file: GitHub merges it into the branch only with a token that holds workflows: write.
    if (method === 'PUT' && /\/update-branch$/.test(route) && w.minted.at(-1)?.workflows !== 'write') { w.calls.push({ method, route, body }); return reply({ message: WORKFLOW_403 }, 403); }
    return fetch(url, init);
  };
  return w;
}
const BASE_PERMISSIONS = { checks: 'write', contents: 'write', pull_requests: 'write', metadata: 'read' };

test('§3: with workflows in the installation the token asks for it, and a main that changed a workflow file is still brought in', async () => {
  const w = mainChangedAWorkflow(scene0823(), { ...BASE_PERMISSIONS, workflows: 'write' });
  const r = await w.run();
  assert.deepEqual(w.minted, [{ contents: 'write', pull_requests: 'write', checks: 'write', workflows: 'write' }]);
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.equal(r.pr, 1156); assert.deepEqual(w.brought(), [1156]);
});

test('§3: without workflows in the installation the token asks for the three as before; the 403 says why', async () => {
  const w = mainChangedAWorkflow(scene0823(), BASE_PERMISSIONS);
  const r = await w.run({ pr: '1156', head: sha(0x1156) });
  assert.deepEqual(w.minted, [{ contents: 'write', pull_requests: 'write', checks: 'write' }]);
  assert.equal(r.result, 'refused', JSON.stringify(r)); assert.deepEqual(w.brought(), []);
  assert.match(r.reason, /HTTP 403/); assert.match(r.reason, /main 改了工作流文件且 App 无 workflows 权限/);
  // An installation record without permissions at all (as the fakes above answer) mints the three, never fails.
  const bare = scene0823();
  assert.equal((await bare.run()).result, 'merged');
  assert.deepEqual(bare.calls.filter(c => c.route.endsWith('/access_tokens')).map(c => c.body.permissions), [{ contents: 'write', pull_requests: 'write', checks: 'write' }]);
});

// FABLE-scaffold-s5-pre §1: the self-hosted workflow (no CLUED_FRONT_MERGE_PHASE) and the hosted copy both brought fronts up while
// the scaffold ruleset was in force, and only the hosted one said "待补授权". The two are exclusive on the same fact (scaffoldInForce):
// the hosted copy while the scaffold ruleset is in force, the self-hosted one otherwise.
test('§1: without the phase (the self-hosted workflow) nothing is changed while the scaffold ruleset is in force, named or not', async () => {
  for (const input of [{}, { pr: '1156', head: sha(0x1156) }]) {
    const w = rulesOf(scene0823(), 'scaffold');
    const r = await w.run(input);
    assert.equal(r.result, 'none', JSON.stringify(r)); assert.match(r.reason, /脚手架规则集在用，由托管副本带车头/);
    assert.equal(w.calls.filter(c => c.method === 'PUT').length, 0, 'no update-branch');
    assert.equal(w.calls.filter(c => c.method === 'POST' && c.route === '/repos/o/r/check-runs').length, 0, 'no check');
    assert.deepEqual(w.comments, []); assert.equal(minted(w), 0, 'no App token');
  }
  // The rules cannot be read: nothing is changed, the next run looks again (as the hosted copy).
  const w = rulesOf(scene0823(), 'scaffold'); w.failing = '/rules/branches/main';
  for (const input of [{}, { pr: '1156', head: sha(0x1156) }]) {
    const r = await w.run(input);
    assert.equal(r.result, 'skipped', JSON.stringify(r)); assert.deepEqual(w.brought(), []); assert.equal(minted(w), 0);
  }
});

test('§1: in each state of the rules exactly one of the two copies brings the front up', async () => {
  for (const rules of ['framework', 'scaffold', 'both']) {
    const bringers = [];
    for (const [copy, extra] of [['self-hosted', {}], ['hosted', SCAFFOLD]]) {
      const w = rulesOf(scene0823(), rules);
      const r = await w.run({}, extra);
      if (r.result === 'merged') { assert.deepEqual(w.brought(), [1156], `${rules} ${copy}`); bringers.push(copy); }
      else { assert.equal(r.result, 'none', `${rules} ${copy}: ${JSON.stringify(r)}`); assert.deepEqual(w.brought(), [], `${rules} ${copy}`); }
    }
    assert.deepEqual(bringers, [rules === 'scaffold' ? 'hosted' : 'self-hosted'], rules);
  }
});

// FABLE-scaffold-s5-pre §2: a head the App brought up to main that the admission does not pass (a failure, or nothing at all) is not
// the front, so the next one is brought, and the next. The hold that stopped the train at 2 such heads is gone (PLAN-train-held-
// deadlock-20261125 §2.1): it counted heads with no way out and stopped the train until someone stepped in. Each run brings one;
// a head whose admission failed is not brought again (main does not change that), one never answered is, after the others.
const [A, B, C, D] = [2001, 2002, 2003, 2004];
function fourBehind(rules) {
  const w = rulesOf(train(), rules);
  [A, B, C, D].forEach((number, i) => w.open(number, { head: sha(number), auto: `2026-11-22T00:0${i}:00Z` }));
  return w;
}
// Runs without inputs, the clock on by `every` after each; whatever was brought up gets `onBrought` (what the admission did on it).
async function runs(w, count, extra, every, onBrought) {
  const results = [];
  for (let i = 0; i < count; i++) {
    const seen = w.updates.length;
    results.push(await w.run({}, extra));
    for (const u of w.updates.slice(seen)) onBrought(u.to);
    w.now += every;
  }
  return results;
}
// The admission each App posts: the independent CI's kooyumi-work-admission, the clued-admission App's kooyumi-admission-verified.
const admissionOf = app => (app === ADMISSION_APP_ID ? APP_CHECK_NAME : INDEPENDENT_ADMISSION_CHECK);
const failsAdmission = (w, app) => head => w.check(head, admissionOf(app), 'failure', app);
const hostedGreen = w => head => { for (const name of HOSTED) w.check(head, name); };

test('§2: brought-up heads the admission fails: each run brings the next one, never held; the failed ones are not brought again', async () => {
  for (const [rules, extra, app] of [['scaffold', SCAFFOLD, ADMISSION_APP_ID], ['framework', {}, INDEPENDENT_ADMISSION_APP_ID]]) {
    const w = fourBehind(rules);
    const results = await runs(w, 5, extra, 10 * MIN, failsAdmission(w, app));
    assert.deepEqual(results.map(r => r.result), ['merged', 'merged', 'merged', 'merged', 'none'], `${rules}: ${statesOf(results.at(-1))}`);
    assert.deepEqual(w.brought(), [A, B, C, D], rules);
    assert.equal(results[4].reason, 'no pull request on the train can be brought up now');
    for (const r of results) assert.doesNotMatch(`${r.reason} ${statesOf(r)} ${renderSummary(r)}`, /held/, rules);
  }
});

test('§2: brought-up heads the admission never answers: one brought per run, each once, never held', async () => {
  const w = fourBehind('scaffold');
  const results = await runs(w, 4, SCAFFOLD, 16 * MIN, hostedGreen(w));
  assert.deepEqual(results.map(r => r.result), ['merged', 'merged', 'merged', 'merged'], statesOf(results.at(-1)));
  assert.deepEqual(w.brought(), [A, B, C, D]);
});

test('§2: a brought head admitted after all is the front; once it merged, the next candidate is brought, not the failed ones', async () => {
  const w = fourBehind('scaffold');
  await runs(w, 3, SCAFFOLD, 10 * MIN, failsAdmission(w, ADMISSION_APP_ID));
  assert.deepEqual(w.brought(), [A, B, C]);
  // A's head is admitted after all (DESK authorized it; later the admission carries it) and its checks are green.
  w.check(w.headOf(A), APP_CHECK_NAME, 'success', ADMISSION_APP_ID); hostedGreen(w)(w.headOf(A));
  let r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.match(r.reason, /#2001 contains main and is under way/); assert.deepEqual(w.brought(), [A, B, C]);
  // GitHub merges A and main moves: B and C, whose admission failed, are not brought again; D is.
  w.merged(A); w.now += 10 * MIN;
  r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.equal(r.pr, D); assert.deepEqual(w.brought(), [A, B, C, D]);
  for (const n of [B, C]) assert.match(r.train.members.find(m => m.pr === n).state, /^red \(kooyumi-admission-verified\)$/, statesOf(r));
});

test('§2: one head the admission fails does not hold the train; the next one admitted is the front', async () => {
  const w = fourBehind('scaffold');
  await runs(w, 1, SCAFFOLD, 10 * MIN, failsAdmission(w, ADMISSION_APP_ID));
  await runs(w, 1, SCAFFOLD, 10 * MIN, head => { w.check(head, APP_CHECK_NAME, 'success', ADMISSION_APP_ID); hostedGreen(w)(head); });
  assert.deepEqual(w.brought(), [A, B]);
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.match(r.reason, /#2002 contains main and is under way/); assert.deepEqual(w.brought(), [A, B]);
});

// FABLE-scaffold-open-qs 问题 1 改法 3: the admission the rules pin is read under the name and App the rules give it. The scaffold
// ruleset's eighth check is kooyumi-admission-verified of App 5164952; a head that App admitted is admitted, not stranded.
test('scaffold open-qs 1.3: under the scaffold ruleset heads App 5164952 admitted (kooyumi-admission-verified) are not stranded', async () => {
  // A and B were brought up before and App 5164952 admitted both; then main moved on, so both are behind again.
  const w = fourBehind('scaffold');
  for (const n of [A, B]) { w.check(sha(n), MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID); w.check(sha(n), APP_CHECK_NAME, 'success', ADMISSION_APP_ID); }
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.equal(r.pr, A); assert.deepEqual(w.brought(), [A]);
  for (const n of [A, B]) assert.doesNotMatch(r.train.members.find(m => m.pr === n).state, /not admitted/, `#${n}`);
  // Its new head admitted by App 5164952 with the hosted checks green: the front, and nobody else is brought.
  w.check(w.headOf(A), APP_CHECK_NAME, 'success', ADMISSION_APP_ID); hostedGreen(w)(w.headOf(A));
  const again = await w.run({}, SCAFFOLD);
  assert.equal(again.result, 'none', JSON.stringify(again)); assert.match(again.reason, /#2001 contains main and is under way/);
});

// 改法 4: a check pinned to an App is read only from that App. Once both Apps post kooyumi-merge-slot (the legacy workflow enabled
// again), App 5164952's newer failure must not make #292's front red and bring the next one up.
test('scaffold open-qs 1.4: under #292 a newer same-name check of another App does not make the front red', async () => {
  const w = fourBehind('framework');
  w.heads.get(sha(A)).contains = w.tip;
  w.check(sha(A), 'gitleaks', null, INDEPENDENT_ADMISSION_APP_ID);   // under way
  w.check(sha(A), 'kooyumi-merge-slot', 'success', INDEPENDENT_ADMISSION_APP_ID);
  w.check(sha(A), 'kooyumi-merge-slot', 'failure', ADMISSION_APP_ID);   // newer, same name, another App
  const r = await w.run();
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.match(r.reason, /#2001 contains main and is under way/);
  assert.equal(r.train.members.find(m => m.pr === A).state, 'front');
  assert.equal(w.calls.filter(c => c.method === 'PUT').length, 0); assert.deepEqual(w.brought(), []);
});

// FABLE-scaffold-open-qs 问题 2 put a named run (the companion's dispatch or a person) through the hold. With the hold gone
// (PLAN-train-held-deadlock-20261125 §2.1) a named run reads no train: it brings up the pull request it names, as before.
const named = (w, number, extra = {}) => w.run({ pr: String(number), head: w.headOf(number) }, extra);
for (const [rules, extra, app] of [['framework', {}, INDEPENDENT_ADMISSION_APP_ID], ['scaffold', SCAFFOLD, ADMISSION_APP_ID]]) {
  test(`open-qs 2 (${rules}): with two brought-up heads not admitted a named run still brings its pull request up`, async () => {
    const w = fourBehind(rules);
    await runs(w, 2, extra, 10 * MIN, failsAdmission(w, app));
    assert.deepEqual(w.brought(), [A, B]);
    const from = w.calls.length;
    const r = await named(w, C, extra);
    assert.equal(r.result, 'merged', JSON.stringify(r));
    assert.deepEqual([r.pr, r.head_sha], [C, sha(C)]);
    assert.equal(w.calls.slice(from).filter(c => c.route === '/graphql').length, 0, 'the train is not read');
    assert.equal(w.calls.slice(from).filter(c => c.method === 'PUT').length, 1); assert.deepEqual(w.brought(), [A, B, C]);
  });
}

test('open-qs 2: named one after another, each brought head failing the admission, each is brought', async () => {
  const w = fourBehind('framework');
  const results = [];
  for (const n of [A, B, C, D]) {
    const seen = w.updates.length;
    results.push(await named(w, n));
    for (const u of w.updates.slice(seen)) failsAdmission(w, INDEPENDENT_ADMISSION_APP_ID)(u.to);
    w.now += 10 * MIN;
  }
  assert.deepEqual(results.map(r => r.result), ['merged', 'merged', 'merged', 'merged'], JSON.stringify(results.at(-1)));
  assert.equal(w.calls.filter(c => c.method === 'PUT').length, 4);
  assert.deepEqual(w.brought(), [A, B, C, D]);
});

test('open-qs 2: a named run does not need the train: the train unreadable, it brings its pull request up', async () => {
  const w = fourBehind('framework');
  w.failing = '/graphql';
  const r = await named(w, C);
  assert.equal(r.result, 'merged', JSON.stringify(r));
  assert.deepEqual([r.pr, r.head_sha], [C, sha(C)]); assert.deepEqual(w.brought(), [C]);
});

test('open-qs 2: with a brought head not admitted, or with a front under way, a named run brings its pull request up as before', async () => {
  // One brought-up head not admitted: below the limit.
  let w = fourBehind('framework');
  await runs(w, 1, {}, 10 * MIN, failsAdmission(w, INDEPENDENT_ADMISSION_APP_ID));
  let r = await named(w, C);
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.deepEqual(w.brought(), [A, C]);
  // Two, one of them admitted after all and the front: the named run brings its pull request up all the same.
  w = fourBehind('framework');
  await runs(w, 2, {}, 10 * MIN, failsAdmission(w, INDEPENDENT_ADMISSION_APP_ID));
  w.check(w.headOf(A), INDEPENDENT_ADMISSION_CHECK, 'success', INDEPENDENT_ADMISSION_APP_ID);
  w.check(w.headOf(A), 'gitleaks', null, INDEPENDENT_ADMISSION_APP_ID);
  r = await named(w, C);
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.deepEqual(w.brought(), [A, B, C]);
});

// FABLE-scaffold-gate-leak 改法 1: at the trial switch (S7) both rulesets are in force and each pins its own admission:
// kooyumi-work-admission of App 5368905 (#292) and kooyumi-admission-verified of App 5164952 (the scaffold). A head the App brought
// up is admitted only when every admission the rules require passed; the first one found does not stand for both.
const nativeAdmits = w => head => w.check(head, INDEPENDENT_ADMISSION_CHECK, 'success', INDEPENDENT_ADMISSION_APP_ID);
const appAdmits = (w, conclusion = 'success') => head => w.check(head, APP_CHECK_NAME, conclusion, ADMISSION_APP_ID);
const statesOf = r => JSON.stringify(r.train?.members.map(m => [m.pr, m.state]));
// Every required check of 'both' green but the scaffold's admission (App 5164952), which says nothing.
const bothGreenButTheApp = w => head => { for (const { context, integration_id } of BOTH) if (integration_id !== ADMISSION_APP_ID) w.check(head, context, 'success', integration_id); };

test('gate-leak 1: at the trial switch heads Native admits and App 5164952 fails are not admitted: the next one is brought each run', async () => {
  const w = fourBehind('both');
  const results = await runs(w, 4, {}, 10 * MIN, head => { nativeAdmits(w)(head); appAdmits(w, 'failure')(head); });
  assert.deepEqual(results.map(r => r.result), ['merged', 'merged', 'merged', 'merged'], statesOf(results.at(-1)));
  assert.deepEqual(w.brought(), [A, B, C, D]);
  // None of them is the front (the admission App 5164952 failed on each): red, not under way.
  for (const n of [A, B, C]) assert.match(results[3].train.members.find(m => m.pr === n).state, /^red \(kooyumi-admission-verified\)$/, statesOf(results[3]));
});

test('gate-leak 2: at the trial switch heads App 5164952 never answers are not admitted: idle, the next one is brought each run', async () => {
  const w = fourBehind('both');
  const results = await runs(w, 4, {}, 16 * MIN, bothGreenButTheApp(w));
  assert.deepEqual(results.map(r => r.result), ['merged', 'merged', 'merged', 'merged'], statesOf(results.at(-1)));
  assert.deepEqual(w.brought(), [A, B, C, D]);
  // idle (and, quiet 30 minutes, named once: §3.11), not under way
  for (const n of [A, B, C]) assert.match(results[3].train.members.find(m => m.pr === n).state, /^idle(; stalled: posted)?$/, statesOf(results[3]));
});

test('gate-leak 3: at the trial switch a named run brings its pull request up whatever the train holds', async () => {
  const w = fourBehind('both');
  await runs(w, 2, {}, 10 * MIN, head => { nativeAdmits(w)(head); appAdmits(w, 'failure')(head); });
  assert.deepEqual(w.brought(), [A, B]);
  const r = await named(w, C);
  assert.equal(r.result, 'merged', `${JSON.stringify({ result: r.result, reason: r.reason })} ${statesOf(r)}`);
  assert.deepEqual(w.brought(), [A, B, C]);
});

// 改法 2 (独审建议 3): a required check pinned to an App is read only from that App's check runs, never from a commit status of the
// same name (the merge-status API does not say who posted it). An unpinned one still reads both.
test('gate-leak 4: a failure status named like a pinned check does not make the front red', async () => {
  const w = fourBehind('framework');
  w.heads.get(sha(A)).contains = w.tip;
  w.check(sha(A), 'gitleaks', null, INDEPENDENT_ADMISSION_APP_ID);   // under way
  w.check(sha(A), 'kooyumi-merge-slot', 'success', INDEPENDENT_ADMISSION_APP_ID);
  w.heads.get(sha(A)).statuses.push({ context: 'kooyumi-merge-slot', state: 'failure', description: '' });
  const r = await w.run();
  assert.equal(r.train.members.find(m => m.pr === A).state, 'front', statesOf(r));
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.equal(w.calls.filter(c => c.method === 'PUT').length, 0);
});

test('gate-leak 5: success statuses named like pinned checks do not make a quiet front green: it is idle', async () => {
  const w = fourBehind('framework');
  w.heads.get(sha(A)).contains = w.tip;   // appeared 600 minutes ago, nothing under way
  w.check(sha(A), 'gitleaks', 'success', INDEPENDENT_ADMISSION_APP_ID);
  for (const context of FRAMEWORK) w.heads.get(sha(A)).statuses.push({ context, state: 'success', description: '' });
  const r = await w.run();
  assert.equal(r.train.members.find(m => m.pr === A).state, 'idle', statesOf(r));
  assert.equal(r.pr, B, JSON.stringify(r));
});

// Kept as they are (not more than the leak): the gate at the trial switch, by name and App, and unpinned statuses.
test('gate-leak kept: at the trial switch heads Native fails and App 5164952 admits are not admitted: red, the next one is brought', async () => {
  const w = fourBehind('both');
  const results = await runs(w, 4, {}, 10 * MIN, head => { failsAdmission(w, INDEPENDENT_ADMISSION_APP_ID)(head); appAdmits(w)(head); });
  assert.deepEqual(results.map(r => r.result), ['merged', 'merged', 'merged', 'merged'], statesOf(results.at(-1)));
  assert.deepEqual(w.brought(), [A, B, C, D]);
  for (const n of [A, B, C]) assert.match(results[3].train.members.find(m => m.pr === n).state, /^red \(kooyumi-work-admission\)$/, statesOf(results[3]));
});

test('gate-leak kept: at the trial switch a head both admissions pass is the front; nobody else is brought', async () => {
  const w = fourBehind('both');
  const results = await runs(w, 3, {}, 16 * MIN, head => { bothGreenButTheApp(w)(head); appAdmits(w)(head); });
  assert.deepEqual(results.map(r => r.result), ['merged', 'none', 'none'], statesOf(results.at(-1)));
  assert.match(results[2].reason, /#2001 contains main and is under way/);
  assert.deepEqual(w.brought(), [A]);
});

test('gate-leak kept: under #292 its kooyumi-admission-verified (App 5368905, merge-slot control) is not an admission', async () => {
  for (const conclusion of [null, 'failure']) {   // missing, or failed
    const w = fourBehind('framework');
    const results = await runs(w, 4, {}, 16 * MIN, head => { nativeAdmits(w)(head); if (conclusion) w.check(head, APP_CHECK_NAME, conclusion, INDEPENDENT_ADMISSION_APP_ID); });
    assert.deepEqual(results.map(r => r.result), ['merged', 'merged', 'merged', 'merged'], `${conclusion}: ${statesOf(results.at(-1))}`);
    for (const r of results) assert.doesNotMatch(statesOf(r), /not admitted/);
    assert.deepEqual(w.brought(), [A, B, C, D], String(conclusion));
  }
});

test('gate-leak kept: an unpinned required check still reads its status: a failure is red, a success is green', async () => {
  let w = fourBehind('loose');
  w.heads.get(sha(A)).contains = w.tip;
  w.heads.get(sha(A)).statuses.push({ context: 'hosted-ci-suites', state: 'failure', description: '' });
  let r = await w.run();
  assert.match(r.train.members.find(m => m.pr === A).state, /^red \(hosted-ci-suites\)$/, statesOf(r));
  assert.equal(r.pr, B);
  w = fourBehind('loose');
  w.heads.get(sha(A)).contains = w.tip;   // quiet for 600 minutes, green by its statuses alone
  for (const context of [...HOSTED, APP_CHECK_NAME]) w.heads.get(sha(A)).statuses.push({ context, state: 'success', description: '' });
  r = await w.run();
  assert.equal(r.train.members.find(m => m.pr === A).state, 'front', statesOf(r));
  assert.equal(r.result, 'none', JSON.stringify(r));
});

// FABLE-defect-remediation-plan-20261124 §3.1 (#1258): a red head behind main was passed over for good. Its red came from the
// pipeline (hosted-gitleaks against an old base), and once the fix was on main the head stayed red, behind and passed over from
// 11-23 18:32 on. A red head behind main that the App did not bring up is brought up once; a head the App brought that is red again
// is truly red and passed over as before.
function scene1258() {
  const w = rulesOf(train(), 'scaffold');
  w.open(1258, { head: sha(0x1258), auto: '2026-11-23T10:17:00Z' });
  for (const name of HOSTED) w.check(sha(0x1258), name, name === 'hosted-gitleaks' ? 'failure' : 'success');
  return w;
}

test('§3.1 #1258: red, behind main and alone on the train, it is brought up to main once; red again on that head, it is passed over', async () => {
  const w = scene1258();
  const first = await w.run({}, SCAFFOLD);
  assert.equal(first.result, 'merged', JSON.stringify(first)); assert.equal(first.pr, 1258); assert.deepEqual(w.brought(), [1258]);
  // The App's head runs everything and is red again: a true red. Nobody else is on the train; nothing is done.
  const made = w.headOf(1258);
  w.check(made, 'hosted-gitleaks', 'failure');
  w.now += 10 * MIN;
  let again = await w.run({}, SCAFFOLD);
  assert.equal(again.result, 'none', JSON.stringify(again)); assert.deepEqual(w.brought(), [1258]);
  // main moves on: the App's head is behind, red and never admitted. It is brought once more (main may carry a fix; PLAN-train-
  // held-deadlock §2.1); red again and behind again, two in a row the App brought: it stays, and says so.
  w.tip = sha(0x7258); w.now += 10 * MIN;
  again = await w.run({}, SCAFFOLD);
  assert.equal(again.result, 'merged', JSON.stringify(again)); assert.deepEqual(w.brought(), [1258, 1258]);
  w.check(w.headOf(1258), 'hosted-gitleaks', 'failure');
  w.tip = sha(0x7259); w.now += 10 * MIN;
  again = await w.run({}, SCAFFOLD);
  assert.equal(again.result, 'none', JSON.stringify(again)); assert.deepEqual(w.brought(), [1258, 1258]);
  assert.match(again.train.members.find(m => m.pr === 1258).state, /^red \(hosted-gitleaks\), not admitted on a head the App brought: 连带 2 次仍未通过，不再带$/, statesOf(again));
  // The self-hosted copy under #292 the same: the author's red head behind main is brought up once.
  const framework = rulesOf(train(), 'framework');
  framework.open(1258, { head: sha(0x1258), auto: '2026-11-23T10:17:00Z' });
  for (const name of FRAMEWORK) framework.check(sha(0x1258), name, name === 'gitleaks' ? 'failure' : 'success', INDEPENDENT_ADMISSION_APP_ID);
  const r = await framework.run();
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.deepEqual(framework.brought(), [1258]);
});

// 修订 6 (Decision c8c4d565): the scaffold ruleset's eighth check is kooyumi-work-admission pinned to App 5368905. The phase is read
// by the one rule that names the main ruleset (train-rules.mjs#sixPinned), not by "main requires some check of 5368905" (搁19).
const SCAFFOLD_R6 = [...HOSTED.map(context => ({ context, integration_id: GITHUB_ACTIONS_APP_ID })),
  { context: INDEPENDENT_ADMISSION_CHECK, integration_id: INDEPENDENT_ADMISSION_APP_ID }];

test('修订 6: the scaffold ruleset pinning kooyumi-work-admission to App 5368905 is in force; only the hosted copy brings the front up', async () => {
  const w = scene0823(); w.pins = {}; w.required = SCAFFOLD_R6;
  assert.equal((await phaseOutput(w)).output, 'in_force=true\n');
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.deepEqual(w.brought(), [1156]);
  const self = scene0823(); self.pins = {}; self.required = SCAFFOLD_R6;
  const s = await self.run();
  assert.equal(s.result, 'none', JSON.stringify(s)); assert.match(s.reason, /脚手架规则集在用，由托管副本带车头/); assert.deepEqual(self.brought(), []);
  // With #292 enabled as well (the trial switch) it is not in force: the self-hosted copy brings the front up.
  const both = scene0823(); both.pins = {}; both.required = [...SCAFFOLD_R6, ...BOTH];
  assert.equal((await phaseOutput(both)).output, 'in_force=false\n');
});

// FABLE-defect-remediation-plan-20261124 §3.11 item 3: a head on the train whose required checks are not all there, with nothing
// queued or running on it for 30 minutes, is named on its pull request once: which required checks are missing and how each last ended.
const STALLED = 1300;
function sceneStalled() {
  const w = rulesOf(train(), 'framework');
  const head = sha(0x1300);
  w.open(STALLED, { head, auto: '2026-11-24T01:00:00Z', contains: T, at: w.now - 40 * MIN });
  for (const name of FRAMEWORK.filter(n => n !== 'kooyumi-merge-slot' && n !== 'kooyumi-admission-verified'))
    w.check(head, name, 'success', INDEPENDENT_ADMISSION_APP_ID, { started_at: iso(w.now - 39 * MIN) });
  return w;
}
const namings = w => w.comments.filter(c => c.body.includes('clued-front-main-merge: stalled'));

test('§3.11: a head missing two required checks with nothing run for 40 minutes is named once on its pull request', async () => {
  const w = sceneStalled();
  const r = await w.run();
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.deepEqual(w.brought(), []);
  const named = namings(w);
  assert.equal(named.length, 1, JSON.stringify(w.comments));
  assert.equal(named[0].pr, STALLED); assert.equal(named[0].app, true, 'posted by the clued-admission App');
  assert.match(named[0].body, new RegExp(sha(0x1300)));
  assert.match(named[0].body, /kooyumi-merge-slot: missing/); assert.match(named[0].body, /kooyumi-admission-verified: missing/);
  assert.doesNotMatch(named[0].body, /gitleaks: /, 'a green required check is not listed');
  // The schedule 10 minutes later: the same head is not named again.
  w.now += 10 * MIN;
  await w.run();
  assert.equal(namings(w).length, 1, 'once per head');
});

test('§3.11: not named before 30 quiet minutes, nor a red, conflicting or busy head; what it cannot read or post changes nothing else', async () => {
  const head = sha(0x1300);
  // The last required check finished 20 minutes ago: quiet for 20 minutes only.
  let w = sceneStalled();
  w.heads.get(head).checks.at(-1).started_at = iso(w.now - 20 * MIN);
  let r = await w.run();
  assert.equal(namings(w).length, 0, JSON.stringify(r)); assert.equal(r.named, undefined);
  for (const change of [
    x => x.check(head, 'kooyumi-merge-slot', 'failure', INDEPENDENT_ADMISSION_APP_ID, { started_at: iso(x.now - 39 * MIN) }),   // red
    x => { x.prs.get(STALLED).mergeable = 'CONFLICTING'; },
    x => x.heads.get(head).runs.push({ id: 1, status: 'queued', conclusion: null }),
    x => x.heads.get(head).statuses.push({ context: 'resident-queue/turing', state: 'pending', description: '排队中' }),
  ]) {
    w = sceneStalled(); change(w);
    r = await w.run();
    assert.equal(namings(w).length, 0, JSON.stringify(r));
  }
  // GitHub refuses the comment: reported in the run, the decision stands, the next run tries again.
  w = sceneStalled();
  const fetch = w.fetchImpl;
  let refuse = true;
  w.fetchImpl = async (url, init = {}) => (refuse && init.method === 'POST' && String(url).endsWith(`/issues/${STALLED}/comments`))
    ? { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}), text: async () => '' } : fetch(url, init);
  r = await w.run();
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.deepEqual(r.named.map(n => [n.pr, n.comment]), [[STALLED, 'not posted (HTTP 403)']]);
  assert.match(renderSummary(r), /#1300 .*kooyumi-admission-verified missing, kooyumi-merge-slot missing; not posted \(HTTP 403\)/);
  refuse = false; w.now += 10 * MIN;
  await w.run();
  assert.equal(namings(w).length, 1);
  // The comments cannot be read: not named, the run is not failed.
  w = sceneStalled(); w.failing = `/issues/${STALLED}/comments`;
  r = await w.run();
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.match(r.named[0].comment, /^not named/); assert.equal(namings(w).length, 0);
});

test('§3.11: #1258 unadmitted (heavy jobs skipped under their unexpanded names, the admission never posted) is named once, under the scaffold', async () => {
  const w = scene0823(); w.pins = {}; w.required = SCAFFOLD_R6; w.prs.clear();
  const head = sha(0x12580);
  w.open(1258, { head, auto: '2026-11-23T10:17:00Z', contains: T, at: w.now - 45 * MIN });
  for (const name of HOSTED) {
    const job = ['hosted-ci-suites', 'hosted-clued-cloud-tests'].includes(name)
      ? `\${{ needs.admission-gate.outputs.admitted == 'true' && '${name}' || '${name}-skipped' }}` : name;
    w.check(head, job, job === name ? 'success' : 'skipped', GITHUB_ACTIONS_APP_ID, { started_at: iso(w.now - 44 * MIN) });
  }
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'none', JSON.stringify(r));
  const [named] = namings(w);
  assert.equal(named?.pr, 1258, JSON.stringify(w.comments));
  assert.match(named.body, /- hosted-ci-suites: job-skipped\n- hosted-clued-cloud-tests: job-skipped\n- kooyumi-work-admission: missing\n/);
  w.now += 10 * MIN; await w.run({}, SCAFFOLD); w.now += 10 * MIN; await w.run({}, SCAFFOLD);
  assert.equal(namings(w).length, 1);
});

// Review 2fb32dc7 §5: a head behind main that the App did not bring up is a candidate; the train brings it up once the front is done.
// Naming it ("nothing will move it, a new head is needed") would send someone to push or merge main by hand: it is not named.
test('§3.11: an author’s head behind main is not named while another pull request is the front; the train brings it up once that is done', async () => {
  const w = sceneStalled();
  const front = sha(0x1301);
  w.open(1301, { head: front, auto: '2026-11-24T00:30:00Z', contains: T, at: w.now - 5 * MIN }); w.check(front, 'gitleaks', null, INDEPENDENT_ADMISSION_APP_ID);
  w.heads.get(sha(0x1300)).contains = BASE;   // #1300 behind main
  let r = await w.run();
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.match(r.reason, /#1301 contains main/);
  assert.equal(namings(w).length, 0, JSON.stringify(w.comments)); assert.equal(r.named, undefined);
  // An hour on, the front still under way: still not named.
  w.now += 60 * MIN;
  r = await w.run();
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.equal(namings(w).length, 0, JSON.stringify(w.comments));
  // The front leaves the train: #1300 is the candidate and brought up, not named.
  w.prs.delete(1301);
  r = await w.run();
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.deepEqual(w.brought(), [STALLED]); assert.equal(namings(w).length, 0);
  // Without a front the stalled head behind main is the candidate: brought up, and its old head is not named.
  const alone = sceneStalled(); alone.heads.get(sha(0x1300)).contains = BASE;
  r = await alone.run();
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.deepEqual(alone.brought(), [STALLED]); assert.equal(namings(alone).length, 0);
});

// What nothing moves behind main: a head the App brought up twice in a row that is not admitted (the train does not bring it again,
// PLAN-train-held-deadlock §2.1). It is named once, with or without a front. Once only, or admitted, it is a candidate and not named.
test('§3.11: a head the App brought up twice in a row, behind main and not admitted, is named once; once only, or admitted, it is not', async () => {
  const head = sha(0x1300);
  const brought = (x, { twice = true } = {}) => {
    x.heads.get(head).contains = BASE;
    x.heads.get(head).checks = x.heads.get(head).checks.filter(c => c.name !== INDEPENDENT_ADMISSION_CHECK);
    x.check(head, MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID, { started_at: iso(x.now - 40 * MIN) });
    x.head(BASE); if (twice) x.check(BASE, MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID);
  };
  let w = sceneStalled(); brought(w);
  let r = await w.run();
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.deepEqual(w.brought(), []);
  assert.deepEqual(namings(w).map(c => c.pr), [STALLED], JSON.stringify(w.comments));
  assert.match(namings(w)[0].body, new RegExp(`- ${INDEPENDENT_ADMISSION_CHECK}: missing\n`));
  // Review §6: the comment is posted with a token that can only write pull requests.
  assert.deepEqual(w.calls.filter(c => c.route?.endsWith('/access_tokens')).map(c => c.body.permissions), [{ pull_requests: 'write' }]);
  w.now += 10 * MIN; await w.run();
  assert.equal(namings(w).length, 1, 'once per head');
  // The same with another pull request the front.
  w = sceneStalled(); brought(w);
  w.open(1301, { head: sha(0x1301), auto: '2026-11-24T00:30:00Z', contains: T, at: w.now - 5 * MIN }); w.check(sha(0x1301), 'gitleaks', null, INDEPENDENT_ADMISSION_APP_ID);
  r = await w.run();
  assert.match(r.reason, /#1301 contains main/); assert.deepEqual(namings(w).map(c => c.pr), [STALLED], JSON.stringify(w.comments));
  // Brought and admitted: a candidate again, not named.
  w = sceneStalled(); brought(w);
  w.check(head, INDEPENDENT_ADMISSION_CHECK, 'success', INDEPENDENT_ADMISSION_APP_ID, { started_at: iso(w.now - 39 * MIN) });
  w.open(1301, { head: sha(0x1301), auto: '2026-11-24T00:30:00Z', contains: T, at: w.now - 5 * MIN }); w.check(sha(0x1301), 'gitleaks', null, INDEPENDENT_ADMISSION_APP_ID);
  r = await w.run();
  assert.match(r.reason, /#1301 contains main/); assert.equal(namings(w).length, 0, JSON.stringify(w.comments));
  // Brought once, not admitted: with a front it waits as a candidate, not named; without one it is brought again.
  w = sceneStalled(); brought(w, { twice: false });
  w.open(1301, { head: sha(0x1301), auto: '2026-11-24T00:30:00Z', contains: T, at: w.now - 5 * MIN }); w.check(sha(0x1301), 'gitleaks', null, INDEPENDENT_ADMISSION_APP_ID);
  r = await w.run();
  assert.match(r.reason, /#1301 contains main/); assert.equal(namings(w).length, 0, JSON.stringify(w.comments)); assert.equal(r.named, undefined);
  w = sceneStalled(); brought(w, { twice: false });
  r = await w.run();
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.deepEqual(w.brought(), [STALLED]); assert.equal(namings(w).length, 0);
  // How many in a row cannot be read: not named this run, and the run says so.
  w = sceneStalled(); brought(w); w.failing = `/git/commits/${head}`;
  w.open(1301, { head: sha(0x1301), auto: '2026-11-24T00:30:00Z', contains: T, at: w.now - 5 * MIN }); w.check(sha(0x1301), 'gitleaks', null, INDEPENDENT_ADMISSION_APP_ID);
  r = await w.run();
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.equal(namings(w).length, 0);
  assert.match(r.named?.[0]?.comment ?? '', /^not named \(连带次数未读到/, JSON.stringify(r.named));
});

// 第二轮规划 A（任务 2fb32dc7，#1298）: a head the App brought up went red for the pipeline's own reason (a test on main that read the
// real base, fixed on main 38 minutes later), then fell behind: passed over for good, and only a person merging main moved it. A
// red head the App brought, admitted and red on something else than the admission, behind main, is brought up again: after every
// candidate that is not red. Not when its first parent is one the App brought as well (two in a row, REBRING_RED_MAX).
const REBRING = 1298, AUTHOR = sha(0x1298a), MADE = sha(0x1298b);
function scene1298({ parentBrought = false, admission = 'success', red = ['hosted-clued-cloud-tests'] } = {}) {
  const w = train(); w.pins = {}; w.required = SCAFFOLD_R6;
  w.head(AUTHOR, {});
  if (parentBrought) w.check(AUTHOR, MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID);
  w.open(REBRING, { head: MADE, auto: '2026-11-24T08:00:00Z', parents: [AUTHOR, BASE] });
  w.check(MADE, MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID);
  w.check(MADE, INDEPENDENT_ADMISSION_CHECK, admission, INDEPENDENT_ADMISSION_APP_ID);
  for (const name of HOSTED) w.check(MADE, name, red.includes(name) ? 'failure' : 'success', GITHUB_ACTIONS_APP_ID);
  return w;
}
const redAgain = (w, head) => { w.check(head, INDEPENDENT_ADMISSION_CHECK, 'success', INDEPENDENT_ADMISSION_APP_ID);
  for (const name of HOSTED) w.check(head, name, name === 'hosted-clued-cloud-tests' ? 'failure' : 'success', GITHUB_ACTIONS_APP_ID); };

test('A1 #1298: a head the App brought, admitted, red on a required check and behind main, alone on the train, is brought up again', async () => {
  const w = scene1298();
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.equal(r.pr, REBRING); assert.deepEqual(w.brought(), [REBRING]);
  assert.deepEqual(w.updates.map(u => u.from), [MADE]);
  // The second head the App made is red again and main moves on: two in a row, passed over as before.
  const second = w.headOf(REBRING); redAgain(w, second);
  w.tip = sha(0x7298); w.now += 40 * MIN;
  const again = await w.run({}, SCAFFOLD);
  assert.equal(again.result, 'none', JSON.stringify(again)); assert.deepEqual(w.brought(), [REBRING]);
  assert.match(again.train.members.find(m => m.pr === REBRING).state, /^red \(hosted-clued-cloud-tests\) on a head the App brought: 连带 2 次仍未通过，不再带$/, statesOf(again));
});

test('A2: a red head the App brought whose first parent the App brought as well is not brought again', async () => {
  const w = scene1298({ parentBrought: true });
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.deepEqual(w.brought(), []);
  assert.match(r.train.members.find(m => m.pr === REBRING).state, /^red \(hosted-clued-cloud-tests\) on a head the App brought: 连带 2 次仍未通过，不再带$/, statesOf(r));
});

test('A3: a candidate that is not red is brought before a red head the App brought; once it merged, the red one is brought', async () => {
  const w = scene1298();
  w.open(1311, { head: sha(0x1311), auto: '2026-11-24T09:00:00Z' });
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.deepEqual(w.brought(), [1311]);
  // #1311 is the front and under way: nobody else is brought.
  w.check(w.headOf(1311), 'hosted-ci-suites', null, GITHUB_ACTIONS_APP_ID); w.now += 5 * MIN;
  assert.equal((await w.run({}, SCAFFOLD)).result, 'none'); assert.deepEqual(w.brought(), [1311]);
  // #1311 merged, main moved: the red head the App brought is the one candidate left.
  w.merged(1311); w.now += 5 * MIN;
  const last = await w.run({}, SCAFFOLD);
  assert.equal(last.result, 'merged', JSON.stringify(last)); assert.deepEqual(w.brought(), [1311, REBRING]);
});

test('A4: a head the App brought whose admission failed is not brought again, red elsewhere or not', async () => {
  for (const red of [[], ['hosted-clued-cloud-tests']]) {
    const w = scene1298({ admission: 'failure', red });
    const r = await w.run({}, SCAFFOLD);
    assert.equal(r.result, 'none', JSON.stringify(r)); assert.deepEqual(w.brought(), []);
    assert.match(r.train.members.find(m => m.pr === REBRING).state, new RegExp(String.raw`^red \(.*` + INDEPENDENT_ADMISSION_CHECK), statesOf(r));
  }
});

// Independent review of 2fb32dc7 A, must-fix 1: counting how many heads in a row the App brought is a helper of the rebring path.
// When it cannot be read (the first parent's check runs, or the parent itself) that head is not brought again this run; the
// candidates before it are brought as before, the run is not given up.
test('A5: a rebring chain that cannot be read only keeps that head back; the candidate before it is still brought', async () => {
  const redBroughtHead = w => { w.check(sha(0x1156), MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID);
    w.check(sha(0x1156), INDEPENDENT_ADMISSION_CHECK, 'success', INDEPENDENT_ADMISSION_APP_ID); w.check(sha(0x1156), 'clued-cloud-tests', 'failure'); };
  // The first parent's check runs cannot be read (BASE is unknown to GitHub here).
  let w = scene0823(); redBroughtHead(w);
  let r = await w.run();
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.equal(r.pr, 1217, JSON.stringify(r)); assert.deepEqual(w.brought(), [1217]);
  assert.match(r.train.members.find(m => m.pr === 1156).state, /^red \(clued-cloud-tests\)/, JSON.stringify(r.train.members));
  // The head's commit cannot be read.
  w = scene0823(); w.head(BASE); redBroughtHead(w);
  const reads = w.fetchImpl;
  w.fetchImpl = async (url, init = {}) => (String(url).endsWith(`/commits/${sha(0x1156)}`)
    ? { ok: false, status: 502, headers: { get: () => null }, json: async () => ({ message: 'Server Error' }), text: async () => '' } : reads(url, init));
  r = await w.run();
  assert.equal(r.pr, 1217, JSON.stringify(r)); assert.deepEqual(w.brought(), [1217]);
  assert.match(r.train.members.find(m => m.pr === 1156).state, /^red \(clued-cloud-tests\)/, JSON.stringify(r.train.members));
});

// PLAN-unadmitted-silent-20261125 §2.2 (任务 2fb32dc7): the resident writes a pending page status on every head behind main that it
// does not propose ("落后 main N 个提交：轮到时机器人合入 main…", pr-status.mjs#describe), and writes it again each time main moves.
// It is the resident saying it will not run that head: not something under way, and not activity. Read as under way, a head the
// App brought up and the admission never answered was never named, and two of them held the train with nobody told.
// The sentence is taken from what pr-status.mjs writes, so a change of the sentence changes these cases with it.
const SILENT_B = 1401, SILENT_C = 1402, SILENT_D = 1403, SILENT_FRONT = 1400;
const residentSays = behindBy => describePrStatus({ pull: { headSha: sha(0x1401), eligible: false, hint: 'merge-main', behindBy }, status: null, now: NOW }).description;
// A head behind main by 12, as the robot left it: kooyumi-main-merge of App 5164952, one hosted check and kooyumi-work-admission missing;
// the resident's pending sentence rewritten 5 minutes ago, everything else last active 40 minutes ago, nothing running. Brought, it
// is the App's second in a row (its first parent the App's as well, inARow 2): the train does not bring it again (PLAN-train-held-
// deadlock §2.1), so nothing moves it; once only (inARow 1) it is a candidate after the others.
function silentHead(w, number, { brought = true, inARow = 2, text = residentSays(12), context = 'resident-queue/turing (info only)', auto } = {}) {
  const head = sha(number * 16 + 1), parent = sha(number * 16 + 2);
  w.head(parent, {});
  if (brought && inARow >= 2) w.check(parent, MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID);
  w.open(number, { head, auto, contains: BASE, at: w.now - 40 * MIN, parents: [parent, BASE] });
  if (brought) w.check(head, MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID, { started_at: iso(w.now - 40 * MIN) });
  for (const name of HOSTED.slice(1)) w.check(head, name, 'success', GITHUB_ACTIONS_APP_ID, { started_at: iso(w.now - 40 * MIN) });
  w.heads.get(head).statuses.unshift({ context, state: 'pending', description: text, created_at: iso(w.now - 300 * MIN), updated_at: iso(w.now - 5 * MIN) });
  return head;
}
function sceneSilent({ front = true } = {}) {
  const w = train(); w.pins = {}; w.required = SCAFFOLD_R6;
  if (front) {
    w.open(SILENT_FRONT, { head: sha(0x14000), auto: '2026-11-24T00:00:00Z', contains: T, at: w.now - 5 * MIN });
    w.check(sha(0x14000), 'hosted-ci-suites', null, GITHUB_ACTIONS_APP_ID);
  }
  return w;
}

test('U1 (修前必红): a brought-up head behind main, not admitted, with only the resident’s “落后 main” pending on it, is named once', async () => {
  assert.match(residentSays(12), /^落后 main 12 个提交：轮到时机器人合入 main/);
  const w = sceneSilent();
  const head = silentHead(w, SILENT_B, { auto: '2026-11-24T01:00:00Z' });
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.match(r.reason, /#1400 contains main/); assert.deepEqual(w.brought(), []);
  assert.deepEqual(namings(w).map(c => c.pr), [SILENT_B], JSON.stringify(r));
  assert.match(namings(w)[0].body, new RegExp(head)); assert.match(namings(w)[0].body, new RegExp(`- ${INDEPENDENT_ADMISSION_CHECK}: missing\n`));
});

test('U2 (修前必红): with no front, two such heads are each named once and the train brings another (PLAN-train-held-deadlock §2.3)', async () => {
  const w = sceneSilent({ front: false });
  silentHead(w, SILENT_B, { auto: '2026-11-24T01:00:00Z' }); silentHead(w, SILENT_C, { auto: '2026-11-24T02:00:00Z' });
  silentHead(w, SILENT_D, { brought: false, auto: '2026-11-24T03:00:00Z' });
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'merged', JSON.stringify(r)); assert.equal(r.pr, SILENT_D); assert.deepEqual(w.brought(), [SILENT_D]);
  assert.deepEqual(namings(w).map(c => c.pr).sort(), [SILENT_B, SILENT_C], JSON.stringify(r));
  w.now += 10 * MIN;
  assert.notEqual((await w.run({}, SCAFFOLD)).result, 'held'); assert.equal(namings(w).length, 2, 'once per head');
});

test('3576b29c: an unadmitted head brought twice with a failed hosted check stays behind the next candidate', async () => {
  const w = sceneSilent({ front: false });
  const head = silentHead(w, SILENT_B, { auto: '2026-11-24T01:00:00Z' });
  w.check(head, HOSTED[0], 'failure', GITHUB_ACTIONS_APP_ID, { started_at: iso(w.now - 40 * MIN) });
  silentHead(w, SILENT_D, { brought: false, auto: '2026-11-24T03:00:00Z' });

  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'merged', statesOf(r));
  assert.deepEqual(w.brought(), [SILENT_D]);
  assert.equal(w.headOf(SILENT_B), head);
  assert.equal(r.train.members.find(m => m.pr === SILENT_B).state,
    `red (${HOSTED[0]}), not admitted on a head the App brought: 连带 2 次仍未通过，不再带`);
});

test('U1b: brought once only, behind and not admitted, it is a candidate after the front: not named', async () => {
  const w = sceneSilent();
  silentHead(w, SILENT_B, { inARow: 1, auto: '2026-11-24T01:00:00Z' });
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.match(r.reason, /#1400 contains main/);
  assert.equal(namings(w).length, 0, JSON.stringify(w.comments)); assert.equal(r.named, undefined);
});

test('U3: an author’s head behind main with the same sentence is a candidate: the train brings it, it is not named', async () => {
  const w = sceneSilent();
  silentHead(w, SILENT_B, { brought: false, auto: '2026-11-24T01:00:00Z' });
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.equal(namings(w).length, 0, JSON.stringify(w.comments)); assert.equal(r.named, undefined);
});

test('U4: a head that contains main with the resident’s pending “排队中” is under way: not named', async () => {
  const w = sceneStalled();
  w.heads.get(sha(0x1300)).statuses.push({ context: 'resident-queue/turing (info only)', state: 'pending', description: '排队中', updated_at: iso(w.now - 40 * MIN) });
  const r = await w.run();
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.equal(namings(w).length, 0, JSON.stringify(w.comments));
});

test('U5: a pending sentence it does not know, or the held sentence under another context, still counts as under way: not named', async () => {
  for (const options of [{ text: '运行中：准入' }, { context: 'someone-else/queue' }]) {
    const w = sceneSilent();
    silentHead(w, SILENT_B, { auto: '2026-11-24T01:00:00Z', ...options });
    const r = await w.run({}, SCAFFOLD);
    assert.equal(r.result, 'none', JSON.stringify(r)); assert.equal(namings(w).length, 0, `${JSON.stringify(options)}: ${JSON.stringify(w.comments)}`);
  }
});

test('U6: named once; the resident rewriting “落后 main 13” 10 minutes later does not name it again', async () => {
  const w = sceneSilent();
  const head = silentHead(w, SILENT_B, { auto: '2026-11-24T01:00:00Z' });
  await w.run({}, SCAFFOLD);
  assert.equal(namings(w).length, 1, JSON.stringify(w.comments));
  w.now += 10 * MIN;
  const status = w.heads.get(head).statuses[0];
  Object.assign(status, { description: residentSays(13), updated_at: iso(w.now) });
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.equal(namings(w).length, 1, 'once per head');
});

const REFUSED_PR = 1151, NEXT_PR = 1374;
const REFUSED_CONTEXT = 'resident-queue/turing (info only)';
const REFUSED_TEXT = '当班：未准入或未执行（PATHS_OUTSIDE_WRITE_SET）：约 21:23 自动重试（第 1 次），修正后编辑 PR 可提前';

function sceneRefused(status = {}) {
  const w = train();
  w.required = SCAFFOLD_R6;
  const refused = sha(0x1151), next = sha(0x1374), at = w.now - 20 * MIN;
  w.open(REFUSED_PR, { head: refused, contains: T, at, auto: '2026-11-21T00:00:00Z', parents: [BASE, T] });
  w.check(refused, MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID, { started_at: iso(at) });
  w.heads.get(refused).statuses.push({ context: REFUSED_CONTEXT, state: 'pending', description: REFUSED_TEXT, updated_at: iso(w.now - MIN), ...status });
  w.open(NEXT_PR, { head: next, auto: '2026-11-21T01:00:00Z' });
  hostedGreen(w)(next);
  return w;
}

test('#1151: a front waiting after admission refused its write set yields to the next healthy PR', async () => {
  const w = sceneRefused();
  const refused = w.headOf(REFUSED_PR), next = w.headOf(NEXT_PR);
  const r = await w.run({}, SCAFFOLD);

  assert.deepEqual({ result: r.result, pr: r.pr, updated: w.brought() },
    { result: 'merged', pr: NEXT_PR, updated: [NEXT_PR] }, statesOf(r));
  assert.deepEqual(w.calls.filter(c => c.method === 'PUT'), [
    { method: 'PUT', route: `/repos/o/r/pulls/${NEXT_PR}/update-branch`, body: { expected_head_sha: next } },
  ]);
  assert.equal(w.headOf(REFUSED_PR), refused);
});

test('refusal refreshes do not count as activity, and the diagnostic names the reason once per head', async () => {
  const w = sceneRefused();
  const head = w.headOf(REFUSED_PR), { statuses } = w.heads.get(head);
  assert.equal((await w.run({}, SCAFFOLD)).pr, NEXT_PR);
  assert.equal(namings(w).length, 0, 'the existing quiet period still applies');
  for (const time of ['21:33Z', '21:43Z']) {
    w.now += 10 * MIN;
    statuses.unshift({ ...statuses[0], description: REFUSED_TEXT.replace('21:23', time), updated_at: iso(w.now) });
    const r = await w.run({}, SCAFFOLD);
    assert.match(r.train.members.find(m => m.pr === REFUSED_PR).state, /准入拒绝待修.*PATHS_OUTSIDE_WRITE_SET/);
    assert.deepEqual(w.brought(), [NEXT_PR]);
    assert.deepEqual(namings(w).map(c => c.pr), [REFUSED_PR]);
    assert.match(namings(w)[0].body, new RegExp(`- ${INDEPENDENT_ADMISSION_CHECK}: missing\n`));
    assert.match(namings(w)[0].body, /PATHS_OUTSIDE_WRITE_SET/);
    assert.ok(namings(w)[0].body.includes(head));
  }
});

test('the resident’s exhausted retry result also yields, before and after main moves', async () => {
  const w = sceneRefused({ state: 'failure', description: '24 小时内已多次未准入或未执行（PATHS_OUTSIDE_WRITE_SET）：请修正后推新提交' });
  const head = w.headOf(REFUSED_PR);
  let r = await w.run({}, SCAFFOLD);
  assert.equal(r.pr, NEXT_PR, statesOf(r));
  assert.match(r.train.members.find(m => m.pr === REFUSED_PR).state, /准入拒绝待修.*PATHS_OUTSIDE_WRITE_SET/);
  w.merged(NEXT_PR);
  r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'none', statesOf(r));
  assert.match(r.train.members[0].state, /准入拒绝待修.*PATHS_OUTSIDE_WRITE_SET/);
  assert.deepEqual(w.brought(), [NEXT_PR]);
  assert.equal(w.headOf(REFUSED_PR), head);
});

test('new queued or running evidence takes precedence over the refusal', async () => {
  for (const resume of [
    (w, head) => w.heads.get(head).statuses.unshift({ context: REFUSED_CONTEXT, state: 'pending',
      description: '当班：运行中：第 8 段（准入）', updated_at: iso(w.now) }),
    (w, head) => w.check(head, HOSTED[0], null, GITHUB_ACTIONS_APP_ID),
    (w, head) => w.heads.get(head).runs.push({ id: 1, status: 'queued' }),
  ]) {
    const w = sceneRefused();
    resume(w, w.headOf(REFUSED_PR));
    const r = await w.run({}, SCAFFOLD);
    assert.equal(r.result, 'none', statesOf(r));
    assert.equal(r.train.members[0].state, 'front');
    assert.deepEqual(w.brought(), []);
    assert.deepEqual(namings(w), []);
  }
});

test('unrecognized or off-duty pending text retains the conservative front behavior', async () => {
  for (const status of [
    { context: 'resident-standby/turing (info only)' },
    { context: 'resident-queue/turing' },
    { description: REFUSED_TEXT.replace('当班：', '') },
    { description: REFUSED_TEXT.replace('当班：', '已交班：') },
    { description: '当班：排队中：暂缓（PATHS_OUTSIDE_WRITE_SET）' },
    { description: REFUSED_TEXT.replace('PATHS_OUTSIDE_WRITE_SET', 'UNKNOWN_ADMISSION_CODE') },
  ]) {
    const w = sceneRefused(status);
    const r = await w.run({}, SCAFFOLD);
    assert.equal(r.result, 'none', JSON.stringify(status));
    assert.equal(r.train.members[0].state, 'front');
    assert.deepEqual(w.brought(), []);
  }
});

test('newer resident completion supersedes rejection evidence without supplying the missing pinned admission', async () => {
  for (const context of [REFUSED_CONTEXT, 'resident-queue/backup (info only)']) {
    const w = sceneRefused();
    const head = w.headOf(REFUSED_PR), { statuses } = w.heads.get(head);
    statuses.unshift({ context, state: 'success', description: '已完成：常驻执行器跑完八段，检查已发布', updated_at: iso(w.now) });
    w.check(head, INDEPENDENT_ADMISSION_CHECK, 'success', ADMISSION_APP_ID);
    hostedGreen(w)(head);
    const r = await w.run({}, SCAFFOLD);
    assert.equal(r.pr, NEXT_PR, statesOf(r));
    assert.equal(r.train.members[0].state, 'idle');
  }
});

test('the pinned admission pass and the required red checks take precedence over an older refusal', async () => {
  for (const conclusion of ['success', 'failure']) {
    const w = sceneRefused();
    const head = w.headOf(REFUSED_PR);
    hostedGreen(w)(head);
    w.check(head, INDEPENDENT_ADMISSION_CHECK, conclusion, INDEPENDENT_ADMISSION_APP_ID);
    const r = await w.run({}, SCAFFOLD);
    if (conclusion === 'success') {
      assert.equal(r.result, 'none', statesOf(r));
      assert.equal(r.train.members[0].state, 'front');
      assert.deepEqual(w.brought(), []);
    } else {
      assert.equal(r.pr, NEXT_PR, statesOf(r));
      assert.equal(r.train.members[0].state, `red (${INDEPENDENT_ADMISSION_CHECK})`);
    }
  }
});

test('U7: the comment refused (403) changes nothing the run decided; the summary says not posted', async () => {
  const w = sceneSilent();
  silentHead(w, SILENT_B, { auto: '2026-11-24T01:00:00Z' });
  const fetch = w.fetchImpl;
  w.fetchImpl = async (url, init = {}) => (init.method === 'POST' && String(url).endsWith(`/issues/${SILENT_B}/comments`))
    ? { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}), text: async () => '' } : fetch(url, init);
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'none', JSON.stringify(r)); assert.match(r.reason, /#1400 contains main/); assert.deepEqual(w.brought(), []);
  assert.deepEqual(r.named?.map(n => [n.pr, n.comment]), [[SILENT_B, 'not posted (HTTP 403)']], JSON.stringify(r));
  assert.match(renderSummary(r), new RegExp(`#${SILENT_B} .*${INDEPENDENT_ADMISSION_CHECK} missing; not posted [(]HTTP 403[)]`));
});

// PLAN-train-held-deadlock-20261125 §1.1, §2.1 (任务 3576b29c): 11-25 10:16 as GitHub had it, under the scaffold ruleset (修订 6).
// A head the App brought up that the admission did not pass had no way out once main moved past it: the resident does not propose
// a head behind main and the robot did not bring it again, while it held one of the two places of the hold for good. With one
// more head brought up and its admission not there yet, nobody was brought (held). Now a head the App brought that has not passed
// is brought again, after every other candidate, while fewer than BROUGHT_IN_A_ROW_MAX heads in a row are the App's; nobody holds.
const JIA = 1321, YI = 1325, BING = 1329, DING = 1330;
const residentPending = (w, head, behindBy) => w.heads.get(head).statuses.push({ context: 'resident-queue/turing (info only)', state: 'pending',
  description: residentSays(behindBy), created_at: iso(w.now - 60 * MIN), updated_at: iso(w.now - 2 * MIN) });
function scene1125() {
  const w = train(); w.pins = {}; w.required = SCAFFOLD_R6;
  w.now = Date.UTC(2026, 10, 25, 2, 16, 0);   // 10:16 Beijing time
  // 甲 #1321: brought up to main at 09:55 from its author's head; contains main's tip; hosted-ci-suites-windows failed; not admitted.
  const jia = sha(0x13211);
  w.head(sha(0x13210), {});
  w.open(JIA, { head: jia, auto: '2026-11-24T20:00:00Z', contains: T, at: w.now - 21 * MIN, parents: [sha(0x13210), T] });
  w.check(jia, MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID);
  for (const name of HOSTED) w.check(jia, name, name === 'hosted-ci-suites-windows' ? 'failure' : 'success', GITHUB_ACTIONS_APP_ID);
  // 乙 #1325: brought up at 09:13 from its author's head, behind main by 5 since 09:40; hosted-migration-verify failed; not admitted;
  // the resident's pending "落后 main 5 个提交" on it.
  const yi = sha(0x13251);
  w.head(sha(0x13250), {});
  w.open(YI, { head: yi, auto: '2026-11-24T21:00:00Z', contains: BASE, at: w.now - 63 * MIN, parents: [sha(0x13250), BASE] });
  w.check(yi, MAIN_MERGE_CHECK, 'success', ADMISSION_APP_ID);
  for (const name of HOSTED) w.check(yi, name, name === 'hosted-migration-verify' ? 'failure' : 'success', GITHUB_ACTIONS_APP_ID);
  residentPending(w, yi, 5);
  // 丙 #1329: pushed at 10:05 on an old main (behind by 5), never brought up, the seven hosted- green, no admission; auto-merge 10:08:51.
  const bing = sha(0x13290);
  w.open(BING, { head: bing, auto: '2026-11-25T02:08:51Z', contains: BASE, at: w.now - 11 * MIN });
  for (const name of HOSTED) w.check(bing, name, 'success', GITHUB_ACTIONS_APP_ID);
  residentPending(w, bing, 5);
  return w;
}
const mainMergeChecks = (w, head) => w.heads.get(head).checks.filter(c => c.name === MAIN_MERGE_CHECK && c.app.id === ADMISSION_APP_ID);

test('D1 (修前必红): 11-25 10:16, two heads the App brought and not admitted, one of them behind: the author’s head behind is brought', async () => {
  const w = scene1125();
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'merged', `${JSON.stringify({ result: r.result, reason: r.reason })} ${statesOf(r)}`);
  assert.equal(r.pr, BING); assert.deepEqual(w.brought(), [BING]);
  assert.equal(w.calls.filter(c => c.method === 'PUT').length, 1, 'one update-branch');
  assert.equal(mainMergeChecks(w, w.headOf(BING)).length, 1, 'one kooyumi-main-merge on its new head');
  assert.match(r.train.members.find(m => m.pr === JIA).state, /^red \(hosted-ci-suites-windows\)$/, statesOf(r));
  assert.match(r.train.members.find(m => m.pr === YI).state,
    /^candidate, red \(hosted-migration-verify\), not admitted on a head the App brought: main is merged in again, after the others$/, statesOf(r));
  assert.doesNotMatch(statesOf(r), /held/);
});

test('D2 (修前必红): after 丙 merged, 乙 (brought, not admitted, behind) is brought up again', async () => {
  const w = scene1125();
  await w.run({}, SCAFFOLD);
  // 丙's new head is admitted, green and merged: main moves. 甲's red is its author's (§4): it leaves the train.
  const made = w.headOf(BING);
  w.check(made, INDEPENDENT_ADMISSION_CHECK, 'success', INDEPENDENT_ADMISSION_APP_ID); hostedGreen(w)(made);
  w.merged(BING); w.prs.get(JIA).auto = null; w.now += 20 * MIN;
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'merged', `${JSON.stringify({ result: r.result, reason: r.reason })} ${statesOf(r)}`);
  assert.equal(r.pr, YI); assert.deepEqual(w.brought(), [BING, YI]);
  assert.deepEqual(w.heads.get(w.headOf(YI)).parents, [sha(0x13251), w.tip], 'GitHub’s merge of main into its head, nothing else');
});

test('D3: 乙’s second head the App brought, not admitted and behind again, is not brought a third time; the others are', async () => {
  const w = scene1125();
  await w.run({}, SCAFFOLD);
  const made = w.headOf(BING);
  w.check(made, INDEPENDENT_ADMISSION_CHECK, 'success', INDEPENDENT_ADMISSION_APP_ID); hostedGreen(w)(made);
  w.merged(BING); w.prs.get(JIA).auto = null; w.now += 20 * MIN;
  await w.run({}, SCAFFOLD);
  assert.deepEqual(w.brought(), [BING, YI]);
  // 乙's second head: one hosted check and admission still missing. Another pull request comes aboard; main moves on.
  const second = w.headOf(YI); for (const name of HOSTED.slice(1)) w.check(second, name);
  w.open(DING, { head: sha(0x13300), auto: '2026-11-25T02:40:00Z', contains: BASE, at: w.now });
  w.tip = sha(0x7325); w.now += 20 * MIN;
  const r = await w.run({}, SCAFFOLD);
  assert.equal(r.result, 'merged', `${JSON.stringify({ result: r.result, reason: r.reason })} ${statesOf(r)}`);
  assert.equal(r.pr, DING); assert.deepEqual(w.brought(), [BING, YI, DING]);
  assert.match(r.train.members.find(m => m.pr === YI).state, /^not admitted on a head the App brought: 连带 2 次仍未通过，不再带$/, statesOf(r));
  // 丁 is the front now. 乙 is not brought again and nothing will move it: named once its head is quiet for 30 minutes.
  w.check(w.headOf(DING), 'hosted-ci-suites', null, GITHUB_ACTIONS_APP_ID);
  w.now += 20 * MIN;
  const later = await w.run({}, SCAFFOLD);
  assert.equal(later.result, 'none', JSON.stringify(later)); assert.deepEqual(w.brought(), [BING, YI, DING]);
  assert.deepEqual(namings(w).map(c => c.pr), [YI], JSON.stringify(w.comments));
});

test('D4 (修前必红): in the world of D1 a run naming 丙 brings it up', async () => {
  const w = scene1125();
  const r = await w.run({ pr: String(BING), head: w.headOf(BING) }, SCAFFOLD);
  assert.equal(r.result, 'merged', JSON.stringify({ result: r.result, reason: r.reason }));
  assert.equal(r.pr, BING); assert.deepEqual(w.brought(), [BING]);
  assert.equal(mainMergeChecks(w, w.headOf(BING)).length, 1);
});

test('D5 (修前必红): four behind, the admission silent on every head brought up, 20 minutes a run: each brought once in order, never held', async () => {
  const w = fourBehind('scaffold');
  const results = [];
  while (w.brought().length < 4 && results.length < 6) results.push(...await runs(w, 1, SCAFFOLD, 20 * MIN, hostedGreen(w)));
  assert.deepEqual(results.map(r => r.result).filter(r => r === 'held'), [], statesOf(results.at(-1)));
  assert.deepEqual(w.brought(), [A, B, C, D], statesOf(results.at(-1)));
  assert.ok(results.length <= 5, `${results.length} runs`);
});

// PLAN-train-held-deadlock-20261125 §3.3, §3.5: the robot chooses again as soon as hosted-required ends on any head (a red front
// passes to the next one at once); the schedule is left for what is decided by time (idle, naming) and for a lost event.
test('§3.3: the hosted copy runs when hosted-required completes; never on a pull request event; the App key only on main', () => {
  const read = file => fs.readFileSync(path.join(ROOT, '.github/workflows', file), 'utf8');
  const text = read('clued-front-main-merge-hosted.yml');
  const on = text.slice(text.indexOf('\non:\n'), text.indexOf('\npermissions:\n'));
  const required = /^name: (.+)$/m.exec(read('hosted-required.yml'))?.[1]?.trim();
  assert.ok(required, 'hosted-required.yml has a name');
  const run = /\n  workflow_run:\n    workflows: \[([^\]\n]*)\]\n    types: \[([^\]\n]*)\]\n/.exec(on);
  assert.ok(run, on);
  assert.deepEqual(run[1].split(',').map(s => s.trim()), [required], 'exactly the workflow hosted-required.yml names');
  assert.deepEqual(run[2].split(',').map(s => s.trim()), ['completed']);
  assert.doesNotMatch(on, /pull_request/);
  assert.match(on, /\n  schedule:\n    - cron: /, 'the schedule stays, for idle, naming and a lost event');
  assert.match(text, /\n    if: needs\.scaffold-phase\.outputs\.in_force == 'true' && github\.ref == 'refs\/heads\/main'\n/);
});
