// Outside-batch revocation maintenance. This bookkeeping never grants a
// Source qualification, clears HALT, consumes a CI head or reopens an unknown
// helper. Every attempt has its own durable intent/result in the receipt chain.
import { check, exactKeys, HEX64 } from './canonical.mjs';

export const REVOCATION_STAGE = 12;
export const REVOCATION_RUN_MS = 300_000;
export const REVOCATION_HELPER_MARGIN_MS = 180_000;
export const REVOCATION_FACTS_CONTRACT = 'clued.independent-ci.revocation-maintenance-facts/1';
export const REVOCATION_QUALIFICATION_CONTRACT = 'clued.independent-ci.revocation-maintenance-qualification/1';
export const REVOCATION_PENDING_STATE = 'REVOCATION_MAINTENANCE_PENDING_ORIGINAL_STOPPED_NO_QUALIFICATION';
export const REVOCATION_BACKOFF_MS = Object.freeze([60_000,120_000,240_000,480_000,900_000]);
export const REVOCATION_SUCCESS_INTERVAL_MS = 300_000;
export const REVOCATION_RUN_ID = /^[0-9a-f]{16}-[0-9a-f]{12}$/;
const REF = /^receipt:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/;

export function validateRevocationFacts(value) {
  exactKeys(value,['contract','pending','reconciled','notSent','acknowledged','complete'],'REVOCATION_FACTS_REFUSED');
  check(value.contract===REVOCATION_FACTS_CONTRACT && ['pending','reconciled','notSent','acknowledged'].every(k=>Number.isSafeInteger(value[k])&&value[k]>=0&&value[k]<=100000)
    &&typeof value.complete==='boolean'&&value.complete===(value.pending===0),'REVOCATION_FACTS_REFUSED');
  return Object.freeze({...value});
}

// The caller must obtain this block only through the installed Source's
// protected record reader. Matching JSON alone is not an execution grant.
export function validateRevocationQualification(value,{sourceManifestSha256,now,minimumRemainingMs=REVOCATION_RUN_MS+REVOCATION_HELPER_MARGIN_MS}) {
  exactKeys(value,['contract','qualificationRef','sourceManifestSha256','allowWhileHalted','validUntil'],'REVOCATION_QUALIFICATION_REFUSED');
  check(value.contract===REVOCATION_QUALIFICATION_CONTRACT&&REF.test(value.qualificationRef??'')&&HEX64.test(sourceManifestSha256??'')
    &&value.sourceManifestSha256===sourceManifestSha256&&typeof value.allowWhileHalted==='boolean'
    &&Number.isSafeInteger(now)&&now>0&&Number.isSafeInteger(minimumRemainingMs)&&minimumRemainingMs>=REVOCATION_RUN_MS
    &&(value.validUntil===null||typeof value.validUntil==='string'&&ISO.test(value.validUntil)
      &&Date.parse(value.validUntil)>now+minimumRemainingMs),'REVOCATION_QUALIFICATION_REFUSED');
  return Object.freeze({...value});
}

export class RevocationMaintenanceBook {
  constructor(){this.lastAt=null;this.nextAt=0;this.pendingLevel=0;this.blocked=false;this.lastRunId=null;}
  snapshot(){return {lastAt:this.lastAt,nextAt:this.nextAt,pendingLevel:this.pendingLevel,blocked:this.blocked,lastRunId:this.lastRunId};}
  restore(value){
    exactKeys(value,['lastAt','nextAt','pendingLevel','blocked','lastRunId'],'REVOCATION_BOOK_REFUSED');
    check(typeof value.blocked==='boolean'&&Number.isSafeInteger(value.pendingLevel)&&value.pendingLevel>=0&&value.pendingLevel<=REVOCATION_BACKOFF_MS.length
      &&(value.lastAt===null||Number.isSafeInteger(value.lastAt)&&value.lastAt>0)
      &&(value.lastRunId===null||REVOCATION_RUN_ID.test(value.lastRunId))
      &&(value.blocked?value.nextAt===null:Number.isSafeInteger(value.nextAt)&&value.nextAt>=0)
      &&(value.lastAt===null?value.lastRunId===null&&value.nextAt===0&&!value.blocked:value.lastRunId!==null
        &&(value.blocked||value.nextAt>value.lastAt)),'REVOCATION_BOOK_REFUSED');
    Object.assign(this,structuredClone(value));
  }
  due(now){return !this.blocked&&Number.isSafeInteger(now)&&now>0&&(this.lastAt===null||now>=this.lastAt)&&now>=this.nextAt;}
  observe({now,runId,pending=false,deferred=false,blocked=false}){
    check(Number.isSafeInteger(now)&&now>0&&(this.lastAt===null||now>=this.lastAt)&&REVOCATION_RUN_ID.test(runId)
      &&typeof pending==='boolean'&&typeof deferred==='boolean'&&typeof blocked==='boolean','REVOCATION_BOOK_REFUSED');
    this.lastAt=now;this.lastRunId=runId;this.blocked=blocked;
    this.pendingLevel=pending?Math.min(this.pendingLevel+1,REVOCATION_BACKOFF_MS.length):0;
    this.nextAt=blocked?null:now+(pending?REVOCATION_BACKOFF_MS[this.pendingLevel-1]:deferred?REVOCATION_BACKOFF_MS[0]:REVOCATION_SUCCESS_INTERVAL_MS);
    return this.snapshot();
  }
}
