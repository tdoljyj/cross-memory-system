import { stopCluster, removeTestDirectory } from './cluster-cleanup.mjs';
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
import { build, stop as stopEsbuild } from 'esbuild';
import { presentCluedLogCard } from '../app/record-presentation.ts';
import { allowRawTestBindings } from './raw-binding-grants-fixture.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_ROOT = path.resolve(TEST_DIR, '..');
const REPO_ROOT = path.resolve(CLOUD_ROOT, '..', '..');
const MIGRATIONS = path.join(CLOUD_ROOT, 'supabase', 'migrations');
const PR8_LOG_MIGRATION = '20260828125643_clued_log_card_api_contract_v12.sql';
const LOG_ISOLATION_FORWARD_MIGRATION = '20260829091757_clued_log_isolation_forward_fix.sql';
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
  recordWorkerConcurrent: '50000000-0000-4000-8000-000000000024',
  recordWorkerFailedConcurrent: '50000000-0000-4000-8000-000000000025',
  recordWorkerLostResponse: '50000000-0000-4000-8000-000000000026',
  recordWorkerPayloadConflict: '50000000-0000-4000-8000-000000000027',
  recordWorkerLegacyRace: '50000000-0000-4000-8000-000000000028',
  recordAttemptExpired: '50000000-0000-4000-8000-000000000029',
  recordAttemptMissingResult: '50000000-0000-4000-8000-000000000030',
  recordAttemptExpiredConcurrent: '50000000-0000-4000-8000-000000000031',
  recordAttemptExpiryLockRace: '50000000-0000-4000-8000-000000000032',
  recordAttemptLinearCommitted: '50000000-0000-4000-8000-000000000033',
  recordAttemptLinearFailed: '50000000-0000-4000-8000-000000000034',
  recordAttemptLinearReexpired: '50000000-0000-4000-8000-000000000035',
  recordAttemptLinearCrossBinding: '50000000-0000-4000-8000-000000000036',
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

function deployedProductionPr8Sql(repairedMigrationSql) {
  const repairedJoin = `left join public.clued_project_resolution_v2 r
        on r.user_id=e.user_id
       and r.source_project_id=(substring(
             e.event_scope
             from '^project:([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$'
           ))::uuid`;
  const deployedJoin = `left join public.clued_project_resolution_v2 r
        on r.user_id=e.user_id and r.source_project_id=e.project_id`;
  const repairedFilter = `where e.user_id=p_user_id
        and e.audit_visibility='work_log'
        and (
          (v_level='global' and e.event_scope='global')
          or (v_level='project' and r.effective_project_id=v_effective_project_id)
        )`;
  const deployedFilter = `where e.user_id=p_user_id
        and (v_level='global' or coalesce(r.effective_project_id,e.project_id)=v_effective_project_id)`;
  const deployedSql = repairedMigrationSql
    .replace(repairedJoin, deployedJoin)
    .replace(repairedFilter, deployedFilter);
  check(deployedSql !== repairedMigrationSql
    && deployedSql.includes('coalesce(r.effective_project_id,e.project_id)=v_effective_project_id'),
  'production PR8 fixture restores the already-deployed vulnerable function definition');
  return deployedSql;
}

async function recordListFunctionIdentity(client) {
  return (await client.query(`select p.oid::text as oid,
    md5(pg_get_functiondef(p.oid)) as definition_md5,
    pg_get_functiondef(p.oid) as definition,
    has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
    has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='clued_private' and p.proname='record_list_core'
      and pg_get_function_identity_arguments(p.oid)='p_user_id uuid, p_input jsonb'`)).rows[0];
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
  const pr8Index = names.indexOf(PR8_LOG_MIGRATION);
  const forwardIndex = names.indexOf(LOG_ISOLATION_FORWARD_MIGRATION);
  check(pr8Index >= 0 && forwardIndex > pr8Index,
    'forward log-isolation migration sorts after the already-applied PR8 migration');
  let productionBefore;
  let upgradedAfter;
  for (const name of names) {
    if (name === LOG_ISOLATION_FORWARD_MIGRATION) {
      const repairedPr8Sql = await fs.readFile(path.join(MIGRATIONS, PR8_LOG_MIGRATION), 'utf8');
      await client.query(deployedProductionPr8Sql(repairedPr8Sql));
      productionBefore = await recordListFunctionIdentity(client);
      check(productionBefore.definition.includes('coalesce(r.effective_project_id,e.project_id)=v_effective_project_id')
        && !productionBefore.definition.includes("e.audit_visibility = 'work_log'")
        && !productionBefore.definition.includes("e.audit_visibility='work_log'"),
      'pre-upgrade database has the production PR8 log-isolation defect');
    }
    await client.query(await fs.readFile(path.join(MIGRATIONS, name), 'utf8'));
    if (name === LOG_ISOLATION_FORWARD_MIGRATION) upgradedAfter = await recordListFunctionIdentity(client);
  }
  await allowRawTestBindings(client);
  check(productionBefore && upgradedAfter, 'upgrade probe observed both production-old and forward-migrated definitions');
  equal(upgradedAfter.oid, productionBefore.oid,
    'forward migration replaces record_list_core in place without changing its identity');
  check(upgradedAfter.definition_md5 !== productionBefore.definition_md5
    && (upgradedAfter.definition.includes("e.audit_visibility = 'work_log'")
      || upgradedAfter.definition.includes("e.audit_visibility='work_log'")),
  'forward migration replaces the production-old function with the work_log filter');
  equal({ anon_execute: upgradedAfter.anon_execute, authenticated_execute: upgradedAfter.authenticated_execute },
    { anon_execute: false, authenticated_execute: false },
    'forward migration keeps the private core unavailable to Data API roles');
  return {
    names,
    logIsolationUpgrade: {
      from: PR8_LOG_MIGRATION,
      through: LOG_ISOLATION_FORWARD_MIGRATION,
      function_oid_preserved: upgradedAfter.oid === productionBefore.oid,
      definition_replaced: upgradedAfter.definition_md5 !== productionBefore.definition_md5,
      data_api_execute_revoked: !upgradedAfter.anon_execute && !upgradedAfter.authenticated_execute,
    },
  };
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

async function waitForDatabasePause(client, applicationName) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const paused = (await client.query(`select exists(
      select 1 from pg_stat_activity
       where application_name=$1 and wait_event_type='Lock' and wait_event='advisory'
    ) as paused`, [applicationName])).rows[0].paused;
    if (paused) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
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
    // This fixture imports the bundle in Node; Worker compatibility is tested
    // separately by the workerd runtime suite.
    platform: 'node',
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function concurrentAttemptBarrier(expected = 2) {
  const beginGate = deferred();
  const mutateGate = deferred();
  const failureClosedGate = deferred();
  const firstMutationCompletedGate = deferred();
  const beginResults = [];
  const mutateRequests = [];
  return {
    async afterAttemptBegin(result) {
      beginResults.push(result);
      if (beginResults.length === expected) {
        try {
          equal(beginResults.map((item) => item.status), Array(expected).fill('open'),
            'all concurrent Worker attempt_begin calls complete with an open Attempt');
          equal(new Set(beginResults.map((item) => item.attempt_id)).size, 1,
            'all concurrent Worker attempt_begin calls share one Attempt');
          beginGate.resolve();
        } catch (error) {
          beginGate.reject(error);
          throw error;
        }
      }
      await beginGate.promise;
    },
    async beforeMutate(body) {
      mutateRequests.push(body);
      const ordinal = mutateRequests.length;
      if (ordinal === expected) {
        try {
          equal(new Set(mutateRequests.map((item) => item.p_attempt_id)).size, 1,
            'both Worker mutate calls use the shared open Attempt');
          equal(mutateRequests[0].p_attempt_id, beginResults[0].attempt_id,
            'mutate cannot pass the barrier before both attempt_begin calls finish');
          mutateGate.resolve();
        } catch (error) {
          mutateGate.reject(error);
          throw error;
        }
      }
      await mutateGate.promise;
      return ordinal;
    },
    markFailureClosed() { failureClosedGate.resolve(); },
    async waitForFailureClosed() { await failureClosedGate.promise; },
    markFirstMutationCompleted() { firstMutationCompletedGate.resolve(); },
    async waitForFirstMutationCompleted() { await firstMutationCompletedGate.promise; },
    snapshot() {
      return {
        attempt_id: beginResults[0]?.attempt_id ?? null,
        begin_count: beginResults.length,
        mutate_count: mutateRequests.length,
        shared_open_attempt: beginResults.length === expected
          && new Set(beginResults.map((item) => item.attempt_id)).size === 1,
      };
    },
  };
}

function postgresGatewayFetch(server, gatewayToken, calls, {
  commitFailureTarget, lostResponseTarget, concurrentBarrier, legacyConsumedTarget,
  pauseAttemptInsertTarget, pauseApplicationName,
} = {}) {
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
      if (rpcName === 'clued_p5_attempt_begin'
          && body.p_input?.target_id === pauseAttemptInsertTarget) {
        await client.query(`select set_config('application_name',$1,false),
          set_config('clued.p5_test_pause_attempt_insert','on',false),
          set_config('clued.p5_test_faults','on',false)`,
        [pauseApplicationName ?? 'p5-attempt-insert-paused']);
      }
      const mutateOrdinal = rpcName === 'clued_p5_mutate' && concurrentBarrier
        ? await concurrentBarrier.beforeMutate(body)
        : null;
      if (rpcName === 'clued_p5_mutate' && body.p_input?.target_id === commitFailureTarget
          && mutateOrdinal && mutateOrdinal > 1) {
        await concurrentBarrier.waitForFailureClosed();
      }
      if (rpcName === 'clued_p5_mutate' && body.p_input?.target_id === legacyConsumedTarget
          && mutateOrdinal && mutateOrdinal > 1) {
        await concurrentBarrier.waitForFirstMutationCompleted();
        return Response.json({ status: 'rejected',
          error: { type: 'P5_ATTEMPT_ALREADY_CONSUMED', sqlstate: 'P0001' } });
      }
      if (rpcName === 'clued_p5_mutate' && body.p_input?.target_id === commitFailureTarget
          && (!mutateOrdinal || mutateOrdinal === 1)) {
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
      if (rpcName === 'clued_p5_attempt_begin' && concurrentBarrier) {
        await concurrentBarrier.afterAttemptBegin(result);
      }
      if (rpcName === 'clued_p5_mutate' && body.p_input?.target_id === legacyConsumedTarget
          && mutateOrdinal === 1) {
        concurrentBarrier.markFirstMutationCompleted();
      }
      if (rpcName === 'clued_p5_record_commit_failure' && concurrentBarrier) {
        concurrentBarrier.markFailureClosed();
      }
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
    result: payload.result?.structuredContent ?? null, rawPayload: payload };
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
    const { names: migrationNames, logIsolationUpgrade } = await applyMigrations(admin);
    await seed(admin);
    const pgVersion = (await admin.query('select version() as version')).rows[0].version;

    await admin.query(`insert into public.clued_context_events(
      id,user_id,context_key,event_type,payload,event_schema_version,
      committed_canonical_version,canonical_event_type,target_refs,event_scope,
      change_summary,result,audit_visibility,evidence_refs,artifact_refs,content_hash
    ) values
      (880580,$1,'global','action','{"canonical_event_type":"production_deployment_completed"}',
        1,580,'production_deployment_completed','[]','global',
        '[{"summary":"97/97 PASS"},{"summary":"build PASS"},{"summary":"healthz 200"}]',
        'success','work_log','{}','[{"kind":"worker_version","id":"version-580"}]',$3),
      (880581,$2,'global','action','{"canonical_event_type":"must_remain_private"}',
        null,null,null,null,null,null,null,null,null,null,null)`,
    [IDS.userOwner, IDS.userTenantB, 'a'.repeat(64)]);
    const logList = (await admin.query(
      `select clued_private.record_list_core($1,'{"level":"global","record_type":"log","limit":200}') as result`,
      [IDS.userOwner],
    )).rows[0].result.records;
    equal(logList.length, 1, 'log list keeps another tenant event isolated');
    equal(logList[0].canonical_event_type, 'production_deployment_completed');
    equal(logList[0].change_summary[2].summary, 'healthz 200');
    equal(logList[0].committed_canonical_version, 580);
    const logCard = presentCluedLogCard(logList[0], '日志', 'zh-CN');
    equal(logCard.title, '日志可读化版本已部署');
    equal(logCard.summary, '97/97 项验证通过；构建通过；健康检查返回 200。');
    equal(logCard.tone, 'success');
    check(logCard.evidence.some((line) => line.value.includes('version-580')),
      'database artifact references reach the readable log card');
    record('log_isolation_upgrade_evidence.jsonl', 'production_PR8_to_forward_migration', {
      ...logIsolationUpgrade,
      post_upgrade_global_isolation: logList.length === 1,
      post_upgrade_expected_event: logList[0].canonical_event_type,
    });
    await admin.query('delete from public.clued_context_events where id in (880580,880581)');

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
    let workerCtx;
    try {
      workerSessionResult = (await workerTool(handleContinuityRequest, workerEnv, RAW_WORKER_BINDING_TOKEN,
        'clued_p5_session_open', context())).result;
      equal(workerSessionResult.status, 'authorized');
      workerCtx = context({ sessionToken: workerSessionResult.session_token });
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

    // F16 second-review regression: both real Worker requests must finish
    // attempt_begin with the same open Attempt before either mutate is allowed
    // to execute. A second barrier then releases both PostgreSQL mutations to
    // contend on the Attempt row lock.
    const committedBarrier = concurrentAttemptBarrier();
    const committedGatewayCalls = [];
    const workerConcurrentInput = mutation(workerCtx, IDS.recordWorkerConcurrent, 1,
      'worker-concurrent-shared-attempt', 'worker-concurrent-v2');
    globalThis.fetch = postgresGatewayFetch(server, gatewayToken, committedGatewayCalls,
      { concurrentBarrier: committedBarrier });
    let workerConcurrentA;
    let workerConcurrentB;
    try {
      [workerConcurrentA, workerConcurrentB] = await Promise.all([
        workerTool(handleContinuityRequest, workerEnv, RAW_WORKER_BINDING_TOKEN,
          'clued_p5_mutate', workerConcurrentInput),
        workerTool(handleContinuityRequest, workerEnv, RAW_WORKER_BINDING_TOKEN,
          'clued_p5_mutate', workerConcurrentInput),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const committedBarrierState = committedBarrier.snapshot();
    equal(committedBarrierState.begin_count, 2);
    equal(committedBarrierState.mutate_count, 2);
    equal(committedBarrierState.shared_open_attempt, true);
    equal(workerConcurrentA.httpStatus, 200);
    equal(workerConcurrentB.httpStatus, 200);
    equal(workerConcurrentA.rpcError, null);
    equal(workerConcurrentB.rpcError, null);
    equal(workerConcurrentA.result, workerConcurrentB.result,
      'concurrent Worker retries return the identical canonical result');
    equal(workerConcurrentA.result.status, 'committed');
    equal(await row(admin, IDS.recordWorkerConcurrent),
      { version: '2', content: 'worker-concurrent-v2' });
    equal(await counts(admin, 'worker-concurrent-shared-attempt'),
      { idempotency: 1, events: 1, receipts: 1 });
    const completedAttemptRow = (await admin.query(`select status,canonical_result
      from public.clued_p5_gateway_attempts where id=$1`,
    [committedBarrierState.attempt_id])).rows[0];
    equal(completedAttemptRow.status, 'completed');
    equal(completedAttemptRow.canonical_result, workerConcurrentA.result);
    check(!JSON.stringify([workerConcurrentA.rawPayload, workerConcurrentB.rawPayload])
      .includes('P5_ATTEMPT_ALREADY_CONSUMED'), 'legal Worker retry never exposes consumed Attempt error');
    record('worker_concurrent_attempt_replay_evidence.jsonl',
      'F16_WORKER_SHARED_OPEN_ATTEMPT_COMMITTED_REPLAY', {
        barrier: committedBarrierState,
        gateway_call_sequence: committedGatewayCalls,
        responses_identical: true,
        response_a: workerConcurrentA.result,
        response_b: workerConcurrentB.result,
        canonical_version: 2,
        mutation_count: 1,
        event_count: 1,
        receipt_count: 1,
        idempotency_count: 1,
        attempt_already_consumed_exposed: false,
        production_access: false,
      });

    // Failed Attempt replay uses the same begin/mutate barriers. The second
    // mutation has already reached the Gateway before the first Worker's real
    // deferred commit failure is resolved and atomically frozen as failed.
    const failedBarrier = concurrentAttemptBarrier();
    const failedGatewayCalls = [];
    const workerFailedInput = mutation(workerCtx, IDS.recordWorkerFailedConcurrent, 1,
      'worker-concurrent-failed-attempt', 'must-rollback');
    globalThis.fetch = postgresGatewayFetch(server, gatewayToken, failedGatewayCalls, {
      concurrentBarrier: failedBarrier,
      commitFailureTarget: IDS.recordWorkerFailedConcurrent,
    });
    let workerFailedA;
    let workerFailedB;
    try {
      [workerFailedA, workerFailedB] = await Promise.all([
        workerTool(handleContinuityRequest, workerEnv, RAW_WORKER_BINDING_TOKEN,
          'clued_p5_mutate', workerFailedInput),
        workerTool(handleContinuityRequest, workerEnv, RAW_WORKER_BINDING_TOKEN,
          'clued_p5_mutate', workerFailedInput),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const failedBarrierState = failedBarrier.snapshot();
    equal(failedBarrierState, {
      attempt_id: failedBarrierState.attempt_id,
      begin_count: 2,
      mutate_count: 2,
      shared_open_attempt: true,
    });
    equal(workerFailedA.result, workerFailedB.result,
      'concurrent failed Attempt retries return the identical canonical result');
    equal(workerFailedA.result.status, 'failed');
    equal(workerFailedA.result.error.type, 'TRANSACTION_COMMIT_FAILED');
    equal(await row(admin, IDS.recordWorkerFailedConcurrent),
      { version: '1', content: 'recordWorkerFailedConcurrent-v1' });
    equal(await counts(admin, 'worker-concurrent-failed-attempt'),
      { idempotency: 1, events: 0, receipts: 1 });
    const failedAttemptRow = (await admin.query(`select status,canonical_result
      from public.clued_p5_gateway_attempts where id=$1`,
    [failedBarrierState.attempt_id])).rows[0];
    equal(failedAttemptRow.status, 'failed');
    equal(failedAttemptRow.canonical_result, workerFailedA.result);
    check(!JSON.stringify([workerFailedA.rawPayload, workerFailedB.rawPayload])
      .includes('P5_ATTEMPT_ALREADY_CONSUMED'), 'failed legal retry never exposes consumed Attempt error');
    record('worker_concurrent_attempt_replay_evidence.jsonl',
      'F16_WORKER_SHARED_OPEN_ATTEMPT_FAILED_REPLAY', {
        barrier: failedBarrierState,
        gateway_call_sequence: failedGatewayCalls,
        responses_identical: true,
        response_a: workerFailedA.result,
        response_b: workerFailedB.result,
        canonical_version: 1,
        mutation_count: 0,
        event_count: 0,
        receipt_count: 1,
        idempotency_count: 1,
        attempt_already_consumed_exposed: false,
        production_access: false,
      });

    // Exercise the Worker's defensive compatibility path explicitly: an old
    // Gateway returns HTTP 200 + ALREADY_CONSUMED for the second mutation, and
    // the Worker resolves the exact completed Attempt instead of exposing it.
    const legacyBarrier = concurrentAttemptBarrier();
    const legacyGatewayCalls = [];
    const legacyRaceInput = mutation(workerCtx, IDS.recordWorkerLegacyRace, 1,
      'worker-legacy-consumed-race', 'legacy-race-v2');
    globalThis.fetch = postgresGatewayFetch(server, gatewayToken, legacyGatewayCalls, {
      concurrentBarrier: legacyBarrier,
      legacyConsumedTarget: IDS.recordWorkerLegacyRace,
    });
    let legacyRaceA;
    let legacyRaceB;
    try {
      [legacyRaceA, legacyRaceB] = await Promise.all([
        workerTool(handleContinuityRequest, workerEnv, RAW_WORKER_BINDING_TOKEN,
          'clued_p5_mutate', legacyRaceInput),
        workerTool(handleContinuityRequest, workerEnv, RAW_WORKER_BINDING_TOKEN,
          'clued_p5_mutate', legacyRaceInput),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
    equal(legacyRaceA.result, legacyRaceB.result);
    equal(legacyRaceA.result.status, 'committed');
    check(legacyGatewayCalls.includes('clued_p5_attempt_resolve'),
      'Worker resolves HTTP-successful ALREADY_CONSUMED race payload');
    check(!JSON.stringify([legacyRaceA.rawPayload, legacyRaceB.rawPayload])
      .includes('P5_ATTEMPT_ALREADY_CONSUMED'), 'defensive resolve hides legacy consumed error');
    equal(await counts(admin, 'worker-legacy-consumed-race'),
      { idempotency: 1, events: 1, receipts: 1 });
    record('worker_concurrent_attempt_replay_evidence.jsonl',
      'F16_WORKER_DEFENSIVE_ALREADY_CONSUMED_RESOLVE', {
        barrier: legacyBarrier.snapshot(),
        gateway_call_sequence: legacyGatewayCalls,
        responses_identical: true,
        canonical_result: legacyRaceA.result,
        defensive_attempt_resolve: true,
        attempt_already_consumed_exposed: false,
      });

    // A successfully committed response that is lost in transport resolves to
    // the terminal Attempt, and a later full Worker retry replays identically.
    const lostGatewayCalls = [];
    const lostResponseInput = mutation(workerCtx, IDS.recordWorkerLostResponse, 1,
      'worker-first-response-lost', 'lost-response-v2');
    globalThis.fetch = postgresGatewayFetch(server, gatewayToken, lostGatewayCalls,
      { lostResponseTarget: IDS.recordWorkerLostResponse });
    let lostResponseFirst;
    let lostResponseReplay;
    try {
      lostResponseFirst = await workerTool(handleContinuityRequest, workerEnv,
        RAW_WORKER_BINDING_TOKEN, 'clued_p5_mutate', lostResponseInput);
      lostResponseReplay = await workerTool(handleContinuityRequest, workerEnv,
        RAW_WORKER_BINDING_TOKEN, 'clued_p5_mutate', lostResponseInput);
    } finally {
      globalThis.fetch = originalFetch;
    }
    equal(lostResponseFirst.result, lostResponseReplay.result);
    equal(lostResponseFirst.result.status, 'committed');
    equal(await counts(admin, 'worker-first-response-lost'),
      { idempotency: 1, events: 1, receipts: 1 });
    equal((await row(admin, IDS.recordWorkerLostResponse)).version, '2');
    record('worker_concurrent_attempt_replay_evidence.jsonl',
      'F16_WORKER_FIRST_RESPONSE_LOST_REPLAY', {
        gateway_call_sequence: lostGatewayCalls,
        first_response: lostResponseFirst.result,
        replay_response: lostResponseReplay.result,
        responses_identical: true,
        canonical_version: 2,
        mutation_count: 1,
        event_count: 1,
        receipt_count: 1,
        idempotency_count: 1,
      });

    // The same Worker Idempotency Key with a different body remains a payload
    // conflict and never receives the first request's canonical result.
    const payloadConflictCalls = [];
    const payloadConflictA = mutation(workerCtx, IDS.recordWorkerPayloadConflict, 1,
      'worker-same-key-different-body', 'original-worker-body');
    const payloadConflictB = mutation(workerCtx, IDS.recordWorkerPayloadConflict, 1,
      'worker-same-key-different-body', 'forged-worker-body');
    globalThis.fetch = postgresGatewayFetch(server, gatewayToken, payloadConflictCalls);
    let workerPayloadFirst;
    let workerPayloadRejected;
    try {
      workerPayloadFirst = await workerTool(handleContinuityRequest, workerEnv,
        RAW_WORKER_BINDING_TOKEN, 'clued_p5_mutate', payloadConflictA);
      workerPayloadRejected = await workerTool(handleContinuityRequest, workerEnv,
        RAW_WORKER_BINDING_TOKEN, 'clued_p5_mutate', payloadConflictB);
    } finally {
      globalThis.fetch = originalFetch;
    }
    equal(workerPayloadFirst.result.status, 'committed');
    equal(workerPayloadRejected.result.status, 'rejected');
    equal(workerPayloadRejected.result.error.type, 'IDEMPOTENCY_PAYLOAD_CONFLICT');
    equal(await row(admin, IDS.recordWorkerPayloadConflict),
      { version: '2', content: 'original-worker-body' });
    equal(await counts(admin, 'worker-same-key-different-body'),
      { idempotency: 1, events: 1, receipts: 1 });
    record('worker_concurrent_attempt_replay_evidence.jsonl',
      'F17_WORKER_SAME_KEY_DIFFERENT_BODY_REJECTED', {
        committed: workerPayloadFirst.result,
        rejected: workerPayloadRejected.result,
        canonical_result_leaked: false,
        canonical_version: 2,
        canonical_content: 'original-worker-body',
        mutation_count: 1,
        event_count: 1,
        idempotency_count: 1,
      });

    // Terminal replay checks are deliberately forged after completion/failure:
    // mismatch must win over status handling, so no stored result can leak.
    const terminalMismatchCases = [
      ['completed', committedBarrierState.attempt_id, workerConcurrentInput, workerConcurrentA.result],
      ['failed', failedBarrierState.attempt_id, workerFailedInput, workerFailedA.result],
    ];
    for (const [terminalStatus, attemptId, exactInput, canonicalResult] of terminalMismatchCases) {
      const wrongTerminalBody = { ...exactInput, mutation: { content: `forged-${terminalStatus}` } };
      const mismatchedMutate = await rawRpc(owner, 'clued_p5_mutate',
        [TOKENS.worker, wrongTerminalBody, attemptId]);
      const mismatchedResolve = await rawRpc(owner, 'clued_p5_attempt_resolve',
        [TOKENS.worker, wrongTerminalBody, attemptId]);
      const crossBindingInput = { ...exactInput, ...ownerCtx };
      const crossBindingMutate = await rawRpc(owner, 'clued_p5_mutate',
        [TOKENS.owner, crossBindingInput, attemptId]);
      equal(mismatchedMutate.error.type, 'P5_ATTEMPT_REQUEST_MISMATCH');
      equal(mismatchedResolve.error.type, 'P5_ATTEMPT_REQUEST_MISMATCH');
      equal(crossBindingMutate.error.type, 'P5_ATTEMPT_REQUEST_MISMATCH');
      check(!('canonical_result' in mismatchedMutate), `${terminalStatus} mismatch leaks no result`);
      check(!('canonical_result' in mismatchedResolve), `${terminalStatus} resolve mismatch leaks no result`);
      check(!('canonical_result' in crossBindingMutate), `${terminalStatus} cross-Binding leaks no result`);
      check(JSON.stringify(mismatchedMutate) !== JSON.stringify(canonicalResult),
        `${terminalStatus} mismatch is checked before terminal replay`);
      record('worker_concurrent_attempt_replay_evidence.jsonl',
        `P5_${terminalStatus.toUpperCase()}_ATTEMPT_MISMATCH_PRECEDES_REPLAY`, {
          attempt_id: attemptId,
          wrong_body: mismatchedMutate.error.type,
          wrong_body_resolve: mismatchedResolve.error.type,
          cross_binding: crossBindingMutate.error.type,
          canonical_result_leaked: false,
          mismatch_precedes_terminal_status: true,
        });
    }

    // Terminal Attempt TTL invalidates the old capability ID, but a complete
    // retry still replays the permanent Idempotency result. None of the three
    // old-ID entrypoints may release Attempt-local canonical_result.
    for (const [terminalStatus, attemptId, exactInput, canonicalResult] of terminalMismatchCases) {
      await admin.query(`update public.clued_p5_gateway_attempts
        set expires_at=now()-interval '1 second' where id=$1`, [attemptId]);
      const expiredTerminalMutate = await rawRpc(owner, 'clued_p5_mutate',
        [TOKENS.worker, exactInput, attemptId]);
      const expiredTerminalResolve = await rawRpc(owner, 'clued_p5_attempt_resolve',
        [TOKENS.worker, exactInput, attemptId]);
      const expiredTerminalFailure = await rawRpc(owner, 'clued_p5_record_commit_failure',
        [TOKENS.worker, exactInput, attemptId, 'database_commit_failure']);
      for (const response of [expiredTerminalMutate, expiredTerminalResolve, expiredTerminalFailure]) {
        equal(response.error.type, 'P5_ATTEMPT_EXPIRED');
        check(!('canonical_result' in response), `${terminalStatus} expired Attempt ID leaks no result`);
      }
      const fullRetry = await rawRpc(owner, 'clued_p5_attempt_begin', [TOKENS.worker, exactInput]);
      equal(fullRetry.status, 'replayed');
      equal(fullRetry.canonical_result, canonicalResult,
        `${terminalStatus} full retry replays permanent Idempotency result`);
      const terminalRow = (await admin.query(`select status from public.clued_p5_gateway_attempts
        where id=$1`, [attemptId])).rows[0];
      equal(terminalRow.status, terminalStatus,
        `${terminalStatus} audit lifecycle is not overwritten by TTL expiry`);
      record('expired_attempt_reissue_evidence.jsonl',
        `P5_${terminalStatus.toUpperCase()}_ATTEMPT_TTL_ID_INVALID_IDEMPOTENCY_REPLAY`, {
          attempt_id: attemptId,
          attempt_status_preserved: terminalRow.status,
          direct_mutate: expiredTerminalMutate.error.type,
          direct_resolve: expiredTerminalResolve.error.type,
          direct_commit_failure: expiredTerminalFailure.error.type,
          old_attempt_canonical_result_leaked: false,
          full_retry_status: fullRetry.status,
          permanent_idempotency_replay: true,
          canonical_result: fullRetry.canonical_result,
        });
    }

    const expiredInput = mutation(ownerCtx, IDS.recordAttemptExpired, 1,
      'attempt-expired-reissue', 'expired-reissued-v2');
    const expiredAttempt = await rawRpc(owner, 'clued_p5_attempt_begin', [TOKENS.owner, expiredInput]);
    await admin.query(`update public.clued_p5_gateway_attempts set expires_at=now()-interval '1 second'
      where id=$1`, [expiredAttempt.attempt_id]);
    const reissuedAttempt = await rawRpc(owner, 'clued_p5_attempt_begin', [TOKENS.owner, expiredInput]);
    equal(reissuedAttempt.status, 'open');
    check(reissuedAttempt.attempt_id !== expiredAttempt.attempt_id,
      'expired open Attempt is replaced by a distinct open Attempt');
    const expiredAttemptRow = (await admin.query(`select status from public.clued_p5_gateway_attempts
      where id=$1`, [expiredAttempt.attempt_id])).rows[0];
    equal(expiredAttemptRow.status, 'expired');
    const oldExpiredMutation = await rawRpc(owner, 'clued_p5_mutate',
      [TOKENS.owner, expiredInput, expiredAttempt.attempt_id]);
    const oldExpiredResolve = await rawRpc(owner, 'clued_p5_attempt_resolve',
      [TOKENS.owner, expiredInput, expiredAttempt.attempt_id]);
    const oldExpiredFailure = await rawRpc(owner, 'clued_p5_record_commit_failure',
      [TOKENS.owner, expiredInput, expiredAttempt.attempt_id, 'transport_failure']);
    for (const response of [oldExpiredMutation, oldExpiredResolve, oldExpiredFailure]) {
      equal(response.error.type, 'P5_ATTEMPT_EXPIRED');
      check(!('canonical_result' in response), 'expired open Attempt ID leaks no result');
    }
    const reissuedMutation = await rawRpc(owner, 'clued_p5_mutate',
      [TOKENS.owner, expiredInput, reissuedAttempt.attempt_id]);
    equal(reissuedMutation.status, 'committed');
    equal(await row(admin, IDS.recordAttemptExpired),
      { version: '2', content: 'expired-reissued-v2' });
    equal(await counts(admin, 'attempt-expired-reissue'),
      { idempotency: 1, events: 1, receipts: 1 });
    record('expired_attempt_reissue_evidence.jsonl',
      'P5_EXPIRED_OPEN_ATTEMPT_REISSUED', {
        old_attempt_id: expiredAttempt.attempt_id,
        new_attempt_id: reissuedAttempt.attempt_id,
        ids_distinct: true,
        old_attempt_status: expiredAttemptRow.status,
        old_mutate: oldExpiredMutation.error.type,
        old_resolve: oldExpiredResolve.error.type,
        old_commit_failure: oldExpiredFailure.error.type,
        new_attempt_status: reissuedAttempt.status,
        canonical_result: reissuedMutation,
        canonical_version: 2,
        mutation_count: 1,
        event_count: 1,
        receipt_count: 1,
        idempotency_count: 1,
      });

    // Two real Worker retries start from the same expired open Attempt. Both
    // attempt_begin transactions must converge on one replacement Attempt,
    // then the existing row-lock replay path returns one canonical result.
    const expiredConcurrentInput = mutation(workerCtx, IDS.recordAttemptExpiredConcurrent, 1,
      'worker-expired-attempt-reissue', 'expired-concurrent-v2');
    const oldConcurrentAttempt = await rawRpc(owner, 'clued_p5_attempt_begin',
      [TOKENS.worker, expiredConcurrentInput]);
    await admin.query(`update public.clued_p5_gateway_attempts
      set expires_at=now()-interval '1 second' where id=$1`, [oldConcurrentAttempt.attempt_id]);
    const expiredRetryBarrier = concurrentAttemptBarrier();
    const expiredRetryCalls = [];
    globalThis.fetch = postgresGatewayFetch(server, gatewayToken, expiredRetryCalls,
      { concurrentBarrier: expiredRetryBarrier });
    let expiredRetryA;
    let expiredRetryB;
    try {
      [expiredRetryA, expiredRetryB] = await Promise.all([
        workerTool(handleContinuityRequest, workerEnv, RAW_WORKER_BINDING_TOKEN,
          'clued_p5_mutate', expiredConcurrentInput),
        workerTool(handleContinuityRequest, workerEnv, RAW_WORKER_BINDING_TOKEN,
          'clued_p5_mutate', expiredConcurrentInput),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
    const expiredRetryBarrierState = expiredRetryBarrier.snapshot();
    equal(expiredRetryBarrierState.begin_count, 2);
    equal(expiredRetryBarrierState.mutate_count, 2);
    equal(expiredRetryBarrierState.shared_open_attempt, true);
    check(expiredRetryBarrierState.attempt_id !== oldConcurrentAttempt.attempt_id,
      'concurrent retries share a new Attempt rather than the expired ID');
    equal(expiredRetryA.result, expiredRetryB.result);
    equal(expiredRetryA.result.status, 'committed');
    equal(await row(admin, IDS.recordAttemptExpiredConcurrent),
      { version: '2', content: 'expired-concurrent-v2' });
    equal(await counts(admin, 'worker-expired-attempt-reissue'),
      { idempotency: 1, events: 1, receipts: 1 });
    const expiredRetryAttempts = (await admin.query(`select status,count(*)::int as count
      from public.clued_p5_gateway_attempts where idempotency_key=$1 group by status order by status`,
    ['worker-expired-attempt-reissue'])).rows;
    equal(expiredRetryAttempts, [
      { status: 'completed', count: 1 },
      { status: 'expired', count: 1 },
    ]);
    check(!JSON.stringify([expiredRetryA.rawPayload, expiredRetryB.rawPayload])
      .includes('P5_ATTEMPT_UNAVAILABLE'), 'concurrent expired retry never exposes unavailable');
    record('expired_attempt_reissue_evidence.jsonl',
      'P5_TWO_WORKERS_EXPIRED_ATTEMPT_SINGLE_REISSUE', {
        old_attempt_id: oldConcurrentAttempt.attempt_id,
        new_attempt_id: expiredRetryBarrierState.attempt_id,
        barrier: expiredRetryBarrierState,
        gateway_call_sequence: expiredRetryCalls,
        responses_identical: true,
        response_a: expiredRetryA.result,
        response_b: expiredRetryB.result,
        attempt_status_counts: expiredRetryAttempts,
        p5_attempt_unavailable_exposed: false,
        canonical_version: 2,
        mutation_count: 1,
        event_count: 1,
        receipt_count: 1,
        idempotency_count: 1,
        production_access: false,
      });

    // Fourth-review linearization: pause Worker B at the database hook after
    // attempt_begin's final Idempotency read but before the successor INSERT.
    // Worker A then completes the same request. The
    // permanent issuance-parent uniqueness must make B's INSERT conflict even
    // though A changed its Attempt from open to completed/failed.
    const attemptInsertLock = 500050004;
    const workerSessionBResult = await rawRpc(owner, 'clued_p5_session_open',
      [TOKENS.worker, context()]);
    equal(workerSessionBResult.status, 'authorized');
    const workerCtxB = context({ sessionToken: workerSessionBResult.session_token });

    async function runAttemptReissueLinearizationRace({ targetId, key, body, terminalStatus }) {
      const input = mutation(workerCtx, targetId, 1, key, body);
      const workerBInput = mutation(workerCtxB, targetId, 1, key, body);
      const oldAttempt = await rawRpc(owner, 'clued_p5_attempt_begin', [TOKENS.worker, input]);
      equal(oldAttempt.status, 'open');
      await admin.query(`update public.clued_p5_gateway_attempts
        set status='expired',expires_at=now()-interval '1 second' where id=$1`,
      [oldAttempt.attempt_id]);

      const calls = [];
      const pausedApplication = `p5-${terminalStatus}-insert-paused`;
      await admin.query('select pg_advisory_lock($1)', [attemptInsertLock]);
      let workerBPromise;
      let workerA;
      let workerB;
      let pausedAfterFinalRecheck = false;
      let bStayedPausedThroughACommit = false;
      try {
        globalThis.fetch = postgresGatewayFetch(server, gatewayToken, calls, {
          pauseAttemptInsertTarget: targetId,
          pauseApplicationName: pausedApplication,
        });
        workerBPromise = workerTool(handleContinuityRequest, workerEnv, RAW_WORKER_BINDING_TOKEN,
          'clued_p5_mutate', workerBInput);
        pausedAfterFinalRecheck = await waitForDatabasePause(admin, pausedApplication);
        equal(pausedAfterFinalRecheck, true,
          'Worker B pauses inside successor INSERT after the final Idempotency recheck');

        globalThis.fetch = postgresGatewayFetch(server, gatewayToken, calls,
          terminalStatus === 'failed' ? { commitFailureTarget: targetId } : {});
        workerA = await workerTool(handleContinuityRequest, workerEnv, RAW_WORKER_BINDING_TOKEN,
          'clued_p5_mutate', input);
        equal(workerA.result.status, terminalStatus);
        bStayedPausedThroughACommit = await Promise.race([
          workerBPromise.then(() => false),
          new Promise((resolve) => setTimeout(() => resolve(true), 50)),
        ]);
        equal(bStayedPausedThroughACommit, true,
          'Worker B remains before INSERT until Worker A terminal result commits');
      } finally {
        await admin.query('select pg_advisory_unlock($1)', [attemptInsertLock]);
      }
      workerB = await workerBPromise;
      globalThis.fetch = originalFetch;

      equal(workerB.result, workerA.result,
        'Worker B returns the exact canonical result committed by Worker A');
      const attemptCounts = (await admin.query(`select
        count(*) filter (where status='expired')::int as expired,
        count(*) filter (where status='open')::int as open,
        count(*) filter (where status in ('completed','failed'))::int as terminal,
        count(*) filter (where status<>'expired')::int as non_expired
        from public.clued_p5_gateway_attempts
        where binding_id=$1 and idempotency_key=$2`, [IDS.bindWorker, key])).rows[0];
      equal(attemptCounts, { expired: 1, open: 0, terminal: 1, non_expired: 1 });
      const sideEffects = await counts(admin, key);
      equal(sideEffects, terminalStatus === 'committed'
        ? { idempotency: 1, events: 1, receipts: 1 }
        : { idempotency: 1, events: 0, receipts: 1 });
      equal((await row(admin, targetId)).version, terminalStatus === 'committed' ? '2' : '1');
      const lineage = (await admin.query(`select id,status,issuance_parent
        from public.clued_p5_gateway_attempts
        where binding_id=$1 and idempotency_key=$2 order by created_at,id`,
      [IDS.bindWorker, key])).rows;
      equal(lineage.length, 2);
      equal(lineage[1].issuance_parent, oldAttempt.attempt_id,
        'the permanent successor slot is bound to the expired predecessor');
      return {
        runtime_input: input, old_attempt_id: oldAttempt.attempt_id, calls, worker_a: workerA.result,
        worker_b: workerB.result, paused_after_final_idempotency_recheck: pausedAfterFinalRecheck,
        worker_a_committed_while_b_paused: bStayedPausedThroughACommit,
        responses_identical: true, attempt_counts: attemptCounts, lineage,
        ...sideEffects,
      };
    }

    const committedLinearization = await runAttemptReissueLinearizationRace({
      targetId: IDS.recordAttemptLinearCommitted,
      key: 'attempt-reissue-linear-committed',
      body: 'linear-committed-v2',
      terminalStatus: 'committed',
    });
    const { runtime_input: committedRuntimeInput,
      ...committedLinearizationEvidence } = committedLinearization;
    record('attempt_reissue_linearization_evidence.jsonl',
      'P5_REISSUE_INSERT_WINDOW_COMMITTED_LINEARIZED', {
        ...committedLinearizationEvidence,
        canonical_version: 2,
        no_extra_open_attempt: true,
        production_access: false,
      });

    const failedLinearization = await runAttemptReissueLinearizationRace({
      targetId: IDS.recordAttemptLinearFailed,
      key: 'attempt-reissue-linear-failed',
      body: 'must-rollback',
      terminalStatus: 'failed',
    });
    const failedLinearizationEvidence = { ...failedLinearization };
    delete failedLinearizationEvidence.runtime_input;
    check(failedLinearization.calls.includes('clued_p5_attempt_resolve')
      && failedLinearization.calls.includes('clued_p5_record_commit_failure'),
    'failed race uses Worker automatic commit-failure closure');
    equal(failedLinearization.worker_a.error.type, 'TRANSACTION_COMMIT_FAILED');
    record('attempt_reissue_linearization_evidence.jsonl',
      'P5_REISSUE_INSERT_WINDOW_FAILED_LINEARIZED', {
        ...failedLinearizationEvidence,
        canonical_version: 1,
        commit_failure_auto_recorded: true,
        no_extra_open_attempt: true,
        production_access: false,
      });

    let immutableParentError;
    await admin.query('begin');
    try {
      await admin.query(`update public.clued_p5_gateway_attempts
        set issuance_parent='forged-parent' where id=$1`,
      [committedLinearization.lineage[1].id]);
    } catch (error) {
      immutableParentError = error;
    } finally {
      await admin.query('rollback');
    }
    equal(immutableParentError?.message, 'P5_ATTEMPT_ISSUANCE_PARENT_IMMUTABLE');
    record('attempt_reissue_linearization_evidence.jsonl',
      'P5_ISSUANCE_PARENT_IMMUTABLE', {
        attempted_rewrite: true,
        rejected_error: immutableParentError.message,
        permanent_slot_preserved: true,
      });

    // Same Binding + key + different body cannot gain a capability after the
    // permanent result. The same key under another Binding is an independent
    // lineage and remains usable.
    globalThis.fetch = postgresGatewayFetch(server, gatewayToken, []);
    const differentBody = (await workerTool(handleContinuityRequest, workerEnv,
      RAW_WORKER_BINDING_TOKEN, 'clued_p5_mutate', {
        ...committedRuntimeInput,
        mutation: { content: 'different-body-must-not-run' },
      })).result;
    globalThis.fetch = originalFetch;
    equal(differentBody.error.type, 'IDEMPOTENCY_PAYLOAD_CONFLICT');
    const committedAttemptTotal = (await admin.query(`select count(*)::int as count
      from public.clued_p5_gateway_attempts where binding_id=$1 and idempotency_key=$2`,
    [IDS.bindWorker, 'attempt-reissue-linear-committed'])).rows[0].count;
    equal(committedAttemptTotal, 2, 'different body creates no additional Attempt');

    const crossBindingInput = mutation(ownerCtx, IDS.recordAttemptLinearCrossBinding, 1,
      'attempt-reissue-linear-committed', 'cross-binding-v2');
    const crossBindingAttempt = await rawRpc(owner, 'clued_p5_attempt_begin',
      [TOKENS.owner, crossBindingInput]);
    equal(crossBindingAttempt.status, 'open');
    const crossBindingResult = await rawRpc(owner, 'clued_p5_mutate',
      [TOKENS.owner, crossBindingInput, crossBindingAttempt.attempt_id]);
    equal(crossBindingResult.status, 'committed');
    record('attempt_reissue_linearization_evidence.jsonl',
      'P5_REISSUE_PAYLOAD_AND_BINDING_SCOPE', {
        same_binding_different_body: differentBody.error.type,
        different_body_attempt_count_unchanged: true,
        cross_binding_isolated: true,
        cross_binding_id: IDS.bindOwner,
        cross_binding_result: crossBindingResult,
      });

    // An unused successor may itself expire. Its immutable ID becomes the
    // sole issuance parent for the next generation, and permanent replay after
    // that generation completes creates no fourth capability.
    const reexpiredInput = mutation(workerCtx, IDS.recordAttemptLinearReexpired, 1,
      'attempt-reissue-linear-reexpired', 'reexpired-v2');
    const reexpiredRoot = await rawRpc(owner, 'clued_p5_attempt_begin',
      [TOKENS.worker, reexpiredInput]);
    await admin.query(`update public.clued_p5_gateway_attempts
      set expires_at=now()-interval '1 second' where id=$1`, [reexpiredRoot.attempt_id]);
    const reexpiredSuccessor = await rawRpc(owner, 'clued_p5_attempt_begin',
      [TOKENS.worker, reexpiredInput]);
    await admin.query(`update public.clued_p5_gateway_attempts
      set expires_at=now()-interval '1 second' where id=$1`, [reexpiredSuccessor.attempt_id]);
    const reexpiredGrandchild = await rawRpc(owner, 'clued_p5_attempt_begin',
      [TOKENS.worker, reexpiredInput]);
    const reexpiredResult = await rawRpc(owner, 'clued_p5_mutate',
      [TOKENS.worker, reexpiredInput, reexpiredGrandchild.attempt_id]);
    const reexpiredReplay = await rawRpc(owner, 'clued_p5_attempt_begin',
      [TOKENS.worker, reexpiredInput]);
    equal(reexpiredReplay.status, 'replayed');
    equal(reexpiredReplay.canonical_result, reexpiredResult);
    const reexpiredLineage = (await admin.query(`select id,status,issuance_parent
      from public.clued_p5_gateway_attempts where binding_id=$1 and idempotency_key=$2
      order by created_at,id`, [IDS.bindWorker, 'attempt-reissue-linear-reexpired'])).rows;
    equal(reexpiredLineage, [
      { id: reexpiredRoot.attempt_id, status: 'expired', issuance_parent: 'root' },
      { id: reexpiredSuccessor.attempt_id, status: 'expired', issuance_parent: reexpiredRoot.attempt_id },
      { id: reexpiredGrandchild.attempt_id, status: 'completed', issuance_parent: reexpiredSuccessor.attempt_id },
    ]);
    equal(await counts(admin, 'attempt-reissue-linear-reexpired'),
      { idempotency: 1, events: 1, receipts: 1 });
    record('attempt_reissue_linearization_evidence.jsonl',
      'P5_REPLACEMENT_NATURAL_EXPIRY_NEXT_GENERATION', {
        lineage: reexpiredLineage,
        final_retry_status: reexpiredReplay.status,
        responses_identical: true,
        open_attempt_count: 0,
        mutation_count: 1,
        event_count: 1,
        receipt_count: 1,
        idempotency_count: 1,
      });

    // A Mutation may have locked the old row while it was still valid, then
    // remain uncommitted until after expires_at. The retry's expiry UPDATE must
    // wait; after commit it must re-evaluate the now-completed row and replay
    // Idempotency instead of overwriting status or issuing another Attempt.
    const lockRaceInput = mutation(ownerCtx, IDS.recordAttemptExpiryLockRace, 1,
      'attempt-expiry-row-lock-race', 'lock-race-v2');
    const lockRaceAttempt = await rawRpc(owner, 'clued_p5_attempt_begin',
      [TOKENS.owner, lockRaceInput]);
    await admin.query(`update public.clued_p5_gateway_attempts
      set expires_at=now()+interval '200 milliseconds' where id=$1`, [lockRaceAttempt.attempt_id]);
    const lockingMutation = await clientFor(server, { faults: true });
    const lockRaceRetry = await clientFor(server, { faults: true });
    clients.push(lockingMutation, lockRaceRetry);
    await lockingMutation.query('begin');
    const uncommittedCanonicalResult = await rawRpc(lockingMutation, 'clued_p5_mutate',
      [TOKENS.owner, lockRaceInput, lockRaceAttempt.attempt_id]);
    equal(uncommittedCanonicalResult.status, 'committed');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const waitingRetryPromise = rawRpc(lockRaceRetry, 'clued_p5_attempt_begin',
      [TOKENS.owner, lockRaceInput]);
    const retryWaitedForLock = await Promise.race([
      waitingRetryPromise.then(() => false),
      new Promise((resolve) => setTimeout(() => resolve(true), 100)),
    ]);
    equal(retryWaitedForLock, true, 'expired transition waits for the Mutation row lock');
    await lockingMutation.query('commit');
    const lockRaceReplay = await waitingRetryPromise;
    equal(lockRaceReplay.status, 'replayed');
    equal(lockRaceReplay.canonical_result, uncommittedCanonicalResult);
    const lockRaceAttemptRows = (await admin.query(`select id,status from public.clued_p5_gateway_attempts
      where idempotency_key=$1 order by created_at`, ['attempt-expiry-row-lock-race'])).rows;
    equal(lockRaceAttemptRows, [{ id: lockRaceAttempt.attempt_id, status: 'completed' }]);
    equal(await row(admin, IDS.recordAttemptExpiryLockRace),
      { version: '2', content: 'lock-race-v2' });
    equal(await counts(admin, 'attempt-expiry-row-lock-race'),
      { idempotency: 1, events: 1, receipts: 1 });
    record('expired_attempt_reissue_evidence.jsonl',
      'P5_EXPIRY_WAITS_FOR_MUTATION_LOCK_AND_RECHECKS_TERMINAL', {
        attempt_id: lockRaceAttempt.attempt_id,
        expiry_transition_waited_for_row_lock: retryWaitedForLock,
        final_attempt_status: lockRaceAttemptRows[0].status,
        completed_not_overwritten_as_expired: true,
        replacement_attempt_count: 0,
        retry_status: lockRaceReplay.status,
        responses_identical: true,
        canonical_version: 2,
        mutation_count: 1,
        event_count: 1,
        receipt_count: 1,
        idempotency_count: 1,
      });

    const missingResultInput = mutation(ownerCtx, IDS.recordAttemptMissingResult, 1,
      'attempt-missing-result-fail-closed', 'must-not-write');
    const missingResultAttempt = await rawRpc(owner, 'clued_p5_attempt_begin',
      [TOKENS.owner, missingResultInput]);
    await admin.query(`update public.clued_p5_gateway_attempts
      set status='completed',canonical_result=null,completed_at=now() where id=$1`,
    [missingResultAttempt.attempt_id]);
    const missingResultMutation = await rawRpc(owner, 'clued_p5_mutate',
      [TOKENS.owner, missingResultInput, missingResultAttempt.attempt_id]);
    equal(missingResultMutation.error.type, 'P5_ATTEMPT_CANONICAL_RESULT_MISSING');
    equal(await row(admin, IDS.recordAttemptMissingResult),
      { version: '1', content: 'recordAttemptMissingResult-v1' });
    record('worker_concurrent_attempt_replay_evidence.jsonl',
      'P5_ATTEMPT_AMBIGUOUS_STATES_FAIL_CLOSED', {
        expired_old_attempt: oldExpiredMutation.error.type,
        missing_canonical_result: missingResultMutation.error.type,
        expired_reissue_mutation_count: 1,
        missing_result_mutation_count: 0,
        missing_result_canonical_version_unchanged: true,
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
      log_isolation_upgrade: logIsolationUpgrade,
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
        'apps/clued-cloud/supabase/migrations/20260827062132_p5_concurrent_attempt_replay.sql',
        'apps/clued-cloud/supabase/migrations/20260827072012_p5_expired_attempt_reissue.sql',
        'apps/clued-cloud/supabase/migrations/20260827084500_p5_attempt_reissue_linearization.sql',
        'apps/clued-cloud/supabase/migrations/20260828125643_clued_log_card_api_contract_v12.sql',
        'apps/clued-cloud/supabase/migrations/20260829091757_clued_log_isolation_forward_fix.sql',
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
    await stopEsbuild();
    if (process.platform === 'win32') {
      const pid = server.process?.pid;
      if (pid) {
        try { execFileSync('taskkill', ['/pid', String(pid), '/f', '/t'], { stdio: 'ignore' }); } catch {}
      }
      // The package exit hook otherwise calls stop() after taskkill and can
      // attach an exit listener after the event has already fired.
      server.process = undefined;
      if (path.dirname(databaseDir) === os.tmpdir() && path.basename(databaseDir).startsWith('clued-p5-pg-')) {
        await removeTestDirectory(databaseDir);
      }
    } else {
      await stopCluster(server);
    }
    if (path.dirname(bundleDir) === os.tmpdir() && path.basename(bundleDir).startsWith('clued-p5-worker-')) {
      await removeTestDirectory(bundleDir);
    }
  }
});
