import { digest } from '../proof.mjs';
import { TRAIN_PROTOCOL_VERSION, trainBatchKey, trainEffectKey, trainHeadWorkKey, trainLandingSlotKey } from '../merge-train-v2-contract.mjs';
import { ABSENT_OID, publishTrainStaging, reconcileTrainIntent, trainMainContains } from './train-landing.mjs';

const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const handle = ({ batchId, generation }) => ({ batchId, generation });
const markerDate = '1970-01-01T00:00:00Z';

export function createSharedTrainPorts({ transport, config, github, landing, clock = Date.now }) {
  const scope = transport.scope;
  const call = (action, fields = {}) => transport.command({ ...fields, action, scope: scope.contextKey,
    repository: config.repository, protocol_version: TRAIN_PROTOCOL_VERSION });
  const project = batch => ({
    ...batch, scope, testTree: batch.treeSha, steps: batch.steps.map(step => step.sha),
    generationRefOid: batch.stagingObservation?.generationRefOid,
    ...(['sent', 'unknown'].includes(batch.landingIntent?.state)
      ? { landing: { state: batch.landingIntent.state, intent: landingIntent(batch.landingIntent) } } : {}),
  });
  const exact = (batch, expected) => batch?.sourceSha256 === config.sourceManifestSha256 && batch.testSha === expected.testSha
    && batch.baseSha === expected.baseSha && batch.members?.[0]?.pr === expected.pr && batch.members[0].headSha === expected.headSha
    && batch.batchId === trainBatchKey({ ...scope, baseSha: batch.baseSha, members: batch.members,
      sourceSha256: batch.sourceSha256, policyVersion: batch.policyVersion });
  const authorized = async () => {
    const probe = await call('role_probe');
    return probe.status === 'ok' && probe.protocol_version === TRAIN_PROTOCOL_VERSION && probe.on_duty === true && probe.stop_scope === 'none'
      && probe.node_id === transport.nodeId && probe.binding_generation === transport.bindingGeneration
      && probe.source_manifest_sha256 === config.sourceManifestSha256
      && Boolean(config.mergeTrainNode?.atomicLandingQualificationRef)
      && probe.atomic_landing_qualification_ref === config.mergeTrainNode.atomicLandingQualificationRef;
  };
  const marker = async (batch, predecessor, effectId, transition) => landing.createGenerationMarker({
    parentOid: predecessor === ABSENT_OID ? batch.baseSha : predecessor, treeOid: batch.treeSha, effectId, transition, createdAt: markerDate,
  });

  async function settleStage(batch) {
    const original = batch.stagingIntent;
    if (!original || !SHA.test(original.successorRefOid ?? '') || !SHA.test(original.stagingBeforeOid ?? '')) return;
    const effectId = trainEffectKey({ ...scope, action: 'staging_publish',
      subject: [batch.batchId, original.generation, original.generationRefOid, batch.baseSha, batch.testSha] });
    const intent = { ...original, effectId, slotId: trainLandingSlotKey(scope), stagedRefOid: original.successorRefOid };
    const readRefs = () => landing.readTrainRefs();
    let result = await publishTrainStaging({ intent, port: landing, readRefs, clock });
    if (result.state === 'unknown' && batch.stagingState === 'reserved' && batch.generation === original.generation
      && result.refs?.mainSha === batch.baseSha && result.refs?.generationRefOid === original.generationRefOid
      && result.refs?.stagingSha === original.stagingBeforeOid && result.refs.stagingSha !== batch.testSha) {
      const sent = await call('staging_send', handle(batch));
      if (sent.stagingState === 'sent')
        result = await publishTrainStaging({ intent, port: landing, readRefs, send: true, clock });
    }
    if (result.state === 'staged') {
      await call('staging_publish', { ...handle(batch), observation: { testSha: batch.testSha,
        generationRefOid: result.generationRefOid, evidence_digest: digest(result) } });
    }
  }

  let active = null;
  async function stagedBatch(expected) {
    if (!await authorized()) return null;
    const pending = await call('work_pending');
    if (pending.status !== 'ok' || !HASH.test(pending.active_batch_id ?? '')) return null;
    const batch = await call('batch_read', { batchId: pending.active_batch_id });
    return exact(batch, expected) && batch.state === 'waiting_checks' && batch.stagingState === 'settled' ? batch : null;
  }
  function landingIntent(result) {
    return { ...result.intent, effectId: result.effect_key, slotId: trainLandingSlotKey(scope), landedRefOid: result.successorRefOid };
  }
  async function reconcile(batch, intent, result) {
    const landed = result.state === 'landed';
    const observation = landed ? { mainSha: result.refs?.mainSha ?? result.mainSha,
      generationRefOid: result.refs?.generationRefOid ?? intent.landedRefOid, containsTestSha: true, evidence_digest: digest(result) } : null;
    const settled = await call('landing_reconcile', { ...handle(batch), effect_key: intent.effectId, observation });
    return { ...settled, effectId: settled.effect_key };
  }
  return Object.freeze({
    protocolVersion: TRAIN_PROTOCOL_VERSION, repositoryId: scope.repositoryId,
    atomicLandingQualified: authorized,
    async readAdmission(job, input) {
      if ((input.pr_ref !== undefined && input.pr_ref !== job.repo + '#' + job.pr)
        || (input.head_sha !== undefined && input.head_sha !== job.headSha)
        || (input.scope !== undefined && input.scope !== scope.contextKey)) return { status: 'rejected', error_code: 'ci_work_lease_stale' };
      if (input.action === 'resolve_pr_claim') return call('resolve_pr_claim', { pr: job.pr, head_sha: job.headSha, base_sha: job.baseSha });
      if (input.action !== undefined && input.action !== 'verify_head') return { status: 'rejected', error_code: 'ci_work_lease_stale' };
      const work_key = trainHeadWorkKey({ ...scope, pr: job.pr, headSha: job.headSha, action: 'verify_head' });
      return call('head_admission_read', { work_key, base_sha: input.base_sha ?? job.baseSha, changed_paths: input.changed_paths });
    },
    async stageBatch(batch) {
      if (!landing || !await authorized()) return;
      if (!batch.stagingState || batch.stagingState === 'reserved' && batch.stagingIntent?.generation !== batch.generation) {
        const refs = await landing.readTrainRefs();
        if (refs.mainSha !== batch.baseSha || refs.stagingSha === batch.testSha || refs.generationRefOid === ABSENT_OID) return;
        const effectId = trainEffectKey({ ...scope, action: 'staging_publish',
          subject: [batch.batchId, batch.generation, refs.generationRefOid, batch.baseSha, batch.testSha] });
        const successorRefOid = await marker(batch, refs.generationRefOid, effectId, 'stage');
        batch = await call('staging_prepare', { ...handle(batch), generationRefOid: refs.generationRefOid,
          stagingBeforeOid: refs.stagingSha, successorRefOid });
      }
      await settleStage(batch);
    },
    async reconcileBatch(batch) {
      if (!landing) return;
      if (!batch.landingIntent) return settleStage(batch);
      const record = batch.landingIntent;
      const intent = landingIntent(record);
      if (record.state !== 'settled') {
        if (record.state === 'reserved') return;
        const result = await reconcileTrainIntent({ intent, readRefs: () => landing.readTrainRefs(),
          contains: (test, tip) => trainMainContains(github, test, tip) });
        await reconcile(batch, intent, result);
        return;
      }
      const { mainSha } = await landing.readTrainRefs();
      if (mainSha !== intent.testSha && await trainMainContains(github, intent.testSha, mainSha) !== true) return;
      for (const member of [...batch.members.slice(1), batch.members[0]]) {
        const pull = await github.readPullRequest(member.pr);
        if (pull?.number !== member.pr || pull.head?.sha !== member.headSha) return;
        const result = await call('claim_adopt', { ...handle(batch), effect_key: intent.effectId, member,
          evidence_digest: digest({ member, mainSha, headSha: pull.head.sha, receipt_id: record.receipt_id }) });
        if (result.status !== 'committed') return;
      }
    },
    async confirmFront(expected) { return (await stagedBatch(expected)) !== null; },
    async readBatch(expected) {
      const batch = landing ? await stagedBatch(expected) : null;
      if (!batch) return null;
      const acquired = await call('batch_acquire', { batchId: batch.batchId });
      if (!exact(acquired, expected) || acquired.state !== 'waiting_checks' || !Number.isSafeInteger(acquired.generation)) return null;
      active = project(acquired);
      return active;
    },
    async release() {
      if (active) await call('batch_release', handle(active));
      active = null;
    },
    readRuleBypass: ({ rulesetId }) => github.readRuleBypass(rulesetId),
    async verifyMember({ batch, member }) {
      if (active !== batch) return false;
      const pull = await github.readPullRequest(member.pr);
      return pull?.number === member.pr && pull.state === 'open' && pull.draft === false && pull.merged === false
        && pull.head?.sha === member.headSha && pull.head.repo?.full_name === config.repository
        && pull.base?.ref === 'main' && pull.base.repo?.full_name === config.repository;
    },
    async prepareLanding({ batch, evidence }) {
      if (batch !== active || !await authorized()) return null;
      const refs = await landing.readTrainRefs();
      if (refs.mainSha !== batch.baseSha || refs.stagingSha !== batch.testSha || refs.generationRefOid !== batch.generationRefOid) return null;
      const effectId = trainEffectKey({ ...scope, action: 'landing_send',
        subject: [batch.batchId, batch.generation, refs.generationRefOid, batch.baseSha, batch.testSha] });
      const successorRefOid = await marker(batch, refs.generationRefOid, effectId, 'land');
      const result = await call('landing_prepare', { ...handle(batch), generationRefOid: refs.generationRefOid, successorRefOid,
        evidence_digest: digest(evidence), requiredRunsSha256: evidence.requiredRunsSha256 });
      return result.effect_key === effectId ? { state: result.state, intent: landingIntent(result) } : null;
    },
    async authorizeLandingSend(intent, evidence) {
      if (!active || intent.batchId !== active.batchId || intent.generation !== active.generation
        || evidence.requiredRunsSha256 !== active.requiredRunsSha256) return false;
      const result = await call('landing_send', { ...handle(active), effect_key: intent.effectId });
      return result.state === 'sent' && result.effect_key === intent.effectId;
    },
    reconcileLanding: ({ intent, result }) => reconcile(active, intent, result),
    async bisectBatch({ batch, terminal, evidenceDigest, requiredRunsSha256 }) {
      if (batch !== active) return null;
      return call('batch_bisect', { ...handle(batch), testSha: batch.testSha, terminal, evidence_digest: evidenceDigest, requiredRunsSha256 });
    },
  });
}
