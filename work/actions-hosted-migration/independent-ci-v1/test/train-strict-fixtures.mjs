// Offline ports shared by the strict coverage and scheduler-to-publisher integration tests. No production access.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runTrain } from '../src/independent-control-checks-v2/train-maintenance.mjs';
import { TrainSweepStore } from '../src/independent-control-checks-v2/train-sweep-store.mjs';
import { GreenLedger } from '../src/independent-control-checks-v2/green-ledger.mjs';
import { TRAIN_RUN_SHADOW_DEFAULTS, makeTrainRun } from '../src/resident-v2/train-run.mjs';
import { tempDir } from './resident-v2-fixtures.mjs';
import { resolvePRTaskBinding } from '../../../../scripts/ci/clued-pr-task-binding.mjs';

const REPO = 'tdoljyj/cross-memory-system', APP = 5368905, SLOT = 'kooyumi-merge-slot';
const sha = n => n.toString(16).padStart(40, '0');
const T = sha(0x7001), H = sha(0x7002), S = sha(0x7003), TREE = sha(0x7004), OLD_T = sha(0x7005);
const CLAIM = '11111111-2222-4333-8444-555555555555', RUN = '0123456789abcdef-0123456789ab', SOURCE = 'e'.repeat(64);
const NOW = Date.parse('2026-10-31T06:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const ON_SINCE = iso(NOW - 3_600_000), CURSOR = iso(NOW - 600_000);
const jobOf = (o = {}) => makeTrainRun({ repo: REPO, runId: RUN, mode: 'on', sourceManifestSha256: SOURCE, createdAt: iso(NOW), ...TRAIN_RUN_SHADOW_DEFAULTS,
  onSince: ON_SINCE, frontBatchBudgetMs: 1_800_000, ...o });
const summaryOf = base => `front PR #910, head ${H}, main@${base}, tested ${S} (tree ${TREE})`;

// ---- fakes ----
function fakeGithub(e, w) {
  const world = { main: T, inMain: new Set(), checks: new Map(), pulls: new Map(), commits: new Map([[S, { sha: S, tree: TREE, parents: [T, H] }]]), hooks: {}, ...w };
  const call = name => { e.now += e.tick; world.calls.push(name); };
  world.calls = []; world.writes = []; world.reads = new Map();
  const norm = c => ({ id: c.id, appId: c.app.id, name: c.name, headSha: c.head_sha, status: c.status, conclusion: c.conclusion, title: c.output?.title ?? null, summary: c.output?.summary ?? null });
  const row = p => ({ number: p.number, state: p.state, updatedAt: p.updated, headSha: p.head, baseRef: p.base ?? 'main', merged: !!p.merged });
  const gh = {
    world,
    async readChangedPaths(job) { return { complete: true, pr: job.pr, headSha: job.headSha, baseSha: job.baseSha, paths: ['a.txt'] }; },
    async createCheck(body) { const id = Math.max(100, ...world.checks.keys()) + 1; const c = { id, app: { id: APP }, ...structuredClone(body) }; world.checks.set(id, c); world.hooks.create?.(c); return structuredClone(c); },
    async readBranchHead(name) { call('branch'); return { name, sha: world.main }; },
    async readBranchRules() { call('rules'); return { complete: true, branch: 'main', rules: [{ type: 'pull_request', parameters: { allowed_merge_methods: ['merge'] } },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: world.strict === true, required_status_checks: ['kooyumi-work-admission', 'gitleaks', 'trivy',
        'contract-placement', 'kooyumi-admission-verified', SLOT].map(context => ({ context, integration_id: APP })) } }] }; },
    async readPullRequest(n) { call('pull'); const p = world.pulls.get(n); return { number: n, state: p.state, draft: false, merged: !!p.merged, mergeable: true,
      merge_commit_sha: p.mergeCommitSha ?? null, head: { sha: p.head }, base: { ref: p.base ?? 'main', sha: world.main } }; },
    async readCompare(base, head) {
      call('compare');
      const hooked = world.hooks.compare?.(base, head);
      if (hooked instanceof Error) throw hooked;
      if (hooked) return hooked;
      // The ends GitHub's compare names, as github.mjs#readCompare returns them.
      const ends = { baseSha: base, headSha: head, mergeBaseSha: base };
      if (world.behindHeads?.has(head)) return { ...ends, status: 'diverged', aheadBy: 1, behindBy: 1 }; return world.inMain.has(head) ? { ...ends, status: 'behind', aheadBy: 0, behindBy: 1 } : { ...ends, status: 'ahead', aheadBy: 1, behindBy: 0 }; },
    async readGitCommit(s) { call('commit'); return structuredClone(world.commits.get(s)); },
    async readChecks(head) { call('checks'); return { complete: true, checks: [...world.checks.values()].filter(c => c.head_sha === head).map(c => structuredClone(c)) }; },
    async readOwnChecksByName(head, name) {
      call('own'); world.hooks.own?.(head);
      return { complete: true, checks: [...world.checks.values()].filter(c => c.head_sha === head && c.name === name && c.app.id === APP).map(c => structuredClone(c)) };
    },
    async readCheckRun(id) {
      call('run'); const n = (world.reads.get(id) ?? 0) + 1; world.reads.set(id, n);
      const c = world.checks.get(id); if (!c) throw Object.assign(new Error('github_http_404'), { code: 'github_http_404' });
      return world.hooks.run?.(id, n, norm(c)) ?? norm(c);
    },
    async revokeCheck(id, body) {
      call('revoke'); world.writes.push(id); world.hooks.revoke?.(id);
      const c = world.checks.get(id); c.conclusion = body.conclusion; c.output = structuredClone(body.output); return { id };
    },
    async readPullsPage({ state = 'all', sort = 'updated', page = 1, perPage = 100 }) {
      call(`pulls-${sort}`); world.hooks.pullsPage?.(sort, page);
      let list = [...world.pulls.values()].filter(p => state === 'all' || p.state === state);
      list = sort === 'created' ? list.sort((a, b) => a.number - b.number) : list.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
      const slice = list.slice((page - 1) * perPage, page * perPage);
      return { complete: true, page, pulls: slice.map(row), last: slice.length < perPage };
    },
    async readPullsUpdatedSince(since) {
      call('updated');
      const pulls = [...world.pulls.values()].filter(p => Date.parse(p.updated) >= Date.parse(since)).sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated)).map(row);
      return { complete: world.hooks.updatedIncomplete ? false : true, pulls, newest: pulls[0]?.updatedAt ?? null };
    },
    async readPullCommitsBounded(n) {
      call('commits'); const p = world.pulls.get(n), commits = p.commits ?? [p.head];
      if (commits.length > 250) return { complete: false, tooMany: true, count: commits.length, headSha: p.head, commits: [] };
      return { complete: true, tooMany: false, count: commits.length, headSha: p.head, commits: [...commits] };
    },
    async readForcePushes(n) { call('pushes'); world.hooks.pushes?.(n); return { complete: world.pulls.get(n).pushesIncomplete !== true, events: structuredClone(world.pulls.get(n).forcePushes ?? []) }; },
  };
  gh.green = (id, head, o = {}) => world.checks.set(id, { id, app: { id: o.app ?? APP }, name: o.name ?? SLOT, head_sha: head, status: 'completed', conclusion: o.conclusion ?? 'success',
    output: { title: 'Complete Native control', summary: o.summary ?? summaryOf(world.main) } });
  gh.pull = (number, o = {}) => world.pulls.set(number, { number, state: 'open', updated: iso(NOW - 3_600_000), head: sha(0x8000 + number), ...o });
  return gh;
}
const holderOf = (o = {}) => ({ claimId: CLAIM, taskId: CLAIM, boundPrs: [`${REPO}#910`], prs: [910], boundPr: `${REPO}#910`, pr: 910, mergeSlotUntil: iso(NOW + 600_000), takenAt: iso(NOW - 300_000), ciState: null, ciHeadSha: null, hardCapUntil: null, ...o });
function fakeNative(e, o = {}) {
  const n = { ...o, calls: [], holder: holderOf(o.holder), onDuty: o.onDuty ?? true, reread: o.reread ?? null, moveUntil: o.moveUntil ?? true };
  n.port = {
    async resolvePRBinding(expected) {
      n.calls.push(['resolve-pr', expected]);
      return resolvePRTaskBinding({ ...expected, command: async () => {
        const v = n.bindings?.get(expected.prNumber), state = v?.state ?? (v ? 'bound' : 'unbound');
        const hasTask = ['bound', 'no_live_claim', 'handover_pending', 'head_not_authorized'].includes(state);
        const hasClaim = ['bound', 'handover_pending', 'head_not_authorized'].includes(state);
        const task = v?.taskId ?? v?.claimId ?? '11111111-2222-4333-8444-666666666666', scope = v?.scope ?? expected.scope;
        return { status: 'ok', binding_status: state, reason: null, repository: expected.repository,
          pr_number: expected.prNumber, pr_ref: `${expected.repository}#${expected.prNumber}`, head_sha: expected.headSha,
          base_sha: expected.baseSha, target_branch: expected.targetBranch, scope, task_id: hasTask ? task : null,
          claim: hasClaim ? { claim_id: v?.claimId ?? CLAIM, task_id: task, context_key: scope, fence: 3, execution_epoch: 1,
            lease_version: 1, expires_at: iso(e.now + 7_200_000), status: 'ACTIVE', execution_handover_pending: state === 'handover_pending' } : null,
          head_authorization_id: v?.headAuthorizationId ?? (v?.auto_bound ? CLAIM : null), auto_bound: v?.auto_bound ?? false, receipt_id: v?.auto_bound ? CLAIM : null };
      } });
    },
    async holders() {
      n.calls.push(['holders']);
      const count = n.calls.filter(c => c[0] === 'holders').length;
      const duty = count > 1 && n.reread !== null ? n.reread : n.onDuty;
      if (!duty) return { onDuty: false, holders: [] };
      return { onDuty: true, holders: n.holders ?? [n.holder] };
    },
    // ci_nodes_status (Source A): not deployed unless the test names nodes; `status` overrides the whole answer
    async nodesStatus() {
      n.calls.push(['nodes']);
      if (n.status instanceof Error) throw n.status;
      if (n.status) return n.status;
      return n.nodes === undefined ? { onDuty: null, deployed: false, nodes: null, dropped: 0, sweepWatermark: null }
        : { onDuty: true, deployed: true, nodes: n.nodes, dropped: n.dropped ?? 0, sweepWatermark: n.watermark ?? null };
    },
    async touch(i) {
      n.calls.push(['touch', i]);
      if (i.ciState === 'running' && n.moveUntil) n.holder = { ...n.holder, mergeSlotUntil: iso(e.now + 90 * 60_000), ciState: 'running', ciHeadSha: i.headSha };
      return { onDuty: true, touched: true, until: n.holder.mergeSlotUntil, claims: [CLAIM], returned: i.ciState === 'failed' ? true : null };
    },
    async adopt(i) { n.calls.push(['adopt', i]); return { onDuty: true, adopted: true, returned: [] }; },
    async returnSlot(i) { n.calls.push(['return', i]); return { onDuty: true, returned: true, claims: [CLAIM] }; },
    async keepalive(i) { n.calls.push(['keepalive', i]); return { onDuty: true, keptAlive: [{ claimId: CLAIM, boundPr: `${REPO}#910`, expiresAt: n.expiresAt ?? iso(e.now + 7_200_000) }] }; },
    async reportSweepWatermark(i) { n.calls.push(['watermark', i]); return { onDuty: true, recorded: n.recorded ?? false, reason: n.recorded ? null : 'SWEEP_WATERMARK_NOT_DEPLOYED' }; },
  };
  n.kinds = () => n.calls.map(c => c[0]);
  return n;
}

async function setup(t, o = {}) {
  const e = { now: NOW, tick: o.tick ?? 0, stream: o.stream ?? [] };
  e.clock = () => e.now;
  e.sleep = async ms => { e.now += ms; };
  e.gh = fakeGithub(e, { ...o.world, strict: o.strict === true });
  e.gh.pull(910, { head: H, mergeCommitSha: S, updated: iso(NOW - 7_200_000), ...(o.front ?? {}) });
  e.native = fakeNative(e, o.native);
  const root = await tempDir(t, 'clued-sweep-');
  e.ledger = new GreenLedger((await GreenLedger.open(path.join(root, 'ledger'))).directory, () => e.now);
  e.store = await TrainSweepStore.open(path.join(root, 'sweep'));
  e.publications = { async heads() { if (e.streamDown) throw new Error('down'); return { complete: true, heads: e.stream }; } };
  if (o.fullDone !== false) await e.store.writeFullSweep({ writtenAt: iso(NOW - 1000), runId: RUN, mode: 'on', incrementalCursor: CURSOR, inMain: [],
    full: { ...FULL0, state: 'complete', via: 'sweep', startedAt: iso(NOW - 1_800_000), completedAt: iso(NOW - 1_200_000), onSince: ON_SINCE, mainSha: T } });
  e.run = (job = jobOf(o.job)) => runTrain({ job, github: e.gh, native: e.native.port, ledger: e.ledger, sweepStore: e.store, publications: e.publications, clock: e.clock, sleep: e.sleep });
  return e;
}
const FULL0 = { state: 'none', via: null, startedAt: null, completedAt: null, onSince: null, mainSha: null, nextPage: 1, nextIndex: 0, prs: 0, commits: 0, heads: 0,
  revoked: 0, unconfirmed: 0, wouldRevoke: 0, calls: 0, ms: 0, reason: null };
let keyN = 0;
async function ledgered(ledger, { pr = 900, headSha, baseSha = T, checkRunId, phase = 'settled', detail = null }) {
  const job = { repo: REPO, pr, headSha, baseSha }, effectKey = createHash('sha256').update(`k${checkRunId}:${keyN++}`).digest('hex'), externalId = `independent-ci:control:${checkRunId}`;
  await ledger.append({ phase: 'intent', job, testTree: TREE, effectKey, externalId });
  await ledger.append({ phase, job, testTree: TREE, effectKey, externalId, checkRunId, detail });
  return effectKey;
}


export { setup, jobOf, holderOf, ledgered, fakeGithub, fakeNative, sha, iso, T, H, S, TREE, OLD_T, CLAIM, RUN, SOURCE, REPO, APP, SLOT, NOW, ON_SINCE, CURSOR, FULL0 };
