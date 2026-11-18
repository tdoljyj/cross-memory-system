import assert from 'node:assert/strict';
import test from 'node:test';
import { schedulingFixture, uuid, digest } from './ci-scheduling-stage1-fixture.mjs';
import { setWorkerGatewayCaller } from './worker-gateway-caller-fixture.mjs';

test('pending TURING-shaped node receives a fresh heartbeat through the original heartbeat-only credential after expiry and rebind', { timeout: 900000 }, async () => {
  const f = await schedulingFixture();
  try {
    const issue = async (kind, input) => {
      const preview = await f.native('clued_headless_' + kind + '_confirmation_issue_v1', input);
      assert.equal(preview.status, 'issued');
      return f.committed(await f.native('clued_headless_' + kind + '_issue_v1', {
        confirmation_token: preview.confirmation_token, view_digest: preview.view_digest }));
    };
    const selected = [{ resource_kind: 'scope', resource_id: 'project:' + f.project, environment: 'canonical', actions: ['read'] }];
    const old = await issue('binding', { label: 'old CI', days: 30, selected });
    const next = await issue('binding', { label: 'new CI', days: 30, selected });
    const heartbeat = await issue('heartbeat_binding', { label: 'heartbeat', days: 30 });
    const registration = f.committed(await f.native('clued_ci_node_registration_v1', { ...f.registration(), binding_id: old.binding_id }));
    await f.admin.query(`insert into clued_private.ci_node_heartbeat_link_v1(user_id,heartbeat_binding_id,node_binding_id,linked_at,linked_receipt_id)
      values($1,$2,$3,clock_timestamp(),$4)`, [f.user, heartbeat.binding_id, old.binding_id, heartbeat.receipt_id]);
    const client = await f.connect('anon');
    const beat = async () => (await client.query('select public.clued_work_verify_v1($1,$2) v', [digest(heartbeat.token),
      { action: 'ci_node_heartbeat', scope: 'global', state: 'NORMAL', mode: 'STANDBY', service_running: true, snapshot_age_seconds: 0 }])).rows[0].v;
    const nodes = async () => (await f.admin.query('select clued_private.ci_failover_nodes_v1($1) v', [f.user])).rows[0].v;
    assert.equal((await beat()).node_binding_id, old.binding_id);
    await f.admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1", [old.binding_id]);
    await f.admin.query('select clued_private.binding_expiry_sweep_v1()');
    assert.equal((await beat()).error_code, 'ci_node_not_registered');
    assert.equal((await f.admin.query('select (clued_private.resolve_heartbeat_binding_v1($1)).id', [digest(heartbeat.token)])).rows[0].id, heartbeat.binding_id);
    const preview = await f.native('clued_ci_node_binding_rebind_confirmation_issue_v1', { project_id: f.project,
      node_id: registration.node_id, old_binding_id: old.binding_id, new_binding_id: next.binding_id,
      base_version: 1, binding_generation: 1, accepted_ref: 'pending-node-recovery', idempotency_key: uuid() });
    assert.equal(preview.status, 'issued');
    const result = f.committed(await f.native('clued_ci_node_binding_rebind_apply_v1', {
      confirmation_token: preview.confirmation_token, view_digest: preview.view_digest }));
    assert.equal(result.state, 'pending');
    assert.ok(!(await nodes()).some(x => x.node?.node_id === registration.node_id), 'old liveness is discarded');
    const heard = await beat();
    assert.equal(heard.status, 'ok');
    assert.equal(heard.via_link, true);
    assert.equal(heard.node_binding_id, next.binding_id);
    assert.deepEqual(heard.node_ids, [registration.node_id]);
    const listing = await nodes();
    const current = listing.find(x => x.binding_id === next.binding_id);
    assert.equal(current?.node.node_id, registration.node_id);
    assert.equal(current.node.stage1_state, 'pending');
    assert.equal(current.node.heartbeat_from_binding_id, heartbeat.binding_id);
    assert.equal(current.node.heartbeat_sequence, 1);
    assert.equal(current.node.last_heartbeat_at, heard.received_at);
    assert.ok(!listing.some(x => x.binding_id === old.binding_id));
  } finally { await f.close(); }
});

// Full migration chain, real Native confirmations and the same database readers
// used by heartbeat and role probes. No deployed database or resident is touched.
// raw-binding-grants: schedulingFixture calls allowRawTestBindings. The first
// end-to-end case uses real Native headless issuance; the matrix below inserts
// isolated v12 authorizations so it does not test the unrelated 50-live limit.
test('expired node connection recovers under the same identity and the heartbeat/role readers see its new binding', { timeout: 900000 }, async () => {
  const f = await schedulingFixture();
  try {
    const issueBinding = async label => {
      const preview = await f.native('clued_headless_binding_confirmation_issue_v1', { label, days: 30,
        selected: [{ resource_kind: 'scope', resource_id: 'project:' + f.project, environment: 'canonical', actions: ['read'] }] });
      return f.committed(await f.native('clued_headless_binding_issue_v1', {
        confirmation_token: preview.confirmation_token, view_digest: preview.view_digest }));
    };
    const old = await issueBinding('old node'), next = await issueBinding('new node'), heartbeat = await issueBinding('heartbeat');
    const registration = { ...f.registration(), binding_id: old.binding_id };
    const node = f.committed(await f.native('clued_ci_node_registration_v1', registration));
    await f.approve(node.node_id);
    await f.admin.query(`insert into clued_private.ci_node_heartbeat_link_v1(user_id,heartbeat_binding_id,node_binding_id,linked_at,linked_receipt_id)
      values($1,$2,$3,clock_timestamp(),$4)`, [f.user, heartbeat.binding_id, old.binding_id, old.receipt_id]);
    await f.admin.query(`update clued_private.authorizations_v12 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1`, [old.binding_id]);
    await f.admin.query('select clued_private.binding_expiry_sweep_v1()');
    const beat = async () => (await f.admin.query(`select clued_private.ci_node_heartbeat_v1(b,$2::jsonb) v
      from public.clued_agent_bindings b where b.id=$1`, [heartbeat.binding_id,
      { action: 'ci_node_heartbeat', scope: 'project:' + f.project, state: 'NORMAL', mode: 'STANDBY', service_running: true, snapshot_age_seconds: 0 }])).rows[0].v;
    const probeClient = await f.connect('anon');
    const probe = async token => (await probeClient.query('select public.clued_work_merge_slot_holders_v1($1,$2) v',
      [digest(token), { scope: 'project:' + f.project, repository: 'fixture/repository-12345' }])).rows[0].v;
    assert.equal((await beat()).error_code, 'ci_node_not_registered', 'expiry actually breaks the heartbeat link');
    await assert.rejects(() => probe(old.token), /binding_not_authorized|authorization_revoked_or_expired/);
    await assert.rejects(() => f.native('clued_ci_node_registration_v1', { ...registration, binding_id: next.binding_id, idempotency_key: uuid() }), /duplicate key/);
    const before = (await f.admin.query('select * from clued_private.ci_nodes_v1 where node_id=$1', [node.node_id])).rows[0];
    const nonce = (await f.admin.query(`insert into clued_private.ci_nonce_ledger_v1(user_id,project_id,nonce_hash,purpose,subject_digest,node_id,key_fingerprint,expires_at)
      values($1,$2,$3,'isolated-generation',$3,$4,$5,clock_timestamp()+interval '10 minutes') returning nonce_id`,
    [f.user, f.project, digest(uuid()), node.node_id, before.identity_fingerprint])).rows[0].nonce_id;
    const preview = await f.native('clued_ci_node_binding_rebind_confirmation_issue_v1', {
      project_id: f.project, node_id: node.node_id, old_binding_id: old.binding_id, new_binding_id: next.binding_id,
      base_version: Number(before.version), binding_generation: Number(before.binding_generation), accepted_ref: 'isolated-test-acceptance', idempotency_key: uuid() });
    assert.equal(preview.status, 'issued');
    const result = f.committed(await f.native('clued_ci_node_binding_rebind_apply_v1', {
      confirmation_token: preview.confirmation_token, view_digest: preview.view_digest }));
    assert.equal(result.binding_id, next.binding_id);
    const after = (await f.admin.query('select * from clued_private.ci_nodes_v1 where node_id=$1', [node.node_id])).rows[0];
    for (const key of ['node_id', 'identity_public_jwk', 'encryption_public_jwk', 'identity_fingerprint', 'encryption_fingerprint'])
      assert.deepEqual(after[key], before[key]);
    assert.equal(Number(after.binding_generation), Number(before.binding_generation) + 1);
    assert.equal(Number(after.version), Number(before.version) + 1);
    assert.equal(after.qualification_status, 'unverified');
    await assert.rejects(() => f.admin.query('select clued_private.ci_gateway_node_v1($1,$2)', [digest(old.token), node.node_id]), /CI_NODE_TRUST_UNAVAILABLE/);
    const trust = (await f.admin.query('select clued_private.ci_gateway_snapshot_v1(clued_private.ci_gateway_node_v1($1,$2)) v', [digest(next.token), node.node_id])).rows[0].v;
    assert.equal(trust.principal.binding_id, next.binding_id); assert.equal(trust.principal.binding_generation, 2);
    assert.equal(trust.node.qualification_verified, false);
    assert.equal(trust.node.binding_expires_at_ms, after.connection_expires_at.getTime());
    const spent = (await f.admin.query('select * from clued_private.ci_nonce_ledger_v1 where nonce_id=$1', [nonce])).rows[0];
    assert.ok(spent.consumed_at); assert.equal(spent.consume_receipt_id, result.receipt_id);
    const gateway = await f.connect(); await setWorkerGatewayCaller(gateway);
    // Synthetic verified-Worker input tests the database's generation fence;
    // cryptographic signature checks themselves remain in ci-node-gateway tests.
    const command = { protocol: 'clued.ci-node-command/1', operation: 'qualification_report', user_id: f.user, project_id: f.project,
      node_id: node.node_id, binding_id: next.binding_id, binding_generation: 1, node_version: Number(before.version), key_version: 1,
      key_fingerprint: before.identity_fingerprint, payload_sha256: digest('{}'), nonce: 'a'.repeat(43), signature: 'a'.repeat(86),
      job_id: null, execution_generation: 0, train_generation: 0, issued_at_ms: Date.now() - 1000, expires_at_ms: Date.now() + 60000 };
    const oldCommand = (await gateway.query('select public.clued_ci_node_command_v1($1,$2,$3,$4) v', [digest(next.token), command, {},
      { operation: command.operation, node_id: node.node_id, payload_sha256: command.payload_sha256, nonce_sha256: digest(command.nonce), verified_at_ms: Date.now() }])).rows[0].v;
    assert.equal(oldCommand.error_code, 'CI_COMMAND_PRINCIPAL_INVALID', JSON.stringify(oldCommand));
    const heard = await beat();
    assert.equal(heard.status, 'ok', JSON.stringify(heard));
    assert.equal(heard.node_binding_id, next.binding_id);
    assert.deepEqual(heard.node_ids, [node.node_id]);
    const roleProbe = await probe(next.token);
    assert.equal(roleProbe.status, 'ok', JSON.stringify(roleProbe));
    assert.equal(roleProbe.reason, 'admission_binding_required', 'the actual role-probe read authenticates the new connection without putting it on duty');
    const current = (await f.admin.query(`select clued_private.ci_failover_node_view_v1($1,$2) v`, [f.user, next.binding_id])).rows[0].v;
    assert.equal(current.node_id, node.node_id);
    assert.equal((await f.admin.query('select clued_private.ci_failover_node_view_v1($1,$2) v', [f.user, old.binding_id])).rows[0].v, null);
    const links = (await f.admin.query('select * from clued_private.ci_node_heartbeat_link_v1 where heartbeat_binding_id=$1 order by linked_at', [heartbeat.binding_id])).rows;
    assert.equal(links.length, 2); assert.ok(links[0].revoked_at); assert.equal(links[1].revoked_at, null);
    assert.equal(links[0].node_binding_id, old.binding_id); assert.equal(links[1].node_binding_id, next.binding_id);
    const replay = await f.native('clued_ci_node_binding_rebind_apply_v1', { confirmation_token: preview.confirmation_token, view_digest: preview.view_digest });
    assert.equal(replay.replayed, true); assert.equal(replay.receipt_id, result.receipt_id);
    assert.equal((await f.admin.query('select binding_id from clued_private.ci_nodes_v1 where node_id=$1', [node.node_id])).rows[0].binding_id, next.binding_id);
  } finally { await f.close(); }
});

test('same-node rebind authorization, CAS, replay, duty, links and expiry reminders on the full PostgreSQL chain', { timeout: 900000 }, async t => {
  const f = await schedulingFixture();
  const sql = async (text, args = []) => (await f.admin.query(text, args)).rows[0];
  const binding = async (project = f.project) => {
    const token = 'isolated_' + uuid();
    const b = await sql(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','isolated-rebind-matrix',$2,array['context:read'],array[$3]) returning id`, [f.user, digest(token), 'project:' + project]);
    await f.admin.query(`insert into clued_private.authorizations_v12(binding_id,owner_id,client_id,client_name,resource,expires_at,issuance)
      values($1,$2,'clued-headless','isolated-rebind-matrix','https://example.invalid/mcp',clock_timestamp()+interval '30 days','headless')`, [b.id, f.user]);
    await f.admin.query(`insert into clued_private.authorization_entries_v12(binding_id,resource_kind,resource_id,environment,actions)
      values($1,'scope',$2,'canonical',array['read'])`, [b.id, 'project:' + project]);
    const receipt = await sql("select clued_private.ci_receipt_v1($1,$2,'isolated_fixture',$3,'{}') id", [f.user, project, b.id]);
    return { binding_id: b.id, receipt_id: receipt.id, token };
  };
  const setup = async () => {
    const old = await binding(), next = await binding();
    const r = f.committed(await f.native('clued_ci_node_registration_v1', { ...f.registration(), binding_id: old.binding_id }));
    return { old, next, node: r.node_id, choices: { project_id: f.project, node_id: r.node_id, old_binding_id: old.binding_id,
      new_binding_id: next.binding_id, base_version: 1, binding_generation: 1, accepted_ref: 'isolated reviewed change', idempotency_key: uuid() } };
  };
  const issue = (x, extra = {}, claims) => f.native('clued_ci_node_binding_rebind_confirmation_issue_v1', { ...x.choices, ...extra }, claims);
  const apply = (p, claims, client) => f.native('clued_ci_node_binding_rebind_apply_v1', { confirmation_token: p.confirmation_token, view_digest: p.view_digest }, claims, client);
  const rejected = (r, code) => { assert.equal(r.status, 'rejected', JSON.stringify(r)); if (code) assert.equal(r.error_code, code, JSON.stringify(r)); };
  try {
    await t.test('only authenticated Native fresh account sessions; private surfaces and ledgers are closed', async () => {
      const x = await setup();
      for (const role of ['anon', 'service_role', 'clued_worker_gateway']) {
        const c = await f.connect(role);
        await assert.rejects(() => c.query('select public.clued_ci_node_binding_rebind_confirmation_issue_v1($1)', [x.choices]), /permission denied/);
        await assert.rejects(() => c.query('select public.clued_ci_node_binding_rebind_apply_v1($1)', [{}]), /permission denied/);
      }
      for (const extra of [{ client_id: 'oauth-client' }, { session_id: uuid() }, { amr: [{ method: 'password', timestamp: 1 }] }])
        await assert.rejects(() => issue(x, {}, f.claims(f.user, f.session, extra)), /direct_human_session_required|storage_native_session_required|CI_NATIVE_SESSION_REQUIRED|reauthentication_required/);
      await assert.rejects(() => issue(x, {}, f.claims(f.other, f.session)), /owned_binding_required|storage_native_session_required|CI_NODE_NOT_FOUND|CI_NATIVE_SESSION_REQUIRED|CI_PROJECT_UNAVAILABLE/);
      for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway']) {
        for (const fn of ['ci_node_rebind_view_v1(uuid,uuid,jsonb)', 'ci_node_rebind_lock_v1(uuid,uuid,jsonb)', 'ci_connection_expiry_remind_v1()'])
          assert.equal((await sql('select has_function_privilege($1,$2,\'execute\') x', [role, 'clued_private.' + fn])).x, false);
        for (const table of ['ci_node_binding_rebinds_v1', 'ci_connection_expiry_reminders_v1'])
          assert.equal((await sql('select has_table_privilege($1,$2,\'select\') x', [role, 'clued_private.' + table])).x, false);
      }
    });
    await t.test('foreign project, insufficient scope, expired/revoked new binding and reused targets refuse', async () => {
      const x = await setup(), foreignProject = await binding(f.project2);
      await assert.rejects(() => issue(x, { new_binding_id: foreignProject.binding_id }), /CI_BINDING_UNAVAILABLE|resource_action_not_authorized/);
      await f.admin.query("update public.clued_agent_bindings set scopes=array['audit:read'] where id=$1", [x.next.binding_id]);
      await assert.rejects(() => issue(x), /CI_BINDING_UNAVAILABLE/);
      await f.admin.query("update public.clued_agent_bindings set scopes=array['context:read'] where id=$1", [x.next.binding_id]);
      await f.admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1", [x.next.binding_id]);
      await assert.rejects(() => issue(x), /CI_BINDING_UNAVAILABLE/);
      await f.admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()+interval '30 days',revoked_at=clock_timestamp() where binding_id=$1", [x.next.binding_id]);
      await assert.rejects(() => issue(x), /authorization_revoked_or_expired/);
      const y = await setup();
      f.committed(await f.native('clued_ci_node_registration_v1', { ...f.registration(f.project2), binding_id: y.next.binding_id }));
      await assert.rejects(() => issue(y), /CI_REBIND_TARGET_IN_USE/);
      const foreignOwner = (await sql(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic','foreign-owner-rebind',$2,array['context:read'],array['*']) returning id`, [f.other, digest(uuid())])).id;
      await assert.rejects(() => issue(x, { new_binding_id: foreignOwner }), /CI_BINDING_UNAVAILABLE/);
      const shared = await setup();
      f.committed(await f.native('clued_ci_node_registration_v1', { ...f.registration(f.project2), binding_id: shared.old.binding_id }));
      await assert.rejects(() => issue(shared), /CI_REBIND_OLD_CONNECTION_SHARED/);
    });
    await t.test('revoked and retired nodes and explicit/unknown binding revocations never revive', async () => {
      for (const state of ['revoked', 'retired']) {
        const x = await setup(); await f.admin.query('update clued_private.ci_nodes_v1 set state=$2 where node_id=$1', [x.node, state]);
        await assert.rejects(() => issue(x), /CI_NODE_TRANSITION_INVALID/);
      }
      for (const operation of [null, 'revoke', 'revoke_self', 'revoke_issuer', 'credential_leak']) {
        const x = await setup();
        await f.admin.query('update public.clued_agent_bindings set revoked_at=clock_timestamp() where id=$1', [x.old.binding_id]);
        if (operation) await f.admin.query('insert into clued_private.authorization_audit_v12(owner_id,binding_id,operation) values($1,$2,$3)', [f.user, x.old.binding_id, operation]);
        await assert.rejects(() => issue(x), /CI_REBIND_OLD_REVOCATION_UNSAFE/);
      }
      const x = await setup();
      await f.admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1", [x.old.binding_id]);
      await f.admin.query('select clued_private.binding_expiry_sweep_v1()');
      await f.admin.query("insert into clued_private.authorization_audit_v12(owner_id,binding_id,operation) values($1,$2,'revoke')", [f.user, x.old.binding_id]);
      await assert.rejects(() => issue(x), /CI_REBIND_OLD_REVOCATION_UNSAFE/);
      const retiredConnection = await setup();
      // Legacy connections have no v12 authorization; their retirement deadline
      // and the actual sweep audit are still an independently verifiable expiry.
      await f.admin.query('delete from clued_private.authorizations_v12 where binding_id=$1', [retiredConnection.old.binding_id]);
      await f.admin.query(`insert into clued_private.binding_retirements_v1(binding_id,owner_id,replaced_by,retire_at,receipt_id)
        values($1,$2,$3,clock_timestamp()-interval '1 second',$4)`,
      [retiredConnection.old.binding_id, f.user, retiredConnection.next.binding_id, retiredConnection.old.receipt_id]);
      await f.admin.query('select clued_private.binding_expiry_sweep_v1()');
      f.committed(await apply(await issue(retiredConnection)));
    });
    await t.test('pending remains pending; expired qualification and cached liveness cannot restore eligibility', async () => {
      const x = await setup(); await f.live(x.node);
      const before = await sql('select * from clued_private.ci_nodes_v1 where node_id=$1', [x.node]);
      const p = await issue(x); assert.equal(p.confirmation_view.effects.qualification.includes('new signed'), true);
      const r = f.committed(await apply(p)); assert.equal(r.state, 'pending'); assert.equal(r.binding_generation, 2);
      const after = await sql('select * from clued_private.ci_nodes_v1 where node_id=$1', [x.node]);
      assert.equal(after.identity_fingerprint, before.identity_fingerprint); assert.equal(after.eligible_until, null);
      assert.equal((await sql('select count(*)::int n from clued_private.ci_node_liveness_v1 where node_id=$1', [x.node])).n, 0);
      const expiry = await sql('select expires_at from clued_private.authorizations_v12 where binding_id=$1', [x.next.binding_id]);
      assert.equal(after.connection_expires_at.toISOString(), expiry.expires_at.toISOString());
      const listing = await f.native('clued_ci_nodes_v1', { project_id: f.project });
      assert.equal(listing.nodes.find(n => n.node_id === x.node).binding_generation, 2);
      assert.equal(Date.parse(listing.nodes.find(n => n.node_id === x.node).connection_expires_at), expiry.expires_at.getTime());
      await assert.rejects(() => f.admin.query('update clued_private.ci_node_binding_rebinds_v1 set result=result'), /CI_PERMANENT_HISTORY/);
      await assert.rejects(() => f.admin.query('delete from clued_private.ci_node_binding_rebinds_v1'), /CI_PERMANENT_HISTORY/);
      await assert.rejects(() => f.admin.query('update public.clued_audit_receipts set metadata=metadata where id=$1', [r.receipt_id]), /CI_PERMANENT_HISTORY/);
      const again = await issue(x); assert.equal(again.replayed, true); assert.equal(again.receipt_id, r.receipt_id);
      await assert.rejects(() => issue(x, { accepted_ref: 'different' }), /CI_IDEMPOTENCY_CONFLICT/);
    });
    await t.test('actual job leases, unobserved publication and train obligations block replacement', async () => {
      await f.pool(); await f.modelMode(2);
      const x = await setup(); await f.approve(x.node); await f.live(x.node);
      // Seed an in-flight job and its real FK parents. This tests the rebind
      // drain gate, independently of the PR admission protocol's own fixtures.
      const head = digest(uuid()).slice(0, 40), hash = digest(uuid());
      const authorization = await sql(`insert into clued_private.work_claim_head_authorizations_v1(user_id,claim_id,execution_epoch,binding_id,
        repository,head_sha,target_branch,pr_ref,idempotency_key,request_digest) values($1,$2,$3,$4,'fixture/repository-12345',$5,'main',
        'fixture/repository-12345#1',$6,$7) returning authorization_id`, [f.user, f.claim.claim_id, f.claim.execution_epoch, f.binding, head, uuid(), hash]);
      const admission = await sql(`insert into clued_private.work_claim_execution_admissions_v1(user_id,claim_id,execution_epoch,ci_binding_id,
        repository,head_sha,target_branch,resources_digest) values($1,$2,$3,$4,'fixture/repository-12345',$5,'main',$6) returning admission_id`,
      [f.user, f.claim.claim_id, f.claim.execution_epoch, f.binding, head, hash]);
      const inserted = await sql(`insert into clued_private.ci_jobs_v1(user_id,project_id,registration_ref,repository_id,repository_name,
        job_key_sha256,kind,task_id,claim_id,claim_fence,execution_epoch,target_branch,head_authorization_id,admission_id,pr_ref,
        head_sha,base_sha,test_sha,source_sha,combination_sha256,role)
        select $1,$2,counter_id,repository_id,repository_name,$3,'combination_execution',$4,$5,$6,$7,'main',$8,$9,
          'fixture/repository-12345#1',$10,$10,$10,$10,$3,'batch' from clued_private.ci_quota_counters_v1
          where user_id=$1 and project_id=$2 and row_kind='repo_registration' returning job_id`,
      [f.user, f.project, hash, f.task, f.claim.claim_id, f.claim.fence, f.claim.execution_epoch, authorization.authorization_id, admission.admission_id, head]);
      const job = inserted.job_id;
      await f.admin.query(`insert into clued_private.ci_job_leases_v1(user_id,project_id,job_id,generation,holder_node_id,holder_binding_id,expires_at,origin)
        values($1,$2,$3,1,$4,$5,clock_timestamp()+interval '10 minutes','queued')`, [f.user, f.project, job, x.node, x.old.binding_id]);
      const choices = { base_version: 2 };
      await assert.rejects(() => issue(x, choices), /CI_REBIND_NOT_DRAINED/);
      await f.admin.query("update clued_private.ci_job_leases_v1 set state='released' where job_id=$1", [job]);
      await f.admin.query("update clued_private.ci_jobs_v1 set state='publication_pending',current_generation=1 where job_id=$1", [job]);
      await assert.rejects(() => issue(x, choices), /CI_REBIND_NOT_DRAINED/);
      await f.admin.query("update clued_private.ci_jobs_v1 set state='completed' where job_id=$1", [job]);
      await f.admin.query(`insert into clued_private.ci_publish_keys_v1(user_id,project_id,registration_ref,repository_id,head_sha,check_name,app_id,
        job_id,publisher_node_id,execution_generation,request_digest,external_id,state,landing_deadline_at)
        select user_id,project_id,registration_ref,repository_id,head_sha,'gitleaks',5368905,job_id,$2,1,$3,$4,'unknown',clock_timestamp()+interval '10 minutes'
          from clued_private.ci_jobs_v1 where job_id=$1`, [job, x.node, digest(uuid()), 'rebind-fixture-' + uuid()]);
      await assert.rejects(() => issue(x, choices), /CI_REBIND_NOT_DRAINED/);
      await f.admin.query("update clued_private.ci_publish_keys_v1 set state='posted' where job_id=$1", [job]);
      await f.admin.query(`insert into clued_private.ci_green_ledger_v1(user_id,project_id,repository_id,head_sha,publish_key_id,job_id,
        publisher_node_id,state,external_id,landing_deadline_at)
        select user_id,project_id,repository_id,head_sha,key_id,job_id,publisher_node_id,'revoke_requested',external_id,landing_deadline_at
          from clued_private.ci_publish_keys_v1 where job_id=$1`, [job]);
      await assert.rejects(() => issue(x, choices), /CI_REBIND_NOT_DRAINED/);
      await f.admin.query("update clued_private.ci_green_ledger_v1 set state='revoke_confirmed' where job_id=$1", [job]);
      f.committed(await apply(await issue(x, choices)));
    });
    await t.test('preview CAS includes binding, authorization, node, links, roles and failover settings', async () => {
      const changes = [
        ['node', x => f.admin.query('update clued_private.ci_nodes_v1 set version=version+1 where node_id=$1', [x.node])],
        ['authorization', x => f.admin.query('update clued_private.authorizations_v12 set version=version+1 where binding_id=$1', [x.next.binding_id])],
        ['new binding', x => f.admin.query("update public.clued_agent_bindings set agent_name='changed' where id=$1", [x.next.binding_id])],
        ['members', x => f.admin.query('insert into clued_private.ci_failover_members_v1(user_id,binding_id,rank,marked_at,receipt_id) values($1,$2,1,clock_timestamp(),$3)', [f.user, x.old.binding_id, x.old.receipt_id])],
        ['link', async x => { const h = await binding(); return f.admin.query('insert into clued_private.ci_node_heartbeat_link_v1(user_id,heartbeat_binding_id,node_binding_id,linked_at,linked_receipt_id) values($1,$2,$3,clock_timestamp(),$4)', [f.user, h.binding_id, x.old.binding_id, h.receipt_id]); }],
      ];
      for (const [label, change] of changes) {
        const x = await setup(), p = await issue(x); await change(x);
        const r = await apply(p); rejected(r); assert.match(r.error_code, /confirmation_view_stale|CI_STALE_VERSION/, label);
        assert.equal((await sql('select binding_id from clued_private.ci_nodes_v1 where node_id=$1', [x.node])).binding_id, x.old.binding_id);
        if (label === 'members') await f.admin.query('delete from clued_private.ci_failover_members_v1 where binding_id=$1', [x.old.binding_id]);
      }
    });
    await t.test('preview invalidated by role changes; current duty requires handover; unsafe roles are not copied', async () => {
      const x = await setup(), p = await issue(x);
      await f.admin.query("insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose) values($1,$2,'ci-admission',clock_timestamp(),$3,clock_timestamp()+interval '5 minutes','resident-node')", [f.user, x.old.binding_id, x.old.receipt_id]);
      rejected(await apply(p), 'confirmation_view_stale');
      await f.admin.query('update clued_private.binding_roles_v1 set revoked_at=clock_timestamp(),revoked_receipt_id=$2 where binding_id=$1 and revoked_at is null', [f.binding, x.old.receipt_id]);
      await f.admin.query("update clued_private.binding_roles_v1 set effective_at=clock_timestamp() where binding_id=$1 and revoked_at is null", [x.old.binding_id]);
      await assert.rejects(() => issue(x), /CI_REBIND_DUTY_HANDOVER_REQUIRED/);
      await f.admin.query("update clued_private.binding_roles_v1 set revoked_at=clock_timestamp(),revoked_receipt_id=$2 where binding_id=$1 and revoked_at is null", [x.old.binding_id, x.old.receipt_id]);
      await f.admin.query("insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id) values($1,$2,'release-door',clock_timestamp(),$3)", [f.user, x.old.binding_id, x.old.receipt_id]);
      await assert.rejects(() => issue(x), /CI_REBIND_ROLE_UNSAFE/);
    });
    await t.test('standby resident purpose, activation delay and failover rank move without acquiring duty', async () => {
      const x = await setup();
      await f.admin.query("insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose) values($1,$2,'ci-admission',clock_timestamp(),$3,clock_timestamp()+interval '5 minutes','resident-node')", [f.user, x.old.binding_id, x.old.receipt_id]);
      await f.admin.query('insert into clued_private.ci_failover_members_v1(user_id,binding_id,rank,marked_at,receipt_id) values($1,$2,1,clock_timestamp(),$3)', [f.user, x.old.binding_id, x.old.receipt_id]);
      const oldRole = await sql('select * from clued_private.binding_roles_v1 where binding_id=$1 and revoked_at is null', [x.old.binding_id]);
      f.committed(await apply(await issue(x)));
      const nextRole = await sql('select * from clued_private.binding_roles_v1 where binding_id=$1 and revoked_at is null', [x.next.binding_id]);
      assert.equal(nextRole.purpose, 'resident-node'); assert.equal(nextRole.effective_at.toISOString(), oldRole.effective_at.toISOString());
      assert.equal((await sql('select rank from clued_private.ci_failover_members_v1 where binding_id=$1', [x.next.binding_id])).rank, 1);
      assert.equal((await sql("select clued_private.binding_role_admits_v1(b,'ci-admission') x from public.clued_agent_bindings b where b.id=$1", [x.next.binding_id])).x, false);
      assert.equal((await f.admin.query('select * from clued_private.ci_duty_holder_v1($1,$2) where binding_id=$3', [f.user, f.project, x.next.binding_id])).rowCount, 0);
      await f.admin.query('delete from clued_private.ci_failover_members_v1 where binding_id=$1', [x.next.binding_id]);
    });
    await t.test('expired or active train lease and current work are refused, even without a live old token', async () => {
      const x = await setup();
      // A residual sweep obligation is not made safe just by its wall-clock expiry.
      await f.admin.query(`insert into clued_private.ci_train_lease_v1(user_id,project_id,holder_node_id,holder_binding_id,state,issued_at,expires_at)
        values($1,$2,$3,$4,'sweep_required',clock_timestamp()-interval '20 minutes',clock_timestamp()-interval '10 minutes')`, [f.user, f.project, x.node, x.old.binding_id]);
      await assert.rejects(() => issue(x), /CI_REBIND_NOT_DRAINED/);
      await f.admin.query('delete from clued_private.ci_train_lease_v1 where user_id=$1 and project_id=$2', [f.user, f.project]);
    });
    await t.test('only one concurrent apply commits, exact replay is immutable, stale previews and sessions refuse', async () => {
      const x = await setup(), p = await issue(x);
      const a = await f.connect('authenticated'), b = await f.connect('authenticated');
      const results = await Promise.all([apply(p, undefined, a), apply(p, undefined, b)]);
      results.forEach(f.committed); assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
      assert.equal(results[0].receipt_id, results[1].receipt_id);
      assert.equal((await sql('select binding_generation from clued_private.ci_nodes_v1 where node_id=$1', [x.node])).binding_generation, '2');
      const busy = await setup(), pending = await issue(busy);
      await b.query('begin');
      try {
        await b.query('select 1 from public.clued_agent_bindings where id=$1 for share', [busy.next.binding_id]);
        await a.query("set lock_timeout='2s'");
        await assert.rejects(() => apply(pending, undefined, a), { code: '55P03', message: 'CI_REBIND_BUSY' });
      } finally { await b.query('rollback'); }
      f.committed(await apply(pending, undefined, a));
      await assert.rejects(() => apply(p, f.claims(f.user, uuid())), /CI_NATIVE_SESSION_REQUIRED|storage_native_session_required/);
      const y = await setup(), first = await issue(y), second = await issue(y, { idempotency_key: uuid() });
      rejected(await apply(first), 'confirmation_token_revoked'); f.committed(await apply(second));
      const z = await setup(), expired = await issue(z);
      // Existing confirmations are immutable: construct an already expired
      // synthetic token instead of disabling its production guard.
      const raw = 'clued_ci_expired_' + uuid();
      await f.admin.query('update clued_private.native_confirmation_tokens set revoked_at=clock_timestamp() where id=$1', [expired.token_id]);
      await f.admin.query(`insert into clued_private.native_confirmation_tokens(user_id,action,subject_key,subject_version,native_choices,confirmation_view,
        view_digest,token_hash,session_id,auth_time,issued_at,expires_at)
        select user_id,action,subject_key,subject_version,native_choices,confirmation_view,view_digest,$2,session_id,auth_time,
          clock_timestamp()-interval '6 minutes',clock_timestamp()-interval '1 second' from clued_private.native_confirmation_tokens where id=$1`, [expired.token_id, digest(raw)]);
      const expiredInput = { ...expired, confirmation_token: raw };
      const refusal = await apply(expiredInput);
      rejected(refusal, 'confirmation_token_expired');
      const retried = await apply(expiredInput);
      rejected(retried, 'confirmation_token_expired');
      assert.equal(retried.receipt_id, refusal.receipt_id);
      assert.equal(retried.replayed, true);
      const same = await setup();
      await f.human.query('begin');
      try { rejected(await apply(await issue(same)), 'confirmation_token_same_request'); }
      finally { await f.human.query('rollback'); }
      const left = await setup(), right = await setup();
      const lp = await issue(left), rp = await issue(right, { new_binding_id: left.next.binding_id });
      const raced = await Promise.all([apply(lp, undefined, a), apply(rp, undefined, b)]);
      assert.equal(raced.filter(r => r.status === 'committed').length, 1);
      assert.equal(raced.find(r => r.status === 'rejected').error_code, 'CI_REBIND_TARGET_IN_USE');
    });
    await t.test('21/14/7/1-day reminders use authorization expiry, deduplicate and reset after renewal, including heartbeat and upgrade', async () => {
      const x = await setup(), h = await binding(), upgrade = await binding();
      await f.admin.query('insert into clued_private.ci_node_heartbeat_link_v1(user_id,heartbeat_binding_id,node_binding_id,linked_at,linked_receipt_id) values($1,$2,$3,clock_timestamp(),$4)', [f.user, h.binding_id, x.old.binding_id, h.receipt_id]);
      await f.admin.query("insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id) values($1,$2,'resident-upgrade',clock_timestamp(),$3)", [f.user, upgrade.binding_id, upgrade.receipt_id]);
      await f.admin.query("update clued_private.ci_nodes_v1 set connection_expires_at=clock_timestamp()+interval '100 days' where node_id=$1", [x.node]);
      for (const days of [21, 14, 7, 1]) {
        await f.admin.query("update clued_private.authorizations_v12 set expires_at=date_trunc('second',clock_timestamp())+($2||' days')::interval where binding_id=any($1::uuid[])", [[x.old.binding_id, h.binding_id, upgrade.binding_id], days]);
        await f.admin.query('select clued_private.binding_expiry_sweep_v1()');
        const before = (await sql('select count(*)::int n from clued_private.ci_connection_expiry_reminders_v1 where binding_id=any($1::uuid[])', [[x.old.binding_id, h.binding_id, upgrade.binding_id]])).n;
        await f.admin.query('select clued_private.binding_expiry_sweep_v1()');
        assert.equal((await sql('select count(*)::int n from clued_private.ci_connection_expiry_reminders_v1 where binding_id=any($1::uuid[])', [[x.old.binding_id, h.binding_id, upgrade.binding_id]])).n, before);
        assert.equal((await sql('select count(*)::int n from clued_private.ci_connection_expiry_reminders_v1 where binding_id=any($1::uuid[]) and threshold_days=$2', [[x.old.binding_id, h.binding_id, upgrade.binding_id], days])).n, 3);
      }
      await f.admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()+interval '20 days' where binding_id=$1", [x.old.binding_id]);
      await f.admin.query('select clued_private.binding_expiry_sweep_v1()');
      assert.equal((await sql('select count(*)::int n from clued_private.ci_connection_expiry_reminders_v1 where binding_id=$1 and threshold_days=21', [x.old.binding_id])).n, 2);
      const listing = await f.native('clued_ci_nodes_v1', { project_id: f.project });
      assert.ok(listing.connection_reminders.some(r => r.binding_id === x.old.binding_id && r.receipt_kind === 'CI_CONNECTION_EXPIRING'));
      const otherListing = await f.native('clued_ci_nodes_v1', { project_id: f.project2 });
      assert.ok(!otherListing.connection_reminders.some(r => r.binding_id === x.old.binding_id || r.binding_id === h.binding_id));
      await assert.rejects(() => f.admin.query('delete from clued_private.ci_connection_expiry_reminders_v1'), /CI_PERMANENT_HISTORY/);
      const edge = await setup();
      await f.admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()+interval '21 days 1 minute' where binding_id=$1", [edge.old.binding_id]);
      await f.admin.query('select clued_private.binding_expiry_sweep_v1()');
      assert.equal((await sql('select count(*)::int n from clued_private.ci_connection_expiry_reminders_v1 where binding_id=$1', [edge.old.binding_id])).n, 0);
      await f.admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()+interval '21 days'-interval '1 second' where binding_id=$1", [edge.old.binding_id]);
      await f.admin.query('select clued_private.binding_expiry_sweep_v1()');
      await f.admin.query("set timezone='Pacific/Honolulu'"); await f.admin.query('select clued_private.binding_expiry_sweep_v1()'); await f.admin.query("set timezone='UTC'");
      assert.equal((await sql('select count(*)::int n from clued_private.ci_connection_expiry_reminders_v1 where binding_id=$1', [edge.old.binding_id])).n, 1);
      await f.admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1", [edge.old.binding_id]);
      await f.admin.query('select clued_private.binding_expiry_sweep_v1()');
      assert.equal((await sql('select count(*)::int n from clued_private.ci_connection_expiry_reminders_v1 where binding_id=$1', [edge.old.binding_id])).n, 1);
    });
    await t.test('a reminder write failure leaves the expiry sweep committed and can be retried', async () => {
      const x = await setup();
      const due = await setup();
      await f.admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()-interval '1 second' where binding_id=$1", [x.old.binding_id]);
      await f.admin.query("update clued_private.authorizations_v12 set expires_at=clock_timestamp()+interval '6 days' where binding_id=$1", [due.old.binding_id]);
      await f.admin.query(`create function pg_temp.fail_reminder() returns trigger language plpgsql as $$
        begin raise exception 'fixture reminder unavailable'; end $$;
        create trigger fixture_reminder before insert on clued_private.ci_connection_expiry_reminders_v1
        for each row execute function pg_temp.fail_reminder()`);
      try {
        await f.admin.query('select clued_private.binding_expiry_sweep_v1()');
        assert.ok((await sql('select revoked_at from public.clued_agent_bindings where id=$1', [x.old.binding_id])).revoked_at);
      } finally { await f.admin.query('drop trigger fixture_reminder on clued_private.ci_connection_expiry_reminders_v1'); }
      await f.admin.query('select clued_private.binding_expiry_sweep_v1()');
      assert.equal((await sql('select threshold_days from clued_private.ci_connection_expiry_reminders_v1 where binding_id=$1', [due.old.binding_id])).threshold_days, 7);
    });
  } finally { await f.close(); }
});
