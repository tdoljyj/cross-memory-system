import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDeliveryKit } from '../../../../scripts/ci/clued-fleet-accept.mjs';
import { firstInstallKitOf } from '../fleet/install.mjs';
import { fleetFacts, nodeSite, sha } from '../fleet/test/fleet-fixtures.mjs';

test('交付门按摘要和仓库核对首装 kit，独立验证 CI 登记范围', async t => {
  const now = Date.parse('2026-11-27T04:00:00Z');
  const { root } = await nodeSite(t, 'a', fleetFacts(), { now });
  const kit = await firstInstallKitOf({ root, now });
  const candidate = { repository: kit.record.repository, scope: 'global' };
  assert.match(kit.record.scope, /^project:/);

  const verify = (scope, overrides = {}) => {
    const bytes = Buffer.from(JSON.stringify({ ...kit, record: { ...kit.record, scope } }));
    checkDeliveryKit(bytes, { ...candidate, kitSha256: sha(bytes), ...overrides });
  };
  assert.doesNotThrow(() => verify(kit.record.scope));
  assert.doesNotThrow(() => verify('global'));
  for (const scope of ['', 'project:*', 'project:invalid', `${kit.record.scope}\n`]) {
    assert.throws(() => verify(scope), /^Error: FLEET_DELIVERY_KIT_REFUSED$/);
  }
  assert.throws(() => verify(kit.record.scope, { repository: 'another/repo' }), /^Error: FLEET_DELIVERY_KIT_REFUSED$/);
  assert.throws(() => verify(kit.record.scope, { kitSha256: '0'.repeat(64) }), /^Error: FLEET_DELIVERY_KIT_REFUSED$/);
});
