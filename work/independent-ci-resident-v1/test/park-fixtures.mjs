// Shared fixtures for the parking tests (resident quota redesign phase 2, step 2, Owner decision e1e19e2e item 4).
import fs from 'node:fs/promises';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { rulesetFacts } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/train-rules.mjs';
import { StatusBoard, parseStatus } from '../src/status.mjs';
import { batchKey } from '../src/ledger.mjs';
import { writeNew } from '../src/store.mjs';
import { Poller } from '../src/poller.mjs';
import { pollLane } from '../src/companion-main.mjs';
import { restAnswer, restPolls } from './gh-rest-stub.mjs';
import { BASE, HEAD, SOURCE, WINDOWS_CLEAN, fakeEngine } from './helpers.mjs';

const MIN = 60_000;
const OWNER = 'S-1-5-21-1-2-3-1001';
const H = n => String(n).repeat(40).slice(0, 40);
const subject = (o = {}) => ({ repo: 'tdoljyj/cross-memory-system', pr: 884, headSha: HEAD, baseSha: BASE, sourceManifestSha256: SOURCE, attempt: 1, ...o });
const KEY = batchKey(subject());
const stagesRun = engine => engine.calls.filter(c => c[0] === 'stage').map(c => c[1]);
const receiptTypes = async f => (await fs.readdir(path.join(f.root, 'state', 'receipts'))).map(n => n.replace(/^\d+-|\.json$/g, ''));
// Stage 8 not ready, as the Source reports it: BLOCKED, zero side effects, the scheduling facts.
const notReady = (code, mergeQueue = { entered: false, state: null, position: null }) => ({ ok: false, code, proof: WINDOWS_CLEAN, brokerNoLaunch: false,
  outcome: { status: 'BLOCKED', reason: code, sideEffects: 0, mayHavePublished: false, diagnostic: null, scheduling: { ciRetryAfter: null, mergeQueue }, safeToRerun: false } });
// An engine whose stage 8 answers from a list (then success); every other stage succeeds. With `only` (a batch key) the
// list answers that batch alone.
function stage8Engine(answers, only = null, script = {}) {
  const engine = fakeEngine(script);
  const base = engine.runStage;
  let i = 0;
  engine.runStage = async (batch, stage, o) => (stage.number === 8 && i < answers.length && (only === null || batch.key === only)
    ? (engine.calls.push(['stage', 8]), answers[i++]) : base(batch, stage, o));
  return engine;
}

const isoAt = at => new Date(at).toISOString();

const bodies = async (f, type) => {
  const out = [];
  for (const e of await f.receipts.entries()) if (e.type === type) out.push(JSON.parse(await fs.readFile(path.join(f.receipts.dir, e.name), 'utf8')).body);
  return out;
};
const UNCERTAIN = { ok: false, code: 'PUBLICATION_UNCERTAIN', proof: WINDOWS_CLEAN, outcome: { status: 'UNCERTAIN', reason: 'x', sideEffects: 1, mayHavePublished: true, diagnostic: null, scheduling: null, safeToRerun: false } };
const K900 = batchKey(subject({ pr: 900, headSha: H(4) }));

// Task bd07449b (PLAN-ruleset-unreadable-park-20261125 §3.2, §4). main's rules as GitHub gave them on 2026-11-25 (ruleset 27843120, the
// hosted scaffold): read whole, and not this App's six. Stage 8 answers RULESET_UNREADABLE for them every time, so a timed retry is
// a wasted stage 8: the batch sleeps at its first try and only rules pinned back to this App wake it.
const LIVE_SCAFFOLD = JSON.parse(readFileSync(new URL('../../actions-hosted-migration/independent-ci-v1/test/fixtures/main-rules-scaffold-20261125.json', import.meta.url), 'utf8'));
const APP = 5368905;
const SIX = ['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot'];
// the same reply once the Owner pins the six back to this App (the scaffold's own entries stay)
const pinnedBack = () => LIVE_SCAFFOLD.map(r => (r.type !== 'required_status_checks' ? r : { ...r, parameters: { ...r.parameters,
  required_status_checks: [...r.parameters.required_status_checks.filter(c => !SIX.includes(c.context)), ...SIX.map(context => ({ context, integration_id: APP }))] } }));
const sourceCode = raw => { try { rulesetFacts(raw.map(r => ({ type: r.type, rulesetId: r.ruleset_id, parameters: r.parameters ?? null })), APP); return null; } catch (e) { return e.code; } };
const stage8Tries = async f => (await f.receipts.latest(['stage8-not-ready'], 50)).map(r => [r.value.body.failureCode, r.value.body.nextAt]);

// Task bd07449b r2 (PLAN-ruleset-unreadable-park-r2 §2, §5 must-red 3, 4). The companion as main() runs it: its poll lane
// (companion-main.mjs#pollLane: the status board, the PR pass, one sleeping batch observed) over a GitHub that shows PR 884 open on main
// (no compare answer: nothing is proposed), with main's rules read pinned to this App. One beat is one pass of that lane.
function companionBeats(f, checkId = () => 1) {
  let events = 0, running = false;
  const pulls = () => [{ number: 884, headRefOid: HEAD, baseRefOid: BASE, isDraft: false, updatedAt: '2026-11-25T03:00:00Z' }];
  const run = restPolls(async argv => {
    const id = argv.some(a => /\/check-runs/.test(a)) ? checkId() : null;
    if (id === null) return { code: 9, stdout: '', stderr: '' };
    return restAnswer(argv, { total_count: 1, check_runs: [{ id, name: 'hosted-ci-suites', status: 'completed', conclusion: 'success' }] });
  }, { main: () => BASE, pulls });
  const poller = new Poller({ repo: subject().repo, ghExe: 'gh', clock: f.clock, run,
    writeTrigger: async trigger => { events++; await f.drop(Buffer.from(JSON.stringify(trigger))); } });
  poller.noteBranchRules(pinnedBack());
  // the status board the executor writes (state\status.json), as the companion parses it
  const readStatus = () => { const b = new StatusBoard({ clock: f.clock }); b.update({ backfill: { complete: true, published: 0, unreadable: 0 } });
    b.setPending(f.queue.view(f.clock(), { etaBatchMs: 20 * MIN }).map(r => (running && r.pr === 884 ? { ...r, state: 'RUNNING', nextAt: null } : r)));
    return parseStatus(Buffer.from(JSON.stringify(b.snapshot()))); };
  const lane = pollLane({ poller, readStatus });
  // runningBeat: one pass that sees the row RUNNING (the poller forgets what it observed of a row that is not asleep)
  const runningBeat = async () => { running = true; try { await lane.work(); } finally { running = false; } };
  return { beat: () => lane.work(), runningBeat, events: () => events, readStatus };
}
const unreadable = () => notReady('RULESET_UNREADABLE');

// Task bd07449b r3 (PLAN-ruleset-unreadable-park-r3 §2, §3): guards of what the code does today (green before and after, not must-red).
// Beat the companion every minute while tries come (every 10 minutes once the last try is 15 minutes old) until `until`; returns the
// clock of every stage-8 try that ran.
async function beatsUntil(f, c, engine, until, at, stopAt = Infinity, step = null) {
  let runs = stagesRun(engine).filter(stage => stage === 8).length;
  while (f.clock() < until && runs < stopAt) {
    await c.beat();
    await f.exec.tick();
    const now = stagesRun(engine).filter(stage => stage === 8).length;
    if (now > runs) { at.push(f.clock()); runs = now; }
    f.advance(step ?? (f.clock() - at.at(-1) < 15 * MIN ? MIN : 10 * MIN));
  }
  return runs;
}

// Same create-only records as Ledger.beginTry/endTry. These attempts are already over when the
// scenario starts. Writing the history directly avoids reopening all prior tries for each seed.
async function seedStage8History(f, key, from, to, batchId, ending) {
  const dir = f.ledger.dir(key);
  const at = isoAt(f.clock());
  for (let n = from; n <= to; n++) {
    const suffix = String(n).padStart(2, '0');
    await writeNew(path.join(dir, `71-try-${suffix}.json`),
      { key, contract: 'clued.independent-ci.resident-stage8-try/1', n, at, batchId });
    await writeNew(path.join(dir, `72-tried-${suffix}.json`),
      { key, contract: 'clued.independent-ci.resident-stage8-tried/1', n, at, ...(typeof ending === 'function' ? ending(n) : ending) });
  }
}

export { MIN, OWNER, H, subject, KEY, stagesRun, receiptTypes, notReady, stage8Engine, isoAt, bodies, UNCERTAIN, K900, LIVE_SCAFFOLD, pinnedBack, sourceCode, stage8Tries, companionBeats, unreadable, beatsUntil, seedStage8History };
