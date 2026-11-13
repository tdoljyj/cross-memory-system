// Terminal admission is removed (20261113151000). A PR's end through adopt (merged) or
// merge_slot_return (closed) releases the claim that served it when the Task has no other
// open PR and the claim authorized no newer head; the judgment never changes adopt/return.
import { stopCluster, waitForPidExit } from './cluster-cleanup.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';

const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const repo = 'fixture/pr-task';
async function freePort() {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port; await new Promise(r => s.close(r)); return p;
}

test('a PR end releases its claim; terminal admission is gone', { timeout: 300000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-pr-end-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'], onLog() {}, onError(m) { process.stderr.write(`${m}\n`); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    process.stderr.write('pr-end-release fixture started own PostgreSQL pid=' + server.process?.pid + '\n');
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
    const claim = async (task_id, session = uuid(), scope = 'global') => committed(await call('holder', 'clued_work_claim_v1', {
      task_id, scope, write_set: ['fixture/' + task_id + '/main.mjs'], holder_label: 'pr-end fixture', holder_session_ref: session, idempotency_key: uuid() }));
    const authorize = (r, head, pr, extra = {}) => call('holder', 'clued_work_renew_v1', {
      scope: r.claim.context_key, action: 'authorize_head', claim_id: r.claim.claim_id, fence: r.claim.fence,
      lease_version: r.claim.lease_version, lease_key: r.lease_key, repository: repo, head_sha: head,
      target_branch: 'main', ...(pr ? { pr_number: pr } : {}), idempotency_key: uuid(), ...extra });
    const resolve = (who, number, head, extra = {}) => call(who, 'clued_work_verify_v1', {
      action: 'resolve_pr_claim', pr_ref: `${repo}#${number}`, head_sha: head, base_sha: 'b'.repeat(40), target_branch: 'main', ...extra });
    const release = r => call('holder', 'clued_work_release_v1', { scope: r.claim.context_key, claim_id: r.claim.claim_id,
      fence: r.claim.fence, lease_key: r.lease_key, outcome: 'completed', evidence_ref: 'fixture:' + uuid() });
    const row = async r => (await admin.query('select status,released_outcome,lease_version,lease_key_hash from clued_private.work_claims_v1 where claim_id=$1',[r.claim.claim_id])).rows[0];
    const verify = (who,r,n,head) => call(who,'clued_work_verify_v1',{scope:r.claim.context_key,claim_id:r.claim.claim_id,
      pr_ref:repo+'#'+n,head_sha:head,base_sha:'b'.repeat(40),target_branch:'main',changed_paths:['fixture/'+r.claim.task_id+'/main.mjs']});
    const noTerminal = value => assert.equal(/terminal_(admission|release|readiness)/.test(JSON.stringify(value)),false,JSON.stringify(value));
    // The holder authorizes the PR head; qualified CI binds and admits it (as stage 1 does).
    const admitted = async (r,n,head) => {
      noTerminal(committed(await authorize(r,head,n)));
      assert.equal((await resolve('ci',n,head)).binding_status,'bound');
      const result=await verify('ci',r,n,head);assert.equal(result.verdict,'ADMITTED',JSON.stringify(result));
      return result;
    };
    const adopt = n => call('ci','clued_work_claim_adopt_v1',{scope:'global',pr_ref:repo+'#'+n,merge_sha:'f'.repeat(40)});
    const giveBack = n => call('ci','clued_work_merge_slot_return_v1',{scope:'global',pr_ref:repo+'#'+n});
    const binding = async n => (await admin.query('select status from clued_private.work_claim_pr_task_bindings_v1 where repo_id=$1 and pr_number=$2',[repo,n])).rows[0]?.status;

    await t.test('verify, authorize_head and verify_edit answer no terminal admission or readiness; the fields are refused',async()=>{
      const r=await claim(await task()),head='1'.repeat(40),result=await admitted(r,1,head);
      noTerminal(result);noTerminal(await call('holder','clued_work_verify_v1',{scope:'global',claim_id:r.claim.claim_id}));
      const edit=await call('holder','clued_work_verify_v1',{action:'verify_edit',scope:'global',claim_id:r.claim.claim_id,
        fence:r.claim.fence,execution_epoch:r.claim.execution_epoch,lease_version:r.claim.lease_version,lease_key:r.lease_key,
        changed_paths:['fixture/'+r.claim.task_id+'/main.mjs']});
      assert.equal(edit.holder_edit_authorized,true,JSON.stringify(edit));noTerminal(edit);
      await assert.rejects(()=>authorize(r,'2'.repeat(40),2,{terminal_release_ready:true}),/work_claim_head_authorization_input_invalid/);
      await assert.rejects(()=>call('ci','clued_work_merge_slot_return_v1',{scope:'global',pr_ref:repo+'#1',terminal_proof:{}}),/input_invalid/);
      assert.equal((await admin.query("select count(*)::int n from pg_proc where proname ~ 'terminal_(admission|release|ready|resources|outcome|runtime)|before_terminal|pr_terminal_apply'")).rows[0].n,0);
      committed(await release(r));
    });
    await t.test('1. a PR merged through adopt releases its claim as completed with the PR as evidence; the holder continues free',async()=>{
      const id=await task(),session=uuid(),r=await claim(id,session),head='3'.repeat(40);await admitted(r,3,head);
      const answer=await adopt(3);assert.equal(answer.status,'ok',JSON.stringify(answer));noTerminal(answer);
      assert.equal(await binding(3),'merged');
      assert.deepEqual(await row(r),{status:'RELEASED',released_outcome:'completed',lease_version:String(r.claim.lease_version),lease_key_hash:null});
      const receipts=(await admin.query("select binding_id,metadata from public.clued_audit_receipts where operation='work_claim_release' and object_id=$1",[r.claim.claim_id])).rows;
      assert.equal(receipts.length,1);assert.equal(receipts[0].binding_id,ids.holder);
      assert.equal(receipts[0].metadata.outcome,'completed');assert.equal(receipts[0].metadata.evidence_ref,repo+'#3');
      assert.equal(receipts[0].metadata.released_by_binding_id,ids.ci);
      const next=await claim(id,session);assert.equal(next.claim.continued_from,r.claim.claim_id,JSON.stringify(next));
      committed(await release(next));
      // A closed (not merged) PR ends the same way through return.
      const c=await claim(await task());await admitted(c,4,'4'.repeat(40));
      assert.equal((await giveBack(4)).status,'ok');assert.equal(await binding(4),'closed');
      assert.equal((await row(c)).status,'RELEASED');
    });
    await t.test('2. another open PR of the same claim keeps it',async()=>{
      const r=await claim(await task()),other='5'.repeat(40);
      committed(await authorize(r,other,6));assert.equal((await resolve('ci',6,other)).binding_status,'bound');
      await admitted(r,5,'6'.repeat(40));
      assert.equal((await adopt(5)).status,'ok');assert.equal(await binding(5),'merged');assert.equal(await binding(6),'active');
      assert.equal((await row(r)).status,'ACTIVE');committed(await release(r));
    });
    await t.test('3. a head authorized after the merged PR keeps the claim',async()=>{
      const r=await claim(await task());await admitted(r,7,'7'.repeat(40));
      committed(await authorize(r,'8'.repeat(40),null));
      assert.equal((await adopt(7)).status,'ok');assert.equal(await binding(7),'merged');
      assert.equal((await row(r)).status,'ACTIVE');committed(await release(r));
    });
    await t.test('4. an error inside the release judgment leaves adopt answering as usual and the claim unchanged',async()=>{
      const r=await claim(await task());await admitted(r,9,'9'.repeat(40));
      const original=(await admin.query("select pg_get_functiondef('clued_private.work_claim_pr_end_release_v1(public.clued_agent_bindings,text,text)'::regprocedure) d")).rows[0].d;
      // A fault after a partial write: the write must roll back with the judgment.
      await admin.query(`create or replace function clued_private.work_claim_pr_end_release_v1(b public.clued_agent_bindings,p_scope text,p_pr text)
        returns void language plpgsql security definer set search_path='' as $f$ begin
          update clued_private.work_claims_v1 set status='RELEASED' where user_id=b.user_id;
          raise exception 'fixture release fault'; end $f$`);
      try{
        const before=await row(r),answer=await adopt(9);
        assert.equal(answer.status,'ok',JSON.stringify(answer));assert.equal(answer.pr_ref,repo+'#9');
        assert.match(answer.binding_receipt_id??'',/^[0-9a-f-]{36}$/);assert.equal(await binding(9),'merged');
        assert.equal(before.status,'ACTIVE');assert.deepEqual(await row(r),before);
      }finally{await admin.query(original);}
      committed(await release(r));
    });
  }finally{
    for(const c of clients.reverse())await c.end().catch(()=>{});
    const ownPid=server.process?.pid;
    await stopCluster(server);
    const stopped=await waitForPidExit(ownPid);
    process.stderr.write('pr-end-release fixture cleanup pid=' + ownPid + ' exited=' + stopped + '\n');
    assert.equal(stopped,true,'this fixture must stop its own PostgreSQL child');
  }
});
