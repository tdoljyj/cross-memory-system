// The driver of the train's property test (FABLE-defect-remediation-plan-20261124 §3.8 steps 1-3, cluster H), over the world of
// train-landing-e2e (train-landing-world.mjs): the real stage 10 (runTrain), the real stage-8 publisher, the real stage-1 admission,
// the real resident executor, queue and poller.
//   a read point: one function through which stage 1, 8 or 10 (or the poller beside them) reads state it does not own: GitHub
//     (rules, a PR, checks, commits), Native (the slot holders, the nodes), the sweep store (proofs and the train's own records), the
//     green ledger, the stage's batch-route file, the status file the poller reads.
//   an injection: every call of one read point, from one stage (or from every stage: scope 'tick'), fails during one round, the first
//     round after the arm in which that stage calls it. error: the read throws; empty: it answers with nothing in it; twin: a second
//     record of the same millisecond with another meaning lies beside the newest one (a state on disk: it stays until someone removes it).
//   the property: within N rounds after the injection every PR has landed, or the node stands in an explicit final state: HALT with a
//     code of the failure table, or PAUSE with a reason. Neither: a silent stall.
// A round is what the service does in a minute: one poller pass, one executor tick, the clock a minute on.
// Where the scene is the fixture's and not the product's (the verdict of a case that ends there is the fixture's, and the table says so):
//   - the fixture runs a stage in this process, with no stage entry around it. A stage that throws is answered here as the real entry
//     answers a throw (entry-runtime.mjs#runEntry: BLOCKED, reason safeReason(error), no side effects; stage 10 after a write, by
//     settleTrain: UNCERTAIN with the count), and the engine hands that reason over as the stage's code, with a clean proof.
//   - a stage that answers without throwing hands over the code the fixture makes of it: stage 1 says NATIVE_NOT_ADMITTED with no reason
//     code for every answer but ADMITTED, stage 8 the publisher's own reason.
//   - HALT codes are the executor's own (TRAIN_STAGE_OUTCOME_UNCONFIRMED, ...), most of them no row of failure-table.json: a HALT with a
//     code is a final state here, and the verdict says whether the table has the code.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trainLandingWorld } from './train-landing-world.mjs';
import { canonical } from '../../actions-hosted-migration/independent-ci-v1/src/proof.mjs';
import { safeReason } from '../../actions-hosted-migration/independent-ci-v1/src/resident-v2/entry-runtime.mjs';
import { TrainSweepStore } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-sweep-store.mjs';

export const ROUNDS = 60; // §3.8 step 1: N starts at the 60 of the existing cases (train-landing-e2e E9)
const TABLE = JSON.parse(await fs.readFile(fileURLToPath(new URL('../src/failure-table.json', import.meta.url)), 'utf8'));
const TABLE_CODES = new Set(TABLE.rows.map(r => r.code));
const PROOF = Object.freeze({ windowsTreeZero: true, serviceOriginalStopped: true });
// The fixture's stage threw: what the real stage entry and engine make of it (see above).
function thrownStage(error, train) {
  const reason = safeReason(error), wrote = train && Number.isSafeInteger(error?.sideEffects) && error.sideEffects > 0;
  return { ok: false, code: reason, proof: PROOF, ...(train ? { train: null, runId: null } : {}),
    outcome: { status: wrote ? 'UNCERTAIN' : 'BLOCKED', reason, sideEffects: wrote ? error.sideEffects : 0, mayHavePublished: wrote, diagnostic: null, scheduling: null, safeToRerun: false } };
}
const http502 = () => Object.assign(new Error('github_http_502'), { code: 'github_http_502' });

// What "empty" is for a read whose answer is a list; every other read answers null.
const EMPTY = {
  'github.readBranchRules': () => ({ complete: true, branch: 'main', rules: [] }),
  'github.readChecks': () => ({ complete: true, checks: [] }),
  'github.readPullsPage': ([o]) => ({ complete: true, page: o?.page ?? 1, pulls: [], last: true }),
  'github.readChangedPaths': ([j]) => ({ complete: true, pr: j.pr, headSha: j.headSha, baseSha: j.baseSha, paths: [] }),
  'github.readPullCommitsBounded': () => ({ complete: true, tooMany: false, count: 0, headSha: null, commits: [] }),
  'native.holders': () => ({ onDuty: true, holders: [] }),
  'native.nodesStatus': () => ({ deployed: true, onDuty: true, dropped: 0, nodes: [] }),
  'store.landingBatches': () => [],
};
// The fixture's own answer is already empty: an empty answer is no injection there.
export const ALREADY_EMPTY = new Set(['github.readPullsUpdatedSince', 'github.readForcePushes']);
// The sweep store's record kinds read "newest, and every record of its millisecond must mean the same" (train-sweep-store.mjs).
export const TWIN_KINDS = Object.freeze(['proof', 'pending-revocations', 'full-on', 'strict-round', 'strict-proof', 'strict-front-proof', 'scan-on']);

const methodsOf = o => {
  const names = new Set();
  for (let p = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) for (const k of Object.getOwnPropertyNames(p)) if (k !== 'constructor' && typeof o[k] === 'function') names.add(k);
  return [...names];
};
const isRead = name => /^(read|latest|landingBatch|list|load|find|has|get)/.test(name) && name !== 'read';

// A second valid record in the newest record's millisecond, with another meaning; null when the kind has no record yet or none can be made.
async function writeTwin(directory, kind) {
  const names = (await fs.readdir(directory)).filter(n => n.startsWith(`${kind}-`) && /^\d{13}-/.test(n.slice(kind.length + 1)) && n.endsWith('.json')).sort();
  const newest = names.at(-1);
  if (!newest) return null;
  const record = JSON.parse(await fs.readFile(path.join(directory, newest), 'utf8'));
  const variants = [];
  for (const [k, v] of Object.entries(record)) {
    if (['writtenAt', 'runId', 'contract'].includes(k)) continue;
    if (typeof v === 'boolean') variants.push({ ...record, [k]: !v });
    if (Number.isInteger(v)) variants.push({ ...record, [k]: v + 1 });
    if (typeof v === 'string' && /^[0-9a-f]{40}$/.test(v)) variants.push({ ...record, [k]: `${v.slice(0, 39)}${v.endsWith('0') ? '1' : '0'}` });
    if (Array.isArray(v) && v.length) variants.push({ ...record, [k]: v.slice(0, -1) });
  }
  for (const [i, twin] of variants.entries()) {
    const name = newest.replace(/-[0-9a-f]{8}\.json$/, `-${(0xfab1e000 + i).toString(16)}.json`), file = path.join(directory, name);
    await fs.writeFile(file, canonical(twin), { flag: 'wx' });
    const fresh = await TrainSweepStore.open(directory), read = await fresh.read(kind, 1, () => true, true);
    if (fresh.torn === 0 && read.length >= 2 && new Set(read.map(r => fresh.strictMeaning(r))).size >= 2) return name;
    await fs.rm(file);
  }
  return null;
}

// One scene: three PRs each two commits behind main, nobody in the merge queue, no admission yet, route push with no scan required from
// this App (train-landing-e2e E3/E9); nobody merges main into a PR. Without an injection all three land.
// stage8Code: the code the fixture's stage 8 handed the executor for every answer but SETTLED until main 80b938207 (11-24), whatever the
// publisher's own reason was; today (null) the stage's code is its own reason, as the real engine hands it over.
export async function scene(t, { prs = [1441, 1442, 1443], stage8Code = null } = {}) {
  const w = await trainLandingWorld();
  const e = await w.world(t, { prs, behind: 2, queued: false, admitted: false, appScans: [] });
  const ctx = { stage: 'outside', injection: null, census: new Map(), round: 0, thrown: [] };
  const count = (point, stage) => { const m = ctx.census.get(point) ?? new Map(); m.set(stage, (m.get(stage) ?? 0) + 1); ctx.census.set(point, m); };
  const inScope = j => (j.scope === 'tick' ? ['1', '8', '10', 'tick'].includes(ctx.stage) : j.scope === ctx.stage);
  const hit = (point, args, call) => {
    count(point, ctx.stage);
    const j = ctx.injection;
    if (!j || !j.armed || j.done || j.point !== point || !inScope(j)) return call();
    j.hits += 1; j.stages.add(ctx.stage);
    if (j.mode === 'error') return Promise.reject(point.startsWith('github.') ? http502() : new Error(`injected: ${point} unreadable`));
    return Promise.resolve((EMPTY[point] ?? (() => null))(args));
  };
  const wrap = (object, prefix, names) => {
    for (const name of names) { const original = object[name].bind(object), point = `${prefix}.${name}`; object[name] = (...a) => hit(point, a, () => original(...a)); }
  };
  wrap(e.gh, 'github', methodsOf(e.gh).filter(n => n.startsWith('read')));
  wrap(e.native.port, 'native', ['holders', 'nodesStatus']);
  wrap(e.store, 'store', methodsOf(e.store).filter(isRead));
  wrap(e.ledger, 'ledger', methodsOf(e.ledger).filter(isRead));
  // the stage's batch-route file (stage 1 and 8 read it from their stage directory): error removes it, empty leaves it with no bytes
  const tamper = async (number, dir) => {
    const file = path.join(dir, 'batch-route.json');
    if (!(await fs.stat(file).then(() => true, () => false))) return;
    await hit('stage-file.batch-route', [], async () => 'kept').then(async v => { if (v === null) await fs.writeFile(file, ''); }, async () => { await fs.rm(file); });
  };
  const r = await w.residentOver(t, e, { queueFacts: true, tamper });
  const { engine } = r;
  for (const name of ['runStage', 'runTrainStage']) {
    const original = engine[name];
    engine[name] = async (a, b) => {
      const before = ctx.stage;
      ctx.stage = name === 'runTrainStage' ? '10' : String(b.number);
      try {
        const x = await original(a, b).catch(error => { ctx.thrown.push([ctx.round, ctx.stage, safeReason(error)]); return thrownStage(error, name === 'runTrainStage'); });
        return stage8Code && ctx.stage === '8' && x.ok === false ? { ...x, code: stage8Code, outcome: { ...x.outcome, reason: stage8Code } } : x;
      } finally { ctx.stage = before; }
    };
  }
  // the poller's own reads: GitHub through gh (the main ref, the open pulls, compare) and the status file the executor writes
  const run = r.poller.run, landing = r.poller.landing;
  r.poller.run = argv => hit('poller.gh', argv, () => run(argv)).then(v => v ?? { code: 0, stdout: 'HTTP/1.1 200 OK\n\n[]' });
  r.poller.landing = () => hit('poller.status', [], () => landing());
  const landedCount = () => prs.filter(pr => e.W.pulls.get(pr).merged).length;
  const s = { w, e, r, ctx, prs, landed: () => landedCount() === prs.length, landedCount, ticks: [] };
  s.round = async () => {
    ctx.round += 1;
    ctx.stage = 'poller';
    await r.poller.pass().catch(error => { s.ticks.push([ctx.round, 'POLLER_THREW', String(error?.message ?? error)]); });
    ctx.stage = 'tick';
    const x = await r.f.exec.tick();
    ctx.stage = 'outside';
    s.ticks.push([ctx.round, x?.state ?? null, x?.reason ?? x?.failureCode ?? null]);
    r.f.advance(60_000);
    return x;
  };
  s.firstLanded = () => engine.stage8.some(x => x.front && x.status === 'SETTLED');
  return s;
}

// The scene without an injection: which read points each stage calls (the injection table is made from it), and that it lands.
export async function census(t) {
  const s = await scene(t);
  for (let i = 0; i < ROUNDS && !s.landed(); i++) await s.round();
  const kinds = new Set((await fs.readdir(s.e.store.directory)).map(n => TWIN_KINDS.filter(k => n.startsWith(`${k}-`) && /^\d{13}-/.test(n.slice(k.length + 1)))[0]).filter(Boolean));
  return { landed: s.landed(), rounds: s.ctx.round, twinKinds: TWIN_KINDS.filter(k => kinds.has(k)),
    points: [...s.ctx.census].map(([point, m]) => ({ point, stages: Object.fromEntries(m) })).sort((a, b) => a.point.localeCompare(b.point)) };
}

// c: { point, scope: '1'|'8'|'10'|'tick'|'poller', mode: 'error'|'empty'|'twin', arm: 'start'|'mid' } (twin: point is 'store:<kind>';
// arm mid: after the first front batch landed). Returns { verdict: 'landed'|'terminal'|'stall'|'not-reached', detail }.
export async function inject(t, c, { rounds = ROUNDS } = {}) {
  const s = await scene(t, { stage8Code: c.stage8Code ?? null }), { r, ctx } = s;
  const armed = () => (typeof c.arm === 'number' ? ctx.round + 1 >= c.arm : c.arm === 'start' || s.firstLanded());
  let injectedAt = null, first = null;
  if (c.mode === 'twin') {
    const kind = c.point.slice('store:'.length);
    for (let i = 0; i < rounds && injectedAt === null && !s.landed(); i++) {
      if (armed() && await writeTwin(s.e.store.directory, kind)) injectedAt = ctx.round; else await s.round();
    }
  } else {
    const j = ctx.injection = { ...c, armed: false, done: false, hits: 0, stages: new Set() };
    for (let i = 0; i < rounds && injectedAt === null && !s.landed(); i++) {
      j.armed = armed();
      await s.round();
      if (j.hits > 0) first ??= ctx.round;
      if (first !== null && ctx.round - first + 1 >= (c.window ?? 1)) { j.done = true; injectedAt = ctx.round; }
    }
  }
  if (injectedAt === null) return { verdict: 'not-reached', detail: `landed ${s.landedCount()}/${s.prs.length} after ${ctx.round} rounds, the injection never fired` };
  let halt = await r.f.ledger.halted(), paused = null;
  for (let i = 0; i < rounds && !s.landed() && !halt; i++) {
    const x = await s.round();
    halt = await r.f.ledger.halted();
    paused = x?.state === 'PAUSED' ? (x.reason ?? 'no reason') : null;
  }
  const after = ctx.round - injectedAt, hits = ctx.injection ? `${ctx.injection.hits} call(s) in ${[...ctx.injection.stages].join('+')}` : 'a record on disk';
  const head = `injected in round ${first !== null && first !== injectedAt ? `${first}-` : ''}${injectedAt} (${hits})`, part = `landed ${s.landedCount()}/${s.prs.length}`;
  if (s.landed()) return { verdict: 'landed', detail: `${head}; all landed ${after} rounds later` };
  halt ??= await r.f.ledger.halted();
  const code = halt?.value?.code ?? halt?.code ?? null;
  const thrown = ctx.thrown.length ? `; stage threw (answered as the entry does): ${[...new Set(ctx.thrown.map(x => `${x[1]}:${x[2]}`))].join(', ')}` : '';
  if (halt && typeof code === 'string') return { verdict: 'terminal', detail: `${head}; HALT ${code}${TABLE_CODES.has(code) ? '' : ' (no row of the failure table)'} ${after} rounds later; ${part}${thrown}` };
  if (!halt && paused && paused !== 'no reason') return { verdict: 'terminal', detail: `${head}; PAUSE ${paused}; ${part}` };
  const last = r.engine.trainRuns.at(-1);
  const rows = s.w.rowsOf(r.f).map(x => `${x.pr}:${x.state}${r.f.queue.row(x.pr)?.reason ? `(${r.f.queue.row(x.pr).reason})` : ''}`).join(' ');
  const tail = [...new Set(s.ticks.slice(-10).map(x => `${x[1]}${x[2] ? `:${x[2]}` : ''}`))].join(', ');
  const stage8 = [...new Set(r.engine.stage8.slice(-6).map(x => `${x.pr}${x.front ? 'F' : ''}:${x.status}${x.reason ? `:${x.reason}` : ''}`))].join(', ');
  const why = halt ? 'HALT without a code' : paused ? 'PAUSE without a reason' : 'no HALT, no PAUSE';
  return { verdict: 'stall', detail: `${head}; ${after} rounds later ${part}; ${why}; stage 10 says ${last?.decision ?? null}${last?.landing?.error ? ` (${last.landing.error})` : ''}`
    + `; rows ${rows || 'none'}; last ticks ${tail}; last stage 8 ${stage8 || 'none'}${thrown}` };
}
