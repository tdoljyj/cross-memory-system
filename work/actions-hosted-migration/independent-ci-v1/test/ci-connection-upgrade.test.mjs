import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixtureRecord, tempDir } from './resident-v2-fixtures.mjs';
import { canonical, digest } from '../src/proof.mjs';
import { effectiveCiPrincipal } from '../src/resident-v2/ci-principal.mjs';
import { nodeIdentityOf, nodeIdentitySha256 } from '../../../independent-ci-resident-v1/src/node-identity.mjs';
import { buildTestPackage } from '../../../independent-ci-resident-v1/upgrader/test/fixtures.mjs';
import { makeEnv, openOp, runOp } from '../../../independent-ci-resident-v1/upgrader/test/harness.mjs';

test('通用升级、校验失败回滚和再次升级均保留连接记录、令牌和安装身份', async t => {
  const pin = token => digest('clued.independent-ci.ci-binding-pin/1\0' + token);
  const token = 'clued_bnd_fixture_after_rebind';
  const { files } = fixtureRecord({ ciTokenPinSha256: pin('clued_bnd_fixture_from_install') });
  const config = JSON.parse(files['installation.json']), accepted = JSON.parse(files['acceptance.json']);
  const identity = nodeIdentitySha256(nodeIdentityOf(config, accepted, digest(files['acceptance.json'])));
  const dir = await tempDir(t);
  const pkgs = {};
  for (const tag of ['n1', 'n2', 'n3']) {
    pkgs[tag] = await buildTestPackage(path.join(dir, tag), { tag, nodeIdentitySha256: identity,
      mutate(manifest, bytes, put) {
        for (const name of ['installation.json', 'acceptance.json']) {
          const file = 'record/' + name;
          put(file, files[name]);
          manifest.files.find(row => row.path === file).sha256 = digest(files[name]);
        }
      } });
  }
  let fail = false;
  // 控制令牌位于与 resident 平级的 secrets。
  const ciRoot = await tempDir(t);
  const env = await makeEnv(t, { shared: pkgs, residentRoot: path.join(ciRoot, 'resident'), installedIdentity: identity,
    windowsOptions: { failVerify: gen => fail && gen === 3 } });
  const tokenDir = path.join(ciRoot, 'secrets');
  await fs.mkdir(tokenDir);

  const connection = canonical({ contract: 'clued.independent-ci.ci-connection/1', baseNodeIdentitySha256: identity,
    bindingId: '97422e7a-250d-46a1-8205-efe28713d117', tokenPinSha256: pin(token), bindingGeneration: 2,
    rebindReceiptId: '07c17825-c99c-45c8-a6d0-24f8d62708dc', previousSha256: null, activatedAt: '2026-11-18T01:02:03.000Z' });
  const connectionFile = path.join(tokenDir, 'ci-admission.connection.json'), tokenFile = path.join(tokenDir, 'ci-admission.token');
  await fs.writeFile(connectionFile, connection);
  await fs.writeFile(tokenFile, token);
  async function verify() {
    const read = file => fs.readFile(path.join(env.root, 'record', file), 'utf8');
    const acceptedText = await read('acceptance.json');
    const r = { config: JSON.parse(await read('installation.json')), accepted: JSON.parse(acceptedText),
      hashes: { acceptanceSha256: digest(acceptedText) } };
    assert.equal(nodeIdentitySha256(nodeIdentityOf(r.config, r.accepted, r.hashes.acceptanceSha256)), identity);
    const currentBytes = await fs.readFile(connectionFile);
    assert.deepEqual(currentBytes, Buffer.from(connection));
    assert.deepEqual(await fs.readFile(tokenFile), Buffer.from(token));
    assert.equal(effectiveCiPrincipal(r, currentBytes).tokenPinSha256, pin(token));
    const receipt = JSON.parse(await fs.readFile(path.join(env.root, 'install', 'install-receipt.json')));
    assert.equal(receipt.nodeIdentitySha256, identity);
    if (process.platform === 'win32') {
      const script = fileURLToPath(new URL('../../../independent-ci-resident-v1/test/ci-connection-parser.ps1', import.meta.url));
      const check = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], {
        input: JSON.stringify({ record: { installation: r.config, accepted: r.accepted, acceptancePin: r.hashes.acceptanceSha256 }, tokenFile }),
        encoding: 'utf8', windowsHide: true,
      });
      assert.equal(check.status, 0, check.stderr);
      const expected = JSON.parse(connection);
      assert.deepEqual(JSON.parse(check.stdout), { ok: true, detail: {
        bindingId: expected.bindingId, generation: expected.bindingGeneration, rebindReceiptId: expected.rebindReceiptId,
      } });
    }
  }
  for (const [tag, failVerify, outcome] of [['n2', false, 'SUCCEEDED'], ['n3', true, 'ROLLED_BACK_PAUSED'], ['n3', false, 'SUCCEEDED']]) {
    fail = failVerify;
    env.resident.paused = null;
    const opts = tag === 'n3' && !fail ? { opId: '5520dc7d-5503-4830-9e63-0fc4ffb1a9f4' } : {};
    const op = await openOp(env, tag, opts);
    assert.equal((await runOp(env, op)).terminal.outcome, outcome);
    await verify();
  }
});
