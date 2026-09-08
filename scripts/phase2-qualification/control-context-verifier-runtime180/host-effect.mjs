// Internal fixed port. The private same-process verified context is its only entry caller.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const python='C:/Users/Windows/AppData/Local/Programs/Python/Python312/python.exe';
const bridge=fileURLToPath(new URL('../preentry-parent/runtime-successor/host-tool-bridge/bridge.py',import.meta.url));
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
// libuv otherwise injects these Windows baseline variables from the parent. Explicit
// empty entries prevent that implicit inheritance; only four values are nonempty.
export const fixedBridgeEnvironment=Object.freeze({SystemRoot:'C:/Windows',WINDIR:'C:/Windows',TEMP:'C:/Users/Windows/AppData/Local/Temp',TMP:'C:/Users/Windows/AppData/Local/Temp',HOMEDRIVE:'',HOMEPATH:'',LOGONSERVER:'',PATH:'',SYSTEMDRIVE:'',USERDOMAIN:'',USERNAME:'',USERPROFILE:''});
export function invokeFixedHost({gaRaw,operation,containerId,deadline}){
 if(!['CREATE','START'].includes(operation)||!Number.isFinite(deadline)||Date.now()>=deadline)throw Error('FIXED_LIVE_HOST_OPERATION_REQUIRED');
 if(sha(fs.readFileSync(python))!=='4d6f5f81a4bca11191c4c7c6b43632694d0a4ce74e068619d8fdc161d469859a'||sha(fs.readFileSync(bridge))!=='11e64259e075481d3311ebd6db7378d2d52e9f8cf537775b39051b3478ad0a7c')throw Error('EXACT_PYTHON_BRIDGE_BYTES_REQUIRED');
 const ga=JSON.parse(gaRaw),nonce=sha('clued-fixed-host-v1\0'+ga.gate_authorization_id).slice(0,32);
 const request={operation,nonce,ga_raw:gaRaw,ga_sha256:sha(gaRaw),container_id:operation==='CREATE'?null:containerId};
 const remaining=deadline-Date.now();if(remaining<=0)throw Error('HOST_DEADLINE_ELAPSED_DURING_SOURCE_CHECK');
 const raw=execFileSync(python,['-I','-S','-B','-X','utf8',bridge],{input:JSON.stringify(request)+'\n',encoding:'utf8',env:fixedBridgeEnvironment,timeout:remaining,maxBuffer:262144,windowsHide:true});
 const result=JSON.parse(raw);
 if(result.state!=='ACTUAL_FIXED_HOST_OBSERVATION_NOT_YET_REMOTE_RESULT'||result.operation!==operation||result.ga_sha256!==request.ga_sha256||!/^[a-f0-9]{64}$/.test(result.container_id)||result.observation?.Id!==result.container_id||result.observation?.Name!=='/clued-synthetic-'+nonce||result.qualified!==false||result.capacity_released!==false||result.remote_result_persisted!==false)throw Error('EXACT_ACTUAL_HOST_RESULT_REQUIRED');
 if(operation==='START'&&(result.container_id!==containerId||result.observation.State?.Running!==true))throw Error('EXACT_STARTED_CONTAINER_REQUIRED');
 if(operation==='CREATE'&&result.observation.State?.Running!==false)throw Error('CREATED_CONTAINER_MUST_BE_STOPPED');
 return result;
}
