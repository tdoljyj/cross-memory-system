// Qualified callers supply the protected Native, GitHub, journal and supervisor
// ports. This module never reads a credential or treats a syntax check as a grant.
import { createHash } from 'node:crypto';
import { APP_ID, CHECKS, validateIndependentPublicationIdentity, independentPublicationIdentityDigest,
  independentPublicationExternalId } from './clued-independent-publication-identity.mjs';
import { TRAIN_CHECK_EFFECT_FIELDS, TRAIN_EFFECT_STATES, TRAIN_FAILURE, TRAIN_HEAD_RETRY_FIELDS,
  TRAIN_PROTOCOL_VERSION, TRAIN_TICKET_AUTHORITY, trainEffectKey, trainHeadWorkKey }
  from '../../work/actions-hosted-migration/independent-ci-v1/src/merge-train-v2-contract.mjs';
import { admissionExternalIdV2 } from '../../work/actions-hosted-migration/independent-ci-v1/src/job-v2.mjs';

export const COMPONENT_VERSION = '1.0.0';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const proofByError = new WeakMap();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const id = value => Number.isSafeInteger(value) && value > 0;
// Hosted relay has its own attested run identity and intentionally keeps that
// external_id. Its exact role/head form is checked here; its Native marker
// separately binds the complete local job and original publication ticket.
export function independentCheckExternalIdMatchesJob(value, job) {
  if (typeof value !== 'string' || value.length > 200) return false;
  if (value.startsWith('independent-ci:') && value.includes(job.id)) return true;
  if (!['gitleaks','trivy'].includes(job.role)) return false;
  const prefix = `independent-ci:relay:${job.role}:${job.headSha.slice(0,12)}:run`;
  return value.startsWith(prefix) && /^[1-9][0-9]{0,19}:a[1-9][0-9]{0,9}$/.test(value.slice(prefix.length));
}
export const nativeNoPostProof = error => proofByError.get(error) ?? null;
export function nativePublicationJournalKey(identity) {
  return digest(['independent-native-publication-journal/1', validateIndependentPublicationIdentity(identity).effect_key]);
}
const marker = ticket => `Native publication ${independentPublicationExternalId(ticket.identity, ticket.publication_id)}; begin Receipt ${ticket.receipt_id}.`;
function ticketOf(reply, identity) {
  if (reply?.status !== 'ok' || reply.verdict !== 'ADMITTED' || reply.execution_policy !== 'active'
    || reply.execution_authorized !== true || reply.publication_required !== true
    || !UUID.test(reply.publication_id ?? '') || !UUID.test(reply.receipt_id ?? '')
    || independentPublicationIdentityDigest(reply.independent_identity) !== independentPublicationIdentityDigest(identity)) fail('independent_native_ticket_unconfirmed');
  return { identity: clone(identity), publication_id: reply.publication_id, receipt_id: reply.receipt_id };
}
function checkIdentity(check, context, ticket) {
  return id(check?.id) && check.app?.id === context.identity.app_id && check.name === context.identity.check_name
    && check.head_sha === context.identity.job.headSha && check.external_id === context.payload.external_id
    && check.status === 'completed' && typeof check.output?.summary === 'string' && check.output.summary.includes(marker(ticket));
}
function contextOf({ identity, scope, paths, payload }) {
  identity = validateIndependentPublicationIdentity(identity);
  if (!/^(global|project:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(scope ?? '')
    || !Array.isArray(paths) || paths.length < 1 || paths.length > 3000 || new Set(paths).size !== paths.length
    || paths.some(p => typeof p !== 'string' || !p || p.length > 4096 || /[\x00-\x1f\\]/.test(p) || p.startsWith('/') || p.split('/').some(s => !s || s === '.' || s === '..'))
    || payload?.name !== identity.check_name || payload.head_sha !== identity.job.headSha || payload.status !== 'completed'
    || !['success', 'failure', 'neutral', 'cancelled', 'timed_out', 'action_required', 'skipped'].includes(payload.conclusion)
    || typeof payload.external_id !== 'string' || payload.external_id.length > 200
    || !independentCheckExternalIdMatchesJob(payload.external_id, identity.job)
    || typeof payload.output?.title !== 'string' || typeof payload.output.summary !== 'string'
    || payload.output.summary.length > 64000) fail('independent_publication_context_invalid');
  return clone({ identity, scope, paths: [...paths].sort(), payload });
}

export function createIndependentPublicationRuntime({ native, github, journal, assertCurrent, observeStopped }) {
  // Every invocation for one identity MUST use the same permanent protected
  // CAS journal. A Native unique ticket is not a cross-journal POST mutex.
  if (typeof native?.command !== 'function' || !['createCheck', 'readCheck', 'readChecks', 'revokeCheck'].every(k => typeof github?.[k] === 'function')
    || !['begin', 'read', 'transition'].every(k => typeof journal?.[k] === 'function') || typeof assertCurrent !== 'function') fail('independent_publication_ports_required');
  const handles = new WeakMap();
  const current = async context => { if (await assertCurrent(clone(context.identity)) !== true) fail('independent_current_authority_refused'); };
  const command = async input => {
    const reply = await native.command(input);
    if (!reply || !['ok', 'committed'].includes(reply.status)) fail('independent_native_command_refused');
    return reply;
  };
  async function noPost(error, key, context, ticket = null) {
    // Only before the durable sent boundary. A copied JSON flag is not proof.
    const record = await journal.read(key);
    if (!record || !['intent', 'authorized', 'not_sent'].includes(record.state)) return error;
    const wrapped = Object.assign(new Error('independent_publication_not_sent'), { code: 'independent_publication_not_sent' });
    proofByError.set(wrapped, Object.freeze({ identitySha256: independentPublicationIdentityDigest(context.identity),
      journalKey: key, publicationId: ticket?.publication_id ?? null, notSent: true }));
    return wrapped;
  }
  async function find(context, ticket, knownId = null) {
    if (knownId !== null) {
      const check = await github.readCheck(knownId);
      if (!checkIdentity(check, context, ticket)) fail('independent_published_check_identity_changed');
      return check;
    }
    const checks = await github.readChecks(context.identity.job.headSha);
    if (!Array.isArray(checks)) fail('independent_check_inventory_unconfirmed');
    const matches = checks.filter(check => checkIdentity(check, context, ticket));
    if (matches.length !== 1) fail(matches.length ? 'independent_publication_ambiguous' : 'independent_unknown_post_not_found');
    return matches[0];
  }
  async function revoke(context, ticket, check) {
    if (check.conclusion !== 'failure') {
      await github.revokeCheck(check.id, { status: 'completed', conclusion: 'failure', output: {
        title: 'REVOKED: Native execution epoch changed', summary: marker(ticket) } });
    }
    const observed = await find(context, ticket, check.id);
    if (observed.conclusion !== 'failure') fail('independent_revocation_unconfirmed');
    return observed;
  }
  async function settle(key, context, ticket, check) {
    const finished = await command({ action: 'publication_finish', scope: context.scope,
      publication_id: ticket.publication_id, check_run_id: String(check.id) });
    if (finished.status !== 'committed' || typeof finished.must_revoke !== 'boolean' || !UUID.test(finished.receipt_id ?? '')) fail('independent_native_finish_unconfirmed');
    if (finished.must_revoke) {
      const observed = await revoke(context, ticket, check);
      const record = await journal.read(key);
      if (record.state !== 'revoked') await journal.transition(key, record.state, 'revoked', { ticket, checkRunId: check.id, pendingNativeDrain: true });
      // Reconciliation needs the qualified supervisor's actual stop proof.
      return { status: 'REVOKED_PENDING_DRAIN', check: observed, ticket };
    }
    const observed = await find(context, ticket, check.id);
    if (observed.conclusion !== context.payload.conclusion) fail('independent_check_conclusion_changed');
    const record = await journal.read(key);
    if (record.state !== 'settled') await journal.transition(key, record.state, 'settled', { ticket, checkRunId: check.id, finishReceiptId: finished.receipt_id });
    return { status: 'SETTLED', check: observed, ticket };
  }
  async function confirmTicket(context, ticket = null) {
    const reply = await command({ action: 'publication_begin_independent', scope: context.scope,
      claim_id: context.identity.claim.claim_id, pr_ref: `${context.identity.job.repo}#${context.identity.job.pr}`,
      head_sha: context.identity.job.headSha, base_sha: context.identity.job.baseSha, target_branch: 'main',
      changed_paths: context.paths, independent_identity: context.identity });
    const confirmed = ticketOf(reply, context.identity);
    if (ticket && (ticket.publication_id !== confirmed.publication_id || ticket.receipt_id !== confirmed.receipt_id)) fail('independent_ticket_journal_invalid');
    return confirmed;
  }
  async function prepare(input) {
    const context = contextOf(input), key = nativePublicationJournalKey(context.identity);
    const begun = await journal.begin(key, context);
    if (['sent', 'uncertain', 'settled', 'revoked'].includes(begun.value.state)) return { recoveryRequired: true, key };
    if (begun.value.state === 'not_sent') fail('independent_publication_already_aborted');
    let ticket = begun.value.details?.ticket ?? null;
    try {
      await current(context);
      {
        // Revalidate even an authorized local ticket: Native may have committed
        // an abort before an older caller lost its reply or local final write.
        ticket = await confirmTicket(context, ticket);
        if (begun.value.state === 'intent') await journal.transition(key, 'intent', 'authorized', { ticket });
      }
      if (!ticket || independentPublicationIdentityDigest(ticket.identity) !== independentPublicationIdentityDigest(context.identity)) fail('independent_ticket_journal_invalid');
      const handle = Object.freeze({ key, publicationId: ticket.publication_id });
      handles.set(handle, { key, context, ticket });
      return handle;
    } catch (error) { throw await noPost(error, key, context, ticket); }
  }
  async function createCheck(handle) {
    const entry = handles.get(handle); handles.delete(handle);
    if (!entry) fail('independent_prepared_handle_required');
    const { key, context, ticket } = entry;
    // A competing instance may only discover the original effect, never POST.
    if ((await journal.read(key)).state !== 'authorized') return recover(key);
    try {
      await current(context);
      // Claim freshness alone does not establish the CI principal's current
      // role or exact-head grant. Recheck the original Native ticket at the
      // final non-POST boundary, without issuing another publication.
      await confirmTicket(context, ticket);
    } catch (error) { throw await noPost(error, key, context, ticket); }
    await journal.transition(key, 'authorized', 'sent', { ticket });
    try {
      const payload = clone(context.payload); payload.output.summary += '\n\n' + marker(ticket);
      const check = await github.createCheck(payload);
      if (!checkIdentity(check, context, ticket)) fail('independent_created_check_identity_unconfirmed');
      return await settle(key, context, ticket, check);
    } catch (error) {
      const record = await journal.read(key);
      if (record.state === 'sent') await journal.transition(key, 'sent', 'uncertain', { ticket });
      throw error;
    }
  }
  async function recover(key) {
    const record = await journal.read(key);
    if (!record || !['sent', 'uncertain', 'settled', 'revoked'].includes(record.state)) fail('independent_recovery_state_invalid');
    const context = contextOf(record.subject), ticket = record.details?.ticket;
    if (!ticket || nativePublicationJournalKey(context.identity) !== key) fail('independent_ticket_journal_invalid');
    if (record.details.abortingNotSent || record.details.notSentConfirmed) return reconcileStopped(key);
    const check = await find(context, ticket, record.details?.checkRunId ?? null);
    if (record.state === 'revoked') return { status: 'REVOKED_PENDING_DRAIN', check, ticket };
    // No createCheck is reachable from this method, even after a lost reply.
    return settle(key, context, ticket, check);
  }
  async function adoptOpenTicket(key, publication) {
    // A lost Native begin reply is not a lost GitHub POST. The qualified
    // revocations reader can supply the original durable ticket after handover;
    // do not call begin again under a new generation or create a fresh effect.
    const record = await journal.read(key);
    if (!record || record.state !== 'intent') fail('independent_recovery_state_invalid');
    const context = contextOf(record.subject), identity = context.identity;
    if (!UUID.test(publication?.publication_id ?? '') || !UUID.test(publication.started_receipt_id ?? '')
      || publication.run_id !== null || publication.claim_id !== identity.claim.claim_id
      || publication.execution_epoch !== identity.claim.execution_epoch || publication.repository !== identity.job.repo
      || publication.head_sha !== identity.job.headSha || publication.pr_ref !== `${identity.job.repo}#${identity.job.pr}`
      || independentPublicationIdentityDigest(publication.independent_identity) !== independentPublicationIdentityDigest(identity)
      || nativePublicationJournalKey(identity) !== key) fail('independent_ticket_journal_invalid');
    const ticket = { identity, publication_id: publication.publication_id, receipt_id: publication.started_receipt_id };
    await journal.transition(key, 'intent', 'authorized', { ticket, recoveredRegistration: true });
    return { status: 'REGISTRATION_RECOVERED', ticket };
  }
  async function reconcileStopped(key) {
    const record = await journal.read(key);
    if (!record) fail('independent_recovery_state_invalid');
    const context = contextOf(record.subject), ticket = record.details?.ticket;
    if (!ticket || typeof observeStopped !== 'function') fail('independent_publisher_stop_unconfirmed');
    const stopped = await observeStopped(clone(context.identity));
    if (stopped?.stopped !== true || stopped.controller_id !== context.identity.controller_id || stopped.job_id !== context.identity.job.id
      || stopped.source !== 'qualified-controller-supervisor'
      || !/^(?:receipt:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|sha256:[0-9a-f]{64})$/.test(stopped.proofRef ?? '')) fail('independent_publisher_stop_unconfirmed');
    if (record.details?.notSentConfirmed) return { status: 'NOT_SENT', ticket };
    if (['intent', 'authorized'].includes(record.state) || record.details?.abortingNotSent) {
      // Reserve a non-POST recovery state BEFORE the remote abort. `sent` here
      // records the abort intent; the explicit flag forbids a GitHub POST.
      if (!record.details?.abortingNotSent) await journal.transition(key, record.state, 'sent', { ticket, abortingNotSent: true, stopProofRef: stopped.proofRef });
      const reply = await command({ action: 'publication_abort_independent', scope: context.scope, publication_id: ticket.publication_id,
        independent_identity: context.identity, not_sent: true, publisher_stopped: true });
      if (reply.status !== 'committed' || reply.publication_id !== ticket.publication_id || !UUID.test(reply.receipt_id ?? '')) fail('independent_native_abort_unconfirmed');
      await journal.transition(key, 'sent', 'revoked', { ticket, notSentConfirmed: true, stopProofRef: stopped.proofRef, abortReceiptId: reply.receipt_id });
      return { status: 'NOT_SENT', ticket };
    }
    if (record.state === 'not_sent') return { status: 'NOT_SENT', ticket };
    const check = await find(context, ticket, record.details?.checkRunId ?? null);
    await revoke(context, ticket, check);
    const reply = await command({ action: 'publication_reconcile', scope: context.scope, publication_id: ticket.publication_id,
      check_run_id: String(check.id), publisher_stopped: true, checks_revoked: true });
    if (reply.status !== 'committed' || reply.must_revoke !== true || !UUID.test(reply.receipt_id ?? '')) fail('independent_native_reconcile_unconfirmed');
    const latest = await journal.read(key);
    if (latest.state !== 'revoked') await journal.transition(key, latest.state, 'revoked', { ticket, checkRunId: check.id, stopProofRef: stopped.proofRef, reconcileReceiptId: reply.receipt_id });
    return { status: 'RECONCILED', ticket, checkRunId: check.id };
  }
  return Object.freeze({ prepare, createCheck, recover, adoptOpenTicket, reconcileStopped });
}

// 协议 2 的发送权由 Native 账本记录，其他节点据此区分预留票据和已发送的请求。
export function createTrainHeadPublicationRuntime({ train, github, assertCurrent }) {
  const command = async (action, fields) => {
    const reply = await train.command({ ...fields, action, protocol_version: TRAIN_PROTOCOL_VERSION });
    if (reply?.protocol_version !== TRAIN_PROTOCOL_VERSION) fail('ci_train_protocol_unconfirmed');
    return reply;
  };
  const unknown = () => fail(TRAIN_FAILURE.EFFECT_UNKNOWN.native);
  const blocked = reason => ({ status: 'BLOCKED', reason, sideEffects: 0 });
  const sameLease = (reply, fields) => reply.work_key === fields.work_key && reply.lease_generation === fields.lease_generation;
  const stale = (reply, fields) => sameLease(reply, fields) && reply.status === 'rejected'
    && reply.error_code === TRAIN_FAILURE.LEASE_STALE.native;

  // 完整准入和发布前只读复验共用这次领用的命令端口。换代后，旧调用仍携带旧代次。
  function admissionCommand(fields) {
    return async input => {
      const action = input.action ?? 'verify_head';
      if (!['verify_head', 'resolve_pr_claim', 'carry_main_merge'].includes(action)
        || (input.scope !== undefined && input.scope !== fields.scope)
        || (input.pr_ref !== undefined && input.pr_ref !== fields.pr_ref)
        || (input.target_branch !== undefined && input.target_branch !== fields.target_branch)
        || (action !== 'carry_main_merge' && input.head_sha !== undefined && input.head_sha !== fields.head_sha))
        fail('ci_train_head_work_unconfirmed');
      const reply = await command(action, { ...fields,
        ...(action === 'verify_head' ? {
          changed_paths: input.changed_paths, claim_id: input.claim_id, read_only: input.read_only ?? (input.pr_ref === undefined),
          ...(input.mechanical_paths_proven === undefined ? {} : { mechanical_paths_proven: input.mechanical_paths_proven }),
          ...(input.mechanical_policy === undefined ? {} : { mechanical_policy: input.mechanical_policy }),
          ...(input.admission_mode === undefined ? {} : { admission_mode: input.admission_mode }),
        } : action === 'resolve_pr_claim' ? { read_only: input.read_only === true }
          : { from_head_sha: input.from_head_sha, head_sha: input.head_sha, main_sha: input.main_sha }),
        base_sha: input.base_sha ?? fields.base_sha,
      });
      if (!sameLease(reply, fields)) fail('ci_train_head_work_unconfirmed');
      return reply;
    };
  }

  async function acquire(job, controllerId) {
    const subject = { ...train.scope, pr: job.pr, headSha: job.headSha };
    const workKey = trainHeadWorkKey({ ...subject, action: 'verify_head' });
    const binding = { work_key: workKey, scope: train.scope.contextKey, repository: job.repo, pr_ref: job.repo + '#' + job.pr,
      head_sha: job.headSha, base_sha: job.baseSha, target_branch: train.scope.targetBranch,
      source_manifest_sha256: job.sourceManifestSha256, controller_id: controllerId };
    const reply = await command('verify_head', binding);
    if (reply.work_key !== workKey) fail('ci_train_head_work_unconfirmed');
    const code = reply.status === 'rejected' ? reply.error_code : null;
    if ([TRAIN_FAILURE.HEAD_LEASE_COMPLETED.native, TRAIN_FAILURE.LEASE_STALE.native].includes(code)) return { reason: code };
    if (code === TRAIN_FAILURE.HEAD_LEASE_HELD.native) {
      const ciRetryAfter = reply[TRAIN_HEAD_RETRY_FIELDS.native];
      if (typeof ciRetryAfter !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(ciRetryAfter)
        || !Number.isFinite(Date.parse(ciRetryAfter))) fail('ci_train_head_work_unconfirmed');
      return { reason: code, ciRetryAfter };
    }
    if (reply.status !== 'ok' || !id(reply.lease_generation) || typeof reply.resume_required !== 'boolean') fail('ci_train_head_work_unconfirmed');
    const fields = { ...binding, lease_generation: reply.lease_generation };
    return { job, subject, resumeRequired: reply.resume_required, fields, admissionCommand: admissionCommand(fields) };
  }

  async function publish(lease, context = null) {
    const { job } = lease;
    const identity = context?.identity;
    if (TRAIN_TICKET_AUTHORITY[job.role] !== 'head_or_front_job' || job.role !== 'work-admission'
      || job.testSha !== job.headSha
      || (!lease.resumeRequired && (context?.scope !== lease.fields.scope || identity?.controller_id !== lease.fields.controller_id)))
      fail('ci_train_head_work_unconfirmed');
    const effectKey = trainEffectKey({ ...lease.subject, action: 'publication_begin_independent',
      subject: [job.pr, job.headSha, APP_ID, CHECKS[job.role]] });
    // 维持 GitHub 准入门禁使用的 external_id 格式。共享效果键跨尝试和认领代次稳定。
    const externalIdOf = ({ job, claim }) => admissionExternalIdV2('independent-ci:native-work-admission', job,
      { claimId: claim.claim_id, fence: claim.fence, epoch: claim.execution_epoch });
    const fields = { ...lease.fields, effect_key: effectKey };
    const begin = lease.resumeRequired
      ? await command('publication_reconcile', { ...fields, phase: 'read' })
      : await command('publication_begin_independent', { ...fields, phase: 'reserve',
        effect: { appId: APP_ID, headSha: job.headSha, externalId: externalIdOf(identity), checkRunId: null },
        changed_paths: context.paths, independent_identity: identity });
    if (stale(begin, fields)) return blocked(TRAIN_FAILURE.LEASE_STALE.native);
    if (begin.status !== 'ok' || begin.lease_generation !== fields.lease_generation || begin.effect_key !== effectKey
      || !TRAIN_EFFECT_STATES.includes(begin.state) || !UUID.test(begin.publication_id ?? '') || !UUID.test(begin.receipt_id ?? '')) unknown();
    const original = validateIndependentPublicationIdentity(begin.independent_identity);
    if (original.job.repo !== job.repo || original.job.pr !== job.pr || original.job.headSha !== job.headSha
      || original.job.role !== job.role || original.job.testSha !== job.headSha) unknown();
    const externalId = externalIdOf(original);
    const effect = { appId: APP_ID, headSha: job.headSha, externalId, checkRunId: null };
    const matchesEffect = value => TRAIN_CHECK_EFFECT_FIELDS.every(k => Object.hasOwn(value ?? {}, k))
      && value.appId === effect.appId && value.headSha === effect.headSha && value.externalId === externalId
      && (value.checkRunId === null || id(value.checkRunId));
    if (!matchesEffect(begin.effect)) unknown();
    const ticket = { identity: original, publication_id: begin.publication_id, receipt_id: begin.receipt_id };
    const bound = { identity: original, payload: { ...context?.payload, external_id: externalId } };
    const matches = async () => (await github.readChecks(job.headSha)).filter(check => check.app?.id === effect.appId
      && check.name === original.check_name && check.head_sha === effect.headSha && check.external_id === externalId);
    async function readEffect(knownId = null) {
      const found = await matches();
      if (found.length !== 1 || !checkIdentity(found[0], bound, ticket)
        || (knownId !== null && found[0].id !== knownId)) unknown();
      return found[0];
    }
    let checkRun, sideEffects = 0;
    if (begin.state === 'reserved') {
      if (lease.resumeRequired || begin.effect.checkRunId !== null || independentPublicationIdentityDigest(original) !== independentPublicationIdentityDigest(identity)) unknown();
      if (await assertCurrent(identity, lease.admissionCommand) !== true) return blocked(TRAIN_FAILURE.LEASE_STALE.native);
      const inventory = await github.readChecks(job.headSha);
      // 混版切换先排空旧普通准入检查。
      if (inventory.some(c => c.app?.id === effect.appId && c.name === original.check_name)) unknown();
      const send = await command('publication_begin_independent', { ...fields, phase: 'send', publication_id: ticket.publication_id });
      if (stale(send, fields)) return blocked(TRAIN_FAILURE.LEASE_STALE.native);
      if (sameLease(send, fields) && ['ok', 'rejected'].includes(send.status) && send.state === 'reserved' && send.send_authorized === false
        && send.publication_id === ticket.publication_id && send.effect_key === effectKey
        && matchesEffect(send.effect) && send.effect.checkRunId === null) return blocked('ci_publication_send_refused');
      if (send.status !== 'ok' || send.state !== 'sent' || send.send_authorized !== true
        || send.lease_generation !== fields.lease_generation || send.publication_id !== ticket.publication_id
        || send.effect_key !== effectKey || !matchesEffect(send.effect) || send.effect.checkRunId !== null) unknown();
      const body = clone(bound.payload);
      body.output.summary += '\n\n' + marker(ticket);
      const posted = await github.createCheck(body);
      if (!checkIdentity(posted, bound, ticket)) unknown();
      sideEffects = 1;
      checkRun = await readEffect(posted.id);
    } else {
      checkRun = await readEffect(begin.effect.checkRunId);
    }

    const exact = { ...fields, publication_id: ticket.publication_id, check_run_id: String(checkRun.id),
      effect: { ...effect, checkRunId: checkRun.id } };
    const confirms = answer => answer.status === 'committed' && answer.publication_id === exact.publication_id
      && answer.effect_key === effectKey && matchesEffect(answer.effect)
      && answer.effect.checkRunId === checkRun.id && UUID.test(answer.receipt_id ?? '');
    if (begin.state !== 'revoked') {
      if (checkRun.conclusion !== 'success') unknown();
      const finished = await command('publication_finish', exact);
      if (!confirms(finished) || typeof finished.must_revoke !== 'boolean') unknown();
      if (!finished.must_revoke) {
        if (finished.publication_status !== 'published' || finished.first_queue_pending !== true) unknown();
        return { status: 'SETTLED', effectKey, checkRunId: checkRun.id, sideEffects };
      }
    }
    if (checkRun.conclusion !== 'failure') {
      const authorized = await command('revoke_check', { ...exact, phase: 'authorize' });
      if (stale(authorized, exact) && sideEffects === 0) return blocked(TRAIN_FAILURE.LEASE_STALE.native);
      if (!sameLease(authorized, exact) || authorized.status !== 'ok' || authorized.revoke_authorized !== true
        || authorized.publication_id !== ticket.publication_id || authorized.effect_key !== effectKey
        || !matchesEffect(authorized.effect) || authorized.effect.checkRunId !== checkRun.id) unknown();
      await github.revokeCheck(checkRun.id, { status: 'completed', conclusion: 'failure', output: {
        title: 'REVOKED: Native publication authority changed', summary: marker(ticket) } });
      sideEffects++;
    }
    if ((await readEffect(checkRun.id)).conclusion !== 'failure') unknown();
    const revoked = await command('publication_reconcile', exact);
    if (!confirms(revoked) || revoked.must_revoke !== true) unknown();
    return { status: 'REVOKED', effectKey, checkRunId: checkRun.id, sideEffects };
  }
  return Object.freeze({ acquire, publish });
}
