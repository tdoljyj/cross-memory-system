import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// One disposable real database; no production URL, credential or Source edits.
const output = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(output, '../repo/apps/clued-cloud');
const require = createRequire(path.join(app, 'package.json'));
const { default: EmbeddedPostgres } = await import(pathToFileURL(require.resolve('embedded-postgres')));
const { allowTestIssuerCredentials } = await import(pathToFileURL(path.join(app, 'tests/issuer-credentials-fixture.mjs')));
const { workerGatewayRpc, assertGatewayCloseoutBoundary } = await import(pathToFileURL(path.join(app, 'tests/worker-gateway-caller-fixture.mjs')));
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const proof = () => crypto.randomBytes(32).toString('hex');
const subjectPaths = [
  'supabase/migrations/20261014044323_all_contexts_authorization_v2.sql',
  'supabase/migrations/20261014045157_all_contexts_serialization_v2.sql',
  'tests/worker-gateway-caller-fixture.mjs',
];
const subject = async () => Promise.all(subjectPaths.map(async (file) => ({ path: file, sha256: sha(await fs.readFile(path.join(app, file))) })));
const freePort = async () => {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
};
const startedAt = new Date().toISOString();
const beforeSubject = await subject();
assert.equal(beforeSubject[0].sha256, '55ba0daa5b4e303c3a954f7eec7a7f82621f6dc432693f5456cf5026684d104b');
assert.equal(beforeSubject[1].sha256, 'ce8ee42d89240a338cbd229846c397f9626f1445e2dfa832b60c19fecb994e58');
const tempParent = await fs.realpath(os.tmpdir());
const directory = await fs.mkdtemp(path.join(tempParent, 'clued-last-source-r4-'));
const server = new EmbeddedPostgres({ databaseDir: directory, user: 'postgres', password: proof(),
  port: await freePort(), persistent: false, postgresFlags: ['-c', 'io_method=sync'],
  onLog() {}, onError(message) { process.stderr.write(`${message}\n`); } });
const clients = [];
let report, failure;
try {
  await server.initialise(); await server.start();
  const admin = server.getPgClient(); clients.push(admin); await admin.connect();
  await admin.query(`create role anon nologin; create role authenticated nologin;
    create role service_role nologin bypassrls; create role authenticator nologin noinherit;
    create schema auth; create schema extensions; create extension pgcrypto with schema extensions;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    grant usage on schema auth,extensions to anon,authenticated,service_role;
    grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;`);
  const migrations = (await fs.readdir(path.join(app, 'supabase/migrations'))).filter((name) => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    try { await admin.query(await fs.readFile(path.join(app, 'supabase/migrations', name), 'utf8')); }
    catch (error) { throw new Error(`Migration ${name}: ${error.message}`, { cause: error }); }
  }
  await allowTestIssuerCredentials(admin);
  await assertGatewayCloseoutBoundary(admin);
  const owner = crypto.randomUUID();
  await admin.query("insert into auth.users(id,email,email_confirmed_at) values($1,'last-source@example.invalid',now())", [owner]);
  const human = server.getPgClient(); clients.push(human); await human.connect();
  await human.query('set role authenticated');
  await human.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [owner, JSON.stringify({ sub: owner, role: 'authenticated', session_id: 'last-source-r4', aal: 'aal1',
      amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] })]);
  const gateway = server.getPgClient(); clients.push(gateway); await gateway.connect();
  const issuer = proof(), bindingProof = proof(), resource = 'https://last-source.example.invalid/mcp';
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'Last source isolated fixture')", [issuer, resource]);
  const prepared = (await human.query('select public.clued_authorization_prepare_v12($1,$2) value', [issuer, {
    request_digest: proof(), client_id: 'last-source-r4', client_name: 'Last source isolated fixture',
    redirect_uri: 'https://last-source.example.invalid/callback', resource, requested_scopes: ['context:read'],
  }])).rows[0].value;
  const selected = [{ resource_kind: 'scope', resource_id: 'global', environment: 'canonical', actions: ['read'] }];
  assert.ok(prepared.eligible.some((row) => row.resource_kind === 'scope' && row.resource_id === 'global'
    && row.environment === 'canonical' && row.actions.includes('read')), 'the real Native eligible DTO offers the precise selected scope');
  const approved = (await human.query('select public.clued_authorization_approve_v12($1,$2,$3,$4,$5,$6) value',
    [issuer, prepared.request_id, prepared.version, JSON.stringify(selected), bindingProof,
      new Date(Date.now() + 3600000).toISOString()])).rows[0].value;
  const manage = async (input) => (await human.query('select public.clued_authorization_manage_v12($1) value', [input])).rows[0].value;
  const view = async () => (await manage({ op: 'list' })).bindings.find((row) => row.binding_id === approved.binding_id);
  const read = async () => workerGatewayRpc(gateway, 'clued_record_list', bindingProof, { level: 'global', record_type: 'note' });
  const originalRead = await read();
  assert.ok(Array.isArray(originalRead.records), 'the approved global/read permission actually admits an MCP record read');
  const current = await view();
  assert.equal(current.selection_format, 'sources_v1');
  assert.ok(current.sources.length > 0);
  assert.deepEqual(current.grants.map((row) => [row.resource_kind, row.resource_id, row.environment, row.effective_actions]),
    [['scope', 'global', 'canonical', ['read']]]);
  const request = { op: 'reduce', binding_id: approved.binding_id, base_version: current.version,
    selection_format: 'sources_v1', sources: current.sources.map((row) => ({ source_id: row.source_id,
      base_version: row.version, action_cap: [] })), exceptions: [] };
  assert.equal(new Set(request.sources.map((row) => row.source_id)).size, current.sources.length);
  assert.ok(request.sources.every((item) => current.sources.some((source) => source.source_id === item.source_id
    && source.version === item.base_version && item.action_cap.length === 0)));
  const constraints = async () => (await admin.query(`select conname,convalidated,pg_get_constraintdef(oid) definition
    from pg_constraint where conrelid='public.clued_agent_bindings'::regclass order by conname`)).rows;
  const snapshot = async () => {
    const tables = [
      ['binding', 'select to_jsonb(b) value from public.clued_agent_bindings b where id=$1'],
      ['authorization', 'select to_jsonb(a) value from clued_private.authorizations_v12 a where binding_id=$1'],
      ['source_mode', 'select to_jsonb(a) value from clued_private.authorization_source_bindings_v2 a where binding_id=$1'],
      ['sources', 'select to_jsonb(a) value from clued_private.authorization_sources_v2 a where binding_id=$1 order by id'],
      ['contributions', 'select to_jsonb(a) value from clued_private.authorization_contributions_v2 a join clued_private.authorization_sources_v2 s on s.id=a.source_id where s.binding_id=$1 order by a.source_id,a.resource_kind,a.resource_id,a.environment'],
      ['overrides', 'select to_jsonb(a) value from clued_private.authorization_resource_overrides_v2 a where binding_id=$1 order by id'],
      ['entries', 'select to_jsonb(a) value from clued_private.authorization_entries_v12 a where binding_id=$1 order by resource_kind,resource_id,environment'],
      ['grants', 'select to_jsonb(a) value from clued_private.development_grants_v14 a where binding_id=$1 order by id'],
      ['authorization_audit', 'select to_jsonb(a) value from clued_private.authorization_audit_v12 a where binding_id=$1 order by recorded_at,operation'],
    ];
    const result = {};
    for (const [name, sql] of tables) result[name] = (await admin.query(sql, [approved.binding_id])).rows.map((row) => row.value);
    result.receipts = (await admin.query('select to_jsonb(a) value from public.clued_audit_receipts a where user_id=$1 order by id', [owner])).rows.map((row) => row.value);
    result.events = (await admin.query('select to_jsonb(a) value from public.clued_context_events a where user_id=$1 order by id', [owner])).rows.map((row) => row.value);
    return result;
  };
  const beforeConstraints = await constraints();
  const before = await snapshot();
  let response = null, refusal = null;
  try { response = await manage(request); }
  catch (error) { refusal = { code: error.code, message: error.message, constraint: error.constraint,
    schema: error.schema, table: error.table }; }
  const after = await snapshot();
  const afterView = await view();
  const afterConstraints = await constraints();
  assert.deepEqual(afterConstraints, beforeConstraints, 'no constraint is modified to perform the reduction');
  const completeRollback = JSON.stringify(after) === JSON.stringify(before);
  const dtoUnchanged = JSON.stringify(afterView) === JSON.stringify(current);
  let afterRead = null, afterReadError = null;
  try { afterRead = await read(); }
  catch (error) { afterReadError = { code: error.code, message: error.message }; }
  if (refusal) {
    assert.equal(refusal.code, '23514', 'the observed last-source failure is the actual Binding CHECK, not invalid input');
    assert.equal(completeRollback, true);
    assert.equal(dtoUnchanged, true);
    assert.ok(Array.isArray(afterRead?.records), 'the failed revoke leaves original read access admitted');
    assert.equal(afterReadError, null);
  }
  const afterSubject = await subject();
  assert.deepEqual(afterSubject, beforeSubject);
  report = { schema: 'clued.last-source-zero-reproduction.v1', started_at: startedAt,
    ended_at: new Date().toISOString(), runtime: process.version, migrations: migrations.length,
    subject_before: beforeSubject, subject_after: afterSubject,
    selected_resource: selected, native_protocol: current.selection_format,
    original_authorization_version: current.version,
    legitimate_request: request,
    live_sources_before: current.sources.map((row) => ({ source_id: row.source_id, version: row.version,
      kind: row.kind, actions: row.actions, contributions: row.contributions })),
    actual_response: response, actual_error: refusal,
    snapshot_before_sha256: sha(JSON.stringify(before)), snapshot_after_sha256: sha(JSON.stringify(after)),
    snapshot_tables: Object.keys(before), complete_rollback: completeRollback, native_full_dto_unchanged: dtoUnchanged,
    constraints_before: beforeConstraints, constraints_after: afterConstraints, constraints_unchanged: true,
    mcp_before: { read_admitted: true, record_count: originalRead.records.length },
    mcp_after: { read_admitted: Array.isArray(afterRead?.records), record_count: afterRead?.records?.length ?? null, error: afterReadError },
    classification: refusal ? 'LEGAL_LAST_SOURCE_REDUCTION_REJECTED_BY_BINDING_CHECK_WITH_FULL_ROLLBACK_AND_ORIGINAL_ACCESS_RETAINED'
      : 'LEGAL_LAST_SOURCE_REDUCTION_RETURNED_RESPONSE',
    qualification: 'ONE_DISPOSABLE_REAL_POSTGRES_NATIVE_BOUNDARY_REPRODUCTION_ONLY',
    no_source_test_constraint_or_timeout_edits: true, no_live_canonical_ci_or_production: true };
} catch (error) {
  failure = error;
  process.stderr.write(`reproduction harness failed: ${error.code ?? 'ASSERTION'} ${error.message}\n`);
  process.exitCode = 1;
} finally {
  for (const client of clients.reverse()) await client.end().catch(() => {});
  // persistent:false may remove the directory itself during stop. Verify its
  // identity before that lifecycle cleanup, then remove only a verified residue.
  const actual = await fs.realpath(directory);
  assert.equal(path.dirname(actual), tempParent);
  assert.ok(path.basename(actual).startsWith('clued-last-source-r4-'));
  await server.stop();
  try { await fs.lstat(actual); await fs.rm(actual, { recursive: true, force: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (report) {
  report.process_closeout = 'own PostgreSQL stopped; verified owned temporary directory removed';
  report.harness_exit_code = failure ? 1 : 0;
  const file = path.join(output, 'last-source-zero-reproduction-r4.json');
  await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify({ classification: report.classification, actual_error: report.actual_error,
    complete_rollback: report.complete_rollback, native_full_dto_unchanged: report.native_full_dto_unchanged,
    original_read_still_admitted: report.mcp_after.read_admitted, report_sha256: sha(await fs.readFile(file)) }) + '\n');
}
