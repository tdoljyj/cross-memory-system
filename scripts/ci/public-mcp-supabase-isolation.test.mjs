import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { isolateConfig, prepare, reservePorts, verify } from './public-mcp-supabase-isolation.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const script = fileURLToPath(new URL('./public-mcp-supabase-isolation.mjs', import.meta.url));
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-public-mcp-ports-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'supabase'));
  await fs.mkdir(path.join(root, 'evals/public-mcp'), { recursive: true });
  for (const file of ['supabase/config.toml', 'evals/public-mcp/wrangler.jsonc']) {
    await fs.copyFile(path.join(repo, 'apps/clued-cloud', file), path.join(root, file));
  }
  const env = { ...process.env, GITHUB_RUN_ID: '38213425486', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'trusted-self-hosted',
    RUNNER_TEMP: root, GITHUB_ENV: path.join(root, 'github.env') };
  return { root, env };
}
test('actual port reservations remain distinct and unavailable until released', async () => {
  const reserved = await reservePorts();
  try {
    assert.equal(new Set(reserved.ports).size, 7);
    for (const port of reserved.ports) {
      const other = net.createServer();
      const error = await new Promise(resolve => { other.once('error', resolve); other.listen(port, '0.0.0.0', () => resolve(null)); });
      if (other.listening) await new Promise(resolve => other.close(resolve));
      assert.equal(error?.code, 'EADDRINUSE');
    }
  } finally { await reserved.close(); }
});
test('actual CLI creates matching fixture DB and Worker origins and verifies owned cleanup', async t => {
  const { root, env } = await fixture(t);
  const run = spawnSync(process.execPath, [script, 'prepare'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.project, 'clued-public-mcp-38213425486-2-trusted-self-hosted');
  const config = await fs.readFile(path.join(root, 'supabase/config.toml'), 'utf8');
  assert.ok(config.includes(`project_id = "${result.project}"`));
  assert.equal((config.match(/^\s*(?:port|shadow_port)\s*=\s*5432[0-9]$/gm) ?? []).length, 0);
  const worker = JSON.parse(await fs.readFile(path.join(root, 'evals/public-mcp/wrangler.jsonc'), 'utf8'));
  assert.equal(worker.vars.SUPABASE_URL, `http://127.0.0.1:${result.ports[1]}`);
  assert.equal(await fs.readFile(env.GITHUB_ENV, 'utf8'), `SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:${result.ports[2]}/postgres\n`);
  const check = spawnSync(process.execPath, [script, 'verify'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const replay = spawnSync(process.execPath, [script, 'prepare'], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(replay.status, 0);
  assert.equal(await fs.readFile(path.join(root, 'supabase/config.toml'), 'utf8'), config);
});
test('cleanup refuses another run, another attempt or a changed project/config/Worker', async t => {
  const { root, env } = await fixture(t);
  await prepare(root, env);
  await assert.rejects(verify(root, { ...env, GITHUB_RUN_ID: '38213425487' }), /ownership mismatch/);
  await assert.rejects(verify(root, { ...env, GITHUB_RUN_ATTEMPT: '3' }), /ownership mismatch/);
  const configPath = path.join(root, 'supabase/config.toml');
  const config = await fs.readFile(configPath, 'utf8');
  await fs.writeFile(configPath, config.replace(/^project_id = .*$/m, 'project_id = "clued-cloud"'));
  await assert.rejects(verify(root, env), /ownership mismatch/);
  await fs.writeFile(configPath, config);
  await fs.appendFile(path.join(root, 'evals/public-mcp/wrangler.jsonc'), '\n');
  await assert.rejects(verify(root, env), /ownership mismatch/);
});
test('changed port layout or missing CI identity cannot rewrite the default project', async t => {
  const { root, env } = await fixture(t);
  const configPath = path.join(root, 'supabase/config.toml');
  const source = await fs.readFile(configPath, 'utf8');
  assert.throws(() => isolateConfig(source.replace('port = 54324', 'port = 54325'), 'test', [45000,45001,45002,45003,45004,45005,45006]), /unexpected Supabase port/);
  await assert.rejects(prepare(root, { ...env, GITHUB_RUN_ID: undefined }), /identity invalid/);
  assert.equal(await fs.readFile(configPath, 'utf8'), source);
  await assert.rejects(verify(root, env), /ENOENT/);
});
