import {resolveRootOwnedInstallation215} from './node_install_authority215.mjs';
import {captureOwnedInstall215,assertCapturedInstall215} from './install_spawn215.mjs';
import {need215,exact215} from './install_protocol215.mjs';
// Actual second stage, same already admitted heavy job. No qualifier dispatch,
// diagnostic scan, CI claim/admission mutation or caller flag is performed.
export async function runStandardRunnerInstallation215(){
 if(arguments.length!==0)throw Error('INSTALL_ARGUMENTS_REFUSED');
 const root=await resolveRootOwnedInstallation215();let owned=null,started=false;
 try{
  owned=captureOwnedInstall215(root.capability);assertCapturedInstall215(owned);
  const metadata=await owned.captured;await root.bindActualInstallSelf(owned,metadata);
  const authorized=await root.launchInstallOnce();owned.startOnce(authorized.plan,authorized.selector);started=true;
  const timeout=new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('INSTALL_OWNED_PROCESS_TIMEOUT_UNKNOWN_NO_RETRY')),360000);timer.unref()});
  const done=await Promise.race([owned.settled,timeout]);need215(done.exit_code===0&&done.signal===null&&done.result?.status==='SELF_INSTALLED_WORKER_OBSERVED_AWAITING_LIFECYCLE','INSTALL_NOT_PROVEN_PRESERVE_NO_RETRY');
  const proof=await root.reopenInstalledProof(done.result);
  return Object.freeze({schema:'clued.standard-runner-install-stage215/1',status:'SELF_INSTALLED_WORKER_INDEPENDENTLY_REOPENED',attempt_id:proof.attempt_id,worker_pid:proof.worker_pid,worker_instance_guid:proof.worker_instance_guid,registered_xml_sha256:proof.registered_xml_sha256,qualification_repeated:false,additional_scans:0,windows_lifecycle_qualified:false,natural_retirement_qualified:false,panel_qualified:false});
 }finally{if(owned&&!started)owned.closeBeforeStart();root.close()}
}
