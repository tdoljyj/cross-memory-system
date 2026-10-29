// Hint mode (free-minutes design S20): the companion's read-only observation through the installed Source's
// relay observer and pure hint attestation, written create-only as hosted-hint/1 records (<= 2 KB) that the
// executor reads newest-first; the gh read port; the Windows engine's stage R and dynamic stage options.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Mailbox, HINT_FILE } from '../src/mailbox.mjs';
import { HostedHints, hintRecord, hintRole, sourceHintObserver } from '../src/hosted-hints.mjs';
import { parseHint, HINT_MAX_BYTES } from '../src/hosted-wait.mjs';
import { createGhReadPort } from '../src/gh-read-port.mjs';
import { Poller, HINT_WINDOW_MS } from '../src/poller.mjs';
import { restPolls } from './gh-rest-stub.mjs';
import { mailboxCompanion } from '../src/service-ports.mjs';
import { validateHintConfig } from '../src/companion.mjs';
import { WindowsEngine } from '../src/engine-windows.mjs';
import { validatePolicy } from '../src/policy.mjs';
import { TEST_NODE, TEST_NODE_SHA, tempRoot, rawPolicy, HEAD, BASE, SOURCE } from './helpers.mjs';
import { createWorld, H, B, PR, REPO } from '../../actions-hosted-migration/independent-ci-v1/test/fixtures/hosted-relay/world.mjs';
import { createHostedRelayObserver } from '../../actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/observe.mjs';
import { hostedHint } from '../../actions-hosted-migration/independent-ci-v1/src/hosted-relay-v1/stage.mjs';

const T0 = Date.parse('2026-10-21T06:00:00Z');

test('hint roles map the hint-mode verdicts; anything unexpected is NOT_ELIGIBLE (local), never SUCCESS', () => {
  assert.deepEqual(hintRole({ verdict: 'ATTESTED_SUCCESS' }, null, T0), { state: 'SUCCESS' });
  assert.deepEqual(hintRole({ verdict: 'PENDING', reason: 'E5_HOSTED_IN_PROGRESS' }, { startedAt: new Date(T0 - 1000).toISOString() }, T0), { state: 'PENDING_RUNNING', startedAt: T0 - 1000 });
  assert.deepEqual(hintRole({ verdict: 'PENDING', reason: 'E5_HOSTED_QUEUED' }, null, T0), { state: 'PENDING_QUEUED', queuedAt: T0 });
  assert.deepEqual(hintRole({ verdict: 'BILLING_REFUSED' }, null, T0), { state: 'BILLING_REFUSED' });
  assert.deepEqual(hintRole({ verdict: 'HOSTED_NOT_SUCCESS', reason: 'E5_HOSTED_FAILURE' }, null, T0), { state: 'HOSTED_NOT_SUCCESS', reason: 'E5_HOSTED_FAILURE' });
  assert.deepEqual(hintRole({ verdict: 'ATTESTATION_FAILED', reason: 'E6_TOKEN_MISSING' }, null, T0), { state: 'NOT_ELIGIBLE', reason: 'E6_TOKEN_MISSING' });
  assert.deepEqual(hintRole(undefined, null, T0), { state: 'NOT_ELIGIBLE', reason: 'HINT_UNCLASSIFIED' });
  const r = hintRecord({ repo: REPO, pr: 7, headSha: H, observedAt: T0, head: { roles: { gitleaks: { verdict: 'ATTESTED_SUCCESS' } } }, facts: null });
  assert.deepEqual(Object.keys(r.roles), ['gitleaks', 'trivy']);
  assert.equal(r.roles.trivy.state, 'NOT_ELIGIBLE');
});

test('end to end over the Source observer in hint mode: hosted success, a queued run and a CI-file change become hints the executor parses', async t => {
  const root = await tempRoot(t);
  const mailbox = await Mailbox.open(root, () => T0);
  const w = createWorld({ now: T0 });
  const observeHead = sourceHintObserver({ registry: w.registry, createObserver: createHostedRelayObserver, hostedHint, github: w.github, repo: REPO });
  const hints = new HostedHints({ repo: REPO, observeHead, mailbox, clock: () => T0 });
  const subject = { repo: REPO, pr: PR, headSha: H };
  // nothing hosted yet: ABSENT for both
  assert.equal((await hints.observe({ pr: PR, headSha: H, baseSha: B })).roles.gitleaks.state, 'ABSENT');
  assert.equal(await hints.observe({ pr: PR, headSha: H, baseSha: B }), null, 'unchanged states write nothing');
  w.addHostedRun('gitleaks');
  w.addHostedRun('trivy', { status: 'queued' });
  const rec = await hints.observe({ pr: PR, headSha: H, baseSha: B });
  assert.deepEqual([rec.roles.gitleaks.state, rec.roles.trivy.state], ['SUCCESS', 'PENDING_QUEUED']);
  const bytes = await mailbox.latestHint(PR, H);
  assert.ok(bytes.length <= HINT_MAX_BYTES);
  const parsed = parseHint(bytes, subject);
  assert.deepEqual([parsed.roles.gitleaks.state, parsed.roles.trivy.state], ['SUCCESS', 'PENDING_QUEUED']);
  assert.equal((await fs.readdir(path.join(root, 'responses'))).filter(n => HINT_FILE.test(n)).length, 2);
  // a CI file in the PR: not eligible in hint mode already (E3), so the executor never waits for it
  w.state.changedPaths = ['.github/workflows/gitleaks.yml']; w.state.pr.changed_files = 1;
  const ne = await hints.observe({ pr: PR, headSha: H, baseSha: B });
  assert.equal(ne.roles.gitleaks.state, 'NOT_ELIGIBLE');
  // an observation that fails says nothing (no file)
  const broken = new HostedHints({ repo: REPO, observeHead: async () => { throw new Error('gh down'); }, mailbox, clock: () => T0 });
  assert.equal(await broken.observe({ pr: PR, headSha: H, baseSha: B }), null);
  // the service side reads the newest record through the companion port
  const port = mailboxCompanion(mailbox, async () => {});
  assert.equal(parseHint(await port.hostedHint(subject), subject).roles.gitleaks.state, 'NOT_ELIGIBLE');
  assert.equal(await port.hostedHint({ ...subject, headSha: 'f'.repeat(40) }), null);
});

test('mailbox hints are create-only, sequenced and bounded', async t => {
  const root = await tempRoot(t);
  const mailbox = await Mailbox.open(root, () => T0);
  const rec = roles => ({ contract: 'clued.independent-ci.hosted-hint/1', repo: REPO, pr: 7, headSha: H, observedAt: T0, roles });
  const a = await mailbox.writeHint(rec({ gitleaks: { state: 'ABSENT' } }));
  const b = await mailbox.writeHint(rec({ gitleaks: { state: 'SUCCESS' } }));
  assert.match(path.basename(a), /-000001\.json$/); assert.match(path.basename(b), /-000002\.json$/);
  assert.equal(JSON.parse(await mailbox.latestHint(7, H)).roles.gitleaks.state, 'SUCCESS');
  await assert.rejects(mailbox.writeHint(rec({ gitleaks: { state: 'NOT_ELIGIBLE', reason: 'X'.repeat(3000) } })), { code: 'HOSTED_HINT_TOO_LARGE' });
  await assert.rejects(mailbox.writeHint({ ...rec({}), pr: 0 }), { code: 'HOSTED_HINT_SUBJECT_INVALID' });
  assert.equal(await mailbox.latestHint(8, H), null);
  assert.deepEqual(validateHintConfig(undefined), { enabled: false, ciSourceManifestSha256: null });
  assert.throws(() => validateHintConfig({ enabled: true, ciSourceManifestSha256: 'x' }), { code: 'COMPANION_HINT_CONFIG_INVALID' });
  assert.throws(() => validateHintConfig({ enabled: true, ciSourceManifestSha256: 'a'.repeat(64), extra: 1 }), { code: 'COMPANION_HINT_CONFIG_INVALID' });
});

test('poller: hint mode observes each proposed head for a bounded window, a failing observation never stops triggers', async t => {
  let now = T0;
  const observed = [], triggers = [];
  const pulls = [{ number: 7, headRefOid: HEAD, baseRefOid: BASE, isDraft: false, body: 'Clued-Work-Claim: 6081c581-1fa5-4492-a4a4-dbdfe931c915', updatedAt: 'x' }];
  const run = async argv => argv.some(a => a.includes('/compare/')) ? { code: 0, stdout: JSON.stringify({ behind_by: 0, base: BASE }) }
    : argv.includes('api') ? { code: 0, stdout: BASE + '\n' } : { code: 0, stdout: JSON.stringify(pulls) };
  const hints = { async observe(s) { observed.push(s); if (observed.length === 1) throw new Error('boom'); } };
  const p = new Poller({ repo: REPO, ghExe: 'C:\\gh.exe', run: restPolls(run, { main: () => BASE, pulls: () => pulls }), writeTrigger: async v => triggers.push(v), clock: () => now, hints });
  assert.equal(await p.pass(), 1);
  assert.equal(await p.pass(), 0, 'the trigger is proposed once');
  assert.equal(observed.length, 2, 'observed on every pass inside the window, also after an error');
  now += HINT_WINDOW_MS + 1;
  await p.pass();
  assert.equal(observed.length, 2, 'not after the window');
  assert.equal(triggers.length, 1);
});

test('gh read port: fixed GET argv only, normalized replies, complete pagination, refusals for bad routes', async t => {
  const calls = [];
  const replies = new Map([
    [`repos/${REPO}/branches/main`, { name: 'main', commit: { sha: B } }],
    [`repos/${REPO}/compare/${B}...${H}?per_page=1`, { status: 'ahead', ahead_by: 1, behind_by: 0, base_commit: { sha: B }, merge_base_commit: { sha: B } }],
    [`repos/${REPO}/commits/${H}/check-runs?check_name=gitleaks-hosted&filter=all&per_page=100&page=1`, { total_count: 1, check_runs: [{ id: 5, head_sha: H, name: 'gitleaks-hosted' }] }],
    [`repos/${REPO}/check-runs/5/annotations?per_page=100&page=1`, [{ annotation_level: 'notice', title: 'clued-hosted-relay-v1', message: 'eyJ.x.y', path: '.github' }]],
  ]);
  const run = async (argv, o) => { calls.push(argv); const route = argv[argv.length - 1]; return replies.has(route) ? { code: 0, stdout: JSON.stringify(replies.get(route)) } : { code: 1, stdout: '' }; };
  const gh = createGhReadPort({ ghExe: 'C:\\Program Files\\GitHub CLI\\gh.exe', repo: REPO, run });
  assert.deepEqual(await gh.readBranchHead('main'), { name: 'main', sha: B });
  assert.equal((await gh.readCompare(B, H)).behindBy, 0);
  assert.equal((await gh.readCheckRunsByName(H, 'gitleaks-hosted')).checks.length, 1);
  assert.equal((await gh.readCheckRunAnnotations(5, 1)).annotations[0].title, 'clued-hosted-relay-v1');
  for (const argv of calls) assert.deepEqual(argv.slice(0, 6), ['C:\\Program Files\\GitHub CLI\\gh.exe', 'api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json']);
  await assert.rejects(gh.readGitCommit(H), { code: 'github_read_unavailable' });
  await assert.rejects(gh.readBranchHead('../x'), { code: 'GH_READ_SUBJECT_INVALID' });
  await assert.rejects(gh.readCheckRunAnnotations(5, 2), { code: 'incomplete_annotations' });
  assert.throws(() => createGhReadPort({ ghExe: 'gh', repo: REPO, run }), { code: 'GH_READ_PORT_CONFIG_INVALID' });
});

test('engine: stage R is derived for exactly the candidates and run as stage 9 with its rows; dynamic options drive the gates', async t => {
  const root = await tempRoot(t);
  const V2 = ['work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2'];
  const sourceRoot = path.join(root, 'source');
  await fs.mkdir(path.join(sourceRoot, ...V2), { recursive: true });
  for (const n of ['derive-batch.mjs', 'invoke-stage.mjs', 'archive-windows-spool.ps1']) await fs.writeFile(path.join(sourceRoot, ...V2, n), '// fixture');
  const SC_QC = 'BINARY_PATH_NAME   : "C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe"\r\n        START_TYPE         : 3   DEMAND_START\r\n        SERVICE_START_NAME : .\\clued-control\r\n';
  const SC_Q = 'STATE              : 1  STOPPED\r\n        PID                : 0\r\n';
  const runs = [], sent = [];
  const fact = { contract: 'clued.independent-ci.resident-stage-fact/2', stage: 9, nonce: 'n'.repeat(32), manifest_sha256: '9'.repeat(64), state: 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION',
    failure_code: null, scm_start_call_issued: true, original_binary_restored: true, complete_original_readback: true, configuration_conflict_detected: false, tree_cleanup_confirmed: true,
    tree_active_processes: 0, root_exit_confirmed: true, native_receipt_sha256: 'e'.repeat(64), outcome: null, relay: [{ role: 'trivy', outcome: 'RELAYED' }] };
  let deriveOk = true;
  const run = async argv => {
    runs.push(argv);
    if (argv[0].endsWith('sc.exe')) return { code: 0, stdout: argv[1] === 'qc' ? SC_QC : SC_Q };
    if (argv.includes('--relay-roles')) return deriveOk ? { code: 0, stdout: JSON.stringify({ status: 'RESIDENT_RELAY_STAGE_DERIVED', batchKey: 'a1'.repeat(32), batchId: 'b', stage: { number: 9, workManifestSha256: '9'.repeat(64), jobIds: ['1'.repeat(64)], runMilliseconds: 900000 } }) } : { code: 2, stdout: '{}' };
    if (argv[1].endsWith('invoke-stage.mjs')) return { code: 0, stdout: JSON.stringify(fact) };
    if (argv[0].endsWith('powershell.exe')) return { code: 0, stdout: JSON.stringify({ verified: true, directory: 'archive-x', moved: 1 }) };
    throw new Error('unexpected ' + argv.join(' '));
  };
  const companionMailbox = { async send(kind, fields) { sent.push(kind); return { kind, fields }; }, async await() { return { ok: true, code: null, verified: true }; } };
  const engine = new WindowsEngine({ node: TEST_NODE, nodeProfileSha256: TEST_NODE_SHA, run, busy: () => false, companionMailbox, sleep: async () => {}, clock: () => T0,
    paths: { sourceRoot, workRoot: path.join(root, 'work'), outboxRoot: path.join(root, 'outbox'), nodeExe: 'C:\\node.exe', powershellExe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', scExe: 'C:\\Windows\\System32\\sc.exe' } });
  const batch = { batchId: 'b', key: 'a1'.repeat(32), dir: path.join(root, 'work', 'b'), stages: [1, 2, 3, 4, 5, 6, 7, 8].map(n => ({ number: n, jobId: String(n).repeat(64).slice(0, 64), workManifestSha256: 'f'.repeat(64) })) };
  const r = await engine.runRelayStage(batch, ['trivy']);
  assert.deepEqual([r.ok, r.relay], [true, [{ role: 'trivy', outcome: 'RELAYED' }]]);
  const derive = runs.find(a => a.includes('--relay-roles'));
  assert.deepEqual(derive.slice(2), ['--relay-roles', 'trivy', '--batch-dir', batch.dir, '--batch-key', batch.key, '--batch-id', 'b']);
  assert.deepEqual(runs.find(a => a[1]?.endsWith('invoke-stage.mjs')).slice(2), ['--batch-dir', batch.dir, '--stage', '9', '--work-manifest-sha256', '9'.repeat(64), '--batch-key', batch.key]);
  assert.equal(sent.includes('relay-stage'), false, 'stage R pumps no bridge');
  await assert.rejects(engine.runRelayStage(batch, ['contract-placement']), { code: 'RESIDENT_RELAY_ROLES_INVALID' });
  deriveOk = false;
  const refused = await engine.runRelayStage(batch, ['gitleaks']);
  assert.deepEqual([refused.ok, refused.code, refused.proof.windowsTreeZero], [false, 'RELAY_STAGE_REFUSED', true]);
  // dynamic options: the first local Linux stage runs the refs gate, a later one the between-roles archive
  const stages = validatePolicy(rawPolicy()).stages;
  sent.length = 0;
  fact.stage = 6; fact.manifest_sha256 = 'f'.repeat(64); fact.relay = null;
  await engine.runStage(batch, stages[5], { betweenRoles: false, firstLinux: true });
  assert.deepEqual(sent.slice(0, 1), ['check-refs']);
  sent.length = 0; const before = runs.length;
  await engine.runStage(batch, stages[3], { betweenRoles: true, firstLinux: false });
  assert.equal(sent[0], 'archive-linux');
  assert.ok(runs.slice(before).some(a => a.includes('between-roles-4')));
  await assert.rejects(engine.runStage(batch, stages[2], { betweenRoles: true, firstLinux: false }), { code: 'RESIDENT_BETWEEN_ROLES_STAGE_INVALID' });
  sent.length = 0;
  assert.equal((await engine.closeBatch(batch, { linux: false })).verified, true);
  assert.equal(sent.includes('archive-linux'), false, 'nothing local on Linux: WSL is not touched at close');
});
