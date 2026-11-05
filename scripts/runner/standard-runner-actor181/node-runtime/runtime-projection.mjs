export const NODE_RUNTIME_SOURCE_SHA256='a4ee0b66382d693ce3fc0bc7cf0e007ed36b9902fda12f2bed6bbdadffe808bc';
// Converts direct kernel observation only. Validation does not grant authority.
export function projectNodeRuntime211(o){
 const expected=['process_id','creation_file_time','sid','image','host','elevated','thread_impersonation','enabled_or_deny_only_admin_sid','primary_token_observed','thread_count','token_id'];
 if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).sort().join('|')!==expected.sort().join('|'))throw Error('NODE_RUNTIME_CLOSED_FIELDS');
 if(o.process_id!==process.pid||typeof o.image!=='string'||o.image.toLowerCase()!==process.execPath.toLowerCase()||typeof o.creation_file_time!=='string'||!/^[1-9][0-9]{0,19}$/.test(o.creation_file_time)||typeof o.sid!=='string'||!/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/.test(o.sid)||typeof o.host!=='string'||!/^[A-Z0-9][A-Z0-9-]{0,62}$/.test(o.host)||!Number.isInteger(o.thread_count)||o.thread_count<1||o.thread_count>1024||typeof o.token_id!=='string'||!/^[a-f0-9]{16}$/.test(o.token_id))throw Error('NODE_RUNTIME_IDENTITY_REFUSED');
 if(o.elevated!==false||o.thread_impersonation!==false||o.enabled_or_deny_only_admin_sid!==false||o.primary_token_observed!==true||Number(process.versions.node.split('.')[0])!==24)throw Error('NODE_RUNTIME_STANDARD_PRIMARY_REQUIRED');
 return Object.freeze({schema:'clued.standard-runner-own-primary-runtime/1',host:o.host,sid:o.sid,process_id:o.process_id,creation_file_time:o.creation_file_time,elevated:false,thread_impersonation:false,enabled_or_deny_only_admin_sid:false,primary_token_observed:true,node_major:24,source_capture_sha256:NODE_RUNTIME_SOURCE_SHA256});
}
