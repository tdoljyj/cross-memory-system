const QUALIFIED='ACCOUNT_PROOF_OBSERVED_REQUIRES_FACTORY_RECONCILIATION';
const INSTALLED='SELF_INSTALLED_WORKER_INDEPENDENTLY_REOPENED';
// Internal orchestration seam, not an authority/provider/CLI. Each real stage
// still requires its own current exact Owner packet and OS-authenticated Root.
export async function runMaintenanceStages215(qualification,install){
 if(!qualification||qualification.status!==QUALIFIED||qualification.installation!==false||qualification.automatic_retry!==false||typeof qualification.proof_sha256!=='string'||!(/^[a-f0-9]{64}(?![\s\S])/).test(qualification.proof_sha256))return Object.freeze({schema:'clued.standard-runner-maintenance-pipeline215/1',status:'QUALIFICATION_NOT_PROVEN_NO_INSTALL',qualification,installation:null,automatic_retry:false});
 let result;
 try{result=await install();}catch{return Object.freeze({schema:'clued.standard-runner-maintenance-pipeline215/1',status:'QUALIFICATION_PROVEN_INSTALL_NOT_PROVEN_NO_RETRY',qualification,installation:null,automatic_retry:false});}
 if(result?.status!==INSTALLED||result.qualification_repeated!==false||result.additional_scans!==0)return Object.freeze({schema:'clued.standard-runner-maintenance-pipeline215/1',status:'QUALIFICATION_PROVEN_INSTALL_NOT_PROVEN_NO_RETRY',qualification,installation:result??null,automatic_retry:false});
 return Object.freeze({schema:'clued.standard-runner-maintenance-pipeline215/1',status:'ACCOUNT_QUALIFIED_AND_MAINTENANCE_INSTALLED_AWAITING_LIFECYCLE',qualification,installation:result,automatic_retry:false,windows_lifecycle_qualified:false,natural_retirement_qualified:false,panel_qualified:false});
}
