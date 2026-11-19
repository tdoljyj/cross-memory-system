// Terminal admission is removed (20261113151000). A PR's end through adopt (merged) or
// an explicit GitHub closure releases the claim that served it when the Task has no other
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
    const claim = async (task_id, session = uuid(), scope = 'global', trigger_refs = []) => committed(await call('holder', 'clued_work_claim_v1', {
      task_id, scope, trigger_refs, write_set: ['fixture/' + task_id + '/main.mjs'], holder_label: 'pr-end fixture', holder_session_ref: session, idempotency_key: uuid() }));
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
    const giveBack = (n, extra = {}) => call('ci','clued_work_merge_slot_return_v1',{scope:'global',pr_ref:repo+'#'+n,...extra});
    const binding = async n => (await admin.query('select status from clued_private.work_claim_pr_task_bindings_v1 where repo_id=$1 and pr_number=$2',[repo,n])).rows[0]?.status;

    const releaseInfo = async r => (await admin.query('select to_jsonb(c) value from clued_private.work_claims_v1 c where claim_id=$1', [r.claim.claim_id])).rows[0].value;
    const inbox = async r => (await call('holder', 'clued_agent_inbox_v1', {
      session_ref: r.claim.holder_session_ref, view: 'unread', mark_read: false,
    })).messages.filter(m => m.to_claim_id === r.claim.claim_id);
    const slot = 'merge:' + repo + ':main';
    await t.test('#1166 检查失败让槽后，同一认领重新入队、通过准入并在合入时释放', async () => {
      const head = '6'.repeat(40), mergeSha = 'f'.repeat(40);
      const r = await claim(await task(), uuid(), 'global', [slot]);
      assert.ok(r.claim.merge_slot_until);
      await admitted(r, 1166, head);
      const endReceipts = async () => (await admin.query(`select operation from public.clued_audit_receipts
        where user_id=$1 and ((object_id=$2 and operation='work_claim_pr_task_finish')
          or (object_id=$3 and operation='work_claim_release'))`, [user, r.claim.task_id, r.claim.claim_id])).rows;
      assert.deepEqual(await endReceipts(), []);
      const result = await giveBack(1166);
      assert.equal(result.returned, true);
      assert.deepEqual(result.merge_slot_returned, [r.claim.claim_id]);
      const after = await releaseInfo(r);
      assert.deepEqual({
        binding: await binding(1166), claim: after.status, releasedBy: after.released_by,
        refs: after.trigger_refs, slotAt: after.merge_slot_at, receipt: result.binding_receipt_id,
        endReceipts: await endReceipts(), inbox: (await inbox(r)).length,
      }, { binding: 'active', claim: 'ACTIVE', releasedBy: null, refs: [], slotAt: null, receipt: null, endReceipts: [], inbox: 0 });
      const renewed = committed(await call('holder', 'clued_work_renew_v1', {
        scope: 'global', claim_id: r.claim.claim_id, fence: r.claim.fence, lease_version: after.lease_version,
        lease_key: r.lease_key, trigger_refs: [slot], progress_ref: 'fixture:' + uuid(),
      }));
      assert.equal(renewed.claim.claim_id, r.claim.claim_id);
      assert.ok(renewed.claim.merge_slot_until);
      assert.equal((await verify('ci', r, 1166, head)).verdict, 'ADMITTED');
      const event = await gateway.query('select public.clued_work_pr_merged_event_v1($1) as result',
        [{ repository: repo, pr_number: 1166, merge_sha: mergeSha }]);
      assert.deepEqual(event.rows[0].result, { status: 'ok', finished: 1, released: [r.claim.claim_id] });
      const ended = await releaseInfo(r);
      assert.deepEqual([await binding(1166), ended.status, ended.released_by, ended.released_evidence_ref],
        ['merged', 'RELEASED', 'pr_end', repo + '#1166@' + mergeSha]);
    });
    await t.test('#1151 同 Task 另有打开的 PR 时保留槽和两个绑定', async () => {
      const r = await claim(await task(), uuid(), 'global', [slot]);
      await admitted(r, 1151, '1'.repeat(40));
      await admitted(r, 1152, '2'.repeat(40));
      const result = await giveBack(1151);
      assert.equal(result.returned, false);
      assert.deepEqual(result.merge_slot_returned, []);
      assert.equal(await binding(1151), 'active');
      assert.equal(await binding(1152), 'active');
      assert.deepEqual((await releaseInfo(r)).trigger_refs, [slot]);
      committed(await release(r));
    });
    await t.test('非法 GitHub 状态被拒绝，迟到的关闭让槽保留 merged', async () => {
      const r = await claim(await task());
      await admitted(r, 106, '6'.repeat(40));
      for (const value of ['open', 'merged', '', null, false, {}]) {
        await assert.rejects(() => giveBack(106, { github_state: value }), { code: '22023', message: 'work_claim_merge_slot_return_input_invalid' });
      }
      assert.equal(await binding(106), 'active');
      assert.equal((await adopt(106)).status, 'ok');
      assert.equal((await giveBack(106, { github_state: 'closed' })).binding_receipt_id, null);
      assert.equal(await binding(106), 'merged');
    });
    await t.test('关闭释放后，新认领可在原 Task 上重新授权、发现并准入同一 PR', async () => {
      const taskId = await task(), head = '7'.repeat(40);
      const first = await claim(taskId);
      await admitted(first, 107, head);
      // 重现旧版本已经写入的终态，恢复动作从这个历史状态开始。
      await admin.query(`select clued_private.work_claim_pr_finish_v1(b,'global',$2,'closed')
        from public.clued_agent_bindings b where b.id=$1`, [ids.ci, repo + '#107']);
      await admin.query(`select clued_private.work_claim_pr_end_release_v1(b,'global',$2,null)
        from public.clued_agent_bindings b where b.id=$1`, [ids.ci, repo + '#107']);
      assert.equal(await binding(107), 'closed');
      assert.equal((await releaseInfo(first)).released_by, 'pr_end');
      const next = await claim(taskId);
      assert.notEqual(next.claim.claim_id, first.claim.claim_id);
      await admitted(next, 107, head);
      assert.equal(await binding(107), 'active');
      committed(await release(next));
    });
    await t.test('PR merge records its source and merge SHA and notifies only the original holder once', async () => {
      const r = await claim(await task()); await admitted(r, 101, 'a'.repeat(40));
      assert.equal((await adopt(101)).status, 'ok');
      const c = await releaseInfo(r);
      assert.equal(c.status, 'RELEASED'); assert.equal(c.released_by, 'pr_end');
      assert.equal(c.released_evidence_ref, repo + '#101@' + 'f'.repeat(40));
      assert.ok(Number.isFinite(Date.parse(c.released_at)));
      const messages = await inbox(r); assert.equal(messages.length, 1);
      assert.equal(messages[0].kind, 'info');
      assert.equal(messages[0].body, `认领 ${r.claim.claim_id} 已因 ${repo}#101 合入（ffffffff）于 ${new Date(c.released_at).toISOString()} 自动释放，Task ${r.claim.task_id}`);
      assert.equal((await call('otherHolder', 'clued_agent_inbox_v1', { view: 'unread' })).messages.length, 0);
      const observed = await call('holder', 'clued_work_verify_v1', { scope: 'global', claim_id: r.claim.claim_id });
      assert.equal(observed.claim.released_by, 'pr_end');
      assert.equal(observed.claim.released_evidence_ref, c.released_evidence_ref);
      const ended = (await native('clued_work_claims_owner_list_v1', { ended_within_hours: 24 })).ended.find(x => x.claim_id === r.claim.claim_id);
      assert.equal(ended.released_by, 'pr_end'); assert.equal(ended.released_evidence_ref, c.released_evidence_ref);
      assert.equal((await adopt(101)).status, 'ok'); assert.equal((await inbox(r)).length, 1);
    });
    await t.test('holder release returns and persists holder source, evidence and time; draining is still live', async () => {
      const r = await claim(await task());
      const conflict = await call('otherHolder', 'clued_work_claim_v1', { scope: 'global', task_id: r.claim.task_id,
        write_set: r.claim.write_set, idempotency_key: uuid(), holder_label: 'conflicting fixture' });
      assert.equal(conflict.error_code, 'work_claim_conflict');
      assert.equal(conflict.conflicts[0].released_by, null); assert.equal(conflict.conflicts[0].released_at, null);
      assert.equal(conflict.conflicts[0].released_evidence_ref, null);
      const draining = committed(await call('holder', 'clued_work_release_v1', { scope: 'global', claim_id: r.claim.claim_id,
        fence: r.claim.fence, lease_key: r.lease_key, outcome: 'draining' }));
      assert.equal(draining.claim.released_by, null); assert.equal(draining.claim.released_at, null);
      const result = committed(await release(r)), c = await releaseInfo(r);
      assert.equal(c.released_by, 'holder'); assert.equal(result.claim.released_by, 'holder');
      assert.equal(result.claim.released_evidence_ref, c.released_evidence_ref);
      assert.match(c.released_evidence_ref, /^fixture:/); assert.ok(Date.parse(c.released_at));
      assert.equal((await inbox(r)).length, 0);
    });
    await t.test('a message insertion failure cannot undo PR release or its receipt', async () => {
      const r = await claim(await task()); await admitted(r, 102, 'b'.repeat(40));
      await admin.query(`create function clued_private.fixture_reject_release_message() returns trigger language plpgsql as $$
        begin raise exception 'fixture message insert failed'; end $$;
        create trigger fixture_reject_release_message before insert on clued_private.agent_messages_v1
        for each row execute function clued_private.fixture_reject_release_message()`);
      try {
        assert.equal((await adopt(102)).status, 'ok');
        const c = await releaseInfo(r); assert.equal(c.status, 'RELEASED'); assert.equal(c.released_by, 'pr_end');
        assert.equal((await admin.query("select count(*)::int n from public.clued_audit_receipts where operation='work_claim_release' and object_id=$1", [r.claim.claim_id])).rows[0].n, 1);
        assert.equal((await inbox(r)).length, 0);
      } finally {
        await admin.query('drop trigger fixture_reject_release_message on clued_private.agent_messages_v1; drop function clued_private.fixture_reject_release_message()');
      }
    });
    await t.test('closed PR notification has no invented SHA; disabling messages preserves release metadata', async () => {
      const r = await claim(await task()); await admitted(r, 103, 'c'.repeat(40));
      assert.equal((await giveBack(103, { github_state: 'closed' })).status, 'ok');
      assert.equal((await releaseInfo(r)).released_evidence_ref, repo + '#103');
      assert.match((await inbox(r))[0].body, /关闭（合并 SHA 不可得）/);
      const c = await claim(await task()); await admitted(c, 104, 'd'.repeat(40));
      await admin.query(`insert into clued_private.agent_message_settings_v1(user_id,enabled,version,updated_at,receipt_id)
        values($1,false,1,now(),$2)`, [user, roleReceipt]);
      try {
        assert.equal((await adopt(104)).status, 'ok');
        assert.equal((await releaseInfo(c)).released_by, 'pr_end'); assert.equal((await inbox(c)).length, 0);
      } finally { await admin.query('delete from clued_private.agent_message_settings_v1 where user_id=$1', [user]); }
    });
    await t.test('expiry, hard deadline and takeover expose explicit sources without fabricating historical releases', async () => {
      const expired = await claim(await task());
      await admin.query("update clued_private.work_claims_v1 set issued_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' where claim_id=$1", [expired.claim.claim_id]);
      const virtual = (await native('clued_work_claims_owner_list_v1', { ended_within_hours: 24 })).ended.find(c => c.claim_id === expired.claim.claim_id);
      assert.equal(virtual.released_by, 'expiry'); assert.equal(virtual.released_at, virtual.expires_at);
      await admin.query('select clued_private.work_claim_expire_due($1)', [user]);
      assert.equal((await releaseInfo(expired)).released_by, 'expiry');
      const next = committed(await call('otherHolder', 'clued_work_takeover_v1', {
        scope: 'global', claim_id: expired.claim.claim_id, holder_label: 'release source takeover fixture',
        write_set: expired.claim.write_set, idempotency_key: uuid(),
      }));
      const old = await releaseInfo(expired);
      assert.equal(old.released_by, 'takeover'); assert.equal(old.released_evidence_ref, 'claim:' + next.claim.claim_id);
      committed(await call('otherHolder', 'clued_work_release_v1', { scope: 'global', claim_id: next.claim.claim_id,
        fence: next.claim.fence, lease_key: next.lease_key, outcome: 'abandoned' }));
      const hard = await claim(await task());
      await admin.query("update clued_private.work_claims_v1 set issued_at=now()-interval '2 seconds',expires_at=now()-interval '1 second',hard_deadline_at=now()-interval '1 second' where claim_id=$1", [hard.claim.claim_id]);
      await admin.query('select clued_private.work_claim_expire_due($1)', [user]);
      const deadline = await releaseInfo(hard); assert.equal(deadline.released_by, 'hard_deadline');
      assert.equal(deadline.released_at, deadline.expires_at);
    });
    await t.test('Owner handover keeps the claim live and does not invent a release', async () => {
      const r = await claim(await task());
      const issued = await native('clued_work_claim_handover_confirmation_issue_v1', { claim_id: r.claim.claim_id });
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      const handed = committed(await native('clued_work_claim_handover_v1', { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }));
      const c = await releaseInfo(r);
      assert.equal(c.status, 'ACTIVE'); assert.equal(c.released_by, null); assert.equal(c.released_at, null);
      assert.ok(Number(c.fence) > Number(r.claim.fence));
      // Owner handover delivers a private key; release using that exact result.
      // The delivered key is never written to fixture output or disk.
      committed(await call('holder', 'clued_work_release_v1', { scope: 'global', claim_id: r.claim.claim_id,
        fence: handed.claim.fence, lease_key: handed.lease_key, outcome: 'abandoned' }));
    });
    await t.test('race losers record copy adoption and the winning claim as evidence', async () => {
      const id = await task();
      const issued = await native('clued_work_claim_multi_confirmation_issue_v1', {
        task_id: id, copies: 2, shared_resources: ['fixture/' + id + '/main.mjs'],
      });
      assert.equal(issued.status, 'issued', JSON.stringify(issued));
      committed(await native('clued_work_claim_multi_enable_v1', { confirmation_token: issued.confirmation_token, view_digest: issued.view_digest }));
      const winner = await claim(id), loser = await claim(id);
      await admitted(winner, 105, 'e'.repeat(40)); assert.equal((await adopt(105)).status, 'ok');
      const c = await releaseInfo(loser);
      assert.equal(c.status, 'SUPERSEDED'); assert.equal(c.released_by, 'copy_adoption');
      assert.equal(c.released_evidence_ref, 'claim:' + winner.claim.claim_id); assert.ok(Date.parse(c.released_at));
      assert.equal((await releaseInfo(winner)).released_by, 'pr_end');
      assert.equal((await inbox(loser)).length, 0);
    });

    await t.test('empty edit preflight retains holder authority, path coverage and the original renewal gates',async t=>{
      const r=await claim(await task());
      const input={action:'verify_edit',scope:'global',claim_id:r.claim.claim_id,fence:r.claim.fence,
        execution_epoch:r.claim.execution_epoch,lease_version:r.claim.lease_version,lease_key:r.lease_key,changed_paths:[]};
      const edit=(extra={},who='holder')=>call(who,'clued_work_verify_v1',{...input,...extra});
      const denied=async(extra,reason,who='holder')=>{
        const answer=await edit(extra,who);
        assert.equal(answer.holder_edit_authorized,false,JSON.stringify(answer));
        assert.equal(answer.verdict,'REJECTED');assert.ok(answer.reasons.includes(reason),JSON.stringify(answer));
      };
      const snapshot=async()=>(await admin.query(`select jsonb_build_object('claim',to_jsonb(c),
        'receipts',(select count(*) from public.clued_audit_receipts where user_id=$1),
        'heads',(select count(*) from clued_private.work_claim_head_authorizations_v1 where claim_id=$2),
        'admissions',(select count(*) from clued_private.work_claim_execution_admissions_v1 where claim_id=$2),
        'bindings',(select count(*) from clued_private.work_claim_pr_task_bindings_v1 where task_id=$3)) v
        from clued_private.work_claims_v1 c where c.user_id=$1 and c.claim_id=$2`,[user,r.claim.claim_id,r.claim.task_id])).rows[0].v;
      await t.test('empty preflight changes no claim, receipt, head authorization, admission or PR binding',async()=>{
        const before=await snapshot(),answer=await edit();
        assert.equal(answer.holder_edit_authorized,true,JSON.stringify(answer));noTerminal(answer);
        assert.equal(answer.execution_authorized,false);assert.equal(answer.task_ci_heads_24h,0);
        assert.deepEqual(await snapshot(),before);
        const attr=(await admin.query(`select prosecdef,provolatile,proconfig,proacl::text acl from pg_proc
          where oid='clued_private.work_claim_verify_before_main_merge_v1(text,jsonb)'::regprocedure`)).rows[0];
        assert.deepEqual(attr,{prosecdef:true,provolatile:'v',proconfig:['search_path=""'],acl:'{postgres=X/postgres}'});
        for(const role of ['anon','authenticated','service_role','clued_worker_gateway'])
          assert.equal((await admin.query('select has_function_privilege($1,$2,\'execute\') allowed',
            [role,'clued_private.work_claim_verify_before_main_merge_v1(text,jsonb)'])).rows[0].allowed,false);
      });
      await t.test('wrong key, fence, epoch, version, claim or scope cannot pass an empty preflight',async()=>{
        const wrongKey=r.lease_key.slice(0,-1)+(r.lease_key.endsWith('0')?'1':'0');
        await denied({lease_key:wrongKey},'work_claim_lease_key_invalid');
        await denied({fence:Number(r.claim.fence)+1},'work_claim_fence_mismatch');
        await denied({execution_epoch:Number(r.claim.execution_epoch)+1},'work_claim_execution_epoch_mismatch');
        await denied({lease_version:Number(r.claim.lease_version)+1},'work_claim_version_conflict');
        await denied({claim_id:uuid()},'work_claim_not_found');
        await denied({scope:'project:'+uuid()},'work_claim_not_found');
      });
      await t.test('read-only and different-holder Bindings cannot turn possession of a key into edit authority',async()=>{
        await assert.rejects(()=>edit({},'reader'),e=>e.code==='42501');
        await denied({},'work_claim_not_holder','otherHolder');
      });
      await t.test('normal empty checks and malformed paths remain invalid; an empty preflight grants no outside path',async()=>{
        await assert.rejects(()=>call('holder','clued_work_verify_v1',{scope:'global',claim_id:r.claim.claim_id,changed_paths:[]}),/work_claim_write_set_invalid/);
        for(const changed_paths of [null,'fixture', ['']])await assert.rejects(()=>edit({changed_paths}),e=>e.code==='22023');
        const outside=await edit({changed_paths:['fixture/'+r.claim.task_id+'/new.mjs']});
        assert.equal(outside.holder_edit_authorized,false);assert.equal(outside.verdict,'REJECTED');
        assert.equal((await edit({changed_paths:r.claim.write_set})).holder_edit_authorized,true);
      });
      await t.test('original-key union renewal is still required, then the latest version and actual paths must pass',async()=>{
        const next='fixture/'+r.claim.task_id+'/new.mjs';
        const renewed=committed(await call('holder','clued_work_renew_v1',{scope:'global',claim_id:r.claim.claim_id,
          fence:r.claim.fence,lease_version:r.claim.lease_version,lease_key:r.lease_key,
          progress_ref:'fixture:'+uuid(),write_set:[...r.claim.write_set,next]}));
        await denied({},'work_claim_version_conflict');
        input.lease_version=renewed.claim.lease_version;
        const answer=await edit({changed_paths:[next]});assert.equal(answer.holder_edit_authorized,true);noTerminal(answer);
      });
      await t.test('expired claims and inactive Tasks cannot use the preflight',async()=>{
        const lease=(await admin.query('select issued_at::text issued,expires_at::text expiry from clued_private.work_claims_v1 where claim_id=$1',[r.claim.claim_id])).rows[0];
        await admin.query("update clued_private.work_claims_v1 set issued_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' where claim_id=$1",[r.claim.claim_id]);
        try{await denied({},'work_claim_not_active');}finally{
          await admin.query('update clued_private.work_claims_v1 set issued_at=$2,expires_at=$3 where claim_id=$1',[r.claim.claim_id,lease.issued,lease.expiry]);
        }
        committed(await call('holder','clued_record_mutate',{operation:'close',record_type:'task',record_schema_version:1,
          id:r.claim.task_id,base_version:1,lifecycle_status:'completed',scope:'global',idempotency_key:uuid(),
          authority:'observed',confidence_reason:'isolated completed fixture',source_refs:[],source_unavailable_reason:'fixture',
          mutation:{closed_reason:'fixture completed',closure_summary:'fixture completed'}}));
        await assert.rejects(()=>edit(),e=>e.code==='22023'&&/work_claim_task/.test(e.message));
      });
      committed(await release(r));
    });
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
      assert.equal((await giveBack(4, { github_state: 'closed' })).status,'ok');assert.equal(await binding(4),'closed');
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
      const original=(await admin.query("select pg_get_functiondef('clued_private.work_claim_pr_end_release_v1(public.clued_agent_bindings,text,text,text)'::regprocedure) d")).rows[0].d;
      // A fault after a partial write: the write must roll back with the judgment.
      await admin.query(`create or replace function clued_private.work_claim_pr_end_release_v1(b public.clued_agent_bindings,p_scope text,p_pr text,p_merge_sha text)
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
