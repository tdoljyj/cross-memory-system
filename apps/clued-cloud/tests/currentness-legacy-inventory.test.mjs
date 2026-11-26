import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';

// raw-binding-grants: applies only migrations before 20261009050000, where raw Bindings still pass.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationDir = path.join(root, 'supabase/migrations');
const coreName = '20260922092355_bug_20260922_002_currentness_core.sql';
const inventoryName = '20260922092810_bug_20260922_002_legacy_carrier_inventory.sql';
const admissionName = '20260922092932_bug_20260922_002_admission_reconcile.sql';
const projectionName = '20260922093621_bug_20260922_002_projection_rebuild_gate.sql';
const readSurfacesName = '20260922093948_bug_20260922_002_currentness_read_surfaces.sql';
const uuid = () => crypto.randomUUID();


test('raw direct Event inventory is complete, scoped, and CAS transitions are atomic', { timeout: 180000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-legacy-currentness-'));
  const server = newCluster({
    databaseDir: directory, user: 'postgres', password: crypto.randomBytes(32).toString('hex'),
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  let db;
  try {
    await startCluster(server);
    db = server.getPgClient();
    await db.connect();
    await db.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions;
      create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
        banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    const names = (await fs.readdir(migrationDir)).filter((name) => name.endsWith('.sql') && name < coreName).sort();
    for (const name of names) await db.query(await fs.readFile(path.join(migrationDir, name), 'utf8'));

    const owner = uuid();
    const projectId = uuid();
    const projectBId = uuid();
    const projectGammaId = uuid();
    await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',
      [owner, 'legacy-inventory@example.invalid']);
    await db.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,
      certainty_status,confirmed_at) values($1,$2,'Alpha','alpha',$3,'confirmed',now())`,
      [projectId, owner, `project:${projectId}`]);
    await db.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,
      certainty_status,confirmed_at) values($1,$2,'Beta','beta',$3,'confirmed',now())`,
      [projectBId, owner, `project:${projectBId}`]);
    await db.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,
      aliases,certainty_status,confirmed_at)
      values($1,$2,'Gamma','gamma',$3,array['shared'],'confirmed',now())`,
      [projectGammaId, owner, `project:${projectGammaId}`]);
    await db.query(`update public.clued_projects set aliases=array['shared'] where id=$1`,
      [projectId]);
    const events = (await db.query(`insert into public.clued_context_events
      (user_id,context_key,event_type,payload,version,audit_visibility)
      values ($1,'global','decision','{"text":"current decision"}',1,'work_log'),
             ($1,'project:alpha','blocker','{"text":"open blocker"}',2,'work_log'),
             ($1,'project:missing','action','{"text":"unknown scope"}',3,'work_log'),
             ($1,'global','retraction','{"text":"unbound global retraction"}',4,'work_log'),
             ($1,'project:alpha','retraction','{"text":"unbound project retraction"}',5,'work_log'),
             ($1,'project:shared','correction','{"text":"ambiguous legacy alias"}',6,'work_log'),
             ($1,'global','note','{"text":"non-material note"}',7,'work_log')
      returning id,event_type`, [owner])).rows;
    const ids = Object.fromEntries(events.map((row) => [row.event_type, row.id]));
    await db.query(await fs.readFile(path.join(migrationDir, coreName), 'utf8'));
    await db.query(await fs.readFile(path.join(migrationDir, inventoryName), 'utf8'));
    const oauthDispatcher = (await db.query(`select pg_get_functiondef(
      'public.clued_oauth_call(text,jsonb)'::regprocedure) definition`)).rows[0].definition;
    assert.match(oauthDispatcher, /when 'clued_event_carrier_transition' then/);
    for (const tool of ['clued_session_reconcile', 'clued_projection_rebuild',
      'clued_full_global_reconcile', 'clued_currentness_g6_gate']) {
      assert.ok(oauthDispatcher.includes(`when '${tool}' then`));
    }
    assert.match(oauthDispatcher, /clued_private\.resolve_oauth_binding\(\)/);
    await db.query('set role authenticated');
    await assert.rejects(db.query(`select public.clued_oauth_call(
      'clued_event_carrier_transition','{}'::jsonb)`),
    /legacy_oauth_requires_new_provider_reauthorization/);
    await db.query('reset role');

    const candidates = (await db.query(`select event_id,canonical_scope,disposition,dimensions
      from clued_private.legacy_event_candidates order by event_id`)).rows;
    assert.equal(candidates.length, 6);
    assert.equal(candidates[0].event_id, ids.decision);
    assert.equal(candidates[0].disposition, 'LEGACY_ACTIVE_UNSTRUCTURED');
    assert.equal(candidates[1].canonical_scope, `project:${projectId}`);
    assert.deepEqual(candidates[1].dimensions, ['state', 'task']);
    assert.equal(candidates[2].disposition, 'LEGACY_UNBOUND');
    assert.equal(candidates[2].canonical_scope, `legacy-unbound:${ids.action}`);
    assert.deepEqual(candidates[2].dimensions, ['state', 'task', 'decision']);
    assert.equal(candidates[3].canonical_scope, 'global');
    assert.equal(candidates[3].disposition, 'LEGACY_UNBOUND');
    assert.equal(candidates[4].canonical_scope, `project:${projectId}`);
    assert.equal(candidates[4].disposition, 'LEGACY_UNBOUND');
    assert.equal(candidates[5].canonical_scope, `legacy-unbound:${ids.correction}`);
    const ambiguousImpacts = (await db.query(`select project_scope from
      clued_private.legacy_event_project_impacts where event_id=$1 order by project_scope`,
      [ids.correction])).rows.map((row) => row.project_scope);
    assert.deepEqual(ambiguousImpacts,
      [`project:${projectId}`, `project:${projectGammaId}`].sort());
    const receipts = (await db.query(`select candidate_count,inventory_sha256,
      scan_completed_revision,append_cutover_revision
      from clued_private.legacy_carrier_inventory_receipts`)).rows;
    assert.equal(receipts.reduce((sum, receipt) => sum + Number(receipt.candidate_count), 0), 6);
    assert.ok(receipts.every((receipt) => /^[0-9a-f]{64}$/.test(receipt.inventory_sha256)));
    assert.ok(receipts.every((receipt) => receipt.scan_completed_revision === receipt.append_cutover_revision));
    const aliasProjection = (await db.query(`select projection_key,invalidation_revision
      from clued_private.projection_invalidation_heads
      where user_id=$1 and target_scope='global' and projection_key='global.__aggregate__'`,
      [owner])).rows[0];
    assert.equal(aliasProjection.projection_key, 'global.__aggregate__');
    assert.equal(Number(aliasProjection.invalidation_revision), 2);
    const betaRecordId = uuid();
    await db.query(`insert into public.clued_memories
      (id,user_id,title,content,record_type,scope,project_id,canonical_scope,lifecycle_status)
      values($1,$2,'Beta state','Independent project state','state','project',$3,$4,'active')`,
      [betaRecordId, owner, projectBId, `project:${projectBId}`]);
    const betaList = (await db.query(`select clued_private.record_list_core($1,$2,$3) result`,
      [owner, { level: 'project', project_id: projectBId, record_type: 'state' },
        [`project:${projectBId}`]])).rows[0].result;
    assert.equal(betaList.records.length, 1);
    assert.equal(betaList.records[0].id, betaRecordId);

    // T-CUR-35 successor: the unresolved legacy source precedes this Record,
    // yet the default list must omit it and history must label it non-current.
    const recordId = uuid();
    await db.query(`insert into public.clued_memories
      (id,user_id,title,content,record_type,scope,canonical_scope,lifecycle_status,
       updated_at)
      values($1,$2,'Later state','A later state record','state','global','global',
        'active',now()+interval '1 second')`, [recordId, owner]);
    const currentList = (await db.query(`select clued_private.record_list_core($1,$2,$3) result`,
      [owner, { level: 'global', record_type: 'state' }, ['global']])).rows[0].result;
    assert.equal(currentList.records.length, 0);
    const historyList = (await db.query(`select clued_private.record_list_core($1,$2,$3) result`,
      [owner, { level: 'global', record_type: 'state', include_history: true }, ['global']])).rows[0].result;
    assert.equal(historyList.records.length, 1);
    assert.equal(historyList.records[0].id, recordId);
    assert.equal(historyList.records[0].authoritative, false);
    assert.equal(historyList.records[0].record_currentness, 'SHADOWED_BY_ACTIVE_EVENT');

    const receiptId = uuid();
    await assert.rejects(db.query(`select clued_private.transition_event_carrier($1,2,
      'RESOLVED_CONTINUITY_ONLY',null,$2)`, [ids.decision, receiptId]), /carrier_transition_conflict/);
    await db.query('begin');
    await db.query(`insert into public.clued_audit_receipts
      (id,user_id,context_key,operation,object_type,object_id,version,metadata)
      values ($1,$2,'global','carrier_transition','event',$3,1,
        jsonb_build_object('target_state','RESOLVED_CONTINUITY_ONLY',
          'expected_transition_version','1','continuity_only_proof','verified',
          'transaction_id',txid_current()::text))`,
      [receiptId, owner, String(ids.decision)]);
    const before = (await db.query(`select carrier_state,transition_version from
      clued_private.event_truth_carriers where event_id=$1`, [ids.decision])).rows[0];
    assert.equal(before.carrier_state, 'ACTIVE_UNSTRUCTURED');
    const changed = (await db.query(`select clued_private.transition_event_carrier($1,1,
      'RESOLVED_CONTINUITY_ONLY',null,$2) as version`, [ids.decision, receiptId])).rows[0];
    assert.equal(Number(changed.version), 2);
    await db.query('commit');
    await assert.rejects(db.query(`select clued_private.transition_event_carrier($1,1,
      'RESOLVED_CONTINUITY_ONLY',null,$2)`, [ids.decision, receiptId]), /carrier_transition_conflict/);
    const after = (await db.query(`select carrier_state,transition_version from
      clued_private.event_truth_carriers where event_id=$1`, [ids.decision])).rows[0];
    assert.equal(after.carrier_state, 'RESOLVED_CONTINUITY_ONLY');
    assert.equal(Number(after.transition_version), 2);

    const tokenHash = crypto.randomBytes(32).toString('hex');
    await db.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','carrier transition test',$2,
        array['context:read','context:write','audit:read'],array['global',$3,$4,$5])`,
      [owner, tokenHash, `project:${projectId}`, `project:${projectBId}`,
        `project:${projectGammaId}`]);
    const restored = (await db.query(`select public.clued_mcp_restore($1,$2) result`,
      [tokenHash, { context_key: `project:${projectId}`, response_view: 'structured',
        event_limit: 1, event_budget_bytes: 4096 }])).rows[0].result;
    const input = {
      context_key: `project:${projectId}`, source_event_id: ids.blocker,
      expected_transition_version: 1, transition: 'supersede', event_type: 'correction',
      payload: { text: 'replacement correction' }, session_token: restored.session_token,
      base_version: restored.version, idempotency_key: uuid(),
    };
    const readOnlyToken = crypto.randomBytes(32).toString('hex');
    await db.query(`insert into public.clued_agent_bindings
      (user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','read-only carrier test',$2,
        array['context:read'],array[$3])`,
      [owner, readOnlyToken, `project:${projectId}`]);
    await assert.rejects(db.query(`select public.clued_mcp_event_carrier_transition($1,$2)`,
      [readOnlyToken, input]), /binding_not_authorized/);
    const countBefore = Number((await db.query('select count(*) from public.clued_context_events')).rows[0].count);
    await assert.rejects(db.query(`select public.clued_mcp_event_carrier_transition($1,$2)`,
      [tokenHash, { ...input, expected_transition_version: 2 }]), /carrier_transition_conflict/);
    assert.equal(Number((await db.query('select count(*) from public.clued_context_events')).rows[0].count), countBefore);
    const replaced = (await db.query(`select public.clued_mcp_event_carrier_transition($1,$2) result`,
      [tokenHash, input])).rows[0].result;
    assert.equal(replaced.status, 'transitioned');
    assert.equal(Number(replaced.transition_version), 2);
    const duplicate = (await db.query(`select public.clued_mcp_event_carrier_transition($1,$2) result`,
      [tokenHash, input])).rows[0].result;
    assert.equal(duplicate.status, 'duplicate');
    assert.equal(Number((await db.query('select count(*) from public.clued_context_events')).rows[0].count), countBefore + 1);
    const replacement = (await db.query(`select event_type,payload from public.clued_context_events
      where id=$1`, [replaced.successor_event_id])).rows[0];
    assert.equal(replacement.payload.supersedes_event_id, String(ids.blocker));
    const retracted = (await db.query(`select public.clued_mcp_event_carrier_transition($1,$2) result`,
      [tokenHash, {
        context_key: `project:${projectId}`, source_event_id: replaced.successor_event_id,
        expected_transition_version: 1, transition: 'retract',
        payload: { text: 'the correction is retracted' },
        session_token: restored.session_token, base_version: restored.version + 1,
        idempotency_key: uuid(),
      }])).rows[0].result;
    assert.equal(retracted.status, 'transitioned');
    const retractionEvent = (await db.query(`select event_type,payload from public.clued_context_events
      where id=$1`, [retracted.successor_event_id])).rows[0];
    assert.equal(retractionEvent.event_type, 'retraction');
    assert.equal(retractionEvent.payload.retracts_event_id, String(replaced.successor_event_id));
    const resolveInput = {
      context_key: `project:${projectId}`, source_event_id: retracted.successor_event_id,
      expected_transition_version: 1, transition: 'resolve',
      proof_receipt_id: uuid(), idempotency_key: uuid(),
    };
    await assert.rejects(db.query(`select public.clued_mcp_event_carrier_transition($1,$2)`,
      [tokenHash, resolveInput]), /continuity_only_proof_required/);
    const proofState = (await db.query(`select carrier_state from
      clued_private.event_truth_carriers where event_id=$1`,
      [retracted.successor_event_id])).rows[0].carrier_state;
    assert.equal(proofState, 'ACTIVE_UNSTRUCTURED');
    await db.query(`insert into public.clued_audit_receipts
      (id,user_id,context_key,operation,object_type,object_id,version,metadata)
      values($1,$2,$3,'continuity_only_resolution_authorized','event',$4,1,
        '{"proof":"verified"}')`,
      [resolveInput.proof_receipt_id, owner, `project:${projectId}`, String(retracted.successor_event_id)]);
    const resolved = (await db.query(`select public.clued_mcp_event_carrier_transition($1,$2) result`,
      [tokenHash, resolveInput])).rows[0].result;
    assert.equal(resolved.status, 'transitioned');
    assert.equal(Number(resolved.transition_version), 2);
    const resolvedAgain = (await db.query(`select public.clued_mcp_event_carrier_transition($1,$2) result`,
      [tokenHash, resolveInput])).rows[0].result;
    assert.equal(resolvedAgain.status, 'duplicate');

    const hiddenEvent = (await db.query(`insert into public.clued_context_events
      (user_id,context_key,event_type,payload,audit_visibility)
      values($1,'global','decision','{"text":"hidden"}','audit_only') returning id`,
      [owner])).rows[0].id;
    await db.query(`insert into clued_private.event_truth_carriers
      (event_id,user_id,canonical_scope,dimensions,visibility,source_kind,carrier_state)
      values($1,$2,'global',array['decision'],'audit_only','legacy','ACTIVE_UNSTRUCTURED')`,
      [hiddenEvent, owner]);
    const revisionBefore = (await db.query(`select snapshot_revision from
      clued_private.scope_currentness_heads where user_id=$1 and canonical_scope='global'`,
      [owner])).rows[0].snapshot_revision;
    const hiddenReceipt = uuid();
    await db.query('begin');
    await db.query(`insert into public.clued_audit_receipts
      (id,user_id,context_key,operation,object_type,object_id,version,metadata)
      values($1,$2,'global','carrier_transition','event',$3,1,
        jsonb_build_object('target_state','RESOLVED_CONTINUITY_ONLY',
          'expected_transition_version','1','continuity_only_proof','verified',
          'transaction_id',txid_current()::text))`, [hiddenReceipt, owner, String(hiddenEvent)]);
    await db.query(`select clued_private.transition_event_carrier($1,1,
      'RESOLVED_CONTINUITY_ONLY',null,$2)`, [hiddenEvent, hiddenReceipt]);
    await db.query('commit');
    const revisionAfter = (await db.query(`select snapshot_revision from
      clued_private.scope_currentness_heads where user_id=$1 and canonical_scope='global'`,
      [owner])).rows[0].snapshot_revision;
    assert.equal(revisionAfter, revisionBefore);

    // T-CUR-66: scoped uncertainty blocks Alpha; unknown aliases stale only
    // Global aggregate. Independent Beta remains eligible for local admission.
    await db.query(await fs.readFile(path.join(migrationDir, admissionName), 'utf8'));
    const bindingId = (await db.query(`select id from public.clued_agent_bindings
      where token_hash=$1`, [tokenHash])).rows[0].id;
    const alphaVector = (await db.query(`select clued_private.currentness_vector($1,$2,$3) v`,
      [owner, `project:${projectId}`, bindingId])).rows[0].v;
    const betaVector = (await db.query(`select clued_private.currentness_vector($1,$2,$3) v`,
      [owner, `project:${projectBId}`, bindingId])).rows[0].v;
    const globalVector = (await db.query(`select clued_private.currentness_vector($1,$2,$3) v`,
      [owner, 'global', bindingId])).rows[0].v;
    assert.equal(alphaVector.legacy_unbound, true);
    assert.equal(betaVector.legacy_unbound, false);
    const gammaVector = (await db.query(`select clued_private.currentness_vector($1,$2,$3) v`,
      [owner, `project:${projectGammaId}`, bindingId])).rows[0].v;
    assert.equal(alphaVector.legacy_alias_unknown, true);
    assert.equal(gammaVector.legacy_alias_unknown, true);
    assert.equal(gammaVector.legacy_unbound, true);
    assert.equal(betaVector.legacy_alias_unknown, false);
    assert.ok(globalVector.projection.some((item) =>
      item.key === 'global.__aggregate__' &&
      Number(item.invalidation_revision) > Number(item.resolved_through_revision)));
    const betaEligible = (await db.query(`select clued_private.currentness_vector_eligible($1) ok`,
      [betaVector])).rows[0].ok;
    assert.equal(betaEligible, true);
    const activeSessionId = (await db.query(`select id from public.clued_continuity_sessions
      where user_id=$1 and binding_id=$2 and context_key=$3 limit 1`,
      [owner, bindingId, `project:${projectId}`])).rows[0].id;
    const postCutoverEventId = (await db.query(`insert into public.clued_context_events
      (user_id,context_key,event_type,payload,audit_visibility,session_id)
      values($1,$2,'decision','{"text":"between migrations"}','work_log',$3) returning id`,
      [owner, `project:${projectId}`, activeSessionId])).rows[0].id;
    assert.equal((await db.query(`select count(*) from clued_private.legacy_event_candidates
      where event_id=$1`, [postCutoverEventId])).rows[0].count, '0');
    await db.query(await fs.readFile(path.join(migrationDir, projectionName), 'utf8'));
    await db.query(await fs.readFile(path.join(migrationDir, readSurfacesName), 'utf8'));
    const inventoryWatermark = Number((await db.query(`select cutover_event_id from
      clued_private.legacy_inventory_epoch`)).rows[0].cutover_event_id);
    assert.ok(inventoryWatermark < Number(postCutoverEventId));
    assert.equal((await db.query(`select carrier_state from
      clued_private.event_truth_carriers where event_id=$1`,
      [postCutoverEventId])).rows[0].carrier_state, 'ACTIVE_UNSTRUCTURED');
    assert.equal((await db.query(`select clued_private.legacy_inventory_complete($1) ok`,
      [owner])).rows[0].ok, true);
    const gammaRecordId = uuid();
    const alphaRecordId = uuid();
    await db.query(`insert into public.clued_memories
      (id,user_id,title,content,record_type,scope,project_id,canonical_scope,lifecycle_status)
      values($1,$2,'Alpha state','Old Alpha truth','state','project',$3,$4,'active'),
            ($5,$2,'Gamma state','Old Gamma truth','state','project',$6,$7,'active')`,
      [alphaRecordId, owner, projectId, `project:${projectId}`,
        gammaRecordId, projectGammaId, `project:${projectGammaId}`]);
    for (const candidateId of [projectId, projectGammaId]) {
      const scope = `project:${candidateId}`;
      const result = (await db.query(`select clued_private.record_list_core($1,$2,$3) result`,
        [owner, { level: 'project', project_id: candidateId, record_type: 'state' },
          [scope]])).rows[0].result;
      assert.deepEqual(result.records, []);
    }
    assert.equal((await db.query(`select clued_private.record_currentness_fence(
      $1,$2,array[$3]::text[]) status`, [owner, gammaRecordId,
      `project:${projectGammaId}`])).rows[0].status, 'UNKNOWN');
    const betaStillCurrent = (await db.query(`select clued_private.record_list_core($1,$2,$3) result`,
      [owner, { level: 'project', project_id: projectBId, record_type: 'state' },
        [`project:${projectBId}`]])).rows[0].result;
    assert.equal(betaStillCurrent.records.length, 1);
    assert.equal(betaStillCurrent.records[0].id, betaRecordId);
    assert.equal((await db.query(`select clued_private.authoritative_current_action_v1($1,$2) result`,
      [owner, `project:${projectGammaId}`])).rows[0].result.status, 'UNKNOWN');
    assert.equal((await db.query(`select clued_private.currentness_vector_eligible($1) ok`,
      [gammaVector])).rows[0].ok, false);
    const gammaRestored = (await db.query(`select public.clued_mcp_restore($1,$2) result`,
      [tokenHash, { context_key: `project:${projectGammaId}`, response_view: 'structured' }]))
      .rows[0].result;
    const gammaAdmission = (await db.query(`select public.clued_mcp_session_reconcile($1,$2) result`,
      [tokenHash, { context_key: `project:${projectGammaId}`,
        session_token: gammaRestored.session_token }])).rows[0].result;
    assert.equal(gammaAdmission.currentness_state, 'UNKNOWN');
    assert.equal(gammaAdmission.admission_eligible, false);
    assert.equal(gammaAdmission.receipt_kind, 'CURRENTNESS_OBSERVATION');
    await db.query('begin');
    await db.query('savepoint inventory_tamper');
    await db.query(`delete from clued_private.legacy_event_project_impacts where event_id=$1`,
      [ids.correction]);
    assert.equal((await db.query(`select clued_private.legacy_inventory_complete($1) ok`,
      [owner])).rows[0].ok, false);
    await db.query('rollback to savepoint inventory_tamper');
    await db.query('commit');
  } finally {
    if (db) await db.end().catch(() => {});
    await stopCluster(server);
    await removeTestDirectory(directory).catch(() => {});
  }
});
