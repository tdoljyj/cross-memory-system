import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readWranglerConfig } from '../../clued-cloud/scripts/projection-postflight.mjs';
import worker from '../worker.mjs';

// Every storage operation uses this in-memory map. Every external request is intercepted.
// These fixtures establish source behavior only, never a live account or production READY.
const publicOrigin = 'https://kooyomi.com';
const canonical = 'https://kooyumi.pixelgrav.com';
const legacy = 'https://clued.pixelgrav.com';
const originalFetch = globalThis.fetch;
const contract = '# BeamingFace Agent Contract\n\nOffline fixture; no account or authority.\n';
function fixture(upstream = canonical) {
  const rows = new Map(), calls = [];
  const env = {
    KOOYUMI_UPSTREAM_ORIGIN: upstream,
    CONNECT_KV: {
      async get(key) { return rows.has(key) ? JSON.parse(rows.get(key)) : null; },
      async put(key, value) { rows.set(key, value); },
    },
    CLUED_CLOUD_SERVICE: { async fetch(request) {
      calls.push({ kind: 'service', request });
      throw new Error('unexpected_service_call');
    } },
  };
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    calls.push({ kind: 'fetch', request });
    const url = new URL(request.url);
    assert.equal(url.origin, upstream, 'unexpected external origin');
    if (url.pathname === '/clued-agent.md') return new Response(contract, { headers: { 'content-type': 'text/markdown' } });
    throw new Error('unexpected_external_request:' + url.pathname);
  };
  const run = (path, options = {}, origin = publicOrigin) => worker.fetch(new Request(origin + path, options), env);
  return { env, rows, calls, run };
}
async function create(f, origin = publicOrigin) {
  const response = await f.run('/connect/api/request', { method: 'POST' }, origin);
  assert.equal(response.status, 201);
  return await response.json();
}
const noLegacyLinks = value => assert.equal(JSON.stringify(value).includes(legacy), false);
function workersRequestShim() {
  const NativeRequest = globalThis.Request;
  globalThis.Request = class extends NativeRequest {
    constructor(input, init) { super(input, init?.body instanceof ReadableStream ? { ...init, duplex: 'half' } : init); }
  };
  return () => { globalThis.Request = NativeRequest; };
}
function unzipStored(bytes) {
  const files = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0, 'fixture supports stored ZIP entries only');
    const size = bytes.readUInt32LE(offset + 18), nameSize = bytes.readUInt16LE(offset + 26), extraSize = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString('utf8');
    const start = offset + 30 + nameSize + extraSize;
    files.set(name, bytes.subarray(start, start + size).toString('utf8'));
    offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  return files;
}

test('candidate records captured provenance and preserves the reviewed source and persistence bindings', async () => {
  const captured = JSON.parse(await readFile(new URL('../captured-source.json', import.meta.url), 'utf8'));
  assert.equal(captured.source.version_id, 'bfa41392-9890-45da-bb56-e49965edeb69');
  assert.equal(captured.source.extracted_module_sha256, 'fe2677bd4f9c34ad467aa47e121e78877487126ae97004d04bb0e1f9c2c581c3');
  const reviewed = await readFile(new URL('../worker.mjs', import.meta.url));
  assert.equal(createHash('sha256').update(reviewed).digest('hex'), captured.candidate.module_sha256);
  // Read as Wrangler reads it (JSONC), like every release-path reader (Fable 1121 §7).
  const config = await readWranglerConfig(fileURLToPath(new URL('../wrangler.production.jsonc', import.meta.url)));
  assert.equal(config.name, 'clued-connect');
  assert.equal(config.kv_namespaces[0].id, captured.bindings.find(b => b.type === 'kv_namespace').namespace_id);
  assert.deepEqual(config.services, [{ binding: 'CLUED_CLOUD_SERVICE', service: 'clued-cloud', environment: 'production' }]);
  assert.deepEqual(config.routes.map(r => r.pattern), ['kooyomi.com/connect*', 'kooyumi.pixelgrav.com/connect*', 'clued.pixelgrav.com/connect*', 'clued.pixelgrav.com/connect/*']);
});

test('new and existing entry origins render BeamingFace and generate only public installation links', async () => {
  const f = fixture();
  try {
    for (const origin of [publicOrigin, canonical, legacy]) {
      const page = await f.run('/connect', {}, origin);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /BeamingFace Connect/);
      assert.match(html, /连接 BeamingFace/);
      assert.equal(html.includes('Clued Connect'), false);
      const request = await create(f, origin);
      assert.equal(new URL(request.install_url).origin, publicOrigin);
      assert.match(request.copy_text, /BeamingFace/);
      noLegacyLinks(request);
      assert.equal(f.rows.size > 0, true);
    }
    assert.equal(f.calls.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('manifest and installation contract migrate public links while retaining protocol keys and host boundaries', async () => {
  const f = fixture();
  try {
    const request = await create(f, legacy), { request_id: id, challenge } = request;
    for (const host of ['ChatGPT', 'Claude', 'Codex', 'Cursor', 'WorkBuddy']) {
      const response = await f.run(`/connect/api/manifest/${id}?challenge=${challenge}&host=${host}`, {}, legacy);
      assert.equal(response.status, 200);
      const manifest = await response.json();
      assert.deepEqual(manifest.issuer, { name: 'BeamingFace', origin: publicOrigin });
      assert.equal(manifest.contract.type, 'clued_installation_contract');
      assert.equal(manifest.host_profile.host, host);
      assert.equal(new URL(manifest.host_profile.mcp.url).origin, publicOrigin);
      assert.equal(new URL(manifest.host_profile.mcp.url).pathname, '/connect/mcp/kooyumi');
      assert.equal(new URL(manifest.endpoints.manifest).origin, publicOrigin);
      assert.equal(manifest.current_status.ready, false);
      if (host === 'WorkBuddy') {
        assert.equal(manifest.host_profile.mcp.temporary_headers['X-Clued-Host'], 'WorkBuddy');
        assert.equal(manifest.host_profile.mcp.temporary_headers['X-Clued-Activation'], id);
      }
      noLegacyLinks(manifest);
    }
    const response = await f.run(`/connect/install/${id}/${challenge}`, {}, legacy);
    const text = await response.text();
    assert.match(text, /# BeamingFace Installation Contract/);
    assert.match(text, /clued_session_resume/);
    assert.equal(text.includes(legacy), false);
    assert.equal(f.calls.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('request-scoped ZIP keeps technical ids and issues the canonical MCP URL without installing anything', async () => {
  const f = fixture();
  try {
    const { request_id: id, challenge } = await create(f);
    const response = await f.run(`/connect/plugin/claude/${id}/${challenge}.zip`, {}, legacy);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /BeamingFace-for-Claude.zip/);
    const files = unzipStored(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual([...files.keys()], ['.claude-plugin/plugin.json', 'skills/clued/SKILL.md', '.mcp.json', 'clued-carrier.json', 'README.md']);
    const plugin = JSON.parse(files.get('.claude-plugin/plugin.json'));
    assert.equal(plugin.name, 'clued');
    assert.equal(plugin.displayName, 'BeamingFace');
    assert.equal(plugin.version, '0.1.6');
    assert.equal(plugin.homepage, publicOrigin);
    const mcp = JSON.parse(files.get('.mcp.json'));
    assert.deepEqual(Object.keys(mcp.mcpServers), ['clued']);
    assert.equal(new URL(mcp.mcpServers.clued.url).origin, publicOrigin);
    assert.equal(new URL(mcp.mcpServers.clued.url).pathname, '/connect/mcp/kooyumi');
    assert.equal(new URL(mcp.mcpServers.clued.url).searchParams.get('request_id'), id);
    assert.ok(new URL(mcp.mcpServers.clued.url).searchParams.get('plugin_nonce'));
    const carrier = JSON.parse(files.get('clued-carrier.json'));
    assert.equal(carrier.clued_skills_source, canonical + '/clued-agent.md');
    assert.equal(carrier.clued_skills_source_sha256, createHash('sha256').update(contract).digest('hex'));
    assert.match(files.get('skills/clued/SKILL.md'), /installation_activation/);
    for (const text of files.values()) assert.equal(text.includes(legacy), false);
    assert.deepEqual(f.calls.map(x => x.request.url), [canonical + '/clued-agent.md']);
  } finally { globalThis.fetch = originalFetch; }
});

test('MCP proxy preserves authentication and upstream challenge without granting READY from metadata', async () => {
  const f = fixture();
  // Node requires duplex for streamed bodies; Workers' Request accepts this shape natively.
  const NativeRequest = globalThis.Request;
  globalThis.Request = class extends NativeRequest {
    constructor(input, init) { super(input, init?.body instanceof ReadableStream ? { ...init, duplex: 'half' } : init); }
  };
  try {
    const { request_id: id, challenge } = await create(f);
    globalThis.fetch = async request => {
      assert.equal(request.url, canonical + '/mcp');
      assert.equal(request.headers.get('Authorization'), 'Bearer offline-fixture-credential');
      assert.equal(request.headers.get('Origin'), 'https://host.example');
      assert.equal(request.headers.has('X-Clued-Host'), false);
      assert.equal(request.headers.has('X-Clued-Activation'), false);
      assert.equal((await request.json()).method, 'tools/list');
      return Response.json({ error: 'unauthorized' }, { status: 401, headers: {
        'www-authenticate': `Bearer resource_metadata="${canonical}/.well-known/oauth-protected-resource/mcp"`,
      } });
    };
    const response = await f.run(`/connect/mcp?request_id=${id}&challenge=${challenge}&host=Codex`, { method: 'POST', headers: {
      Authorization: 'Bearer offline-fixture-credential', Origin: 'https://host.example', 'Content-Type': 'application/json',
      'X-Clued-Host': 'Codex', 'X-Clued-Activation': id,
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('www-authenticate'), /kooyumi\.pixelgrav\.com/);
    const status = await (await f.run(`/connect/api/status/${id}?challenge=${challenge}`)).json();
    assert.equal(status.ready, false);
    assert.equal(status.evidence.account, false);
    assert.equal(status.evidence.mcp, false);
  } finally { globalThis.fetch = originalFetch; globalThis.Request = NativeRequest; }
});

test('explicit legacy upstream compatibility never leaks old public URLs and invalid upstream fails before forwarding', async () => {
  const f = fixture(legacy);
  try {
    const { request_id: id, challenge } = await create(f, legacy);
    const skill = await f.run(`/connect/skill/${id}/${challenge}`);
    assert.equal(skill.status, 200);
    assert.equal(f.calls[0].request.url, legacy + '/clued-agent.md');
    const manifest = await (await f.run(`/connect/api/manifest/${id}?challenge=${challenge}&host=Codex`)).json();
    noLegacyLinks(manifest);
    f.env.KOOYUMI_UPSTREAM_ORIGIN = 'https://untrusted.example';
    const before = f.calls.length;
    assert.equal((await f.run(`/connect/skill/${id}/${challenge}`)).status, 200, 'existing request retains its trusted origin');
    assert.equal(f.calls.length, before + 1);
    const rejected = await f.run('/connect/api/request', { method: 'POST' });
    assert.equal(rejected.status, 500);
    assert.match(await rejected.text(), /invalid_upstream_origin/);
    assert.equal(f.calls.length, before + 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('legacy KV sessions and new sessions retain separate MCP audiences and discovery after configuration changes', async () => {
  const f = fixture();
  try {
    const old = await create(f), current = await create(f);
    const oldState = JSON.parse(f.rows.get('req:' + old.request_id));
    delete oldState.upstream_origin; delete oldState.upstream_resource;
    oldState.expires_at = '2000-01-01T00:00:00Z';
    f.rows.set('req:' + old.request_id, JSON.stringify(oldState));
    const currentState = JSON.parse(f.rows.get('req:' + current.request_id));
    assert.equal(currentState.upstream_origin, canonical);
    assert.equal(currentState.upstream_resource, canonical + '/mcp');
    const seen = [];
    globalThis.fetch = async request => {
      const url = new URL(request.url);
      seen.push({ origin: url.origin, authorization: request.headers.get('Authorization') });
      assert.equal(url.pathname, '/mcp');
      return Response.json({ error: 'authorization_required' }, { status: 401, headers: {
        'www-authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"`,
      } });
    };
    for (const [session, expected, token] of [[old, legacy, 'old-audience-token'], [current, canonical, 'new-audience-token']]) {
      const path = `/connect/mcp?request_id=${session.request_id}&challenge=${session.challenge}`;
      const response = await f.run(path, { headers: { Authorization: 'Bearer ' + token } });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('www-authenticate'), `Bearer resource_metadata="${expected}/.well-known/oauth-protected-resource/mcp"`);
      assert.deepEqual(seen.at(-1), { origin: expected, authorization: 'Bearer ' + token });
    }
    f.env.KOOYUMI_UPSTREAM_ORIGIN = legacy;
    await f.run(`/connect/mcp?request_id=${current.request_id}&challenge=${current.challenge}`);
    assert.equal(seen.at(-1).origin, canonical, 'configuration changes cannot move an issued request audience');
    const bootstrap = await f.run('/connect/mcp');
    assert.equal(bootstrap.status, 401);
    assert.equal(seen.at(-1).origin, legacy, 'selector-free stable bootstrap uses the explicit configuration');
    const before = seen.length;
    for (const suffix of [`?request_id=${current.request_id}`, '?challenge=unknown', `?request_id=${old.request_id}&challenge=wrong`]) {
      assert.equal((await f.run('/connect/mcp' + suffix)).status, 404);
    }
    assert.equal(seen.length, before, 'bad selectors never fall back to a different audience');
  } finally { globalThis.fetch = originalFetch; }
});

test('new request audience is server controlled and unknown or inconsistent stored targets fail before any forwarding', async () => {
  const f = fixture();
  try {
    const response = await f.run('/connect/api/request?upstream_origin=https://untrusted.example', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ upstream_origin: legacy, upstream_resource: legacy + '/mcp' }) });
    assert.equal(response.status, 201);
    const session = await response.json(), key = 'req:' + session.request_id;
    const original = JSON.parse(f.rows.get(key));
    assert.equal(original.upstream_origin, canonical);
    assert.equal(original.upstream_resource, canonical + '/mcp');
    const badStates = [
      { ...original, upstream_origin: 'https://untrusted.example', upstream_resource: 'https://untrusted.example/mcp' },
      { ...original, upstream_resource: legacy + '/mcp' },
      { ...original, upstream_origin: null },
      Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'upstream_resource')),
      Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'upstream_origin')),
    ];
    for (const state of badStates) {
      f.rows.set(key, JSON.stringify(state));
      for (const path of [
        `/connect/mcp?request_id=${session.request_id}&challenge=${session.challenge}`,
        `/connect/api/smoke?request_id=${session.request_id}&challenge=${session.challenge}`,
        `/connect/skill/${session.request_id}/${session.challenge}`,
      ]) {
        const rejected = await f.run(path);
        assert.equal(rejected.status, 500);
        assert.match(await rejected.text(), /invalid_request_upstream/);
      }
      assert.equal(f.calls.length, 0);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('request-specific contract, smoke health and service-bound rebind use the same pinned upstream as MCP', async () => {
  const f = fixture();
  try {
    const old = await create(f), current = await create(f);
    const oldState = JSON.parse(f.rows.get('req:' + old.request_id));
    delete oldState.upstream_origin; delete oldState.upstream_resource;
    f.rows.set('req:' + old.request_id, JSON.stringify(oldState));
    const seen = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push(request.url);
      const url = new URL(request.url);
      if (url.pathname === '/clued-agent.md') return new Response(contract);
      if (url.pathname === '/healthz' || url.pathname === '/.well-known/clued-continuity') return Response.json({ ok: true });
      throw new Error('unexpected_path:' + url.pathname);
    };
    const activationId = '10000000-0000-4000-8000-000000000001';
    for (const [session, expected] of [[old, legacy], [current, canonical]]) {
      seen.length = 0;
      assert.equal((await f.run(`/connect/skill/${session.request_id}/${session.challenge}`)).status, 200);
      const smoke = await f.run(`/connect/api/smoke?request_id=${session.request_id}&challenge=${session.challenge}`);
      assert.equal(smoke.status, 200);
      assert.deepEqual(seen.map(url => new URL(url).origin), Array(4).fill(expected));
      const archive = await f.run(`/connect/plugin/claude/${session.request_id}/${session.challenge}.zip`);
      assert.equal(archive.status, 200);
      const files = unzipStored(Buffer.from(await archive.arrayBuffer()));
      const carrier = JSON.parse(files.get('clued-carrier.json'));
      assert.equal(carrier.clued_skills_source, expected + '/clued-agent.md', 'provenance names the actual pinned contract source');
      assert.equal(new URL(JSON.parse(files.get('.mcp.json')).mcpServers.clued.url).origin, publicOrigin, 'public installation still uses the new proxy URL');
      assert.equal(new URL(seen.at(-1)).origin, expected);
      const key = 'req:' + session.request_id, state = JSON.parse(f.rows.get(key));
      Object.assign(state, { host: 'Claude', plugin_package_downloaded_at: new Date().toISOString(),
        plugin_package_sha256: 'a'.repeat(64), plugin_nonce: 'b'.repeat(48) });
      f.rows.set(key, JSON.stringify(state));
      f.env.CLUED_CLOUD_SERVICE.fetch = async request => {
        assert.equal(new URL(request.url).origin, expected);
        assert.equal(new URL(request.url).pathname, '/.well-known/clued-connect-activation/' + activationId);
        return Response.json({ valid: true, host: 'Claude', resume_verified: true });
      };
      const rebind = await f.run(`/connect/api/rebind/${session.request_id}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge: session.challenge, plugin_nonce: state.plugin_nonce, activation_id: activationId }) });
      assert.equal(rebind.status, 200);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('unknown or expired installation requests do not receive packages or bypass existing request checks', async () => {
  const f = fixture();
  try {
    const { request_id: id, challenge } = await create(f);
    const wrong = '0'.repeat(48);
    assert.equal((await f.run(`/connect/install/${id}/${wrong}`)).status, 404);
    assert.equal((await f.run(`/connect/plugin/claude/${id}/${wrong}.zip`)).status, 404);
    const state = JSON.parse(f.rows.get('req:' + id));
    state.expires_at = '2000-01-01T00:00:00Z';
    f.rows.set('req:' + id, JSON.stringify(state));
    assert.equal((await f.run(`/connect/install/${id}/${challenge}`)).status, 404);
    assert.equal((await f.run(`/connect/plugin/claude/${id}/${challenge}.zip`)).status, 404);
    assert.equal((await f.run('/connect/unknown')).status, 404);
    assert.equal((await f.run('/connect', { method: 'POST' })).status, 405);
    assert.equal(f.calls.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

for (const expected of [canonical, legacy]) {
  test(`issued ${expected} audience survives installation KV expiry without creating READY evidence`, async () => {
    const f = fixture(), restoreRequest = workersRequestShim();
    try {
      const session = await create(f), key = 'req:' + session.request_id;
      if (expected === legacy) {
        const state = JSON.parse(f.rows.get(key));
        delete state.upstream_origin; delete state.upstream_resource;
        f.rows.set(key, JSON.stringify(state));
      }
      const manifest = await (await f.run(`/connect/api/manifest/${session.request_id}?challenge=${session.challenge}&host=ChatGPT`)).json();
      const issued = new URL(manifest.host_profile.mcp.url), typed = expected === canonical ? 'kooyumi' : 'legacy';
      assert.equal(issued.pathname, '/connect/mcp/' + typed);
      const wrong = typed === 'kooyumi' ? 'legacy' : 'kooyumi';
      assert.equal((await f.run('/connect/mcp/' + wrong + issued.search)).status, 404, 'a live request cannot switch to a typed endpoint for another audience');
      assert.equal(f.calls.length, 0);
      f.rows.delete(key); // Same loss as normal expiry; KEEP is intentionally unchanged.
      let succeed = false, calls = 0;
      globalThis.fetch = async request => {
        calls++;
        assert.equal(request.url, expected + '/mcp');
        assert.equal(request.headers.get('Authorization'), 'Bearer existing-audience-token');
        return succeed ? Response.json({ jsonrpc: '2.0', id: 1, result: { content: [], structuredContent: { status: 'ok' }, isError: false } })
          : Response.json({ error: 'authorization_required' }, { status: 401, headers: {
            'www-authenticate': `Bearer resource_metadata="${expected}/.well-known/oauth-protected-resource/mcp"`,
          } });
      };
      const options = { method: 'POST', headers: { Authorization: 'Bearer existing-audience-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'clued_session_resume', arguments: {} } }) };
      const challenge = await f.run(issued.pathname + issued.search, options);
      assert.equal(challenge.status, 401);
      assert.equal(challenge.headers.get('www-authenticate'), `Bearer resource_metadata="${expected}/.well-known/oauth-protected-resource/mcp"`);
      succeed = true;
      assert.equal((await f.run(issued.pathname + issued.search, options)).status, 200);
      if (expected === legacy) assert.equal((await f.run('/connect/mcp' + issued.search, options)).status, 200, 'historical untyped issued URLs retain the legacy issuer');
      assert.equal(f.rows.size, 0, 'successful forwarding without installation evidence cannot recreate KV state or sign READY');
      const before = calls;
      assert.equal((await f.run(`/connect/api/smoke?request_id=${session.request_id}&challenge=${session.challenge}`)).status, 404);
      for (const suffix of ['?request_id=invalid&challenge=' + 'a'.repeat(48), '?challenge=' + 'a'.repeat(48), '?request_id=' + session.request_id, '?request_id=&challenge=']) {
        assert.equal((await f.run(issued.pathname + suffix, options)).status, 404);
      }
      assert.equal(calls, before);
    } finally { globalThis.fetch = originalFetch; restoreRequest(); }
  });
}

test('tool errors, rejected business results and mismatched RPC responses cannot add authenticated READY evidence', async () => {
  const f = fixture(), restoreRequest = workersRequestShim();
  try {
    const session = await create(f), id = session.request_id, challenge = session.challenge;
    await f.run('/connect/api/activate/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge, host: 'ChatGPT' }) });
    const success = { jsonrpc: '2.0', id: 1, result: { content: [], structuredContent: { status: 'ok', records: [] }, isError: false } };
    let outcome = success, contractReads = 0;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url === canonical + '/mcp') return Response.json(outcome);
      assert.equal(request.url, canonical + '/clued-agent.md');
      contractReads++;
      return new Response(contract);
    };
    const call = () => f.run(`/connect/mcp/kooyumi?request_id=${id}&challenge=${challenge}`, { method: 'POST',
      headers: { Authorization: 'Bearer fixture-only', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'clued_session_resume', arguments: {} } }) });
    const failures = [
      { ...success, result: { ...success.result, isError: true } },
      { ...success, result: { ...success.result, structuredContent: { error: { code: 'insufficient_scope' } } } },
      { ...success, result: { ...success.result, structuredContent: { status: 'rejected' } } },
      { ...success, result: { ...success.result, isError: 'false' } },
      { ...success, id: 2 }, { ...success, error: null },
      { ...success, result: {} },
    ];
    for (const result of failures) {
      outcome = result;
      assert.equal((await call()).status, 200, 'the original upstream tool response remains available to the Host');
      const state = await (await f.run(`/connect/api/status/${id}?challenge=${challenge}`)).json();
      assert.equal(state.ready, false);
      assert.equal(state.evidence.mcp, false);
      assert.equal(state.evidence.account, false);
    }
    assert.equal(contractReads, 0);
    outcome = success;
    assert.equal((await call()).status, 200);
    const state = await (await f.run(`/connect/api/status/${id}?challenge=${challenge}`)).json();
    assert.equal(state.ready, true, 'only the fixture server successful protected response satisfies this fixture');
    assert.equal(contractReads, 1);
  } finally { globalThis.fetch = originalFetch; restoreRequest(); }
});

test('pre-rename state works on every entry domain and the public domain cannot become an OAuth audience', async () => {
  const f = fixture();
  try {
    const session = await create(f, canonical), key = 'req:' + session.request_id;
    const stored = JSON.parse(f.rows.get(key));
    stored.protocol_revision = '0.2.14';
    f.rows.set(key, JSON.stringify(stored));
    const before = f.rows.get(key);
    globalThis.fetch = async request => {
      f.calls.push({ kind: 'fetch', request });
      assert.equal(request.url, canonical + '/mcp');
      assert.equal(request.headers.get('Authorization'), 'Bearer pre-rename-audience-token');
      return Response.json({ error: 'authorization_required' }, { status: 401, headers: {
        'www-authenticate': `Bearer resource_metadata="${canonical}/.well-known/oauth-protected-resource/mcp"`,
      } });
    };
    for (const origin of [publicOrigin, canonical, legacy]) {
      const response = await f.run(`/connect/mcp/kooyumi?request_id=${session.request_id}&challenge=${session.challenge}`,
        { headers: { Authorization: 'Bearer pre-rename-audience-token' } }, origin);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('www-authenticate'),
        `Bearer resource_metadata="${canonical}/.well-known/oauth-protected-resource/mcp"`);
      assert.equal(f.rows.get(key), before, 'forwarding cannot rewrite stored provenance or READY');
    }
    f.env.KOOYUMI_UPSTREAM_ORIGIN = publicOrigin;
    const rejected = await f.run('/connect/api/request', { method: 'POST' });
    assert.equal(rejected.status, 500);
    assert.match(await rejected.text(), /invalid_upstream_origin/);
    assert.equal(f.calls.length, 3, 'an invalid audience never reaches an external service');
    const existing = await f.run(`/connect/mcp/kooyumi?request_id=${session.request_id}&challenge=${session.challenge}`,
      { headers: { Authorization: 'Bearer pre-rename-audience-token' } });
    assert.equal(existing.status, 401, 'a bad new default cannot move or disable a previously pinned audience');
  } finally { globalThis.fetch = originalFetch; }
});
