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
//   - a required check no longer pinned to App 5368905, or no required_status_checks at all (the ruleset disabled):
//     raise an Owner notification (no pause: stage 8 already writes no green then);
//   - the rules cannot be read: nothing (stage 8 parks on RULESET_UNREADABLE by itself).
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
export const BACKSTOP_KINDS = Object.freeze(['STRICT_OFF_WITHOUT_TRAIN', 'RULESET_NOT_PINNED', 'STRICT_OFF_SWEEP_INCOMPLETE', 'STRICT_OFF_SWEEP_PENDING']);
const DAY = 24 * 3600_000;
// The longest a full sweep may take (policy train.fullSweepMaxMs is at most 24 hours): a newer eligibility only notifies.
export const SWEEP_GRACE_MS = DAY;

// gh api repos/{repo}/rules/branches/main -> { strict, pinned } or null when the reply is not a rules list.
export function rulesFacts(reply) {
  if (!Array.isArray(reply) || reply.length >= 100 || !reply.every(r => r && typeof r === 'object' && typeof r.type === 'string')) return null;
  const required = reply.filter(r => r.type === 'required_status_checks');
  const checks = required.flatMap(r => Array.isArray(r.parameters?.required_status_checks) ? r.parameters.required_status_checks : []);
  const pinned = required.length > 0 && REQUIRED_CHECK_NAMES.every(n => checks.some(c => c?.context === n) && checks.filter(c => c?.context === n).every(c => c.integration_id === APP_ID));
  return { strict: required.some(r => r.parameters?.strict_required_status_checks_policy === true), pinned };
}

// facts: rulesFacts(...) or null; trainMode: the executor's train.enabled from its status snapshot (null: unknown); sweep: its
// train.sweep (status.mjs; null or absent: no full sweep known, which in mode 'on' is "not complete"); duty: { onDuty (false: the
// status says STANDBY or UNCERTAIN, or train.notOnDuty), onSince (ms or null) } from the same snapshot; now: the clock.
export function backstopDecision({ facts, trainMode, sweep = null, duty = { onDuty: true, onSince: null }, now = Date.now() }) {
  if (!facts) return { pause: false, notify: null };
  if (!facts.pinned) return { pause: false, notify: 'RULESET_NOT_PINNED' };
  if (!facts.strict && trainMode !== 'on') return { pause: true, notify: 'STRICT_OFF_WITHOUT_TRAIN' };
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
  RULESET_NOT_PINNED: 'main 的必需检查不再全部钉在 App 5368905（或规则集被停用）：常驻执行器不会再发合并位。若是灾备切换，请按运维手册的流程走。',
};
export const backstopText = kind => TEXT[kind] ?? null;

// One pass. ports: readRules() -> raw reply (throws when unreadable), trainMode() -> 'off'|'shadow'|'on'|null,
// writePause(reason), notify(kind, text), memory: { get(key), set(key, value) } (the companion's own store), trainSweep()
// (optional) -> status train.sweep or null, trainDuty() (optional) -> dutyOf(status) (absent: on duty, eligibility unknown).
export async function backstopPass({ readRules, trainMode, trainSweep = async () => null, trainDuty = async () => ({ onDuty: true, onSince: null }), writePause, notify, memory, clock = Date.now }) {
  let facts = null;
  try { facts = rulesFacts(await readRules()); } catch { facts = null; }
  let mode = null;
  try { mode = await trainMode(); } catch { mode = null; }
  let sweep = null;
  try { sweep = await trainSweep(); } catch { sweep = null; }
  let duty = { onDuty: true, onSince: null };
  try { duty = await trainDuty(); } catch { duty = { onDuty: true, onSince: null }; }
  const now = clock();
  const d = backstopDecision({ facts, trainMode: mode, sweep, duty, now });
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
export function companionBackstop({ root, ghExe, repo, powershellExe, run, store, clock = Date.now, timeoutMs = 60_000 }) {
  return backstopPass({
    readRules: async () => {
      const r = await run([ghExe, 'api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', `repos/${repo}/rules/branches/main?per_page=100`], { timeoutMs });
      if (r.code !== 0) throw new Error('rules unreadable');
      return JSON.parse(r.stdout);
    },
    trainMode: async () => (await readStatus(root)).train?.enabled ?? null,
    trainSweep: async () => (await readStatus(root)).train?.sweep ?? null,
    trainDuty: async () => dutyOf(await readStatus(root)),
    writePause: reason => writePauseRequest(path.join(root, 'requests'), reason, clock),
    notify: async (kind, text) => { await run(toastArgv(powershellExe, kind.startsWith('STRICT_OFF') ? '紧急：main 的 strict 已关' : 'main 的必需检查有变', text), { timeoutMs }); },
    memory: {
      get: key => Date.parse(store.data.notified[key]?.at) || 0,
      set: async (key, at) => { store.data.notified[key] = { at: new Date(at).toISOString() }; await store.save(); },
    },
    clock,
  });
}
