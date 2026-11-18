import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { PLATFORM_SQL } from '../scripts/production-schema-drift.mjs';
import { stopCluster, waitForPidExit } from './cluster-cleanup.mjs';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';
import { setWorkerGatewayCaller, workerGatewayRpc } from './worker-gateway-caller-fixture.mjs';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';

const repository = 'fixture/pr-task';
const mergeSha = 'f'.repeat(40);
const input = pr => ({ repository, pr_number: pr, merge_sha: mergeSha });
const sql = 'select public.clued_work_pr_merged_event_v1($1::jsonb) as result';
const empty = { status: 'ok', finished: 0, released: [] };
const migrations = new URL('../supabase/migrations/', import.meta.url);
const committed = result => {
  assert.equal(result.status, 'committed', result.error_code);
  return result;
};

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

test('PR 合入事件释放符合条件的认领', { timeout: 300000 }, async t => {
  const server = new EmbeddedPostgres({
    databaseDir: await fs.mkdtemp(path.join(os.tmpdir(), 'clued-merged-event-')),
    user: 'postgres', password: randomUUID(), port: await freePort(), persistent: false,
    postgresFlags: ['-c', 'io_method=sync'], onLog() {}, onError(message) { console.error(message); },
  });
  const clients = [];
  const connect = async () => {
    const client = server.getPgClient();
    clients.push(client);
    await client.connect();
    return client;
  };
  try {
    await server.initialise();
    await server.start();
    const admin = await connect();
    await admin.query(PLATFORM_SQL);
    for (const name of (await fs.readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
      await admin.query(await fs.readFile(new URL(name, migrations), 'utf8'));
    }
    await allowRawTestBindings(admin);
    const user = randomUUID();
    await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'merge@example.invalid',now())", [user]);
    const tokens = {};
    const ids = {};
    for (const name of ['holder', 'otherHolder', 'ci']) {
      tokens[name] = randomBytes(32).toString('hex');
      ids[name] = (await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*']) returning id`,
      [user, name, tokens[name], name === 'ci' ? ['context:read'] : ['context:read', 'context:write']])).rows[0].id;
    }
    await admin.query(`with receipt as (insert into public.clued_audit_receipts
      (user_id,context_key,operation,object_type,object_id,version,metadata,status)
      values($1,'global','fixture_role','binding',$2::uuid::text,1,'{}','committed') returning id)
      insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      select $1,$2,'ci-admission',now(),id from receipt`, [user, ids.ci]);
    const anon = await connect();
    await anon.query('set role anon');
    const gateway = await connect();
    await setWorkerGatewayCaller(gateway);
    const notices = [];
    gateway.on('notice', notice => notices.push(notice.message));
    const event = async body => (await gateway.query(sql, [JSON.stringify(body)])).rows[0].result;
    const rpc = (who, name, args) => workerGatewayRpc(gateway, name, tokens[who], args);
    const ci = async (name, args) => (await anon.query(`select public.${name}($1,$2) as result`, [tokens.ci, args])).rows[0].result;
    const task = async (scope = 'global', holder = 'holder') => committed(await rpc(holder, 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active', scope,
      idempotency_key: randomUUID(), authority: 'observed', confidence_reason: 'local fixture',
      source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title: randomUUID(), content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = (who, taskId, file, scope = 'global') => rpc(who, 'clued_work_claim_v1', {
      scope, task_id: taskId, write_set: [file], holder_label: who, holder_session_ref: randomUUID(), idempotency_key: randomUUID(),
    });
    const authorize = (r, sha, pr) => rpc('holder', 'clued_work_renew_v1', {
      scope: r.claim.context_key, action: 'authorize_head', claim_id: r.claim.claim_id, fence: r.claim.fence,
      lease_version: r.claim.lease_version, lease_key: r.lease_key, repository, head_sha: sha,
      target_branch: 'main', ...(pr ? { pr_number: pr } : {}), idempotency_key: randomUUID(),
    });
    const admit = async (r, sha, pr) => {
      committed(await authorize(r, sha, pr));
      const proof = { scope: r.claim.context_key, pr_ref: repository + '#' + pr, head_sha: sha, base_sha: 'b'.repeat(40), target_branch: 'main' };
      assert.equal((await ci('clued_work_verify_v1', { ...proof, action: 'resolve_pr_claim' })).binding_status, 'bound');
      const result = await ci('clued_work_verify_v1', { ...proof, claim_id: r.claim.claim_id, changed_paths: r.claim.write_set });
      assert.equal(result.verdict, 'ADMITTED');
    };
    const admitted = async (pr, scope = 'global') => {
      const taskId = await task(scope);
      const r = committed(await claim('holder', taskId, 'fixture/' + taskId + '/main.mjs', scope));
      await admit(r, randomBytes(20).toString('hex'), pr);
      return r;
    };
    const adopt = pr => ci('clued_work_claim_adopt_v1', { scope: 'global', pr_ref: repository + '#' + pr, merge_sha: mergeSha });
    const state = async id => (await admin.query(`select status,released_by,released_at,released_evidence_ref,
      expires_at <= clock_timestamp()+interval '2 hours' as ordinary_lease from clued_private.work_claims_v1 where claim_id=$1`, [id])).rows[0];
    const binding = async pr => (await admin.query('select status from clued_private.work_claim_pr_task_bindings_v1 where user_id=$1 and repo_id=$2 and pr_number=$3', [user, repository, pr])).rows[0].status;
    const receipts = async id => (await admin.query("select binding_id,metadata from public.clued_audit_receipts where operation='work_claim_release' and object_id=$1", [id])).rows;
    const messages = async id => (await admin.query(`select
      (select count(*)::int from clued_private.agent_messages_v1 where to_claim_id=$1::uuid) as inbox,
      (select count(*)::int from public.clued_audit_receipts where operation='agent_message_send' and metadata->>'to_claim_id'=$1::uuid::text) as sent`, [id])).rows[0];
    const checkSilentRelease = async (r, pr) => {
      const id = r.claim.claim_id;
      const record = await state(id);
      assert.equal(record.status, 'RELEASED');
      assert.equal(record.released_by, 'pr_end');
      assert.ok(record.released_at);
      assert.equal(record.released_evidence_ref, repository + '#' + pr + '@' + mergeSha);
      const audit = await receipts(id);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].binding_id, ids.holder);
      assert.equal(audit[0].metadata.released_by_binding_id, null);
      assert.equal(audit[0].metadata.released_evidence_ref, record.released_evidence_ref);
      const finish = await admin.query(`select binding_id from public.clued_audit_receipts
        where user_id=$1 and operation='work_claim_pr_task_finish' and object_id=$2 and metadata->>'status'='merged'`,
      [user, r.claim.task_id]);
      assert.deepEqual(finish.rows, [{ binding_id: null }]);
      assert.deepEqual(await messages(id), { inbox: 0, sent: 0 });
      assert.ok(!notices.some(message => message.includes('work_claim_pr_end_notification_skipped')));
    };
    // 两个不同的 Task 争用完全相同的文件，单独验证每条入口都能解除冲突。
    const contention = async pr => {
      const r = await admitted(pr);
      const waiting = await task();
      const retry = () => claim('otherHolder', waiting, r.claim.write_set[0]);
      assert.equal((await retry()).error_code, 'work_claim_conflict');
      return { r, retry };
    };

    await t.test('#1161 网关在常驻 adopt 前释放路径，重投不补发通知', async () => {
      const { r, retry } = await contention(1161);
      assert.equal((await admin.query('select clued_private.agent_messages_enabled_v1($1) as enabled', [user])).rows[0].enabled, true);
      assert.deepEqual(await event(input(1161)), { status: 'ok', finished: 1, released: [r.claim.claim_id] });
      committed(await retry());
      await checkSilentRelease(r, 1161);
      const late = await adopt(1161);
      assert.equal(late.status, 'ok');
      assert.equal(late.pr_ref, repository + '#1161');
      assert.equal(late.binding_receipt_id, null);
      assert.equal(await binding(1161), 'merged');
      assert.deepEqual(await event(input(1161)), empty);
      await checkSilentRelease(r, 1161);
    });

    await t.test('#1161 签名投递经过 Worker 和数据库网关后，冲突路径可立即认领', async t => {
      const { r, retry } = await contention(1162);
      const worker = await loadContinuityWorker();
      const secret = randomBytes(32).toString('hex');
      const body = JSON.stringify({ action: 'closed', number: 1162, repository: { full_name: repository, default_branch: 'main' },
        pull_request: { merged: true, base: { ref: 'main' }, merge_commit_sha: mergeSha } });
      const calls = [];
      t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls.push(url);
        assert.equal(url, 'https://db.example.test/rest/v1/rpc/clued_work_pr_merged_event_v1');
        assert.equal(init.method, 'POST');
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-gateway');
        const envelope = JSON.parse(init.body);
        assert.deepEqual(envelope, { p_input: input(1162) });
        return Response.json(await event(envelope.p_input));
      });
      const response = await worker.fetch(new Request('https://app.example.test/v1/github/events', {
        method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request',
          'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') },
      }), { GITHUB_WEBHOOK_SECRET: secret, SUPABASE_URL: 'https://db.example.test', SUPABASE_PUBLISHABLE_KEY: 'fixture-key', CLUED_DB_GATEWAY_TOKEN: 'fixture-gateway' });
      const next = await retry();
      assert.deepEqual({ http: response?.status, calls: calls.length, next: next.error_code ?? next.status },
        { http: 200, calls: 1, next: 'committed' });
      await checkSilentRelease(r, 1162);
    });

    await t.test('常驻先 adopt 会通知一次，后到事件不重复发信', async () => {
      const r = await admitted(21);
      assert.equal((await adopt(21)).status, 'ok');
      assert.deepEqual(await messages(r.claim.claim_id), { inbox: 1, sent: 1 });
      assert.deepEqual(await event(input(21)), empty);
      assert.deepEqual(await messages(r.claim.claim_id), { inbox: 1, sent: 1 });
      const audit = await receipts(r.claim.claim_id);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].metadata.released_by_binding_id, ids.ci);
    });

    await t.test('同 Task 仍有打开的 PR 或后来授权的新 head 时保留认领', async () => {
      const r = await admitted(31);
      await admit(r, 'c'.repeat(40), 32);
      assert.deepEqual(await event(input(32)), { status: 'ok', finished: 1, released: [] });
      assert.equal(await binding(31), 'active');
      assert.equal(await binding(32), 'merged');
      assert.equal((await state(r.claim.claim_id)).status, 'ACTIVE');
      const newer = await admitted(33);
      committed(await authorize(newer, 'd'.repeat(40)));
      assert.deepEqual(await event(input(33)), { status: 'ok', finished: 1, released: [] });
      assert.equal(await binding(33), 'merged');
      const record = await state(newer.claim.claim_id);
      assert.equal(record.status, 'ACTIVE');
      assert.equal(record.ordinary_lease, true);
      for (const retained of [r, newer]) {
        committed(await rpc('holder', 'clued_work_release_v1', { scope: 'global', claim_id: retained.claim.claim_id,
          fence: retained.claim.fence, lease_key: retained.lease_key, outcome: 'abandoned' }));
      }
    });

    await t.test('只有网关可以调用，畸形输入被拒绝，未知 PR 返回零行', async () => {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const caller = await connect();
        await caller.query('set role ' + role);
        await assert.rejects(() => caller.query(sql, [input(81)]), { code: '42501' });
      }
      assert.deepEqual(await event(input(404)), empty);
      assert.deepEqual(await event({ ...input(404), repository: 'unknown/repo', merge_sha: null }), empty);
      for (const bad of [null, [], {}, { repository, pr_number: 1 }, { ...input(1), extra: true },
        { ...input(1), repository: 'bad' }, input(-1), input(1.5), input('1'), input(10000000000),
        { ...input(1), merge_sha: '123abcd' }, { ...input(1), merge_sha: 1 }]) {
        await assert.rejects(() => event(bad), { code: '22023' });
      }
    });

    await t.test('unknown 绑定可结束，缺少合并 SHA 时以 PR 为证据释放', async () => {
      const r = await admitted(41);
      await admin.query("update clued_private.work_claim_pr_task_bindings_v1 set status='unknown' where user_id=$1 and repo_id=$2 and pr_number=41", [user, repository]);
      assert.deepEqual(await event({ ...input(41), merge_sha: null }), { status: 'ok', finished: 1, released: [r.claim.claim_id] });
      assert.equal((await state(r.claim.claim_id)).released_evidence_ref, repository + '#41');
      assert.equal(await binding(41), 'merged');
    });

    await t.test('项目范围的同一 PR 并发投递只结束和释放一次', async () => {
      const project = randomUUID();
      const scope = 'project:' + project;
      await admin.query(`with project as (insert into public.clued_projects
        (id,user_id,name,normalized_name,context_key,project_schema_version,project_recognized_v2)
        values($1,$2,'merge fixture','merge fixture',$3,2,true) returning id,user_id)
        insert into clued_private.project_lifecycle_v2_dispositions
        (project_id,user_id,disposition,disposition_reason,recognition_confidence,recognition_source,basis,disposition_hash)
        select id,user_id,'recognized_project','isolated fixture',1,'v2_explicit_create','{}',$4 from project`,
      [project, user, scope, randomBytes(32).toString('hex')]);
      const r = await admitted(42, scope);
      const peer = await connect();
      await setWorkerGatewayCaller(peer);
      const answers = await Promise.all([event(input(42)), peer.query(sql, [input(42)]).then(result => result.rows[0].result)]);
      assert.deepEqual(answers.sort((a, b) => a.finished - b.finished), [empty, { status: 'ok', finished: 1, released: [r.claim.claim_id] }]);
      await checkSilentRelease(r, 42);
    });

    await t.test('多个用户跟踪同一 PR 时逐户结束，另一仓库的同号 PR 保持打开', async () => {
      const r = await admitted(43);
      const other = randomUUID();
      tokens.otherTenant = randomBytes(32).toString('hex');
      await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'other@example.invalid',now())", [other]);
      await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic','另一用户',$2,array['context:read','context:write'],array['*'])`, [other, tokens.otherTenant]);
      const otherTask = await task('global', 'otherTenant');
      await admin.query(`insert into clued_private.work_claim_pr_task_bindings_v1(user_id,repo_id,pr_number,task_id,status)
        values($1,$2,43,$3,'unknown'),($1,'other/repo',43,$3,'active')`, [other, repository, otherTask]);
      assert.deepEqual(await event(input(43)), { status: 'ok', finished: 2, released: [r.claim.claim_id] });
      assert.deepEqual((await admin.query(`select repo_id,status from clued_private.work_claim_pr_task_bindings_v1
        where user_id=$1 and pr_number=43 order by repo_id`, [other])).rows, [
        { repo_id: repository, status: 'merged' }, { repo_id: 'other/repo', status: 'active' },
      ]);
      await checkSilentRelease(r, 43);
    });

    await t.test('释放回执写入故障时回滚释放，PR 绑定仍结束', async () => {
      const r = await admitted(51);
      await admin.query(`create function clued_private.fixture_fail_release() returns trigger language plpgsql as $$
        begin raise exception 'fixture receipt fault'; end $$;
        create trigger fixture_fail_release before insert on public.clued_audit_receipts
        for each row when (new.operation='work_claim_release') execute function clued_private.fixture_fail_release()`);
      try {
        assert.deepEqual(await event(input(51)), { status: 'ok', finished: 1, released: [] });
        assert.equal(await binding(51), 'merged');
        assert.equal((await state(r.claim.claim_id)).status, 'ACTIVE');
        assert.deepEqual(await receipts(r.claim.claim_id), []);
        assert.ok(notices.some(message => message.includes('work_claim_pr_end_release_skipped')));
      } finally {
        await admin.query('drop trigger fixture_fail_release on public.clued_audit_receipts; drop function clued_private.fixture_fail_release()');
      }
    });
  } finally {
    for (const client of clients.reverse()) await client.end();
    const pid = server.process?.pid;
    await stopCluster(server);
    assert.ok(await waitForPidExit(pid));
  }
});
