import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { schedulingFixture, digest } from './ci-scheduling-stage1-fixture.mjs';

// Unified scheduling 2A, second part (T2A-2) on the full migration chain:
// lease-next (G1), the lease sweep (G2), the Owner's phase moves (G4), liveness
// freshness (G5), preference and exclusions (G6), availability windows, the
// sixth check (G8) and admissions that survive a duty handover (G9).
// raw-binding-grants: every Binding inserted here is inserted after schedulingFixture(), which calls
// allowRawTestBindings before returning, so the test-only trigger grants it.

test('unified scheduling 2A (T2A-2): lease-next, sweep, phase moves, liveness, preference, exclusions, availability, sixth check, G9', { timeout: 1200000 }, async t => {
  const f = await schedulingFixture(); const { admin, user, project } = f;
  const q = async (text, args = [], c = admin) => (await c.query(text, args)).rows;
  const one = async (text, args = [], c = admin) => (await q(text, args, c))[0];
  const newBinding = async name => (await one(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
    values($1,'synthetic',$2,$3,array['context:read','context:write'],array['*']) returning id`, [user, name, crypto.randomBytes(32).toString('hex')])).id;
  const verify = async id => { await admin.query(`update clued_private.ci_nodes_v1 set qualification_status='verified',qualification_verified_at=now(),
    qualification_expires_at=now()+interval '1 hour',eligible_until=now()+interval '1 hour',hardening_observed=true,qualification_receipt_ref='fixture-reviewed-qualification'
    where node_id=$1`, [id]); await f.live(id); };
  const node = async (profile = {}, { binding, ready = true } = {}) => {
    const reg = f.registration(); reg.binding_id = binding ?? await newBinding('t2a2-node'); reg.profile = { ...reg.profile, ...profile };
    const r = f.committed(await f.native('clued_ci_node_registration_v1', reg)); await f.approve(r.node_id);
    if (ready) await verify(r.node_id);
    return r.node_id;
  };
  const next = async (n, c = admin) => (await one('select clued_private.ci_job_lease_next_v1($1,$2,$3) v', [user, project, n], c)).v;
  const byId = async (n, id) => (await one('select clued_private.ci_job_lease_v1($1,$2,$3,$4,(select version from clued_private.ci_jobs_v1 where job_id=$4)) v',
    [user, project, n, id])).v;
  const job = id => one('select * from clued_private.ci_jobs_v1 where job_id=$1', [id]);
  const clearQueue = async () => {
    await admin.query("update clued_private.ci_job_leases_v1 set state='released',terminal_at=now() where user_id=$1 and state='current'", [user]);
    await admin.query("update clued_private.ci_jobs_v1 set state='canceled' where user_id=$1 and state in ('queued','leased','started','result_ready')", [user]);
  };
  const expire = id => admin.query(`update clued_private.ci_job_leases_v1 set issued_at=now()-interval '11 minutes',expires_at=now()-interval '1 second'
    where job_id=$1 and state='current'`, [id]);
  const sweep = async () => (await one('select clued_private.ci_job_lease_sweep_v1() v')).v;
  const started = (n, id, g = 1) => one('select clued_private.ci_job_started_v1($1,$2,$3,$4,$5) v', [user, project, n, id, g]);
  const issuePhase = (from, to, attestations, extra = {}) => f.native('clued_ci_nodes_v1', { project_id: project }).then(view =>
    f.native('clued_ci_phase_confirmation_issue_v1', { project_id: project, base_version: view.pool.version, expected_phase: from, target_phase: to,
      attestations, accepted_ref: 'fixture-owner-phase-acceptance', ...extra }));
  const movePhase = async (from, to, attestations) => {
    const issue = await issuePhase(from, to, attestations); assert.equal(issue.status, 'issued', JSON.stringify(issue));
    return f.committed(await f.native('clued_ci_phase_apply_v1', { confirmation_token: issue.confirmation_token, view_digest: issue.view_digest }));
  };
  const policy = async () => (await one("select policy from clued_private.ci_quota_counters_v1 where user_id=$1 and project_id=$2 and row_kind='pool_policy'", [user, project])).policy;
  const hhmm = minutes => { const m = ((minutes % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

  try {
    let nodeA;
    await t.test('closed surfaces: new private functions run for nobody; the two phase RPCs only for a signed-in Owner', async () => {
      for (const fn of ['ci_job_lease_next_v1(uuid,uuid,uuid)', 'ci_job_lease_sweep_v1()', 'ci_job_lease_expire_v1(uuid,uuid,uuid,bigint)',
        'ci_job_lease_sweep_account_v1(uuid)', 'ci_job_fit_v1(clued_private.ci_jobs_v1,clued_private.ci_nodes_v1,timestamp with time zone,text)',
        'ci_phase_move_unmet_v1(uuid,uuid,integer,integer)', 'ci_phase_moves_view_v1(uuid,uuid)', 'ci_node_live_v1(uuid)',
        'ci_admission_issue_valid_v1(uuid,clued_private.work_claim_execution_admissions_v1,uuid)', 'ci_node_available_v1(jsonb,timestamp with time zone)'])
        for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway'])
          assert.equal((await one(`select has_function_privilege($1,'clued_private.${fn}','execute') x`, [role])).x, false, fn + ' ' + role);
      for (const fn of ['clued_ci_phase_confirmation_issue_v1(jsonb)', 'clued_ci_phase_apply_v1(jsonb)'])
        for (const [role, allowed] of [['anon', false], ['authenticated', true], ['service_role', false], ['clued_worker_gateway', false]])
          assert.equal((await one(`select has_function_privilege($1,'public.${fn}','execute') x`, [role])).x, allowed, fn + ' ' + role);
      assert.equal((await one("select to_regprocedure('clued_private.ci_t2a2_patch_v1(text,text,text)') p")).p, null);
      assert.match((await one("select pg_get_constraintdef(oid) d from pg_constraint where conname='ci_publish_keys_v1_check_name_check'")).d, /kooyumi-work-admission/);
    });

    await t.test('phase 1 is unchanged (prepared pool refuses), then G4 1->2: machine checks, Owner ticks, two steps, mode active', async () => {
      f.committed(await f.pool());
      const other = await node();
      await assert.rejects(() => next(other), /CI_SCHEDULING_NOT_ACTIVATED/);
      assert.deepEqual((await sweep()).accounts, []);
      let view = (await f.native('clued_ci_nodes_v1', { project_id: project })).phase_moves;
      assert.deepEqual(view, { phase: 1, moves: [{ target_phase: 2, attestations: ['two_node_assumptions_a1_a5_installed'], unmet: ['publisher_not_ready:' + f.binding] }] });
      await assert.rejects(() => issuePhase(1, 2, ['two_node_assumptions_a1_a5_installed']), /CI_PHASE_CONDITION_UNMET:publisher_not_ready/);
      nodeA = await node({}, { binding: f.binding });   // the ci-admission holder's own node: approved, qualified, alive
      view = (await f.native('clued_ci_nodes_v1', { project_id: project })).phase_moves;
      assert.deepEqual(view.moves[0].unmet, []);
      await f.live(nodeA, '21 minutes');
      await assert.rejects(() => issuePhase(1, 2, ['two_node_assumptions_a1_a5_installed']), /publisher_not_ready/, 'a silent publisher blocks the move');
      await f.live(nodeA);
      await assert.rejects(() => issuePhase(1, 2, []), /CI_PHASE_ATTESTATION_MISMATCH/);
      await assert.rejects(() => issuePhase(1, 2, ['two_node_assumptions_a1_a5_installed', 'other']), /CI_PHASE_ATTESTATION_MISMATCH/);
      await assert.rejects(() => issuePhase(1, 2, ['two_node_assumptions_a1_a5_installed'], { accepted_ref: ' ' }), /CI_PHASE_REQUEST_INVALID/);
      await assert.rejects(() => issuePhase(1, 3, []), /move_not_offered/);
      await assert.rejects(() => issuePhase(2, 3, ['stage2_exit_acceptance_passed']), /phase_changed/);
      const before = await policy();
      const issue = await issuePhase(1, 2, ['two_node_assumptions_a1_a5_installed']);
      const applied = f.committed(await f.native('clued_ci_phase_apply_v1', { confirmation_token: issue.confirmation_token, view_digest: issue.view_digest }));
      assert.deepEqual([applied.from_phase, applied.to_phase, applied.pool.phase, applied.pool.mode, applied.pool.status], [1, 2, 2, 'active', 'ACTIVE']);
      assert.deepEqual((await policy()).limits, before.limits);
      assert.equal((await f.native('clued_ci_phase_apply_v1', { confirmation_token: issue.confirmation_token, view_digest: issue.view_digest })).replayed, true);
      const receipt = await one("select metadata from public.clued_audit_receipts where id=$1", [applied.receipt_id]);
      assert.deepEqual([receipt.metadata.from_phase, receipt.metadata.to_phase, receipt.metadata.attestations, receipt.metadata.accepted_ref],
        [1, 2, ['two_node_assumptions_a1_a5_installed'], 'fixture-owner-phase-acceptance']);
      // A pool apply at phase 2 keeps the phase and the mode (T2A); a stale move preview is refused.
      const stale = await issuePhase(2, 1, []);
      const view2 = await f.native('clued_ci_nodes_v1', { project_id: project });
      const limitsIssue = await f.native('clued_ci_pool_confirmation_issue_v1', { project_id: project, base_version: view2.pool.version, limits: null });
      f.committed(await f.native('clued_ci_pool_apply_v1', { confirmation_token: limitsIssue.confirmation_token, view_digest: limitsIssue.view_digest }));
      const kept = await policy(); assert.deepEqual([kept.phase, kept.mode], [2, 'active']);
      const refused = await f.native('clued_ci_phase_apply_v1', { confirmation_token: stale.confirmation_token, view_digest: stale.view_digest });
      assert.deepEqual([refused.status, refused.error_code], ['rejected', 'confirmation_view_stale']);
      assert.equal((await policy()).phase, 2);
      const view3 = await f.native('clued_ci_nodes_v1', { project_id: project });
      const restore = await f.native('clued_ci_pool_confirmation_issue_v1', { project_id: project, base_version: view3.pool.version, limits: before.limits, accepted_ref: 'fixture' });
      f.committed(await f.native('clued_ci_pool_apply_v1', { confirmation_token: restore.confirmation_token, view_digest: restore.view_digest }));
    });

    await t.test('G4 2->3 needs three days of phase 2 and no unknown publication; 3->4 is not offered; 3->2; 2->1 only on a drained pool', async () => {
      await assert.rejects(() => issuePhase(2, 3, ['stage2_exit_acceptance_passed']), /phase2_under_3_days/);
      await admin.query(`update public.clued_audit_receipts set created_at=now()-interval '4 days' where user_id=$1 and operation='ci_phase_move' and metadata->>'to_phase'='2'`, [user]);
      await assert.rejects(() => issuePhase(2, 3, []), /CI_PHASE_ATTESTATION_MISMATCH/);
      assert.equal((await movePhase(2, 3, ['stage2_exit_acceptance_passed'])).to_phase, 3);
      const view = (await f.native('clued_ci_nodes_v1', { project_id: project })).phase_moves;
      assert.deepEqual(view, { phase: 3, moves: [{ target_phase: 2, attestations: [], unmet: [] }] });
      await assert.rejects(() => issuePhase(3, 4, []), /move_not_offered/);
      assert.equal((await movePhase(3, 2, [])).to_phase, 2);
      const id = await f.enqueue(); assert.equal((await next(nodeA)).job_id, id);
      await assert.rejects(() => issuePhase(2, 1, []), /pool_not_drained/);
      await clearQueue();
      const down = await movePhase(2, 1, []);
      assert.deepEqual([down.pool.phase, down.pool.mode, down.pool.status], [1, 'prepared', 'CONFIGURED_PREPARED']);
      await assert.rejects(() => f.enqueue(), /CI_SCHEDULING_NOT_ACTIVATED/);
    });

    await t.test('G5: every node operation needs a heartbeat within 20 minutes', async () => {
      await f.modelMode(2);
      const x = await node();
      const current = () => one('select (clued_private.ci_node_current_v1($1,$2,$3)).node_id n', [user, project, x]);
      assert.equal((await current()).n, x);
      await admin.query('delete from clued_private.ci_node_liveness_v1 where node_id=$1', [x]);
      await assert.rejects(current, /CI_NODE_NOT_ELIGIBLE/);
      await f.live(x, '21 minutes'); await assert.rejects(current, /CI_NODE_NOT_ELIGIBLE/);
      await f.live(x, '19 minutes'); assert.equal((await current()).n, x);
    });

    await t.test('profile: availability and preference are accepted only in their exact form; the preference is copied to the node', async () => {
      const relay = await node({ preference: 'relay', availability: { timezone: 'Asia/Shanghai', windows: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '18:30' }] } }, { ready: false });
      const row = await one('select preference,profile from clued_private.ci_nodes_v1 where node_id=$1', [relay]);
      assert.equal(row.preference, 'relay'); assert.equal(row.profile.availability.timezone, 'Asia/Shanghai');
      for (const bad of [{ preference: 'first' }, { availability: { timezone: 'Mars/Base', windows: [{ days: [1], start: '09:00', end: '18:00' }] } },
        { availability: { timezone: 'UTC', windows: [] } }, { availability: { timezone: 'UTC', windows: [{ days: [0], start: '09:00', end: '18:00' }] } },
        { availability: { timezone: 'UTC', windows: [{ days: [1, 1], start: '09:00', end: '18:00' }] } },
        { availability: { timezone: 'UTC', windows: [{ days: [1], start: '24:00', end: '18:00' }] } },
        { availability: { timezone: 'UTC', windows: [{ days: [1], start: '09:00', end: '09:00' }] } },
        { availability: { timezone: 'UTC', windows: [{ days: [1], start: '9:00', end: '18:00' }] } },
        { availability: { timezone: 'UTC', windows: [{ days: [1], start: '09:00', end: '18:00', note: 'x' }] } },
        { availability: { timezone: 'UTC' } }]) {
        const reg = f.registration(); reg.binding_id = await newBinding('bad-profile'); reg.profile = { ...reg.profile, ...bad };
        await assert.rejects(() => f.native('clued_ci_node_registration_v1', reg), /CI_REGISTRATION_INVALID/, JSON.stringify(bad));
      }
      const at = async (profile, ts) => (await one('select clued_private.ci_node_available_v1($1::jsonb,$2::timestamptz) v', [JSON.stringify(profile), ts])).v;
      const office = { availability: { timezone: 'Asia/Shanghai', windows: [{ days: [1], start: '09:00', end: '18:00' }] } };
      assert.equal(await at(office, '2026-11-02T02:00:00Z'), true);    // Monday 10:00 in Shanghai
      assert.equal(await at(office, '2026-11-02T11:00:00Z'), false);   // Monday 19:00
      assert.equal(await at(office, '2026-11-03T02:00:00Z'), false);   // Tuesday 10:00
      const night = { availability: { timezone: 'Asia/Shanghai', windows: [{ days: [5], start: '22:00', end: '06:00' }] } };
      assert.equal(await at(night, '2026-11-06T15:00:00Z'), true);     // Friday 23:00
      assert.equal(await at(night, '2026-11-06T21:00:00Z'), true);     // Saturday 05:00, the Friday window's tail
      assert.equal(await at(night, '2026-11-07T14:00:00Z'), false);    // Saturday 22:00
      assert.equal(await at({ availability: { timezone: 'Asia/Shanghai', windows: [{ days: [1], start: '20:00', end: '24:00' }] } }, '2026-11-02T15:59:00Z'), true);
      assert.equal(await at({}, '2026-11-02T15:59:00Z'), true);
    });

    let nB, nC;
    await t.test('G1: lease-next takes priority, then queue time; never maintenance; a requested node; capacity; leases by id obey the same filter', async () => {
      await clearQueue(); nB = await node(); nC = await node();
      const j1 = await f.enqueue(), j2 = await f.enqueue(), j3 = await f.enqueue();
      await admin.query("update clued_private.ci_jobs_v1 set priority=0 where job_id=$1", [j3]);
      await admin.query("update clued_private.ci_jobs_v1 set queued_at=now()-interval '1 hour' where job_id=$1", [j2]);
      const first = await next(nB);
      assert.equal(first.state, 'leased'); assert.equal(first.job_id, j3); assert.equal(first.job.job_id, j3); assert.equal(first.generation, 1);
      assert.equal(first.job.head_sha, (await job(j3)).head_sha); assert.equal(first.job.claim_id, undefined, 'claim internals stay private');
      assert.equal((await next(nB)).job_id, j2); assert.equal((await next(nB)).job_id, j1);
      assert.deepEqual(await next(nB), { state: 'none', tried: 0, skipped: [] });
      const maintenance = await f.enqueue({ kind: 'maintenance', role: 'train-maintenance' });
      assert.equal((await next(nB)).state, 'none');
      await assert.rejects(() => byId(nB, maintenance), /CI_JOB_KIND_NOT_LEASABLE/);
      assert.equal((await job(maintenance)).state, 'queued');
      const wanted = await f.enqueue(); await admin.query('update clued_private.ci_jobs_v1 set requested_node_id=$2 where job_id=$1', [wanted, nC]);
      assert.equal((await next(nB)).state, 'none'); await assert.rejects(() => byId(nB, wanted), /CI_JOB_REQUESTED_ELSEWHERE/);
      assert.equal((await next(nC)).job_id, wanted);
      const small = await node({ slot_count: 1 }); await f.enqueue(); await f.enqueue();
      assert.equal((await next(small)).state, 'leased');
      assert.deepEqual(await next(small), { state: 'none', reason: 'CI_NODE_CAPACITY_UNAVAILABLE', tried: 0 });
      // A job that fails at lease time (here: its claim moved on) is skipped, not fatal.
      await clearQueue();
      const broken = await f.enqueue(), fine = await f.enqueue();
      await admin.query("update clued_private.ci_jobs_v1 set priority=0,claim_fence=claim_fence+100 where job_id=$1", [broken]);
      const skipped = await next(nB);
      assert.equal(skipped.job_id, fine); assert.deepEqual(skipped.tried, 2);
      await clearQueue();
      await admin.query("update clued_private.ci_jobs_v1 set state='queued' where job_id=$1", [broken]);
      assert.deepEqual(await next(nB), { state: 'none', tried: 1, skipped: [{ job_id: broken, error_code: 'CI_CLAIM_NOT_CURRENT' }] });
      await clearQueue();
    });

    await t.test('G6: node exclusions and required capabilities, by lease-next and by id', async () => {
      const noLinux = await node({ exclusions: ['linux'] }), noScan = await node({ exclusions: ['scan'] }), docker = await node({ capabilities: ['docker'] });
      const plain = await f.enqueue();
      assert.equal((await next(noLinux)).state, 'none'); await assert.rejects(() => byId(noLinux, plain), /CI_NODE_EXCLUDES_JOB/);
      await admin.query("update clued_private.ci_nodes_v1 set exclusions='[\"linux\"]' where node_id=$1", [docker]);
      await assert.rejects(() => byId(docker, plain), /CI_NODE_EXCLUDES_JOB/, 'the node column counts as well');
      await admin.query("update clued_private.ci_nodes_v1 set exclusions='[]' where node_id=$1", [docker]);
      const scan = await f.enqueue({ kind: 'delegated_scan' });
      await assert.rejects(() => byId(noScan, scan), /CI_NODE_EXCLUDES_JOB/);
      const needsDocker = await f.enqueue({ required_capabilities: ['docker'] });
      assert.deepEqual((await job(needsDocker)).required_capabilities, ['docker']);
      await assert.rejects(() => byId(nB, needsDocker), /CI_NODE_CAPABILITY_MISSING/);
      assert.equal((await byId(docker, needsDocker)).state, 'leased');
      await assert.rejects(() => f.enqueue({ required_capabilities: ['quantum'] }), /CI_JOB_SCALAR_INVALID/);
      await assert.rejects(() => f.enqueue({ required_capabilities: 'docker' }), /CI_JOB_SCALAR_INVALID/);
      await clearQueue();
    });

    await t.test('G6/6.4: a job excludes its lost node unless no other ready node could take it; never for a depth-1 execution', async () => {
      const h1 = await node({ capabilities: ['hyper-v'] });
      const only = await f.enqueue({ kind: 'github_f_pr', required_capabilities: ['hyper-v'] });
      await admin.query('update clued_private.ci_jobs_v1 set excluded_node_ids=array[$2::uuid] where job_id=$1', [only, h1]);
      assert.equal((await next(h1)).job_id, only, 'waived: no other ready node has hyper-v');
      const h2 = await node({ capabilities: ['hyper-v'] });
      const other = await f.enqueue({ kind: 'github_f_pr', required_capabilities: ['hyper-v'] });
      await admin.query('update clued_private.ci_jobs_v1 set excluded_node_ids=array[$2::uuid] where job_id=$1', [other, h1]);
      assert.equal((await next(h1)).state, 'none'); await assert.rejects(() => byId(h1, other), /CI_NODE_EXCLUDED_FOR_JOB/);
      assert.equal((await next(h2)).job_id, other);
      const depth1 = await f.enqueue({ required_capabilities: ['hyper-v'] });
      await admin.query('update clued_private.ci_jobs_v1 set excluded_node_ids=array[$2::uuid] where job_id=$1', [depth1, h1]);
      await admin.query('delete from clued_private.ci_node_liveness_v1 where node_id=$1', [h2]);
      await assert.rejects(() => byId(h1, depth1), /CI_NODE_EXCLUDED_FOR_JOB/, 'its head key is already burned on h1');
      await f.live(h2); await clearQueue();
    });

    await t.test('availability: outside its window a node gets no job, inside it does; relay and overflow wait 60 seconds', async () => {
      const now = new Date(); const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
      const out = await node({ availability: { timezone: 'UTC', windows: [{ days: ALL_DAYS, start: hhmm(minute + 120), end: hhmm(minute + 180) }] } });
      const inside = await node({ availability: { timezone: 'UTC', windows: [{ days: ALL_DAYS, start: hhmm(minute - 60), end: hhmm(minute + 60) }] } });
      const id = await f.enqueue();
      assert.equal((await next(out)).state, 'none'); await assert.rejects(() => byId(out, id), /CI_NODE_OUTSIDE_AVAILABILITY/);
      assert.equal((await next(inside)).job_id, id);
      for (const preference of ['relay', 'overflow']) {
        const late = await node({ preference }); const fresh = await f.enqueue();
        assert.equal((await next(late)).state, 'none'); await assert.rejects(() => byId(late, fresh), /CI_NODE_PREFERENCE_WAIT/);
        await admin.query("update clued_private.ci_jobs_v1 set queued_at=now()-interval '61 seconds' where job_id=$1", [fresh]);
        assert.equal((await next(late)).job_id, fresh);
      }
      await clearQueue();
    });

    await t.test('three and five nodes pulling at once: each job is leased once, each node gets at most what is there', async () => {
      const pool = []; for (let i = 0; i < 5; i++) pool.push(await node());
      for (const count of [3, 5]) {
        await clearQueue(); const jobs = []; for (let i = 0; i < 5; i++) jobs.push(await f.enqueue());
        const clients = []; for (let i = 0; i < count; i++) clients.push(await f.connect());
        const got = await Promise.all(pool.slice(0, count).map((n, i) => next(n, clients[i])));
        assert.ok(got.every(r => r.state === 'leased'), JSON.stringify(got));
        assert.equal(new Set(got.map(r => r.job_id)).size, count);
        assert.ok(got.every(r => jobs.includes(r.job_id)));
        assert.equal(Number((await one("select count(*) n from clued_private.ci_job_leases_v1 where job_id=any($1) and state='current'", [jobs])).n), count);
        assert.equal(Number((await one("select count(*) n from clued_private.ci_jobs_v1 where job_id=any($1) and state='queued'", [jobs])).n), 5 - count);
      }
      await clearQueue();
    });

    await t.test('G2: an expired lease that never started goes back to the queue (restored), uncounted, for any node', async () => {
      const id = await f.enqueue(); assert.equal((await next(nB)).job_id, id);
      assert.deepEqual((await sweep()).accounts, [], 'a current lease is not swept');
      await expire(id);
      const swept = await sweep();
      assert.equal(swept.accounts.length, 1); assert.equal(swept.accounts[0].leases[0].outcome, 'restored');
      const j = await job(id); assert.deepEqual([j.state, j.origin], ['queued', 'restored']);
      const l = await one('select * from clued_private.ci_job_leases_v1 where job_id=$1 and generation=1', [id]);
      assert.deepEqual([l.state, l.terminal_reason, l.terminal_class, l.classification_verified], ['expired', 'LEASE_EXPIRED', 'environment', true]);
      assert.equal(Number((await one("select count(*) n from clued_private.ci_quota_counters_v1 where job_id=$1 and metric='head_release'", [id])).n), 0);
      assert.equal(Number((await one("select count(*) n from public.clued_audit_receipts where operation='ci_job_restored' and object_id=$1", [id])).n), 1);
      const again = await next(nC); assert.deepEqual([again.job_id, again.generation], [id, 2]);
      assert.deepEqual((await sweep()).accounts, []);
      await clearQueue();
    });

    await t.test('G2: a started job whose lease is lost: retried once elsewhere (6.4 rule 3), then an alert; phase 4 burns a depth-1 head; control never moves', async () => {
      const lost = async (n, id, g = 1) => { await started(n, id, g); await expire(id); const s = await sweep(); return s.accounts[0].leases.find(x => x.job_id === id); };
      const id = await f.enqueue(); assert.equal((await next(nB)).job_id, id);
      const first = await lost(nB, id);
      assert.equal(first.outcome, 'retried');
      assert.equal((await job(id)).state, 'failed');
      const retry = await job(first.retry_job_id);
      assert.deepEqual([retry.state, retry.attempt, retry.origin, retry.retry_of_job_id, retry.excluded_node_ids, retry.head_sha],
        ['queued', 2, 'backoff-retry', id, [nB], (await job(id)).head_sha]);
      await assert.rejects(() => byId(nB, retry.job_id), /CI_NODE_EXCLUDED_FOR_JOB/);
      assert.equal((await next(nC)).job_id, retry.job_id);
      const second = await lost(nC, retry.job_id);
      assert.equal(second.outcome, 'lost_final'); assert.equal(second.retry_job_id, null);
      assert.equal(Number((await one('select count(*) n from clued_private.ci_jobs_v1 where retry_of_job_id=$1', [retry.job_id])).n), 0);
      const alert = await one("select metadata from public.clued_audit_receipts where operation='ci_job_lease_lost' and object_id=$1", [retry.job_id]);
      assert.deepEqual([alert.metadata.outcome, alert.metadata.alert], ['lost_final', true]);
      // delegated scan: retried with the parent tuple unchanged
      const scan = await f.enqueue({ kind: 'delegated_scan', parent_job_id: id, parent_lease_generation: 1 });
      assert.equal((await next(nB)).job_id, scan);
      const scanLost = await lost(nB, scan);
      const scanRetry = await job(scanLost.retry_job_id);
      assert.deepEqual([scanLost.outcome, scanRetry.kind, scanRetry.parent_job_id, Number(scanRetry.parent_lease_generation)], ['retried', 'delegated_scan', id, 1]);
      // control: no retry
      await clearQueue();
      const control = await f.enqueue({ kind: 'control' }); assert.equal((await next(nB)).job_id, control);
      assert.equal((await lost(nB, control)).outcome, 'lost_no_retry');
      // phase 4: the head is spent pool-wide
      await f.modelMode(4);
      const burned = await f.enqueue(); assert.equal((await next(nB)).job_id, burned);
      assert.equal((await lost(nB, burned)).outcome, 'lost_head_burned');
      await f.modelMode(2); await clearQueue();
    });

    await t.test('G2: available results past their time expire', async () => {
      const id = await f.enqueue();
      const r = await one(`insert into clued_private.ci_result_index_v1(user_id,project_id,job_id,execution_generation,producer_node_id,result_kind,result_digest,certificate_digest,
        signature_envelope,source_sha,combination_sha256,qualification_ref,produced_at,expires_at) select user_id,project_id,job_id,1,$2,'gitleaks',$3,$3,'{}',source_sha,combination_sha256,'q',
        now()-interval '7 hours',now()-interval '1 hour' from clued_private.ci_jobs_v1 where job_id=$1 returning result_id`, [id, nB, digest('stale result')]);
      const swept = await sweep(); assert.equal(swept.accounts[0].expired_results, 1);
      assert.equal((await one('select state from clued_private.ci_result_index_v1 where result_id=$1', [r.result_id])).state, 'expired');
      await clearQueue();
    });

    await t.test('G8: the sixth check passes the reservation input check; an unknown check does not', async () => {
      const id = await f.enqueue();
      const data = check => ({ check_name: check, request_digest: digest('wrong'), nonce_id: crypto.randomUUID(), nonce: 'n'.repeat(43),
        landing_window_seconds: 300, external_facts_digest: digest('facts') });
      const prepare = check => one('select clued_private.ci_publish_prepare_v1($1,$2,$3,$4,1,$5::jsonb) v', [user, project, nB, id, JSON.stringify(data(check))]);
      await assert.rejects(() => prepare('kooyumi-work-admission'), /CI_REQUEST_DIGEST_MISMATCH/);
      await assert.rejects(() => prepare('kooyumi-other'), /CI_PUBLICATION_INPUT_INVALID/);
      await clearQueue();
    });

    await t.test('G9: a handover does not void jobs admitted before it; a revoked issuer node does', async () => {
      const id = await f.enqueue();
      assert.equal((await one('select e.issuer_on_duty x from clued_private.work_claim_execution_admissions_v1 e join clued_private.ci_jobs_v1 j on j.admission_id=e.admission_id where j.job_id=$1', [id])).x, true);
      const receipt = (await one(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,version,metadata)
        values($1,'global','binding_role_revoke','binding_role','fixture',1,'{}') returning id`, [user])).id;
      await admin.query("update clued_private.binding_roles_v1 set revoked_at=now(),revoked_receipt_id=$2 where user_id=$1 and binding_id=$3 and role='ci-admission' and revoked_at is null", [user, receipt, f.binding]);
      assert.equal((await next(nB)).job_id, id, 'the old holder\'s admission still admits');
      await clearQueue(); await admin.query("update clued_private.ci_jobs_v1 set state='queued' where job_id=$1", [id]);
      const issue = await f.native('clued_ci_node_confirmation_issue_v1', { project_id: project, node_id: nodeA,
        base_version: Number((await one('select version from clued_private.ci_nodes_v1 where node_id=$1', [nodeA])).version), action: 'revoke' });
      f.committed(await f.native('clued_ci_node_apply_v1', { confirmation_token: issue.confirmation_token, view_digest: issue.view_digest }));
      assert.deepEqual(await next(nB), { state: 'none', tried: 1, skipped: [{ job_id: id, error_code: 'CI_ADMISSION_BINDING_NOT_CURRENT' }] });
    });
  } finally { await f.close(); }
});
