// The companion's ruleset backstop (quota redesign phase 2, step 3c-1; design v0.5 §6 "关 strict 前后的保护", last
// item; DESIGN §22.3). Stage 8 reads main's rules before every green, but that only stops NEW greens. The companion
// (the Owner's identity, read-only GitHub) therefore reads the rules on every poll as well:
//   - strict off while the executor is not in train mode 'on': write a pause request (any Owner process may stop the
//     executor, never resume it) and raise an urgent Owner notification: turn strict back on, or finish the sweep;
//   - strict off in train mode 'on' while this node has not completed a full sweep since it became eligible for on-mode duty
//     (status train.sweep.fullSinceOn, kept across restarts by the executor; step 3c-2b, DESIGN §41.7): the same pause and urgent
//     notice, saying 清扫没完成; but only on the node on duty (ACTIVE, not train.notOnDuty: a STANDBY never sweeps, §41.9 item 5,
//     and a paused STANDBY could never be a take-over target, §41.6a), and only once its eligibility (train.onSince) is older than
//     SWEEP_GRACE_MS: before that (a take-over, a start whose state is not read back yet) stage 8 writes no green without the
//     proof anyway and the executor defers every batch, so it only notifies (STRICT_OFF_SWEEP_PENDING, review R3 M1);
//   - strict off in train mode 'on' while the policy runs strict-permanent mode (status train.sweepMode 'audit' or 'off', DESIGN §65,
//     Owner decision 9e2511fe): strict must never be off there, so the pause request and the urgent notice come at once, on every
//     node, whatever the sweep or the duty says (STRICT_OFF_STRICT_PERMANENT; no SWEEP_GRACE_MS). Stage 8 writes no green then and
//     stage 10 asks for PAUSE too (TRAIN_STRICT_OFF); this is the backstop for a node whose stage 10 does not run;
//   - a required check with no entry pinned to App 5368905 (R3: a scan may be pinned to GitHub Actions 15368 instead), or listed
//     without an App, or no required_status_checks at all (the ruleset disabled): raise an Owner notification (no pause: stage 8
//     already writes no green then). The same name pinned to another App as well (the hosted scaffold ruleset next to #292) is one
//     more requirement, not a lost pin (task 04f9b91b);
//   - the rules cannot be read: nothing (stage 8 parks on RULESET_READ_FAILED by itself).
// Each notification is raised once per kind per day; a pause request is written once per kind per day as well.
// Pure decision plus thin ports; the caller supplies the gh read, the pause writer and the notifier.
import path from 'node:path';
import { Inbox } from './inbox.mjs';
import { readStatus } from './status.mjs';
import { toastArgv } from './pr-status.mjs';

export const APP_ID = 5368905;
// Must equal Source v2 train-rules.mjs REQUIRED_CHECK_NAMES and executor.mjs PAUSE_CONTRACT (a test keeps them equal).
export const REQUIRED_CHECK_NAMES = Object.freeze(['kooyumi-work-admission', 'gitleaks', 'trivy', 'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot']);
export const PAUSE_CONTRACT = 'clued.independent-ci.resident-pause/1';
export const BACKSTOP_KINDS = Object.freeze(['STRICT_OFF_WITHOUT_TRAIN', 'RULESET_NOT_PINNED', 'STRICT_OFF_SWEEP_INCOMPLETE', 'STRICT_OFF_SWEEP_PENDING',
  'STRICT_OFF_STRICT_PERMANENT']);
// R3 lean: must equal Source v2 train-rules.mjs ACTIONS_INTEGRATION_ID and RULE_SCAN_NAMES (a test keeps them equal).
export const ACTIONS_INTEGRATION_ID = 15368;
export const RULE_SCAN_NAMES = Object.freeze(['gitleaks', 'trivy', 'contract-placement']);
// The policy sweep modes of strict-permanent mode (policy.mjs TRAIN_SWEEPS without 'gate').
export const STRICT_PERMANENT_MODES = Object.freeze(['audit', 'off']);
const DAY = 24 * 3600_000;
// The longest a full sweep may take (policy train.fullSweepMaxMs is at most 24 hours): a newer eligibility only notifies.
export const SWEEP_GRACE_MS = DAY;

// gh api repos/{repo}/rules/branches/main -> { strict, pinned } or null when the reply is not a rules list. pinned: the rule of Source v2
// train-rules.mjs#rulesetFacts, each of the six required, every requirement of it from App 5368905 (a scan: or from GitHub Actions, R3).
export function rulesFacts(reply) {
  if (!Array.isArray(reply) || reply.length >= 100 || !reply.every(r => r && typeof r === 'object' && typeof r.type === 'string')) return null;
  const required = reply.filter(r => r.type === 'required_status_checks');
  const checks = required.flatMap(r => Array.isArray(r.parameters?.required_status_checks) ? r.parameters.required_status_checks : []);
  // Source v2 train-rules.mjs#rulesetFacts reads the pin the same way (a test runs both over one table): each of the six has an
  // entry pinned to this App (a scan: or to GitHub Actions, R3), and none of their entries is pinned to no App; another App pinning
  // the same name is one more requirement.
  const allowed = n => (RULE_SCAN_NAMES.includes(n) ? [APP_ID, ACTIONS_INTEGRATION_ID] : [APP_ID]);
  const named = checks.filter(c => REQUIRED_CHECK_NAMES.includes(c?.context));
  const pinned = required.length > 0 && REQUIRED_CHECK_NAMES.every(n => named.some(c => c.context === n && allowed(n).includes(c.integration_id)))
    && named.every(c => Number.isSafeInteger(c.integration_id) && c.integration_id > 0);
  return { strict: required.some(r => r.parameters?.strict_required_status_checks_policy === true), pinned };
}

// facts: rulesFacts(...) or null; trainMode: the executor's train.enabled from its status snapshot (null: unknown); sweep: its
// train.sweep (status.mjs; null or absent: no full sweep known, which in mode 'on' is "not complete"); duty: { onDuty (false: the
// status says STANDBY or UNCERTAIN, or train.notOnDuty), onSince (ms or null) } from the same snapshot; now: the clock; sweepMode: the
// snapshot's train.sweepMode (null or absent: a resident before DESIGN §65, i.e. 'gate').
export function backstopDecision({ facts, trainMode, sweep = null, duty = { onDuty: true, onSince: null }, now = Date.now(), sweepMode = null }) {
  if (!facts) return { pause: false, notify: null };
  if (!facts.pinned) return { pause: false, notify: 'RULESET_NOT_PINNED' };
  if (!facts.strict && trainMode !== 'on') return { pause: true, notify: 'STRICT_OFF_WITHOUT_TRAIN' };
  if (!facts.strict && STRICT_PERMANENT_MODES.includes(sweepMode)) return { pause: true, notify: 'STRICT_OFF_STRICT_PERMANENT' };
  if (facts.strict || sweep?.fullSinceOn === true || duty?.onDuty === false) return { pause: false, notify: null };
  const settled = Number.isFinite(duty?.onSince) && now - duty.onSince >= SWEEP_GRACE_MS;
  return settled ? { pause: true, notify: 'STRICT_OFF_SWEEP_INCOMPLETE' } : { pause: false, notify: 'STRICT_OFF_SWEEP_PENDING' };
}

// The duty the backstop reads from a status snapshot (status.mjs#parseStatus): a known node not ACTIVE, or train.notOnDuty, is not
// on duty; no node at all is the single node it always was.
export function dutyOf(status) {
  const mode = status?.node?.mode;
  return { onDuty: status?.train?.notOnDuty !== true && (mode === undefined || mode === null || mode === 'ACTIVE'), onSince: Number.isFinite(status?.train?.onSince) ? status.train.onSince : null };
}

const TEXT = {
  STRICT_OFF_WITHOUT_TRAIN: 'main 的规则集已关掉 strict，而合并列车没有开：已暂停常驻执行器（不再发新绿）。请把 strict 改回开，或按上线流程先完成清扫。',
  STRICT_OFF_SWEEP_INCOMPLETE: 'main 的规则集已关掉 strict，合并列车开着但清扫没完成（本节点开车或接班后还没完成全量清扫）：已暂停常驻执行器（不再发新绿）。请把 strict 改回开，等清扫完成后再关。',
  STRICT_OFF_SWEEP_PENDING: 'main 的规则集已关掉 strict，本节点刚开车、接班或重启，清扫还在进行：清扫完成前不发新绿（未暂停）。若这不是计划内的操作，请把 strict 改回开。',
  STRICT_OFF_STRICT_PERMANENT: 'main 的规则集已关掉 strict，而合并列车运行在 strict 永久开模式：已暂停常驻执行器（不再发新绿）。请立即把 strict 改回开，然后恢复执行器。',
  RULESET_NOT_PINNED: 'main 的必需检查不再全部钉在 App 5368905（三项扫描钉在 GitHub Actions 也算钉住；或规则集被停用）：常驻执行器不会再发合并位。若是灾备切换，请按运维手册的流程走。',
};
export const backstopText = kind => TEXT[kind] ?? null;

// One pass. ports: readRules() -> raw reply (throws when unreadable), trainMode() -> 'off'|'shadow'|'on'|null,
// writePause(reason), notify(kind, text), memory: { get(key), set(key, value) } (the companion's own store), trainSweep()
// (optional) -> status train.sweep or null, trainDuty() (optional) -> dutyOf(status) (absent: on duty, eligibility unknown).
// trainSweepMode() (optional, DESIGN §65) -> status train.sweepMode or null.
export async function backstopPass({ readRules, trainMode, trainSweep = async () => null, trainDuty = async () => ({ onDuty: true, onSince: null }), trainSweepMode = async () => null,
  writePause, notify, memory, clock = Date.now }) {
  let facts = null;
  try { facts = rulesFacts(await readRules()); } catch { facts = null; }
  let mode = null;
  try { mode = await trainMode(); } catch { mode = null; }
  let sweep = null;
  try { sweep = await trainSweep(); } catch { sweep = null; }
  let duty = { onDuty: true, onSince: null };
  try { duty = await trainDuty(); } catch { duty = { onDuty: true, onSince: null }; }
  let sweepMode = null;
  try { sweepMode = await trainSweepMode(); } catch { sweepMode = null; }
  const now = clock();
  const d = backstopDecision({ facts, trainMode: mode, sweep, duty, now, sweepMode });
  if (!d.notify) return { ...d, acted: false };
  const key = `backstop:${d.notify}`, last = Number(await memory.get(key)) || 0;
  if (now - last < DAY) return { ...d, acted: false };
  if (d.pause) await writePause(`ruleset-backstop: ${d.notify}`);
  // Remembered before the notification: a toast that fails never makes every poll write another pause request.
  await memory.set(key, now);
  try { await notify(d.notify, backstopText(d.notify)); } catch { /* the pause request is written; the toast is advisory */ }
  return { ...d, acted: true };
}

// The pause request, written create-only into the executor's requests inbox (inbox.mjs file name shape).
export async function writePauseRequest(requestsDir, reason, clock = Date.now) {
  return Inbox.drop(requestsDir, { contract: PAUSE_CONTRACT, reason: String(reason).slice(0, 200) }, clock);
}

// The companion's ports for one pass (companion-main.mjs calls it on every poll): main's rules with the Owner's read-only
// gh login, the train mode from the executor's status snapshot, the pause request into the user-writable requests\, a
// Windows notification, and the once-a-day memory in the companion's own store (pr-status.mjs#LocalStore, `backstop:` keys).
// notify(key, title, body): the companion's notification queue (ADR 0022 §4.3, M5); without it (tests, older wiring) a toast as before.
export function companionBackstop({ root, ghExe, repo, powershellExe, run, store, clock = Date.now, timeoutMs = 60_000, notify = null, observeRules = null }) {
  return backstopPass({
    readRules: async () => {
      const r = await run([ghExe, 'api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', `repos/${repo}/rules/branches/main?per_page=100`], { timeoutMs });
      if (r.code !== 0) throw new Error('rules unreadable');
      const rules = JSON.parse(r.stdout);
      try { observeRules?.(rules); } catch { /* wake hints cannot change the backstop reading */ }
      return rules;
    },
    trainMode: async () => (await readStatus(root)).train?.enabled ?? null,
    trainSweep: async () => (await readStatus(root)).train?.sweep ?? null,
    trainDuty: async () => dutyOf(await readStatus(root)),
    trainSweepMode: async () => (await readStatus(root)).train?.sweepMode ?? null,
    writePause: reason => writePauseRequest(path.join(root, 'requests'), reason, clock),
    notify: async (kind, text) => {
      const title = kind.startsWith('STRICT_OFF') ? '紧急：main 的 strict 已关' : 'main 的必需检查有变';
      if (notify) await notify(`backstop:${kind}`, title, text); else await run(toastArgv(powershellExe, title, text), { timeoutMs });
    },
    memory: {
      get: key => Date.parse(store.data.notified[key]?.at) || 0,
      set: async (key, at) => { store.data.notified[key] = { at: new Date(at).toISOString() }; await store.save(); },
    },
    clock,
  });
}
