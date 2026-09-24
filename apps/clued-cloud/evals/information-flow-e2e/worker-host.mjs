// Child-process Worker host for the S6 harness (plan section 2.4). Runs the
// dry-run bundle of the continuity handler in Miniflare (workerd) with an
// outboundService ledger. Spawned detached, so it leads its own process
// group; workerd inherits that group and SIGKILL of the group kills both.
// Talks to the orchestrator only over the Node IPC channel; configuration
// (including the local publishable key) arrives over IPC, never in a file.

import fs from 'node:fs';
import path from 'node:path';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { createGatewayLedger } from './gateway-ledger.mjs';

if (!process.send) throw new Error('worker-host must be spawned with an IPC channel');
const send = (message) => { try { process.send(message); } catch { /* parent gone */ } };

class RingLog extends Log {
  constructor() { super(LogLevel.WARN); }
  log(message) { send({ type: 'log', message: String(message).slice(0, 2000) }); }
}

let mf = null;
let ledger = null;

async function start(config) {
  const bundle = path.join(config.bundleDir, 'worker.js');
  if (!fs.existsSync(bundle)) throw new Error(`missing bundle ${bundle}`);
  fs.mkdirSync(config.persistDir, { recursive: true });
  if (fs.readdirSync(config.persistDir).length !== 0) throw new Error('persist directory must start empty');
  ledger = createGatewayLedger({ gatewayOrigin: config.gatewayOrigin, report: send });
  const started = performance.now();
  mf = new Miniflare({
    host: '127.0.0.1',
    port: 0,
    log: new RingLog(),
    handleStructuredLogs(entry) {
      send({ type: 'log', level: entry.level, message: String(entry.message ?? '').slice(0, 2000) });
    },
    telemetry: { enabled: false },
    // No request.cf download from workers.cloudflare.com: use the built-in placeholder.
    cf: false,
    resourcePersistencePath: config.persistDir,
    unsafeDevRegistryPath: path.join(config.persistDir, 'registry'),
    workers: [{
      config: {
        name: 'clued-information-flow-e2e',
        type: 'worker',
        compatibilityDate: config.compatibilityDate,
        compatibilityFlags: config.compatibilityFlags,
        manifest: {
          mainModule: 'worker.js',
          modules: { 'worker.js': { type: 'esm', contents: fs.readFileSync(bundle, 'utf8') } },
        },
        env: Object.fromEntries(Object.entries({
          SUPABASE_URL: config.gatewayOrigin,
          SUPABASE_PUBLISHABLE_KEY: config.publishableKey,
          PROJECT_VIEWS_V2: 'true',
          P5_TENANT_WRITES: 'false',
          CLUED_ALLOWED_ORIGINS: config.allowedOrigins,
        }).map(([name, value]) => [name, { type: 'text', value }])),
      },
      dev: { outboundService: { type: 'fetcher', handler: ledger.handler } },
    }],
  });
  const url = await mf.ready;
  send({ type: 'ready', url: url.href, pid: process.pid, pgid: process.pid,
    startup_ms: Math.round(performance.now() - started),
    binding_names: Object.keys(await mf.getBindings('clued-information-flow-e2e')).sort() });
}

process.on('message', async (message) => {
  try {
    if (message.type === 'start') await start(message.config);
    else if (message.type === 'arm') { ledger.arm(message.hook); send({ type: 'armed', id: message.id }); }
    else if (message.type === 'disarm') { ledger.disarm(); send({ type: 'disarmed', id: message.id }); }
    else if (message.type === 'sync') send({ type: 'synced', id: message.id });
    else if (message.type === 'stop') {
      await mf?.dispose();
      send({ type: 'stopped', id: message.id });
      process.exit(0);
    }
  } catch (error) {
    send({ type: 'error', message: String(error?.stack ?? error).slice(0, 4000) });
  }
});
process.on('SIGTERM', async () => { await mf?.dispose().catch(() => {}); process.exit(0); });
send({ type: 'spawned', pid: process.pid });
