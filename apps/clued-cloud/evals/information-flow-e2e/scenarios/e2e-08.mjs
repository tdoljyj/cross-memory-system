// E2E-08 (B06): restart/continuity. Phase A (this process, Worker host W1)
// creates pending candidates and a compiled manifest; the orchestrator stops
// W1, restarts the db/PostgREST/GoTrue/Kong containers and starts phase B in
// a new process (continuity-phase-b.mjs) that reads its expectations only
// from phaseA.json. merge() folds phase B's steps into this evidence.
import { acceptPolicy, checkPack, item, nativeNote, packExtract, policyDoc, promote, submitAgent,
  submitNative } from './common.mjs';
import { label, sha256 } from '../evidence.mjs';

export const id = 'E2E-08';

export const pendingRow = (row) => ({ tier: row.tier, id: row.id, version: Number(row.version),
  input_digest: row.input_digest, status: row.status });
export const sortRows = (rows) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export async function phaseA(ctx, r) {
  const { U, B_main: B, projects } = ctx;
  const scope = projects.p08;
  r.alias('P08', scope.slice(8));
  const native = await submitNative(r, U, scope, 'seg_s6_e08n', [item('e08a', 'fact'), item('e08b', 'fact'),
    item('e08p', 'fact')]);
  r.alias('C8A', native.ids.item_e08a);
  r.alias('C8B', native.ids.item_e08b);
  const agent = await submitAgent(r, B, scope, 'seg_s6_e08a', [item('e08c', 'fact')]);
  r.alias('C8C', agent.ids.item_e08c);
  r.alias('R8', (await promote(r, U, 'information', native.ids.item_e08p)).recordId);
  r.alias('N8', await nativeNote(r, U, 'E2E-08 continuity note', { scope }));
  await acceptPolicy(r, U, policyDoc('e2e.08', [scope], { allowed_record_types: ['note'] }));
  const compiled = (await r.tool(B, 'clued_context_pack', { scope, task_class: 'e2e.08' }, { extract: packExtract }))
    .structured;
  checkPack(r, '08.phaseA', compiled);
  r.alias('M8', compiled?.manifest?.id);
  const nativeList = await r.rest(U, 'GET', `/v1/intake?status=pending&scope=${encodeURIComponent(scope)}&limit=200`,
    undefined, { extract: (b) => ({ count: b?.candidates?.length }) });
  const agentList = await r.tool(B, 'clued_intake_list', { scope, status: 'pending', limit: 200 },
    { extract: (b) => ({ count: b?.candidates?.length }) });
  const nativePending = sortRows((nativeList.body?.candidates ?? []).map(pendingRow));
  const agentPending = sortRows((agentList.structured?.candidates ?? []).map(pendingRow));
  r.check('08.phaseA.native_pending', 'phase A: the owner sees three pending candidates', 3, nativePending.length);
  r.check('08.phaseA.agent_pending', 'phase A: the Binding sees its own pending candidate', 1, agentPending.length);
  const publicState = {
    schema: 'clued.information-flow.m0d.continuity-phase-a/1', scope, task_class: 'e2e.08',
    native_pending: nativePending, agent_pending: agentPending,
    manifest_id: compiled?.manifest?.id ?? null, pack_digest: compiled?.pack_digest ?? null,
    p1_pid: process.pid, w1_pid: ctx.h.worker.child.pid, gotrue_session_label: U.session.claimsSummary.session_label,
  };
  return { public: publicState, aliases: r.aliases };
}

// Folds the phase B child result into the E2E-08 recorder.
export function merge(r, { phaseA, child, restart, phaseB, parentPid }) {
  r.processControl('stop Worker host W1 (SIGTERM) and close phase A connections', { w1_pid: phaseA.public.w1_pid });
  r.processControl('docker restart db, PostgREST, GoTrue and Kong (volume persists)', {
    restarted: Object.keys(restart.before ?? {}) });
  const changed = Object.keys(restart.before ?? {}).filter((k) => restart.before[k] && restart.after[k]
    && restart.before[k] !== restart.after[k]);
  r.check('08.containers_restarted', 'db, rest, auth and kong containers restarted (new StartedAt)',
    ['auth', 'db', 'kong', 'rest'], changed.sort());
  r.processControl('spawn phase B in a new Node process', { exit_code: child.code });
  r.check('08.phaseB_exit', 'the phase B process completed', 0, child.code);
  if (!phaseB) {
    r.check('08.phaseB_result', 'phase B returned a result', true, false);
    return;
  }
  for (const step of phaseB.steps) r.addStep({ ...step, phase: 'B' });
  for (const assertion of phaseB.assertions) r.assertions.push(assertion);
  r.check('08.new_process', 'phase B ran in a new process (P2 != P1)', true,
    phaseB.p2_pid !== phaseA.public.p1_pid && phaseB.p2_pid !== parentPid);
  r.check('08.new_worker', 'phase B used a new Worker host (W2 != W1)', true, phaseB.w2_pid !== phaseA.public.w1_pid);
  r.note(`phaseA.json sha256 ${phaseA.sha256}`);
  r.note('No local cache used as truth: W2 started from an empty persist directory with no KV/cache/storage '
    + 'bindings (only text vars), P2 has no access to P1 memory and read only phaseA.json for expectations, '
    + 'and the database-side services were restarted.');
}

export { label, sha256 };
