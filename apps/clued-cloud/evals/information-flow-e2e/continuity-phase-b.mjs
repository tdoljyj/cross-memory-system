#!/usr/bin/env node
// E2E-08 phase B: a new process with a new Worker host (empty persist
// directory, no storage bindings), a new GoTrue session and a new MCP
// initialize. Expectations come only from phaseA.json (--expect). Secrets
// (the synthetic password, Binding token and local gateway JWT) arrive over the IPC channel
// from the orchestrator and are never written to disk.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { sha256 } from './evidence.mjs';
import { Recorder, WorkerHost } from './harness.mjs';
import { connectObserver } from './observer.mjs';
import { AccountPrincipal } from './principals.mjs';
import { packExtract } from './scenarios/common.mjs';
import { pendingRow, sortRows } from './scenarios/e2e-08.mjs';
import { childEnv } from './stack.mjs';

const { values: args } = parseArgs({ options: { expect: { type: 'string' } } });
if (!process.send) throw new Error('phase B must be forked with an IPC channel');
const expected = JSON.parse(fs.readFileSync(args.expect, 'utf8'));
const secrets = await new Promise((resolve) => process.once('message', resolve));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ife2e-phase-b-'));
const h = { stack: { apiUrl: secrets.apiUrl, publishableKey: secrets.publishableKey }, worker: null };
let out = { steps: [], assertions: [], aliases: {}, egress: [], p2_pid: process.pid, w2_pid: null };
try {
  h.observer = await connectObserver(secrets.dbUrl, secrets.dbIdentity, secrets.bridgeCidrs ?? []);
  const r = new Recorder(h, 'E2E-08');
  r.check('08.B.db_identity', 'phase B reached the same local database (system identifier and database oid)',
    [secrets.dbIdentity.system_identifier, secrets.dbIdentity.database_oid],
    [h.observer.identity.system_identifier, h.observer.identity.database_oid]);
  const persistDir = path.join(work, 'persist');
  h.worker = new WorkerHost({ bundleDir: secrets.bundleDir, persistDir, gatewayOrigin: secrets.apiUrl,
    publishableKey: secrets.publishableKey, gatewayToken: secrets.gatewayToken,
    guardLedger: secrets.workerGuardLedger, env: childEnv() });
  await h.worker.start();
  out.w2_pid = h.worker.child.pid;
  r.check('08.B.no_storage_bindings', 'W2 has only text variable bindings (no KV, cache or storage)',
    ['CLUED_ALLOWED_ORIGINS', 'CLUED_DB_GATEWAY_TOKEN', 'P5_TENANT_WRITES', 'PROJECT_VIEWS_V2', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_URL'],
    h.worker.ready.binding_names);
  const U = new AccountPrincipal('U', secrets.apiUrl, secrets.publishableKey, secrets.email);
  U.password = secrets.password;
  U.userId = secrets.userId;
  await U.newSession();
  r.addStep({ channel: 'gotrue', method: 'POST', target: '/auth/v1/token?grant_type=password', request_sha256: null,
    http_status: 200, response_sha256: null, extracted: { principal: 'U' }, ledger: [], duration_ms: 0 });
  r.check('08.B.new_session', 'phase B signs in with a new GoTrue session', true,
    U.session.claimsSummary.session_label !== expected.gotrue_session_label && U.session.claimsSummary.has_session_id);
  const B = { raw: secrets.bindingRaw };
  const init = await r.mcp(B, 'initialize', { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'ife2e-agent-phase-b', version: '1.0.0' } });
  r.check('08.B.mcp_initialize', 'phase B runs a new MCP initialize', 200, init.status);

  const scope = expected.scope;
  const nativeList = await r.rest(U, 'GET', `/v1/intake?status=pending&scope=${encodeURIComponent(scope)}&limit=200`,
    undefined, { extract: (b) => ({ count: b?.candidates?.length }) });
  r.check('08.a.native_pending', '(a) the owner sees exactly the phase A pending candidates', expected.native_pending,
    sortRows((nativeList.body?.candidates ?? []).map(pendingRow)));
  const agentList = await r.tool(B, 'clued_intake_list', { scope, status: 'pending', limit: 200 },
    { extract: (b) => ({ count: b?.candidates?.length }) });
  r.check('08.a.agent_pending', '(a) the Binding sees exactly its phase A pending candidates', expected.agent_pending,
    sortRows((agentList.structured?.candidates ?? []).map(pendingRow)));
  const revalidated = await r.rest(U, 'POST', '/v1/context/pack', { manifest_id: expected.manifest_id },
    { extract: packExtract });
  r.check('08.b.revalidate', '(b) the stored manifest revalidates VALID with the recomputed digest equal to D8',
    [200, 'VALID', expected.pack_digest], [revalidated.status, revalidated.body?.revalidation, revalidated.body?.pack_digest]);
  const recompiled = await r.tool(B, 'clued_context_pack', { scope, task_class: expected.task_class },
    { extract: packExtract });
  const pack = recompiled.structured;
  r.check('08.c.recompile', '(c) the Binding recompile returns D8 and reuses manifest M8',
    [expected.pack_digest, expected.manifest_id, true], [pack?.pack_digest, pack?.manifest?.id, pack?.manifest?.reused]);
  r.check('08.c.text_digest', '(c) sha256(pack_text) equals D8', expected.pack_digest,
    typeof pack?.pack_text === 'string' ? sha256(pack.pack_text) : null);
  r.check('08.d.fresh_persist', '(d) W2 created a new persist directory that was empty when the host started',
    [true, true], [h.worker.ready.persist_dir_new, h.worker.ready.persist_empty_at_start]);
  out = { ...out, steps: r.steps, assertions: r.assertions, aliases: r.aliases };
} catch (error) {
  out.error = String(error.stack ?? error).split('\n').slice(0, 3).join(' | ');
} finally {
  if (h.worker) {
    out.egress = h.worker.egress.map((row) => ({ allowed: row.allowed, host: row.host, path_class: row.path_class,
      status: row.status }));
    await h.worker.stop().catch(() => {});
  }
  await h.observer?.close().catch(() => {});
  fs.rmSync(work, { recursive: true, force: true });
}
process.send(out, () => process.exit(0));
