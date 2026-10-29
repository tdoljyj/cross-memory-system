// Qualified callers supply the protected Native, GitHub, journal and supervisor
// ports. This module never reads a credential or treats a syntax check as a grant.
import { createHash } from 'node:crypto';
import { validateIndependentPublicationIdentity, independentPublicationIdentityDigest,
  independentPublicationExternalId } from './clued-independent-publication-identity.mjs';

export const COMPONENT_VERSION = '1.0.0';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const proofByError = new WeakMap();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const id = value => Number.isSafeInteger(value) && value > 0;
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
    || !payload.external_id.startsWith('independent-ci:') || !payload.external_id.includes(identity.job.id)
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
        const reply = await command({ action: 'publication_begin_independent', scope: context.scope,
          claim_id: context.identity.claim.claim_id, pr_ref: `${context.identity.job.repo}#${context.identity.job.pr}`,
          head_sha: context.identity.job.headSha, base_sha: context.identity.job.baseSha, target_branch: 'main',
          changed_paths: context.paths, independent_identity: context.identity });
        const confirmed = ticketOf(reply, context.identity);
        if (ticket && (ticket.publication_id !== confirmed.publication_id || ticket.receipt_id !== confirmed.receipt_id)) fail('independent_ticket_journal_invalid');
        ticket = confirmed;
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
    try { await current(context); } catch (error) { throw await noPost(error, key, context, ticket); }
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
      || stopped.source !== 'qualified-controller-supervisor' || !/^receipt:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(stopped.proofRef ?? '')) fail('independent_publisher_stop_unconfirmed');
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
