import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';

// Work Claim Admission v0.1, step 7 review fixes (migration
// 20261002050000_work_claims_admission_hardening): glob-against-glob conflicts
// and one pull request per claim.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uuid = () => crypto.randomUUID();
const hash = () => crypto.randomBytes(32).toString('hex');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

test('work claims hardening: glob/glob overlap and pull request binding',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-work-claims-hardening-'));
  const server = new EmbeddedPostgres({
    databaseDir: directory, user: 'postgres', password: hash(), port: await freePort(),
    persistent: false, postgresFlags: ['-c', 'io_method=sync'],
    onLog() {}, onError(message) { process.stderr.write(`${message}\n`); },
  });
  const clients = [];
  try {
    await server.initialise();
    await server.start();
    const admin = server.getPgClient();
    clients.push(admin);
    await admin.connect();
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
    for (const name of (await fs.readdir(path.join(root, 'supabase/migrations')))
      .filter((name) => name.endsWith('.sql')).sort()) {
      try { await admin.query(await fs.readFile(path.join(root, 'supabase/migrations', name), 'utf8')); }
      catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
    }

    // --- Glob intersection, pairwise. Overlap must be found whenever one
    // path can match both; disjoint pairs stay disjoint. ---
    const intersects = async (a, b) => (await admin.query(
      'select clued_private.work_claim_globs_intersect($1,$2) v', [a, b])).rows[0].v;
    const overlapping = [
      ['apps/clued-cloud/**', '**/package-lock.json'], // the #443/#444 lockfile case
      ['apps/*/foo.ts', 'apps/x/*.ts'],
      ['src/**', 'src'],
      ['src/**', 'src/a/b/c.ts'],
      ['**', 'anything/at/all'],
      ['a/**/z', 'a/*/z'],
      ['a/**/z', 'a/z'],
      ['docs/v*.md', 'docs/*1.md'],
      ['x/**/y/*.ts', 'x/p/q/y/r.ts'],
      ['lib/foo**', 'lib/foobar/baz.js'], // "**" inside a segment crosses "/"
    ];
    const disjoint = [
      ['apps/a/**', 'apps/b/**'],
      ['docs/*.md', 'docs/*.txt'],
      ['src/*.ts', 'src/sub/x.ts'],
      ['a/*/z', 'a/z'],
      ['v1*.md', 'w*.md'],
      ['one/two', 'one/three'],
    ];
    for (const [a, b] of overlapping) {
      assert.equal(await intersects(a, b), true, `${a} ∩ ${b}`);
      assert.equal(await intersects(b, a), true, `${b} ∩ ${a}`);
    }
    for (const [a, b] of disjoint) {
      assert.equal(await intersects(a, b), false, `${a} ∩ ${b}`);
      assert.equal(await intersects(b, a), false, `${b} ∩ ${a}`);
    }
    // Agreement with the old one-sided rule on every literal path it covers.
    for (const [glob, file] of [['apps/clued-cloud/**', 'apps/clued-cloud/package.json'],
      ['docs/*.md', 'docs/a.md'], ['src/**', 'src']]) {
      const covered = (await admin.query('select clued_private.work_claim_path_covered($1,array[$2]) v',
        [file, glob])).rows[0].v;
      assert.equal(covered, true);
      assert.equal(await intersects(glob, file), true);
    }

    const userId = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'hardening@example.invalid',now())`, [userId]);
    const tokens = {};
    for (const [name, scopes] of [
      ['A', ['context:read', 'context:write']], ['B', ['context:read', 'context:write']],
      ['verifier', ['context:read']],
    ]) {
      tokens[name] = hash();
      await admin.query(`insert into public.clued_agent_bindings
        (user_id,vendor,agent_name,token_hash,scopes,context_keys)
        values($1,'synthetic',$2,$3,$4,array['*'])`, [userId, name, tokens[name], scopes]);
    }
    const connect = async () => {
      const client = server.getPgClient();
      clients.push(client);
      await client.connect();
      await client.query('set role anon');
      return client;
    };
    const anon = await connect();
    const anon2 = await connect();
    const rpc = async (client, token, name, input) =>
      (await client.query(`select public.${name}($1,$2) value`, [token, input])).rows[0].value;
    const call = (token, name, input) => rpc(anon, token, name, input);
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const createTask = async (title) => committed(await call(tokens.A, 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'work claim hardening fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = (token, input) => call(token, 'clued_work_claim_v1', { scope: 'global', idempotency_key: uuid(), ...input });
    const release = (token, c) => call(token, 'clued_work_release_v1', {
      scope: 'global', claim_id: c.claim_id, fence: c.fence, outcome: 'abandoned' });
    const verify = (input, client = anon) => rpc(client, tokens.verifier, 'clued_work_verify_v1', { scope: 'global', ...input });

    // --- Glob/glob conflicts reach the claim RPC. ---
    const lock = committed(await claim(tokens.A, { task_id: await createTask('lockfile A'),
      write_set: ['apps/clued-cloud/**'] })).claim;
    const lockfile = await claim(tokens.B, { task_id: await createTask('lockfile B'), write_set: ['**/package-lock.json'] });
    assert.equal(lockfile.error_code, 'work_claim_conflict', JSON.stringify(lockfile));
    assert.equal(lockfile.conflicts[0].claim_id, lock.claim_id);
    assert.deepEqual(lockfile.conflicts[0].overlap.paths, ['**/package-lock.json', 'apps/clued-cloud/**']);
    committed(await release(tokens.A, lock));
    const star = committed(await claim(tokens.A, { task_id: await createTask('star A'), write_set: ['apps/*/foo.ts'] })).claim;
    assert.equal((await claim(tokens.B, { task_id: await createTask('star B'), write_set: ['apps/x/*.ts'] })).error_code,
      'work_claim_conflict');
    const apart = committed(await claim(tokens.B, { task_id: await createTask('star C'), write_set: ['apps/x/*.md'] })).claim;
    committed(await release(tokens.A, star));
    committed(await release(tokens.B, apart));
    // Renewal with a wider write set is re-checked the same way.
    const left = committed(await claim(tokens.A, { task_id: await createTask('renew A'), write_set: ['pkg/a/**'] })).claim;
    const right = committed(await claim(tokens.B, { task_id: await createTask('renew B'), write_set: ['pkg/b/x.ts'] })).claim;
    const widened = await call(tokens.B, 'clued_work_renew_v1', { scope: 'global', claim_id: right.claim_id,
      fence: right.fence, lease_version: right.lease_version, progress_ref: 'p1', write_set: ['pkg/*/x.ts'] });
    assert.equal(widened.error_code, 'work_claim_conflict', JSON.stringify(widened));
    committed(await release(tokens.A, left));
    committed(await release(tokens.B, right));

    // --- One pull request per claim. ---
    const taskPr = await createTask('bound to one PR');
    const bound = committed(await claim(tokens.A, { task_id: taskPr, write_set: ['web/**'] })).claim;
    assert.equal(bound.bound_pr, null);
    const receipts = async () => (await admin.query(`select count(*)::int n from public.clued_audit_receipts
      where operation='work_claim_bind_pr' and object_id=$1`, [bound.claim_id])).rows[0].n;
    // A failing verify does not bind.
    let v = await verify({ claim_id: bound.claim_id, changed_paths: ['api/x.ts'], pr_ref: 'o/r#9' });
    assert.deepEqual([v.verdict, v.reasons, v.bound_pr], ['REJECTED', ['paths_outside_write_set'], null]);
    // Without pr_ref nothing changes (the MCP tool's call).
    v = await verify({ claim_id: bound.claim_id, changed_paths: ['web/a.ts'] });
    assert.deepEqual([v.verdict, v.bound_pr], ['ADMITTED', null]);
    assert.equal(await receipts(), 0);
    // The first admitting verify with a pr_ref binds; the same PR stays admitted.
    v = await verify({ claim_id: bound.claim_id, changed_paths: ['web/a.ts'], pr_ref: 'o/r#1', head_sha: 'abc1234' });
    assert.deepEqual([v.verdict, v.bound_pr, v.claim.bound_pr], ['ADMITTED', 'o/r#1', 'o/r#1']);
    v = await verify({ claim_id: bound.claim_id, changed_paths: ['web/b.ts'], pr_ref: 'o/r#1' });
    assert.equal(v.verdict, 'ADMITTED');
    assert.equal(await receipts(), 1);
    // Any other PR naming the same claim is rejected, with or without other faults.
    v = await verify({ claim_id: bound.claim_id, changed_paths: ['web/a.ts'], pr_ref: 'o/r#2' });
    assert.deepEqual([v.verdict, v.reasons, v.bound_pr], ['REJECTED', ['claim_bound_to_other_pr'], 'o/r#1']);
    v = await verify({ claim_id: bound.claim_id, changed_paths: ['api/x.ts'], pr_ref: 'other/repo#1' });
    assert.deepEqual(v.reasons, ['paths_outside_write_set', 'claim_bound_to_other_pr']);
    assert.equal(await receipts(), 1);
    // Malformed pr_ref raises instead of silently not binding.
    for (const bad of ['', '#1', 'o/r', 'o/r#x', 'o r/x#1', 'o/r#12345678901']) {
      await assert.rejects(() => verify({ claim_id: bound.claim_id, pr_ref: bad }), /work_claim_pr_ref_invalid/, bad);
    }
    // A takeover starts unbound.
    await admin.query(`update clued_private.work_claims_v1 set issued_at=clock_timestamp()-interval '3 hours',
      expires_at=clock_timestamp()-interval '1 second' where claim_id=$1`, [bound.claim_id]);
    const taken = committed(await call(tokens.B, 'clued_work_takeover_v1', { scope: 'global',
      claim_id: bound.claim_id, idempotency_key: uuid() })).claim;
    assert.equal(taken.bound_pr, null);
    v = await verify({ claim_id: taken.claim_id, changed_paths: ['web/a.ts'], pr_ref: 'o/r#2' });
    assert.deepEqual([v.verdict, v.bound_pr], ['ADMITTED', 'o/r#2']);
    committed(await release(tokens.B, taken));

    // Two PRs verified at the same moment: exactly one binds.
    for (let round = 0; round < 5; round += 1) {
      const c = committed(await claim(tokens.A, { task_id: await createTask(`race ${round}`), write_set: [`race/${round}/**`] })).claim;
      const answers = await Promise.all([
        verify({ claim_id: c.claim_id, changed_paths: [`race/${round}/a`], pr_ref: `o/r#${100 + round}` }),
        verify({ claim_id: c.claim_id, changed_paths: [`race/${round}/a`], pr_ref: `o/r#${200 + round}` }, anon2),
      ]);
      const admitted = answers.filter((a) => a.verdict === 'ADMITTED');
      assert.equal(admitted.length, 1, `round ${round}: ${JSON.stringify(answers)}`);
      const refused = answers.find((a) => a.verdict === 'REJECTED');
      assert.deepEqual(refused.reasons, ['claim_bound_to_other_pr']);
      assert.equal(refused.bound_pr, admitted[0].pr_ref);
      committed(await release(tokens.A, c));
    }

    // The column is not writable through the client role, and verify is
    // still the only anon entry that touches it.
    await assert.rejects(() => anon.query('update clued_private.work_claims_v1 set bound_pr=null'), /permission denied/);
    await assert.rejects(() => anon.query("select clued_private.work_claim_globs_intersect('a','a')"), /permission denied/);
  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await server.stop().catch(() => {});
  }
});
