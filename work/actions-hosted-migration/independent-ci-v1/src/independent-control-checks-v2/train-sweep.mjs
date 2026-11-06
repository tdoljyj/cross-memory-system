// Merge-train sweeps and revocations of stage 10 (step 3c-2b; DESIGN §41.3, §41.6). Pure over its ports (GitHub port of
// github.mjs, the publication stream, the green ledger), tested with fakes.
//   Who is revoked (revokeTargets): every App 5368905 kooyumi-merge-slot success on a head that is not in main and is
//     not the front's current head; the front's own success when main moved outside the train (its T, from the ledger's
//     baseSha or the check's `main@<T>`, is not main's tip: a green without main@T counts as moved); every success on
//     the front's current head when an accepted revoke-head request is given.
//   Incremental sweep (every run): this node's ledgered heads whose last phase is posted, settled or merged; the heads of
//     the KooYomi publication stream (every node's publications); every pull updated since the cursor: its head, all its
//     commits, the before/after of its force pushes. No truncation: a bound reached is an incomplete sweep.
//   Full sweep (segmented over runs, cursor in train-sweep-store.mjs): every pull of the listing, oldest first. A round of
//     scope 'all' reads every pull the same as above (a pull with more than 250 commits, REST's limit, voids the round). A
//     round of scope 'current' (generation 15, Owner Decision fb39ec73 v2, options c, c1 and a; DESIGN 60) reads an open pull
//     the same way; a merged pull into main only the both ends of its force pushes (its commits are in main, the heads a
//     force push replaced are not); a merged pull into another base the same as an open one; a closed unmerged pull its
//     current head only: a green a closed pull's history keeps cannot be merged without a push or a reopen, both of which the
//     incremental sweep sees; its current head can (a reopen at once), e.g. #936's df659f1c (2026-11-06).
//     train-maintenance.mjs chooses 'all' when main was rewritten (merged heads may have left main) or no main tip is recorded.
//   Revoke one (revokeGreens): GET the run (App, name, head, success); PATCH failure with the reason; read back; read back
//     again 30 s later. Both read-backs must show this revocation; anything else is unconfirmed.
// Any read that is incomplete fails the sweep closed (never "clean").
export const SLOT_CHECK = 'kooyumi-merge-slot';
export const REVOKE_READBACK_DELAY_MS = 30_000;
// Bounds of one run (stage 10's cap is 5 minutes, SwapBroker line 10): heads looked at by the incremental sweep, the
// time spent sweeping (incremental, then a full-sweep segment), revocations (each three reads and one write, plus one
// shared 30 s wait).
export const MAX_SWEEP_HEADS = 400;
export const SWEEP_BUDGET_MS = 150_000;
export const MAX_REVOKES_PER_RUN = 20;
export const MAX_PUBLICATION_PAGES = 50;
const SHA = /^[0-9a-f]{40}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const codeOf = (e, fallback) => (/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(e?.code ?? '') ? e.code : fallback);

// A GitHub port that counts its calls (shadow statistics: calls and time of a full sweep, §41.9 item 2).
export function countedGithub(github) {
  const counter = { calls: 0 }, port = {};
  for (let o = github; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
    for (const k of Object.getOwnPropertyNames(o))
      if (k !== 'constructor' && !Object.hasOwn(port, k) && typeof github[k] === 'function') port[k] = (...a) => { counter.calls++; return github[k](...a); };
  return { github: Object.freeze(port), counter };
}

// The publication stream's heads (KooYomi work_claim_publications_v1 through the Native verify action revocations_list,
// the channel stage 12 already uses): every page, complete or refused. command: entry-runtime controllerPorts native.command.
export function publicationHeads({ command, scope, repository }) {
  return Object.freeze({ async heads() {
    const heads = new Set(); let cursor = null;
    for (let page = 0; page < MAX_PUBLICATION_PAGES; page++) {
      const reply = await command({ action: 'revocations_list', scope, ...(cursor ? { publication_cursor: cursor } : {}) });
      if (reply?.status !== 'ok' || !Array.isArray(reply.publications) || reply.publications.length > 100 || !Object.hasOwn(reply, 'next_publication_cursor')) fail('TRAIN_PUBLICATIONS_UNREADABLE');
      for (const p of reply.publications) {
        if (typeof p?.repository !== 'string') fail('TRAIN_PUBLICATIONS_UNREADABLE');
        if (p.repository !== repository) continue;
        if (!SHA.test(p.head_sha ?? '')) fail('TRAIN_PUBLICATIONS_UNREADABLE');
        heads.add(p.head_sha);
      }
      const next = reply.next_publication_cursor;
      if (next === null) return { complete: true, heads: [...heads] };
      if (typeof next !== 'string' || !next || (cursor && next <= cursor)) fail('TRAIN_PUBLICATIONS_UNREADABLE');
      cursor = next;
    }
    fail('TRAIN_PUBLICATIONS_UNREADABLE');
  } });
}

// The ledger's live greens: last phase per (head, check run) is posted, settled or merged. -> Map checkRunId -> entry.
export function ledgerGreens(entries) {
  const last = new Map();
  for (const { entry } of entries ?? []) if (entry?.checkRunId) last.set(entry.checkRunId, entry);
  return new Map([...last].filter(([, e]) => ['posted', 'settled', 'merged'].includes(e.phase)));
}

const MAIN_AT = /\bmain@([0-9a-f]{40})\b/;
// Pure. greens: [{checkRunId, headSha, summary}] (successes only); inMain: head -> true|false|null; front: {headSha} | null;
// own: Map checkRunId -> ledger entry. -> { targets: [{checkRunId, headSha, reason, own}], unknown: [head] }.
export function revokeTargets({ greens, inMain, front, mainSha, own, revokeHead = false }) {
  const targets = [], unknown = new Set();
  for (const g of greens) {
    const contained = inMain.get(g.headSha);
    if (contained === true) continue;
    if (contained !== false) { unknown.add(g.headSha); continue; }
    let reason = 'NOT_FRONT_HEAD';
    if (front?.headSha === g.headSha) {
      const base = own.get(g.checkRunId)?.baseSha ?? MAIN_AT.exec(g.summary ?? '')?.[1] ?? null;
      if (revokeHead) reason = 'REVOKE_HEAD_REQUEST';
      else if (base !== mainSha) reason = 'MAIN_MOVED_OUTSIDE_TRAIN';
      else continue;
    }
    targets.push({ checkRunId: g.checkRunId, headSha: g.headSha, reason, own: own.has(g.checkRunId) });
  }
  return { targets: targets.sort((a, b) => a.checkRunId - b.checkRunId), unknown: [...unknown] };
}

// One run's sweeper: GitHub reads with a cache of heads already known to be in main, a time bound and counters.
export function createSweeper({ github, appId, mainSha, inMain = [], clock = Date.now, until = Infinity, strictCoverage = false }) {
  const contained = new Map(inMain.map(h => [h, true]));
  const comparisons = new Map();
  const stats = { heads: 0, prs: 0, commits: 0, ...(strictCoverage ? { deferred: 0, eligible: 0 } : {}) };
  const late = () => clock() > until;
  async function comparison(head) {
    if (!comparisons.has(head)) comparisons.set(head, await github.readCompare(mainSha, head));
    return comparisons.get(head);
  }
  // Direction matters: strict main is contained by H, not H contained by main. Unknown comparisons never defer a green.
  async function eligibleOf(head) {
    try {
      const c = await comparison(head);
      if (!Number.isSafeInteger(c?.aheadBy) || c.aheadBy < 0 || !Number.isSafeInteger(c?.behindBy) || c.behindBy < 0
        || !['ahead', 'behind', 'identical', 'diverged'].includes(c.status)
        || (c.status === 'identical' && (c.aheadBy !== 0 || c.behindBy !== 0))
        || (c.status === 'ahead' && (c.aheadBy === 0 || c.behindBy !== 0))
        || (c.status === 'behind' && (c.aheadBy !== 0 || c.behindBy === 0))
        || (c.status === 'diverged' && (c.aheadBy === 0 || c.behindBy === 0))) fail('TRAIN_STRICT_COMPARE_UNREADABLE');
      return c.behindBy === 0 && ['ahead', 'identical'].includes(c.status);
    } catch { fail('TRAIN_STRICT_COMPARE_UNREADABLE'); }
  }
  async function inMainOf(head) {
    if (contained.has(head)) return contained.get(head);
    try { const c = await comparison(head); contained.set(head, c.aheadBy === 0 && ['behind', 'identical'].includes(c.status)); }
    // GitHub's compare answers 404 for a commit it no longer has (an old head after a force push, collected) and for one
    // with no common ancestor with main: neither is in main, so it is judged "not in main" (revoking is the stricter side;
    // review R2 minor 9). Every other failure stays unknown.
    catch (e) { contained.set(head, e?.code === 'github_http_404' ? false : null); }
    return contained.get(head);
  }
  // Successes of App appId's kooyumi-merge-slot on one head (every run of the name, complete or refused).
  async function greensOf(head) {
    const listed = await github.readOwnChecksByName(head, SLOT_CHECK);
    if (listed?.complete !== true || !Array.isArray(listed.checks)) fail('TRAIN_CHECKS_UNREADABLE');
    return listed.checks.filter(c => c?.app?.id === appId && c.name === SLOT_CHECK && c.head_sha === head && c.status === 'completed' && c.conclusion === 'success')
      .map(c => ({ checkRunId: c.id, headSha: head, summary: typeof c.output?.summary === 'string' ? c.output.summary : null }));
  }
  // Every head of one pull: all commits (the current head among them) and both ends of every force push.
  async function headsOfPull(number) {
    const listed = await github.readPullCommitsBounded(number);
    if (listed.tooMany) return { tooMany: true, heads: [] };
    if (listed.complete !== true) fail('TRAIN_PULL_COMMITS_INCOMPLETE');
    const pushes = await github.readForcePushes(number);
    if (pushes?.complete !== true) fail('TRAIN_FORCE_PUSHES_INCOMPLETE');
    const heads = new Set([listed.headSha, ...listed.commits]);
    for (const e of pushes.events) for (const h of [e.before, e.after]) if (h) heads.add(h);
    stats.prs++; stats.commits += listed.commits.length;
    return { tooMany: false, heads: [...heads] };
  }
  // Both ends of every force push of one pull, and nothing else (generation 15: a merged pull into main, whose commits are in main).
  async function forcePushHeadsOfPull(number) {
    const pushes = await github.readForcePushes(number);
    if (pushes?.complete !== true) fail('TRAIN_FORCE_PUSHES_INCOMPLETE');
    const heads = new Set();
    for (const e of pushes.events) for (const h of [e.before, e.after]) if (h) heads.add(h);
    stats.prs++;
    return { tooMany: false, heads: [...heads] };
  }
  // Greens of these heads -> revocation targets; heads whose containment is unknown make the pass incomplete.
  async function judge(heads, { front, own, revokeHead }) {
    const greens = [];
    for (const h of heads) {
      if (contained.get(h) === true) continue;
      if (late()) fail('TRAIN_SWEEP_TIME_BOUND');
      stats.heads++;
      if (strictCoverage) {
        if (!(await eligibleOf(h))) { stats.deferred++; continue; }
        stats.eligible++;
      }
      const found = await greensOf(h);
      if (found.length) { await inMainOf(h); greens.push(...found); }
    }
    const r = revokeTargets({ greens, inMain: contained, front, mainSha, own, revokeHead });
    if (r.unknown.length) fail('TRAIN_MAIN_CONTAINMENT_UNREADABLE');
    return r.targets;
  }
  return Object.freeze({ stats, late, judge, headsOfPull, forcePushHeadsOfPull, inMainOf, eligibleOf, knownInMain: h => contained.get(h) === true,
    inMain: () => [...contained].filter(([, v]) => v === true).map(([h]) => h) });
}

// Incremental sweep. ledger: GreenLedger list() entries; stream: { complete, heads } | null (unreadable); cursor: ISO | null
// (no cursor: the pulls part waits for the full sweep); until: this part's own time bound (the sweeper's still holds).
// Steps, each judged whole: this node's ledgered heads, the front's head and the stream's heads; then the pulls updated
// since the cursor, oldest first, one updated_at instant at a time. `progress` is the updated_at up to which every pull was
// judged: the next run resumes there (readPullsUpdatedSince is inclusive, so that instant is read again, never skipped),
// so a long backlog advances run by run (review R2 M2). The head bound counts only heads not already known to be in main,
// and the first pull step of a run is always taken, so one large pull cannot stop the sweep for ever (the time bound holds).
// A step that fails ends the pass incomplete; the targets of the steps before it stand. -> { complete, reason, targets,
// newest (complete only), progress }.
export async function incrementalSweep({ sweeper, github, entries, stream, cursor, front, own, revokeHead = false, until = Infinity, clock = Date.now }) {
  const targets = [], judged = new Set();
  let reason = null, progress = null, newest = null;
  const late = () => sweeper.late() || clock() > until;
  const fresh = heads => [...new Set(heads)].filter(h => !judged.has(h) && !sweeper.knownInMain(h));
  const take = async heads => { targets.push(...await sweeper.judge(heads, { front, own, revokeHead })); for (const h of heads) judged.add(h); };
  const base = [...[...ledgerGreens(entries).values()].map(e => e.headSha), ...(front?.headSha ? [front.headSha] : [])];
  try {
    if (stream?.complete === true) base.push(...stream.heads); else reason = 'TRAIN_PUBLICATIONS_UNREADABLE';
    if (late()) fail('TRAIN_SWEEP_TIME_BOUND');
    await take(fresh(base));
    if (cursor) {
      const updated = await github.readPullsUpdatedSince(cursor);
      if (updated?.complete !== true) fail('TRAIN_PULLS_INCOMPLETE');
      const pulls = [...updated.pulls].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.number - b.number);
      for (let i = 0, first = true; i < pulls.length; first = false) {
        let j = i;
        while (j < pulls.length && Date.parse(pulls[j].updatedAt) === Date.parse(pulls[i].updatedAt)) j++;
        if (late()) fail('TRAIN_SWEEP_TIME_BOUND');
        const heads = [];
        for (const p of pulls.slice(i, j)) {
          const r = await sweeper.headsOfPull(p.number);
          if (r.tooMany) fail('TRAIN_PULL_OVER_250_COMMITS');
          heads.push(...r.heads);
        }
        const step = fresh(heads);
        if (!first && judged.size + step.length > MAX_SWEEP_HEADS) fail('TRAIN_SWEEP_HEAD_BOUND');
        await take(step);
        progress = pulls[i].updatedAt; i = j;
      }
      newest = updated.newest;
    } else {
      newest = (await github.readPullsPage({ state: 'all', sort: 'updated', direction: 'desc', page: 1, perPage: 1 })).pulls[0]?.updatedAt ?? null;
    }
  } catch (e) { reason ??= codeOf(e, 'TRAIN_SWEEP_INCOMPLETE'); return { complete: false, reason, targets, newest: null, progress }; }
  return reason ? { complete: false, reason, targets, newest: null, progress } : { complete: true, reason: null, targets, newest: newest ?? cursor, progress };
}

// The heads the full sweep judges for one listed pull. Scope 'all': every pull's every head. Scope 'current': an open pull's
// every head; a merged pull's force-push ends (into main) or every head (into another base); a closed unmerged pull's current
// head. -> { tooMany, heads }.
export async function fullSweepHeads(sweeper, pull, scope = 'current') {
  if (scope === 'all' || pull.state === 'open') return sweeper.headsOfPull(pull.number);
  if (pull.state === 'closed' && pull.merged === true) return pull.baseRef === 'main' ? sweeper.forcePushHeadsOfPull(pull.number) : sweeper.headsOfPull(pull.number);
  if (pull.state === 'closed' && pull.merged === false) { sweeper.stats.prs++; return { tooMany: false, heads: [pull.headSha] }; }
  fail('TRAIN_PULLS_INCOMPLETE');
}

// One full-sweep segment from the cursor {nextPage, nextIndex}: pulls oldest first (open and closed: the listing only grows at
// its end, so the cursor stays stable), until the time bound or the revoke cap would be passed. -> { ok, reason, tooMany,
// targets, nextPage, nextIndex, reachedEnd }. A pull is consumed whole or not at all, so the cursor never splits one.
export async function fullSweepSegment({ sweeper, github, nextPage, nextIndex, front, own, scope = 'all', revokeCap = MAX_REVOKES_PER_RUN }) {
  if (!['all', 'current'].includes(scope)) fail('TRAIN_FULL_SWEEP_SCOPE_INVALID');
  const targets = [];
  let page = nextPage, index = nextIndex;
  try {
    for (;;) {
      const reply = await github.readPullsPage({ state: 'all', sort: 'created', direction: 'asc', page });
      if (reply?.complete !== true || reply.page !== page || !Array.isArray(reply.pulls) || typeof reply.last !== 'boolean') fail('TRAIN_PULLS_INCOMPLETE');
      for (; index < reply.pulls.length; index++) {
        if (sweeper.late()) return { ok: true, reason: null, tooMany: false, targets, nextPage: page, nextIndex: index, reachedEnd: false };
        const r = await fullSweepHeads(sweeper, reply.pulls[index], scope);
        if (r.tooMany) return { ok: false, reason: 'TRAIN_PULL_OVER_250_COMMITS', tooMany: true, targets: [], nextPage, nextIndex, reachedEnd: false };
        const found = await sweeper.judge(r.heads, { front, own });
        if (targets.length + found.length > revokeCap && targets.length > 0) return { ok: true, reason: null, tooMany: false, targets, nextPage: page, nextIndex: index, reachedEnd: false };
        targets.push(...found);
      }
      if (reply.last) return { ok: true, reason: null, tooMany: false, targets, nextPage: page, nextIndex: index, reachedEnd: true };
      page++; index = 0;
    }
  } catch (e) {
    if (e?.code === 'TRAIN_SWEEP_TIME_BOUND') return { ok: true, reason: null, tooMany: false, targets, nextPage: page, nextIndex: index, reachedEnd: false };
    // a stable upper-case code (GitHub's own codes such as github_http_502 stay in the observation log, not in the facts)
    return { ok: false, reason: /^[A-Z][A-Z0-9_]{1,79}$/.test(e?.code ?? '') ? e.code : 'TRAIN_SWEEP_INCOMPLETE', tooMany: false, targets: [], nextPage, nextIndex, reachedEnd: false };
  }
}

export const revocationBody = (t, mainSha) => ({ status: 'completed', conclusion: 'failure', output: { title: 'Merge train revoked this green',
  summary: `kooyumi-merge-slot revoked by the merge train (${t.reason}): head ${t.headSha} is not the front's green on main@${mainSha}. A new green needs a new front batch.` } });

// Revoke each target and confirm it twice (§41.3 "撤一条"). ledger: GreenLedger (own targets get a `revoked` record whose
// detail carries both read-back times); own: Map checkRunId -> ledger entry. sleep is injected (tests).
// -> { revoked: [{checkRunId, headSha, reason, firstAt, secondAt}], unconfirmed: [{checkRunId, code}], sideEffects, ledgerFailures }.
// writeUntil / readUntil (review R2 minor 5): no revocation is started after writeUntil and no second read-back is made after
// readUntil; what is left is unconfirmed (TRAIN_REVOKE_DEADLINE), so the stage ends inside its cap with its facts.
export async function revokeGreens({ github, targets, appId, mainSha, ledger, own, clock = Date.now, sleep, delayMs = REVOKE_READBACK_DELAY_MS, writeUntil = Infinity, readUntil = Infinity,
  pendingStore = null, pendingJob = null }) {
  const pending = [], unconfirmed = [];
  let durable = [], legacyUnconfirmed = 0, legacySince = null;
  if (pendingStore && targets.length > 0) {
    try {
      const previous = await pendingStore.readPendingRevocations();
      if (previous && previous.repo !== pendingJob.repo) fail('TRAIN_PENDING_REVOCATIONS_UNREADABLE');
      if (previous && Date.parse(previous.writtenAt) > clock()) fail('TRAIN_PENDING_REVOCATIONS_UNREADABLE');
      if (previous && Date.parse(previous.writtenAt) === clock()) await sleep(1);
      legacyUnconfirmed = previous?.legacyUnconfirmed ?? 0; legacySince = previous?.legacySince ?? null;
      durable = [...new Map([...(previous?.targets ?? []), ...targets].map(t => [t.checkRunId, t])).values()];
      if (durable.length > MAX_REVOKES_PER_RUN) fail('TRAIN_PENDING_REVOCATIONS_CAP');
      await pendingStore.writePendingRevocations({ repo: pendingJob.repo, writtenAt: new Date(clock()).toISOString(), runId: pendingJob.runId,
        targets: durable, legacyUnconfirmed, legacySince });
    } catch {
      return { revoked: [], unconfirmed: targets.map(t => ({ checkRunId: t.checkRunId, code: 'TRAIN_PENDING_REVOCATIONS_UNWRITTEN' })),
        sideEffects: 0, ledgerFailures: 0, pendingStateFailed: true };
    }
  }
  let sideEffects = 0;
  const shows = (c, t, body) => c?.id === t.checkRunId && c.appId === appId && c.name === SLOT_CHECK && c.headSha === t.headSha && c.status === 'completed' && c.conclusion === 'failure'
    && (body === null || (c.title === body.output.title && c.summary === body.output.summary));
  for (const t of targets) {
    if (clock() > writeUntil) { unconfirmed.push({ checkRunId: t.checkRunId, code: 'TRAIN_REVOKE_DEADLINE' }); continue; }
    try {
      const before = await github.readCheckRun(t.checkRunId);
      if (before?.id !== t.checkRunId || before.appId !== appId || before.name !== SLOT_CHECK || before.headSha !== t.headSha || before.status !== 'completed') fail('TRAIN_REVOKE_SUBJECT_CHANGED');
      // already failure: recorded as revoked once both read-backs show it (no write)
      let body = null;
      if (before.conclusion === 'success') {
        body = revocationBody(t, mainSha);
        sideEffects++;
        await github.revokeCheck(t.checkRunId, body);
      } else if (before.conclusion !== 'failure') fail('TRAIN_REVOKE_SUBJECT_CHANGED');
      const first = body === null ? before : await github.readCheckRun(t.checkRunId);
      if (!shows(first, t, body)) fail('TRAIN_REVOKE_FIRST_READBACK_REFUSED');
      pending.push({ t, body, firstAt: clock() });
    } catch (e) { unconfirmed.push({ checkRunId: t.checkRunId, code: codeOf(e, 'TRAIN_REVOKE_UNCONFIRMED') }); }
  }
  if (pending.length) {
    const wait = pending[pending.length - 1].firstAt + delayMs - clock();
    if (wait > 0) await sleep(wait);
  }
  const revoked = [];
  let ledgerFailures = 0;
  for (const { t, body, firstAt } of pending) {
    try {
      if (clock() > readUntil) fail('TRAIN_REVOKE_DEADLINE');
      if (clock() - firstAt < delayMs) fail('TRAIN_REVOKE_SECOND_READBACK_EARLY');
      if (!shows(await github.readCheckRun(t.checkRunId), t, body)) fail('TRAIN_REVOKE_SECOND_READBACK_REFUSED');
    } catch (e) { unconfirmed.push({ checkRunId: t.checkRunId, code: codeOf(e, 'TRAIN_REVOKE_UNCONFIRMED') }); continue; }
    const r = { checkRunId: t.checkRunId, headSha: t.headSha, reason: t.reason, firstAt: new Date(firstAt).toISOString(), secondAt: new Date(clock()).toISOString() };
    revoked.push(r);
    const entry = own?.get(t.checkRunId);
    if (entry && ledger) {
      // the ledger only records: a failed write leaves the green listed, and the next sweep finds it already revoked
      try { await ledger.append({ phase: 'revoked', job: { repo: entry.repo, pr: entry.pr, headSha: entry.headSha, baseSha: entry.baseSha }, testTree: entry.testTree,
        testMergeSha: entry.testMergeSha, effectKey: entry.effectKey, externalId: entry.externalId, checkRunId: t.checkRunId,
        detail: `revoked2:${r.firstAt},${r.secondAt};${t.reason}` }); } catch { ledgerFailures++; }
    }
  }
  let pendingStateFailed = false;
  if (pendingStore && targets.length > 0) {
    const confirmed = ledgerFailures === 0 ? new Set(revoked.map(t => t.checkRunId)) : new Set();
    const remaining = durable.filter(t => !confirmed.has(t.checkRunId));
    if (remaining.length !== durable.length) try {
      await pendingStore.writePendingRevocations({ repo: pendingJob.repo, writtenAt: new Date(clock()).toISOString(), runId: pendingJob.runId,
        targets: remaining, legacyUnconfirmed, legacySince });
    } catch { pendingStateFailed = true; }
  }
  return { revoked, unconfirmed: unconfirmed.sort((a, b) => a.checkRunId - b.checkRunId), sideEffects, ledgerFailures, pendingStateFailed };
}
