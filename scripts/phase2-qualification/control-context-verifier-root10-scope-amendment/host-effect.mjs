// Internal fixed port. The private same-process verified context is its only entry caller.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const python='/usr/bin/python3.11';
const bridge=fileURLToPath(new URL('./bridge.py',import.meta.url));
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
// libuv otherwise injects these Windows baseline variables from the parent. Explicit
// empty entries prevent that implicit inheritance; only four values are nonempty.
export const fixedBridgeEnvironment=Object.freeze({TEMP:'/tmp',TMP:'/tmp',HOME:'',PATH:'',SHELL:'',USER:'',LOGNAME:'',LANG:'',LC_ALL:'',PWD:'',TERM:'',XDG_RUNTIME_DIR:''});
export function invokeFixedHost({gaRaw,operation,containerId,deadline,temporal=null}){
 if(!['CREATE','START'].includes(operation)||!Number.isFinite(deadline)||Date.now()>=deadline)throw Error('FIXED_LIVE_HOST_OPERATION_REQUIRED');
 // Two byte checks, two messages. They shared one until R20-N2: a check can only be proven
 // live on its own if it has an error only it can raise, and with a single message the
 // self-test proved the bridge half while the python half went both unproven and unlisted.
 if(sha(fs.readFileSync(python))!=='f56a588548dd013906ae1dcd1b6faa417f4e204da634ff354840d9643e78ff9e')throw Error('EXACT_PYTHON_BYTES_REQUIRED');
 if(sha(fs.readFileSync(bridge))!=='48386a5447a7a0ac465213025918f54699e9c84d4c19933acffb6c03ebb9e170')throw Error('EXACT_PYTHON_BRIDGE_BYTES_REQUIRED');
 const ga=JSON.parse(gaRaw),nonce=sha('clued-fixed-host-v1\0'+ga.gate_authorization_id).slice(0,32);
 if(temporal!==null){
  const shape=Object.keys(temporal).sort().join(',');
  // Two accepted separate-authority shapes: the temporal continuation carries a
  // fixed effect deadline; the runtime-clock amendment carries an explicit
  // per-dispatch host window whose deadline bounds only the container's life.
  // The scope amendment narrows the applicable test set and carries that clock
  // forward verbatim, so it presents the second shape and is held to the same
  // 600000ms here. Telling the two amendments apart is parent600's job; this
  // check is about the window, and it is the same window either way.
  if(shape==='event,raw,sha256'){if(sha(temporal.raw)!==temporal.sha256||Date.parse(temporal.event?.request?.body?.effect_deadline)!==deadline)throw Error('EXACT_SEPARATE_TEMPORAL_HOST_INPUT');}
  else if(shape==='event,host_window,raw,sha256'){if(sha(temporal.raw)!==temporal.sha256||Date.parse(temporal.host_window?.deadline_utc)!==deadline||Date.parse(temporal.host_window?.deadline_utc)-Date.parse(temporal.host_window?.prepared_utc)!==600000)throw Error('EXACT_SEPARATE_RUNTIME_CLOCK_HOST_INPUT');}
  else throw Error('EXACT_SEPARATE_TEMPORAL_HOST_INPUT');
 }
 const request={operation,nonce,ga_raw:gaRaw,ga_sha256:sha(gaRaw),container_id:operation==='CREATE'?null:containerId,...(temporal===null?{}:{temporal_continuation:temporal})};
 const remaining=deadline-Date.now();if(remaining<=0)throw Error('HOST_DEADLINE_ELAPSED_DURING_SOURCE_CHECK');
 const raw=execFileSync(python,['-I','-S','-B','-X','utf8',bridge],{input:JSON.stringify(request)+'\n',encoding:'utf8',env:fixedBridgeEnvironment,timeout:remaining,maxBuffer:262144,windowsHide:true});
 const result=JSON.parse(raw);
 if(result.state!=='ACTUAL_FIXED_HOST_OBSERVATION_NOT_YET_REMOTE_RESULT'||result.operation!==operation||result.ga_sha256!==request.ga_sha256||!/^[a-f0-9]{64}$/.test(result.container_id)||result.observation?.Id!==result.container_id||result.observation?.Name!=='/clued-synthetic-'+nonce||result.qualified!==false||result.capacity_released!==false||result.remote_result_persisted!==false)throw Error('EXACT_ACTUAL_HOST_RESULT_REQUIRED');
 if(operation==='START'&&(result.container_id!==containerId||result.observation.State?.Running!==true))throw Error('EXACT_STARTED_CONTAINER_REQUIRED');
 if(operation==='CREATE'&&result.observation.State?.Running!==false)throw Error('CREATED_CONTAINER_MUST_BE_STOPPED');
 return result;
}
