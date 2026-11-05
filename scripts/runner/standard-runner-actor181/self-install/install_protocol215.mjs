import {createHash} from 'node:crypto';
export const INSTALL_PURPOSE='standard_runner_self_s4u_maintenance_install_once';
export const INSTALL_ROLE='standard-runner-maintenance-install';
export const INSTALL_OWNER_PHASE='STANDARD_RUNNER_SELF_MAINTENANCE_INSTALL_ONCE';
export const INSTALL_PHASES=Object.freeze(['before-enroll','before-register','after-register','before-run','observe-worker']);
export const OBSERVER_PHASES=Object.freeze(['enrolled-before-register','registered-worker','before-initial-run-if-empty','actual-worker']);
export const hash215=b=>createHash('sha256').update(b).digest('hex');
export function need215(v,c){if(v!==true)throw Error(c)}
export function exact215(v,keys){need215(v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|'),'INSTALL_CLOSED_OBJECT')}
export function selfPipeAttempt215(attempt){need215(typeof attempt==='string'&&/^[a-f0-9]{32}(?![\s\S])/.test(attempt),'INSTALL_REAL_ACCEPTED_ATTEMPT');return hash215(Buffer.from('clued.install-self215/'+attempt)).slice(0,32)}
export function assertInstallPlan215(p){
 exact215(p,['schema','purpose','role','attempt_id','actor_packet_sha256','owner_receipt_id','source_acceptance_ref','component_version','component_sha256','row']);
 need215(p.schema==='clued.self-maintenance-install-plan211/1'&&p.purpose===INSTALL_PURPOSE&&p.role===INSTALL_ROLE&&p.component_version==='1.0.1'&&p.component_sha256==='cee184416d253fbdd42b47b6d21b1629c3703beacd4d918f75ae531926ae8a8a','INSTALL_EXACT_PURPOSE_ROLE');
 need215(typeof p.attempt_id==='string'&&/^[a-f0-9]{32}(?![\s\S])/.test(p.attempt_id)&&typeof p.actor_packet_sha256==='string'&&/^[a-f0-9]{64}(?![\s\S])/.test(p.actor_packet_sha256),'INSTALL_PLAN_ATTEMPT_PACKET');
 for(const k of ['owner_receipt_id','source_acceptance_ref'])need215(typeof p[k]==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?![\s\S])/.test(p[k]),'INSTALL_REAL_REFERENCE');
 exact215(p.row,['host','node_id','expected_sid','home','python','python_sha256','pythonw','pythonw_sha256','request_path','request_sha256','source','managed','task_name']);
 for(const k of Object.keys(p.row))need215(typeof p.row[k]==='string'&&p.row[k].length>0&&p.row[k].length<=512&&!/[\r\n\0]/.test(p.row[k]),'INSTALL_ROW_STRING');
 need215(p.row.request_path==='C:\\ProgramData\\CluedCacheInstallSelf211\\Control\\'+p.row.node_id+'\\request.json'&&p.row.task_name==='CluedCache-'+p.row.node_id,'INSTALL_FIXED_TARGET');return p;
}
