import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../../src/canonical.mjs';
import { parseUpgradeStatus } from '../../src/upgrade-mailbox.mjs';
import { Upgrader, main } from '../src/upgrader-main.mjs';
import { UPGRADE_CANCEL_CONTRACT } from '../src/request.mjs';
import { U } from '../src/codes.mjs';
import { T0, upgradeRequestBytes } from './fixtures.mjs';
import { makeEnv } from './harness.mjs';

const OP1 = '5e1f0000-0000-4000-8000-0000000000a1';
const OP2 = '5e1f0000-0000-4000-8000-0000000000a2';
const drop = (env, bytes) => fs.writeFile(path.join(env.root, 'upgrade', 'inbox', `${String(env.clock.now).padStart(13, '0')}-${sha256(bytes).slice(0, 12)}.json`), bytes);
const cancelBytes = id => Buffer.from(JSON.stringify({ contract: UPGRADE_CANCEL_CONTRACT, requestId: id, requestedAt: new Date(T0).toISOString(), nonce: 'cd'.repeat(8) }));

async function drive(up, env, until, max = 500) {
  for (let i = 0; i < max; i += 1) {
    const wait = await up.tick();
    if (await until()) return;
    env.clock.advance(Math.max(wait, 1_000));
  }
  throw new Error('condition not reached');
}

test('the service loop: inbox to operation, the grant link in status.json, a second request refused while one is active, cancel only before STAGE', async t => {
  const env = await makeEnv(t, { doorOptions: { approveAt: T0 + 30 * 60_000 } });
  const up = await new Upgrader({ root: env.root, config: env.config, clock: env.clock.fn, pid: 7, ports: env.ports }).open();
  await drop(env, upgradeRequestBytes(env.pkgs.n2, { requestId: OP1 }));
  await up.tick();
  const status = parseUpgradeStatus(await fs.readFile(path.join(env.root, 'upgrade', 'status.json')));
  assert.equal(status.op.opId, OP1);
  assert.equal(status.op.state, 'WAITING_GRANT');
  assert.match(status.op.confirmUrl, /^https:\/\/kooyumi\.pixelgrav\.com\/confirm\/[0-9a-f-]{36}$/);
  assert.equal(status.current.generation, 1);
  // Another request meanwhile: its own operation, refused at once.
  env.clock.advance(1_000);
  await drop(env, upgradeRequestBytes(env.pkgs.n2, { requestId: OP2 }));
  await up.tick();
  const t2 = JSON.parse(await fs.readFile(path.join(env.root, 'upgrade', 'ops', OP2, '900-terminal.json'), 'utf8'));
  assert.deepEqual([t2.outcome, t2.code], ['REFUSED', U.ANOTHER_OP_ACTIVE]);
  // A cancel of an unknown operation is rejected; inbox files are archived either way.
  await drop(env, cancelBytes('5e1f0000-0000-4000-8000-0000000000ff'));
  await up.tick();
  assert.deepEqual(await fs.readdir(path.join(env.root, 'upgrade', 'inbox')), []);
  assert.equal((await fs.readdir(path.join(env.root, 'upgrade', 'inbox-archive', 'rejected'))).length, 1);
  // Run until STAGE, then a cancel comes too late.
  await drive(up, env, async () => (await fs.readdir(path.join(env.root, 'upgrade', 'ops', OP1))).some(n => n.startsWith('060-stage-windows.result')));
  await drop(env, cancelBytes(OP1));
  await drive(up, env, async () => fs.access(path.join(env.root, 'upgrade', 'ops', OP1, '900-terminal.json')).then(() => true, () => false));
  const t1 = JSON.parse(await fs.readFile(path.join(env.root, 'upgrade', 'ops', OP1, '900-terminal.json'), 'utf8'));
  assert.equal(t1.outcome, 'SUCCEEDED');
  await assert.rejects(fs.access(path.join(env.root, 'upgrade', 'ops', OP1, '001-cancel.json')));
  const final = parseUpgradeStatus(await fs.readFile(path.join(env.root, 'upgrade', 'status.json')));
  assert.equal(final.current.generation, 2);
  assert.equal(final.op.state, 'SUCCEEDED', 'the pass that ends an operation shows its outcome');
  await up.tick();
  assert.equal(parseUpgradeStatus(await fs.readFile(path.join(env.root, 'upgrade', 'status.json'))).op, null);
  const raw = JSON.parse(await fs.readFile(path.join(env.root, 'upgrade', 'status.json'), 'utf8'));
  assert.deepEqual(raw.recent.map(r => r.outcome).sort(), ['REFUSED', 'SUCCEEDED']);
  assert.deepEqual(raw.generations.map(g => [g.generation, g.state]), [[1, 'kept'], [2, 'kept']]);
});

test('a cancel before STAGE ends the operation CANCELLED', async t => {
  const env = await makeEnv(t, { doorOptions: { approveAt: null } });
  const up = await new Upgrader({ root: env.root, config: env.config, clock: env.clock.fn, pid: 7, ports: env.ports }).open();
  await drop(env, upgradeRequestBytes(env.pkgs.n2, { requestId: OP1 }));
  await up.tick();
  env.clock.advance(1_000);
  await drop(env, cancelBytes(OP1));
  await drive(up, env, async () => fs.access(path.join(env.root, 'upgrade', 'ops', OP1, '900-terminal.json')).then(() => true, () => false));
  assert.equal(JSON.parse(await fs.readFile(path.join(env.root, 'upgrade', 'ops', OP1, '900-terminal.json'), 'utf8')).outcome, 'CANCELLED');
});

test('main: refuses a configuration that does not hash to --config-sha256; one pass with --once', async t => {
  const env = await makeEnv(t);
  const file = path.join(env.root, 'upgrader', 'config', 'upgrader.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(env.config));
  await fs.writeFile(file, bytes);
  await assert.rejects(main({ argv: ['--root', env.root, '--config-sha256', 'ab'.repeat(32), '--once'], ports: env.ports }), { code: 'UPGRADER_CONFIG_CHANGED' });
  assert.equal(await main({ argv: ['--root', env.root, '--config-sha256', sha256(bytes), '--once'], ports: env.ports, clock: env.clock.fn }), 0);
  await fs.access(path.join(env.root, 'upgrade', 'status.json'));
  // A second instance while the first holds the lock (its pid is alive and its liveness fresh) is refused.
  await assert.rejects(main({ argv: ['--root', env.root, '--config-sha256', sha256(bytes), '--once'], ports: env.ports, clock: env.clock.fn }), { code: 'EXECUTOR_ALREADY_RUNNING' });
});

test('the inbox is bounded: 8 files a pass, at most 48 operations a day; more requests are archived as ignored', async t => {
  const env = await makeEnv(t, { doorOptions: { approveAt: null } });
  const up = await new Upgrader({ root: env.root, config: env.config, clock: env.clock.fn, pid: 7, ports: env.ports }).open();
  for (let i = 0; i < 60; i += 1) {
    const id = `5e1f0000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
    await fs.writeFile(path.join(env.root, 'upgrade', 'inbox', `${String(env.clock.now + i).padStart(13, '0')}-${sha256(id).slice(0, 12)}.json`), upgradeRequestBytes(env.pkgs.n2, { requestId: id }));
  }
  await up.tick();
  assert.equal((await fs.readdir(path.join(env.root, 'upgrade', 'inbox'))).length, 52, 'eight a pass');
  for (let i = 0; i < 8; i += 1) { env.clock.advance(1_000); await up.tick(); }
  assert.equal((await fs.readdir(path.join(env.root, 'upgrade', 'ops'))).length, 48);
  assert.equal((await fs.readdir(path.join(env.root, 'upgrade', 'inbox-archive', 'ignored'))).length, 12);
  // A day later there is room again.
  env.clock.advance(24 * 3_600_000);
  await drop(env, upgradeRequestBytes(env.pkgs.n2, { requestId: '5e1f0000-0000-4000-8000-0000000000ee' }));
  await up.tick();
  await fs.access(path.join(env.root, 'upgrade', 'ops', '5e1f0000-0000-4000-8000-0000000000ee'));
});
