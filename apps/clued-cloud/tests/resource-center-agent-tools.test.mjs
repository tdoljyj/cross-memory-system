import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';
const worker = await loadContinuityWorker();
const origin = 'https://clued.example.invalid';
const token = 'clued_bnd_' + 'a'.repeat(40);
const env = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_STORAGE_ACCOUNT_V1: 'true', CLUED_STORAGE_JOBS_V1: 'true',
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
  for (const flags of [{}, { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_STORAGE_ACCOUNT_V1: 'true' }, { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway", CLUED_STORAGE_JOBS_V1: 'true' }, env]) {
    const result = await (await worker.fetch(rpc('tools/list', {}), flags)).json();
    const tools = result.result.tools.filter(x => x.name.startsWith('clued_storage_'));
    assert.equal(tools.length, flags === env ? 4 : 0);
    if (flags !== env) assert.equal((await submit(undefined, flags)).status, 404);
    else {
      // clued_storage_connections (Decision 1721045d) says where connection_id comes from.
      assert.deepEqual(tools.map(x => x.name), ['clued_storage_submit', 'clued_storage_inspect', 'clued_storage_trash_batch', 'clued_storage_connections']);
      assert.equal(tools[0].annotations.readOnlyHint, false);
      assert.equal(tools[1].annotations.readOnlyHint, true);
      assert.equal(tools[0].inputSchema.additionalProperties, false);
      assert.equal(tools[0].inputSchema.properties.mutation.oneOf.length, 9);
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
    assert.equal(calls[0].headers.get('authorization'), 'Bearer test-worker-gateway');
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
    // A started job cancelled before it reached Drive names its fixed reason, with a fixed hint.
    reply = { ...status('cancelled'), reason_code: 'NO_PROVIDER_ATTEMPT' };
    const cancelled = await inspect();
    assert.equal(cancelled.isError, false); assert.equal(cancelled.structuredContent.reason_code, 'NO_PROVIDER_ATTEMPT');
    assert.match(cancelled.structuredContent.hint, /nothing was changed/);
    for (const state of ['started', 'uncertain', 'queued']) {
      reply = { ...status(state), reason_code: 'NO_PROVIDER_ATTEMPT' };
      assert.equal((await inspect()).isError, true, state);
    }
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

test('a directory move passes only in its exact shape (Drive ID, path, version, same name, another folder) and reaches the jobs RPC unchanged', async () => {
  const before = globalThis.fetch; const calls = [];
  globalThis.fetch = async (_url, init) => { calls.push(JSON.parse(init.body)); return Response.json(status()); };
  const root = 'G:/My Drive/Clued_资料中心/track';
  const good = [
    { operation: 'move', target_kind: 'directory', source_path: root + '/topic/folder', destination_path: root + '/other/folder',
      source_file_version: '9', source_file_id: 'drive-folder' },
    { operation: 'move', target_kind: 'directory', source_path: 'track/topic/folder', destination_path: 'track/folder',
      source_file_version: '9', source_file_id: 'drive-folder' },
  ];
  const bad = [
    { ...good[0], source_file_id: undefined }, { ...good[0], source_file_id: 'bad id' }, { ...good[0], source_file_version: '0' },
    { ...good[0], destination_path: root + '/other/renamed' }, { ...good[0], destination_path: root + '/topic/folder' },
    { ...good[0], destination_path: root + '/topic/folder/inner/folder' }, { ...good[0], operation: 'rename' },
    { ...good[0], directory_semantics: 'topic' }, { ...good[0], content: 'x' }, { ...good[0], destination_path: root + '/topic/../folder' },
  ].map(input => JSON.parse(JSON.stringify(input)));
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

test('a binary replace (staging_id with the observed version) passes in its exact shape and reaches the jobs RPC unchanged', async () => {
  const before = globalThis.fetch; const calls = [];
  globalThis.fetch = async (_url, init) => { calls.push(JSON.parse(init.body)); return Response.json(status()); };
  const binaryEnv = { ...env, CLUED_STORAGE_JOBS_V2: 'true', CLUED_STORAGE_GOOGLE_V1: 'true', CLUED_STORAGE_BINARY_V1: 'true' };
  const path = 'G:/My Drive/Clued_资料中心/track/topic/assets.xlsx';
  const good = { operation: 'replace', target_kind: 'file', destination_path: path, destination_file_version: '7',
    mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content_sha256: 'b'.repeat(64), staging_id: ref.job_id };
  const bad = [
    { ...good, destination_file_version: undefined }, { ...good, content: 'x' }, { ...good, restore_job_id: ref.job_id },
    { ...good, content_base64: 'AAAA' }, { ...good, content_sha256: 'nope' }, { ...good, staging_id: 'nope' },
    { ...good, mime_type: undefined }, { ...good, target_kind: 'directory' }, { ...good, source_path: path },
  ].map(m => JSON.parse(JSON.stringify(m)));
  try {
    for (const input of bad) {
      const reply = await (await submit({ ...ref, mutation: input }, binaryEnv)).json();
      assert.ok(reply.result?.isError === true || reply.error, JSON.stringify(input));
    }
    assert.equal(calls.length, 0);
    const reply = (await (await submit({ ...ref, mutation: good }, binaryEnv)).json()).result;
    assert.equal(reply.isError, false);
    assert.deepEqual(calls.at(-1).p_input, { ...ref, mutation: good, action: 'submit' });
    // Without the binary flags the same request is refused before any RPC.
    const off = await (await submit({ ...ref, mutation: good })).json();
    assert.ok(off.result?.isError === true || off.error);
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = before; }
});

test('trash and untrash pass only in their exact shape (Drive ID, path, version) and reach the jobs RPC as delete and restore', async () => {
  const before = globalThis.fetch; const calls = [];
  globalThis.fetch = async (_url, init) => { calls.push(JSON.parse(init.body)); return Response.json(status()); };
  const path = 'G:/My Drive/Clued_资料中心/track/topic/a.md';
  const item = { target_kind: 'file', source_path: path, source_file_version: '7', source_file_id: 'drive-a' };
  const good = [
    [{ operation: 'trash', ...item }, { operation: 'delete', ...item }],
    [{ operation: 'trash', ...item, target_kind: 'directory', source_path: 'track/empty' }, { operation: 'delete', ...item, target_kind: 'directory', source_path: 'track/empty' }],
    [{ operation: 'untrash', ...item, source_path: '90_待归类/a.md' }, { operation: 'restore', ...item, source_path: '90_待归类/a.md' }],
    // The user's explicit choices after restore_name_conflict.
    [{ operation: 'untrash', ...item, source_path: '90_待归类/a.md', restore_folder: '20_P/topic' },
      { operation: 'restore', ...item, source_path: '90_待归类/a.md', destination_path: '20_P/topic/a.md', restore_mode: 'folder' }],
    [{ operation: 'untrash', ...item, restore_name: 'a (2).md' },
      { operation: 'restore', ...item, destination_path: 'G:/My Drive/Clued_资料中心/track/topic/a (2).md', restore_mode: 'suffix' }],
  ];
  const bad = [
    { operation: 'trash', ...item, destination_path: path }, { operation: 'trash', ...item, source_file_version: '0' },
    { operation: 'trash', ...item, source_file_version: 7 }, { operation: 'trash', ...item, content: 'x' },
    { operation: 'trash', target_kind: 'file', source_path: path, source_file_version: '7' },
    { operation: 'trash', ...item, source_file_id: 'bad id' }, { operation: 'trash', ...item, restore_folder: 'x' },
    { operation: 'untrash', ...item, directory_semantics: 'topic' }, { operation: 'untrash', ...item, restore_folder: 'x', restore_name: 'a (1).md' },
    { operation: 'untrash', ...item, restore_name: 'b (1).md' }, { operation: 'untrash', ...item, restore_name: 'a (100).md' },
    { operation: 'untrash', ...item, restore_name: 'x/a (1).md' }, { operation: 'untrash', ...item, target_kind: 'directory', restore_name: 'a (1).md' },
    { operation: 'delete', ...item }, { operation: 'restore', ...item },
  ];
  try {
    for (const input of bad) {
      const reply = await (await submit({ ...ref, mutation: input })).json();
      assert.ok(reply.result?.isError === true || reply.error, JSON.stringify(input));
    }
    const invalid = (await (await submit({ ...ref, mutation: { operation: 'trash', ...item, source_path: '90_待归类/../a.md' } })).json()).result;
    assert.equal(invalid.structuredContent.error, 'storage_path_invalid');
    assert.equal(calls.length, 0);
    for (const [input, expected] of good) {
      const reply = (await (await submit({ ...ref, mutation: input })).json()).result;
      assert.equal(reply.isError, false, JSON.stringify(input));
      assert.deepEqual(calls.at(-1).p_input, { ...ref, mutation: expected, action: 'submit' });
    }
  } finally { globalThis.fetch = before; }
});

test('the trash limit and an untrash name conflict are fixed refusals with guidance that schedule nothing', async () => {
  const before = globalThis.fetch; const pending = []; let code;
  globalThis.fetch = async () => Response.json({ message: code, code: '42501' }, { status: 403 });
  const mutationOf = operation => ({ operation, target_kind: 'file', source_path: '90_待归类/a.md', source_file_version: '3', source_file_id: 'drive-a' });
  try {
    code = 'owner_batch_confirmation_required';
    let reply = (await (await submit({ ...ref, mutation: mutationOf('trash') }, env, { waitUntil: p => pending.push(p) })).json()).result;
    assert.equal(reply.isError, true); assert.equal(reply.structuredContent.error, 'owner_batch_confirmation_required');
    assert.match(reply.structuredContent.message, /clued_storage_trash_batch/); assert.match(reply.structuredContent.message, /全部确认/);
    code = 'restore_name_conflict';
    reply = (await (await submit({ ...ref, mutation: mutationOf('untrash') }, env, { waitUntil: p => pending.push(p) })).json()).result;
    assert.equal(reply.structuredContent.error, 'restore_name_conflict');
    assert.match(reply.structuredContent.message, /ask the user/); assert.match(reply.structuredContent.message, /restore_folder/);
    assert.match(reply.structuredContent.message, /restore_name/);
    assert.equal(pending.length, 0);
  } finally { globalThis.fetch = before; }
});

test('inspect adds a fixed Worker hint for RESTORE_NAME_CONFLICT, DIRECTORY_NOT_EMPTY, DIRECTORY_SHARING_DIFFERS, SUBTREE_DRIFT, DIRECTORY_ACCESS_UNAVAILABLE and PARENT_UNREGISTERED only', async () => {
  const before = globalThis.fetch; let reason;
  globalThis.fetch = async () => Response.json({ ...status('denied'), reason_code: reason, hint: 'database text must not pass' });
  try {
    const expected = { RESTORE_NAME_CONFLICT: /ask the user/, DIRECTORY_NOT_EMPTY: /empty directory/,
      DIRECTORY_SHARING_DIFFERS: /same access/, SUBTREE_DRIFT: /Nothing was moved/, DIRECTORY_ACCESS_UNAVAILABLE: /permissions/,
      PARENT_UNREGISTERED: /adopt the folder first/, CLOUD_REPLACE_TARGET_UNREGISTERED: /adopt the file first/ };
    for (reason of Object.keys(expected)) {
      const r = (await (await call('clued_storage_inspect', ref, env, { waitUntil: () => {} })).json()).result;
      assert.equal(r.structuredContent.reason_code, reason); assert.match(r.structuredContent.hint, expected[reason]);
    }
    reason = 'UNAUTHORIZED_WORKSPACE_MUTATION';
    const r = (await (await call('clued_storage_inspect', ref, env, { waitUntil: () => {} })).json()).result;
    assert.equal('hint' in r.structuredContent, false);
  } finally { globalThis.fetch = before; }
});

// StorageFullCapability P7 (Decisions 746fd078, 6dc1cf20).
test('adopt passes only in its exact shape (path and Drive ID) and reaches the jobs RPC unchanged', async () => {
  const before = globalThis.fetch; const calls = [];
  globalThis.fetch = async (_url, init) => { calls.push(JSON.parse(init.body)); return Response.json(status()); };
  const item = { operation: 'adopt', target_kind: 'file', source_path: '20_P/uploads/manual.pdf', source_file_id: 'drive-m' };
  const bad = [{ ...item, source_file_version: '3' }, { ...item, destination_path: '20_P/x.pdf' }, { ...item, source_file_id: 'bad id' },
    { ...item, target_kind: 'link' }, { operation: 'adopt', target_kind: 'file', source_path: item.source_path }, { ...item, content: 'x' },
    { ...item, directory_semantics: 'topic' }];
  try {
    for (const input of bad) {
      const reply = await (await submit({ ...ref, mutation: input })).json();
      assert.ok(reply.result?.isError === true || reply.error, JSON.stringify(input));
    }
    const invalid = (await (await submit({ ...ref, mutation: { ...item, source_path: '20_P/../x.pdf' } })).json()).result;
    assert.equal(invalid.structuredContent.error, 'storage_path_invalid');
    assert.equal(calls.length, 0);
    for (const input of [item, { ...item, target_kind: 'directory', source_path: 'G:/My Drive/Clued_资料中心/20_P/uploads' }]) {
      const reply = (await (await submit({ ...ref, mutation: input })).json()).result;
      assert.equal(reply.isError, false, JSON.stringify(input));
      assert.deepEqual(calls.at(-1).p_input, { ...ref, mutation: input, action: 'submit' });
    }
  } finally { globalThis.fetch = before; }
});

test('adopt refusals before any job and its execution reasons carry fixed guidance and schedule nothing', async () => {
  const before = globalThis.fetch; const pending = []; let code;
  globalThis.fetch = async () => Response.json({ message: code, code: '42501' }, { status: 403 });
  const item = { operation: 'adopt', target_kind: 'file', source_path: '20_P/uploads/manual.pdf', source_file_id: 'drive-m' };
  try {
    for (const [refusal, pattern] of [['adopt_scope_upgrade_required', /allow managing existing files/], ['adopt_already_registered', /do not adopt it again/]]) {
      code = refusal;
      const reply = (await (await submit({ ...ref, mutation: item }, env, { waitUntil: p => pending.push(p) })).json()).result;
      assert.equal(reply.isError, true); assert.equal(reply.structuredContent.error, refusal); assert.match(reply.structuredContent.message, pattern);
    }
    assert.equal(pending.length, 0);
  } finally { globalThis.fetch = before; }
  let reason;
  globalThis.fetch = async () => Response.json({ ...status(reason === 'ADOPT_NOT_SETTLED' ? 'cancelled' : 'denied'), reason_code: reason });
  try {
    const expected = { ADOPT_SCOPE_UPGRADE_REQUIRED: /allow managing existing files/, ADOPT_TARGET_UNSUPPORTED: /shortcut/,
      ADOPT_NOT_SETTLED: /nothing was registered/, SCOPE_UPGRADE_REQUIRED: /not created by BeamingFace/, PROVIDER_OWNER_REQUIRED: /adopted/ };
    for (reason of Object.keys(expected)) {
      const r = (await (await call('clued_storage_inspect', ref, env, { waitUntil: () => {} })).json()).result;
      assert.equal(r.structuredContent.reason_code, reason); assert.match(r.structuredContent.hint, expected[reason], reason);
    }
  } finally { globalThis.fetch = before; }
});

test('clued_storage_trash_batch registers one batch through its own RPC and returns only fixed fields', async () => {
  const before = globalThis.fetch; const calls = []; let reply;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return Response.json(reply); };
  const batch = { connection_id: ref.connection_id, batch_id: '40000000-0000-4000-8000-000000000004',
    items: [{ operation: 'trash', target_kind: 'file', source_path: '90_待归类/a.md', source_file_version: '3', source_file_id: 'drive-a' },
      { operation: 'untrash', target_kind: 'directory', source_path: '90_待归类/old', source_file_version: '2', source_file_id: 'drive-d' }] };
  const view = { batch_id: batch.batch_id, connection_id: ref.connection_id, status: 'pending', expires_at: '2026-10-02T00:00:00Z',
    created_at: '2026-10-01T00:00:00Z', execution_permitted: false, replayed: false, private_owner_field: 'x',
    items: [{ operation: 'delete', target_kind: 'file', path: '/r/90_待归类/a.md', provider_file_id: 'drive-a', provider_file_version: '3', used: false, current: true }] };
  try {
    for (const input of [{ ...batch, items: [] }, { ...batch, items: [{ ...batch.items[0], restore_name: 'a (1).md' }] },
      { ...batch, items: [{ ...batch.items[0], operation: 'delete' }] }, { ...batch, extra: 1 }, { ...batch, batch_id: 'x' },
      { ...batch, items: Array.from({ length: 51 }, () => batch.items[0]) }]) {
      const r = (await (await call('clued_storage_trash_batch', input)).json()).result;
      assert.equal(r.isError, true, JSON.stringify(input));
    }
    assert.equal(calls.length, 0);
    reply = view;
    const r = (await (await call('clued_storage_trash_batch', batch)).json()).result;
    assert.equal(r.isError, false);
    assert.equal(calls[0].url, env.SUPABASE_URL + '/rest/v1/rpc/clued_storage_trash_batch_v1');
    assert.deepEqual(calls[0].body, { p_token_hash: createHash('sha256').update(token).digest('hex'), p_input: { ...batch,
      items: [{ ...batch.items[0], operation: 'delete' }, { ...batch.items[1], operation: 'restore' }] } });
    assert.deepEqual(r.structuredContent, { batch_id: batch.batch_id, connection_id: ref.connection_id, status: 'pending',
      expires_at: view.expires_at, items: [{ operation: 'trash', target_kind: 'file', path: '/r/90_待归类/a.md', provider_file_id: 'drive-a',
        provider_file_version: '3', used: false }], execution_permitted: false, replayed: false });
    reply = { ...view, execution_permitted: true };
    assert.equal((await (await call('clued_storage_trash_batch', batch)).json()).result.isError, true);
    globalThis.fetch = async () => Response.json({ message: 'storage_trash_batch_item_unavailable', code: '22023' }, { status: 400 });
    const refused = (await (await call('clued_storage_trash_batch', batch)).json()).result;
    assert.equal(refused.structuredContent.error, 'storage_trash_batch_item_unavailable');
    globalThis.fetch = async () => Response.json({ message: 'storage_trash_batch_pending_limit', code: '42501' }, { status: 403 });
    const limited = (await (await call('clued_storage_trash_batch', batch)).json()).result;
    assert.equal(limited.structuredContent.error, 'storage_trash_batch_pending_limit'); assert.match(limited.structuredContent.message, /5 batches/);
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

test('work_claim passes through to the storage RPCs; a Work Claim refusal is a structured error that dispatches nothing', async () => {
  const before = globalThis.fetch; const calls = []; let reply;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return Response.json(reply); };
  const claim = { claim_id: '50000000-0000-4000-8000-000000000005', fence: 2 };
  const batch = { connection_id: ref.connection_id, batch_id: '40000000-0000-4000-8000-000000000004',
    items: [{ operation: 'trash', target_kind: 'file', source_path: '90_待归类/a.md', source_file_version: '3', source_file_id: 'drive-a' }] };
  const tools = (await (await worker.fetch(rpc('tools/list', {}), env)).json()).result.tools;
  for (const name of ['clued_storage_submit', 'clued_storage_trash_batch']) {
    const schema = tools.find(x => x.name === name).inputSchema.properties.work_claim;
    assert.deepEqual([schema.required, schema.additionalProperties], [['claim_id', 'fence'], false]);
    assert.match(tools.find(x => x.name === name).description, /work_claim_conflict/);
  }
  const conflict = { status: 'rejected', error_code: 'work_claim_conflict', door: 'clued-storage',
    resources: ['storage:' + ref.connection_id + '/track/topic/example.md'], private_field: 'x',
    conflicts: [{ claim_id: claim.claim_id, task_id: '60000000-0000-4000-8000-000000000006', holder_binding_id: '70000000-0000-4000-8000-000000000007',
      holder_session_ref: 'session-a', status: 'ACTIVE', fence: 1, expires_at: '2026-10-03T08:00:00Z',
      overlap: { same_task: null, paths: ['storage:' + ref.connection_id + '/track/**'], trigger_refs: [] } }] };
  const pending = [];
  try {
    // Malformed claims fail at the tool boundary without a request.
    for (const work_claim of [{}, { claim_id: claim.claim_id }, { ...claim, fence: 0 }, { ...claim, fence: '2' }, { ...claim, extra: 1 }, { claim_id: 'x', fence: 1 }]) {
      assert.equal((await (await submit({ ...ref, mutation, work_claim })).json()).result.isError, true, JSON.stringify(work_claim));
      assert.equal((await (await call('clued_storage_trash_batch', { ...batch, work_claim })).json()).result.isError, true);
    }
    assert.equal((await (await call('clued_storage_inspect', { ...ref, work_claim: claim })).json()).result.isError, true);
    assert.equal(calls.length, 0);
    // A valid claim reaches both RPCs unchanged.
    reply = status();
    assert.equal((await (await submit({ ...ref, mutation, work_claim: claim })).json()).result.isError, false);
    assert.deepEqual(calls.at(-1).body.p_input, { ...ref, mutation, work_claim: claim, action: 'submit' });
    reply = { status: 'rejected', error_code: 'work_claim_not_covered', uncovered: ['storage:x/y'], resources: ['storage:x/y'] };
    const batchRefused = (await (await call('clued_storage_trash_batch', { ...batch, work_claim: claim })).json()).result;
    assert.equal(calls.at(-1).url, env.SUPABASE_URL + '/rest/v1/rpc/clued_storage_trash_batch_v1');
    assert.deepEqual(calls.at(-1).body.p_input.work_claim, claim);
    assert.equal(batchRefused.isError, true);
    assert.deepEqual(batchRefused.structuredContent, { status: 'rejected', error: 'work_claim_not_covered',
      message: batchRefused.structuredContent.message, uncovered: ['storage:x/y'], resources: ['storage:x/y'] });
    // A conflict: fixed fields only, isError, no dispatch.
    reply = conflict;
    const refused = (await (await submit({ ...ref, mutation }, env, { waitUntil: p => pending.push(p) })).json()).result;
    assert.equal(refused.isError, true);
    assert.deepEqual(refused.structuredContent, { status: 'rejected', error: 'work_claim_conflict', message: refused.structuredContent.message,
      conflicts: [{ claim_id: claim.claim_id, task_id: conflict.conflicts[0].task_id, holder_binding_id: conflict.conflicts[0].holder_binding_id,
        holder_session_ref: 'session-a', expires_at: '2026-10-03T08:00:00Z', paths: conflict.conflicts[0].overlap.paths }],
      resources: conflict.resources });
    assert.match(refused.structuredContent.message, /tell the user/);
    assert.equal(pending.length, 0);
    // An unknown rejection code is not passed through.
    reply = { status: 'rejected', error_code: 'something_else', resources: [] };
    assert.equal((await (await submit({ ...ref, mutation })).json()).result.structuredContent.error, 'storage_job_unavailable');
  } finally { globalThis.fetch = before; }
});
