// Fixed stage12 controller. This is a negative-effect maintenance consumer:
// it cannot create a check, issue a publication or acknowledge the old Actions
// revoker's independent auto-merge/dispatch obligations.
import {EffectJournal} from '../../work/actions-hosted-migration/independent-ci-v1/src/effect-journal.mjs';
import {STATE_V2} from '../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/layout.mjs';
import {revocationQualification,REVOCATION_FACTS_CONTRACT} from '../../work/actions-hosted-migration/independent-ci-v1/src/resident-v2/revocation-run.mjs';
import {revokeIndependentPublications} from './clued-independent-revoker.mjs';
import {drainLegacyIndependentChecks} from './clued-independent-legacy-drain.mjs';
import {createWindowsIndependentSupervisor} from './clued-independent-supervisor.mjs';

export const COMPONENT_VERSION='1.0.0';
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const clone=value=>JSON.parse(JSON.stringify(value));
const mutating=new Set(['publication_reconcile','publication_abort_independent','independent_legacy_drain_finish']);
export async function readIndependentRevocationBatch(native,scope){
 const outboxes=new Map(),publications=new Map();let outboxCursor,publicationCursor;
 for(let page=0;page<50;page++){
  const reply=await native.command({action:'revocations_list',scope,...(outboxCursor?{outbox_cursor:outboxCursor}:{}),...(publicationCursor?{publication_cursor:publicationCursor}:{})});
  if(reply?.status!=='ok'||!Array.isArray(reply.revocations)||!Array.isArray(reply.publications)||reply.revocations.length>100||reply.publications.length>100
   ||!Object.hasOwn(reply,'next_outbox_cursor')||!Object.hasOwn(reply,'next_publication_cursor'))fail('independent_revocation_page_unconfirmed');
  for(const [items,map,key] of [[reply.revocations,outboxes,'outbox_id'],[reply.publications,publications,'publication_id']]){
   for(const item of items){if(!UUID.test(item?.[key]??''))fail('independent_revocation_page_unconfirmed');
    if(map.has(item[key])&&JSON.stringify(map.get(item[key]))!==JSON.stringify(item))fail('independent_revocation_page_changed');map.set(item[key],item);}
  }
  const nextOutbox=reply.next_outbox_cursor,nextPublication=reply.next_publication_cursor;
  for(const [next,previous] of [[nextOutbox,outboxCursor],[nextPublication,publicationCursor]]){
   if(next!==null&&(!UUID.test(next??'')||(previous&&next<=previous)))fail('independent_revocation_cursor_unconfirmed');
  }
  if(nextOutbox===null&&nextPublication===null)return {revocations:[...outboxes.values()],publications:[...publications.values()]};
  outboxCursor=nextOutbox??outboxCursor;publicationCursor=nextPublication??publicationCursor;
 }
 fail('independent_revocation_page_limit');
}

// Pure orchestration over qualified ports, also used by local integration
// tests. The production adapter below supplies the fixed protected ports.
export async function runIndependentRevocationWithPorts({record,native,github,journalFor,supervisor,live=()=>{}}){
 let sideEffects=0,reconciled=0,notSent=0,pending=0;
 const facts=()=>({contract:REVOCATION_FACTS_CONTRACT,pending,reconciled,notSent,acknowledged:0,complete:pending===0});
 const trackedNative={async command(input){
  live();if(input.scope!==record.config.scope)fail('independent_revocation_scope_changed');
  if(!['revocations_list','independent_revocation_heads',...mutating].includes(input.action))fail('independent_revocation_action_refused');
  // Count a possibly committed command before awaiting its response. A lost
  // reply must not become a false zero-side-effect report.
  const effect=mutating.has(input.action);if(effect)sideEffects++;
  const reply=await native.command(input);if(!['ok','committed'].includes(reply?.status))fail('independent_revocation_command_refused');
  if(effect&&reply.replayed===true)sideEffects--;return reply;
 }};
 const trackedGithub={};
 for(const key of ['readChecks','readPullRequest','readPullRequestCommits'])trackedGithub[key]=(...args)=>github[key](...args);
 trackedGithub.revokeCheck=async(...args)=>{live();sideEffects++;return github.revokeCheck(...args);};
 try{
  const initial=await readIndependentRevocationBatch(trackedNative,record.config.scope);
  const result=await revokeIndependentPublications({scope:record.config.scope,publications:initial.publications,native:trackedNative,github:trackedGithub,journalFor,supervisor});
  reconciled=result.reconciled;notSent=result.notSent;pending+=result.pending.length;
  for(const revocation of initial.revocations){
   if(revocation.repository!==record.config.repository)continue;
   const nativeHeads={read:item=>trackedNative.command({action:'independent_revocation_heads',scope:record.config.scope,
    outbox_id:item.outbox_id,execution_epoch:item.execution_epoch})};
   const drained=await drainLegacyIndependentChecks({scope:record.config.scope,revocation,github:trackedGithub,nativeHeads,supervisor});
   if(drained.status!=='DRAINED'||!Array.isArray(drained.stopProofRefs)||!drained.stopProofRefs.length){pending++;continue;}
   await trackedNative.command({action:'independent_legacy_drain_finish',scope:record.config.scope,outbox_id:revocation.outbox_id,
    execution_epoch:revocation.execution_epoch,source_manifest_sha256:record.config.sourceManifestSha256,
    evidence:{heads:drained.heads,revoked_check_ids:drained.revokedCheckIds,stop_proof_refs:drained.stopProofRefs}});
  }
  const after=await readIndependentRevocationBatch(trackedNative,record.config.scope);
  // Original App516 remains responsible for auto-merge and Actions revocation,
  // and its ACK now waits for our Receipt. Until it ACKs, this is still pending.
  pending=Math.max(pending,after.publications.filter(p=>p.repository===record.config.repository).length
   +after.revocations.filter(o=>o.repository===record.config.repository).length);
  return {status:pending?'PENDING':'REVOCATION_MAINTENANCE',sideEffects,revocation:facts()};
 }catch{
  pending=Math.max(1,pending);
  // All reachable writes are identity-bound negative effects or idempotent
  // Native reconciliation. A physically clean helper may safely retry them;
  // no createCheck or publication-begin path is present here.
  return {status:'PENDING',reason:'INDEPENDENT_REVOCATION_PENDING',sideEffects,revocation:facts()};
 }
}

export async function runIndependentRevocationMaintenance({record,ports,live,invocation}){
 if(!revocationQualification(record,{reserveMs:300000})||!invocation||invocation.plan?.stage!==12){
  return {status:'BLOCKED',reason:'REVOCATION_QUALIFICATION_REQUIRED',sideEffects:0,
   revocation:{contract:REVOCATION_FACTS_CONTRACT,pending:1,reconciled:0,notSent:0,acknowledged:0,complete:false}};
 }
 const windows=createWindowsIndependentSupervisor({controllerSid:record.accepted.node.controllerSid,nodeId:record.accepted.node.hostname});
 const assertWindow=async()=>{
  live();if(!revocationQualification(record))fail('independent_revocation_qualification_expired');
  const observed=await windows.assertMaintenanceWindow({nonce:invocation.nonce,configSha256:invocation.configSha256,stage:12,
   controllerSid:record.accepted.node.controllerSid,nodeId:record.accepted.node.hostname,runnerService:record.accepted.node.runnerService,nodePid:process.pid});
  if(observed?.sourceManifestSha256!==record.config.sourceManifestSha256)fail('independent_revocation_source_changed');
  return true;
 };
 const supervisor={readProtectedStopBundle:witness=>windows.readProtectedStopBundle(witness),
  async withLegacyDrainWindow(subject,callback){
   await assertWindow();
   const current=async()=>{
    await assertWindow();
    const reply=await ports.native.command({action:'independent_revocation_heads',scope:record.config.scope,
     outbox_id:subject.outboxId,execution_epoch:subject.beforeExecutionEpoch});
    if(!ports.bindingId||reply?.status!=='ok'||reply.claimId!==subject.claimId||reply.ciPrincipalBindingId!==ports.bindingId
     ||reply.consumerSourceManifestSha256!==record.config.sourceManifestSha256
     ||reply.consumerCiPrincipalBindingId!==ports.bindingId)fail('independent_revocation_principal_changed');
    return true;
   };
   await current();return callback({assertCurrent:current,readControllerStopBundles:()=>windows.readLegacyControllerStopBundles({
     repository:subject.repository,heads:[...subject.heads],claimId:subject.claimId,beforeExecutionEpoch:subject.beforeExecutionEpoch})});
  }};
 const journals=new Map();
 const journalFor=async identity=>{
  const directory=identity.job.role==='work-admission'?STATE_V2.effectsWorkAdmission:
   identity.job.role.startsWith('control-')?STATE_V2.effectsControl:STATE_V2.effectsScan;
  if(!journals.has(directory))journals.set(directory,await EffectJournal.open(directory));return journals.get(directory);
 };
 await assertWindow();
 return runIndependentRevocationWithPorts({record,native:ports.native,github:ports.github,journalFor,supervisor,live});
}
