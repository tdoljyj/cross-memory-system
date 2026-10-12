import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const defaults = [54320, 54321, 54322, 54323, 54324, 54327, 54329];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function identity(env) {
  const { GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: attempt, GITHUB_JOB: job } = env;
  if (!/^[1-9][0-9]{0,19}$/.test(run ?? '') || !/^[1-9][0-9]{0,5}$/.test(attempt ?? '') ||
      !/^[a-z][a-z0-9_-]{0,29}$/.test(job ?? '')) throw Error('public MCP run identity invalid');
  return `clued-public-mcp-${run}-${attempt}-${job}`;
}
export async function reservePorts() {
  const servers = [];
  try {
    for (const ignored of defaults) {
      const server = net.createServer(); servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject); server.listen(0, '0.0.0.0', resolve);
      });
    }
    return { ports: servers.map(server => server.address().port),
      close: () => Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))) };
  } catch (error) {
    await Promise.all(servers.filter(server => server.listening).map(server => new Promise(resolve => server.close(resolve))));
    throw error;
  }
}
export function isolateConfig(source, project, ports) {
  if ((source.match(/^project_id = "clued-cloud"$/gm) ?? []).length !== 1 ||
      ports.length !== defaults.length || new Set(ports).size !== defaults.length ||
      ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) throw Error('public MCP isolation input invalid');
  const found = [];
  const config = source.replace(/^project_id = "clued-cloud"$/m, `project_id = "${project}"`)
    .replace(/^(\s*(?:port|shadow_port)\s*=\s*)(5432[0-9])$/gm, (line, prefix, value) => {
      const index = defaults.indexOf(Number(value));
      if (index < 0) throw Error('unexpected Supabase port');
      found.push(Number(value)); return prefix + ports[index];
    });
  if (found.length !== defaults.length || new Set(found).size !== defaults.length) throw Error('Supabase port layout changed');
  return config;
}
export async function prepare(cloudRoot, env = process.env) {
  const project = identity(env);
  if (!env.RUNNER_TEMP || !env.GITHUB_ENV) throw Error('public MCP job files missing');
  const configPath = path.join(cloudRoot, 'supabase/config.toml');
  const workerPath = path.join(cloudRoot, 'evals/public-mcp/wrangler.jsonc');
  const markerPath = path.join(env.RUNNER_TEMP, 'public-mcp-supabase-isolation.json');
  const source = await fs.readFile(configPath, 'utf8');
  const worker = JSON.parse(await fs.readFile(workerPath, 'utf8'));
  if (worker.vars?.SUPABASE_URL !== 'http://127.0.0.1:54321') throw Error('public MCP Worker origin changed');
  const reservation = await reservePorts();
  try {
    const config = isolateConfig(source, project, reservation.ports);
    worker.vars.SUPABASE_URL = `http://127.0.0.1:${reservation.ports[defaults.indexOf(54321)]}`;
    const workerText = JSON.stringify(worker, null, 2) + '\n';
    // This marker is created only for this run; cleanup never targets the default project.
    await fs.writeFile(markerPath, JSON.stringify({ version: 1, project, configHash: hash(config), workerHash: hash(workerText) }) + '\n', { flag: 'wx' });
    await fs.writeFile(configPath, config);
    await fs.writeFile(workerPath, workerText);
    await fs.appendFile(env.GITHUB_ENV, `SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:${reservation.ports[defaults.indexOf(54322)]}/postgres\n`);
    return { project, ports: reservation.ports };
  } finally { await reservation.close(); }
}
export async function verify(cloudRoot, env = process.env) {
  const marker = JSON.parse(await fs.readFile(path.join(env.RUNNER_TEMP, 'public-mcp-supabase-isolation.json'), 'utf8'));
  const config = await fs.readFile(path.join(cloudRoot, 'supabase/config.toml'), 'utf8');
  const worker = await fs.readFile(path.join(cloudRoot, 'evals/public-mcp/wrangler.jsonc'), 'utf8');
  if (marker.version !== 1 || marker.project !== identity(env) || marker.configHash !== hash(config) || marker.workerHash !== hash(worker) ||
      !config.includes(`project_id = "${marker.project}"`)) throw Error('public MCP cleanup ownership mismatch');
  return { project: marker.project };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  if (!['prepare', 'verify'].includes(mode) || process.argv.length !== 3) throw Error('Usage: public-mcp-supabase-isolation.mjs prepare|verify');
  console.log(JSON.stringify(await (mode === 'prepare' ? prepare : verify)(process.cwd())));
}
