// Legacy App536 checks predate Native publication tickets. A qualified
// supervisor must hold a cross-node no-new-starts window and expose the
// complete protected controller inventory throughout this operation. Its
// callable assertCurrent capability is never replaced by a JSON "stopped" or
// an IDLE string. Every listed execution still needs the original bound
// broker/helper bytes, checked by observeIndependentControllerStop below.
//
// This module cannot ACK an outbox, stop Actions/App516, merge a PR, disable
// auto-merge or grant a supervisor qualification. The enclosing qualified
// controller must finish those independent gates before acknowledging.
import { observeIndependentControllerStop } from './clued-independent-revoker.mjs';

export const COMPONENT_VERSION = '1.0.0';
export const INDEPENDENT_APP_ID = 5368905;
export const INDEPENDENT_CHECK_NAMES = Object.freeze(['kooyumi-work-admission', 'gitleaks', 'trivy',
  'contract-placement', 'kooyumi-admission-verified', 'kooyumi-merge-slot']);
const names = new Set(INDEPENDENT_CHECK_NAMES);
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SCOPE = /^(global|project:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const MAX_HEADS = 5000, MAX_CHECKS = 10000, MAX_CONTROLLERS = 10000;
const clone = value => JSON.parse(JSON.stringify(value));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const safeReason = error => /^[a-z][a-z0-9_]{0,79}$/.test(error?.code ?? '') ? error.code : 'independent_legacy_drain_unconfirmed';
const targetCheck = check => check?.app?.id === INDEPENDENT_APP_ID && names.has(check.name);
const negative = check => check.status === 'completed' && check.conclusion === 'failure';
const sameCheck = (left, right) => left?.id === right?.id && left.app?.id === right.app?.id
  && left.name === right.name && left.head_sha === right.head_sha && left.external_id === right.external_id;
const nativeMarkers = check => String(check.output?.summary ?? '').split('\n').filter(line => line.startsWith('Native publication '));
const admittedSubjectMatches = (reply, subject) => reply?.complete === true
  && reply.repository === subject.repository && reply.claimId === subject.claimId
  && reply.executionEpoch === subject.beforeExecutionEpoch;

function subjectOf(scope, item) {
  if (!SCOPE.test(scope ?? '') || !UUID.test(item?.outbox_id ?? '') || !UUID.test(item.claim_id ?? '')
    || !positive(item.execution_epoch) || !REPO.test(item.repository ?? '')
    || !(item.head_sha == null || SHA.test(item.head_sha))
    || !(item.pr_ref == null || typeof item.pr_ref === 'string')) fail('independent_legacy_revocation_invalid');
  let pr = null;
  if (item.pr_ref != null) {
    const match = /^([^#]+)#([1-9][0-9]{0,9})$/.exec(item.pr_ref);
    if (!match || match[1].toLowerCase() !== item.repository.toLowerCase()) fail('independent_legacy_pr_subject_changed');
    pr = Number(match[2]);
  }
  if (!item.head_sha && !pr) fail('independent_legacy_heads_unknown');
  return Object.freeze({ scope, outboxId: item.outbox_id, claimId: item.claim_id,
    beforeExecutionEpoch: item.execution_epoch, repository: item.repository, prRef: item.pr_ref ?? null, pr });
}

function validatePull(pr, subject) {
  if (pr?.number !== subject.pr || !SHA.test(pr.head?.sha ?? '')
    || pr.base?.repo?.full_name?.toLowerCase() !== subject.repository.toLowerCase()
    || !positive(pr.commits) || pr.commits > MAX_HEADS) fail('independent_legacy_pr_subject_changed');
  if (pr.auto_merge != null) fail('independent_legacy_auto_merge_enabled');
  return pr;
}

async function completeInventory(github, head) {
  const reply = await github.readChecks(head);
  if (reply?.complete !== true || !Array.isArray(reply.checks) || reply.checks.length > MAX_CHECKS
    || new Set(reply.checks.map(c => c?.id)).size !== reply.checks.length
    || reply.checks.some(c => !positive(c?.id) || c.head_sha !== head)) fail('independent_legacy_check_inventory_incomplete');
  return reply.checks;
}

export async function drainLegacyIndependentChecks({ scope, revocation, github, nativeHeads, supervisor }) {
  const result = { status: 'PENDING', heads: [], revokedCheckIds: [], stopProofRefs: [], pending: [], acknowledgmentAllowed: false };
  try {
    const subject = subjectOf(scope, revocation);
    if (!['readChecks', 'revokeCheck'].every(k => typeof github?.[k] === 'function')
      || typeof nativeHeads?.read !== 'function'
      || typeof supervisor?.withLegacyDrainWindow !== 'function'
      || (subject.pr && !['readPullRequest', 'readPullRequestCommits'].every(k => typeof github?.[k] === 'function'))) fail('independent_legacy_ports_unavailable');
    const admitted = await nativeHeads.read(clone(revocation));
    if (!admittedSubjectMatches(admitted, subject) || !Array.isArray(admitted.heads) || admitted.heads.length > MAX_HEADS
      || admitted.heads.some(head => !SHA.test(head))) fail('independent_legacy_admitted_heads_incomplete');
    const heads = new Set(admitted.heads);
    if (revocation.head_sha) heads.add(revocation.head_sha);
    let pull = null;
    if (subject.pr) {
      pull = validatePull(await github.readPullRequest(subject.pr), subject);
      heads.add(pull.head.sha);
      const history = await github.readPullRequestCommits(subject.pr);
      if (history?.complete !== true || !Array.isArray(history.commits) || history.commits.length !== pull.commits
        || history.commits.length > MAX_HEADS || history.commits.some(c => !SHA.test(c?.sha ?? ''))
        || new Set(history.commits.map(c => c.sha)).size !== history.commits.length) fail('independent_legacy_pr_history_incomplete');
      for (const commit of history.commits) heads.add(commit.sha);
    }
    if (!heads.size || heads.size > MAX_HEADS) fail('independent_legacy_heads_unknown');
    result.heads = [...heads].sort();
    const windowSubject = Object.freeze({ ...subject, heads: [...result.heads] });
    let invoked = false, completed = false;
    await supervisor.withLegacyDrainWindow(clone(windowSubject), async window => {
      if (invoked) fail('independent_legacy_supervisor_window_reentered');
      invoked = true;
      if (typeof window?.assertCurrent !== 'function' || typeof window?.readControllerStopBundles !== 'function') fail('independent_legacy_supervisor_unqualified');
      const current = async () => {
        // The qualified port checks the retained launch barrier, inventory
        // generation and all affected nodes. A copied JSON flag cannot do it.
        if (await window.assertCurrent() !== true) fail('independent_legacy_supervisor_window_lost');
      };
      await current();
      const inventory = await window.readControllerStopBundles();
      if (inventory?.complete !== true || !Array.isArray(inventory.executions) || inventory.executions.length > MAX_CONTROLLERS)
        fail('independent_legacy_controller_inventory_incomplete');
      const controllers = new Set(), stoppedChecks = new Set();
      for (const execution of inventory.executions) {
        const identity = execution?.identity;
        if (identity?.job?.repo !== subject.repository || !heads.has(identity.job.headSha)
          || identity.claim?.claim_id !== subject.claimId || !positive(identity.claim.execution_epoch)
          || identity.claim.execution_epoch >= subject.beforeExecutionEpoch || controllers.has(identity.controller_id))
          fail('independent_legacy_controller_subject_changed');
        const stopped = observeIndependentControllerStop(identity, execution.witness, execution.bundle);
        controllers.add(identity.controller_id);
        stoppedChecks.add(`${identity.job.headSha}:${identity.check_name}`);
        result.stopProofRefs.push(stopped.proofRef);
      }
      await current();
      for (const head of result.heads) {
        const checks = await completeInventory(github, head);
        for (const check of checks.filter(targetCheck)) {
          // Completeness flags and the launch barrier cannot stand in for the
          // physical proof of the old publisher that could make this check
          // green again. Unsupported older job formats stay pending.
          if (!stoppedChecks.has(`${head}:${check.name}`)) fail('independent_legacy_stop_proof_missing');
          if (!negative(check)) {
            await current();
            const markers = nativeMarkers(check);
            const patched = await github.revokeCheck(check.id, { status: 'completed', conclusion: 'failure', output: {
              title: 'REVOKED: work handed over', summary: ['The previous independent execution no longer authorizes this head.', ...markers].join('\n\n') } });
            if (!sameCheck(patched, check) || !negative(patched) || markers.some(marker => !String(patched.output?.summary ?? '').includes(marker)))
              fail('independent_legacy_revocation_unconfirmed');
            // Record a known write before the read-back: a later read failure
            // is pending and must never erase the fact this PATCH occurred.
            result.revokedCheckIds.push(check.id);
          }
          const observed = (await completeInventory(github, head)).find(c => c.id === check.id);
          if (!sameCheck(observed, check) || !negative(observed) || nativeMarkers(check).some(marker => !String(observed.output?.summary ?? '').includes(marker)))
            fail('independent_legacy_revocation_unconfirmed');
        }
        const after = await completeInventory(github, head);
        if (after.some(check => targetCheck(check) && !negative(check))) fail('independent_legacy_checks_changed');
      }
      await current();
      if (pull) {
        const after = validatePull(await github.readPullRequest(subject.pr), subject);
        if (after.head.sha !== pull.head.sha || after.commits !== pull.commits) fail('independent_legacy_pr_subject_changed');
      }
      // Native's complete durable head set must also remain covered. This is
      // another read; only the enclosing admission barrier can prohibit a new
      // head after this function returns.
      const after = await nativeHeads.read(clone(revocation));
      if (!admittedSubjectMatches(after, subject) || !Array.isArray(after.heads) || after.heads.length > MAX_HEADS
        || after.heads.some(head => !SHA.test(head) || !heads.has(head))) fail('independent_legacy_admitted_heads_changed');
      await current();
      completed = true;
    });
    if (!invoked || !completed) fail('independent_legacy_supervisor_window_unconfirmed');
    result.status = 'DRAINED';
  } catch (error) { result.pending.push({ reason: safeReason(error) }); }
  return result;
}
