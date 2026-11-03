import {performance} from 'node:perf_hooks';
// Mechanical absence wait, not an authority provider. Production passes only
// its closed fixed-path held reader; this helper cannot create a Root handle.
export async function waitOnlyEnoent218(read,{maxMs=120000,pollMs=100,now=()=>performance.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 if(typeof read!=='function'||!Number.isSafeInteger(maxMs)||maxMs<1||maxMs>120000||!Number.isSafeInteger(pollMs)||pollMs<1||pollMs>1000)throw Error('SELECTOR_WAIT_BOUND');
 const began=now();let reads=0;
 for(;;){
  if(++reads>1201)throw Error('SELECTOR_ABSENT_WAIT_LIMIT_NO_RETRY');
  const age=now()-began;if(!Number.isFinite(age)||age<0||age>maxMs)throw Error('SELECTOR_ABSENT_TIMEOUT_NO_LAUNCH');
  try{const value=read();const after=now()-began;if(!Number.isFinite(after)||after<0||after>maxMs)throw Error('SELECTOR_ABSENT_TIMEOUT_NO_LAUNCH');return value}catch(e){if(e===null||typeof e!=='object'||e.code!=='ENOENT')throw e;const elapsed=now()-began;if(!Number.isFinite(elapsed)||elapsed<0||elapsed>=maxMs)throw Error('SELECTOR_ABSENT_TIMEOUT_NO_LAUNCH');await sleep(Math.min(pollMs,maxMs-elapsed))}
 }
}
