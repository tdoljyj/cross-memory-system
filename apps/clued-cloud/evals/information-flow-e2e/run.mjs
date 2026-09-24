#!/usr/bin/env node
// Information Flow M0-D S6 E2E orchestrator (plan sections 2-4, 7, 8).
// preflight -> stack status -> db reset -> Worker bundle -> Worker host ->
// principals -> scenarios E2E-01..15 (E2E-11 OBSERVED) -> E2E-08 phase A ->
// container restart -> E2E-08 phase B (new process) -> E2E-09 aggregation
// -> isolation report -> run manifest. Run under
// `node --require ./evals/information-flow-e2e/isolation-guard.cjs`.

import { fork, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { connectFixtures } from './fixtures.mjs';
import { connectObserver } from './observer.mjs';
import { normalizedDigest, redact, sha256, writeJson } from './evidence.mjs';
import { Recorder, WorkerHost } from './harness.mjs';
import { AccountPrincipal, mintBinding, newBindingToken } from './principals.mjs';
import * as stack from './stack.mjs';
import { environmentScan, bundleScan, runtimeVersions, codeBinding } from './preflight.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({ options: {
  'evidence-dir': { type: 'string' }, tier: { type: 'string', default: 'T1' }, 'skip-reset': { type: 'boolean' },
  only: { type: 'string' }, 'ttl-wait-ms': { type: 'string' } } });
if (!args['evidence-dir']) throw new Error('--evidence-dir is required');
if (args.tier !== 'T1') throw new Error('only transport tier T1 (full Supabase CLI stack incl. Kong) is implemented');
const evidenceDir = path.resolve(args['evidence-dir']);
fs.mkdirSync(path.join(evidenceDir, 'e2e'), { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ife2e-'));
const guardDir = path.join(work, 'guard');
fs.mkdirSync(guardDir);
const SCENARIOS = ['01', '02', '15', '03', '04', '05', '06', '07', '10', '11', '12', '13', '14'];
const runStarted = Date.now();

const env = stack.childEnv();
const log = (line) => process.stderr.write(`[ife2e] ${line}\n`);

// ---- Preflight (outside the qualification window).
const scan = environmentScan();
if (scan.forbidden.length) throw new Error(`forbidden credentials in environment: ${scan.forbidden.join(',')}`);
const versions = runtimeVersions();
const binding = codeBinding();
log(`code tree ${binding.code_tree} node ${process.version}`);
const bundleDir = path.join(work, 'bundle');
const wranglerArgv = ['wrangler', 'deploy', '--dry-run', '--outdir', bundleDir, '--config',
  'evals/information-flow-e2e/wrangler.jsonc'];
const wrangler = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', wranglerArgv, { cwd: stack.cloudRoot,
  env: stack.childEnv({ WRANGLER_LOG_PATH: path.join(work, 'wrangler-logs') }), encoding: 'utf8' });
if (wrangler.status !== 0) throw new Error(`wrangler dry-run failed: ${wrangler.stderr}`);
const bundle = bundleScan(bundleDir);

// ---- Stack and database identity.
const status = stack.status();
if (!args['skip-reset']) { log('db reset (full migration chain)'); stack.resetDatabase(); }
await stack.waitHealthy(status.apiUrl, status.publishableKey);
const firstObserver = await connectObserver(status.dbUrl);
const dbIdentity = firstObserver.identity;
await firstObserver.close();
const observer = await connectObserver(status.dbUrl, dbIdentity);
const fixtures = await connectFixtures(status.dbUrl, dbIdentity);
const migrationsApplied = (await observer.query(
  'select count(*)::int n, max(version) latest from supabase_migrations.schema_migrations'))[0];
const images = stack.imageDigests();
const cli = stack.cliVersions();

const h = { stack: status, observer, fixtures, worker: null, hosts: [] };
let hostSeq = 0;
async function startWorker() {
  hostSeq += 1;
  const persistDir = path.join(work, `persist-${hostSeq}`);
  const host = new WorkerHost({ bundleDir, persistDir, gatewayOrigin: status.apiUrl, publishableKey: status.publishableKey,
    guardLedger: path.join(guardDir, `worker-host-${hostSeq}.json`), env });
  await host.start();
  h.worker = host;
  h.hosts.push(host);
  return host;
}

// Every run-level exit path stops what this process started.
async function teardown() {
  for (const host of h.hosts) await host.stop().catch(() => {});
  await observer.close().catch(() => {});
  await fixtures.close().catch(() => {});
}

const results = {};
let phaseA = null;
let state = null;
try {
  await startWorker();
  const environment = { qualification: 'LOCAL', transport_tier: args.tier, node: process.version,
    ...versions, supabase_cli: cli.supabase_cli, docker: cli.docker,
    images: Object.fromEntries(Object.entries(images).map(([k, v]) => [k, v?.id ?? null])),
    db_system_identifier: dbIdentity.system_identifier, db_database_oid: dbIdentity.database_oid,
    migrations_applied: migrationsApplied };

  // ---- Principals (gotrue channel) and project scopes (worker_rest).
  const setup = new Recorder(h, 'SETUP');
  const runTag = crypto.randomBytes(4).toString('hex');
  const U = new AccountPrincipal('U', status.apiUrl, status.publishableKey, `if-m0d-u-${runTag}@example.invalid`);
  const V = new AccountPrincipal('V', status.apiUrl, status.publishableKey, `if-m0d-v-${runTag}@example.invalid`);
  for (const p of [U, V]) {
    await p.register();
    setup.addStep({ channel: 'gotrue', method: 'POST', target: '/auth/v1/signup', request_sha256: null, http_status: 200,
      response_sha256: null, extracted: { principal: p.name }, ledger: [], duration_ms: 0 });
    await p.newSession();
    setup.addStep({ channel: 'gotrue', method: 'POST', target: '/auth/v1/token?grant_type=password', request_sha256: null,
      http_status: 200, response_sha256: null, extracted: { principal: p.name, claims: redact(p.session.claimsSummary) },
      ledger: [], duration_ms: 0 });
  }
  h.U = U;
  const projects = {};
  for (const name of ['p01', 'p02', 'p03', 'p04', 'p05a', 'p05b', 'p06', 'p07', 'p08', 'p10', 'p11', 'p12', 'p13',
    'p14', 'p15']) {
    const projectId = crypto.randomUUID();
    const created = await setup.rest(U, 'POST', '/v1/projects', { operation: 'create', canonical_project_id: projectId,
      project_schema_version: 2, base_version: null, idempotency_key: `if-s6-project-${name}-${runTag}`,
      mutation: { name: `IF S6 ${name}`, progress_status: 'active', aliases: [] } },
    { extract: (b) => ({ status: b?.status }) });
    if (created.body?.status !== 'committed') throw new Error(`project ${name}: ${JSON.stringify(created.body)}`);
    projects[name] = `project:${projectId}`;
  }
  const issuerSecret = crypto.randomBytes(32).toString('hex');
  const issuerHash = sha256(issuerSecret);
  // The issuer resource must be https (table check); it is a label only.
  const resource = 'https://mcp.ife2e.invalid/mcp';
  await setup.fixture('register v12 issuer (configuration, no product transport)',
    (f) => f.registerIssuer(issuerHash, resource));
  const allScopes = ['global', ...Object.values(projects)];
  const bindings = {
    B_main: await mintBinding(setup, U, { issuerHash, resource, scopes: allScopes, clientId: 'ife2e-main',
      raw: newBindingToken('m') }),
    B_reduce: await mintBinding(setup, U, { issuerHash, resource, scopes: [projects.p05a, projects.p05b],
      clientId: 'ife2e-reduce', raw: newBindingToken('r') }),
    B_del: await mintBinding(setup, U, { issuerHash, resource, scopes: [projects.p13], clientId: 'ife2e-del',
      raw: newBindingToken('d') }),
  };
  const vSetup = await mintBinding(setup, V, { issuerHash, resource, scopes: ['global'], clientId: 'ife2e-foreign',
    raw: newBindingToken('v') }).catch((error) => ({ error: error.message }));
  bindings.B_V = vSetup;
  const ctx = { h, U, V, projects, ...bindings, shared: {}, environment,
    restartWorker: async () => { await startWorker(); } };

  const principalsEvidence = { account_user: '<synthetic>', token_labels: Object.fromEntries([U, V].map((p) =>
    [p.name, p.session.claimsSummary.token_label])),
  bindings: Object.entries(bindings).map(([name, b]) => ({ name, label: b.label ?? null,
    scopes_count: b.scopes?.length ?? null, granted_scopes: b.grantedScopes ?? null, error: b.error ?? null })) };
  writeJson(path.join(evidenceDir, 'setup.json'), { schema: 'clued.information-flow.m0d.e2e-setup/1',
    steps: setup.steps.map((s) => ({ ...s, duration_ms: undefined })), principals: principalsEvidence,
    projects_count: Object.keys(projects).length });

  // ---- Scenarios.
  const deferred = [];
  const only = args.only ? new Set(args.only.split(',')) : null;
  const finish = (scenario, rec, result, error) => {
    const allPass = rec.assertions.length > 0 && rec.assertions.every((a) => a.pass);
    const verdict = result ?? (error ? 'FAIL' : allPass ? 'PASS' : 'FAIL');
    const evidence = { schema: 'clued.information-flow.m0d.e2e-evidence/1', scenario_id: scenario.id,
      contract: binding.contract, code_binding: binding.code, environment, principals: principalsEvidence,
      aliases: rec.aliases, steps: rec.steps, assertions: rec.assertions, notes: rec.notes, ...(rec.extra ?? {}),
      error: error ? String(error.stack ?? error).split('\n').slice(0, 3).join(' | ') : null, result: verdict,
      claims: { model_extraction: 'NOT_EVALUATED', verdict_env: '_LOCAL_QUALIFIED',
        od5_qualifier: 'Agent authority confined only on the Information Flow path' } };
    evidence.normalized_digest = normalizedDigest(evidence);
    writeJson(path.join(evidenceDir, 'e2e', `${scenario.id}.json`), evidence);
    results[scenario.id] = { result: verdict, assertions: rec.assertions.length,
      failed: rec.assertions.filter((a) => !a.pass).map((a) => a.id), normalized_digest: evidence.normalized_digest,
      error: evidence.error };
    log(`${scenario.id}: ${verdict}${evidence.error ? ` (${evidence.error})` : ''} ${results[scenario.id].failed.join(',')}`);
  };
  const runDue = async (force = false) => {
    for (const task of [...deferred]) {
      if (!force && Date.now() < task.dueAt) continue;
      const wait = task.dueAt - Date.now();
      if (wait > 0) { log(`waiting ${Math.ceil(wait / 1000)} s for the real-clock TTL`); await new Promise((r) => setTimeout(r, wait)); }
      deferred.splice(deferred.indexOf(task), 1);
      try { await task.run(); finish(task.scenario, task.rec, task.result); } catch (error) {
        finish(task.scenario, task.rec, null, error);
      }
    }
  };
  for (const n of SCENARIOS) {
    if (only && !only.has(n)) continue;
    const scenario = await import(pathToFileURL(path.join(here, 'scenarios', `e2e-${n}.mjs`)).href);
    const rec = new Recorder(h, scenario.id);
    try {
      const out = await scenario.run(ctx, rec);
      if (out?.deferred) {
        const dueAt = args['ttl-wait-ms'] ? Date.now() + Number(args['ttl-wait-ms']) : out.deferred.dueAt;
        deferred.push({ scenario, rec, dueAt, run: out.deferred.run, result: out.result });
      } else finish(scenario, rec, out?.result);
    } catch (error) {
      finish(scenario, rec, null, error);
    }
    await runDue();
  }
  await runDue(true);

  // ---- E2E-08 phase A, restart, phase B in a new process.
  if (!only || only.has('08')) {
    const continuity = await import(pathToFileURL(path.join(here, 'scenarios', 'e2e-08.mjs')).href);
    const rec = new Recorder(h, 'E2E-08');
    try {
      phaseA = await continuity.phaseA(ctx, rec);
      fs.mkdirSync(path.join(evidenceDir, 'continuity'), { recursive: true });
      phaseA.file = path.join(evidenceDir, 'continuity', 'phaseA.json');
      phaseA.sha256 = writeJson(phaseA.file, phaseA.public);
      phaseA.rec = rec;
    } catch (error) {
      finish({ id: 'E2E-08' }, rec, null, error);
      phaseA = null;
    }
  }

  // ---- E2E-09 and the isolation report are written after phase B (below).
  state = { ctx, results, finish, environment, binding, bundle, scan, images, status, dbIdentity,
    principalsEvidence, runStarted, wranglerArgv, versions };
} catch (error) {
  log(`run aborted: ${error.stack ?? error}`);
  results.RUN = { result: 'FAIL', error: String(error.message ?? error) };
}

// Phase B needs the Worker host stopped and the containers restarted.
if (state && phaseA) {
  const { ctx } = state;
  await teardown();
  const before = stack.containerStartedAt();
  stack.restartContainers();
  await stack.waitHealthy(status.apiUrl, status.publishableKey);
  const after = stack.containerStartedAt();
  // Phase B is a new process. Secrets travel over IPC only; expectations come
  // only from phaseA.json.
  const child = fork(path.join(here, 'continuity-phase-b.mjs'), ['--expect', phaseA.file], {
    cwd: stack.cloudRoot, execArgv: ['--require', path.join(here, 'isolation-guard.cjs')],
    env: { ...env, IFE2E_GUARD_LEDGER: path.join(guardDir, 'phase-b.json') }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const phaseB = await new Promise((resolve) => {
    let received = null;
    child.on('message', (message) => { received = message; });
    child.on('exit', (code) => resolve({ code, received }));
    child.send({ apiUrl: status.apiUrl, publishableKey: status.publishableKey, dbUrl: status.dbUrl,
      dbIdentity: state.dbIdentity, email: ctx.U.email, password: ctx.U.password, userId: ctx.U.userId,
      bindingRaw: ctx.B_main.raw, bundleDir: path.join(work, 'bundle'),
      workerGuardLedger: path.join(guardDir, 'worker-host-phase-b.json') });
  });
  if (phaseB.received?.error) log(`phase B error: ${phaseB.received.error}`);
  const continuity = await import(pathToFileURL(path.join(here, 'scenarios', 'e2e-08.mjs')).href);
  const rec = phaseA.rec;
  continuity.merge(rec, { phaseA, child: { code: phaseB.code }, restart: { before, after },
    phaseB: phaseB.received && !phaseB.received.error ? phaseB.received : null, parentPid: process.pid });
  Object.assign(rec.aliases, phaseB.received?.aliases ?? {});
  state.phaseBEgress = phaseB.received?.egress ?? [];
  state.finish({ id: 'E2E-08' }, rec, null, phaseB.received?.error ? new Error(phaseB.received.error) : null);
  fs.mkdirSync(path.join(evidenceDir, 'continuity'), { recursive: true });
  fs.renameSync(path.join(evidenceDir, 'e2e', 'E2E-08.json'), path.join(evidenceDir, 'continuity', 'E2E-08.json'));
} else {
  await teardown();
}

if (state) {
  const { aggregate } = await import(pathToFileURL(path.join(here, 'aggregate.mjs')).href);
  await aggregate({ ...state, evidenceDir, guardDir, hosts: h.hosts, work });
  writeJson(path.join(evidenceDir, 'run-results.json'), { results: Object.fromEntries(Object.entries(results).sort()) });
}
fs.rmSync(work, { recursive: true, force: true });
const failed = Object.entries(results).filter(([, v]) => v.result === 'FAIL');
log(`done: ${Object.entries(results).map(([k, v]) => `${k}=${v.result}`).join(' ')}`);
process.exitCode = failed.length ? 1 : 0;
