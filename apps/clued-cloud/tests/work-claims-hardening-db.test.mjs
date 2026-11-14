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

// Work Claim Admission v0.1, step 7 review fixes (migration
// 20261002050000_work_claims_admission_hardening): glob-against-glob conflicts
// and one pull request per claim; the concurrency caps (20261002060001); and
// the MINOR fixes (20261002072000): trigger-ref matching, idempotency keys,
// repeated progress and "**/" at the root; and the count caps
// (20261002100000): attempts per Task per 24 hours, heads per claim, with
// retry_after corrected in 20261002150000.

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
    await allowRawTestBindings(admin);

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
    // The verifier is the CI admission Binding, as in production (Owner
    // Decision 38ddb8cf): only it observes a PR and activates its PR -> Task
    // relation (20261108161615).
    const verifierId = (await admin.query("select id from public.clued_agent_bindings where user_id=$1 and agent_name='verifier'", [userId])).rows[0].id;
    const roleReceipt = (await admin.query(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,version,metadata,status)
      values($1,'global','fixture_role','binding',$2,1,'{}','committed') returning id`, [userId, verifierId])).rows[0].id;
    await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id)
      values($1,$2,'ci-admission',now(),$3)`, [userId, verifierId, roleReceipt]);
    const connect = async () => {
      const client = server.getPgClient();
      clients.push(client);
      await client.connect();
      await client.query('set role anon');
      return client;
    };
    const anon = await connect();
    // A distinct GW connection for each original transport preserves real
    // concurrent transactions; CI and permission-negative callers stay anon.
    const workerClients = new Map();
    const workerClient = async (transport) => {
      if (!workerClients.has(transport)) workerClients.set(transport, (async () => {
        const client = server.getPgClient(); clients.push(client);
        await client.connect(); await setWorkerGatewayCaller(client); return client;
      })());
      return await workerClients.get(transport);
    };
    const rpc = async (client, token, name, input) =>
      CI_SIGNATURES.includes(name + '(text,jsonb)')
        ? (await client.query(`select public.${name}($1,$2) value`, [token,input])).rows[0].value
        : await workerGatewayRpc(await workerClient(client), name, token, input);
    const call = (token, name, input) => rpc(anon, token, name, input);
    const committed = (result) => { assert.equal(result.status, 'committed', JSON.stringify(result)); return result; };
    const createTask = async (title) => committed(await call(tokens.A, 'clued_record_mutate', {
      operation: 'create', record_type: 'task', record_schema_version: 1, lifecycle_status: 'active',
      scope: 'global', idempotency_key: uuid(), authority: 'observed',
      confidence_reason: 'work claim hardening fixture', source_refs: [], source_unavailable_reason: 'fixture',
      mutation: { title, content: 'fixture', type_fields: { execution_bucket: 'next' }, relations: {} },
    })).target_refs[0].id;
    const holders = new Map();
    const claim = async (token, input) => {
      const result = await call(token, 'clued_work_claim_v1', { scope: 'global', idempotency_key: uuid(), ...input });
      if (result.status === 'committed') holders.set(result.claim.claim_id, { token, lease_key: result.lease_key });
      return result;
    };
    const release = (token, c) => call(token, 'clued_work_release_v1', {
      scope: 'global', claim_id: c.claim_id, fence: c.fence, outcome: 'abandoned' });
    const verify = (input, client = anon) => rpc(client, tokens.verifier, 'clued_work_verify_v1', { scope: 'global', ...input });
    // A PR verify of a bound PR: the holder authorizes the exact head naming
    // the PR, the CI Binding observes it, then verifies the exact head and base.
    const base = 'b'.repeat(40);
    const prVerify = async (input) => {
      const { token, lease_key } = holders.get(input.claim_id);
      const now = (await admin.query('select fence,lease_version from clued_private.work_claims_v1 where claim_id=$1', [input.claim_id])).rows[0];
      committed(await call(token, 'clued_work_renew_v1', { scope: 'global', action: 'authorize_head', claim_id: input.claim_id,
        fence: Number(now.fence), lease_version: Number(now.lease_version), lease_key, repository: input.pr_ref.split('#')[0],
        head_sha: input.head_sha, target_branch: 'main', pr_number: Number(input.pr_ref.split('#')[1]), idempotency_key: uuid() }));
      const seen = await verify({ action: 'resolve_pr_claim', pr_ref: input.pr_ref, head_sha: input.head_sha, base_sha: base,
        target_branch: 'main', scope: undefined });
      assert.equal(seen.binding_status, 'bound', JSON.stringify(seen));
      return verify({ base_sha: base, target_branch: 'main', ...input });
    };

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

    // --- A verify never binds a pull request. ---
    // Since 20261108161615 a PR belongs to a Task, not to a claim: the
    // holder's head authorization or the CI Binding's discovery binds it, and
    // a Task may have several PRs (work-claims-pr-task-binding-db covers the
    // relation, its conflicts and races). A verify only reads the relation.
    const taskPr = await createTask('verify does not bind');
    const bound = committed(await claim(tokens.A, { task_id: taskPr, write_set: ['web/**'] })).claim;
    assert.equal(bound.bound_pr, null);
    const relations = async () => (await admin.query(`select count(*)::int n from clued_private.work_claim_pr_task_bindings_v1
      where task_id=$1`, [taskPr])).rows[0].n;
    const exact = { head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), target_branch: 'main' };
    let v = await verify({ claim_id: bound.claim_id, changed_paths: ['web/a.ts'], pr_ref: 'o/r#1', ...exact });
    assert.deepEqual([v.verdict, v.reasons, v.claim_binding.binding_status], ['REJECTED', ['pr_task_binding_unbound'], 'unbound']);
    // Without pr_ref nothing changes (the MCP tool's call).
    v = await verify({ claim_id: bound.claim_id, changed_paths: ['web/a.ts'] });
    assert.deepEqual([v.verdict, v.bound_pr], ['ADMITTED', null]);
    assert.equal(await relations(), 0);
    // A malformed pr_ref, or one without its exact head and base, raises.
    for (const bad of ['', '#1', 'o/r', 'o/r#x', 'o r/x#1', 'o/r#12345678901']) {
      await assert.rejects(() => verify({ claim_id: bound.claim_id, pr_ref: bad, ...exact }), /work_claim_pr_binding_input_invalid/, bad);
    }
    await assert.rejects(() => verify({ claim_id: bound.claim_id, pr_ref: 'o/r#1', head_sha: 'abc1234', base_sha: 'b'.repeat(40) }),
      /work_claim_pr_binding_input_invalid/);
    await assert.rejects(() => verify({ claim_id: bound.claim_id, pr_ref: 'o/r#1', head_sha: 'a'.repeat(40) }),
      /work_claim_pr_binding_input_invalid/);
    assert.equal(await relations(), 0);
    committed(await release(tokens.A, bound));

    // --- Concurrency caps (migration 20261002060001): 3 per session, 10 per
    // Binding across sessions; a claim without holder_session_ref counts in
    // a group of its own. ---
    const capClaim = async (token, session, label) => call(token, 'clued_work_claim_v1', {
      scope: 'global', idempotency_key: uuid(), task_id: await createTask(`cap ${label}`),
      write_set: [`cap/${label}`], ...(session ? { holder_session_ref: session } : {}) });
    const live = [];
    for (let i = 0; i < 3; i += 1) live.push(committed(await capClaim(tokens.A, 's1', `s1-${i}`)).claim);
    let over = await capClaim(tokens.A, 's1', 's1-over');
    assert.equal(over.error_code, 'work_claim_budget_exhausted', JSON.stringify(over));
    assert.deepEqual([over.limit, over.max_active_per_session, over.max_active_per_binding, over.active, over.active_binding],
      ['max_active_per_session', 3, 10, 3, 3]);
    // Another session of the same Binding is not blocked by s1.
    for (let i = 0; i < 3; i += 1) live.push(committed(await capClaim(tokens.A, 's2', `s2-${i}`)).claim);
    for (let i = 0; i < 3; i += 1) live.push(committed(await capClaim(tokens.A, 's3', `s3-${i}`)).claim);
    // Claims without a session share one group of their own.
    live.push(committed(await capClaim(tokens.A, null, 'none-0')).claim);
    // Ten live claims on the Binding: an eleventh is refused even from a fresh session.
    over = await capClaim(tokens.A, 's4', 's4-0');
    assert.equal(over.error_code, 'work_claim_budget_exhausted', JSON.stringify(over));
    assert.deepEqual([over.limit, over.active, over.active_session], ['max_active_per_binding', 10, 0]);
    // Another Binding of the same user has its own budget.
    const other = committed(await capClaim(tokens.B, 's1', 'b-s1')).claim;
    // Releasing one claim of s1 frees a slot for s1 and for the Binding.
    committed(await release(tokens.A, live[0]));
    live[0] = committed(await capClaim(tokens.A, 's1', 's1-again')).claim;
    for (const c of live) committed(await release(tokens.A, c));
    committed(await release(tokens.B, other));
    const profile = (await admin.query('select clued_private.work_claim_profile_v1() p')).rows[0].p;
    assert.deepEqual([profile.max_active_per_session, profile.max_active_per_binding], [3, 10]);

    // --- MINOR fixes (migration 20261002072000, Task 27b4f5e8). ---
    // Trigger refs: case-insensitive, and a short SHA matches its full SHA.
    const full = 'f7ba6ff312aa0e90095db1e28f5937920f30de3a';
    const ghsa = committed(await claim(tokens.A, { task_id: await createTask('ghsa upper'),
      write_set: ['minor/a.txt'], trigger_refs: ['ghsa:GHSA-VCVR-R3JV-PC5J', `ci:trivy@${full}`] })).claim;
    assert.deepEqual(ghsa.trigger_refs, [`ci:trivy@${full}`, 'ghsa:GHSA-VCVR-R3JV-PC5J']);
    for (const refs of [['GHSA:ghsa-vcvr-r3jv-pc5j'], ['ci:trivy@f7ba6ff'], ['CI:Trivy@F7BA6FF312']]) {
      const clash = await claim(tokens.B, { task_id: await createTask(`ref ${refs[0]}`), write_set: ['minor/b.txt'], trigger_refs: refs });
      assert.equal(clash.error_code, 'work_claim_conflict', JSON.stringify(refs));
    }
    for (const refs of [['ci:trivy@f7ba6fe'], ['ci:gitleaks@f7ba6ff'], ['ci:trivy@abc']]) {
      const fine = committed(await claim(tokens.B, { task_id: await createTask(`ref ${refs[0]}`), write_set: ['minor/c.txt'], trigger_refs: refs })).claim;
      committed(await release(tokens.B, fine));
    }
    committed(await release(tokens.A, ghsa));

    // Idempotency: the same key with another request is refused; a spent key is refused.
    const key = uuid();
    const task1 = await createTask('idempotency one');
    const first = committed(await claim(tokens.A, { idempotency_key: key, task_id: task1, write_set: ['minor/one.txt'] }));
    const again = committed(await claim(tokens.A, { idempotency_key: key, task_id: task1, write_set: ['./minor/one.txt'] }));
    assert.deepEqual([again.replayed, again.claim.claim_id], [true, first.claim.claim_id], 'normalized-equal request replays');
    const other1 = await claim(tokens.A, { idempotency_key: key, task_id: await createTask('idempotency two'), write_set: ['minor/two.txt'] });
    assert.deepEqual([other1.status, other1.error_code], ['rejected', 'work_claim_idempotency_conflict']);
    const widenedKey = await claim(tokens.A, { idempotency_key: key, task_id: task1, write_set: ['minor/**'] });
    assert.equal(widenedKey.error_code, 'work_claim_idempotency_conflict');
    committed(await release(tokens.A, first.claim));
    const spent = await claim(tokens.A, { idempotency_key: key, task_id: task1, write_set: ['minor/one.txt'] });
    assert.deepEqual([spent.error_code, spent.claim.status], ['work_claim_idempotency_spent', 'RELEASED']);
    // A row from before the migration (no hash) replays as before while live.
    const legacy = committed(await claim(tokens.A, { task_id: await createTask('legacy key'), write_set: ['minor/legacy.txt'] })).claim;
    await admin.query('update clued_private.work_claims_v1 set request_hash=null where claim_id=$1', [legacy.claim_id]);
    const legacyKey = (await admin.query('select idempotency_key k from clued_private.work_claims_v1 where claim_id=$1', [legacy.claim_id])).rows[0].k;
    const legacyReplay = committed(await claim(tokens.A, { idempotency_key: legacyKey, task_id: uuid(), write_set: ['anything'] }));
    assert.equal(legacyReplay.claim.claim_id, legacy.claim_id);
    committed(await release(tokens.A, legacy));

    // Renewal progress cannot repeat, even alternating.
    let r = committed(await claim(tokens.A, { task_id: await createTask('progress'), write_set: ['minor/p.txt'] })).claim;
    const renew = (progress_ref) => call(tokens.A, 'clued_work_renew_v1',
      { scope: 'global', claim_id: r.claim_id, fence: r.fence, lease_version: r.lease_version, progress_ref });
    r = committed(await renew('x')).claim;
    r = committed(await renew('y')).claim;
    for (const repeat of ['x', 'y']) {
      const refused = await renew(repeat);
      assert.equal(refused.error_code, 'work_claim_no_progress', repeat);
      assert.deepEqual(refused.used_progress_refs, ['x', 'y']);
    }
    r = committed(await renew('z')).claim;
    committed(await release(tokens.A, r));

    // "**/" also matches zero directories.
    const covers = async (file, glob) => (await admin.query(
      'select clued_private.work_claim_path_covered($1,array[$2]) v', [file, glob])).rows[0].v;
    assert.equal(await covers('package-lock.json', '**/package-lock.json'), true);
    assert.equal(await covers('apps/x/package-lock.json', '**/package-lock.json'), true);
    assert.equal(await covers('a/z', 'a/**/z'), true);
    assert.equal(await covers('a/b/c/z', 'a/**/z'), true);
    assert.equal(await covers('xpackage-lock.json', '**/package-lock.json'), false);
    assert.equal(await covers('a/xz', 'a/**/z'), false);
    assert.equal(await covers('src', 'src/**'), true);

    // --- Count caps (migration 20261002100000, Owner Decision a264ea02,
    // Task 80aea04a). The per-Task 24-hour count is replaced by rate buckets
    // (20261003050000), covered in work-claims-rate-buckets-db.test.mjs; the
    // per-claim head cap is replaced by a per-Task 24-hour CI meter
    // (20261003180000), covered in work-claims-ci-metering-db.test.mjs. ---
    const caps = (await admin.query('select clued_private.work_claim_profile_v1() p')).rows[0].p;
    assert.deepEqual([caps.max_claims_per_task_24h, caps.max_heads_per_claim, caps.github_ci_heads_per_task_24h],
      [undefined, undefined, 40]);

    // A claim records each distinct pull-request head it admits.
    const headClaim = committed(await claim(tokens.A, { task_id: await createTask('head cap'), write_set: ['heads/**'] })).claim;
    const sha = (i) => i.toString(16).padStart(40, '0');
    for (let i = 1; i <= 20; i += 1) {
      v = await prVerify({ claim_id: headClaim.claim_id, changed_paths: ['heads/a'], pr_ref: 'o/r#77', head_sha: sha(i) });
      assert.deepEqual([v.verdict, v.admitted_heads, v.task_ci_heads_24h, v.task_ci_head_cap], ['ADMITTED', i, i, 40],
        JSON.stringify(v));
    }
    // The same head again (a re-run, the hourly reverify) does not count.
    v = await verify({ claim_id: headClaim.claim_id, changed_paths: ['heads/a'], pr_ref: 'o/r#77', head_sha: sha(5),
      base_sha: base, target_branch: 'main' });
    assert.deepEqual([v.verdict, v.admitted_heads], ['ADMITTED', 20]);
    // A 21st head is no longer refused per claim.
    v = await prVerify({ claim_id: headClaim.claim_id, changed_paths: ['heads/a'], pr_ref: 'o/r#77', head_sha: sha(21) });
    assert.deepEqual([v.verdict, v.reasons, v.admitted_heads], ['ADMITTED', [], 21]);
    // A failing verify does not record its head either.
    const headTwo = committed(await claim(tokens.A, { task_id: await createTask('head fail'), write_set: ['heads2/**'] })).claim;
    v = await prVerify({ claim_id: headTwo.claim_id, changed_paths: ['elsewhere/a'], pr_ref: 'o/r#78', head_sha: sha(1) });
    assert.deepEqual([v.verdict, v.admitted_heads], ['REJECTED', 0]);
    // Without pr_ref (a hand dispatch, an Agent's own check) nothing is recorded.
    v = await verify({ claim_id: headClaim.claim_id, changed_paths: ['heads/a'], head_sha: sha(22) });
    assert.deepEqual([v.verdict, v.admitted_heads, v.task_ci_heads_24h], ['ADMITTED', 21, 21]);
    await assert.rejects(() => verify({ claim_id: headClaim.claim_id, pr_ref: 'o/r#77', head_sha: 'not-a-sha', base_sha: base }),
      /work_claim_pr_binding_input_invalid/);
    committed(await release(tokens.A, headClaim));
    committed(await release(tokens.A, headTwo));

    // The column is not writable through the client role, and verify is
    // still the only anon entry that touches it.
    await assert.rejects(() => anon.query('update clued_private.work_claims_v1 set bound_pr=null'), /permission denied/);
    await assert.rejects(() => anon.query("select clued_private.work_claim_globs_intersect('a','a')"), /permission denied/);
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
