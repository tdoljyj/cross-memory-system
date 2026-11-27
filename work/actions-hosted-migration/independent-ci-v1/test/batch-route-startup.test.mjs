// bc982192 (C3; FABLE-c3-b1b2-20261122 §7): the two stage entries read the batch's route from their own stage directory and hand it on.
// Stage 1 (formal-work-admission-check-v2/startup.mjs): to controllerPorts (the full admission and the checks port). Stage 8
// (independent-control-checks-v2/startup.mjs): to controllerPorts and to the control publisher. A legal batch-route.json in the stage
// directory is 'push'; none is null (main's tip is the batch base). E3 feeds the ports from the stage file directly, so only this test
// breaks when an entry stops reading the file or stops passing it on.
// As ci-connection.test.mjs: the entry's host dependencies (entry runtime, journals, ledgers, the Native and GitHub ports) are replaced for
// the entry module alone; the route file is read by the real batch-route.mjs from a real directory. Nothing outside the temp directory
// is read or written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { stageBatchRouteText, STAGE_BATCH_ROUTE_FILE } from '../src/independent-control-checks-v2/batch-route.mjs';

const STOP = 'fixture_route_observed';
const entries = {
  1: { rel: '../src/formal-work-admission-check-v2/startup.mjs', publisher: 'createProductionWorkAdmissionPublisherV2' },
  8: { rel: '../src/independent-control-checks-v2/startup.mjs', publisher: 'createProductionControlPublisherV2' },
};
// The replaced modules of the entry (by file name), each over its real module (export *), the named exports from the fixture.
const replaced = stage => new Map([
  ['entry-runtime.mjs', 'export const {runEntry, controllerPrincipal, controllerPorts, publicationControllerGithub, observationLog, authorityOf} = globalThis.batchRouteEntryFixture;'],
  ['effect-journal.mjs', 'export const {EffectJournal} = globalThis.batchRouteEntryFixture;'],
  ['batch-claim-v2.mjs', 'export const {readBatchClaim, recordBatchClaim, rewriteUnpublishedBatchClaim, withBatchClaimPublication} = globalThis.batchRouteEntryFixture;'],
  ['green-ledger.mjs', 'export const {GreenLedger} = globalThis.batchRouteEntryFixture;'],
  ['train-mode.mjs', 'export const {readStageTrainModeFact, trainPortsV2} = globalThis.batchRouteEntryFixture;'],
  ['claim-assist-native.mjs', 'export const {createClaimAssistNative, stage1WithLease, stage1FrontRequeue} = globalThis.batchRouteEntryFixture;'],
  ['publisher.mjs', `export const {${entries[stage].publisher}} = globalThis.batchRouteEntryFixture;`],
]);

for (const stage of [1, 8]) test(`bc982192 stage ${stage} entry: batch-route.json in the stage directory -> the ports${stage === 8 ? ' and the publisher' : ''} get push; none -> null`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-route-startup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const seen = [];
  let dir = null;
  const fixture = {
    runEntry: opts => opts.body({ args: {}, inputs: { dir, record: { config: { repository: 'o/r' }, accepted: { validUntil: '2099-01-01T00:00:00Z' } }, jobs: [{ id: 'job' }], plan: null },
      held: { policyText: '{}' }, live() {}, sourceRoot: root }),
    async controllerPrincipal() { return { appKey: null, nativeToken: 'fixture', bindingId: 'binding' }; },
    controllerPorts(opts) {
      seen.push(['ports', opts.batchRoute]);
      if (stage === 1) throw new Error(STOP);
      return { admission: {}, fetchImpl: async () => { throw new Error('no network'); }, github: {}, scanStartRegistrySha256: null,
        native: { command() { assert.fail('protocol 1 has no protected train transport'); } } };
    },
    publicationControllerGithub: () => ({}),
    observationLog: () => () => {},
    authorityOf: () => ({}),
    EffectJournal: { async open() { return {}; } },
    async readBatchClaim() { return null; }, async recordBatchClaim() {}, async rewriteUnpublishedBatchClaim() {}, async withBatchClaimPublication() {},
    GreenLedger: { async open() { return {}; } },
    async readStageTrainModeFact() { return { trainMode: 'off', unreadable: false }; },
    async trainPortsV2({ nativeCommand }) {
      assert.equal(nativeCommand, undefined, 'protocol 1 must use the legacy train ports');
      return {};
    },
    createClaimAssistNative: () => ({}), async stage1WithLease({ result }) { return result; }, async stage1FrontRequeue({ result }) { return result; },
    [entries[stage].publisher](opts) { seen.push(['publisher', opts.batchRoute]); throw new Error(STOP); },
  };
  globalThis.batchRouteEntryFixture = fixture;
  const entry = new URL(entries[stage].rel, import.meta.url);
  entry.searchParams.set('fixture', `batch-route-${stage}`);
  const map = replaced(stage);
  const hook = registerHooks({ resolve(spec, context, next) {
    const url = next(spec, context);
    const replacement = context.parentURL === entry.href && map.get(spec.split('/').pop());
    if (!replacement) return url;
    return { url: 'data:text/javascript,' + encodeURIComponent(`export * from ${JSON.stringify(url.url)};${replacement}\n// stage ${stage}`), shortCircuit: true };
  } });
  try {
    const { main } = await import(entry.href);
    const expected = stage === 1 ? route => [['ports', route]] : route => [['ports', route], ['publisher', route]];
    for (const [name, write, route] of [['legal file', true, 'push'], ['no file', false, null]]) {
      dir = await fs.mkdtemp(path.join(root, 'stage-'));
      if (write) await fs.writeFile(path.join(dir, STAGE_BATCH_ROUTE_FILE), stageBatchRouteText('push'));
      seen.length = 0;
      await assert.rejects(main([]), { message: STOP }, name);
      assert.deepEqual(seen, expected(route), name);
    }
  } finally { hook.deregister(); delete globalThis.batchRouteEntryFixture; }
});
