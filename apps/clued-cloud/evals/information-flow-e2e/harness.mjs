// Harness core: Worker host lifecycle, the four transport channels, the
// read-only observer and fixture channels, and per-scenario step/assertion
// recording (plan sections 2 and 3). Every step carries its channel:
// worker_rest, worker_mcp, postgrest_direct, gotrue, db_fixture_setup,
// db_observer_readonly or process_control.

import { fork } from 'node:child_process';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { label, redact, sha256, targetTemplate } from './evidence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export class WorkerHost {
  constructor({ bundleDir, persistDir, gatewayOrigin, publishableKey, guardLedger, env }) {
    this.config = { bundleDir, persistDir, gatewayOrigin, publishableKey, compatibilityDate: '2026-08-23',
      compatibilityFlags: ['nodejs_compat'], allowedOrigins: '' };
    this.guardLedger = guardLedger;
    this.env = env;
    this.egress = [];
    this.logs = [];
    this.hookHits = [];
    this.pending = new Map();
    this.seq = 0;
  }

  async start() {
    this.child = fork(path.join(here, 'worker-host.mjs'), [], {
      detached: true, cwd: path.resolve(here, '../..'),
      execArgv: ['--require', path.join(here, 'isolation-guard.cjs')],
      env: { ...this.env, IFE2E_GUARD_LEDGER: this.guardLedger },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    this.exited = new Promise((resolve) => this.child.on('exit', (code, signal) => resolve({ code, signal })));
    const ready = new Promise((resolve, reject) => {
      this.child.on('message', (message) => {
        if (message.type === 'egress') this.egress.push({ ...message, at: Date.now() });
        else if (message.type === 'log') this.logs.push(message.message);
        else if (message.type === 'hook_hit') { this.hookHits.push(message); this.onHook?.(message); }
        else if (message.type === 'ready') resolve(message);
        else if (message.type === 'error') reject(new Error(message.message));
        else if (message.id !== undefined && this.pending.has(message.id)) {
          this.pending.get(message.id)(message);
          this.pending.delete(message.id);
        }
      });
      this.exited.then(({ code, signal }) => reject(new Error(`worker host exited early ${code} ${signal}`)));
    });
    this.child.send({ type: 'start', config: this.config });
    this.ready = await ready;
    this.url = this.ready.url.replace(/\/$/, '');
    return this.ready;
  }

  request(type, extra = {}) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.send({ type, id, ...extra });
    });
  }

  sync() { return this.request('sync'); }
  arm(hook) { return this.request('arm', { hook }); }

  async stop() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => { try { process.kill(-this.child.pid, 'SIGKILL'); } catch { /* gone */ } }, 10000);
    await this.exited;
    clearTimeout(timer);
    try { process.kill(-this.child.pid, 'SIGKILL'); } catch { /* group already gone */ }
  }

  killGroup(signal = 'SIGKILL') {
    process.kill(-this.child.pid, signal);
    return this.exited;
  }
}

const MCP_PROTOCOL = '2025-06-18';

export class Recorder {
  constructor(harness, scenarioId) {
    this.h = harness;
    this.scenarioId = scenarioId;
    this.steps = [];
    this.assertions = [];
    this.notes = [];
    this.aliases = {};
  }

  // Symbolic names keep evidence reproducible across runs (random ids).
  alias(name, id) {
    if (id) this.aliases[name] = id;
    return id;
  }

  named(value) {
    const byId = new Map(Object.entries(this.aliases).map(([name, id]) => [String(id).toLowerCase(), name]));
    const walk = (v) => {
      if (typeof v === 'string') {
        return v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
          (match) => (byId.has(match.toLowerCase()) ? `<${byId.get(match.toLowerCase())}>` : match));
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, c]) => [k, walk(c)]));
      return v;
    };
    return walk(value);
  }

  // Set comparison over aliased ids.
  checkSet(id, text, expected, observed) {
    const sorted = (list) => (list ?? []).map((v) => this.named(v)).sort();
    return this.check(id, text, sorted(expected), Array.isArray(observed) ? sorted(observed) : observed);
  }

  addStep(step) {
    const n = this.steps.length + 1;
    this.steps.push({ n, ...step });
    return n;
  }

  async viaWorker(channel, method, pathname, init) {
    const host = this.h.worker;
    const before = host.egress.length;
    const logsBefore = host.logs.length;
    const started = performance.now();
    let status = 0;
    let body = null;
    let text = '';
    let networkError = null;
    let headers = {};
    try {
      const response = await fetch(`${host.url}${pathname}`, init);
      status = response.status;
      headers = { cache_control: response.headers.get('cache-control'),
        www_authenticate: response.headers.get('www-authenticate') };
      text = await response.text();
      try { body = text ? JSON.parse(text) : null; } catch { body = { non_json: true }; }
    } catch (error) {
      networkError = error.cause?.code ?? error.code ?? error.name;
    }
    const duration = Math.round(performance.now() - started);
    // Structured Worker logs reach the host asynchronously; give refusals a
    // moment so their log line is attributed to this step.
    if (status === 401 || status === 403) await new Promise((resolve) => setTimeout(resolve, 250));
    if (!networkError) await host.sync();
    const ledger = host.egress.slice(before).map((row) => ({ path_class: row.path_class, status: row.status,
      allowed: row.allowed }));
    const logs = host.logs.slice(logsBefore);
    return { status, body, text, duration, ledger, networkError, headers, logs };
  }

  record(channel, method, target, requestBody, result, extract) {
    let extracted = null;
    try { extracted = extract ? redact(extract(result.body, result)) : null; } catch (error) {
      extracted = { extract_error: String(error.message) };
    }
    return this.addStep({ channel, method, target: targetTemplate(target),
      request_sha256: requestBody === undefined ? null : sha256(JSON.stringify(redact(requestBody))),
      http_status: result.networkError ? `network_error:${result.networkError}` : result.status,
      response_sha256: result.text ? sha256(result.text) : null,
      extracted, ledger: result.ledger ?? [], duration_ms: result.duration });
  }

  // Worker REST with an account session (or an explicit bearer).
  async rest(principal, method, pathname, body, { extract, bearer, session } = {}) {
    const token = bearer !== undefined ? bearer : (session ?? await principal.current()).accessToken;
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const result = await this.viaWorker('worker_rest', method, pathname, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const n = this.record('worker_rest', method, pathname, body, result, extract);
    return { ...result, n };
  }

  async mcp(binding, rpcMethod, params, { extract, raw } = {}) {
    const token = raw ?? binding.raw;
    const envelope = { jsonrpc: '2.0', id: this.steps.length + 1, method: rpcMethod, params };
    const result = await this.viaWorker('worker_mcp', 'POST', '/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`, 'mcp-protocol-version': MCP_PROTOCOL },
      body: JSON.stringify(envelope) });
    const structured = result.body?.result?.structuredContent ?? result.body?.error ?? result.body;
    const target = rpcMethod === 'tools/call' ? `/mcp tools/call ${params.name}` : `/mcp ${rpcMethod}`;
    const n = this.record('worker_mcp', 'POST', target, envelope, { ...result, body: structured }, extract);
    return { ...result, structured, n };
  }

  tool(binding, name, args, options = {}) {
    return this.mcp(binding, 'tools/call', { name, arguments: args }, options);
  }

  // Direct PostgREST through the gateway: 'owner_jwt' (Authorization: Bearer
  // <GoTrue JWT>) or 'anon_apikey' (apikey only, the Binding-callable role).
  async postgrest(auth, rpc, body, { extract, session, principal } = {}) {
    const headers = { 'content-type': 'application/json', apikey: this.h.stack.publishableKey };
    if (auth === 'owner_jwt') {
      const s = session ?? await (principal ?? this.h.U).current();
      headers.authorization = `Bearer ${s.accessToken}`;
    }
    const started = performance.now();
    const response = await fetch(`${this.h.stack.apiUrl}/rest/v1/rpc/${rpc}`, { method: 'POST', headers,
      body: JSON.stringify(body) });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { non_json: true }; }
    const result = { status: response.status, body: parsed, text, duration: Math.round(performance.now() - started),
      ledger: [] };
    const n = this.record('postgrest_direct', 'POST', `/rest/v1/rpc/${rpc} (${auth})`, body, result, extract);
    return { ...result, n };
  }

  async observe(what, sql, params = []) {
    const started = performance.now();
    const rows = await this.h.observer.query(sql, params);
    this.addStep({ channel: 'db_observer_readonly', method: 'SELECT', target: what, request_sha256: sha256(sql),
      http_status: null, response_sha256: sha256(JSON.stringify(rows)), extracted: null, ledger: [],
      duration_ms: Math.round(performance.now() - started) });
    return rows;
  }

  async fixture(what, fn) {
    const started = performance.now();
    const value = await fn(this.h.fixtures);
    this.addStep({ channel: 'db_fixture_setup', method: 'FIXTURE', target: what, request_sha256: null, http_status: null,
      response_sha256: null, extracted: null, ledger: [], duration_ms: Math.round(performance.now() - started) });
    return value;
  }

  processControl(what, extracted) {
    return this.addStep({ channel: 'process_control', method: 'PROCESS', target: what, request_sha256: null,
      http_status: null, response_sha256: null, extracted: redact(extracted ?? null), ledger: [], duration_ms: 0 });
  }

  // Records an assertion; never throws, so every condition is evaluated.
  check(id, text, expected, observed, compare) {
    const pass = compare ? Boolean(compare(observed, expected)) : isDeepStrictEqual(observed, expected);
    this.assertions.push({ id, text, expected: redact(this.named(expected ?? null)),
      observed: redact(this.named(observed ?? null)), pass });
    return pass;
  }

  note(text) { this.notes.push(text); }
}

export function tokenLabel(token) { return label(token); }
