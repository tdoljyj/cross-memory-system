import { stopCluster } from './cluster-cleanup.mjs';
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
const repository = path.resolve(cloud, '../..');
const policy = JSON.parse(await fs.readFile(path.join(repository, 'config/clued-mechanical-files.json'), 'utf8'));
const scope = policy.context_keys[0];
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');
const artifacts = policy.mechanical_paths.map(p => p.endsWith('/**') ? p.slice(0, -2) + 'components.ts' : p);

async function freePort() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

test('mechanical files do not serialize independent source claims or widen source authority',
  { timeout: 300000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-mech-'));
  const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: hash(),
    port: await freePort(), persistent: false, postgresFlags: ['-c', 'io_method=sync'],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
  const clients = [];
  try {
    await server.initialise(); await server.start();
    const admin = server.getPgClient(); clients.push(admin); await admin.connect();
    await admin.query(`create role anon nologin; create role authenticated nologin;
      create role service_role nologin bypassrls; create role authenticator nologin noinherit;
      create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
        banned_until timestamptz,deleted_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql stable as
        $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      grant usage on schema auth,extensions to anon,authenticated,service_role;
      grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
    for (const name of (await fs.readdir(path.join(cloud, 'supabase/migrations'))).filter(n => n.endsWith('.sql')).sort()) {
      try { await admin.query(await fs.readFile(path.join(cloud, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }
    await allowRawTestBindings(admin);
    const user = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'mechanical@example.invalid',now())`, [user]);
    await admin.query(`insert into public.clued_projects
      (id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at,progress_status)
      values($1,$2,'Mechanical test','mechanical test',$3,'confirmed',now(),'active')`,
      [scope.slice('project:'.length), user, scope]);
    const tokens = { A: hash(), B: hash(), verifier: hash() };
    const bindingIds = {};
    for (const [name, token] of Object.entries(tokens)) {
      const createdBinding = await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*']) returning id`,
        [user, name, token, name === 'verifier' ? ['context:read'] : ['context:read', 'context:write']]);
      bindingIds[name] = createdBinding.rows[0].id;
    }
    const ciBinding = bindingIds.verifier;
    const ciReceipt = (await admin.query(`insert into public.clued_audit_receipts
      (user_id,context_key,operation,object_type,object_id,version,metadata,status)
      values($1,$2,'fixture_role','binding',$3,1,'{}','committed') returning id`, [user, scope, ciBinding])).rows[0].id;
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      values($1,$2,'ci-admission',clock_timestamp(),$3)`, [user, ciBinding, ciReceipt]);
    await admin.query('update clued_private.work_claim_execution_policy_v1 set activated_at=clock_timestamp(),qualification_commit=$1', ['f'.repeat(40)]);
    const anon = server.getPgClient(); clients.push(anon); await anon.connect(); await anon.query('set role anon');
    const gateway = server.getPgClient(); clients.push(gateway); await gateway.connect(); await setWorkerGatewayCaller(gateway);
    const native = server.getPgClient(); clients.push(native); await native.connect(); await native.query('set role authenticated');
    const ownerJwt = { sub: user, role: 'authenticated', session_id: 'mechanical-owner-session', aal: 'aal1',
      amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] };
    await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
      [user, JSON.stringify(ownerJwt)]);
    const call = async (token, name, input) => CI_SIGNATURES.includes(name + '(text,jsonb)')
      ? (await anon.query(`select public.${name}($1,$2) value`, [token, input])).rows[0].value
      : workerGatewayRpc(gateway, name, token, input);
    const committed = r => { assert.equal(r.status, 'committed', JSON.stringify(r)); return r; };
    const createTask = async (title, context = scope) => committed(await call(tokens.A, 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: context, idempotency_key: uuid(), authority: 'observed', confidence_reason: 'mechanical fixture',
      source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = (token, task, write_set, extra = {}) => call(token, 'clued_work_claim_v1', {
      scope, task_id: task, write_set, holder_session_ref: uuid(), holder_label: 'Mechanical fixture',
      idempotency_key: uuid(), ...extra });
    const release = async (token, r, context = scope) => {
      if (r.status === 'committed') committed(await call(token, 'clued_work_release_v1', {
        scope: context, claim_id: r.claim.claim_id, fence: r.claim.fence,
        lease_key: r.lease_key, outcome: 'abandoned' }));
    };
    const verify = (claimId, changed_paths, context = scope, extra = {}) => call(tokens.verifier, 'clued_work_verify_v1', {
      scope: context, claim_id: claimId, changed_paths, ...extra });
    const authorize = (r, subject) => call(tokens.A, 'clued_work_renew_v1', {
      action: 'authorize_head', scope, claim_id: r.claim.claim_id, fence: r.claim.fence,
      lease_version: r.claim.lease_version, lease_key: r.lease_key, progress_ref: 'head:' + subject.head_sha,
      repository: policy.repository, head_sha: subject.head_sha, target_branch: subject.target_branch,
      pr_ref: subject.pr_ref, idempotency_key: uuid() });
    const protect = async r => {
      // Use the real account-confirmed handover, exactly as the existing
      // handover execution fixture does. It drains, issues the new key and
      // completes pending state; directly flipping a column is not equivalent.
      const preview = (await native.query('select public.clued_work_claim_handover_confirmation_issue_v1($1::jsonb) value',
        [{ claim_id: r.claim.claim_id }])).rows[0].value;
      assert.equal(preview.status, 'issued');
      const moved = (await native.query('select public.clued_work_claim_handover_v1($1::jsonb) value',
        [{ confirmation_token: preview.confirmation_token, view_digest: preview.view_digest }])).rows[0].value;
      assert.equal(moved.status, 'committed');
      assert.equal(moved.claim.lease_key_required, true);
      assert.equal(moved.claim.execution_handover_pending, false);
      return { ...r, claim: moved.claim, lease_key: moved.lease_key };
    };

    await t.test('two different source edits sharing generated files can both claim', async () => {
      const a = await claim(tokens.A, await createTask('left'), ['src/left/**', ...policy.mechanical_paths]);
      const b = await claim(tokens.B, await createTask('right'), ['src/right/**', ...policy.mechanical_paths]);
      try { committed(a); committed(b); }
      finally { await release(tokens.B, b); await release(tokens.A, a); }
    });
    await t.test('same source path and same trigger remain conflicts', async () => {
      const aTask = await createTask('same source A');
      const a = committed(await claim(tokens.A, aTask, ['src/shared/**', ...policy.mechanical_paths], { trigger_refs: ['issue:shared'] }));
      try {
        for (const input of [
          { task: await createTask('same source B'), paths: ['src/shared/x.ts'] },
          { task: await createTask('same trigger B'), paths: ['src/other/**'], trigger_refs: ['issue:shared'] },
          { task: aTask, paths: ['src/unrelated/**'] },
        ]) {
          const r = await claim(tokens.B, input.task, input.paths, { trigger_refs: input.trigger_refs ?? [] });
          assert.equal(r.error_code, 'work_claim_conflict', JSON.stringify(r));
        }
      } finally { await release(tokens.A, a); }
    });
    await t.test('typed qualified repository outputs are exempt, broad source ownership is not', async () => {
      const typed = policy.mechanical_paths.map(p => `repo:${policy.repository}/${p}`);
      const a = await claim(tokens.A, await createTask('typed qualified A'), ['src/typed-left/**', ...typed]);
      const b = await claim(tokens.B, await createTask('typed qualified B'), ['src/typed-right/**', ...typed]);
      try { committed(a); committed(b); }
      finally { await release(tokens.B, b); await release(tokens.A, a); }
      const c = committed(await claim(tokens.A, await createTask('broad source A'), ['apps/**']));
      const d = await claim(tokens.B, await createTask('broad source B'), ['apps/clued-cloud/**']);
      try { assert.equal(d.error_code, 'work_claim_conflict'); }
      finally { await release(tokens.B, d); await release(tokens.A, c); }
    });
    await t.test('only exact CI byte-proven mechanical changes receive a coverage exemption', async () => {
      const a = await protect(committed(await claim(tokens.A, await createTask('coverage'), ['src/covered/**'])));
      const subject = { pr_ref: `${policy.repository}#17`, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), target_branch: 'main' };
      const proven = { ...subject, mechanical_paths_proven: artifacts };
      try {
        const unproven = await verify(a.claim.claim_id, ['src/covered/a.ts', ...artifacts]);
        assert.equal(unproven.verdict, 'REJECTED', 'file names alone prove neither runtime nor configuration edits mechanical');
        assert.deepEqual(unproven.paths_outside_write_set, artifacts.toSorted());
        const missingHeadGrant = await verify(a.claim.claim_id, artifacts, scope, proven);
        assert.equal(missingHeadGrant.verdict, 'REJECTED');
        assert.ok(missingHeadGrant.reasons.includes('head_authorization_required'));
        const wrongKey = await authorize({ ...a, lease_key: 'clued_lk_' + '0'.repeat(64) }, subject);
        assert.equal(wrongKey.error_code, 'work_claim_lease_key_invalid');
        committed(await authorize(a, subject));
        assert.equal((await verify(a.claim.claim_id, ['src/covered/a.ts', ...artifacts], scope, proven)).verdict, 'ADMITTED');
        const unauthorizedHead = await verify(a.claim.claim_id, artifacts, scope, { ...proven, head_sha: 'e'.repeat(40) });
        assert.equal(unauthorizedHead.verdict, 'REJECTED');
        assert.ok(unauthorizedHead.reasons.includes('head_authorization_required'));
        const outside = await verify(a.claim.claim_id, ['src/outside.ts', ...artifacts], scope, proven);
        assert.equal(outside.verdict, 'REJECTED');
        assert.deepEqual(outside.paths_outside_write_set, ['src/outside.ts']);
        assert.ok(outside.reasons.includes('paths_outside_write_set'));
        assert.equal((await verify(uuid(), artifacts)).verdict, 'REJECTED', 'mechanical-only changes need a real claim');
        const otherRepository = (await admin.query('select clued_private.work_claim_verify_before_execution_v1($1,$2::jsonb) value',
          [tokens.verifier, JSON.stringify({ scope, claim_id: a.claim.claim_id, changed_paths: artifacts, pr_ref: 'other/repo#1' })])).rows[0].value;
        assert.equal(otherRepository.verdict, 'REJECTED');
        assert.ok(otherRepository.reasons.includes('paths_outside_write_set'), 'a qualified project does not exempt a different target repository');
      } finally { await release(tokens.A, a); }
      assert.equal((await verify(a.claim.claim_id, artifacts, scope, proven)).verdict, 'REJECTED', 'released claim stays rejected');
      const covered = committed(await claim(tokens.A, await createTask('explicit runtime coverage'), ['config/clued-components.json']));
      try { assert.equal((await verify(covered.claim.claim_id, ['config/clued-components.json'])).verdict, 'ADMITTED', 'unproven edits may instead use normal full write-set coverage'); }
      finally { await release(tokens.A, covered); }
    });
    await t.test('forged or malformed mechanical proofs fail before binding or CI head metering', async () => {
      const a = committed(await claim(tokens.A, await createTask('proof negatives'), ['src/proof/**']));
      const input = { scope, claim_id: a.claim.claim_id, changed_paths: [artifacts[0]],
        pr_ref: `${policy.repository}#18`, head_sha: 'c'.repeat(40), base_sha: 'd'.repeat(40),
        target_branch: 'main', mechanical_paths_proven: [artifacts[0]] };
      try {
        const forged = await call(tokens.A, 'clued_work_verify_v1', input);
        assert.equal(forged.verdict, 'REJECTED');
        assert.deepEqual(forged.reasons, ['ci_binding_required']);
        for (const wrong of [
          { mechanical_paths_proven: [artifacts[1]] },
          { mechanical_paths_proven: ['src/proof/a.ts'], changed_paths: ['src/proof/a.ts'] },
          { mechanical_paths_proven: null },
          { mechanical_paths_proven: [42] },
          { head_sha: 'c'.repeat(7) },
          { base_sha: undefined },
          { pr_ref: 'other/repo#18' },
          { scope: 'global' },
          { changed_paths: undefined },
        ]) {
          const invalid = await call(tokens.verifier, 'clued_work_verify_v1', { ...input, ...wrong });
          assert.equal(invalid.verdict, 'REJECTED');
          assert.deepEqual(invalid.reasons, ['mechanical_paths_proof_invalid']);
        }
        const untouched = (await admin.query('select bound_pr,cardinality(admitted_heads) heads from clued_private.work_claims_v1 where claim_id=$1', [a.claim.claim_id])).rows[0];
        assert.deepEqual(untouched, { bound_pr: null, heads: 0 });
      } finally { await release(tokens.A, a); }
    });
    await t.test('unqualified context and other repositories retain original conflicts and coverage', async () => {
      const a = committed(await claim(tokens.A, await createTask('global A', 'global'), ['config/clued-components.json'], { scope: 'global' }));
      const b = await claim(tokens.B, await createTask('global B', 'global'), ['config/clued-components.json'], { scope: 'global' });
      try { assert.equal(b.error_code, 'work_claim_conflict'); }
      finally { await release(tokens.B, b, 'global'); await release(tokens.A, a, 'global'); }
      const c = committed(await claim(tokens.A, await createTask('other repo A'), ['repo:other/repo/config/clued-components.json']));
      const d = await claim(tokens.B, await createTask('other repo B'), ['repo:other/repo/config/clued-components.json']);
      try { assert.equal(d.error_code, 'work_claim_conflict'); }
      finally { await release(tokens.B, d); await release(tokens.A, c); }
      const e = committed(await claim(tokens.A, await createTask('global coverage', 'global'), ['src/covered/**'], { scope: 'global' }));
      try { assert.equal((await verify(e.claim.claim_id, artifacts, 'global')).verdict, 'REJECTED'); }
      finally { await release(tokens.A, e, 'global'); }
      const f = committed(await claim(tokens.A, await createTask('cross context qualified'), ['config/clued-components.json']));
      const g = await claim(tokens.B, await createTask('cross context global', 'global'), ['config/clued-components.json'], { scope: 'global' });
      try { assert.equal(g.error_code, 'work_claim_conflict'); }
      finally { await release(tokens.B, g, 'global'); await release(tokens.A, f); }
    });
    await t.test('Native policy exactly matches the canonical source, with private helper ACLs', async () => {
      const native = (await admin.query('select clued_private.work_claim_mechanical_policy_v1() value')).rows[0].value;
      assert.deepEqual(native, policy);
      await assert.rejects(() => anon.query('select clued_private.work_claim_mechanical_policy_v1()'), /permission denied/);
      await assert.rejects(() => anon.query("select clued_private.work_claim_mechanical_path_v1('config/clued-components.json',$1)", [scope]), /permission denied/);
      await assert.rejects(() => anon.query('select clued_private.work_claim_mechanical_proof_error_v1(null,null)'), /permission denied/);
      // The primitive glob matcher remains a generic matcher: exemption is
      // applied only at qualified claim/verify consumers, never storage gates.
      assert.equal((await admin.query("select clued_private.work_claim_path_covered('config/clued-components.json', array['unrelated']) value")).rows[0].value, false);
      assert.notDeepEqual((await admin.query("select clued_private.work_claim_paths_overlap(array['apps/**'],array['apps/clued-cloud/**']) value")).rows[0].value, []);
    });
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
