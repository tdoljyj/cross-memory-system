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
import { CI_SIGNATURES, setWorkerGatewayCaller, workerGatewayRpc, findGatewayCloseoutMigration, snapshotCallerCatalog, assertGatewayCloseoutBoundary, replayGatewayCloseout } from './worker-gateway-caller-fixture.mjs';

// Generic Work Claim v0.1, rollout step 1 (migration
// 20261002210000_work_claims_resource_kinds; GenericWorkClaim.v0.1.md §2):
// typed resources "kind:value" in write_set, registered kinds only, overlap
// judged per kind, bare-path write sets judged exactly as in v1.

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

test('work claims: typed resources, registered kinds and per-kind overlap',
  { timeout: 300000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-work-claims-kinds-'));
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
    await allowRawTestBindings(admin);

    // --- Normalization. ---
    const normalize = async (entries) => (await admin.query(
      'select clued_private.work_claim_normalize_paths($1::jsonb) v', [JSON.stringify(entries)])).rows[0].v;
    assert.deepEqual(await normalize(['apps/x', 'Storage:/c1//docs/**/', 'REPO:o/n/apps/**', './apps/x']),
      ['apps/x', 'repo:o/n/apps/**', 'storage:c1/docs/**']);
    assert.deepEqual(await normalize(['record:52739939-a719-4819-b81b-05339f0ffea9']),
      ['record:52739939-a719-4819-b81b-05339f0ffea9']);
    // Unregistered kinds are refused, also where a bare root file would carry a colon.
    for (const entry of ['calendar:team/2026-10-02', 'ab:foo', 'x-y:z']) {
      await assert.rejects(() => normalize([entry]), /work_claim_resource_kind_unknown/, entry);
    }
    // The value follows the path rules.
    for (const entry of ['storage:', 'storage:/', 'storage:a/../b', 'repo:o/n/a b', `storage:${'a'.repeat(400)}`]) {
      await assert.rejects(() => normalize([entry]), /work_claim_write_set_invalid/, entry);
    }
    // A colon later in a bare path is not a kind, and a single letter is a drive.
    assert.deepEqual(await normalize(['docs/a:b.md']), ['docs/a:b.md']);
    assert.deepEqual(await normalize(['C:/Clued/M2Isolation/**', 'c:foo']), ['C:/Clued/M2Isolation/**', 'c:foo']);

    // --- Overlap per kind. ---
    const overlap = async (a, b) => (await admin.query(
      'select clued_private.work_claim_paths_overlap($1,$2) v', [a, b])).rows[0].v;
    const cases = [
      // Same kind: the v1 path rules on the values.
      [['storage:c1/docs/**'], ['storage:c1/docs/a.md'], ['storage:c1/docs/**', 'storage:c1/docs/a.md']],
      [['storage:c1/a/**'], ['storage:c2/a/**'], []],
      [['storage:c1/*/x.md'], ['storage:c1/p/*.md'], ['storage:c1/*/x.md', 'storage:c1/p/*.md']],
      [['record:r1'], ['record:r1'], ['record:r1']],
      [['record:r1'], ['record:r2'], []],
      // Different kinds never overlap, a bare "**" included.
      [['storage:c1/**'], ['record:r1'], []],
      [['**'], ['storage:c1/x'], []],
      [['**'], ['record:r1'], []],
      // Bare paths against repo: compare the path part, whatever the repository.
      [['apps/**'], ['repo:o/n/apps/x.ts'], ['apps/**', 'repo:o/n/apps/x.ts']],
      [['apps/**'], ['repo:o/n/docs/x.md'], []],
      [['docs/y.md'], ['repo:*/n/x'], ['docs/y.md', 'repo:*/n/x']],
      [['docs/y.md'], ['repo:o/n'], ['docs/y.md', 'repo:o/n']],
      // repo: against repo: compares the full value, so other repositories are apart.
      [['repo:o/a/x'], ['repo:o/b/x'], []],
      [['repo:o/*/x'], ['repo:o/b/x'], ['repo:o/*/x', 'repo:o/b/x']],
      // Drive paths stay bare paths (bare-only sets: the v1 result lists the covered entry).
      [['C:/Clued/**'], ['C:/Clued/M2Isolation/x'], ['C:/Clued/M2Isolation/x']],
      [['c:/a/**'], ['storage:c/a/x'], []],
      // Mixed sets: only the intersecting entries are listed.
      [['apps/**', 'storage:c1/a'], ['storage:c1/**', 'docs/z'], ['storage:c1/**', 'storage:c1/a']],
    ];
    for (const [a, b, expected] of cases) {
      assert.deepEqual(await overlap(a, b), expected, `${a} ∩ ${b}`);
      assert.deepEqual(await overlap(b, a), expected, `${b} ∩ ${a}`);
    }
    // Bare-only sets: identical to the v1 result (covered entries win over intersecting ones).
    for (const [a, b] of [
      [['apps/clued-cloud/**'], ['**/package-lock.json']],
      [['src/**', 'docs/a.md'], ['src/x.ts', 'docs/*.md', 'lib/**']],
      [['a/*/z'], ['a/z']],
    ]) {
      const v1 = (await admin.query('select clued_private.work_claim_bare_overlap($1,$2) v', [a, b])).rows[0].v;
      assert.deepEqual(await overlap(a, b), v1, `${a} ∩ ${b}`);
    }
    assert.deepEqual(await overlap(['apps/clued-cloud/**'], ['**/package-lock.json']),
      ['**/package-lock.json', 'apps/clued-cloud/**']);

    // --- Through the claim RPCs. ---
    const userId = uuid();
    await admin.query(`insert into auth.users(id,email,email_confirmed_at)
      values($1,'kinds@example.invalid',now())`, [userId]);
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
    const anon = server.getPgClient();
    clients.push(anon);
    await anon.connect();
    await anon.query('set role anon');
    const workerCaller = server.getPgClient();
    clients.push(workerCaller);
    await workerCaller.connect();
    await setWorkerGatewayCaller(workerCaller);
    const call = async (token, name, input) =>
      CI_SIGNATURES.includes(name + '(text,jsonb)')
        ? (await anon.query(`select public.${name}($1,$2) value`, [token,input])).rows[0].value
        : await workerGatewayRpc(workerCaller, name, token, input);
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const createTask = async (title) => committed(await call(tokens.A, 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'resource kinds fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const claim = (token, input) => call(token, 'clued_work_claim_v1', {
      scope: 'global', idempotency_key: uuid(), holder_session_ref: uuid(), ...input });
    const release = (token, c) => call(token, 'clued_work_release_v1', {
      scope: 'global', claim_id: c.claim_id, fence: c.fence, outcome: 'abandoned' });
    const verify = (input) => call(tokens.verifier, 'clued_work_verify_v1', { scope: 'global', ...input });

    // Two Agents on the same storage folder conflict; the holder is named.
    const contracts = committed(await claim(tokens.A, { task_id: await createTask('contracts A'),
      write_set: ['storage:c1/客户/合同/**'] })).claim;
    assert.deepEqual(contracts.write_set, ['storage:c1/客户/合同/**']);
    const clash = await claim(tokens.B, { task_id: await createTask('contracts B'),
      write_set: ['Storage:c1/客户/合同/a.md'] });
    assert.equal(clash.error_code, 'work_claim_conflict', JSON.stringify(clash));
    assert.equal(clash.conflicts[0].claim_id, contracts.claim_id);
    assert.deepEqual(clash.conflicts[0].overlap.paths, ['storage:c1/客户/合同/**', 'storage:c1/客户/合同/a.md']);
    // Another folder, another kind, and a bare "**" do not conflict with it.
    const other = committed(await claim(tokens.B, { task_id: await createTask('reports B'),
      write_set: ['storage:c1/客户/报告/**', 'record:r1'] })).claim;
    const everything = committed(await claim(tokens.B, { task_id: await createTask('repo B'), write_set: ['**'] })).claim;
    // A bare repository claim and a repo: claim on the same path conflict.
    const repoTyped = await claim(tokens.A, { task_id: await createTask('repo A'),
      write_set: ['repo:tdoljyj/cross-memory-system/apps/**'] });
    assert.equal(repoTyped.error_code, 'work_claim_conflict', JSON.stringify(repoTyped));
    assert.equal(repoTyped.conflicts[0].claim_id, everything.claim_id);
    // Renewal re-checks typed resources too.
    const widened = await call(tokens.B, 'clued_work_renew_v1', { scope: 'global', claim_id: other.claim_id,
      fence: other.fence, lease_version: other.lease_version, progress_ref: 'p1', write_set: ['storage:c1/客户/**'] });
    assert.equal(widened.error_code, 'work_claim_conflict', JSON.stringify(widened));
    // Unknown kinds are refused at claim time.
    const calendarTask = await createTask('calendar A');
    await assert.rejects(() => claim(tokens.A, { task_id: calendarTask,
      write_set: ['calendar:team/standup'] }), /work_claim_resource_kind_unknown/);

    // Verify stays literal: a bare changed path is covered only by bare entries.
    committed(await release(tokens.B, everything));
    const typedRepo = committed(await claim(tokens.A, { task_id: await createTask('typed repo verify'),
      write_set: ['repo:o/n/web/**'] })).claim;
    let v = await verify({ claim_id: typedRepo.claim_id, changed_paths: ['web/a.ts'] });
    assert.deepEqual([v.verdict, v.reasons], ['REJECTED', ['paths_outside_write_set']]);
    const bareRepo = committed(await claim(tokens.B, { task_id: await createTask('bare repo verify'),
      write_set: ['api/**'] })).claim;
    v = await verify({ claim_id: bareRepo.claim_id, changed_paths: ['api/a.ts'] });
    assert.equal(v.verdict, 'ADMITTED');

    for (const [token, c] of [[tokens.A, contracts], [tokens.B, other], [tokens.A, typedRepo], [tokens.B, bareRepo]]) {
      committed(await release(token, c));
    }

    // The registry and helpers are not reachable from client roles.
    await assert.rejects(() => anon.query('select * from clued_private.work_claim_resource_kinds'), /permission denied/);
    await assert.rejects(() => anon.query("select clued_private.work_claim_resources_intersect('a','a')"), /permission denied/);
    // The real formal migration is installed by the full chain and replays
    // unchanged after the original business/concurrency/negative matrix.
    const closeoutMigration = await findGatewayCloseoutMigration(root);
    const closeoutBefore = await snapshotCallerCatalog(admin);
    await replayGatewayCloseout(admin, await fs.readFile(path.join(root, 'supabase/migrations', closeoutMigration), 'utf8'));
    assert.deepEqual(await snapshotCallerCatalog(admin), closeoutBefore, 'formal closeout replay preserves definitions and caller ACLs');
    await assertGatewayCloseoutBoundary(admin);

  } finally {
    for (const client of clients.reverse()) await client.end().catch(() => {});
    await stopCluster(server);
  }
});
