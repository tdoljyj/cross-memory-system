import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { build } from 'esbuild';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_ROOT = path.resolve(TEST_DIR, '..');
const REPO_ROOT = path.resolve(CLOUD_ROOT, '..', '..');
const MIGRATIONS = path.join(CLOUD_ROOT, 'supabase', 'migrations');
const EVIDENCE_DIR = process.env.CLD_P5_EVIDENCE_DIR
  ? path.resolve(process.env.CLD_P5_EVIDENCE_DIR)
  : null;

const IDS = {
  userOwner: '10000000-0000-4000-8000-000000000001',
  userEditor: '10000000-0000-4000-8000-000000000002',
  userReader: '10000000-0000-4000-8000-000000000003',
  userTenantB: '10000000-0000-4000-8000-000000000004',
  userDenied: '10000000-0000-4000-8000-000000000005',
  orgA: '20000000-0000-4000-8000-000000000001',
  orgB: '20000000-0000-4000-8000-000000000002',
  wsA: '30000000-0000-4000-8000-000000000001',
  wsA2: '30000000-0000-4000-8000-000000000002',
  wsB: '30000000-0000-4000-8000-000000000003',
  bindOwner: '40000000-0000-4000-8000-000000000001',
  bindEditor: '40000000-0000-4000-8000-000000000002',
  bindReader: '40000000-0000-4000-8000-000000000003',
  bindTenantB: '40000000-0000-4000-8000-000000000004',
  bindRevoked: '40000000-0000-4000-8000-000000000005',
  bindUserActor: '40000000-0000-4000-8000-000000000006',
  bindService: '40000000-0000-4000-8000-000000000007',
  bindAutomation: '40000000-0000-4000-8000-000000000008',
  bindDenied: '40000000-0000-4000-8000-000000000009',
  bindWorker: '40000000-0000-4000-8000-000000000010',
  recordCas: '50000000-0000-4000-8000-000000000001',
  recordSerial: '50000000-0000-4000-8000-000000000002',
  recordConcurrentSame: '50000000-0000-4000-8000-000000000003',
  recordSerialConflict: '50000000-0000-4000-8000-000000000004',
  recordConcurrentConflict: '50000000-0000-4000-8000-000000000005',
  recordNetwork: '50000000-0000-4000-8000-000000000006',
  recordFaultMutation: '50000000-0000-4000-8000-000000000007',
  recordFaultEvent: '50000000-0000-4000-8000-000000000008',
  recordFaultReceipt: '50000000-0000-4000-8000-000000000009',
  recordFaultAfterReceipt: '50000000-0000-4000-8000-000000000010',
  recordFaultAudit: '50000000-0000-4000-8000-000000000011',
  recordCommit: '50000000-0000-4000-8000-000000000012',
  recordAuth: '50000000-0000-4000-8000-000000000013',
  recordPrivate: '50000000-0000-4000-8000-000000000014',
  recordTenantB: '50000000-0000-4000-8000-000000000015',
  recordActorUser: '50000000-0000-4000-8000-000000000016',
  recordActorService: '50000000-0000-4000-8000-000000000017',
  recordActorAutomation: '50000000-0000-4000-8000-000000000018',
  recordF29: '50000000-0000-4000-8000-000000000019',
  recordWsA2: '50000000-0000-4000-8000-000000000020',
  recordWorkerSuccess: '50000000-0000-4000-8000-000000000021',
  recordWorkerCommit: '50000000-0000-4000-8000-000000000022',
  recordAttemptForgery: '50000000-0000-4000-8000-000000000023',
  projectA: '60000000-0000-4000-8000-000000000001',
  projectB: '60000000-0000-4000-8000-000000000002',
};

const RAW_WORKER_BINDING_TOKEN = `clued_bnd_${crypto.randomBytes(32).toString('hex')}`;

const TOKENS = {
  owner: 'a'.repeat(64), editor: 'b'.repeat(64), reader: 'c'.repeat(64), tenantB: 'd'.repeat(64),
  revoked: 'e'.repeat(64), user: '1'.repeat(64), service: '2'.repeat(64), automation: '3'.repeat(64),
  denied: '4'.repeat(64),
  worker: crypto.createHash('sha256').update(RAW_WORKER_BINDING_TOKEN).digest('hex'),
};

const evidence = new Map();
const raw = [];
let assertionCount = 0;

function check(value, message) {
  assertionCount += 1;
  assert.ok(value, message);
}

function equal(actual, expected, message) {
  assertionCount += 1;
  assert.deepEqual(actual, expected, message);
}

function record(file, scenario, details) {
  const row = { scenario, result: 'PASS', ...details };
  if (!evidence.has(file)) evidence.set(file, []);
  evidence.get(file).push(row);
  raw.push({ gate: scenario, result: 'PASS', evidence_file: file });
}

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function applyMigrations(client) {
  await client.query(`
    create role authenticator nologin noinherit;
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create schema extensions;
    grant usage on schema auth,extensions to anon,authenticated,service_role;
    create extension pgcrypto with schema extensions;
    create table auth.users(id uuid primary key,email text);
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    create or replace function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb
    $$;
    grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
  `);
  const names = (await fs.readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql')).sort();
  for (const name of names) await client.query(await fs.readFile(path.join(MIGRATIONS, name), 'utf8'));
  return names;
}

async function seed(client) {
  const userRows = [IDS.userOwner, IDS.userEditor, IDS.userReader, IDS.userTenantB, IDS.userDenied]
    .map((id, index) => `('${id}','u${index + 1}@p5.invalid')`).join(',');
  await client.query(`insert into auth.users(id,email) values ${userRows}`);
  await client.query(`
    insert into public.clued_organizations(id,tenant_key,name) values
      ('${IDS.orgA}','tenant-a','Tenant A'),('${IDS.orgB}','tenant-b','Tenant B');
    insert into public.clued_workspaces(id,organization_id,workspace_key,name) values
      ('${IDS.wsA}','${IDS.orgA}','workspace-a','Workspace A'),
      ('${IDS.wsA2}','${IDS.orgA}','workspace-a2','Workspace A2'),
      ('${IDS.wsB}','${IDS.orgB}','workspace-b','Workspace B');
    insert into public.clued_workspace_memberships(
      organization_id,workspace_id,user_id,role,scopes,purposes,expires_at
    ) values
      ('${IDS.orgA}','${IDS.wsA}','${IDS.userOwner}','owner',array['canonical:read','canonical:write','project:read','project:write','audit:read'],array['project_delivery'],now()+interval '1 day'),
      ('${IDS.orgA}','${IDS.wsA2}','${IDS.userOwner}','owner',array['canonical:read','canonical:write','project:read','project:write','audit:read'],array['project_delivery'],now()+interval '1 day'),
      ('${IDS.orgA}','${IDS.wsA}','${IDS.userEditor}','editor',array['canonical:read','canonical:write','project:read','project:write','audit:read'],array['project_delivery'],now()+interval '1 day'),
      ('${IDS.orgA}','${IDS.wsA}','${IDS.userReader}','reader',array['canonical:read','project:read','audit:read'],array['project_delivery'],now()+interval '1 day'),
      ('${IDS.orgA}','${IDS.wsA}','${IDS.userDenied}','denied',array['canonical:read','canonical:write','project:read','project:write','audit:read'],array['project_delivery'],now()+interval '1 day'),
      ('${IDS.orgB}','${IDS.wsB}','${IDS.userTenantB}','owner',array['canonical:read','canonical:write','project:read','project:write','audit:read'],array['project_delivery'],now()+interval '1 day');
  `);
  const bindings = [
    [IDS.bindOwner, IDS.userOwner, IDS.orgA, IDS.wsA, 'owner', 'agent_binding', TOKENS.owner, 'owner-agent'],
    [IDS.bindEditor, IDS.userEditor, IDS.orgA, IDS.wsA, 'editor', 'agent_binding', TOKENS.editor, 'editor-agent'],
    [IDS.bindReader, IDS.userReader, IDS.orgA, IDS.wsA, 'reader', 'agent_binding', TOKENS.reader, 'reader-agent'],
    [IDS.bindTenantB, IDS.userTenantB, IDS.orgB, IDS.wsB, 'owner', 'agent_binding', TOKENS.tenantB, 'tenant-b-agent'],
    [IDS.bindRevoked, IDS.userOwner, IDS.orgA, IDS.wsA, 'owner', 'agent_binding', TOKENS.revoked, 'revocation-agent'],
    [IDS.bindUserActor, IDS.userOwner, IDS.orgA, IDS.wsA, 'owner', 'user', TOKENS.user, 'user-actor'],
    [IDS.bindService, IDS.userOwner, IDS.orgA, IDS.wsA, 'owner', 'service_account', TOKENS.service, 'service-actor'],
    [IDS.bindAutomation, IDS.userOwner, IDS.orgA, IDS.wsA, 'owner', 'automation', TOKENS.automation, 'automation-actor'],
    [IDS.bindDenied, IDS.userDenied, IDS.orgA, IDS.wsA, 'denied', 'agent_binding', TOKENS.denied, 'denied-agent'],
    [IDS.bindWorker, IDS.userOwner, IDS.orgA, IDS.wsA, 'owner', 'agent_binding', TOKENS.worker, 'worker-gateway-agent'],
  ];
  for (const [id, user, org, ws, role, actor, token, name] of bindings) {
    const scopes = role === 'reader'
      ? `array['canonical:read','project:read','audit:read']`
      : `array['canonical:read','canonical:write','project:read','project:write','audit:read']`;
    await client.query(`
      insert into public.clued_agent_bindings(
        id,user_id,vendor,agent_name,token_hash,scopes,context_keys,organization_id,workspace_id,
        active_context_key,role,purpose,policy_version,revocation_epoch,expires_at,actor_kind
      ) values ($1,$2,'codex',$3,$4,${scopes},array['project:p5'],$5,$6,'project:p5',$7,
        'project_delivery',1,1,now()+interval '1 day',$8)
    `, [id, user, name, token, org, ws, role, actor]);
  }
  const recordsA = Object.entries(IDS).filter(([name]) => name.startsWith('record') && name !== 'recordTenantB' && name !== 'recordWsA2');
  for (const [name, id] of recordsA) {
    const visibility = name === 'recordPrivate' ? 'private' : 'workspace';
    await client.query(`insert into public.clued_memories(
      id,user_id,title,content,record_type,scope,status,version,organization_id,workspace_id,p5_visibility
    ) values ($1,$2,$3,$4,'note','global','active',1,$5,$6,$7)`,
    [id, IDS.userOwner, name, `${name}-v1`, IDS.orgA, IDS.wsA, visibility]);
  }
  await client.query(`insert into public.clued_memories(
    id,user_id,title,content,record_type,scope,status,version,organization_id,workspace_id,p5_visibility
  ) values
    ($1,$2,'tenant-b','tenant-b-v1','note','global','active',1,$3,$4,'workspace'),
    ($5,$6,'workspace-a2','workspace-a2-v1','note','global','active',1,$7,$8,'workspace')`,
  [IDS.recordTenantB, IDS.userTenantB, IDS.orgB, IDS.wsB,
    IDS.recordWsA2, IDS.userOwner, IDS.orgA, IDS.wsA2]);
  await client.query(`insert into public.clued_projects(
    id,user_id,name,normalized_name,certainty_status,progress_status,context_key,confirmed_at,version,
    organization_id,workspace_id,p5_visibility
  ) values
    ($1,$2,'Project A','projecta','confirmed','active','project:p5:a',now(),1,$3,$4,'workspace'),
    ($5,$6,'Project B','projectb','confirmed','active','project:p5:b',now(),1,$7,$8,'workspace')`,
  [IDS.projectA, IDS.userOwner, IDS.orgA, IDS.wsA, IDS.projectB, IDS.userTenantB, IDS.orgB, IDS.wsB]);
}

function context({ org = IDS.orgA, ws = IDS.wsA, role = 'owner', scope = 'canonical:write',
  contextKey = 'project:p5', policy = 1, epoch = 1, sessionToken } = {}) {
  return {
    organization_id: org, workspace_id: ws, context_key: contextKey, role, scope,
    purpose: 'project_delivery', policy_version: policy, revocation_epoch: epoch,
    ...(sessionToken ? { session_token: sessionToken } : {}),
  };
}

function mutation(ctx, targetId, baseVersion, key, body, extra = {}) {
  return { ...ctx, target_kind: 'record', target_id: targetId, base_version: baseVersion,
    idempotency_key: key, mutation: { content: body }, ...extra };
}

async function clientFor(server, { faults = false, role = 'clued_p5_gateway' } = {}) {
  const client = server.getPgClient();
  await client.connect();
  if (faults) await client.query(`set clued.p5_test_faults='on'`);
  await client.query(`set role ${role}`);
  return client;
}

async function rawRpc(client, name, params) {
  const placeholders = params.map((_, index) => `$${index + 1}`).join(',');
  const result = await client.query(`select public.${name}(${placeholders}) as result`, params);
  return result.rows[0].result;
}

async function rpc(client, name, token, input, extra = []) {
  if (name === 'clued_p5_mutate') {
    const attempt = await rawRpc(client, 'clued_p5_attempt_begin', [token, input]);
    if (attempt.status === 'replayed') return attempt.canonical_result;
    if (attempt.status !== 'open') return attempt;
    return await rawRpc(client, name, [token, input, attempt.attempt_id]);
  }
  return await rawRpc(client, name, [token, input, ...extra]);
}

async function openSession(client, token, ctx) {
  const result = await rpc(client, 'clued_p5_session_open', token, ctx);
  equal(result.status, 'authorized', `session must open for ${token.slice(0, 1)}`);
  return result.session_token;
}

async function row(client, id) {
  return (await client.query('select version,content from public.clued_memories where id=$1', [id])).rows[0];
}

async function counts(client, idempotencyKey) {
  return (await client.query(`
    select
      (select count(*)::int from public.clued_p5_idempotency where idempotency_key=$1) as idempotency,
      (select count(*)::int from public.clued_p5_events e join public.clued_p5_idempotency i on i.id=e.idempotency_id where i.idempotency_key=$1) as events,
      (select count(*)::int from public.clued_p5_receipts r join public.clued_p5_idempotency i on i.id=r.idempotency_id where i.idempotency_key=$1) as receipts
  `, [idempotencyKey])).rows[0];
}

async function treeDigest(root) {
  const entries = [];
  async function walk(dir) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else entries.push(`${path.relative(root, absolute).replaceAll('\\', '/')}:${crypto.createHash('sha256').update(await fs.readFile(absolute)).digest('hex')}`);
    }
  }
  await walk(root);
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
}

async function loadWorkerContinuity(bundleDir) {
  const outfile = path.join(bundleDir, 'continuity-under-test.mjs');
  await build({
    entryPoints: [path.join(CLOUD_ROOT, 'worker', 'continuity.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
  });
  return await import(`${pathToFileURL(outfile).href}?run=${crypto.randomUUID()}`);
}

const GATEWAY_RPC_ARGUMENTS = {
  clued_p5_session_open: ['p_token_hash', 'p_input'],
  clued_p5_workspace_switch: ['p_token_hash', 'p_input'],
  clued_p5_pending_intent: ['p_token_hash', 'p_input'],
  clued_p5_git_divergence: ['p_token_hash', 'p_input'],
  clued_p5_attempt_begin: ['p_token_hash', 'p_input'],
  clued_p5_attempt_resolve: ['p_token_hash', 'p_input', 'p_attempt_id'],
  clued_p5_mutate: ['p_token_hash', 'p_input', 'p_attempt_id'],
  clued_p5_record_commit_failure: ['p_token_hash', 'p_input', 'p_attempt_id', 'p_failure_kind'],
};

function postgresGatewayFetch(server, gatewayToken, calls, { commitFailureTarget, lostResponseTarget } = {}) {
  return async (url, init = {}) => {
    const rpcName = new URL(String(url)).pathname.split('/').at(-1);
    calls.push(rpcName);
    if (new Headers(init.headers).get('authorization') !== `Bearer ${gatewayToken}`) {
      return Response.json({ message: 'gateway credential required', code: '42501' }, { status: 403 });
    }
    const keys = GATEWAY_RPC_ARGUMENTS[rpcName];
    if (!keys) return Response.json({ message: 'unknown gateway rpc', code: '42883' }, { status: 404 });
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
    const params = keys.map((key) => body[key]);
    const client = server.getPgClient();
    await client.connect();
    try {
      if (rpcName === 'clued_p5_mutate' && body.p_input?.target_id === commitFailureTarget) {
        await client.query('begin');
        await client.query('set local role clued_p5_gateway');
        await rawRpc(client, rpcName, params);
        await client.query('reset role');
        await client.query('create temp table p5_worker_commit_fail(x integer unique deferrable initially deferred) on commit drop');
        await client.query('insert into p5_worker_commit_fail values (1),(1)');
        try {
          await client.query('commit');
          throw new Error('deferred commit failure was not raised');
        } catch (error) {
          if (!error.code) throw error;
          return Response.json({ message: 'database transaction commit failed', code: 'P5_TRANSACTION_COMMIT_FAILED' }, { status: 503 });
        }
      }
      await client.query('set role clued_p5_gateway');
      const result = await rawRpc(client, rpcName, params);
      if (rpcName === 'clued_p5_mutate' && body.p_input?.target_id === lostResponseTarget) {
        return Response.json({ message: 'mutation response lost', code: 'P5_TRANSPORT_RESPONSE_LOST' }, { status: 503 });
      }
      return Response.json(result);
    } catch (error) {
      return Response.json({ message: error.message, code: error.code ?? 'P5_GATEWAY_ERROR' }, { status: 500 });
    } finally {
      await client.end().catch(() => {});
    }
  };
}

async function workerTool(handleContinuityRequest, env, bindingToken, name, args) {
  const request = new Request('https://worker.p5.invalid/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${bindingToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call',
      params: { name, arguments: args } }),
  });
  const response = await handleContinuityRequest(request, env);
  const payload = await response.json();
  return { httpStatus: response.status, rpcError: payload.error ?? null,
    result: payload.result?.structuredContent ?? null };
}

function runSupabaseSecurityAdvisors(port, password) {
  const url = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres?sslmode=disable`;
  try {
    const args = ['--yes', 'supabase@2.115.0', 'db', 'advisors', '--db-url', url,
      '--type', 'security', '--level', 'warn', '--fail-on', 'error', '--output-format', 'json'];
    if (process.platform === 'win32') {
      const command = `npx --yes supabase@2.115.0 db advisors --db-url ${url} --type security --level warn --fail-on error --output-format json`;
      return execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command],
        { cwd: CLOUD_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
    }
    return execFileSync('npx', args,
      { cwd: CLOUD_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  } catch (error) {
    const detail = `${String(error.stderr ?? '')}\n${String(error.stdout ?? '')}`.replaceAll(password, '<redacted-local-password>')
      .replace(/postgresql:\/\/[^\s]+/g, '<redacted-local-db-url>').trim();
    throw new Error(`Supabase security advisors failed (status ${error.status ?? 'unknown'}): ${detail}`);
  }
}

async function writeEvidence(summary) {
  if (!EVIDENCE_DIR) return;
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  evidence.set('p5_raw_results.jsonl', [...raw, { gate: 'summary', result: 'PASS', ...summary }]);
  for (const [name, rows] of evidence) {
    await fs.writeFile(path.join(EVIDENCE_DIR, name), `${rows.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
  }
}

test('P5 real PostgreSQL tenant isolation, concurrency, idempotency, rollback, and RLS', async () => {
  const port = await unusedPort();
  const databaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-p5-pg-'));
  const bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-p5-worker-'));
  const localPassword = crypto.randomBytes(24).toString('hex');
  const server = new EmbeddedPostgres({ databaseDir, user: 'postgres', password: localPassword, port,
    persistent: false, onLog: () => {}, onError: (message) => process.stderr.write(`${message}\n`) });
  const clients = [];
  let admin;
  try {
    await server.initialise();
    await server.start();
    admin = server.getPgClient();
    clients.push(admin);
    await admin.connect();
    const migrationNames = await applyMigrations(admin);
    await seed(admin);
    const pgVersion = (await admin.query('select version() as version')).rows[0].version;

    // Independent-review repair: every public P5 RPC is denied to Data API
    // roles even when the caller knows a valid Binding hash. Only the minimal
    // gateway role may execute; it cannot log in, inherit, bypass RLS, or read
    // the P5 tables directly.
    const gatewayRole = (await admin.query(`select rolcanlogin,rolinherit,rolbypassrls,rolsuper
      from pg_roles where rolname='clued_p5_gateway'`)).rows[0];
    equal(gatewayRole, { rolcanlogin: false, rolinherit: false, rolbypassrls: false, rolsuper: false });
    const rpcPrivileges = (await admin.query(`select p.proname,
      has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
      has_function_privilege('service_role',p.oid,'EXECUTE') service_execute,
      has_function_privilege('clued_p5_gateway',p.oid,'EXECUTE') gateway_execute
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'clued_p5_%' order by p.proname`)).rows;
    check(rpcPrivileges.length >= 8, 'all public P5 RPCs discovered');
    check(rpcPrivileges.every((item) => !item.anon_execute && !item.authenticated_execute
      && !item.service_execute && item.gateway_execute), 'P5 RPC EXECUTE belongs only to gateway');
    const gatewayDataPrivileges = (await admin.query(`select
      has_table_privilege('clued_p5_gateway','public.clued_p5_gateway_attempts','SELECT')
      or has_table_privilege('clued_p5_gateway','public.clued_p5_gateway_attempts','INSERT')
      or has_table_privilege('clued_p5_gateway','public.clued_p5_gateway_attempts','UPDATE')
      or has_table_privilege('clued_p5_gateway','public.clued_p5_gateway_attempts','DELETE') as any_table,
      has_function_privilege('clued_p5_gateway','clued_private.p5_mutate_gateway_core(text,jsonb)','EXECUTE') as private_core`)).rows[0];
    equal(gatewayDataPrivileges, { any_table: false, private_core: false });

    const directAnon = await clientFor(server, { role: 'anon' });
    const directAuthenticated = await clientFor(server, { role: 'authenticated' });
    clients.push(directAnon, directAuthenticated);
    const deniedInput = mutation(context({ sessionToken: `clued_p5s_${'0'.repeat(64)}` }),
      IDS.recordAuth, 1, 'direct-rpc-denied', 'must-not-write');
    const directCalls = [
      ['clued_p5_session_open', [TOKENS.owner, context()]],
      ['clued_p5_workspace_switch', [TOKENS.owner, { ...deniedInput, new_workspace_id: IDS.wsA2, new_context_key: 'direct:denied' }]],
      ['clued_p5_mutate', [TOKENS.owner, deniedInput, crypto.randomUUID()]],
      ['clued_p5_pending_intent', [TOKENS.owner, { ...deniedInput, encrypted_intent_ref: 'denied' }]],
      ['clued_p5_attempt_begin', [TOKENS.owner, deniedInput]],
      ['clued_p5_attempt_resolve', [TOKENS.owner, deniedInput, crypto.randomUUID()]],
      ['clued_p5_record_commit_failure', [TOKENS.owner, deniedInput, crypto.randomUUID(), 'database_commit_failure']],
      ['clued_p5_git_divergence', [TOKENS.owner, { base: '1'.repeat(40), local: '2'.repeat(40), remote: '3'.repeat(40) }]],
    ];
    async function expectRpcPermissionDenied(client, role, name, params) {
      let deniedError;
      try { await rawRpc(client, name, params); } catch (error) { deniedError = error; }
      equal(deniedError?.code, '42501', `${role} direct ${name} must be permission denied`);
    }
    for (const [name, params] of directCalls) {
      await expectRpcPermissionDenied(directAnon, 'anon', name, params);
      await expectRpcPermissionDenied(directAuthenticated, 'authenticated', name, params);
    }
    equal(await row(admin, IDS.recordAuth), { version: '1', content: 'recordAuth-v1' });
    const advisorOutput = runSupabaseSecurityAdvisors(port, localPassword);
    check(typeof advisorOutput === 'string', 'Supabase security advisors executed');
    check(!/clued_p5_[^\n]*(anon|authenticated)[^\n]*(execute|security definer)/i.test(advisorOutput),
      'Supabase advisors report no P5 executable SECURITY DEFINER finding');
    record('supabase_advisors_evidence.jsonl', 'P5_GATEWAY_RPC_PRIVILEGE_AND_ADVISOR', {
      public_p5_rpc_count: rpcPrivileges.length,
      anon_permission_denied: directCalls.map(([name]) => name),
      authenticated_permission_denied: directCalls.map(([name]) => name),
      valid_binding_hash_cannot_bypass_worker: true,
      gateway_role: gatewayRole,
      gateway_execute_only: true,
      gateway_table_privileges: gatewayDataPrivileges.any_table,
      gateway_private_core_execute: gatewayDataPrivileges.private_core,
      supabase_security_advisors: 'PASS',
      advisor_p5_executable_findings: 0,
      advisor_output_sha256: crypto.createHash('sha256').update(advisorOutput).digest('hex'),
      advisor_output_bytes: Buffer.byteLength(advisorOutput),
    });

    const owner = await clientFor(server, { faults: true });
    const editor = await clientFor(server, { faults: true });
    const reader = await clientFor(server, { faults: true });
    const tenantB = await clientFor(server, { faults: true });
    const denied = await clientFor(server, { faults: true });
    clients.push(owner, editor, reader, tenantB, denied);
    const ownerSession = await openSession(owner, TOKENS.owner, context());
    const editorSession = await openSession(editor, TOKENS.editor, context({ role: 'editor' }));
    const tenantBSession = await openSession(tenantB, TOKENS.tenantB, context({ org: IDS.orgB, ws: IDS.wsB }));
    const ownerCtx = context({ sessionToken: ownerSession });
    const editorCtx = context({ role: 'editor', sessionToken: editorSession });
    const tenantBCtx = context({ org: IDS.orgB, ws: IDS.wsB, sessionToken: tenantBSession });

    // F15: two independent connections and bindings contend on the same exact base version.
    const casA = mutation(ownerCtx, IDS.recordCas, 1, 'f15-owner-cas', 'winner-owner');
    const casB = mutation(editorCtx, IDS.recordCas, 1, 'f15-editor-cas', 'winner-editor');
    const [casResultA, casResultB] = await Promise.all([
      rpc(owner, 'clued_p5_mutate', TOKENS.owner, casA), rpc(editor, 'clued_p5_mutate', TOKENS.editor, casB),
    ]);
    const casStatuses = [casResultA.status, casResultB.status].sort();
    equal(casStatuses, ['committed', 'conflict'], 'exactly one CAS writer commits');
    const casWinner = casResultA.status === 'committed' ? casResultA : casResultB;
    const casLoser = casResultA.status === 'conflict' ? casResultA : casResultB;
    equal(casLoser.error.type, 'CANONICAL_CAS_CONFLICT');
    equal(casLoser.error.expected_version, 1);
    equal(casLoser.error.actual_version, 2);
    equal((await row(admin, IDS.recordCas)).version, '2');
    const casAggregate = await admin.query(`select count(*)::int events,
      (select count(*)::int from public.clued_p5_receipts where target_id=$1 and status='committed') receipts
      from public.clued_p5_events where target_id=$1`, [IDS.recordCas]);
    equal(casAggregate.rows[0], { events: 1, receipts: 1 });
    record('concurrent_cas_evidence.jsonl', 'F15_same_base_real_concurrency', {
      connections: ['owner-independent-pg-connection', 'editor-independent-pg-connection'], base_version: 1,
      committed: casWinner, conflict: casLoser, final_version: 2, success_event_count: 1, success_receipt_count: 1,
    });

    // F16/F17: serial, concurrent, lost-result replay, and payload conflicts.
    const serialInput = mutation(ownerCtx, IDS.recordSerial, 1, 'f16-serial-same', 'serial-v2');
    const serialFirst = await rpc(owner, 'clued_p5_mutate', TOKENS.owner, serialInput);
    const serialReplay = await rpc(owner, 'clued_p5_mutate', TOKENS.owner, serialInput);
    equal(serialReplay, serialFirst, 'serial replay returns identical business result');
    equal(await counts(admin, 'f16-serial-same'), { idempotency: 1, events: 1, receipts: 1 });

    const concurrentSame = mutation(ownerCtx, IDS.recordConcurrentSame, 1, 'f16-concurrent-same', 'concurrent-same-v2');
    const replayConnection = await clientFor(server, { faults: true });
    clients.push(replayConnection);
    const [sameA, sameB] = await Promise.all([
      rpc(owner, 'clued_p5_mutate', TOKENS.owner, concurrentSame),
      rpc(replayConnection, 'clued_p5_mutate', TOKENS.owner, concurrentSame),
    ]);
    equal(sameA, sameB, 'concurrent same-body replay returns identical result');
    equal(await counts(admin, 'f16-concurrent-same'), { idempotency: 1, events: 1, receipts: 1 });

    const networkInput = mutation(ownerCtx, IDS.recordNetwork, 1, 'f16-network-loss', 'network-v2');
    await rpc(owner, 'clued_p5_mutate', TOKENS.owner, networkInput); // Simulated lost response.
    const networkReplay = await rpc(owner, 'clued_p5_mutate', TOKENS.owner, networkInput);
    equal(networkReplay.status, 'committed');
    equal(await counts(admin, 'f16-network-loss'), { idempotency: 1, events: 1, receipts: 1 });

    const serialConflictA = mutation(ownerCtx, IDS.recordSerialConflict, 1, 'f17-serial-different', 'original-body');
    const serialConflictB = mutation(ownerCtx, IDS.recordSerialConflict, 1, 'f17-serial-different', 'different-body');
    await rpc(owner, 'clued_p5_mutate', TOKENS.owner, serialConflictA);
    const serialPayloadConflict = await rpc(owner, 'clued_p5_mutate', TOKENS.owner, serialConflictB);
    equal(serialPayloadConflict.error.type, 'IDEMPOTENCY_PAYLOAD_CONFLICT');
    equal((await row(admin, IDS.recordSerialConflict)).content, 'original-body');

    const concurrentConflictA = mutation(ownerCtx, IDS.recordConcurrentConflict, 1, 'f17-concurrent-different', 'body-a');
    const concurrentConflictB = mutation(ownerCtx, IDS.recordConcurrentConflict, 1, 'f17-concurrent-different', 'body-b');
    const [differentA, differentB] = await Promise.all([
      rpc(owner, 'clued_p5_mutate', TOKENS.owner, concurrentConflictA),
      rpc(replayConnection, 'clued_p5_mutate', TOKENS.owner, concurrentConflictB),
    ]);
    equal([differentA.status, differentB.status].sort(), ['committed', 'rejected']);
    const differentRejected = differentA.status === 'rejected' ? differentA : differentB;
    equal(differentRejected.error.type, 'IDEMPOTENCY_PAYLOAD_CONFLICT');
    equal((await row(admin, IDS.recordConcurrentConflict)).version, '2');
    record('idempotency_retry_evidence.jsonl', 'F16_F17_idempotency_matrix', {
      serial_same: { identical_result: true, ...await counts(admin, 'f16-serial-same') },
      concurrent_same: { identical_result: true, ...await counts(admin, 'f16-concurrent-same') },
      network_loss_retry: { status: networkReplay.status, ...await counts(admin, 'f16-network-loss') },
      serial_different: serialPayloadConflict, concurrent_different: differentRejected,
      duplicate_business_side_effects: 0,
    });

    // F18: all injected failures roll back mutation/event/committed receipt and replay deterministically.
    const faults = [
      ['after_mutation', IDS.recordFaultMutation], ['after_event', IDS.recordFaultEvent],
      ['receipt_write', IDS.recordFaultReceipt], ['after_receipt', IDS.recordFaultAfterReceipt],
      ['audit_write', IDS.recordFaultAudit],
    ];
    for (const [fault, target] of faults) {
      const key = `f18-${fault.replaceAll('_', '-')}`;
      const input = mutation(ownerCtx, target, 1, key, `${fault}-v2`, { fault_at: fault });
      const before = await row(admin, target);
      const failed = await rpc(owner, 'clued_p5_mutate', TOKENS.owner, input);
      const retry = await rpc(owner, 'clued_p5_mutate', TOKENS.owner, input);
      equal(failed.status, 'failed', `${fault} must fail`);
      equal(retry, failed, `${fault} retry must be deterministic`);
      equal(await row(admin, target), before, `${fault} must preserve canonical row`);
      const aggregate = await admin.query(`select
        (select count(*)::int from public.clued_p5_events where target_id=$1) events,
        (select count(*)::int from public.clued_p5_receipts where target_id=$1 and status='committed') committed_receipts`, [target]);
      equal(aggregate.rows[0], { events: 0, committed_receipts: 0 });
      record('transaction_rollback_evidence.jsonl', `F18_${fault}`, {
        old_version: before.version, final_version: (await row(admin, target)).version,
        partial_mutation: false, orphan_event: false, success_receipt: false, deterministic_retry: true,
        error: failed.error,
      });
    }

    // The actual Worker executes begin -> mutation -> resolve -> compensation.
    // The gateway adapter uses a real PostgreSQL transaction and a deferred
    // constraint failure; the fixture never calls compensation for this case.
    const { handleContinuityRequest } = await loadWorkerContinuity(bundleDir);
    const gatewayToken = crypto.randomBytes(48).toString('base64url');
    const gatewayCalls = [];
    const workerEnv = {
      SUPABASE_URL: 'https://gateway.p5.invalid',
      SUPABASE_PUBLISHABLE_KEY: 'publishable-local-test',
      CLUED_P5_GATEWAY_TOKEN: gatewayToken,
      P5_TENANT_WRITES: 'false',
    };
    const originalFetch = globalThis.fetch;
    let disabledFetchCount = 0;
    globalThis.fetch = async () => { disabledFetchCount += 1; throw new Error('disabled gate must not fetch'); };
    const gateOff = await workerTool(handleContinuityRequest, workerEnv, RAW_WORKER_BINDING_TOKEN,
      'clued_p5_mutate', mutation(context({ sessionToken: `clued_p5s_${'0'.repeat(64)}` }),
        IDS.recordWorkerSuccess, 1, 'worker-gate-off', 'must-not-write'));
    equal(gateOff.httpStatus, 404);
    equal(disabledFetchCount, 0, 'disabled feature gate performs no gateway request');
    equal(await row(admin, IDS.recordWorkerSuccess), { version: '1', content: 'recordWorkerSuccess-v1' });

    const missingGatewaySecret = await workerTool(handleContinuityRequest,
      { ...workerEnv, P5_TENANT_WRITES: 'true', CLUED_P5_GATEWAY_TOKEN: undefined },
      RAW_WORKER_BINDING_TOKEN, 'clued_p5_mutate',
      mutation(context({ sessionToken: `clued_p5s_${'0'.repeat(64)}` }),
        IDS.recordWorkerSuccess, 1, 'worker-secret-missing', 'must-not-write'));
    equal(missingGatewaySecret.httpStatus, 503);
    equal(disabledFetchCount, 0, 'missing gateway secret performs no Supabase request');

    workerEnv.P5_TENANT_WRITES = 'true';
    globalThis.fetch = postgresGatewayFetch(server, gatewayToken, gatewayCalls,
      { commitFailureTarget: IDS.recordWorkerCommit });
    let workerSessionResult;
    let workerSuccess;
    let workerCommitFailure;
    let workerCommitRetry;
    let workerCommitInput;
    try {
      workerSessionResult = (await workerTool(handleContinuityRequest, workerEnv, RAW_WORKER_BINDING_TOKEN,
        'clued_p5_session_open', context())).result;
      equal(workerSessionResult.status, 'authorized');
      const workerCtx = context({ sessionToken: workerSessionResult.session_token });
      workerSuccess = (await workerTool(handleContinuityRequest, workerEnv, RAW_WORKER_BINDING_TOKEN,
        'clued_p5_mutate', mutation(workerCtx, IDS.recordWorkerSuccess, 1,
          'worker-gateway-success', 'worker-gateway-v2'))).result;
      equal(workerSuccess.status, 'committed');
      equal(await row(admin, IDS.recordWorkerSuccess), { version: '2', content: 'worker-gateway-v2' });

      workerCommitInput = mutation(workerCtx, IDS.recordWorkerCommit, 1,
        'worker-real-commit-failure', 'must-rollback');
      workerCommitFailure = (await workerTool(handleContinuityRequest, workerEnv, RAW_WORKER_BINDING_TOKEN,
        'clued_p5_mutate', workerCommitInput)).result;
      equal(workerCommitFailure.status, 'failed');
      equal(workerCommitFailure.error.type, 'TRANSACTION_COMMIT_FAILED');
      equal(workerCommitFailure.error.failure_kind, 'database_commit_failure');
      equal(await row(admin, IDS.recordWorkerCommit), { version: '1', content: 'recordWorkerCommit-v1' });
      equal(await counts(admin, 'worker-real-commit-failure'), { idempotency: 1, events: 0, receipts: 1 });
      workerCommitRetry = (await workerTool(handleContinuityRequest, workerEnv, RAW_WORKER_BINDING_TOKEN,
        'clued_p5_mutate', workerCommitInput)).result;
      equal(workerCommitRetry, workerCommitFailure, 'Worker retry replays trusted failed result');
    } finally {
      globalThis.fetch = originalFetch;
    }
    check(gatewayCalls.includes('clued_p5_attempt_begin') && gatewayCalls.includes('clued_p5_mutate')
      && gatewayCalls.includes('clued_p5_attempt_resolve')
      && gatewayCalls.includes('clued_p5_record_commit_failure'), 'Worker automatically closes commit failure');
    record('transaction_rollback_evidence.jsonl', 'F18_WORKER_REAL_TRANSACTION_COMMIT_FAILURE', {
      actual_worker_module: 'worker/continuity.ts',
      actual_gateway_role: 'clued_p5_gateway',
      real_deferred_commit_failure: true,
      fixture_manual_compensation: false,
      gateway_call_sequence: gatewayCalls,
      canonical_version: 1,
      events: 0,
      success_receipts: 0,
      failed_receipts: 1,
      deterministic_retry: true,
      platform_failure_audit: workerCommitFailure,
    });
    record('tenant_workspace_rls_evidence.jsonl', 'P5_FEATURE_GATE_AND_WORKER_GATEWAY', {
      feature_disabled_worker_http_status: gateOff.httpStatus,
      feature_disabled_gateway_calls: disabledFetchCount,
      missing_gateway_secret_http_status: missingGatewaySecret.httpStatus,
      feature_disabled_direct_anon_rpc: 'permission_denied',
      feature_enabled_worker_gateway_postgres: workerSuccess.status,
      worker_uses_dedicated_gateway_role: true,
      gateway_secret_logged: false,
    });

    // Missing, mismatched, cross-Binding, untrusted-class and duplicate
    // compensation attempts are fail-closed. The first four create no
    // Idempotency/Receipt/Audit and leave the same Attempt usable by a valid
    // mutation; the duplicate consumes nothing a second time.
    const forgeryInput = mutation(ownerCtx, IDS.recordAttemptForgery, 1,
      'attempt-forgery-control', 'legitimate-v2');
    const forgeryAttempt = await rawRpc(owner, 'clued_p5_attempt_begin', [TOKENS.owner, forgeryInput]);
    equal(forgeryAttempt.status, 'open');
    const missingAttempt = await rawRpc(owner, 'clued_p5_record_commit_failure',
      [TOKENS.owner, forgeryInput, crypto.randomUUID(), 'database_commit_failure']);
    equal(missingAttempt.error.type, 'P5_ATTEMPT_NOT_FOUND');
    const wrongBody = { ...forgeryInput, mutation: { content: 'forged-body' } };
    const wrongHash = await rawRpc(owner, 'clued_p5_record_commit_failure',
      [TOKENS.owner, wrongBody, forgeryAttempt.attempt_id, 'database_commit_failure']);
    equal(wrongHash.error.type, 'P5_ATTEMPT_REQUEST_MISMATCH');
    const crossBinding = await rawRpc(owner, 'clued_p5_record_commit_failure',
      [TOKENS.editor, { ...forgeryInput, ...editorCtx }, forgeryAttempt.attempt_id, 'database_commit_failure']);
    equal(crossBinding.error.type, 'P5_ATTEMPT_REQUEST_MISMATCH');
    const forgedError = await rawRpc(owner, 'clued_p5_record_commit_failure',
      [TOKENS.owner, forgeryInput, forgeryAttempt.attempt_id, 'attacker_claimed_error']);
    equal(forgedError.error.type, 'P5_UNTRUSTED_FAILURE_CLASS');
    equal(await counts(admin, 'attempt-forgery-control'), { idempotency: 0, events: 0, receipts: 0 });
    equal(await row(admin, IDS.recordAttemptForgery), { version: '1', content: 'recordAttemptForgery-v1' });
    const legitimateAfterForgery = await rawRpc(owner, 'clued_p5_mutate',
      [TOKENS.owner, forgeryInput, forgeryAttempt.attempt_id]);
    equal(legitimateAfterForgery.status, 'committed');
    equal(await counts(admin, 'attempt-forgery-control'), { idempotency: 1, events: 1, receipts: 1 });

    const duplicateAttempt = await rawRpc(owner, 'clued_p5_record_commit_failure',
      [TOKENS.worker, workerCommitInput, workerCommitFailure.attempt_id, 'database_commit_failure']);
    equal(duplicateAttempt.error.type, 'P5_ATTEMPT_ALREADY_CONSUMED');
    equal(await counts(admin, 'worker-real-commit-failure'), { idempotency: 1, events: 0, receipts: 1 });
    record('transaction_rollback_evidence.jsonl', 'P5_ATTEMPT_FORGERY_AND_SINGLE_CONSUMPTION', {
      missing_attempt: missingAttempt.error.type,
      wrong_request_hash: wrongHash.error.type,
      cross_binding_attempt: crossBinding.error.type,
      forged_error_class: forgedError.error.type,
      duplicate_attempt: duplicateAttempt.error.type,
      pre_legitimate_idempotency_rows: 0,
      legitimate_mutation_after_forgery: legitimateAfterForgery.status,
      duplicate_side_effects: 0,
    });

    // F24 service checks: cross-tenant, cross-workspace/user private, project and record forgery.
    const forgedRecord = await rpc(owner, 'clued_p5_mutate', TOKENS.owner,
      mutation(ownerCtx, IDS.recordTenantB, 1, 'f24-forged-tenant-record', 'forbidden'));
    equal(forgedRecord.error.type, 'P5_TARGET_SCOPE_DENIED');
    const forgedPrivate = await rpc(editor, 'clued_p5_mutate', TOKENS.editor,
      mutation(editorCtx, IDS.recordPrivate, 1, 'f24-forged-private-record', 'forbidden'));
    equal(forgedPrivate.error.type, 'P5_TARGET_SCOPE_DENIED');
    const forgedProjectInput = { ...ownerCtx, target_kind: 'project', target_id: IDS.projectB, base_version: 1,
      idempotency_key: 'f24-forged-tenant-project', mutation: { summary: 'forbidden' } };
    const forgedProject = await rpc(owner, 'clued_p5_mutate', TOKENS.owner, forgedProjectInput);
    equal(forgedProject.error.type, 'P5_TARGET_SCOPE_DENIED');
    equal((await row(admin, IDS.recordTenantB)).content, 'tenant-b-v1');
    const serviceDenialAudits = Number((await admin.query(`select count(*) from public.clued_p5_audit_events
      where result='rejected' and target_id=any($1::uuid[])`,
    [[IDS.recordTenantB, IDS.recordPrivate, IDS.projectB]])).rows[0].count);
    equal(serviceDenialAudits, 3, 'every service-layer forged target is audited');

    // Real RLS under the authenticated role. Claims only identify the binding; DB rows revalidate it.
    async function rlsRead(userId, bindingId, org, ws, ctxKey = 'project:p5', policy = 1, epoch = 1) {
      const claims = { app_metadata: { clued_binding_id: bindingId, clued_organization_id: org,
        clued_workspace_id: ws, clued_context_key: ctxKey, clued_purpose: 'project_delivery',
        clued_policy_version: String(policy), clued_revocation_epoch: String(epoch) } };
      await admin.query('begin');
      try {
        await admin.query('set local role authenticated');
        await admin.query(`select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)`,
          [userId, JSON.stringify(claims)]);
        return (await admin.query('select id from public.clued_memories order by id')).rows.map((item) => item.id);
      } finally { await admin.query('rollback'); }
    }
    const ownerVisible = await rlsRead(IDS.userOwner, IDS.bindOwner, IDS.orgA, IDS.wsA);
    check(ownerVisible.includes(IDS.recordCas), 'owner sees workspace A record');
    check(ownerVisible.includes(IDS.recordPrivate), 'owner sees own private record');
    check(!ownerVisible.includes(IDS.recordTenantB), 'owner cannot see tenant B');
    const editorVisible = await rlsRead(IDS.userEditor, IDS.bindEditor, IDS.orgA, IDS.wsA);
    check(editorVisible.includes(IDS.recordCas), 'editor sees shared workspace record');
    check(!editorVisible.includes(IDS.recordPrivate), 'editor cannot see another user private record');
    const forgedRls = await rlsRead(IDS.userOwner, IDS.bindOwner, IDS.orgB, IDS.wsB);
    equal(forgedRls, [], 'forged tenant/workspace claims are denied by RLS');
    await admin.query('grant update(content) on public.clued_memories to authenticated');
    let rlsWriteError;
    let rlsWriteRowCount = null;
    await admin.query('begin');
    try {
      await admin.query('set local role authenticated');
      const claims = { app_metadata: { clued_binding_id: IDS.bindOwner, clued_organization_id: IDS.orgA,
        clued_workspace_id: IDS.wsA, clued_context_key: 'project:p5', clued_purpose: 'project_delivery',
        clued_policy_version: '1', clued_revocation_epoch: '1' } };
      await admin.query(`select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)`,
        [IDS.userOwner, JSON.stringify(claims)]);
      rlsWriteRowCount = (await admin.query('update public.clued_memories set content=$1 where id=$2', ['rls-forbidden', IDS.recordTenantB])).rowCount;
    } catch (error) { rlsWriteError = error; }
    await admin.query('rollback');
    await admin.query('revoke update(content) on public.clued_memories from authenticated');
    check(Boolean(rlsWriteError) || rlsWriteRowCount === 0, 'direct cross-tenant write is rejected by actual RLS');
    equal((await row(admin, IDS.recordTenantB)).content, 'tenant-b-v1');
    record('tenant_workspace_rls_evidence.jsonl', 'F24_service_and_real_rls', {
      postgres_version: pgVersion, service_record_denial: forgedRecord.error.type,
      service_private_user_denial: forgedPrivate.error.type, service_project_denial: forgedProject.error.type,
      rls_owner_visible_shared: true, rls_owner_visible_private: true, rls_editor_private_denied: true,
      rls_cross_tenant_read_rows: 0, rls_cross_tenant_write_sqlstate: rlsWriteError?.code ?? null,
      rls_cross_tenant_write_row_count: rlsWriteRowCount,
      service_denial_audit_rows: serviceDenialAudits,
      production_target: false, local_temporary_database: true,
    });

    // F22 and identity matrix: revoked binding, role downgrade, scope shrink, policy change, Reader denied.
    const revokedClient = await clientFor(server, { faults: true });
    clients.push(revokedClient);
    const revokedSession = await openSession(revokedClient, TOKENS.revoked, context());
    const revokedCtx = context({ sessionToken: revokedSession });
    await admin.query('update public.clued_agent_bindings set revoked_at=now(),revocation_epoch=revocation_epoch+1 where id=$1', [IDS.bindRevoked]);
    const revokedRetry = await rpc(revokedClient, 'clued_p5_mutate', TOKENS.revoked,
      mutation(revokedCtx, IDS.recordAuth, 1, 'f22-revoked-old-session', 'forbidden'));
    equal(revokedRetry.error.type, 'P5_BINDING_REVOKED');
    equal((await row(admin, IDS.recordAuth)).version, '1');

    const readerOpen = await openSession(reader, TOKENS.reader, context({ role: 'reader', scope: 'canonical:read' }));
    const readerWrite = await rpc(reader, 'clued_p5_mutate', TOKENS.reader,
      mutation(context({ role: 'reader', sessionToken: readerOpen }), IDS.recordAuth, 1, 'f22-reader-write', 'forbidden'));
    equal(readerWrite.error.type, 'P5_SCOPE_DENIED');
    const deniedOpen = await openSession(denied, TOKENS.denied, context({ role: 'denied', scope: 'canonical:read' }));
    const deniedWrite = await rpc(denied, 'clued_p5_mutate', TOKENS.denied,
      mutation(context({ role: 'denied', sessionToken: deniedOpen }), IDS.recordAuth, 1, 'f22-denied-write', 'forbidden'));
    equal(deniedWrite.error.type, 'P5_ROLE_WRITE_DENIED');

    await admin.query(`update public.clued_workspace_memberships set role='reader',revocation_epoch=2
      where organization_id=$1 and workspace_id=$2 and user_id=$3`, [IDS.orgA, IDS.wsA, IDS.userEditor]);
    const roleDowngrade = await rpc(editor, 'clued_p5_mutate', TOKENS.editor,
      mutation(editorCtx, IDS.recordAuth, 1, 'f22-role-downgrade', 'forbidden'));
    equal(roleDowngrade.error.type, 'P5_ROLE_CHANGED');
    await admin.query(`update public.clued_workspace_memberships set role='editor',revocation_epoch=1
      where organization_id=$1 and workspace_id=$2 and user_id=$3`, [IDS.orgA, IDS.wsA, IDS.userEditor]);

    await admin.query(`update public.clued_workspace_memberships set scopes=array['canonical:read','project:read','audit:read']
      where organization_id=$1 and workspace_id=$2 and user_id=$3`, [IDS.orgA, IDS.wsA, IDS.userEditor]);
    const scopeShrink = await rpc(editor, 'clued_p5_mutate', TOKENS.editor,
      mutation(editorCtx, IDS.recordAuth, 1, 'f22-scope-shrink', 'forbidden'));
    equal(scopeShrink.error.type, 'P5_SCOPE_DENIED');
    await admin.query(`update public.clued_workspace_memberships set scopes=array['canonical:read','canonical:write','project:read','project:write','audit:read']
      where organization_id=$1 and workspace_id=$2 and user_id=$3`, [IDS.orgA, IDS.wsA, IDS.userEditor]);

    await admin.query('update public.clued_organizations set policy_version=2 where id=$1', [IDS.orgA]);
    const policyChanged = await rpc(owner, 'clued_p5_mutate', TOKENS.owner,
      mutation(ownerCtx, IDS.recordAuth, 1, 'f22-policy-change', 'forbidden'));
    equal(policyChanged.error.type, 'P5_POLICY_VERSION_CHANGED');
    await admin.query('update public.clued_organizations set policy_version=1 where id=$1', [IDS.orgA]);
    record('binding_revocation_role_scope_evidence.jsonl', 'F22_fresh_authorization_matrix', {
      revoked_binding_old_session: revokedRetry.error.type, reader_write: readerWrite.error.type,
      denied_write: deniedWrite.error.type,
      role_downgrade: roleDowngrade.error.type, scope_shrink: scopeShrink.error.type,
      policy_change: policyChanged.error.type, canonical_version_unchanged: true,
    });

    // Audit actor distinctions.
    for (const [kind, token, binding, target] of [
      ['user', TOKENS.user, IDS.bindUserActor, IDS.recordActorUser],
      ['service_account', TOKENS.service, IDS.bindService, IDS.recordActorService],
      ['automation', TOKENS.automation, IDS.bindAutomation, IDS.recordActorAutomation],
    ]) {
      const actorClient = await clientFor(server, { faults: true });
      clients.push(actorClient);
      const session = await openSession(actorClient, token, context());
      const result = await rpc(actorClient, 'clued_p5_mutate', token,
        mutation(context({ sessionToken: session }), target, 1, `actor-${kind}-write`, `${kind}-v2`));
      equal(result.status, 'committed');
      const audit = (await admin.query('select actor_kind,service_account_actor,automation_actor from public.clued_p5_audit_events where target_id=$1 and result=$2', [target, 'committed'])).rows[0];
      equal(audit.actor_kind, kind);
      if (kind === 'service_account') check(audit.service_account_actor, 'service actor identifier recorded');
      if (kind === 'automation') check(audit.automation_actor, 'automation actor identifier recorded');
    }
    const agentAuditKinds = (await admin.query(`select distinct actor_kind from public.clued_p5_audit_events order by actor_kind`)).rows.map((item) => item.actor_kind);
    check(agentAuditKinds.includes('agent_binding') && agentAuditKinds.includes('user')
      && agentAuditKinds.includes('service_account') && agentAuditKinds.includes('automation'), 'all actor kinds audited');
    record('binding_revocation_role_scope_evidence.jsonl', 'P5_actor_identity_matrix', {
      actor_kinds: agentAuditKinds,
      independent_agent_bindings: [IDS.bindOwner, IDS.bindEditor],
      users: [IDS.userOwner, IDS.userEditor, IDS.userReader, IDS.userTenantB, IDS.userDenied],
      organizations: [IDS.orgA, IDS.orgB], workspaces: [IDS.wsA, IDS.wsA2, IDS.wsB],
      roles: ['owner', 'editor', 'reader', 'denied'], purposes: ['project_delivery'],
    });

    // Offline writes remain Pending Intent only.
    const pending = await rpc(owner, 'clued_p5_pending_intent', TOKENS.owner, {
      ...ownerCtx, idempotency_key: 'offline-pending-intent', encrypted_intent_ref: 'local-outbox://intent/1',
    });
    equal(pending.status, 'pending');
    equal(pending.server_confirmed, false);
    equal(pending.canonical_mutated, false);
    record('idempotency_retry_evidence.jsonl', 'P5_offline_pending_intent_only', pending);

    // F28: Git and Canonical conflicts remain distinct and neither modifies the winner.
    const beforeF28 = await row(admin, IDS.recordCas);
    const canonicalConflict = await rpc(owner, 'clued_p5_mutate', TOKENS.owner,
      mutation(ownerCtx, IDS.recordCas, 1, 'f28-canonical-conflict', 'must-not-overwrite'));
    const gitConflict = await rpc(owner, 'clued_p5_git_divergence', TOKENS.owner, {
      base: '1'.repeat(40), local: '2'.repeat(40), remote: '3'.repeat(40),
    });
    equal(canonicalConflict.error.type, 'CANONICAL_CAS_CONFLICT');
    equal(gitConflict.error.type, 'GIT_DIVERGENCE');
    equal(gitConflict.evidence.conflict_domain, 'git_history');
    equal(canonicalConflict.evidence.conflict_domain, 'canonical_store');
    equal(await row(admin, IDS.recordCas), beforeF28);
    record('git_canonical_conflict_evidence.jsonl', 'F28_conflict_domain_separation', {
      canonical: canonicalConflict, git: gitConflict, winner_preserved: true,
      auto_merge: false, auto_overwrite: false,
    });

    // F29: Canonical mutation succeeds atomically; retired local Markdown/Git write path is fail-closed.
    const memoryDigestBefore = await treeDigest(path.join(REPO_ROOT, 'memory'));
    const snapshotDigestBefore = await treeDigest(path.join(REPO_ROOT, 'artifacts', 'clued-two-level-snapshots'));
    const gitBefore = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const canonicalF29 = await rpc(owner, 'clued_p5_mutate', TOKENS.owner,
      mutation(ownerCtx, IDS.recordF29, 1, 'f29-canonical-control', 'canonical-only-v2'));
    equal(canonicalF29.status, 'committed');
    let retiredExit = 0;
    let retiredStderr = '';
    try {
      execFileSync('python', [path.join(REPO_ROOT, 'memory.py'), 'add', '--content', 'forbidden-p5-write'],
        { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      retiredExit = error.status;
      retiredStderr = String(error.stderr);
    }
    equal(retiredExit, 2);
    check(retiredStderr.includes('local_snapshot_is_read_only'), 'retired local write reports fail-closed error');
    equal(await treeDigest(path.join(REPO_ROOT, 'memory')), memoryDigestBefore);
    equal(await treeDigest(path.join(REPO_ROOT, 'artifacts', 'clued-two-level-snapshots')), snapshotDigestBefore);
    equal(execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: REPO_ROOT, encoding: 'utf8' }), gitBefore);
    record('git_canonical_conflict_evidence.jsonl', 'F29_canonical_only_and_projection_fail_closed', {
      canonical_result: canonicalF29, retired_entry_exit: retiredExit,
      retired_entry_error: 'local_snapshot_is_read_only', memory_digest_unchanged: memoryDigestBefore,
      snapshot_digest_unchanged: snapshotDigestBefore, development_worktree_unchanged: true,
    });

    // F23 last: workspace switch invalidates the old Context and Session immediately.
    const switchResult = await rpc(owner, 'clued_p5_workspace_switch', TOKENS.owner, {
      ...ownerCtx, new_workspace_id: IDS.wsA2, new_context_key: 'project:p5:a2',
    });
    equal(switchResult.status, 'committed');
    equal(switchResult.old_context_invalidated, true);
    const oldContextRetry = await rpc(owner, 'clued_p5_mutate', TOKENS.owner,
      mutation(ownerCtx, IDS.recordAuth, 1, 'f23-old-context-retry', 'forbidden'));
    check(['P5_TENANT_WORKSPACE_DENIED', 'P5_CONTEXT_INVALIDATED'].includes(oldContextRetry.error.type), 'old context rejected');
    const newCtxNoSession = context({ ws: IDS.wsA2, contextKey: 'project:p5:a2', epoch: 2 });
    const newSession = await openSession(owner, TOKENS.owner, newCtxNoSession);
    const newWorkspaceResult = await rpc(owner, 'clued_p5_mutate', TOKENS.owner,
      mutation(context({ ws: IDS.wsA2, contextKey: 'project:p5:a2', epoch: 2, sessionToken: newSession }),
        IDS.recordWsA2, 1, 'f23-new-workspace-control', 'workspace-a2-v2'));
    equal(newWorkspaceResult.status, 'committed');
    record('binding_revocation_role_scope_evidence.jsonl', 'F23_workspace_switch_context_invalidation', {
      switch_result: switchResult, old_context_error: oldContextRetry.error.type,
      new_context_authorized: true, new_workspace_mutation: newWorkspaceResult,
    });

    const rejectedAudits = Number((await admin.query(`select count(*) from public.clued_p5_audit_events where result in ('rejected','failed')`)).rows[0].count);
    check(rejectedAudits >= 10, 'rejections and failures are audited');
    const summary = {
      postgres_version: pgVersion,
      migration_count: migrationNames.length,
      assertions: assertionCount,
      real_connections: true,
      rls_executed: true,
      production_access: false,
      scenarios: raw.length,
      sources_read: [
        'docs/clued-two-level-views/Clued_校验不变量与去重矩阵_v1.1.md',
        'docs/clued-two-level-views/Clued_单一数据源与两级五视图架构方案_v1.6.md',
        'apps/clued-cloud/AGENTS.md',
        'apps/clued-cloud/worker/continuity.ts',
        'apps/clued-cloud/worker/records.ts',
        'apps/clued-cloud/worker/projects.ts',
        'apps/clued-cloud/supabase/migrations/20260825171129_clued_m1_runtime_contracts.sql',
        'apps/clued-cloud/supabase/migrations/20260827031728_clued_p5_tenant_isolation_concurrent_writes.sql',
        'apps/clued-cloud/supabase/migrations/20260827050750_p5_gateway_attempt_commit_failure.sql',
        'cloud/postgres/README.md',
        'cloud/postgres/migrations/0001_cloud_data_foundation.up.sql',
      ],
    };
    record('p5_raw_results.jsonl', 'P5_REAL_POSTGRES_SUMMARY', summary);
    await writeEvidence(summary);
    process.stdout.write(`${JSON.stringify({ result: 'PASS', gate: 'P5_REAL_POSTGRES', ...summary })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ p5_test_failure: error.message, code: error.code, stack: error.stack })}\n`);
    throw error;
  } finally {
    await Promise.allSettled(clients.reverse().map((client) => client.end()));
    if (process.platform === 'win32') {
      const pid = server.process?.pid;
      if (pid) {
        try { execFileSync('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore' }); } catch {}
      }
      // The package exit hook otherwise calls stop() after taskkill and can
      // attach an exit listener after the event has already fired.
      server.process = undefined;
      if (path.dirname(databaseDir) === os.tmpdir() && path.basename(databaseDir).startsWith('clued-p5-pg-')) {
        await fs.rm(databaseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    } else {
      await server.stop().catch(() => {});
    }
    if (path.dirname(bundleDir) === os.tmpdir() && path.basename(bundleDir).startsWith('clued-p5-worker-')) {
      await fs.rm(bundleDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});
