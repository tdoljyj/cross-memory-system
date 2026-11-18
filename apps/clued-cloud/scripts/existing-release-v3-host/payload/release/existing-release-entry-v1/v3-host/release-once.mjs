// Concrete original production command chain. Default disabled; no command input.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {BASE,APP,ROOT,RUN,SOURCE,CONNECT,WRANGLER,HASH,hash,fail,readContext,verifyPackage,safeEnv,exactMain,writeOnce,readSecret,verifyBuildFiles,protectedBytes,utf8,interopBoundary} from './host-files.mjs';
import {main as existingStage} from '../v3/existing-stages.mjs';
const SCOPE='existing-production-release-v3-host';
const PDF_CONFIG='apps/clued-cloud/wrangler.pdf-extractor.jsonc',PDF_RELEASE_CONFIG='.wrangler/pdf-extractor.release.json';
// wrangler 4 has no --no-build and always runs build.command, which would rebuild
// the root-protected dist. The same verified artifact is deployed through a
// derived copy of the pinned config: only "build" (and $schema) removed, "main"
// re-anchored from .wrangler/ to the same dist/pdf-extractor/index.js.
export function pdfReleaseConfig(c){
 const bytes=protectedBytes(path.join(SOURCE,PDF_CONFIG),65536);
 if(!HASH.test(c.sourcePins?.[PDF_CONFIG]??'')||hash(bytes)!==c.sourcePins[PDF_CONFIG])fail('PDF_CONFIG_PIN_REQUIRED');
 const cfg=JSON.parse(utf8(bytes));
 if(cfg.name!=='clued-storage-pdf'||cfg.main!=='./dist/pdf-extractor/index.js'||cfg.no_bundle!==true||Object.keys(cfg.build??{}).join('|')!=='command')fail('PDF_CONFIG_SHAPE_CHANGED');
 delete cfg.build;delete cfg.$schema;cfg.main='../dist/pdf-extractor/index.js';
 return Buffer.from(JSON.stringify(cfg,null,2)+'\n');
}
function ownReleaseConfig(){
 const file=path.join(APP,PDF_RELEASE_CONFIG),a=fs.lstatSync(file);
 if(!a.isFile()||a.isSymbolicLink()||a.nlink!==1||a.uid!==process.getuid()||(a.mode&0o777)!==0o600||a.size>65536)fail('PDF_RELEASE_CONFIG_BOUNDARY');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const held=fs.fstatSync(fd);if(held.dev!==a.dev||held.ino!==a.ino)fail('PDF_RELEASE_CONFIG_CHANGED');return fs.readFileSync(fd);}finally{fs.closeSync(fd);}
}
function writePdfReleaseConfig(c){
 const bytes=pdfReleaseConfig(c),dir=path.join(APP,'.wrangler'),s=fs.lstatSync(dir);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)fail('PDF_CONFIG_DIRECTORY_REQUIRED');
 const fd=fs.openSync(path.join(APP,PDF_RELEASE_CONFIG),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 writeOnce('pdf-release-config.json',{contract:'clued.existing-release-pdf-config/1',sourcePin:c.sourcePins[PDF_CONFIG],derivedSha256:hash(bytes),path:PDF_RELEASE_CONFIG,automaticRetryAllowed:false});
 return hash(bytes);
}
export async function main(argv=[]){
 if(argv.length===0)return {status:'DISABLED',code:'NO_HOST_READ'};
 if(argv.length!==7||argv[0]!=='--execute-once'||argv[1]!=='--fixed-scope'||argv[2]!==SCOPE||argv[3]!=='--reviewed-context-sha256'||!HASH.test(argv[4])||argv[5]!=='--reviewed-package-sha256'||!HASH.test(argv[6]))return {status:'BLOCKED',code:'FIXED_EXPLICIT_SCOPE_REQUIRED'};
 const contextSha=argv[4],packageSha=argv[6];let intent=false;
 try{
  // The fixed unit makes /run/WSL and /dev/shm inaccessible; stop before any
  // read, write or credential where either is reachable.
  interopBoundary();verifyPackage(packageSha);let c=readContext(contextSha);exactMain(c);const build=verifyBuildFiles(c);
  writeOnce('release-intent.json',{contract:'clued.existing-production-release-intent/1',contextSha256:contextSha,packageSha256:packageSha,sourceCommit:c.sourceCommit,build,startedAt:new Date().toISOString(),automaticRetryAllowed:false});intent=true;
  // Validate fixed credential presence/format before consuming the real Grant.
  const cloudflare=readSecret('cloudflare-deploy-token'),account=readSecret('cloudflare-account-id');
  if(!/^[a-f0-9]{32}$/.test(account))fail('ACTUAL_CLOUDFLARE_ACCOUNT_REQUIRED');
  // Derive before the Grant: a changed PDF config stops the chain before any use.
  const pdfConfigSha=writePdfReleaseConfig(c);
  const plain=()=>({...safeEnv(c),GITHUB_SHA:c.sourceCommit});
  // GITHUB_SHA is the actual required commit metadata of unchanged original
  // verification CLIs. No Actions/run/attempt/job identity is supplied.
  const cf=()=>({...plain(),CLOUDFLARE_API_TOKEN:cloudflare,CLOUDFLARE_ACCOUNT_ID:account});
  function run(name,args,{env=plain(),cwd=APP,timeout=600000}={}){
   c=readContext(contextSha);exactMain(c);verifyBuildFiles(c);
   writeOnce(name+'-intent.json',{argv:[c.node.path,...args],cwd,startedAt:new Date().toISOString(),automaticRetryAllowed:false});
   const r=spawnSync(c.node.path,args,{cwd,env,encoding:'utf8',maxBuffer:8*1024*1024,timeout,killSignal:'SIGTERM',windowsHide:true});
   writeOnce(name+'.stdout',r.stdout??'');writeOnce(name+'.stderr',r.stderr??'');
   const result={exitCode:r.status,signal:r.signal??null,error:r.error?.code??null,stdoutSha256:hash(r.stdout??''),stderrSha256:hash(r.stderr??'')};
   writeOnce(name+'-result.json',result);
   if(r.error||r.signal||!Number.isInteger(r.status))fail('COMMAND_TREE_OUTCOME_UNCONFIRMED');
   if(r.status!==0)fail('ORIGINAL_RELEASE_COMMAND_FAILED');
  }
  const grant=await existingStage(['--execute-once','--fixed-scope','existing-main-release-grant-and-currentness-v3','--stage','grant-before-deploy','--reviewed-context-sha256',contextSha]);
  writeOnce('release-grant-stage.json',grant);if(grant.status!=='GRANT_CONSUMED')return {status:'BLOCKED_OR_PENDING',grant,automaticRetryAllowed:false};
  const wr=SOURCE+'/'+WRANGLER;
  run('storage-queue-info',[wr,'queues','info','clued-storage-jobs'],{env:cf()});
  // Same accepted PDF artifact was already built without publisher credentials.
  // The derived config (no build hook) avoids writing the root-protected dist.
  if(hash(ownReleaseConfig())!==pdfConfigSha)fail('PDF_RELEASE_CONFIG_CHANGED');
  run('pdf-deploy',[wr,'deploy','--config',PDF_RELEASE_CONFIG],{env:cf()});
  run('main-deploy',[wr,'deploy','--config','wrangler.production.jsonc','--keep-vars'],{env:{...cf(),CLUED_ATTESTATION_DATABASE_URL:readSecret('attestation-database-url')}});
  const deployedAt=new Date().toISOString();writeOnce('deployment-time.json',{deployedAt,sourceCommit:c.sourceCommit});
  const current=await existingStage(['--execute-once','--fixed-scope','existing-main-release-grant-and-currentness-v3','--stage','currentness-after-deploy','--reviewed-context-sha256',contextSha]);
  writeOnce('release-currentness-stage.json',current);if(current.status!=='CURRENTNESS_ATTESTED')fail('REAL_CURRENTNESS_STAGE_NOT_ACCEPTED');
  run('served-contract',['scripts/verify-served-agent-contract.mjs','--evidence-out',RUN+'/served-agent-contract.json']);
  run('pdf-service',['scripts/verify-pdf-extractor.mjs','--evidence-out',RUN+'/pdf-extractor.json']);
  run('connect-deploy',[wr,'deploy',SOURCE+'/'+CONNECT,'--config','../kooyumi-connect/wrangler.production.jsonc','--no-bundle','--keep-vars'],{env:cf()});
  run('connect-postflight',['../kooyumi-connect/verify-production.mjs','--evidence-out',RUN+'/connect-postflight.json']);
  run('projection-postflight',['scripts/production-release-gate.mjs','--post-deploy','--evidence-out',RUN+'/production-postflight.json'],
   {env:{...plain(),CLUED_ATTESTATION_DATABASE_URL:readSecret('attestation-database-url')}});
  c=readContext(contextSha);exactMain(c);verifyBuildFiles(c);
  const result={status:'COMMAND_CHAIN_COMPLETED_AWAIT_HOST_CLEANUP',sourceCommit:c.sourceCommit,deployedAt,contextSha256:contextSha,packageSha256:packageSha,grantReceiptId:grant.receiptId,currentnessReceiptRef:current.receiptRef,systemdTerminalAndTreeCleanupObserved:false,productionAcceptanceClaimed:false,automaticRetryAllowed:false};
  writeOnce('commands-completed.json',result);return result;
 }catch(e){return {status:intent?'BLOCKED_OR_UNCERTAIN_NO_RETRY':'BLOCKED',code:/^[A-Z][A-Z0-9_]{1,90}$/.test(e?.code??'')?e.code:'EXISTING_RELEASE_UNCONFIRMED',automaticRetryAllowed:false};}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const result=await main(process.argv.slice(2));process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=['DISABLED','COMMAND_CHAIN_COMPLETED_AWAIT_HOST_CLEANUP'].includes(result.status)?0:2;}
