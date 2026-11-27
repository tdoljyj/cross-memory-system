// The train front's main merge, asked for by the node on duty (DESIGN §80; Owner Decisions 9e2511fe item 3 and 78a3052f item 2).
// Stage 10 (train-maintenance) says FRONT_NEEDS_MAIN_MERGE when the front's head does not contain main's tip (strict merges only a head
// that does). This lane starts the repository's clued-front-main-merge.yml for exactly that front (pr, head) with workflow_dispatch, as
// the panel trigger starts its workflow (panel-dispatch.mjs): the same gh login as every other companion call, no credential of its own,
// one fixed argv. The workflow does the one write (update-branch and the attestation check, as the clued-admission App) and reads every
// fact again itself; this lane is only the signal, so a missed or doubled dispatch costs a dispatch, never a wrong merge.
//
// When: this node's status says ACTIVE (panel-dispatch.mjs#dutyOf; a standby node never asks), the newest train summary is mode on,
// decision FRONT_NEEDS_MAIN_MERGE, names the front's PR and head and main, and is at most SUMMARY_FRESH_MS old. Once per (pr, head, main);
// the same again after RETRY_MS while stage 10 still says so (a conflict the holder must resolve keeps saying so), at most MAX_TRIES times.
// A new head or a new main is a new request.
import fs from 'node:fs/promises';
import { check } from './canonical.mjs';
import { dispatchByTrainEffect, dutyOf } from './panel-dispatch.mjs';
import { operationalIntakePause, usesSharedDuty } from './node-duty.mjs';

const MIN = 60_000;
export const FRONT_MERGE_REPO = 'tdoljyj/cross-memory-system';
export const FRONT_MERGE_WORKFLOW = 'clued-front-main-merge.yml';
export const FRONT_MERGE_LANE_EVERY_MS = MIN;
export const SUMMARY_FRESH_MS = 10 * MIN;
export const RETRY_MS = 15 * MIN;
export const MAX_TRIES = 3;
export const POST_TIMEOUT_MS = 30_000;
const SHA = /^[0-9a-f]{40}$/;
const STATE_CONTRACT = 'clued.independent-ci.front-merge-dispatch/1';

// The front to bring main into, or null.
export function wantedFrontMerge(status, nodeName, now, protocolVersion = 1) {
  if (dutyOf(status, nodeName, now) !== null || status.paused || status.halt) return null;
  // 仅暂停接新时，协议 1 的既有车头可以继续。
  if (protocolVersion !== 1 && operationalIntakePause(status.intakePause, usesSharedDuty(status))) return null;
  const last = status?.train?.last;
  if (!last || last.mode !== 'on' || last.decision !== 'FRONT_NEEDS_MAIN_MERGE' || !(now - last.at <= SUMMARY_FRESH_MS)) return null;
  if (!Number.isSafeInteger(last.front?.pr) || last.front.pr < 1 || !SHA.test(last.front.headSha ?? '') || !SHA.test(last.mainSha ?? '')) return null;
  return { pr: last.front.pr, head: last.front.headSha, main: last.mainSha };
}

export function frontMergeArgv(ghExe, repo, { pr, head }) {
  check(typeof ghExe === 'string' && /^[A-Z]:\\/.test(ghExe) && repo === FRONT_MERGE_REPO && Number.isSafeInteger(pr) && pr > 0 && SHA.test(head ?? ''),
    'FRONT_MERGE_DISPATCH_ARGS_INVALID');
  return [ghExe, 'api', '--method', 'POST', `repos/${repo}/actions/workflows/${FRONT_MERGE_WORKFLOW}/dispatches`,
    '-f', 'ref=main', '-f', `inputs[pr]=${pr}`, '-f', `inputs[head]=${head}`];
}

// Its memory in the Owner's profile: the request last sent, how often, and when.
export class FrontMergeDispatchState {
  constructor(file) { this.file = file; this.data = { contract: STATE_CONTRACT, key: null, tries: 0, at: null }; }
  static async open(file) {
    const s = new FrontMergeDispatchState(file);
    try {
      const v = JSON.parse(await fs.readFile(file, 'utf8'));
      if (v?.contract === STATE_CONTRACT && (v.key === null || typeof v.key === 'string') && Number.isSafeInteger(v.tries) && v.tries >= 0
        && (v.at === null || Number.isSafeInteger(v.at))) s.data = { contract: STATE_CONTRACT, key: v.key, tries: v.tries, at: v.at };
    } catch { /* none yet, or unreadable: start empty (a doubled dispatch is harmless) */ }
    return s;
  }
  async save() { await fs.writeFile(this.file, JSON.stringify(this.data), 'utf8'); }
}

export class FrontMergeDispatcher {
  // ports: { nodeName, repo, ghExe, run(argv, { timeoutMs }), clock, readStatus(), state (FrontMergeDispatchState) }
  constructor(ports) { Object.assign(this, ports); }
  async step() {
    const now = this.clock();
    let status = null;
    try { status = await this.readStatus(); } catch { status = null; }
    const want = wantedFrontMerge(status, this.nodeName, now, this.trainProtocolVersion);
    if (!want) return { dispatched: false };
    const key = `${want.pr}:${want.head}:${want.main}`, d = this.state.data;
    if (d.key === key && (d.tries >= MAX_TRIES || now - d.at < RETRY_MS)) return { dispatched: false, waiting: key };
    const tries = d.key === key ? d.tries + 1 : 1;
    let r = null;
    try {
      const dispatch = await dispatchByTrainEffect(this,
        { repo: this.repo, ref: 'main', subject: [FRONT_MERGE_WORKFLOW, want.pr, want.head, want.main] },
        () => this.run(frontMergeArgv(this.ghExe, this.repo, want), { timeoutMs: POST_TIMEOUT_MS }));
      if (!dispatch.sent) return { dispatched: false, waiting: key };
      r = dispatch.reply;
    } catch { r = null; }
    // Whatever came of it counts as a try: a refused or uncertain dispatch is asked again after RETRY_MS, not at once.
    this.state.data = { contract: STATE_CONTRACT, key, tries, at: now };
    try { await this.state.save(); } catch { /* memory is a convenience; the workflow refuses what is no longer true */ }
    return { dispatched: r?.code === 0, key, tries };
  }
}
