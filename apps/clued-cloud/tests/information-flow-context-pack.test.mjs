import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { Tiktoken, getEncodingNameForModel } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';
import { serialize } from '../../../scripts/phase2-qualification/minimum-context-compiler/compiler.mjs';
import { loadContinuityWorker } from './worker-continuity-loader.mjs';

// Information Flow M0-D slice S4 without a database: the tokenizer binding,
// Worker token measurement and the Context Policy / pack route surface.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(root, '../..');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const TOKENIZER = { package: 'js-tiktoken', version: '1.0.21', encoding: 'o200k_base', model_mapping: 'gpt-4.1-2025-04-14' };
const env = { CLUED_DB_GATEWAY_TOKEN: "test-worker-gateway",
  PROJECT_VIEWS_V2: 'true',
  ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) },
};
const bindingToken = `clued_bnd_${'i'.repeat(43)}`;
const encoder = new Tiktoken(o200kBase);

let contextPackModule;
async function loadContextPack() {
  contextPackModule ??= (async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-context-pack-'));
    const output = path.join(directory, 'context-pack.mjs');
    await build({ entryPoints: [path.join(root, 'worker/context-pack.ts')], outfile: output, bundle: true,
      platform: 'node', format: 'esm', logLevel: 'silent' });
    return await import(pathToFileURL(output).href);
  })();
  return contextPackModule;
}

// A pack-shaped result as the definer Compiler returns it.
function fakePack(overrides = {}, packOverrides = {}) {
  const pack = { schema: 'clued.context-pack.v1', items: [{ canonical_id: 'x', fields: { title: 'Hello <|endoftext|> 中文' } }],
    token_budget: 4096, tokenizer: { ...TOKENIZER, status: 'offline_target' }, authoritative: true,
    execution_authorization: 'NOT_GRANTED', model_extraction: 'NOT_EVALUATED', ...packOverrides };
  const packText = serialize(pack);
  return { status: 'ok', pack, pack_text: packText, pack_digest: sha256(packText), compile_inputs_digest: 'a'.repeat(64),
    manifest: { id: 'm', reused: false, stale: false }, measurement: { status: 'not_measured' }, authoritative: true,
    execution_authorization: 'NOT_GRANTED', model_extraction: 'NOT_EVALUATED', ...overrides };
}

function rest(pathname, { method = 'POST', token = 'account-jwt', body } = {}) {
  return new Request(`https://clued.test${pathname}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function withStorage(handler, run) {
  const previousFetch = globalThis.fetch;
  const previousWarn = console.warn;
  const calls = [];
  const warnings = [];
  console.warn = (line) => { warnings.push(String(line)); };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: '44444444-4444-4444-8444-444444444444' });
    const rpc = /\/rpc\/([^/?]+)$/.exec(url)?.[1];
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ rpc, body });
    return Response.json(handler(rpc, body));
  };
  try {
    return await run(calls, warnings);
  } finally {
    globalThis.fetch = previousFetch;
    console.warn = previousWarn;
  }
}

test('the installed tokenizer matches TokenizerBinding.json and the pinned ranks digest', async () => {
  const binding = JSON.parse(await fs.readFile(path.join(repoRoot,
    'scripts/phase2-qualification/minimum-context-compiler/TokenizerBinding.json'), 'utf8'));
  assert.deepEqual([binding.package, binding.version, binding.encoding, binding.actual_library_model_mapping],
    [TOKENIZER.package, TOKENIZER.version, TOKENIZER.encoding, TOKENIZER.model_mapping]);
  const nestedBase64 = path.join(root, 'node_modules/js-tiktoken/node_modules/base64-js');
  const base64Root = existsSync(nestedBase64) ? nestedBase64 : path.join(root, 'node_modules/base64-js');
  const located = {
    'node_modules/js-tiktoken/package.json': path.join(root, 'node_modules/js-tiktoken/package.json'),
    'node_modules/js-tiktoken/dist/lite.js': path.join(root, 'node_modules/js-tiktoken/dist/lite.js'),
    'node_modules/js-tiktoken/dist/chunk-VL2OQCWN.js': path.join(root, 'node_modules/js-tiktoken/dist/chunk-VL2OQCWN.js'),
    'node_modules/js-tiktoken/dist/ranks/o200k_base.js': path.join(root, 'node_modules/js-tiktoken/dist/ranks/o200k_base.js'),
    'node_modules/base64-js/index.js': path.join(base64Root, 'index.js'),
  };
  for (const [file, location] of Object.entries(located)) {
    const expected = binding.dependency_files.find((entry) => entry.path === file);
    assert.ok(expected, file);
    const bytes = await fs.readFile(location);
    assert.deepEqual([sha256(bytes), bytes.length], [expected.sha256, expected.bytes], file);
  }
  const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const locked = lock.packages['node_modules/js-tiktoken'];
  assert.deepEqual([locked.version, locked.integrity, locked.dev ?? false, locked.optional ?? false],
    ['1.0.21', binding.source_integrity, false, false], 'a pinned runtime dependency');
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['js-tiktoken'], '1.0.21', 'exact version');
  const { O200K_RANKS_SHA256, TOKENIZER_TARGET } = await loadContextPack();
  assert.equal(sha256(JSON.stringify(o200kBase)), O200K_RANKS_SHA256);
  assert.deepEqual({ ...TOKENIZER_TARGET }, TOKENIZER);
  assert.equal(getEncodingNameForModel(TOKENIZER.model_mapping), TOKENIZER.encoding);
  const migration = await fs.readFile(path.join(root,
    'supabase/migrations/20260924200000_information_flow_context_policy.sql'), 'utf8');
  assert.match(migration, /'package','js-tiktoken','version','1\.0\.21','encoding','o200k_base',\s*'model_mapping','gpt-4\.1-2025-04-14'/,
    'the SQL policy tokenizer binding matches the Worker target');
});

test('measurePack counts exact pack_text, enforces the budget and fails closed', async () => {
  const { measurePack, loadTokenizer } = await loadContextPack();
  for (const passthrough of [null, 'x', { status: 'rejected', error_code: 'CONTEXT_POLICY_REQUIRED' },
    { status: 'stale', revalidation: 'STALE' }, { status: 'ok', revalidation: 'VALID', pack_digest: 'a'.repeat(64) }]) {
    assert.deepEqual(await measurePack(passthrough), { result: passthrough });
  }
  const good = fakePack();
  const measured = await measurePack(good);
  assert.equal(measured.httpStatus, undefined);
  assert.deepEqual(measured.result.measurement, { status: 'measured',
    token_count: encoder.encode(good.pack_text, [], []).length, token_budget: 4096, tokenizer_status: 'offline_target',
    tokenizer: TOKENIZER, counted: 'pack_text', pack_digest: good.pack_digest });
  assert.equal(measured.result.pack_text, good.pack_text, 'the digested body is untouched');
  assert.equal(await loadTokenizer(), await loadTokenizer(), 'the tokenizer is a singleton');
  // Integrity: a pack_text that does not hash to pack_digest, or a pack not
  // bound to the target tokenizer, is refused.
  for (const tampered of [{ ...good, pack_text: `${good.pack_text} ` }, { ...good, pack_digest: 'f'.repeat(64) },
    fakePack({}, { tokenizer: { ...TOKENIZER, status: 'accepted' } }),
    fakePack({}, { tokenizer: { ...TOKENIZER, encoding: 'cl100k_base', status: 'offline_target' } }),
    fakePack({}, { token_budget: 0 }), fakePack({}, { token_budget: '10' })]) {
    const refused = await measurePack(tampered);
    assert.deepEqual([refused.httpStatus, refused.result.error_code, refused.result.authoritative],
      [502, 'CONTEXT_PACK_INTEGRITY', false]);
    assert.ok(!('pack_text' in refused.result));
  }
  const tight = fakePack({}, { token_budget: 3 });
  const exceeded = await measurePack(tight);
  assert.equal(exceeded.httpStatus, 422);
  assert.deepEqual(exceeded.result, { status: 'rejected', error_code: 'CONTEXT_INSUFFICIENT',
    reason: 'token_budget_exceeded', token_count: encoder.encode(tight.pack_text, [], []).length, token_budget: 3,
    pack_digest: tight.pack_digest, authoritative: false, execution_authorization: 'NOT_GRANTED',
    model_extraction: 'NOT_EVALUATED' });
  const previousError = console.error;
  console.error = () => {};
  try {
    const unavailable = await measurePack(good, async () => { throw new Error('ranks missing'); });
    assert.deepEqual([unavailable.httpStatus, unavailable.result.error_code], [503, 'TOKENIZER_UNAVAILABLE']);
    const broken = await measurePack(good, async () => ({ count: () => Number.NaN }));
    assert.deepEqual([broken.httpStatus, broken.result.error_code], [503, 'TOKENIZER_UNAVAILABLE']);
  } finally {
    console.error = previousError;
  }
});

test('Context Policy routes are Native-only, bind one RPC each and map results to HTTP status', async () => {
  const worker = await loadContinuityWorker();
  await withStorage((rpc) => rpc === 'clued_context_policy_confirmation_issue_v1'
    ? { status: 'issued', confirmation_token: 'clued_cpt_x', view_digest: 'a'.repeat(64) }
    : { status: 'committed', supplemental: { outcome: 'accepted' } }, async (calls, warnings) => {
    for (const [pathname, route] of [['/v1/context/policies/confirmation', 'policy_confirmation'],
      ['/v1/context/policies', 'policy_accept']]) {
      for (const token of [bindingToken, null]) {
        const response = await worker.fetch(rest(pathname, { token, body: { idempotency_key: 'bnd-policy-0001' } }), env, {});
        assert.equal(response.status, 401, pathname);
        const entry = JSON.parse(warnings.at(-1));
        assert.deepEqual(entry, { event: 'information_flow_native_route_denied', route, reason: 'binding_or_missing_token' });
        assert.ok(!warnings.at(-1).includes(bindingToken));
      }
    }
    assert.equal(calls.length, 0, 'no storage call ran, not even /auth/v1/user');
    assert.equal((await worker.fetch(rest('/v1/context/policies/confirmation', { body: { policy: {},
      confirmation_token: 'x' } }), env, {})).status, 422);
    assert.equal(calls.length, 0);
    const issued = await worker.fetch(rest('/v1/context/policies/confirmation', { body: { policy: {}, rationale: 'r',
      base_policy_version: 0 } }), env, {});
    assert.equal(issued.status, 200);
    assert.deepEqual([issued.headers.get('cache-control'), issued.headers.get('pragma')], ['no-store', 'no-cache']);
    const accepted = await worker.fetch(rest('/v1/context/policies', { body: { idempotency_key: 'policy-accept-0001',
      task_class: 'x', base_policy_version: 0, confirmation_token: 'clued_cpt_x', view_digest: 'a'.repeat(64) } }), env, {});
    assert.equal(accepted.status, 200);
    assert.deepEqual(calls.map(({ rpc }) => rpc), ['clued_context_policy_confirmation_issue_v1',
      'clued_context_policy_accept_v1']);
    assert.deepEqual(Object.keys(calls[0].body), ['p_input'], 'issuing carries no payload hash');
    assert.match(calls[1].body.p_received_payload_hash, /^[0-9a-f]{64}$/);
    for (const pathname of ['/v1/context/policies', '/v1/context/policies/confirmation']) {
      const wrong = await worker.fetch(rest(pathname, { method: 'GET' }), env, {});
      assert.deepEqual([wrong.status, wrong.headers.get('allow')], [405, 'POST, OPTIONS'], pathname);
    }
    assert.equal((await worker.fetch(rest('/v1/context/policies/other', { body: {} }), env, {})).status, 404);
    assert.equal((await worker.fetch(rest('/v1/context/policies', { body: {} }), { ...env, PROJECT_VIEWS_V2: 'false' }, {}))
      .status, 404);
  });
  const cases = [
    [{ status: 'rejected', error_code: 'reauthentication_required', authoritative: false }, 401],
    [{ status: 'rejected', error_code: 'confirmation_token_reused' }, 403],
    [{ status: 'rejected', error_code: 'confirmation_token_binding_mismatch' }, 403],
    [{ status: 'rejected', error_code: 'context_policy_version_conflict' }, 409],
    [{ status: 'rejected', error_code: 'confirmation_view_stale' }, 409],
    [{ status: 'rejected', error_code: 'IDEMPOTENCY_KEY_CONFLICT' }, 409],
    [{ status: 'rejected', error_code: 'context_policy_unknown_field' }, 422],
    [{ status: 'failed', error_code: 'policy_decision_failed:x' }, 500],
    [{ status: 'committed', supplemental: { outcome: 'accepted' } }, 200],
  ];
  for (const [result, status] of cases) {
    await withStorage(() => result, async () => {
      for (const pathname of ['/v1/context/policies/confirmation', '/v1/context/policies']) {
        const response = await worker.fetch(rest(pathname, { body: { idempotency_key: 'policy-status-0001' } }), env, {});
        assert.equal(response.status, status, `${pathname} ${JSON.stringify(result)}`);
        assert.equal(Boolean(response.headers.get('www-authenticate')), result.error_code === 'reauthentication_required');
      }
    });
  }
});

test('the pack route and MCP tool measure compiled packs; revalidation outcomes map to HTTP status', async () => {
  const worker = await loadContinuityWorker();
  const good = fakePack();
  const cases = [
    [{ status: 'rejected', error_code: 'CONTEXT_POLICY_REQUIRED', authoritative: false,
      execution_authorization: 'NOT_GRANTED', model_extraction: 'NOT_EVALUATED' }, 422],
    [{ status: 'rejected', error_code: 'CONTEXT_INSUFFICIENT', reason: 'no_eligible_sources' }, 422],
    [{ status: 'rejected', error_code: 'CONTEXT_POLICY_SCOPE_MISMATCH' }, 422],
    [{ status: 'stale', revalidation: 'STALE', reason: 'inputs_changed' }, 409],
    [{ status: 'stale', revalidation: 'PROJECTION_REQUIRED', reason: 'projection_required' }, 409],
    [{ status: 'ok', revalidation: 'VALID', manifest_id: 'm', pack_digest: 'a'.repeat(64) }, 200],
    [good, 200],
    [{ ...good, pack_digest: 'f'.repeat(64) }, 502],
    [fakePack({}, { token_budget: 2 }), 422],
  ];
  for (const [result, status] of cases) {
    await withStorage(() => result, async (calls) => {
      const response = await worker.fetch(rest('/v1/context/pack', { body: { scope: 'global', task_class: 'x' } }), env, {});
      assert.equal(response.status, status, JSON.stringify(result));
      const body = await response.json();
      if (result === good) {
        assert.equal(body.measurement.status, 'measured');
        assert.equal(body.measurement.token_count, encoder.encode(good.pack_text, [], []).length);
      }
      assert.deepEqual(calls.map(({ rpc }) => rpc), ['clued_user_context_pack']);
    });
  }
  // Revalidation input reaches the account entry unchanged.
  await withStorage(() => cases[5][0], async (calls) => {
    await worker.fetch(rest('/v1/context/pack', { body: { manifest_id: '33333333-3333-4333-8333-333333333333' } }), env, {});
    assert.deepEqual(calls[0].body, { p_input: { manifest_id: '33333333-3333-4333-8333-333333333333' } });
  });
  // MCP (Binding and delegated OAuth): measured before sanitizing.
  for (const token of [bindingToken, 'oauth-access-token']) {
    await withStorage(() => good, async (calls) => {
      const envelope = await (await worker.fetch(new Request('https://clued.test/mcp', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'clued_context_pack', arguments: { scope: 'global', task_class: 'x' } } }),
      }), env, {})).json();
      const structured = envelope.result.structuredContent;
      assert.equal(structured.measurement.status, 'measured', token);
      assert.equal(envelope.result.isError, false);
      assert.equal(structured.pack_text, good.pack_text);
      assert.equal(calls.length, 1);
    });
    await withStorage(() => fakePack({}, { token_budget: 1 }), async () => {
      const envelope = await (await worker.fetch(new Request('https://clued.test/mcp', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'clued_context_pack', arguments: { scope: 'global' } } }),
      }), env, {})).json();
      assert.deepEqual([envelope.result.structuredContent.error_code, envelope.result.structuredContent.reason,
        envelope.result.isError], ['CONTEXT_INSUFFICIENT', 'token_budget_exceeded', true]);
    });
    await withStorage(() => ({ ...good, pack_digest: 'f'.repeat(64) }), async () => {
      const envelope = await (await worker.fetch(new Request('https://clued.test/mcp', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'clued_context_pack', arguments: { scope: 'global' } } }),
      }), env, {})).json();
      assert.deepEqual([envelope.result.structuredContent.error_code, envelope.result.isError],
        ['CONTEXT_PACK_INTEGRITY', true]);
    });
  }
});

test('policy acceptance schedules the post-commit projection refresh; compiles do not', async () => {
  const worker = await loadContinuityWorker();
  const refreshEnv = { ...env, CLUED_PROJECTION_BUILDER_TOKEN: `clued_bnd_${'p'.repeat(43)}` };
  await withStorage((rpc) => rpc?.startsWith('clued_mcp_projection_refresh') ? { status: 'idle' }
    : rpc === 'clued_user_context_pack' ? fakePack() : { status: 'committed', supplemental: { outcome: 'accepted' } },
  async () => {
    const scheduled = [];
    const ctx = { waitUntil(promise) { scheduled.push(promise); }, passThroughOnException() {} };
    const response = await worker.fetch(rest('/v1/context/policies', { body: { idempotency_key: 'refresh-policy-01' } }),
      refreshEnv, ctx);
    assert.equal(response.status, 200);
    assert.equal(scheduled.length, 1);
    assert.equal((await worker.fetch(rest('/v1/context/pack', { body: { scope: 'global' } }), refreshEnv, ctx)).status, 200);
    assert.equal(scheduled.length, 1, 'a compile is not a Canonical write');
    await Promise.allSettled(scheduled);
  });
});
