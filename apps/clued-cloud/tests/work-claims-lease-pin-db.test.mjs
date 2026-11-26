import { stopCluster, waitForPidExit, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS, startCluster } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { newCluster } from './pg-cluster-fixture.mjs';
// The server decides a pull request's target branch (Task 0ca0479d) runs with this file, in the production-schema suite.
import './work-claims-served-target-db.case.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const repo = 'fixture/pr-task';

test('a PR-authorized claim lives as long as its PR, never past the hard deadline', { timeout: 300000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-lease-pin-'));
  const server = newCluster({ databaseDir: dir, user: 'postgres', password: hash(), 
    persistent: false, initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags: [...EPHEMERAL_POSTGRES_FLAGS], onLog() {}, onError(m) { process.stderr.write(`${m}\n`); } });
  const clients = [];
  try {
    await startCluster(server);
    process.stderr.write('lease-pin fixture started own PostgreSQL pid=' + server.process?.pid + '\n');
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for (const name of (await fs.readdir(path.join(cloud, 'supabase/migrations'))).filter(n => n.endsWith('.sql')).sort()) {
      if (process.env.CLUED_LEASE_PIN_BASELINE === '1' && name.endsWith('_work_claim_lease_pinned_by_head_v1.sql')) continue;
      try { await admin.query(await fs.readFile(path.join(cloud, 'supabase/migrations', name), 'utf8')); }
      catch (e) { throw new Error('Migration ' + name + ': ' + e.message, { cause: e }); }
    }
    await allowRawTestBindings(admin);
    const user = uuid(); await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'pr-task@example.invalid',now())", [user]);
    const tokens = {}, ids = {};
    for (const [name, scopes] of [['holder', ['context:read', 'context:write']], ['otherHolder', ['context:read','context:write']], ['reader', ['context:read']], ['ci', ['context:read']], ['ciLimited',['context:read']]]) {
      tokens[name] = hash(); ids[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys) values($1,'synthetic',$2,$3,$4,$5) returning id`,
        [user, name, tokens[name], scopes,[name==='ciLimited'?'global':'*']])).rows[0].id;
    }
    const roleReceipt = (await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,version,metadata,status)
      values($1,'global','fixture_role','binding',$2,1,'{}','committed') returning id`, [user, ids.ci])).rows[0].id;
    await admin.query("insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id) values($1,$2,'ci-admission',now(),$3)", [user, ids.ci, roleReceipt]);
    await admin.query("insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id) values($1,$2,'ci-admission',now(),$3)", [user, ids.ciLimited, roleReceipt]);
    const anon = server.getPgClient(); clients.push(anon); await anon.connect(); await anon.query('set role anon');
    const gateway = server.getPgClient(); clients.push(gateway); await gateway.connect(); await setWorkerGatewayCaller(gateway);
    const human = server.getPgClient(); clients.push(human); await human.connect(); await human.query('set role authenticated');
    const native = async (name, input) => {
      const claims = { sub: user, role: 'authenticated', session_id: 'pr-task-owner-fixture', aal: 'aal1',
        amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] };
      await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [user, JSON.stringify(claims)]);
      return (await human.query(`select public.${name}($1) value`, [input])).rows[0].value;
    };
    const call = async (who, name, input) => CI_SIGNATURES.includes(name + '(text,jsonb)')
      ? (await anon.query(`select public.${name}($1,$2) value`, [tokens[who], input])).rows[0].value
      : workerGatewayRpc(gateway, name, tokens[who], input);
    const committed = r => { assert.equal(r.status, 'committed', JSON.stringify(r)); return r; };
    const task = async (scope = 'global') => committed(await call('holder', 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active', scope,
      idempotency_key: uuid(), authority: 'observed', confidence_reason: 'isolated binding fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: uuid(), content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = async (task_id, scope = 'global', paths = ['fixture/' + task_id + '/main.mjs']) => committed(await call('holder', 'clued_work_claim_v1', {
      task_id, scope, write_set: paths, holder_label: 'terminal fixture', holder_session_ref: uuid(), idempotency_key: uuid() }));
    const authorize = (r, head, pr, extra = {}) => call('holder', 'clued_work_renew_v1', {
      scope: r.claim.context_key, action: 'authorize_head', claim_id: r.claim.claim_id, fence: r.claim.fence,
      lease_version: r.claim.lease_version, lease_key: r.lease_key, repository: repo, head_sha: head,
      target_branch: 'main', ...(pr ? { pr_number: pr } : {}), idempotency_key: uuid(), ...extra });
    const resolve = (who, number, head, extra = {}) => call(who, 'clued_work_verify_v1', {
      action: 'resolve_pr_claim', pr_ref: `${repo}#${number}`, head_sha: head, base_sha: 'b'.repeat(40), target_branch: 'main', ...extra });
    const release = r => call('holder', 'clued_work_release_v1', { scope: r.claim.context_key, claim_id: r.claim.claim_id,
      fence: r.claim.fence, lease_key: r.lease_key, outcome: 'completed', evidence_ref: 'fixture:' + uuid() });
    const releaseHeld = async r => {
      const result = await release(r);
      assert.deepEqual([result.status, result.error_code], ['rejected', 'work_claim_release_pr_open']);
      await admin.query(`update clued_private.work_claims_v1 set hard_deadline_at=clock_timestamp()+interval '1 hour',
        expires_at=clock_timestamp()+interval '1 hour' where claim_id=$1`, [r.claim.claim_id]);
      return release(r);
    };
    const counts = async () => {
      const present = (await admin.query("select to_regclass('clued_private.work_claim_pr_task_bindings_v1') present")).rows[0].present;
      const bindings = present ? (await admin.query('select count(*)::int n from clued_private.work_claim_pr_task_bindings_v1')).rows[0].n : 0;
      const uses = (await admin.query('select count(*)::int n from clued_private.work_claim_door_usage_v1')).rows[0].n;
      const receipts=(await admin.query('select count(*)::int n from public.clued_audit_receipts')).rows[0].n;
      const admissions=(await admin.query('select count(*)::int n from clued_private.work_claim_execution_admissions_v1')).rows[0].n;
      return { bindings, uses, receipts, admissions };
    };
    const row = async r => (await admin.query('select status,lease_version,execution_epoch,lease_key_hash from clued_private.work_claims_v1 where claim_id=$1',[r.claim.claim_id])).rows[0];
    const verify = (who,r,n,head,extra={})=>call(who,'clued_work_verify_v1',{scope:r.claim.context_key,claim_id:r.claim.claim_id,
      pr_ref:repo+'#'+n,head_sha:head,base_sha:'b'.repeat(40),target_branch:'main',changed_paths:['fixture/'+r.claim.task_id+'/main.mjs'],...extra});
    const admitted=async(r,n,head,{repository=repo,paths}={})=>{
      committed(await authorize(r,head,n,{repository}));
      assert.equal((await resolve('ci',n,head,{pr_ref:repository+'#'+n})).binding_status,'bound');
      const result=await verify('ci',r,n,head,{pr_ref:repository+'#'+n,...(paths?{changed_paths:paths}:{})});
      assert.equal(result.verdict,'ADMITTED',JSON.stringify(result));return result;
    };
    const lease = async r => (await admin.query(`select expires_at,hard_deadline_at,lease_version,fence,
      extract(epoch from expires_at-clock_timestamp())::int left_s from clued_private.work_claims_v1 where claim_id=$1`,[r.claim.claim_id])).rows[0];
    const ciReceipts = async r => (await admin.query("select count(*)::int n from public.clued_audit_receipts where object_id=$1 and operation='work_claim_lease_extend_by_ci'",[r.claim.claim_id])).rows[0].n;
    await t.test('the holder authorizing a PR head pins the lease to the hard deadline without moving fence or version',async()=>{
      const r=await claim(await task()),before=await lease(r);
      assert.ok(before.left_s<=7200,'an unbound claim keeps the 2 h lease');
      committed(await authorize(r,'1'.repeat(40),null));
      const after=await lease(r);
      assert.equal(after.expires_at.getTime(),after.hard_deadline_at.getTime(),'pinned to the unchanged hard deadline');
      assert.equal(after.hard_deadline_at.getTime(),before.hard_deadline_at.getTime());
      assert.equal(after.lease_version,before.lease_version);assert.equal(after.fence,before.fence);
      // The holder can still record progress; the expiry stays at the deadline.
      const renewed=await call('holder','clued_work_renew_v1',{scope:'global',claim_id:r.claim.claim_id,fence:r.claim.fence,
        lease_version:r.claim.lease_version,lease_key:r.lease_key,progress_ref:'2'.repeat(40),idempotency_key:uuid()});
      assert.equal(renewed.status,'committed',JSON.stringify(renewed));
      assert.equal((await lease(r)).expires_at.getTime(),after.hard_deadline_at.getTime());
      committed(await release({claim:renewed.claim??r.claim,lease_key:r.lease_key}));
    });
    await t.test('the CI extension becomes a no-op on a pinned admitted claim',async()=>{
      const r=await claim(await task()),head='3'.repeat(40);await admitted(r,7,head);
      const x=await call('ci','clued_work_verify_v1',{action:'lease_extend',scope:'global',pr_ref:repo+'#7',head_sha:head,minutes:180});
      assert.equal(x.extended,false,JSON.stringify(x));assert.equal(await ciReceipts(r),0);
      committed(await releaseHeld(r));
    });
    await t.test('nobody but the holder pins, and a workflow dispatch authorization does not pin',async()=>{
      const r=await claim(await task()),before=await lease(r);
      for(const who of ['ci','otherHolder','reader']){
        const x=await call(who,'clued_work_renew_v1',{scope:'global',action:'authorize_head',claim_id:r.claim.claim_id,fence:r.claim.fence,
          lease_version:r.claim.lease_version,lease_key:r.lease_key,repository:repo,head_sha:'4'.repeat(40),target_branch:'main',idempotency_key:uuid()}).catch(e=>({error:e.message}));
        assert.notEqual(x.status,'committed',who);
      }
      committed(await authorize(r,'5'.repeat(40),null,{workflow:'fixture.yml'}));
      assert.equal((await lease(r)).expires_at.getTime(),before.expires_at.getTime(),'no pin by others or by a dispatch');
      committed(await release(r));
    });
    await t.test('the PR stopping returns the claim to the ordinary lease',async()=>{
      const r=await claim(await task()),head='6'.repeat(40);await admitted(r,8,head);
      assert.ok((await lease(r)).left_s>7200,'pinned while the PR is open');
      await admin.query("select clued_private.work_claim_pr_finish_v1(b,'global',$2,'closed') from public.clued_agent_bindings b where b.id=$1",[ids.ci,repo+'#8']);
      const after=await lease(r);assert.ok(after.left_s<=7200&&after.left_s>7000,JSON.stringify(after));
      committed(await release(r));
    });
  }finally{
    for(const c of clients.reverse())await c.end().catch(()=>{});
    const ownPid=server.process?.pid;
    await stopCluster(server);
    const stopped=await waitForPidExit(ownPid);
    process.stderr.write('lease-pin fixture cleanup pid=' + ownPid + ' exited=' + stopped + '\n');
    assert.equal(stopped,true,'this fixture must stop its own PostgreSQL child');
  }
});
