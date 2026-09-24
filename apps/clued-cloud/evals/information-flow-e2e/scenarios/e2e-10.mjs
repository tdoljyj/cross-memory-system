// E2E-10: Global-projection and MTPE interaction. Candidate submit,
// withdraw and reject leave mtpe_intake_projection, the Frontier, projection
// invalidation and Currentness unchanged; a promotion whose payload carried
// priority/actionable keys yields a Record without the stripped keys; task
// promotion touches Currentness and MTPE, note promotion does not.
import { canonicalSnapshotSql, item, key, promote, submitAgent, submitNative } from './common.mjs';
import { canonical, sha256 } from '../evidence.mjs';

export const id = 'E2E-10';

const STRIPPED = ['priority', 'intake_kind', 'execution_bucket', 'current_frontier_blocking', 'criticality',
  'owner_track', 'priority_eligibility', 'executability', 'governance_profile', 'state_kind'];

// Frontier digest over the MTPE snapshot body without volatile read metadata.
function frontierDigest(body) {
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value)
        .filter(([k]) => !/(_at$|^as_of|generated|read_at|observed_at|request|receipt|elapsed|duration)/.test(k))
        .map(([k, v]) => [k, strip(v)]));
    }
    return value;
  };
  return sha256(canonical(strip(body)));
}

export async function run(ctx, r) {
  const { U, B_main: B, projects } = ctx;
  const scope = projects.p10;
  r.alias('P10', scope.slice(8));
  const snap = async (tag) => {
    const frontier = await r.tool(B, 'clued_mtpe_snapshot', {}, { extract: (b) => ({ status: b?.status ?? null,
      keys: b && typeof b === 'object' ? Object.keys(b).sort() : null }) });
    const counts = (await r.observe(`canonical snapshot ${tag}`, canonicalSnapshotSql, [U.userId]))[0];
    return { frontier: frontierDigest(frontier.structured), frontierOk: !frontier.structured?.error
      && frontier.structured?.status !== 'denied', counts };
  };
  const a = await snap('A');
  r.check('10.snapshot_available', 'the MTPE snapshot is readable through MCP', true, a.frontierOk);

  // Candidate submit / withdraw / reject.
  const nat = await submitNative(r, U, scope, 'seg_s6_e10n', [item('rej', 'fact'), item('keep', 'fact')]);
  const agent = await submitAgent(r, B, scope, 'seg_s6_e10a', [item('wd', 'fact')]);
  const withdrawn = await r.tool(B, 'clued_intake_withdraw', { idempotency_key: key('e10wd'), scope,
    candidate_id: agent.ids.item_wd, base_version: 1 }, { extract: (b) => ({ status: b?.status }) });
  r.check('10.withdraw', 'the Binding withdraws its own candidate', 'committed', withdrawn.structured?.status);
  const rejected = await r.rest(U, 'POST', `/v1/intake/${nat.ids.item_rej}/reject`, { idempotency_key: key('e10rej'),
    base_version: 1, reason: 'Not accurate (synthetic)' }, { extract: (b) => ({ status: b?.status,
    outcome: b?.supplemental?.outcome }) });
  r.check('10.reject', 'the owner rejects a candidate', ['committed', 'rejected'],
    [rejected.body?.status, rejected.body?.supplemental?.outcome]);
  const b = await snap('B');
  r.check('10.frontier_unchanged', 'candidate submit/withdraw/reject leave the Frontier unchanged', a.frontier, b.frontier);
  r.check('10.counts_unchanged', 'MTPE, projection invalidation, Currentness and carriers are unchanged', a.counts, b.counts);

  // Stripped keys + Currentness: a task candidate whose payload carries
  // priority=high, an actionable level and priority-like text; the Native
  // user sets only execution_bucket at step 1.
  const loudText = 'BLOCKER: fix the CRITICAL bug now, priority high, intake_kind TASK, owner_track BUSINESS_GROWTH.';
  const loud = { ...item('loud', 'task', loudText), priority: 'high', action_level: 'needs_action' };
  const loudSub = await submitNative(r, U, scope, 'seg_s6_e10l', [loud]);
  const beforeTask = await snap('before task');
  const loudRecord = r.alias('R_TASK', (await promote(r, U, 'information', loudSub.ids.item_loud,
    { native_type_fields: { execution_bucket: 'later' } })).recordId);
  const c = await snap('C');
  // /v1/records lists omit type_fields; the Native export route returns the
  // Canonical Record body (it writes an export Receipt, no business state).
  const exported = await r.rest(U, 'POST', '/v1/export', { idempotency_key: key('e10exp') },
    { extract: (body) => ({ status: body?.status ?? null }) });
  const findRecord = (value) => {
    if (Array.isArray(value)) { for (const child of value) { const hit = findRecord(child); if (hit) return hit; } return null; }
    if (value && typeof value === 'object') {
      if (value.id === loudRecord && value.type_fields) return value;
      for (const child of Object.values(value)) { const hit = findRecord(child); if (hit) return hit; }
    }
    return null;
  };
  const row = findRecord(exported.body);
  r.check('10.record_found', 'the promoted task body is readable through the Native export route', true, Boolean(row));
  r.check('10.stripped_keys', 'the Record carries none of the stripped priority/MTPE keys from the payload', [],
    STRIPPED.filter((k) => k !== 'execution_bucket' && row?.type_fields && k in row.type_fields));
  r.check('10.native_bucket_only', 'execution_bucket is the Native step-1 choice', 'later', row?.type_fields?.execution_bucket);
  const listed = await r.rest(U, 'GET', `/v1/records?level=project&project_id=${scope.slice(8)}&record_type=task`, undefined,
    { extract: (body) => ({ count: body?.records?.length }) });
  const listedRow = listed.body?.records?.find((rec) => rec.id === loudRecord);
  r.check('10.record_priority', 'the payload priority=high never becomes the Record priority', 0, listedRow?.priority);
  r.check('10.task_currentness', 'task promotion advances scope Currentness (touch_currentness)', true,
    c.counts.currentness > beforeTask.counts.currentness);
  r.check('10.task_mtpe', 'task promotion syncs one row into mtpe_intake_projection', beforeTask.counts.mtpe + 1,
    c.counts.mtpe);
  // Note promotion does not.
  const noteSub = await submitNative(r, U, scope, 'seg_s6_e10q', [item('note', 'fact')]);
  const beforeNote = await snap('before note');
  await promote(r, U, 'information', noteSub.ids.item_note);
  const d = await snap('D');
  r.check('10.note_no_currentness', 'note promotion leaves Currentness and MTPE unchanged',
    [beforeNote.counts.currentness, beforeNote.counts.mtpe, beforeNote.counts.mtpe_digest],
    [d.counts.currentness, d.counts.mtpe, d.counts.mtpe_digest]);
  r.check('10.note_frontier', 'note promotion leaves the Frontier unchanged', beforeNote.frontier, d.frontier);
  return {};
}
