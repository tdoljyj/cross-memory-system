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

test('trusted PR terminal release requires holder intent, real admission and conservative lifecycle proof', { timeout: 300000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-pr-task-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'], onLog() {}, onError(m) { process.stderr.write(`${m}\n`); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    process.stderr.write('terminal-release fixture started own PostgreSQL pid=' + server.process?.pid + '\n');
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
      if (process.env.CLUED_PR_TERMINAL_BASELINE === '1' && name.endsWith('_work_claim_pr_terminal_release_v1.sql')) continue;
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
    const admitted=async(r,n,head,{ready=false,repository=repo,paths}={})=>{
      committed(await authorize(r,head,n,{repository,...(ready?{terminal_release_ready:true}:{})}));
      assert.equal((await resolve('ci',n,head,{pr_ref:repository+'#'+n})).binding_status,'bound');
      const result=await verify('ci',r,n,head,{pr_ref:repository+'#'+n,...(paths?{changed_paths:paths}:{})});
      assert.equal(result.verdict,'ADMITTED',JSON.stringify(result));return result;
    };
    // Synthetic qualified-CI external fact fixture: this isolated world never
    // starts an Actions workflow. This is not production physical-idle proof.
    const zeroRuntime=async r=>({source:'github-actions-runs/all-events',observed_at:new Date().toISOString(),
      entries:(await admin.query('select repository,head_sha from clued_private.work_claim_head_authorizations_v1 where claim_id=$1 union select repository,head_sha from clued_private.work_claim_execution_admissions_v1 where claim_id=$1',[r.claim.claim_id])).rows
        .map(h=>({...h,first:{total_count:0,workflow_runs:[]},second:{total_count:0,workflow_runs:[]}}))});
    const terminal=async(r,n,head,result,{who='ci',merged=false,repository=repo,proof=true,runtime=true,observation={},extra={}}={})=>call(who,
      merged?'clued_work_claim_adopt_v1':'clued_work_merge_slot_return_v1',{scope:r.claim.context_key,pr_ref:repository+'#'+n,
        ...(merged?{merge_sha:'f'.repeat(40)}:{}),...(proof?{terminal_proof:{last_admission:result.terminal_admission,
          ...(runtime?{runtime_inventory:await zeroRuntime(r)}:{}),
          observation:{repository,pr_ref:repository+'#'+n,head_sha:head,base_sha:'b'.repeat(40),target_branch:'main',
            state:'closed',merged,...(merged?{merge_sha:'f'.repeat(40)}:{}),...observation}}}:{}),...extra});
    const kept=async(r,result,reason)=>{
      assert.equal(result.auto_release?.released,false,JSON.stringify(result));
      if(reason)assert.equal(result.auto_release.reason,reason,JSON.stringify(result));
      assert.equal((await row(r)).status,'ACTIVE');assert.ok(result.auto_release.receipt_id,'retained reason is durable');
    };
    await t.test('actual admitted CI returns immutable terminal witness; ordinary readers cannot manufacture it',async()=>{
      const r=await claim(await task()),head='1'.repeat(40),result=await admitted(r,1,head);
      assert.match(result.terminal_admission_receipt_id??'',/^[0-9a-f-]{36}$/,'real Native admission must return its witness');
      assert.equal(result.terminal_admission.receipt_id,result.terminal_admission_receipt_id);
      const receipt=(await admin.query('select metadata from public.clued_audit_receipts where id=$1',[result.terminal_admission_receipt_id])).rows[0];
      assert.equal(receipt.metadata.receipt_kind,'WORK_CLAIM_TERMINAL_ADMISSION');assert.equal(JSON.stringify(receipt).includes(r.lease_key),false);
      assert.equal((await verify('reader',r,1,head)).terminal_admission_receipt_id,undefined);committed(await release(r));
    });
    if(process.env.CLUED_PR_TERMINAL_BASELINE==='1')return;
    await t.test('editing authority requires the actual current holder key and exact claim CAS without metering or mutation',async()=>{
      const r=await claim(await task()),input={action:'verify_edit',scope:'global',claim_id:r.claim.claim_id,
        fence:r.claim.fence,execution_epoch:r.claim.execution_epoch,lease_version:r.claim.lease_version,
        lease_key:r.lease_key,changed_paths:['fixture/'+r.claim.task_id+'/main.mjs']};
      const before=await counts(),snapshot=await row(r);
      await assert.rejects(()=>call('holder','clued_work_verify_v1',{scope:'global',claim_id:r.claim.claim_id,lease_key:r.lease_key}),
        /work_claim_private_key_action_invalid/,'normal public RPC must reject a private key rather than silently ignore it');
      await assert.rejects(()=>resolve('reader',999,'f'.repeat(40),{lease_key:r.lease_key,read_only:true}),
        /work_claim_private_key_action_invalid/,'resolve also never accepts the editing capability');
      const ok=await call('holder','clued_work_verify_v1',input);
      assert.equal(ok.holder_edit_authorized,true,JSON.stringify(ok));assert.equal(ok.verdict,'ADMITTED');
      assert.equal(ok.claim.terminal_release_ready,false);
      for(const [who,extra] of [['reader',{}],['ci',{}],['otherHolder',{}],['holder',{lease_key:undefined}],
        ['holder',{lease_key:'clued_lk_'+'0'.repeat(64)}],['holder',{fence:r.claim.fence+1}],
        ['holder',{execution_epoch:r.claim.execution_epoch+1}],['holder',{lease_version:r.claim.lease_version+1}],
        ['holder',{pr_ref:repo+'#999'}],['holder',{changed_paths:['outside.mjs']}]] ){
        let result;try{result=await call(who,'clued_work_verify_v1',{...input,...extra});}
        catch(error){assert.equal(String(error).includes(r.lease_key),false);continue;}
        assert.notEqual(result.holder_edit_authorized,true,JSON.stringify({who,result}));
      }
      const ordinary=await call('holder','clued_work_verify_v1',{scope:'global',claim_id:r.claim.claim_id});
      assert.notEqual(ordinary.holder_edit_authorized,true);
      assert.deepEqual(await counts(),before);assert.deepEqual(await row(r),snapshot);committed(await release(r));
    });
    await t.test('explicit holder ready plus real admission releases claim once, never the Task',async()=>{
      const r=await claim(await task()),head='2'.repeat(40),result=await admitted(r,2,head,{ready:true});
      const read=await call('holder','clued_work_verify_v1',{scope:'global',claim_id:r.claim.claim_id});
      assert.equal(read.terminal_release_ready,true);assert.equal(read.claim.terminal_release_ready,true);
      // Fresh closed metadata may report main's advanced base, while the
      // immutable admission Receipt must keep the base actually admitted.
      const closed=await terminal(r,2,head,result,{merged:true,observation:{base_sha:'c'.repeat(40)}});
      assert.equal(closed.auto_release.released,true,JSON.stringify(closed));
      assert.equal(closed.terminal_replayed,undefined);
      assert.equal((await row(r)).status,'RELEASED');assert.equal((await row(r)).lease_key_hash,null);
      const receipt=(await admin.query('select metadata from public.clued_audit_receipts where id=$1',[closed.auto_release.receipt_id])).rows[0].metadata;
      assert.equal(receipt.terminal_observation.base_sha,'c'.repeat(40));
      assert.match(receipt.runtime_inventory_sha256,/^[0-9a-f]{64}$/);
      assert.equal(receipt.terminal_admission_receipt_id,result.terminal_admission_receipt_id);
      assert.equal((await admin.query('select lifecycle_status from public.clued_memories where id=$1',[r.claim.task_id])).rows[0].lifecycle_status,'active');
      const replay=await terminal(r,2,head,result,{merged:true,observation:{base_sha:'c'.repeat(40)}});
      assert.equal(replay.auto_release.receipt_id,closed.auto_release.receipt_id);assert.equal(replay.auto_release.released,true);
      assert.equal(replay.terminal_replayed,true,'historical effects must not count as a fresh terminal action');
      assert.deepEqual(Object.keys(replay.auto_release).sort(),['status','released','reason','receipt_id','retryable'].sort());
    });
    await t.test('progress=head, missing proof and authorization without actual admission never prove idle',async()=>{
      const r=await claim(await task()),head='3'.repeat(40);
      r.claim=committed(await call('holder','clued_work_renew_v1',{scope:'global',claim_id:r.claim.claim_id,fence:r.claim.fence,
        lease_version:r.claim.lease_version,lease_key:r.lease_key,progress_ref:head})).claim;
      const result=await admitted(r,3,head);await kept(r,await terminal(r,3,head,result),'editing_occupancy_unconfirmed');
      await kept(r,await terminal(r,3,head,result,{proof:false}),'terminal_proof_missing');committed(await release(r));
      const a=await claim(await task()),auth=committed(await authorize(a,head,4,{terminal_release_ready:true}));await resolve('ci',4,head);
      const forged={terminal_admission:{receipt_id:auth.terminal_readiness_receipt_id,claim_id:a.claim.claim_id,fence:a.claim.fence,
        execution_epoch:a.claim.execution_epoch,lease_version:a.claim.lease_version,head_authorization_id:auth.authorization_id}};
      await kept(a,await terminal(a,4,head,forged),'admission_unconfirmed');committed(await release(a));
    });
    await t.test('the deployed Source missing complete runtime inventory explicitly remains pending',async()=>{
      const r=await claim(await task()),head='d'.repeat(40),result=await admitted(r,5,head,{ready:true});
      const closed=await terminal(r,5,head,result,{runtime:false});
      await kept(r,closed,'runtime_inventory_unconfirmed');assert.equal(closed.auto_release.status,'pending');
      assert.equal(closed.auto_release.retryable,true);committed(await release(r));
    });
    await t.test('an older same-head stop Receipt cannot prove a new workflow run attempt physically stopped',async()=>{
      const r=await claim(await task()),head='e'.repeat(40),n=70;
      const policy=(await admin.query('select * from clued_private.work_claim_independent_consumer_v1 where singleton')).rows[0];
      try{
        // Adversarial immutable history fixture: a real-shaped old drain fact
        // precedes this admission and carries no binding to attempt 2.
        await admin.query('update clued_private.work_claim_independent_consumer_v1 set ci_principal_binding_id=$1,source_manifest_sha256=$2,qualification_commit=$3 where singleton',
          [ids.ci,'d'.repeat(64),'d'.repeat(40)]);
        const old=(await admin.query(`insert into public.clued_audit_receipts(user_id,binding_id,context_key,operation,object_type,object_id,version,metadata)
          values($1,$2,'global','work_claim_independent_legacy_drain','work_claim',$3,$4,$5) returning id`,
          [user,ids.ci,r.claim.claim_id,r.claim.execution_epoch,{claim_id:r.claim.claim_id,execution_epoch:r.claim.execution_epoch,
            source_manifest_sha256:'d'.repeat(64),evidence:{heads:[head],stop_proof_refs:['sha256:'+'d'.repeat(64)],revoked_check_ids:[]}}])).rows[0].id;
        const result=await admitted(r,n,head,{ready:true}),inventory=await zeroRuntime(r);
        for(const entry of inventory.entries){
          const run={id:77,run_attempt:2,head_sha:entry.head_sha,event:'workflow_dispatch',status:'completed',conclusion:'success'};
          entry.first={total_count:1,workflow_runs:[run]};entry.second={...entry.first};
        }
        inventory.stop_receipt_ids=[old];
        const extra={terminal_proof:{last_admission:result.terminal_admission,runtime_inventory:inventory,
          observation:{repository:repo,pr_ref:repo+'#'+n,head_sha:head,base_sha:'b'.repeat(40),target_branch:'main',state:'closed',merged:false}}};
        await kept(r,await terminal(r,n,head,result,{extra}),'physical_execution_unconfirmed');
      }finally{
        await admin.query('update clued_private.work_claim_independent_consumer_v1 set activated_at=$1,qualification_commit=$2,source_manifest_sha256=$3,ci_principal_binding_id=$4 where singleton',
          [policy.activated_at,policy.qualification_commit,policy.source_manifest_sha256,policy.ci_principal_binding_id]);
        if((await row(r)).status==='ACTIVE')committed(await release(r));
      }
    });
    await t.test('other same-repository/cross-repository open or unknown targets preserve the claim',async()=>{
      for(const [i,other] of [{repository:repo,unknown:false},{repository:'fixture/other',unknown:false},{repository:'fixture/other',unknown:true}].entries()){
        const r=await claim(await task()),head='4'.repeat(40),n=100+i,otherN=110+i,result=await admitted(r,n,head,{ready:true});
        committed(await authorize(r,head,otherN,{repository:other.repository}));
        if(!other.unknown)await resolve('ci',otherN,head,{pr_ref:other.repository+'#'+otherN});
        await kept(r,await terminal(r,n,head,result),'other_pr_not_terminal');committed(await release(r));
      }
    });
    await t.test('new head authorization without explicit holder readiness revokes old conditional intent',async()=>{
      const r=await claim(await task()),head='f'.repeat(40),result=await admitted(r,80,head,{ready:true});
      committed(await authorize(r,'0'.repeat(40),81));
      assert.equal((await call('holder','clued_work_verify_v1',{scope:'global',claim_id:r.claim.claim_id})).terminal_release_ready,false);
      // Finish the extra relation with the existing legacy terminal door;
      // this must not make the earlier readiness valid again.
      await call('ci','clued_work_merge_slot_return_v1',{scope:'global',pr_ref:repo+'#81'});
      await kept(r,await terminal(r,80,head,result),'editing_occupancy_unconfirmed');committed(await release(r));
    });
    await t.test('revoked or no-longer-writing holder bindings invalidate historical readiness',async()=>{
      for(const [i,change] of [{revoked_at:new Date().toISOString()},{scopes:['context:read']}].entries()){
        const r=await claim(await task()),head='1'.repeat(40),n=85+i,result=await admitted(r,n,head,{ready:true});
        try{
          if(change.revoked_at)await admin.query('update public.clued_agent_bindings set revoked_at=$2 where id=$1',[ids.holder,change.revoked_at]);
          else await admin.query('update public.clued_agent_bindings set scopes=$2 where id=$1',[ids.holder,change.scopes]);
          await kept(r,await terminal(r,n,head,result),'editing_occupancy_unconfirmed');
        }finally{
          await admin.query("update public.clued_agent_bindings set revoked_at=null,scopes=array['context:read','context:write'] where id=$1",[ids.holder]);
          if((await row(r)).status==='ACTIVE')committed(await release(r));
        }
      }
    });
    await t.test('invalid terminal proof cannot disclose a private Task through another authorized scope Receipt',async()=>{
      const project=uuid(),scope='project:'+project;
      await admin.query(`insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at)
        values($1,$2,'Private terminal','private terminal',$3,'confirmed',now())`,[project,user,scope]);
      const r=await claim(await task(scope),scope),head='c'.repeat(40),n=82,result=await admitted(r,n,head,{ready:true});
      const before=await row(r),proof={last_admission:{...result.terminal_admission,receipt_id:uuid()},observation:{}};
      const rejected=await call('ciLimited','clued_work_merge_slot_return_v1',{scope:'global',pr_ref:repo+'#'+n,terminal_proof:proof});
      const receipt=(await admin.query('select context_key,metadata from public.clued_audit_receipts where id=$1',[rejected.auto_release.receipt_id])).rows[0];
      assert.equal(receipt.context_key,'global');assert.equal(receipt.metadata.task_id,null);
      assert.equal(JSON.stringify(receipt).includes(r.claim.task_id),false);assert.deepEqual(await row(r),before);
      assert.equal((await resolve('reader',n,head,{scope,read_only:true})).binding_status,'bound');committed(await release(r));
    });
    await t.test('broad or incompletely covered write sets cannot erase editing occupancy',async()=>{
      for(const [i,broad] of [true,false].entries()){
        const id=await task(),r=await claim(id,'global',broad?['fixture/'+id+'/**']:['fixture/'+id+'/main.mjs','fixture/'+id+'/planned.mjs']);
        const head='5'.repeat(40),n=20+i,result=await admitted(r,n,head,{ready:true});
        await kept(r,await terminal(r,n,head,result),'editing_occupancy_unconfirmed');committed(await release(r));
      }
    });
    await t.test('renewal, reclaim and real Owner handover invalidate old readiness/last-admission CAS',async()=>{
      const r=await claim(await task()),head='6'.repeat(40),result=await admitted(r,30,head,{ready:true});
      r.claim=committed(await call('holder','clued_work_renew_v1',{scope:'global',claim_id:r.claim.claim_id,fence:r.claim.fence,
        lease_version:r.claim.lease_version,lease_key:r.lease_key,progress_ref:'editing:'+uuid()})).claim;
      assert.equal((await call('holder','clued_work_verify_v1',{scope:'global',claim_id:r.claim.claim_id})).terminal_release_ready,false);
      const stale=await terminal(r,30,head,result);await kept(r,stale,'claim_cas_changed');
      assert.equal(stale.returned,false);assert.equal(stale.pr_ref,repo+'#30');assert.deepEqual(stale.merge_slot_returned,[]);
      const staleAdopt=await terminal(r,30,head,result,{merged:true});
      assert.equal(staleAdopt.adopted,false);assert.equal(staleAdopt.pr_ref,repo+'#30');committed(await release(r));
      const id=await task(),old=await claim(id),oldProof=await admitted(old,31,head,{ready:true});committed(await release(old));
      const next=await claim(id),late=await terminal(old,31,head,oldProof);
      assert.equal(late.auto_release.released,false);assert.equal((await row(next)).status,'ACTIVE');committed(await release(next));
      const h=await claim(await task()),proof=await admitted(h,32,head,{ready:true});
      const offered=await native('clued_work_claim_handover_confirmation_issue_v1',{claim_id:h.claim.claim_id});
      const moved=committed(await native('clued_work_claim_handover_v1',{confirmation_token:offered.confirmation_token,view_digest:offered.view_digest}));
      await kept(h,await terminal(h,32,head,proof),'claim_cas_changed');
      committed(await release({claim:moved.claim,lease_key:moved.lease_key}));
    });
    await t.test('wrong key, ordinary reader and open observation never activate automatic release',async()=>{
      const r=await claim(await task()),head='7'.repeat(40);
      const denied=await authorize(r,head,40,{terminal_release_ready:true,lease_key:'clued_lk_'+'0'.repeat(64)});
      assert.equal(denied.status,'rejected');assert.equal(denied.terminal_readiness_receipt_id,undefined);
      const result=await admitted(r,40,head,{ready:true}),unprivileged=await terminal(r,40,head,result,{who:'reader'});
      assert.equal(unprivileged.reason,'admission_binding_required');assert.equal(unprivileged.auto_release,undefined);
      const extra={terminal_proof:{last_admission:result.terminal_admission,observation:{repository:repo,pr_ref:repo+'#40',head_sha:head,
        base_sha:'b'.repeat(40),target_branch:'main',state:'open',merged:false}}};
      await kept(r,await terminal(r,40,head,result,{extra}),'terminal_observation_unconfirmed');committed(await release(r));
    });
    await t.test('race keeps original winner semantics and open/adopt-only calls never mean terminal release',async()=>{
      const id=await task(),offer=await native('clued_work_claim_multi_confirmation_issue_v1',{task_id:id,copies:2,shared_resources:['fixture/'+id+'/**']});
      committed(await native('clued_work_claim_multi_enable_v1',{confirmation_token:offer.confirmation_token,view_digest:offer.view_digest}));
      const a=await claim(id),b=await claim(id),ra=await admitted(a,41,'7'.repeat(40),{ready:true}),rb=await admitted(b,42,'8'.repeat(40),{ready:true});
      const landed=await terminal(b,42,'8'.repeat(40),rb,{merged:true,proof:false});
      assert.equal(landed.adopted,true);assert.equal(landed.auto_release.released,false);
      assert.equal((await row(b)).status,'ACTIVE');assert.equal((await row(a)).status,'SUPERSEDED');
      assert.equal((await terminal(a,41,'7'.repeat(40),ra)).auto_release?.released??false,false);assert.equal((await row(b)).status,'ACTIVE');
      committed(await release(b));
    });
    await t.test('current/old uncertain publications and workflow dispatch cannot be interpreted as idle',async()=>{
      for(const epochOffset of [0,-1]){
        let r=await claim(await task());
        if(epochOffset<0){
          const p=await native('clued_work_claim_handover_confirmation_issue_v1',{claim_id:r.claim.claim_id});
          const m=committed(await native('clued_work_claim_handover_v1',{confirmation_token:p.confirmation_token,view_digest:p.view_digest}));
          r={claim:m.claim,lease_key:m.lease_key};
        }
        const head='9'.repeat(40),n=epochOffset===0?50:52,result=await admitted(r,n,head,{ready:true});
        await admin.query("insert into clued_private.work_claim_publications_v1(user_id,claim_id,execution_epoch,repository,head_sha,pr_ref,run_id,publication_key) values($1,$2,$3,$4,$5,$6,'10',$7)",
          [user,r.claim.claim_id,r.claim.execution_epoch+epochOffset,repo,head,repo+'#'+n,uuid()]);
        await kept(r,await terminal(r,n,head,result),'publication_pending');committed(await release(r));
      }
      const r=await claim(await task()),head='a'.repeat(40),result=await admitted(r,51,head,{ready:true});
      committed(await authorize(r,'b'.repeat(40),null,{workflow:'fixture.yml'}));
      assert.equal((await call('ci','clued_work_verify_v1',{scope:'global',claim_id:r.claim.claim_id,repository:repo,ci_dispatch:true,
        workflow:'fixture.yml',head_sha:'b'.repeat(40),base_sha:'c'.repeat(40),target_branch:'main',
        changed_paths:['fixture/'+r.claim.task_id+'/main.mjs']})).verdict,'ADMITTED');
      await kept(r,await terminal(r,51,head,result),'dispatch_state_unconfirmed');committed(await release(r));
    });
  }finally{
    for(const c of clients.reverse())await c.end().catch(()=>{});
    const ownPid=server.process?.pid;
    await stopCluster(server);
    const stopped=await waitForPidExit(ownPid);
    process.stderr.write('terminal-release fixture cleanup pid=' + ownPid + ' exited=' + stopped + '\n');
    assert.equal(stopped,true,'this fixture must stop its own PostgreSQL child');
  }
});
