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
import { ADMISSION_APP_ID, APP_CHECK_NAME, MAIN_MERGE_CHECK, OWNER_REVIEW_RPC, evaluate, mainMergeExternalId, parseMainMergeExternalId, resolvePublicSupabaseConfig } from './clued-work-admission.mjs';
import { runFrontMainMerge } from './clued-front-main-merge.mjs';
import { ciWorkflows } from './clued-merge-slot-ci.mjs';
import { NON_PR_CONTROL_FILES, NON_PR_CONTROL_SOURCE_PATH, classifyNonPrControlWorkflowSource, parseNonPrControlCatalogue } from './clued-non-pr-control-source.mjs';
import { recognizeCatalogueWorkflow } from './clued-source-only-workflow.mjs';
import { parseWorkflowProfiles, roleDefinitionDigest, workflowBlob } from './clued-workflow-profile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RPC_URL = `${resolvePublicSupabaseConfig({}, ROOT).url}/rest/v1/rpc/clued_work_verify_v1`;
const DOOR_URL = `${resolvePublicSupabaseConfig({}, ROOT).url}/rest/v1/rpc/${OWNER_REVIEW_RPC}`;
const API = 'https://api.test';
const PROTECTED = 'scripts/ci/x.mjs';
const PR = 1125, H = 'a'.repeat(40), T = '7'.repeat(40), X = 'e'.repeat(40), BASE = 'b'.repeat(40);
const CLAIM = '0f3d9c6a-1b2e-4c5d-8e7f-9a0b1c2d3e4f', TASK = '00000000-0000-4000-8000-000000000452';
const AUTH = '00000000-0000-4000-8000-000000000453', CARRIED = '00000000-0000-4000-8000-000000000454';
// One GitHub repository and one Native, as their HTTP answers. world.pr is the PR; world.commits the commits GitHub knows.
function world({ updateMakes = 'web-flow', updateStatus = 202, behind = 3, file = 'docs/front.md', mainTouches = ['docs/other.md'] } = {}) {
  const w = {
    pr: { number: PR, state: 'open', draft: false, body: 'Body', changed_files: 1, head: { sha: H, ref: 'claude/x', repo: { full_name: 'o/r' } },
      base: { sha: BASE, ref: 'main', repo: { full_name: 'o/r', default_branch: 'main' } } },
    tip: T, mainTouches, checks: [], authorized: new Set([H]), granted: new Set([H]), asked: [], carries: [], updates: [], calls: [],
    commits: new Map([[H, { sha: H, parents: [{ sha: BASE }] }]]),
  };
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
        w.authorized.add(input.head_sha);
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
    if (method === 'GET' && route === `/repos/o/r/pulls/${PR}`) return reply(structuredClone(w.pr));
    if (method === 'GET' && route.startsWith(`/repos/o/r/pulls/${PR}/files`)) return reply([{ filename: file, status: 'modified' }]);
    if (method === 'GET' && route === '/repos/o/r/branches/main') return reply({ name: 'main', commit: { sha: w.tip } });
    if (method === 'GET' && route.startsWith('/repos/o/r/compare/')) {
      const [from, to] = route.slice('/repos/o/r/compare/'.length).split('?')[0].split('...');
      if (from === w.tip && to === H) return reply({ status: 'diverged', behind_by: behind, ahead_by: 1, merge_base_commit: { sha: BASE }, files: [{ filename: file }] });
      if (from === w.tip && to === X) return reply({ status: 'ahead', behind_by: 0, ahead_by: 2, files: [{ filename: file }] });
      if (from === to) return reply({ status: 'identical', behind_by: 0, files: [] });
      // What main changed since this branch forked (also what the merge brought into the head).
      if ((from === BASE && to === w.tip) || (from === H && to === X)) return reply({ status: 'ahead', behind_by: 0, files: w.mainTouches.map(filename => ({ filename })) });
      return reply({ status: 'ahead', behind_by: 0, files: [] });
    }
    const checkList = /^\/repos\/o\/r\/commits\/([0-9a-f]{40})\/check-runs/.exec(route);
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
      w.commits.set(X, { sha: X, parents: [{ sha: H }, { sha: w.tip }], committer: { login: updateMakes },
        commit: { verification: { verified: updateMakes === 'web-flow', reason: updateMakes === 'web-flow' ? 'valid' : 'unsigned' } } });
      w.pr.head.sha = X;
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
const admit = (w, head = w.pr.head.sha) =>
  evaluate({ env: env(), event: { pull_request: { ...structuredClone(w.pr), head: { ...w.pr.head, sha: head } } }, eventName: 'pull_request',
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
test('the dispatch-only workflow is an exact non-PR control Source; every counted CI workflow keeps its catalogue identity', () => {
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
    workflow_definition_sha256: roleDefinitionDigest(definition), triggers: ['workflow_dispatch'],
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
