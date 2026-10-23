// Disabled Source candidate. Concrete existing release door and G6 postflight;
// no authorizeCurrentness service, generic publisher or fabricated Actions run.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const FIXED_SCOPE='existing-main-release-grant-and-currentness-v3';
const CONTEXT='/etc/clued-production-release/existing-release.json';
const SECRETS='/etc/clued-production-release/secrets';
const RUN='/var/lib/clued-production-release/run';
const REPOSITORY='tdoljyj/cross-memory-system';
const G6_SOURCE='apps/clued-cloud/supabase/migrations/20260922094719_bug_20260922_002_g6_full_gate.sql';
const G6_SIGNATURE='public.clued_mcp_currentness_g6_gate(text,jsonb)';
const CONSUMER_HEALTH_URL='https://clued.pixelgrav.com/healthz';
const PINNED=Object.freeze({
 'apps/clued-cloud/scripts/verify-currentness-transport.mjs':'f5c59bdcd09834aa88f466879a072e30318d799ad8ab65c1c4e6337396a5a54a',
 'apps/clued-cloud/scripts/production-release-gate.mjs':'3bb019ba9f842589e782b89b0c4c10ffb4875c78198b9eea83f53f8cd6303f89',
 'scripts/ci/clued-release-grant.mjs':'55b587d4e052b0281ce346c68ce1e4fc2c4f74d06287f0af1fa76481ca18c52e',
});
const EXTERNAL=new URL('../../verify-currentness-external.mjs',import.meta.url);
const MANAGER=new URL('../../linux-process-manager.mjs',import.meta.url);
const PORTS=new URL('../fixed-currentness-ports.mjs',import.meta.url);
const LOCAL_PINS=new Map([
 [EXTERNAL,'4bb88785021b73783bfe2b37972be11806f2c3b564ced8785dfbda25405106cd'],
 [MANAGER,'b961dfc06794336f38f47d4f8f5d7c6a2724aee6ba5bac4ff69090ef30842f70'],
 [PORTS,'93f95698f359c94585053d4331ae855bc07004245b4429ecaf6470aa40c25f3f'],
]);
const HASH=/^[a-f0-9]{64}$/,SHA=/^[a-f0-9]{40}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash=b=>createHash('sha256').update(b).digest('hex');
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const sameJson=(a,b)=>hash(JSON.stringify(canonical(a)))===hash(JSON.stringify(canonical(b)));
const fail=code=>{throw Object.assign(new Error(code),{code});};
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
function protectedParents(file){
 for(let p=path.dirname(file);;p=path.dirname(p)){
  const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))fail('ROOT_PROTECTED_PARENT_REQUIRED');if(p==='/')break;
 }
}
function rootBytes(file,maximum=1048576,secret=false){
 protectedParents(file);const first=fs.lstatSync(file);
 if(!first.isFile()||first.isSymbolicLink()||first.nlink!==1||first.uid!==0||(first.mode&0o022)||first.size<1||first.size>maximum||secret&&((first.mode&0o777)!==0o440||first.gid!==process.getgid()))fail('PROTECTED_SOURCE_OR_CREDENTIAL_REQUIRED');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const held=fs.fstatSync(fd),bytes=fs.readFileSync(fd);if(!same(first,held)||bytes.length!==first.size||!same(held,fs.lstatSync(file)))fail('PROTECTED_FILE_CHANGED');return bytes;}finally{fs.closeSync(fd);}
}
function text(bytes){const value=bytes.toString('utf8');if(!Buffer.from(value).equals(bytes))fail('STRICT_UTF8_REQUIRED');return value;}
function secret(leaf){const v=text(rootBytes(path.join(SECRETS,leaf),8192,true));if(v!==v.trim()||/[\r\n\x00]/.test(v))fail('FIXED_CREDENTIAL_FORMAT');return v;}
function privateRun(){protectedParents(RUN);const s=fs.lstatSync(RUN);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o777)!==0o700)fail('PRIVATE_RUN_DIRECTORY_REQUIRED');return s;}
function writeOnce(leaf,value){
 const before=privateRun(),bytes=Buffer.from(JSON.stringify(value)+'\n'),directory=fs.openSync(RUN,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);let fd;
 try{if(!same(before,fs.fstatSync(directory)))fail('RUN_DIRECTORY_CHANGED');fd=fs.openSync(path.join(RUN,leaf),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);if(!same(before,privateRun()))fail('RUN_DIRECTORY_CHANGED');fs.fsyncSync(directory);}
 finally{if(fd!==undefined)fs.closeSync(fd);fs.closeSync(directory);}
}
function readGrant(c,contextSha){
 privateRun();const file=path.join(RUN,'grant-use.json'),s=fs.lstatSync(file);
 if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size>65536)fail('SAME_RELEASE_GRANT_RECEIPT_REQUIRED');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let r;
 try{if(!same(s,fs.fstatSync(fd)))fail('GRANT_RECEIPT_CHANGED');r=JSON.parse(text(fs.readFileSync(fd)));if(!same(s,fs.lstatSync(file)))fail('GRANT_RECEIPT_CHANGED');}finally{fs.closeSync(fd);}
 if(r.contract!=='clued.existing-release-grant-use/1'||r.contextSha256!==contextSha||r.sourceCommit!==c.sourceCommit||r.action!=='release.production'||r.resource!==`repo:${REPOSITORY}/${c.sourceCommit}`||!UUID.test(r.grantId)||!UUID.test(r.receiptId)||!Number.isSafeInteger(r.use)||r.use<1||Date.parse(r.consumedAt)<Date.parse(c.acceptedAt)||Date.parse(r.consumedAt)>Date.now())fail('SAME_RELEASE_GRANT_RECEIPT_REQUIRED');return r;
}
function loadContext(expected){
 if(process.platform!=='linux'||!Number.isSafeInteger(process.getuid?.())||process.getuid()<1||!Number.isSafeInteger(process.getgid?.())||process.getgid()<1)fail('DEDICATED_LINUX_PUBLISHER_REQUIRED');
 if(!HASH.test(expected??''))fail('REVIEWED_CONTEXT_SHA_REQUIRED');const bytes=rootBytes(CONTEXT,1024*1024);if(hash(bytes)!==expected)fail('REVIEWED_CONTEXT_CHANGED');const c=JSON.parse(text(bytes));
 if(!exact(c,['contract','repository','sourceCommit','sourceRoot','publisherUid','publisherGid','acceptedAt','expiresAt','node','git','managerConfigSha256','sourcePins'])||c.contract!=='clued.existing-release-context/2'||c.repository!==REPOSITORY||!SHA.test(c.sourceCommit)||c.publisherUid!==process.getuid()||c.publisherGid!==process.getgid()||!path.isAbsolute(c.sourceRoot)||path.normalize(c.sourceRoot)!==c.sourceRoot||!HASH.test(c.managerConfigSha256))fail('FIXED_REVIEWED_RELEASE_CONTEXT_REQUIRED');
 const a=Date.parse(c.acceptedAt),e=Date.parse(c.expiresAt);if(!Number.isFinite(a)||!Number.isFinite(e)||a>Date.now()||e<=Date.now()||e-a>7200000)fail('REVIEWED_RELEASE_WINDOW_EXPIRED');
 if(!exact(c.node,['path','sha256'])||!exact(c.git,['path','sha256'])||c.node.path!==process.execPath||![c.node,c.git].every(x=>path.isAbsolute(x.path)&&HASH.test(x.sha256)))fail('REVIEWED_RUNTIME_REQUIRED');
 if(hash(rootBytes(c.node.path,128*1024*1024))!==c.node.sha256||hash(rootBytes(c.git.path,32*1024*1024))!==c.git.sha256)fail('REVIEWED_RUNTIME_CHANGED');
 if(!c.sourcePins||typeof c.sourcePins!=='object'||Array.isArray(c.sourcePins))fail('ACCEPTED_SOURCE_CLOSURE_REQUIRED');
 for(const [relative,pin] of Object.entries(c.sourcePins)){
  if(!/^[A-Za-z0-9_./-]+$/.test(relative)||relative.startsWith('/')||relative.split('/').some(p=>!p||p==='.'||p==='..')||!HASH.test(pin)||hash(rootBytes(path.join(c.sourceRoot,relative),128*1024*1024))!==pin)fail('ACCEPTED_SOURCE_CHANGED');
 }
 for(const [relative,pin] of Object.entries(PINNED))if(c.sourcePins[relative]!==pin)fail('ORIGINAL_RELEASE_SOURCE_PIN_REQUIRED');
 for(const relative of [G6_SOURCE,'apps/clued-cloud/scripts/currentness-live-build.mjs','apps/clued-cloud/app/supabase-public-config.ts','scripts/ci/clued-work-admission.mjs'])if(!HASH.test(c.sourcePins[relative]??''))fail('EXISTING_DEPENDENCY_SOURCE_REQUIRED');
 for(const [url,pin] of LOCAL_PINS)if(hash(rootBytes(fileURLToPath(url),128*1024*1024))!==pin)fail('EXISTING_HELPER_SOURCE_CHANGED');
 return c;
}
function safeEnv(c){return {PATH:path.dirname(c.node.path)+':'+path.dirname(c.git.path)+':/usr/bin:/bin',HOME:'/nonexistent',LANG:'C',LC_ALL:'C',NODE_OPTIONS:'',NODE_PATH:''};}
function localGit(c,args){const r=spawnSync(c.git.path,args,{cwd:c.sourceRoot,env:safeEnv(c),encoding:'utf8',maxBuffer:65536});if(r.error||r.status!==0)fail('EXACT_MAIN_READ_FAILED');return r.stdout.trim();}
function exactMain(c){if(localGit(c,['rev-parse','HEAD'])!==c.sourceCommit||localGit(c,['branch','--show-current'])!=='main'||localGit(c,['status','--porcelain','--untracked-files=all']))fail('REAL_CLEAN_REVIEWED_MAIN_REQUIRED');}
async function grantBeforeDeploy(c,contextSha){
 exactMain(c);writeOnce('grant-intent.json',{contract:'clued.existing-release-grant-intent/1',contextSha256:contextSha,sourceCommit:c.sourceCommit,startedAt:new Date().toISOString(),automaticRetryAllowed:false});
 const app=path.join(c.sourceRoot,'apps/clued-cloud');
 // Unchanged gate already has a truthful non-GHA clean-main branch. Its own
 // ledger/DB/projection/heartbeat checks remain actual read-only observations.
 const preflight=spawnSync(c.node.path,['scripts/production-release-gate.mjs','--pre-deploy'],{cwd:app,env:{...safeEnv(c),CLUED_ATTESTATION_DATABASE_URL:secret('attestation-database-url')},encoding:'utf8',maxBuffer:8*1024*1024});
 if(preflight.error||preflight.status!==0)fail('ORIGINAL_PRODUCTION_PREFLIGHT_FAILED');loadContext(contextSha);exactMain(c);
 const {checkGrant}=await import(pathToFileURL(path.join(c.sourceRoot,'scripts/ci/clued-release-grant.mjs')).href);
 // These are private arguments to the unchanged helper's metadata API. They
 // describe actual Git metadata; no GITHUB_ACTIONS/run/job identity is set.
 const env={GITHUB_REPOSITORY:REPOSITORY,GITHUB_SHA:c.sourceCommit,GITHUB_WORKSPACE:c.sourceRoot,CLUED_RELEASE_TOKEN:secret('release-door.token'),CLUED_RELEASE_GRANT_ENFORCE:'true'};
 const result=await checkGrant({env,mode:'deploy',workspace:c.sourceRoot,fetchImpl:globalThis.fetch});
 // Preserve the actual possibly consumed result before post-await revalidation.
 // Intent and result are CreateNew, so a failure cannot trigger an automatic retry.
 writeOnce('grant-result.json',{contract:'clued.existing-release-grant-result/1',contextSha256:contextSha,sourceCommit:c.sourceCommit,observedAt:new Date().toISOString(),result,automaticRetryAllowed:false});
 const refreshed=loadContext(contextSha);exactMain(refreshed);
 if(result.consumed===false&&result.error===null&&UUID.test(result.request_id??'')&&typeof result.confirm_url==='string'&&/^https:\/\/kooyumi\.pixelgrav\.com\/confirm\/[a-f0-9-]{36}$/.test(result.confirm_url))return {status:'OWNER_GRANT_REQUIRED',sourceCommit:c.sourceCommit,requestId:result.request_id,confirmUrl:result.confirm_url,automaticRetryAllowed:false};
 if(result.consumed!==true||result.action!=='release.production'||result.resources?.length!==1||result.resources[0]!==`repo:${REPOSITORY}/${c.sourceCommit}`||!UUID.test(result.grant?.grant_id??'')||!UUID.test(result.grant?.receipt_id??'')||!Number.isSafeInteger(result.grant.use))fail('REAL_EXACT_COMMIT_RELEASE_GRANT_NOT_CONSUMED');
 const receipt={contract:'clued.existing-release-grant-use/1',contextSha256:contextSha,sourceCommit:c.sourceCommit,action:'release.production',resource:result.resources[0],grantId:result.grant.grant_id,receiptId:result.grant.receipt_id,use:result.grant.use,consumedAt:new Date().toISOString(),automaticRetryAllowed:false};writeOnce('grant-use.json',receipt);return {status:'GRANT_CONSUMED',receiptId:receipt.receiptId,sourceCommit:c.sourceCommit};
}
// Specific original consumer block, never caller SQL or a replacement gate.
export function originalG6AllPathCondition(definition){
 if(typeof definition!=='string'||definition.length>1024*1024)fail('G6_CONSUMER_DEFINITION_REQUIRED');
 const normalized=definition.replace(/\r\n/g,'\n');
 const marker='  -- DB-level write enforcement cannot be bypassed by a retired RPC alias.\n';
 const start=normalized.indexOf(marker);
 if(start<0||normalized.indexOf(marker,start+marker.length)>=0)fail('G6_CONSUMER_BLOCK_NOT_UNIQUE');
 const tail=normalized.slice(start+marker.length);
 const action="    v_missing:=v_missing||'\"all_path_checkpoint_enforcement\"'::jsonb;";
 const end=tail.indexOf(action);
 if(end<0)fail('G6_CONSUMER_BLOCK_REQUIRED');
 const match=/^  if ([\s\S]+) then\n$/.exec(tail.slice(0,end));
 if(!match||!tail.slice(end).startsWith(action+'\n  end if;'))fail('G6_CONSUMER_BLOCK_REQUIRED');
 const condition=match[1],parameter="p_input->>'__transport_source_commit'";
 if(condition.split(parameter).length!==2||/[;$]|\bp_input\b/.test(condition.replace(parameter,'')))fail('G6_CONSUMER_PARAMETER_NOT_FIXED');
 return condition;
}
async function requireActualG6AllPathAcceptance(client,c){
 const expected=originalG6AllPathCondition(text(rootBytes(path.join(c.sourceRoot,G6_SOURCE),1024*1024)));
 const deployed=await client.query('select pg_catalog.pg_get_functiondef($1::regprocedure) as definition',[G6_SIGNATURE]);
 if(deployed.rows?.length!==1||originalG6AllPathCondition(deployed.rows[0].definition)!==expected)fail('DEPLOYED_G6_CONSUMER_SOURCE_CHANGED');
 // Execute the deployed, reviewed condition itself: trigger, retired RPC ACLs,
 // 24h age, exact commit and every evidence predicate. Bind its sole p_input.
 const condition=expected.replace("p_input->>'__transport_source_commit'",'$1::text');
 const r=await client.query('select not ('+condition+') as all_path_checkpoint_enforcement',[c.sourceCommit]);
 if(r.rows?.length!==1||r.rows[0].all_path_checkpoint_enforcement!==true)fail('ACTUAL_G6_CONSUMER_REJECTED_ATTESTATION');
 return {functionSignature:G6_SIGNATURE,definitionSha256:hash(deployed.rows[0].definition),conditionSha256:hash(expected),allPathCheckpointEnforcement:true,projectG6ClosureClaimed:false};
}
async function observeConsumerHealth(live,expected){
 // Original strict verifier/retry, reading the fixed consumer endpoint itself.
 return live.waitForLiveSourceCommit(expected,{fetchLive:(requested,options)=>{
  if(requested!==live.PRODUCTION_HEALTH_URL)fail('ORIGINAL_LIVE_REQUEST_CHANGED');
  return globalThis.fetch(CONSUMER_HEALTH_URL,options);
 }});
}
async function currentnessAfterDeploy(c,contextSha){
 exactMain(c);const grant=readGrant(c,contextSha);writeOnce('currentness-intent.json',{contract:'clued.existing-currentness-intent/1',contextSha256:contextSha,sourceCommit:c.sourceCommit,grantReceiptId:grant.receiptId,automaticRetryAllowed:false});
 const {boundedProcess,readOriginalTestFiles,requireCompleteTap}=await import(EXTERNAL.href);
 const {createLinuxProcessManager}=await import(MANAGER.href);
 const {retainExistingCurrentnessEvidence,connectExistingAttestation}=await import(PORTS.href);
 const managerPath='/etc/clued/currentness-manager.json',managerBytes=rootBytes(managerPath),managerConfig=JSON.parse(text(managerBytes));
 if(hash(managerBytes)!==c.managerConfigSha256||managerConfig.uid!==c.publisherUid||managerConfig.source_root!==c.sourceRoot||managerConfig.source_commit!==c.sourceCommit||managerConfig.node?.path!==c.node.path||managerConfig.node?.sha256!==c.node.sha256||managerConfig.git?.path!==c.git.path||managerConfig.git?.sha256!==c.git.sha256)fail('SAME_SOURCE_MANAGER_CONTEXT_REQUIRED');
 const manager=createLinuxProcessManager({configPath:managerPath,configSha256:c.managerConfigSha256});
 const tests=readOriginalTestFiles(rootBytes(path.join(c.sourceRoot,'apps/clued-cloud/scripts/verify-currentness-transport.mjs'),65536));
 const live=await import(pathToFileURL(path.join(c.sourceRoot,'apps/clued-cloud/scripts/currentness-live-build.mjs')).href);
 if(live.PRODUCTION_HEALTH_URL!=='https://kooyumi.pixelgrav.com/healthz'||typeof live.waitForLiveSourceCommit!=='function')fail('ORIGINAL_LIVE_VERIFIER_REQUIRED');
 await live.waitForLiveSourceCommit(c.sourceCommit);await observeConsumerHealth(live,c.sourceCommit);
 const args=['--test','--test-force-exit','--test-reporter=tap',...tests];
 const run=await boundedProcess(c.node.path,args,{manager,domain:'production',cwd:path.join(c.sourceRoot,'apps/clued-cloud'),env:safeEnv(c),timeoutMs:2700000,maxBytes:64*1024*1024});
 if(run.exitCode!==0||run.exitSignal)fail('ORIGINAL_NINETEEN_TESTS_FAILED');const terminal=requireCompleteTap(run.stdout);
 await live.waitForLiveSourceCommit(c.sourceCommit);await observeConsumerHealth(live,c.sourceCommit);loadContext(contextSha);exactMain(c);
 const output=`${run.stdout||''}\n${run.stderr||''}`,digest=hash(JSON.stringify({commit:c.sourceCommit,dirty:false,test_files:tests,output}));
 const identity={hostname:os.hostname(),principal_uid:process.getuid(),context_sha256:contextSha,grant_receipt_ref:grant.receiptId,execution_ref:randomUUID()};
 const evidence={source_commit:c.sourceCommit,source_worktree_dirty:false,verification_context:'production_post_deploy',deployed_commit:c.sourceCommit,live_health_url:CONSUMER_HEALTH_URL,additional_observed_live_health_urls:[live.PRODUCTION_HEALTH_URL],test_digest:digest,verification_status:'passed',test_files:tests,test_command:[c.node.path,...args],test_terminal:terminal,ci_run:null,execution_provider:'independent-publisher',execution_identity:identity,checked_at:new Date().toISOString()};
 const retained=await retainExistingCurrentnessEvidence(evidence,{exclusive:true,domain:'production'});
 if(retained.status!=='RETAINED'||retained.evidence_sha256!==hash(JSON.stringify(evidence)))fail('REAL_EVIDENCE_RETENTION_REQUIRED');
 const client=await connectExistingAttestation(c.sourceRoot);let began=false,writeAttempted=false;
 try{
  await client.query('begin');began=true;writeAttempted=true;
  const verifiedBy=`independent-publisher:${identity.hostname}:${identity.principal_uid}:${identity.execution_ref}`;
  await client.query(`insert into clued_private.currentness_transport_attestations
   (environment,source_commit,test_digest,all_paths_enforced,evidence,verified_at,verified_by)
   values('production',$1,$2,true,$3::jsonb,now(),$4)
   on conflict(environment) do update set source_commit=excluded.source_commit,test_digest=excluded.test_digest,
   all_paths_enforced=excluded.all_paths_enforced,evidence=excluded.evidence,verified_at=excluded.verified_at,verified_by=excluded.verified_by`,[c.sourceCommit,digest,JSON.stringify(evidence),verifiedBy]);
  const r=await client.query(`select source_commit,test_digest,all_paths_enforced,evidence,verified_by from clued_private.currentness_transport_attestations where environment='production'`),row=r.rows?.[0];
  if(r.rows?.length!==1||row.source_commit!==c.sourceCommit||row.test_digest!==digest||row.all_paths_enforced!==true||row.verified_by!==verifiedBy||!sameJson(row.evidence,evidence))fail('ATTESTATION_READBACK_MISMATCH');
  await requireActualG6AllPathAcceptance(client,c);loadContext(contextSha);exactMain(c);await client.query('commit');began=false;
  // Require actual committed consumer readback as well; failure is uncertain.
  const g6Consumer=await requireActualG6AllPathAcceptance(client,c);loadContext(contextSha);exactMain(c);
  const result={g6Consumer,status:'CURRENTNESS_ATTESTED',sourceCommit:c.sourceCommit,testDigest:digest,testCount:tests.length,receiptRef:retained.receipt_ref,grantReceiptId:grant.receiptId};writeOnce('currentness-completed.json',result);return result;
 }catch{if(began){try{await client.query('rollback');}catch{}}fail(writeAttempted?'ATTESTATION_OUTCOME_UNCERTAIN_NO_RETRY':'ATTESTATION_UNAVAILABLE_NO_RETRY');}finally{try{await client.end();}catch{}}
}
export async function main(argv=[]){
 if(argv.length===0)return {status:'DISABLED',code:'NO_HOST_READ'};
 if(argv.length!==7||argv[0]!=='--execute-once'||argv[1]!=='--fixed-scope'||argv[2]!==FIXED_SCOPE||argv[3]!=='--stage'||!['grant-before-deploy','currentness-after-deploy'].includes(argv[4])||argv[5]!=='--reviewed-context-sha256'||!HASH.test(argv[6]))return {status:'BLOCKED',code:'FIXED_EXPLICIT_SCOPE_REQUIRED'};
 try{const c=loadContext(argv[6]);return argv[4]==='grant-before-deploy'?await grantBeforeDeploy(c,argv[6]):await currentnessAfterDeploy(c,argv[6]);}
 catch(e){return {status:'BLOCKED_OR_UNCERTAIN',code:/^[A-Z][A-Z0-9_]{1,90}$/.test(e?.code??'')?e.code:'EXISTING_RELEASE_STAGE_UNCONFIRMED',automaticRetryAllowed:false};}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const r=await main(process.argv.slice(2));process.stdout.write(JSON.stringify(r)+'\n');process.exitCode=['DISABLED','GRANT_CONSUMED','CURRENTNESS_ATTESTED'].includes(r.status)?0:2;}
