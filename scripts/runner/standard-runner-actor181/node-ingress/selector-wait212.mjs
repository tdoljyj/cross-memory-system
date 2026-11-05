import {performance} from 'node:perf_hooks';
const WAIT_MS=120000,POLL_MS=200;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Mechanical file-presence wait only. It never creates authority, a process,
// a selector, an execution attempt, or a retry of a failed existing selector.
// The production noarg factory supplies its fixed local reader below; these
// optional clock seams exist solely for finite pure tests of the wait policy.
export async function waitForSelector212(readOnce,clock=()=>performance.now(),sleep=pause){
 if(typeof readOnce!=='function'||typeof clock!=='function'||typeof sleep!=='function')throw Error('SELECTOR_WAIT_INTERNAL_READER_REQUIRED');
 const start=clock();if(!Number.isFinite(start))throw Error('SELECTOR_MONOTONIC_CLOCK_REQUIRED');
 for(;;){
  const elapsed=clock()-start;if(!Number.isFinite(elapsed)||elapsed<0)throw Error('SELECTOR_MONOTONIC_CLOCK_REQUIRED');
  if(elapsed>WAIT_MS)throw Error('PHYSICAL_OWNER_PACKET_MISSING_NO_LAUNCH');
  try{const value=await readOnce();const after=clock()-start;if(!Number.isFinite(after)||after<0||after>WAIT_MS)throw Error('PHYSICAL_OWNER_PACKET_MISSING_NO_LAUNCH');return value}catch(error){
   // Do not convert parse/type/ACL/currentness/revocation/expiry errors into
   // missing-file waits. Only the genuine fixed-file fs ENOENT is transient.
   if(error?.code!=='ENOENT')throw error;
   const remaining=WAIT_MS-(clock()-start);if(!Number.isFinite(remaining)||remaining<=0)throw Error('PHYSICAL_OWNER_PACKET_MISSING_NO_LAUNCH');
   await sleep(Math.min(POLL_MS,remaining));
  }
 }
}
