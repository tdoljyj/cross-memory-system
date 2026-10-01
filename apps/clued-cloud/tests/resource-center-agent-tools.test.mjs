import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';
const worker = await loadContinuityWorker();
const origin = 'https://clued.example.invalid';
const token = 'clued_bnd_' + 'a'.repeat(40);
const env = { CLUED_STORAGE_ACCOUNT_V1: 'true', CLUED_STORAGE_JOBS_V1: 'true',
  SUPABASE_URL: 'https://db.example.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture-public-key' };
const ref = { connection_id: '20000000-0000-4000-8000-000000000001', job_id: '10000000-0000-4000-8000-000000000001' };
const mutation = { operation: 'create', target_kind: 'file', destination_path: 'G:/My Drive/Clued_资料中心/track/topic/example.md', content: 'fixture' };
const status = (state = 'queued') => ({ ...ref, status: state, request_digest: 'a'.repeat(64), intent_id: null,
  receipt_id: '30000000-0000-4000-8000-000000000001', execution_permitted: false });
const rpc = (method, params, bearer = token) => new Request(origin + '/mcp', { method: 'POST',
  headers: { 'content-type': 'application/json', origin, ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
const call = (name, args, config = env, ctx, bearer = token) => worker.fetch(rpc('tools/call', { name, arguments: args }, bearer), config, ctx);
const submit = (args = { ...ref, mutation }, config = env, ctx, bearer = token) => call('clued_storage_submit', args, config, ctx, bearer);

test('discovery and guessed calls require both existing account/jobs flags; no private tools', async () => {
  for (const flags of [{}, { CLUED_STORAGE_ACCOUNT_V1: 'true' }, { CLUED_STORAGE_JOBS_V1: 'true' }, env]) {
    const result = await (await worker.fetch(rpc('tools/list', {}), flags)).json();
    const tools = result.result.tools.filter(x => x.name.startsWith('clued_storage_'));
    assert.equal(tools.length, flags === env ? 2 : 0);
    if (flags !== env) assert.equal((await submit(undefined, flags)).status, 404);
    else {
      assert.deepEqual(tools.map(x => x.name), ['clued_storage_submit', 'clued_storage_inspect']);
      assert.equal(tools[0].annotations.readOnlyHint, false);
      assert.equal(tools[1].annotations.readOnlyHint, true);
      assert.equal(tools[0].inputSchema.additionalProperties, false);
      assert.equal(tools[0].inputSchema.properties.mutation.oneOf.length, 7);
    }
  }
  for (const name of ['clued_storage_begin', 'clued_storage_admission', 'clued_storage_grant', 'clued_storage_credential']) {
    assert.equal((await call(name, ref)).status, 404);
  }
});

test('MCP requires an actual Binding transport and rejects caller authority before RPC', async () => {
  const before = globalThis.fetch; let count = 0;
  globalThis.fetch = async () => { count++; throw new Error('must not fetch'); };
  try {
    for (const bearer of ['', 'native-jwt', 'clued_bnd_short', 'service-role']) {
      assert.equal((await (await submit(undefined, env, undefined, bearer)).json()).result.isError, true);
    }
    const inputs = [null, [], { ...ref, mutation, owner_id: ref.job_id }, { ...ref, mutation, action: 'begin' },
      { ...ref, mutation, admission: 'forged' }, { ...ref, job_id: 'not-uuid', mutation },
      ...['managed_root', 'profile_id', 'artifact_role', 'policy_version', 'source_path', 'deletion_authority', 'currentness'].map(k => ({ ...ref, mutation: { ...mutation, [k]: 'forged' } })),
      { ...ref, mutation: { ...mutation, operation: 'delete' } }, { ...ref, mutation: { ...mutation, operation: 'replace' } },
      { ...ref, mutation: { ...mutation, directory_semantics: 'topic' } },
      { ...ref, mutation: { ...mutation, content: '字'.repeat(350000) } },
      { ...ref, mutation: { operation: 'create', target_kind: 'directory', destination_path: '/x', directory_semantics: 'status' } }];
    for (const input of inputs) {
      const reply = await (await submit(input)).json();
      assert.ok(reply.result?.isError === true || reply.error, 'invalid input must fail at parser or tool boundary');
    }
    assert.equal((await (await call('clued_storage_inspect', { ...ref, mutation })).json()).result.isError, true);
    assert.equal(count, 0);
  } finally { globalThis.fetch = before; }
});

test('write, delete, replace without a file version or content, and rename/move without a source version are rejected before any RPC or dispatch', async () => {
  const before = globalThis.fetch; let count = 0;
  const source = mutation.destination_path;
  const cases = [
    { operation: 'write', target_kind: 'file', destination_path: source, content: 'changed bytes' },
    { operation: 'replace', target_kind: 'file', destination_path: source, content: 'replacement bytes' },
    { operation: 'replace', target_kind: 'file', destination_path: source, destination_file_version: '3' },
    { operation: 'move', target_kind: 'file', source_path: source, destination_path: 'G:/My Drive/Clued_资料中心/track/other-topic/example.md' },
    { operation: 'rename', target_kind: 'file', source_path: source, destination_path: 'G:/My Drive/Clued_资料中心/track/topic/renamed.md' },
    { operation: 'delete', target_kind: 'file', source_path: source },
  ];
  globalThis.fetch = async () => { count++; throw new Error('must not fetch'); };
  try {
    for (const input of cases) {
      const pending = [];
      const reply = await (await submit({ ...ref, mutation: input }, env, { waitUntil: p => pending.push(p) })).json();
      assert.ok(reply.result?.isError === true || reply.error, input.operation + ' must be rejected');
      assert.equal(count, 0, input.operation + ' must not reach an RPC');
      assert.equal(pending.length, 0, input.operation + ' must not schedule execution');
    }
  } finally { globalThis.fetch = before; }
});

test('same existing jobs RPC hashes Binding, uses anon, whitelists response and never grants execution to caller', async () => {
  const before = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers) });
    return Response.json({ ...status(), credential_envelope: 'private', access_token: 'private', admission: { private: true }, owner_id: 'private' });
  };
  try {
    const response = await submit();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const reply = (await response.json()).result;
    assert.equal(reply.isError, false); assert.deepEqual(reply.structuredContent, status());
    assert.equal(JSON.stringify(reply).includes('private'), false);
    assert.equal(calls[0].url, env.SUPABASE_URL + '/rest/v1/rpc/clued_storage_jobs_v1');
    assert.deepEqual(calls[0].body, { p_token_hash: createHash('sha256').update(token).digest('hex'), p_input: { ...ref, mutation, action: 'submit' } });
    assert.equal(calls[0].headers.get('authorization'), 'Bearer fixture-public-key');
  } finally { globalThis.fetch = before; }
});

test('inspect all durable states is read-only; repeated submit keeps the exact identity/payload', async () => {
  const before = globalThis.fetch; const calls = [], pending = [];
  let state = 'queued';
  globalThis.fetch = async (_url, init) => { calls.push(JSON.parse(init.body)); return Response.json({ ...status(state), replayed: true }); };
  try {
    for (state of ['queued', 'prepared', 'started', 'uncertain', 'committed', 'cancelled', 'denied', 'attention_required']) {
      const r = (await (await call('clued_storage_inspect', ref, env, { waitUntil: p => pending.push(p) })).json()).result;
      assert.equal(r.isError, false); assert.equal(r.structuredContent.status, state);
    }
    assert.equal(pending.length, 0);
    await submit(); await submit(); assert.deepEqual(calls.at(-1), calls.at(-2));
  } finally { globalThis.fetch = before; }
});

test('inspect exposes only the fixed reason_code of a denied or attention_required job', async () => {
  const before = globalThis.fetch; let reply;
  globalThis.fetch = async () => Response.json(reply);
  const inspect = async () => (await (await call('clued_storage_inspect', ref, env, { waitUntil: () => {} })).json()).result;
  try {
    for (const state of ['denied', 'attention_required']) {
      reply = { ...status(state), reason_code: 'UNAUTHORIZED_WORKSPACE_MUTATION',
        findings: [{ path: 'G:/My Drive/Clued_private.md', reason: 'unregistered_clued_resource_location' }] };
      const r = await inspect();
      assert.equal(r.isError, false); assert.equal(r.structuredContent.reason_code, 'UNAUTHORIZED_WORKSPACE_MUTATION');
      assert.equal(JSON.stringify(r).includes('Clued_private'), false);
    }
    for (const bad of [{ ...status('committed'), reason_code: 'UNAUTHORIZED_WORKSPACE_MUTATION' },
      { ...status('denied'), reason_code: 'not a code' }, { ...status('denied'), reason_code: 7 }]) {
      reply = bad; const r = await inspect();
      assert.equal(r.isError, true); assert.equal(r.structuredContent.reason_code, undefined);
    }
    reply = status('denied'); assert.equal('reason_code' in (await inspect()).structuredContent, false);
  } finally { globalThis.fetch = before; }
});

test('database denials/lost replies do not retry, disclose internal diagnostics or assert completion', async () => {
  const before = globalThis.fetch; let count = 0;
  try {
    for (const denial of ['storage_binding_denied', 'revoked', 'storage_job_identity_conflict', 'network']) {
      globalThis.fetch = async () => { count++; if (denial === 'network') throw new Error('private-secret');
        return Response.json({ message: 'private-secret ' + denial, code: '42501' }, { status: 403 }); };
      const beforeCount = count, pending = [];
      const result = (await (await submit(undefined, env, { waitUntil: p => pending.push(p) })).json()).result;
      assert.equal(result.isError, true); assert.equal(count, beforeCount + 1); assert.equal(pending.length, 0);
      assert.equal(JSON.stringify(result).includes('private-secret'), false);
      assert.equal(result.structuredContent.error, 'storage_job_unavailable');
    }
  } finally { globalThis.fetch = before; }
});

test('only server-returned same-job references schedule fixed executor, inspect never schedules', async () => {
  const before = globalThis.fetch; const calls = [], pending = [];
  const secret = 'synthetic-fixed-issuer-'.repeat(3);
  const enabled = { ...env, CLUED_STORAGE_GOOGLE_V1: 'true', CLUED_STORAGE_EXECUTOR_V1: 'true', CLUED_STORAGE_CONNECTOR_ISSUER: secret,
    CLUED_STORAGE_GOOGLE_CLIENT_ID: 'fixture-client', CLUED_STORAGE_VAULT_KEYS: JSON.stringify({ current_key_id: 'v1', keys: { v1: Buffer.alloc(32, 7).toString('base64url') } }) };
  let mismatch = false;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url: String(url), body });
    if (String(url).endsWith('/clued_storage_jobs_v1')) return Response.json({ ...status(), ...(mismatch ? { job_id: ref.connection_id } : {}) });
    assert.equal(String(url), env.SUPABASE_URL + '/rest/v1/rpc/clued_storage_cloud_worker_v1');
    assert.equal(body.p_issuer_hash, createHash('sha256').update(secret).digest('hex'));
    if (body.p_input.action === 'recovery_load') return Response.json({ error: 'not_recoverable' }, { status: 403 });
    assert.deepEqual(body.p_input, { ...ref, action: 'load' });
    return Response.json({ ...ref, contract: 'clued.storage-job-execution/1', owner_id: ref.connection_id, request_digest: 'a'.repeat(64), status: 'committed' });
  };
  try {
    const ctx = { waitUntil: p => pending.push(p) };
    assert.equal((await (await submit(undefined, enabled, ctx)).json()).result.isError, false);
    await Promise.all(pending); assert.equal(calls.length, 3); assert.equal(pending.length, 1);
    await call('clued_storage_inspect', ref, enabled, ctx); assert.equal(calls.length, 4); assert.equal(pending.length, 1);
    mismatch = true;
    assert.equal((await (await submit(undefined, enabled, ctx)).json()).result.isError, true);
    assert.equal(pending.length, 1);
  } finally { globalThis.fetch = before; }
});

test('rename and file move pass only in their exact shape and reach the same jobs RPC unchanged', async () => {
  const before = globalThis.fetch; const calls = [];
  globalThis.fetch = async (_url, init) => { calls.push(JSON.parse(init.body)); return Response.json(status()); };
  const root = 'G:/My Drive/Clued_资料中心/track';
  const good = [
    { operation: 'rename', target_kind: 'file', source_path: root + '/topic/a.md', destination_path: root + '/topic/b.md', source_file_version: '7' },
    { operation: 'move', target_kind: 'file', source_path: root + '/topic/a.md', destination_path: root + '/other/a.md', source_file_version: '12' },
  ];
  const bad = [
    { ...good[0], destination_path: root + '/other/b.md' }, { ...good[0], destination_path: good[0].source_path },
    { ...good[1], destination_path: root + '/other/b.md' }, { ...good[1], destination_path: good[1].source_path },
    { ...good[0], target_kind: 'directory' }, { ...good[0], source_file_version: '0' }, { ...good[0], source_file_version: 7 },
    { ...good[0], content: 'x' }, { ...good[1], directory_semantics: 'topic' },
  ];
  try {
    for (const input of bad) {
      const reply = await (await submit({ ...ref, mutation: input })).json();
      assert.ok(reply.result?.isError === true || reply.error, JSON.stringify(input));
    }
    assert.equal(calls.length, 0);
    for (const input of good) {
      const reply = (await (await submit({ ...ref, mutation: input })).json()).result;
      assert.equal(reply.isError, false);
      assert.deepEqual(calls.at(-1).p_input, { ...ref, mutation: input, action: 'submit' });
    }
  } finally { globalThis.fetch = before; }
});

test('replace passes with new content or a restore job in its exact shape and reaches the same jobs RPC unchanged', async () => {
  const before = globalThis.fetch; const calls = [];
  globalThis.fetch = async (_url, init) => { calls.push(JSON.parse(init.body)); return Response.json(status()); };
  const path = 'G:/My Drive/Clued_资料中心/track/topic/a.md';
  const good = [
    { operation: 'replace', target_kind: 'file', destination_path: path, destination_file_version: '7', content: 'new text' },
    { operation: 'replace', target_kind: 'file', destination_path: path, destination_file_version: '9', restore_job_id: ref.job_id },
  ];
  const bad = [
    { ...good[0], restore_job_id: ref.job_id }, { ...good[0], destination_file_version: '0' }, { ...good[0], destination_file_version: 7 },
    { ...good[0], content: '字'.repeat(350000) }, { ...good[0], source_path: path }, { ...good[0], target_kind: 'directory' },
    { ...good[1], restore_job_id: 'not-a-uuid' }, { ...good[1], directory_semantics: 'topic' },
  ];
  try {
    for (const input of bad) {
      const reply = await (await submit({ ...ref, mutation: input })).json();
      assert.ok(reply.result?.isError === true || reply.error, JSON.stringify(input));
    }
    assert.equal(calls.length, 0);
    for (const input of good) {
      const reply = (await (await submit({ ...ref, mutation: input })).json()).result;
      assert.equal(reply.isError, false);
      assert.deepEqual(calls.at(-1).p_input, { ...ref, mutation: input, action: 'submit' });
    }
  } finally { globalThis.fetch = before; }
});

test('trash and untrash pass only in their exact shape and reach the jobs RPC as delete and restore', async () => {
  const before = globalThis.fetch; const calls = [];
  globalThis.fetch = async (_url, init) => { calls.push(JSON.parse(init.body)); return Response.json(status()); };
  const path = 'G:/My Drive/Clued_资料中心/track/topic/a.md';
  const good = [
    [{ operation: 'trash', target_kind: 'file', source_path: path, source_file_version: '7' }, 'delete'],
    [{ operation: 'untrash', target_kind: 'file', source_path: '90_待归类/a.md', source_file_version: '8' }, 'restore'],
  ];
  const bad = [
    { ...good[0][0], destination_path: path }, { ...good[0][0], source_file_version: '0' }, { ...good[0][0], source_file_version: 7 },
    { ...good[0][0], target_kind: 'directory' }, { ...good[0][0], content: 'x' }, { operation: 'trash', target_kind: 'file', source_path: path },
    { ...good[1][0], directory_semantics: 'topic' }, { operation: 'delete', target_kind: 'file', source_path: path, source_file_version: '7' },
    { operation: 'restore', target_kind: 'file', source_path: path, source_file_version: '7' },
  ];
  try {
    for (const input of bad) {
      const reply = await (await submit({ ...ref, mutation: input })).json();
      assert.ok(reply.result?.isError === true || reply.error, JSON.stringify(input));
    }
    const invalid = (await (await submit({ ...ref, mutation: { ...good[0][0], source_path: '90_待归类/../a.md' } })).json()).result;
    assert.equal(invalid.structuredContent.error, 'storage_path_invalid');
    assert.equal(calls.length, 0);
    for (const [input, operation] of good) {
      const reply = (await (await submit({ ...ref, mutation: input })).json()).result;
      assert.equal(reply.isError, false);
      assert.deepEqual(calls.at(-1).p_input, { ...ref, mutation: { ...input, operation }, action: 'submit' });
    }
  } finally { globalThis.fetch = before; }
});

test('the trash limit refusal is a fixed code with guidance and schedules nothing', async () => {
  const before = globalThis.fetch; const pending = [];
  globalThis.fetch = async () => Response.json({ message: 'storage_trash_confirmation_required', code: '42501' }, { status: 403 });
  try {
    const reply = (await (await submit({ ...ref, mutation: { operation: 'trash', target_kind: 'file',
      source_path: '90_待归类/a.md', source_file_version: '3' } }, env, { waitUntil: p => pending.push(p) })).json()).result;
    assert.equal(reply.isError, true);
    assert.equal(reply.structuredContent.error, 'storage_trash_confirmation_required');
    assert.match(reply.structuredContent.message, /Owner/);
    assert.equal(pending.length, 0);
  } finally { globalThis.fetch = before; }
});

test('root-relative and full paths both reach the jobs RPC as given; malformed paths are storage_path_invalid before any RPC', async () => {
  const before = globalThis.fetch; const calls = []; let refusal = null;
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return refusal ? Response.json({ message: refusal, code: '22023' }, { status: 400 }) : Response.json(status());
  };
  const full = 'G:/My Drive/Clued_资料中心';
  const good = [
    { operation: 'create', target_kind: 'file', destination_path: '90_待归类/笔记.md', content: 'x' },
    { operation: 'create', target_kind: 'directory', destination_path: '90_待归类/新主题', directory_semantics: 'topic' },
    { operation: 'rename', target_kind: 'file', source_path: '90_待归类/a.md', destination_path: '90_待归类/b.md', source_file_version: '3' },
    { operation: 'rename', target_kind: 'file', source_path: 'a.md', destination_path: 'b.md', source_file_version: '3' },
    { operation: 'rename', target_kind: 'file', source_path: full + '/90_待归类/a.md', destination_path: '90_待归类/b.md', source_file_version: '3' },
    { operation: 'move', target_kind: 'file', source_path: '90_待归类/a.md', destination_path: full + '/20_P/a.md', source_file_version: '3' },
    { operation: 'replace', target_kind: 'file', destination_path: '90_待归类/a.md', destination_file_version: '4', content: 'y' },
  ];
  const invalid = ['90_待归类/../x.md', '../x.md', './x.md', '90_待归类//x.md', '90_待归类/', 'a\\b.md', 'a\u0001b.md', full + '/../x.md'];
  try {
    for (const path of invalid) {
      for (const input of [{ ...mutation, destination_path: path },
        { operation: 'rename', target_kind: 'file', source_path: path, destination_path: '90_待归类/b.md', source_file_version: '3' }]) {
        const pending = [];
        const reply = (await (await submit({ ...ref, mutation: input }, env, { waitUntil: p => pending.push(p) })).json()).result;
        assert.equal(reply.isError, true, path);
        assert.equal(reply.structuredContent.error, 'storage_path_invalid', path);
        assert.match(reply.structuredContent.message, /relative to the connection's registered root/);
        assert.equal(pending.length, 0);
      }
    }
    // Mixed forms still keep the rename (new name) / move (same name) distinction.
    for (const input of [
      { operation: 'rename', target_kind: 'file', source_path: full + '/90_待归类/a.md', destination_path: '90_待归类/a.md', source_file_version: '3' },
      { operation: 'move', target_kind: 'file', source_path: full + '/90_待归类/a.md', destination_path: '20_P/b.md', source_file_version: '3' }]) {
      assert.equal((await (await submit({ ...ref, mutation: input })).json()).result.isError, true, JSON.stringify(input));
    }
    assert.equal(calls.length, 0);
    for (const input of good) {
      const reply = (await (await submit({ ...ref, mutation: input })).json()).result;
      assert.equal(reply.isError, false, JSON.stringify(input));
      assert.deepEqual(calls.at(-1).p_input, { ...ref, mutation: input, action: 'submit' }, 'the database canonicalizes, not the Worker');
    }
    // The database's fixed refusals are passed on as the same fixed codes, never as storage_job_unavailable.
    for (const code of ['storage_path_outside_root', 'storage_path_invalid']) {
      refusal = code;
      const pending = [];
      const reply = (await (await submit({ ...ref, mutation: { ...mutation, destination_path: 'G:/Other/x.md' } }, env, { waitUntil: p => pending.push(p) })).json()).result;
      assert.equal(reply.isError, true); assert.equal(reply.structuredContent.error, code);
      assert.equal(JSON.stringify(reply).includes('G:/Other'), false, 'no path in the refusal');
      assert.equal(pending.length, 0);
    }
  } finally { globalThis.fetch = before; }
});

test('tool descriptions say both relative and full paths are accepted', async () => {
  const tools = (await (await worker.fetch(rpc('tools/list', {}), env)).json()).result.tools;
  const submitTool = tools.find(x => x.name === 'clued_storage_submit');
  assert.match(submitTool.description, /relative to the connection's registered root/);
  for (const variant of submitTool.inputSchema.properties.mutation.oneOf) {
    for (const key of ['destination_path', 'source_path']) {
      if (variant.properties[key]) assert.match(variant.properties[key].description, /relative to the connection's registered root.*full path/, key);
    }
  }
});
