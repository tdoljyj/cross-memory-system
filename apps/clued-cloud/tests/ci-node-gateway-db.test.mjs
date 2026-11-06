import assert from 'node:assert/strict';
import crypto, { webcrypto } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build, stop } from 'esbuild';
import { schedulingFixture, uuid, digest, sha, limits } from './ci-scheduling-stage1-fixture.mjs';
import { setWorkerGatewayCaller } from './worker-gateway-caller-fixture.mjs';

// Unified scheduling 2B end to end: real P-256 node keys sign commands, the real
// Worker handler (ci-node-gateway-v1.ts, bundled) verifies them and calls the
// real gateway RPCs on the full migration chain as clued_worker_gateway.
// raw-binding-grants: every Binding inserted here is inserted after schedulingFixture(), which calls
// allowRawTestBindings before returning, so the test-only trigger grants it.

const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({ stdin: { contents: "export * from './worker/ci-node-gateway-v1.ts'; export * from './worker/ci-scheduling-v1.ts';",
  resolveDir: cloud, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
stop();
const gatewayModule = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const { handleCiNodeGatewayV1, ciCanonicalJson, ciCommandSigningBytes, ciIdentityFingerprint } = gatewayModule;
const hex = text => crypto.createHash('sha256').update(text).digest('hex');
const env = { SUPABASE_URL: 'https://db.example.test', SUPABASE_PUBLISHABLE_KEY: 'publishable-fixture', CLUED_DB_GATEWAY_TOKEN: 'gateway-fixture' };

test('unified scheduling 2B: node gateway, qualification, node list, G7/G10 and the green mirror on PostgreSQL', { timeout: 900000 }, async t => {
  const f = await schedulingFixture(); const { admin, user, project } = f;
  const sql = async (text, args = [], client = admin) => (await client.query(text, args)).rows[0];
  const gw = await f.connect(); await setWorkerGatewayCaller(gw);
  const calls = [];
  const fetchImpl = async (url, init) => {
    const name = new URL(url).pathname.replace('/rest/v1/rpc/', ''); const body = JSON.parse(init.body); calls.push(name);
    let value;
    if (name === 'clued_ci_node_trust_v1') value = (await gw.query('select public.clued_ci_node_trust_v1($1,$2::uuid) v', [body.p_token_hash, body.p_node_id])).rows[0].v;
    else if (name === 'clued_ci_node_command_v1') value = (await gw.query('select public.clued_ci_node_command_v1($1,$2::jsonb,$3::jsonb,$4::jsonb) v',
      [body.p_token_hash, JSON.stringify(body.p_command), JSON.stringify(body.p_payload), JSON.stringify(body.p_verified)])).rows[0].v;
    else throw new Error('unexpected RPC ' + name);
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const post = async (route, token, body) => {
    const response = await handleCiNodeGatewayV1(new Request('https://clued.example.test' + route, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) }), env, { fetchImpl });
    return { status: response.status, body: await response.json() };
  };
  const status = async node => { const r = await post('/v1/ci/node/status', node.token, { node_id: node.id }); assert.equal(r.status, 200, JSON.stringify(r)); return r.body; };
  async function makeNode({ publisher = true, scan = true } = {}) {
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const e = await webcrypto.subtle.exportKey('jwk', pair.publicKey); const identity = { crv: e.crv, kty: e.kty, x: e.x, y: e.y };
    const token = 'clued_node_fixture_' + crypto.randomBytes(24).toString('hex');
    const bindingId = (await admin.query(`insert into public.clued_agent_bindings(user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values($1,'synthetic','ci-node-gateway-fixture',$2,array['context:read'],array['*']) returning id`, [user, hex(token)])).rows[0].id;
    const reg = { ...f.registration(), binding_id: bindingId, identity_public_jwk: identity, publisher_requested: publisher, scan_signing_requested: scan };
    const r = f.committed(await f.native('clued_ci_node_registration_v1', reg));
    const encryption = (await sql('select encryption_fingerprint from clued_private.ci_nodes_v1 where node_id=$1', [r.node_id])).encryption_fingerprint;
    await f.live(r.node_id); // G5 (T2A-2): node operations need a fresh heartbeat.
    return { id: r.node_id, token, key: pair.privateKey, publicKey: pair.publicKey, identity, fingerprint: await ciIdentityFingerprint(identity), reg, encryption, bindingId };
  }
  const nodeRow = id => sql('select * from clued_private.ci_nodes_v1 where node_id=$1', [id]);
  const approve = async node => f.approve(node.id, Number((await nodeRow(node.id)).version));
  const nodeAction = async (node, action) => {
    const issue = await f.native('clued_ci_node_confirmation_issue_v1', { project_id: project, node_id: node.id, base_version: Number((await nodeRow(node.id)).version), action });
    assert.equal(issue.status, 'issued', JSON.stringify(issue));
    return f.committed(await f.native('clued_ci_node_apply_v1', { confirmation_token: issue.confirmation_token, view_digest: issue.view_digest }));
  };
  const setGateway = async open => {
    const view = await f.native('clued_ci_nodes_v1', { project_id: project });
    const issue = await f.native('clued_ci_pool_confirmation_issue_v1', { project_id: project, base_version: view.pool.version, signature_gateway_active: open,
      ...(open ? { accepted_ref: 'fixture-owner-opens-gateway' } : {}) });
    assert.equal(issue.status, 'issued', JSON.stringify(issue));
    assert.equal(issue.confirmation_view.choices.signature_gateway_active, open);
    return f.committed(await f.native('clued_ci_pool_apply_v1', { confirmation_token: issue.confirmation_token, view_digest: issue.view_digest }));
  };
  async function command(node, operation, payload, { job = null, g = 0, tg = 0, nonce, change } = {}) {
    const st = await status(node);
    const c = { protocol: 'clued.ci-node-command/1', operation, user_id: user, project_id: project, node_id: node.id,
      binding_id: st.node.binding_id, binding_generation: 1, node_version: st.node.version, key_version: 1, key_fingerprint: node.fingerprint,
      payload_sha256: hex(ciCanonicalJson(payload)), nonce: nonce ?? crypto.randomBytes(32).toString('base64url'),
      job_id: job, execution_generation: g, train_generation: tg, issued_at_ms: Date.now() - 1000, expires_at_ms: Date.now() + 60000,
      signature: Buffer.alloc(64).toString('base64url'), ...(change ?? {}) };
    c.signature = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, node.key, ciCommandSigningBytes(c))).toString('base64url');
    return c;
  }
  const send = async (node, operation, payload, options = {}) => {
    const c = options.signed ?? await command(node, operation, payload, options);
    return { command: c, ...(await post('/v1/ci/node', options.token ?? node.token, { command: c, payload })) };
  };
  const committed = r => { assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, 'committed', JSON.stringify(r.body)); return r.body.result; };
  const refused = (r, code, statusCode = 409) => { assert.equal(r.status, statusCode, JSON.stringify(r.body)); assert.equal(r.body.error_code, code, JSON.stringify(r.body)); };
  const report = (node, list, extra = {}, reportExtra = {}) => ({ schema: 'clued.ci-node-qualification/1',
    report: { schema: 'clued.ci-node-qualification-report/1', tool: { name: 'fixture', version: '1' }, generated_at: new Date().toISOString(),
      host: { os: 'linux', tpm_present: false }, keys: { identity_fingerprint: node.fingerprint, encryption_fingerprint: node.encryption,
        identity_key_origin: 'software', encryption_key_origin: 'software' }, source: { commit: sha('source'), manifest_sha256: null },
      profile_sha256: node.reg.profile_sha256, ...reportExtra },
    node_list_version: list.version, node_list_sha256: list.sha256, hardening_observed: true, ...extra });
  const commandsFor = async id => Number((await sql('select count(*) n from clued_private.ci_node_commands_v1 where node_id=$1', [id])).n);
  const qualify = async node => committed(await send(node, 'qualification_report', report(node, (await status(node)).node_list)));
  const domain = (operation, node, id, g, payload) => ({ operation, user_id: user, project_id: project, node_id: node.id, job_id: id, generation: g, payload });
  const m1 = async value => (await sql('select clued_private.m1_sha256($1::jsonb) d', [JSON.stringify(value)])).d;

  try {
    const a = await makeNode(), b = await makeNode(), plain = await makeNode({ publisher: false, scan: false });
    let drained;

    await t.test('gateway RPCs are the serving Worker gateway\'s only; new private functions and tables stay closed', async () => {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const c = await f.connect(role);
        await assert.rejects(() => c.query("select public.clued_ci_node_trust_v1('x',gen_random_uuid())"), /permission denied/);
        await assert.rejects(() => c.query("select public.clued_ci_node_command_v1('x','{}','{}','{}')"), /permission denied/);
      }
      for (const fn of ['ci_node_qualify_v1(uuid,uuid,uuid,jsonb,text)', 'ci_green_mirror_append_v1(uuid,uuid,uuid,jsonb,text,text)',
        'ci_node_list_refresh_v1(uuid,uuid,uuid,text)', 'ci_job_renew_v2(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text)', 'ci_gateway_node_v1(text,uuid)'])
        for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway'])
          assert.equal((await sql(`select has_function_privilege($1,'clued_private.${fn}','execute') x`, [role])).x, false, fn + ' ' + role);
      for (const table of ['ci_node_lists_v1', 'ci_node_commands_v1', 'ci_green_mirror_v1'])
        for (const role of ['anon', 'authenticated', 'service_role', 'clued_worker_gateway'])
          assert.equal((await sql(`select has_table_privilege($1,'clued_private.${table}','select') x`, [role])).x, false, table + ' ' + role);
      assert.equal(await sql("select to_regprocedure('clued_private.ci_gateway_patch_v1(text,text,text)') p").then(r => r.p), null);
    });

    await t.test('approval versions the approved node list in the same transaction; a pending node is not listed', async () => {
      assert.deepEqual((await f.native('clued_ci_nodes_v1', { project_id: project })).node_list, { version: 0, sha256: null, nodes: [] });
      const r = await approve(a); assert.equal(r.node_list_version, 1);
      const listed = (await f.native('clued_ci_nodes_v1', { project_id: project })).node_list;
      assert.equal(listed.version, 1); assert.equal(listed.cause, 'approve');
      assert.deepEqual(listed.nodes, [{ node_id: a.id, identity_fingerprint: a.fingerprint, state: 'active', publisher: true, scan_signing: true }]);
      assert.equal(listed.sha256, await m1({ schema: 'clued.ci-node-list/1', project_id: project, version: 1, nodes: listed.nodes }));
      const row = await nodeRow(a.id); assert.equal(Number(row.approved_manifest_version), 1); assert.equal(row.approved_manifest_sha256, listed.sha256);
      assert.equal(row.qualification_status, 'unverified');
      assert.equal((await approve(b)).node_list_version, 2); assert.equal((await approve(plain)).node_list_version, 3);
      drained = await makeNode(); await approve(drained); const before = (await f.native('clued_ci_nodes_v1', { project_id: project })).node_list.version;
      assert.equal((await nodeAction(drained, 'drain')).node_list_version, before + 1, 'a drain is a new version');
      const afterDrain = (await f.native('clued_ci_nodes_v1', { project_id: project })).node_list;
      assert.equal(afterDrain.cause, 'drain');
      assert.equal(afterDrain.nodes.find(x => x.node_id === drained.id).state, 'draining', 'a draining node stays listed');
      await assert.rejects(() => admin.query('update clued_private.ci_node_lists_v1 set cause=cause'), /CI_PERMANENT_HISTORY/);
      await assert.rejects(() => admin.query('delete from clued_private.ci_node_lists_v1'), /CI_PERMANENT_HISTORY/);
    });

    await t.test('closed by default: the database refuses every signed command until the Owner opens the project gateway', async () => {
      const st = await status(a); assert.equal(st.gateway_open, false); assert.equal(st.node.qualification_verified, false);
      assert.equal(st.node_list.version, 5);
      const r = await send(a, 'qualification_report', report(a, st.node_list)); refused(r, 'SIGNATURE_GATEWAY_NOT_ACTIVATED');
      assert.equal(await commandsFor(a.id), 0);
      assert.equal((await nodeRow(a.id)).qualification_status, 'unverified');
    });

    await t.test('the Owner opens and closes the gateway with a two-step pool confirmation; limits and repositories are kept', async () => {
      f.committed(await f.pool());
      const unopened = await f.native('clued_ci_nodes_v1', { project_id: project });
      await assert.rejects(() => f.native('clued_ci_pool_confirmation_issue_v1', { project_id: project, base_version: unopened.pool.version, signature_gateway_active: true }), /CI_ACCEPTANCE_REF_REQUIRED/);
      const opened = await setGateway(true); assert.equal(opened.pool.signature_gateway_active, true);
      assert.equal(opened.pool.mode, 'prepared'); assert.equal(opened.pool.phase, 1); assert.deepEqual(opened.pool.limits, limits(100));
      assert.equal(opened.pool.repositories.length, 1);
      // A later pool change without the choice keeps the flag.
      const view = await f.native('clued_ci_nodes_v1', { project_id: project });
      const issue = await f.native('clued_ci_pool_confirmation_issue_v1', { project_id: project, base_version: view.pool.version, limits: limits(50), accepted_ref: 'fixture' });
      const applied = f.committed(await f.native('clued_ci_pool_apply_v1', { confirmation_token: issue.confirmation_token, view_digest: issue.view_digest }));
      assert.equal(applied.pool.signature_gateway_active, true); assert.deepEqual(applied.pool.limits, limits(50));
      await assert.rejects(() => f.native('clued_ci_pool_confirmation_issue_v1', { project_id: project, base_version: applied.pool.version, signature_gateway_active: 'yes' }), /CI_INPUT_INVALID/);
      assert.equal((await setGateway(false)).pool.signature_gateway_active, false);
      assert.equal((await status(a)).gateway_open, false);
      assert.equal((await setGateway(true)).pool.signature_gateway_active, true);
    });

    let qualifiedAt;
    await t.test('a signed qualification report against the current list qualifies the node for 7 days; the signed command is kept', async () => {
      const st = await status(a); assert.equal(st.gateway_open, true);
      const before = await nodeRow(a.id);
      const r = await send(a, 'qualification_report', report(a, st.node_list));
      const result = committed(r);
      assert.equal(result.status, 'qualified'); assert.equal(result.node_list_version, st.node_list.version);
      const row = await nodeRow(a.id); qualifiedAt = row;
      assert.equal(row.qualification_status, 'verified'); assert.equal(Number(row.version), Number(before.version), 'qualification does not move the node version');
      assert.equal(row.qualification_source, sha('source')); assert.equal(row.hardening_observed, true);
      assert.equal(row.qualification_receipt_ref, result.qualification_receipt_ref);
      assert.equal(row.qualification_digest, digest('qualification'), 'the registration digest the Owner approved is kept');
      const receipt = await sql('select metadata from public.clued_audit_receipts where id=$1', [result.receipt_id]);
      assert.equal(receipt.metadata.payload_sha256, r.command.payload_sha256);
      const days = (new Date(row.qualification_expires_at) - new Date(row.qualification_verified_at)) / 86400000;
      assert.ok(days > 6.99 && days <= 7, String(days)); assert.equal(String(row.eligible_until), String(row.qualification_expires_at));
      assert.equal(row.scan_signing_approved, true, 'scan signing stays the Owner approval from registration');
      const kept = await sql('select * from clued_private.ci_node_commands_v1 where node_id=$1', [a.id]);
      assert.deepEqual(kept.command, r.command); assert.equal(kept.operation, 'qualification_report');
      assert.equal(kept.nonce_sha256, hex(r.command.nonce));
      // The kept command is the signed one: anyone can verify it offline against the node key.
      assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, a.publicKey,
        Buffer.from(kept.command.signature, 'base64url'), ciCommandSigningBytes(kept.command)), true);
      await assert.rejects(() => admin.query('delete from clued_private.ci_node_commands_v1'), /CI_PERMANENT_HISTORY/);
      const st2 = await status(a); assert.equal(st2.node.qualification_verified, true); assert.equal(st2.qualification.receipt_ref, result.qualification_receipt_ref);
    });

    await t.test('refusals: stale or foreign list, foreign keys or profile, old report, other token, bad signature, stale version', async () => {
      const list = (await status(b)).node_list;
      const before = await commandsFor(b.id);
      refused(await send(b, 'qualification_report', report(b, { ...list, version: list.version - 1 })), 'CI_NODE_LIST_NOT_CURRENT');
      refused(await send(b, 'qualification_report', report(b, { ...list, sha256: digest('other list') })), 'CI_NODE_LIST_NOT_CURRENT');
      refused(await send(b, 'qualification_report', report(b, list, {}, { keys: { identity_fingerprint: a.fingerprint, encryption_fingerprint: b.encryption } })), 'CI_QUALIFICATION_MISMATCH');
      refused(await send(b, 'qualification_report', report(b, list, {}, { profile_sha256: digest('other profile') })), 'CI_QUALIFICATION_MISMATCH');
      refused(await send(b, 'qualification_report', report(b, list, {}, { generated_at: new Date(Date.now() - 16 * 60000).toISOString() })), 'CI_QUALIFICATION_STALE');
      refused(await send(b, 'qualification_report', report(b, list, { hardening_observed: 'yes' })), 'CI_QUALIFICATION_INVALID');
      refused(await send(b, 'qualification_report', report(b, list, {}, { source: { commit: sha('other source'), manifest_sha256: null } })), 'CI_QUALIFICATION_SOURCE_NOT_APPROVED');
      refused(await send(b, 'qualification_report', report(b, list), { token: a.token }), 'CI_NODE_TRUST_REFUSED', 403);
      refused(await send(b, 'qualification_report', report(b, list), { token: 'clued_unknown_' + crypto.randomBytes(16).toString('hex') }), 'CI_NODE_TRUST_REFUSED', 403);
      const signed = await command(b, 'qualification_report', report(b, list));
      refused(await send(b, 'qualification_report', report(b, list), { signed: { ...signed, signature: (await command(a, 'qualification_report', report(b, list))).signature } }), 'CI_NODE_SIGNATURE_INVALID', 403);
      refused(await send(b, 'qualification_report', report(b, list), { change: { node_version: 1 } }), 'CI_NODE_STALE_VERSION', 403);
      refused(await send(b, 'qualification_report', report(b, list), { change: { issued_at_ms: Date.now() - 200000, expires_at_ms: Date.now() - 100000 } }), 'CI_NODE_COMMAND_EXPIRED', 403);
      refused(await send(a, 'node_heartbeat', {}), 'CI_OPERATION_NOT_SERVED');
      assert.equal(await commandsFor(b.id), before, 'no refused command is kept');
      const rejected = await sql(`select count(*) n from public.clued_audit_receipts where operation='ci_node_command_rejected' and object_id=$1
        and metadata->>'error_code'='CI_QUALIFICATION_SOURCE_NOT_APPROVED'`, [b.id]);
      assert.equal(Number(rejected.n), 1, 'a refusal for a resolved node leaves an audit receipt');
      assert.equal((await nodeRow(b.id)).qualification_status, 'unverified');
      assert.ok(calls.every(name => name === 'clued_ci_node_trust_v1' || name === 'clued_ci_node_command_v1'));
    });

    await t.test('a retried command returns its original result; a reused nonce never runs a second command', async () => {
      const list = (await status(b)).node_list; const payload = report(b, list);
      const first = await send(b, 'qualification_report', payload); committed(first);
      const ref = (await nodeRow(b.id)).qualification_receipt_ref;
      const again = await post('/v1/ci/node', b.token, { command: first.command, payload });
      assert.equal(again.status, 200); assert.equal(again.body.replayed, true);
      assert.equal(again.body.result.qualification_receipt_ref, first.body.result.qualification_receipt_ref);
      assert.equal((await nodeRow(b.id)).qualification_receipt_ref, ref, 'the replay ran nothing');
      const verified = { operation: 'qualification_report', node_id: b.id, payload_sha256: first.command.payload_sha256,
        nonce_sha256: hex(first.command.nonce), verified_at_ms: Date.now() };
      const reused = await send(b, 'qualification_report', report(b, list), { nonce: first.command.nonce });
      refused(reused, 'CI_COMMAND_REPLAY');
      // The Worker's verification facts must match the command exactly.
      const fresh = { ...first.command, nonce: crypto.randomBytes(32).toString('base64url') };
      for (const [bad, code] of [[{ nonce_sha256: digest('x') }, 'CI_COMMAND_INVALID'], [{ payload_sha256: digest('x') }, 'CI_COMMAND_INVALID'],
        [{ operation: 'job_lease' }, 'CI_COMMAND_INVALID'], [{ node_id: a.id }, 'CI_COMMAND_INVALID'], [{ verified_at_ms: Date.now() - 60000 }, 'CI_COMMAND_EXPIRED']]) {
        const v = (await gw.query('select public.clued_ci_node_command_v1($1,$2::jsonb,$3::jsonb,$4::jsonb) v',
          [hex(b.token), JSON.stringify(fresh), JSON.stringify(payload), JSON.stringify({ ...verified, nonce_sha256: hex(fresh.nonce), ...bad })])).rows[0].v;
        assert.equal(v.error_code, code, JSON.stringify(bad));
      }
    });

    let job; const g = 1;
    await t.test('job lifecycle through the gateway: lease, start, renew by a progress counter (G10), result_ready (G7)', async () => {
      await admin.query(`update clued_private.ci_quota_counters_v1 set policy=policy||$3::jsonb where user_id=$1 and project_id=$2 and row_kind='pool_policy'`,
        [user, project, JSON.stringify({ mode: 'resident_mirror', phase: 2, limits: limits(100), status: 'FIXTURE_ONLY' })]);
      job = await f.enqueue();
      const leased = committed(await send(a, 'job_lease', { expected_version: 1 }, { job, g }));
      assert.equal(leased.generation, 1); assert.equal(leased.state, 'leased');
      refused(await send(a, 'job_lease', { expected_version: 1 }, { job, g: 2 }), 'CI_JOB_ALREADY_LEASED');
      const started = committed(await send(a, 'job_started', {}, { job, g })); assert.equal(started.status, 'started');
      let r = committed(await send(a, 'job_renew', { lease_version: 1, progress_seq: 1 }, { job, g })); assert.equal(r.lease_version, 2); assert.equal(r.progress_seq, 1);
      r = committed(await send(a, 'job_renew', { lease_version: 2, progress_seq: 2 }, { job, g })); assert.equal(r.lease_version, 3);
      const replay = committed(await send(a, 'job_renew', { lease_version: 2, progress_seq: 2 }, { job, g })); assert.equal(replay.replayed, true);
      refused(await send(a, 'job_renew', { lease_version: 3, progress_seq: 2 }, { job, g }), 'CI_RENEW_STALE');
      refused(await send(a, 'job_renew', { lease_version: 3, progress_seq: 1 }, { job, g }), 'CI_RENEW_STALE');
      r = committed(await send(a, 'job_renew', { lease_version: 3, progress_seq: 7, progress_digest: digest('p') }, { job, g })); assert.equal(r.lease_version, 4);
      const lease = await sql('select * from clued_private.ci_job_leases_v1 where job_id=$1', [job]);
      assert.equal(Number(lease.progress_seq), 7); assert.equal(lease.progress_digest, digest('p'));
      // Result: an effect nonce bound to the server-derived intent, then the result itself.
      const body = { result_kind: 'gitleaks', result_digest: digest(uuid()), certificate_digest: digest('certificate'), signature_envelope: { protocol: 'synthetic-signed-proof' },
        qualification_ref: qualifiedAt.qualification_receipt_ref, scanner_digest: digest('scanner'), rules_digest: digest('rules') };
      const issued = await send(a, 'nonce_issue', { purpose: 'result-register', subject_digest: await m1(domain('result-register', a, job, g, body)) }, { job, g });
      const n = committed(issued); assert.match(n.nonce, /^[A-Za-z0-9_-]{43}$/);
      // The ledger never keeps the raw effect nonce; a replay is redacted.
      const keptIssue = await sql('select result from clued_private.ci_node_commands_v1 where nonce_sha256=$1', [hex(issued.command.nonce)]);
      assert.equal(keptIssue.result.result.nonce, undefined); assert.equal(keptIssue.result.redacted, true);
      assert.ok(!JSON.stringify(keptIssue.result).includes(n.nonce));
      const replayedIssue = await post('/v1/ci/node', a.token, { command: issued.command, payload: { purpose: 'result-register', subject_digest: await m1(domain('result-register', a, job, g, body)) } });
      assert.equal(replayedIssue.body.replayed, true); assert.equal(replayedIssue.body.result.nonce, undefined); assert.equal(replayedIssue.body.result.nonce_id, n.nonce_id);
      const result = committed(await send(a, 'result_register', { ...body, nonce_id: n.nonce_id, nonce: n.nonce }, { job, g }));
      assert.match(result.result_id, /^[0-9a-f-]{36}$/);
      assert.equal((await sql('select state from clued_private.ci_jobs_v1 where job_id=$1', [job])).state, 'result_ready');
      // The signed job is the one acted on: another, unleased job has no current lease for this node.
      refused(await send(a, 'job_started', {}, { job: await f.enqueue(), g }), 'CI_LEASE_NOT_CURRENT');
    });

    await t.test('T2A-2: job_lease_next through the gateway leases the next queued job and names it; a job id is refused', async () => {
      const queued = (await sql("select array_agg(job_id::text order by queued_at,created_at,job_id) ids from clued_private.ci_jobs_v1 where user_id=$1 and state='queued'", [user])).ids;
      assert.ok(queued?.length >= 1);
      // The signer refuses a jobless operation naming a job; the database refuses it too.
      const c = { ...(await command(a, 'job_lease_next', {})), job_id: queued[0], execution_generation: 1 };
      const direct = (await gw.query('select public.clued_ci_node_command_v1($1,$2::jsonb,$3::jsonb,$4::jsonb) v', [hex(a.token), JSON.stringify(c), '{}',
        JSON.stringify({ operation: c.operation, node_id: a.id, payload_sha256: c.payload_sha256, nonce_sha256: hex(c.nonce), verified_at_ms: Date.now() })])).rows[0].v;
      assert.equal(direct.error_code, 'CI_COMMAND_INVALID');
      refused(await send(a, 'job_lease_next', { extra: true }), 'CI_INPUT_INVALID');
      const leased = committed(await send(a, 'job_lease_next', {}));
      assert.equal(leased.state, 'leased'); assert.equal(leased.job_id, queued[0]); assert.equal(leased.job.job_id, queued[0]);
      for (let i = 1; i < queued.length; i++) assert.equal(committed(await send(a, 'job_lease_next', {})).job_id, queued[i]);
      assert.deepEqual(committed(await send(a, 'job_lease_next', {})), { state: 'none', tried: 0, skipped: [] });
      await admin.query("update clued_private.ci_job_leases_v1 set state='released',terminal_at=now() where job_id=any($1::uuid[]) and state='current'", [queued]);
      await admin.query("update clued_private.ci_jobs_v1 set state='canceled' where job_id=any($1::uuid[])", [queued]);
    });

    await t.test('revocation narrows the list: the node is withdrawn, its unpublished work invalidated; no older version restores it', async () => {
      await qualify(b);
      const jobB = await f.enqueue();
      committed(await send(b, 'job_lease', { expected_version: 1 }, { job: jobB, g: 1 }));
      committed(await send(b, 'job_started', {}, { job: jobB, g: 1 }));
      const bRow = await nodeRow(b.id);
      const body = { result_kind: 'trivy', result_digest: digest(uuid()), certificate_digest: digest('certificate'), signature_envelope: { protocol: 'synthetic-signed-proof' },
        qualification_ref: bRow.qualification_receipt_ref, scanner_digest: digest('scanner'), rules_digest: digest('rules'), vulnerability_db_digest: digest('db'),
        db_updated_at: new Date(Date.now() - 10000).toISOString(), db_next_update: new Date(Date.now() + 3600000).toISOString() };
      const n = committed(await send(b, 'nonce_issue', { purpose: 'result-register', subject_digest: await m1(domain('result-register', b, jobB, 1, body)) }, { job: jobB, g: 1 }));
      const res = committed(await send(b, 'result_register', { ...body, nonce_id: n.nonce_id, nonce: n.nonce }, { job: jobB, g: 1 }));
      const oldList = (await status(a)).node_list; const oldReportForB = report(b, oldList);
      // The Owner prepares the revocation; the node re-qualifies meanwhile; the confirmation stays valid.
      const issue = await f.native('clued_ci_node_confirmation_issue_v1', { project_id: project, node_id: b.id, base_version: Number(bRow.version), action: 'revoke' });
      assert.equal(issue.status, 'issued');
      await qualify(b);
      const revoked = f.committed(await f.native('clued_ci_node_apply_v1', { confirmation_token: issue.confirmation_token, view_digest: issue.view_digest }));
      assert.equal(revoked.state, 'revoked'); assert.equal(revoked.node_list_version, oldList.version + 1);
      const newList = (await f.native('clued_ci_nodes_v1', { project_id: project })).node_list;
      assert.equal(newList.cause, 'revoke'); assert.ok(!newList.nodes.some(x => x.node_id === b.id));
      const after = await nodeRow(b.id);
      assert.equal(after.qualification_status, 'expired'); assert.equal(after.eligible_until, null); assert.equal(after.qualification_verified_at, null);
      assert.equal((await sql('select state from clued_private.ci_jobs_v1 where job_id=$1', [jobB])).state, 'invalidated');
      assert.equal((await sql('select state from clued_private.ci_result_index_v1 where result_id=$1', [res.result_id])).state, 'invalidated');
      assert.equal((await sql('select state from clued_private.ci_job_leases_v1 where job_id=$1', [jobB])).state, 'revoked');
      // A's work is untouched and its qualification stays valid across the new version.
      assert.equal((await sql('select state from clued_private.ci_jobs_v1 where job_id=$1', [job])).state, 'result_ready');
      assert.equal((await nodeRow(a.id)).qualification_status, 'verified');
      // The revoked node cannot come back: its trust is gone and an older list naming it is refused.
      refused(await send(b, 'qualification_report', oldReportForB), 'CI_NODE_PRINCIPAL_INVALID', 403);
      await assert.rejects(() => f.native('clued_ci_node_confirmation_issue_v1', { project_id: project, node_id: b.id, base_version: Number(after.version), action: 'approve', accepted_ref: 'x' }), /CI_NODE_TRANSITION_INVALID/);
      refused(await send(a, 'qualification_report', report(a, oldList)), 'CI_NODE_LIST_NOT_CURRENT');
      committed(await send(a, 'qualification_report', report(a, newList)));
      // Even past the Worker, the database refuses a revoked node's command.
      const c = await command(b, 'qualification_report', report(b, newList));
      const direct = (await gw.query('select public.clued_ci_node_command_v1($1,$2::jsonb,$3::jsonb,$4::jsonb) v', [hex(b.token), JSON.stringify(c),
        JSON.stringify(report(b, newList)), JSON.stringify({ operation: c.operation, node_id: b.id, payload_sha256: c.payload_sha256, nonce_sha256: hex(c.nonce), verified_at_ms: Date.now() })])).rows[0].v;
      assert.equal(direct.error_code, 'CI_NODE_NOT_ELIGIBLE');
    });

    await t.test('G7 at the core: reservation makes the job publication_pending, the observed post makes it observed; release still settles', async () => {
      const id = await f.enqueue(); const node = a.id;
      await admin.query('select clued_private.ci_job_lease_v1($1,$2,$3,$4,1)', [user, project, node, id]);
      await admin.query('select clued_private.ci_job_started_v1($1,$2,$3,$4,1)', [user, project, node, id]);
      // Phase 2: the Stage 1 publisher check is the ci-admission role of the publisher's Binding.
      const receipt = (await sql(`insert into public.clued_audit_receipts(user_id,context_key,operation,object_type,object_id,version,metadata)
        values($1,$2,'fixture_role','binding_role',$3,1,'{}') returning id`, [user, 'project:' + project, a.bindingId])).id;
      await admin.query(`insert into clued_private.binding_roles_v1(user_id,binding_id,role,granted_at,granted_receipt_id,effective_at,purpose)
        values($1,$2,'ci-admission',clock_timestamp(),$3,clock_timestamp(),'resident-node')`, [user, a.bindingId, receipt]);
      const row = await nodeRow(node);
      const body = { result_kind: 'gitleaks', result_digest: digest(uuid()), certificate_digest: digest('certificate'), signature_envelope: { protocol: 'synthetic-signed-proof' },
        qualification_ref: row.qualification_receipt_ref, scanner_digest: digest('scanner'), rules_digest: digest('rules') };
      const nonce = async (purpose, payload, jobId = id) => (await sql('select clued_private.ci_nonce_issue_v1($1,$2,$3,$4,$5,$6,1) v',
        [user, project, node, purpose, await m1(domain(purpose, a, jobId, 1, payload)), jobId])).v;
      const n1 = await nonce('result-register', body);
      const resultId = (await sql('select clued_private.ci_result_register_v1($1,$2,$3,$4,1,$5::jsonb) id', [user, project, node, id, JSON.stringify({ ...body, nonce_id: n1.nonce_id, nonce: n1.nonce })])).id;
      assert.equal((await sql('select state from clued_private.ci_jobs_v1 where job_id=$1', [id])).state, 'result_ready');
      const pub = { check_name: 'gitleaks', result_id: resultId, landing_window_seconds: 151, external_facts_digest: digest('read') };
      const n2 = await nonce('publish-reserve', pub);
      // The mirror is locked exclusively by another connection: publication never touches it.
      const locker = await f.connect(); await locker.query('begin'); await locker.query('lock table clued_private.ci_green_mirror_v1 in access exclusive mode');
      await admin.query("set statement_timeout='5s'");
      try {
        const key = (await sql('select clued_private.ci_publish_prepare_v1($1,$2,$3,$4,1,$5::jsonb) v', [user, project, node, id,
          JSON.stringify({ ...pub, request_digest: await m1(domain('publish-reserve', a, id, 1, pub)), nonce_id: n2.nonce_id, nonce: n2.nonce })])).v.key_id;
        assert.equal((await sql('select state from clued_private.ci_jobs_v1 where job_id=$1', [id])).state, 'publication_pending');
        const k = await sql('select * from clued_private.ci_publish_keys_v1 where key_id=$1', [key]);
        const evidence = digest(uuid());
        const n3 = await nonce('publish-observe', { key_id: key, external_id: k.external_id, observation: 'present', check_run_id: 501, evidence_digest: evidence });
        const observed = (await sql('select clued_private.ci_publish_observe_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) v', [user, project, node, key, 'present', 501, evidence, n3.nonce_id, n3.nonce])).v;
        assert.equal(observed.state, 'posted');
        assert.equal((await sql('select state from clued_private.ci_jobs_v1 where job_id=$1', [id])).state, 'observed');
      } finally { await admin.query('reset statement_timeout'); await locker.query('rollback'); }
      await admin.query("select clued_private.ci_job_release_v1($1,$2,$3,$4,1,'DONE','success','closed',true)", [user, project, node, id]);
      assert.equal((await sql('select state from clued_private.ci_jobs_v1 where job_id=$1', [id])).state, 'completed');
    });

    await t.test('green mirror: a publisher appends only its own records in one hash chain; replays are idempotent; open greens count the newest phase', async () => {
      const effect = digest(uuid()), effect2 = digest(uuid());
      const record = (phase, effectKey = effect, extra = {}) => ({ contract: 'clued.independent-ci.green-ledger/1', phase, repo: 'fixture/repository-12345', pr: 7,
        headSha: sha('head'), baseSha: sha('base'), testTree: sha('tree'), testMergeSha: null, effectKey, externalId: 'independent-ci:control:' + effectKey.slice(0, 16),
        checkRunId: phase === 'intent' ? null : 901, at: new Date().toISOString(), detail: null, ...extra });
      const open = async () => Number((await sql('select clued_private.ci_phase_open_greens_v1($1,$2) n', [user, project])).n);
      const base = await open();
      const intent = record('intent');
      const r1 = committed(await send(a, 'green_mirror_append', { record: intent })); assert.equal(r1.seq, 1); assert.equal(r1.replayed, false);
      assert.equal(await open(), base + 1);
      const posted = record('posted');
      const r2 = committed(await send(a, 'green_mirror_append', { record: posted })); assert.equal(r2.seq, 2);
      const again = committed(await send(a, 'green_mirror_append', { record: posted })); assert.equal(again.replayed, true); assert.equal(again.seq, 2);
      const rows = (await admin.query('select * from clued_private.ci_green_mirror_v1 where publisher_node_id=$1 order by seq', [a.id])).rows;
      assert.equal(rows.length, 2); assert.equal(rows[0].prev_sha256, '0'.repeat(64)); assert.equal(rows[1].prev_sha256, rows[0].row_sha256);
      assert.equal(rows[1].row_sha256, await m1({ node_id: a.id, seq: 2, prev_sha256: rows[0].row_sha256, record_sha256: rows[1].record_sha256 }));
      assert.deepEqual(rows[1].record, posted); assert.equal(rows[1].publisher_node_id, a.id);
      assert.equal((await sql('select count(*) n from clued_private.ci_node_commands_v1 where nonce_sha256=$1', [rows[1].command_nonce_sha256])).n, '1');
      committed(await send(a, 'green_mirror_append', { record: record('settled') })); assert.equal(await open(), base + 1, 'a settled green is still open');
      committed(await send(a, 'green_mirror_append', { record: record('intent', effect2) })); assert.equal(await open(), base + 2);
      committed(await send(a, 'green_mirror_append', { record: record('merged') })); assert.equal(await open(), base + 1);
      committed(await send(a, 'green_mirror_append', { record: record('revoked', effect2) })); assert.equal(await open(), base);
      // A late retry of an older record cannot reopen a merged green.
      committed(await send(a, 'green_mirror_append', { record: record('posted', effect, { at: new Date(Date.now() - 60000).toISOString() }) }));
      assert.equal(await open(), base);
      // A draining publisher whose qualification is gone (here: never qualified) still records how its greens end.
      assert.equal((await nodeRow(drained.id)).state, 'draining'); assert.equal((await nodeRow(drained.id)).qualification_status, 'unverified');
      const late = committed(await send(drained, 'green_mirror_append', { record: record('revoked', digest(uuid())) })); assert.equal(late.seq, 1);
      // Two copies of one command at once: one runs, the other replays it.
      const twinKey = digest(uuid()), twinPayload = { record: record('intent', twinKey) };
      const twinCmd = await command(a, 'green_mirror_append', twinPayload);
      const gw2 = await f.connect(); await setWorkerGatewayCaller(gw2);
      const facts = { operation: twinCmd.operation, node_id: a.id, payload_sha256: twinCmd.payload_sha256, nonce_sha256: hex(twinCmd.nonce), verified_at_ms: Date.now() };
      const runTwin = client => client.query('select public.clued_ci_node_command_v1($1,$2::jsonb,$3::jsonb,$4::jsonb) v',
        [hex(a.token), JSON.stringify(twinCmd), JSON.stringify(twinPayload), JSON.stringify(facts)]).then(r => r.rows[0].v);
      const both = await Promise.all([runTwin(gw), runTwin(gw2)]);
      assert.deepEqual(both.map(v => v.status).sort(), ['committed', 'committed'], JSON.stringify(both));
      assert.deepEqual(both.map(v => v.replayed).sort(), [false, true]);
      assert.equal(Number((await sql('select count(*) n from clued_private.ci_green_mirror_v1 where effect_key=$1', [twinKey])).n), 1);
      // Invalid records are refused, never coerced.
      for (const bad of [{ contract: 'other' }, { phase: 'proposed' }, { checkRunId: null }, { effectKey: 'X'.repeat(64) }, { externalId: 'clued-ci:x' },
        { at: 'not a time' }, { pr: 0 }, { extra: 1 }])
        refused(await send(a, 'green_mirror_append', { record: { ...record('posted'), ...bad } }), 'CI_GREEN_RECORD_INVALID');
      // Not a publisher: refused before the database.
      await qualify(plain);
      refused(await send(plain, 'green_mirror_append', { record: record('intent', digest(uuid())) }), 'CI_NODE_SCOPE_DENIED', 403);
      for (const at of ['now', 'infinity', '2026-11-06 10:00:00', '2026-11-06T10:00:00'])
        refused(await send(a, 'green_mirror_append', { record: record('posted', digest(uuid()), { at }) }), 'CI_GREEN_RECORD_INVALID');
      // Beyond 2^53 the Worker cannot even parse it; the database refuses it on its own too.
      for (const big of ['{"pr":9007199254740993}', '{"checkRunId":9007199254740993}']) {
        const doc = JSON.stringify(record('posted', digest(uuid()))).replace(/}$/, ',' + big.slice(1)).replace(/"(pr|checkRunId)":[0-9]+,/, (m, k) => big.includes(k) ? '' : m);
        assert.equal((await sql('select clued_private.ci_green_record_valid_v1($1::jsonb) v', [doc])).v, false, big);
      }
      assert.equal((await sql('select clued_private.ci_green_record_valid_v1($1::jsonb) v', [JSON.stringify(record('posted'))])).v, true);
      await assert.rejects(() => admin.query('update clued_private.ci_green_mirror_v1 set phase=phase'), /CI_PERMANENT_HISTORY/);
      await assert.rejects(() => admin.query('delete from clued_private.ci_green_mirror_v1'), /CI_PERMANENT_HISTORY/);
      const prerequisites = (await sql('select clued_private.ci_phase_external_prerequisites_v1($1,$2) v', [user, project])).v;
      assert.ok(prerequisites.includes('green_mirror_writers_3d')); assert.ok(!prerequisites.includes('green_mirror_2b'));
    });

    await t.test('the database refuses a command whose signed identity no longer matches the node row', async () => {
      const payload = { record: { contract: 'clued.independent-ci.green-ledger/1', phase: 'intent', repo: 'fixture/repository-12345', pr: 8, headSha: sha('h2'), baseSha: sha('base'),
        testTree: sha('tree'), testMergeSha: null, effectKey: digest(uuid()), externalId: 'independent-ci:control:x', checkRunId: null, at: new Date().toISOString(), detail: null } };
      const c = await command(a, 'green_mirror_append', payload);
      const verified = { operation: c.operation, node_id: a.id, payload_sha256: c.payload_sha256, nonce_sha256: hex(c.nonce), verified_at_ms: Date.now() };
      const run = async (cmd, token = a.token) => (await gw.query('select public.clued_ci_node_command_v1($1,$2::jsonb,$3::jsonb,$4::jsonb) v',
        [hex(token), JSON.stringify(cmd), JSON.stringify(payload), JSON.stringify({ ...verified, nonce_sha256: hex(cmd.nonce) })])).rows[0].v;
      for (const [change, code] of [[{ node_version: c.node_version + 1 }, 'CI_COMMAND_STALE_VERSION'], [{ key_version: 2 }, 'CI_COMMAND_STALE_VERSION'],
        [{ key_fingerprint: digest('k') }, 'CI_COMMAND_STALE_VERSION'], [{ binding_generation: 2 }, 'CI_COMMAND_PRINCIPAL_INVALID'],
        [{ project_id: f.project2 }, 'CI_COMMAND_PRINCIPAL_INVALID'], [{ job_id: uuid(), execution_generation: 1 }, 'CI_COMMAND_INVALID'],
        [{ expires_at_ms: Date.now() + 500000 }, 'CI_COMMAND_EXPIRED']]) {
        const v = await run({ ...c, ...change, nonce: crypto.randomBytes(32).toString('base64url') });
        assert.equal(v.error_code, code, JSON.stringify(change));
      }
      assert.equal((await run(c, b.token)).error_code, 'CI_NODE_TRUST_UNAVAILABLE');
      assert.equal((await run(c)).status, 'committed');
    });
    await t.test('retirement withdraws the node in one transaction; the seed gives a project with listed-state nodes its first version', async () => {
      const r = await makeNode(); await approve(r); await qualify(r);
      await nodeAction(r, 'drain');
      const before = (await f.native('clued_ci_nodes_v1', { project_id: project })).node_list.version;
      const retired = await nodeAction(r, 'retire');
      assert.equal(retired.state, 'retired'); assert.equal(retired.node_list_version, before + 1);
      const row = await nodeRow(r.id); assert.equal(row.qualification_status, 'expired'); assert.equal(row.eligible_until, null);
      assert.ok(!(await f.native('clued_ci_nodes_v1', { project_id: project })).node_list.nodes.some(x => x.node_id === r.id));
      // Seed: project2 gets an active node outside any apply (as a node approved before this migration).
      const reg = f.registration(f.project2); const p2 = f.committed(await f.native('clued_ci_node_registration_v1', reg));
      await admin.query("update clued_private.ci_nodes_v1 set state='active' where node_id=$1", [p2.node_id]);
      assert.equal((await sql('select count(*) n from clued_private.ci_node_lists_v1 where project_id=$1', [f.project2])).n, '0');
      const migration = await (await import('node:fs/promises')).readFile(path.join(cloud, 'supabase/migrations/20261106090000_ci_node_gateway_v1.sql'), 'utf8');
      const seed = migration.slice(migration.indexOf('do $seed$'), migration.indexOf('end $seed$;') + 'end $seed$;'.length);
      const versionBefore = (await f.native('clued_ci_nodes_v1', { project_id: project })).node_list.version;
      await admin.query(seed);
      const seeded = await sql('select * from clued_private.ci_node_lists_v1 where project_id=$1', [f.project2]);
      assert.equal(Number(seeded.list_version), 1); assert.equal(seeded.cause, 'seed'); assert.equal(seeded.nodes[0].node_id, p2.node_id);
      assert.equal((await f.native('clued_ci_nodes_v1', { project_id: project })).node_list.version, versionBefore, 'an unchanged list gets no new version');
      // Draining and retiring that node never creates a pool row in project2 (T2A would then see two CI projects).
      const act = async action => {
        const v = Number((await nodeRow(p2.node_id)).version);
        const issue = await f.native('clued_ci_node_confirmation_issue_v1', { project_id: f.project2, node_id: p2.node_id, base_version: v, action });
        return f.committed(await f.native('clued_ci_node_apply_v1', { confirmation_token: issue.confirmation_token, view_digest: issue.view_digest }));
      };
      await act('drain'); assert.equal((await act('retire')).state, 'retired');
      assert.equal((await sql("select count(*) n from clued_private.ci_quota_counters_v1 where project_id=$1 and row_kind='pool_policy'", [f.project2])).n, '0');
      assert.equal(Number((await sql('select max(list_version) v from clued_private.ci_node_lists_v1 where project_id=$1', [f.project2])).v), 3);
    });
  } finally { await f.close(); }
});
