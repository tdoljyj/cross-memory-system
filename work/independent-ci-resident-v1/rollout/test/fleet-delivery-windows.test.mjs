import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';
import { firstInstallCheck } from '../fleet/install.mjs';
import { acceptanceOf } from '../fleet/publish.mjs';
import { releaseAssets } from '../fleet/test/delivery-release-fixture.mjs';
import { checkWindowsBoundary } from '../fleet/test/windows-delivery-fixture.mjs';

test('Windows 使用真实舰队资产验证首装操作人和重装计划', { skip: process.platform !== 'win32' }, async t => {
  // 包内 Record CLI 也会拒绝未来的接受时刻。
  const now = Date.parse('2026-11-01T00:00:00Z');
  const w = await releaseAssets(t, now);
  const request = JSON.parse(await fs.readFile(w.prepared.request, 'utf8'));
  const acceptance = acceptanceOf(request, { decision: randomUUID(), receipt: randomUUID(), acceptedAt: new Date(now).toISOString() });
  const checked = await firstInstallCheck({ artifactPath: w.build.tar, artifactSha256: acceptance.archive_sha256, acceptance, from: w.out, now });
  assert.equal(checked.status, 'FIRST_INSTALL_INPUTS_ACCEPTED');
  assert.equal(checked.kitSha256, w.prepared.firstInstallKitSha256);
  await checkWindowsBoundary(t, w, acceptance, checked, now);
});
