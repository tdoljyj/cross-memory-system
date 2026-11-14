// App536 revocation consumes the original permanent publication journal and
// the qualified supervisor's protected broker/helper bytes. It never invents
// an Actions run_id, treats a cancellation request as stop, or closes an
// invisible uncertain POST. Installing/qualifying these ports is separate.
import { createHash } from 'node:crypto';
import { validateIndependentPublicationIdentity, independentPublicationIdentityDigest } from './clued-independent-publication-identity.mjs';
import { createIndependentPublicationRuntime, nativePublicationJournalKey } from './clued-independent-publication-runtime.mjs';
import { validateNativeReceiptV2, validateOutcome } from '../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-fact.mjs';
import { validateBrokerResponse, BROKER_REQUEST_CONTRACT } from '../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/broker-protocol.mjs';
import { validatePlanV2 } from '../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/stage-package.mjs';
import { canonical } from '../../work/actions-hosted-migration/independent-ci-v1/src/proof.mjs';

export const COMPONENT_VERSION = '1.0.0';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const parse = bytes => {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > 1024 * 1024) fail('independent_stop_bundle_unconfirmed');
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
};
const clone = value => JSON.parse(JSON.stringify(value));
export function controllerWitnessJournalKey(identity) {
  return hash(JSON.stringify(['independent-controller-supervision/1',independentPublicationIdentityDigest(identity)]));
}

// Called by the real protected entry before Native begin; all arguments come
// from its already-held record and sealed stage, never from PR code.
export async function registerIndependentController({ identity, journal, args, plan, record }) {
  identity = validateIndependentPublicationIdentity(identity);
  validatePlanV2(plan);
  if (!/^[0-9a-f]{32}$/.test(args?.nonce??'') || !/^[0-9a-f]{64}$/.test(args?.configSha256??'')
    || !plan || !['work-admission','check-publisher','control-checks'].includes(plan.entryRole)
    || plan.sourceManifestSha256 !== identity.job.sourceManifestSha256
    || plan.sourceManifestSha256 !== record?.config?.sourceManifestSha256
    || plan.acceptanceSha256 !== record?.hashes?.acceptanceSha256
    || !/^[0-9a-f]{64}$/.test(plan.entrySha256??'') || !/^[0-9a-f]{64}$/.test(plan.jobSha256??'')
    || typeof record?.accepted?.node?.controllerSid !== 'string'
    || hash(canonical(plan))!==args.configSha256) fail('independent_controller_witness_invalid');
  const witness = { contract:'clued.independent-ci.controller-supervision/1',identity,
    nonce:args.nonce,configSha256:args.configSha256,plan:clone(plan),controllerSid:record.accepted.node.controllerSid };
  await journal.begin(controllerWitnessJournalKey(identity),witness);
  return witness;
}

export function observeIndependentControllerStop(identity, witness, bundle) {
  identity = validateIndependentPublicationIdentity(identity);
  if (witness?.contract !== 'clued.independent-ci.controller-supervision/1'
    || independentPublicationIdentityDigest(witness.identity)!==independentPublicationIdentityDigest(identity)
    || !/^[0-9a-f]{32}$/.test(witness.nonce??'')) fail('independent_controller_witness_invalid');
  const plan=parse(bundle?.planBytes),jobs=parse(bundle?.jobsBytes),request=parse(bundle?.requestBytes),receipt=parse(bundle?.receiptBytes),outcome=parse(bundle?.outcomeBytes);
  const response=validateBrokerResponse(parse(bundle?.responseBytes),bundle.requestId);
  validatePlanV2(plan);
  if (hash(bundle.planBytes)!==witness.configSha256 || canonical(plan)!==canonical(witness.plan)
    || hash(bundle.jobsBytes)!==plan.jobSha256 || !Array.isArray(jobs)
    || !jobs.some(j=>canonical(j)===canonical(identity.job))
    || request.contract!==BROKER_REQUEST_CONTRACT || request.stage!==plan.stage || request.nonce!==witness.nonce
    || request.configSha256!==witness.configSha256 || !response || !response.started || !response.startCallIssued
    || !response.helperPid || !response.stoppedInTime || !response.restored || !response.accountUnchanged
    || !response.stableBefore || !response.stableAfter || response.configurationConflict) fail('independent_controller_stop_unconfirmed');
  const checked=validateNativeReceiptV2(receipt,{nonce:witness.nonce,plan,planSha256:witness.configSha256,
    controllerSid:witness.controllerSid,helperPid:response.helperPid});
  const observed=validateOutcome(outcome,{nonce:witness.nonce,plan});
  if (checked.treeZero!==true || !observed || receipt.outcome_sha256!==hash(bundle.outcomeBytes)
    || !Array.isArray(observed.jobIds) || !observed.jobIds.includes(identity.job.id)) fail('independent_controller_stop_unconfirmed');
  // A hash of the actual protected observations, not a fabricated Canonical
  // Receipt UUID. The supervisor port must verify their filesystem authority.
  const evidence=hash(JSON.stringify(['independent-controller-stop/1',bundle.requestId,
    ...['planBytes','jobsBytes','requestBytes','responseBytes','receiptBytes','outcomeBytes'].map(k=>hash(bundle[k]))]));
  return Object.freeze({stopped:true,controller_id:identity.controller_id,job_id:identity.job.id,
    source:'qualified-controller-supervisor',proofRef:`sha256:${evidence}`});
}

export async function revokeIndependentPublications({scope,publications,native,github,journalFor,supervisor}) {
  if (!Array.isArray(publications) || publications.length>5000 || typeof journalFor!=='function'
    || typeof supervisor?.readProtectedStopBundle!=='function') fail('independent_revoker_ports_required');
  const result={reconciled:0,notSent:0,pending:[]};
  for(const publication of publications){
    if(publication.independent_identity==null)continue; // Other provider retains its own revoker.
    let publicationId=publication.publication_id;
    try{
      const identity=validateIndependentPublicationIdentity(publication.independent_identity);
      if(publication.run_id!==null || publication.repository!==identity.job.repo || publication.head_sha!==identity.job.headSha
        || publication.pr_ref!==`${identity.job.repo}#${identity.job.pr}` || publication.claim_id!==identity.claim.claim_id
        || publication.execution_epoch!==identity.claim.execution_epoch)fail('independent_revocation_subject_changed');
      const journal=await journalFor(identity),key=nativePublicationJournalKey(identity),record=await journal.read(key);
      if(!record || record.subject.scope!==scope || independentPublicationIdentityDigest(record.subject.identity)!==independentPublicationIdentityDigest(identity)
        || (record.details?.ticket && record.details.ticket.publication_id!==publicationId))fail('independent_ticket_journal_invalid');
      const witness=(await journal.read(controllerWitnessJournalKey(identity)))?.subject;
      const stopped=observeIndependentControllerStop(identity,witness,await supervisor.readProtectedStopBundle(clone(witness)));
      const inventory=async head=>{const r=await github.readChecks(head);
        if(r?.complete!==true||!Array.isArray(r.checks)||r.checks.length>10000||new Set(r.checks.map(c=>c?.id)).size!==r.checks.length
          ||r.checks.some(c=>!Number.isSafeInteger(c?.id)||c.id<1||c.head_sha!==head))fail('independent_check_inventory_unconfirmed');return r.checks;};
      const runtime=createIndependentPublicationRuntime({native,journal,assertCurrent:async()=>false,observeStopped:async()=>stopped,
        github:{createCheck:async()=>fail('independent_revoker_cannot_post'),readChecks:inventory,
          readCheck:async id=>(await inventory(identity.job.headSha)).find(c=>c.id===id),revokeCheck:(id,body)=>github.revokeCheck(id,body)}});
      if(record.state==='intent')await runtime.adoptOpenTicket(key,publication);
      const reconciled=await runtime.reconcileStopped(key);
      if(reconciled.status==='NOT_SENT')result.notSent++;else if(reconciled.status==='RECONCILED')result.reconciled++;
      else fail('independent_revocation_unconfirmed');
    }catch(error){result.pending.push({publicationId,reason:/^[a-z][a-z0-9_]{0,79}$/.test(error?.code??'')?error.code:'independent_revocation_unconfirmed'});}
  }
  // Outbox ACK requires a separate full-head legacy drain, not just these
  // tracked publications. This function deliberately cannot acknowledge it.
  return result;
}
