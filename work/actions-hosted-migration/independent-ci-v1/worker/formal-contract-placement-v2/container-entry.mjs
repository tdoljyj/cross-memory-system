// Source v2 copy of formal-contract-placement-v1/container-entry.mjs (DESIGN S6): job contract v2 only.
// Trusted read-only container entry. All candidate Python/Node/build/renderer
// execution happens here as UID65532 with no network/credentials/control mounts.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const PROFILE='required-contract-placement/1';
export const LIMITS=Object.freeze({timeoutMs:300000,maxOutputBytes:16777216,memoryBytes:2147483648,cpus:2,pids:128});
const HASH=/^[a-f0-9]{64}$/,SHA=/^[a-f0-9]{40}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const check=(v,c)=>{if(!v)fail(c);};
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const absolute=v=>typeof v==='string'&&/^\/[A-Za-z0-9_./-]+$/.test(v)&&path.posix.normalize(v)===v;
const sha=b=>createHash('sha256').update(b).digest('hex');
export function validateTools(tools){
  check(exact(tools,['node','python','git','esbuildJs','esbuildBinary']),'EXACT_IMAGE_TOOLS_REQUIRED');
  for(const tool of Object.values(tools))check(exact(tool,['path','sha256'])&&absolute(tool.path)&&HASH.test(tool.sha256)&&!['/input','/source','/request','/control','/scratch','/proc','/sys','/dev'].some(p=>tool.path===p||tool.path.startsWith(p+'/')),'FIXED_IMAGE_TOOL_PIN_REQUIRED');
  check(new Set(Object.values(tools).map(t=>t.path)).size===5,'DISTINCT_IMAGE_TOOLS_REQUIRED');return tools;
}
// Job contract /3 (claim-free, attempt-scoped, names the tested commit S). Self-contained on purpose: this file runs
// inside the image with only node builtins, so it re-derives the id exactly as src/job-v2.mjs#jobIdV2 does.
export function validateEntryJob(job){
  const fields=['contract','id','repo','pr','headSha','baseSha','testSha','role','sourceManifestSha256','createdAt','attempt'];
  const identity=['repo','pr','headSha','baseSha','testSha','sourceManifestSha256','role','attempt'];
  check(exact(job,fields)&&job.contract==='clued.independent-ci.job/3'&&job.repo==='tdoljyj/cross-memory-system'&&job.role==='contract-placement'&&Number.isSafeInteger(job.attempt)&&job.attempt>=1&&job.attempt<=2&&
    Number.isSafeInteger(job.pr)&&job.pr>0&&SHA.test(job.headSha)&&SHA.test(job.baseSha)&&SHA.test(job.testSha)&&HASH.test(job.sourceManifestSha256)&&Number.isFinite(Date.parse(job.createdAt))&&
    job.id===sha(JSON.stringify(['clued.independent-ci.job/3',...identity.map(k=>job[k])])),'EXACT_PLACEMENT_JOB_REQUIRED');return job;
}
export function fixedCommands(job,tools){
  validateEntryJob(job);validateTools(tools);
  return Object.freeze([
    {id:'python-placement-fixtures',executable:tools.python.path,args:['-m','unittest','scripts/ci/test_check_contract_placement.py','-v']},
    {id:'bootstrap-fixtures',executable:tools.node.path,args:['--test','apps/clued-cloud/tests/agent-contract-bootstrap.test.mjs']},
    {id:'actual-bootstrap-build',executable:tools.node.path,args:[tools.esbuildJs.path,'apps/clued-cloud/worker/continuity.ts','--bundle','--platform=node','--format=esm','--external:js-tiktoken/*',`--define:__CLUED_BUILD_SHA__=${JSON.stringify(job.testSha)}`,'--outfile=/scratch/contract-bootstrap.mjs']},
    {id:'actual-and-synthetic-renderer',executable:tools.node.path,args:['apps/clued-cloud/scripts/render-agent-contract-budget.mjs','--worker-module','/scratch/contract-bootstrap.mjs','--output','/scratch/contract-responses.json']},
    {id:'placement-and-production-floor',executable:tools.python.path,args:['scripts/ci/check_contract_placement.py','--base',job.baseSha,'--head',job.testSha,'--minimum-service-version','0.4.5','--rendered-responses','/scratch/contract-responses.json']},
  ].map(v=>Object.freeze({...v,args:Object.freeze(v.args)})));
}
// Pure offline sequencing helper. Actual container main supplies only its fixed
// spawn operation; fixture output is never a signed/actual Host observation.
export async function executeSequence(job,tools,execute){
  check(typeof execute==='function','EXECUTOR_REQUIRED');const completed=[];
  for(const command of fixedCommands(job,tools)){
    const result=await execute(command);check(exact(result,['code','signal','error'])&&result.error===false&&result.signal===null&&Number.isInteger(result.code)&&result.code>=0&&result.code<=255,'PIPELINE_EXIT_UNKNOWN');
    completed.push({id:command.id,exitCode:result.code});
    if(result.code!==0)return{status:'CHECK_FAILED',exitCode:result.code,completed};
  }
  return{status:'ALL_ORIGINAL_CHECKS_COMPLETED',exitCode:0,completed};
}
async function regularPin(tool){
  const stat=await fs.lstat(tool.path);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.uid===0&&!(stat.mode&0o022)&&stat.size>0&&stat.size<=128*1024*1024,'IMAGE_TOOL_BOUNDARY_REQUIRED');
  check(sha(await fs.readFile(tool.path))===tool.sha256,'IMAGE_TOOL_HASH_CHANGED');
}
async function main(){
  check(process.platform==='linux'&&process.getuid?.()===65532&&process.versions.node==='24.19.0'&&process.cwd()==='/scratch','FIXED_NONROOT_CONTAINER_REQUIRED');
  const raw=await fs.readFile('/request/job.json');check(raw.length<=65536,'CONTROL_REQUEST_BOUND');const request=JSON.parse(raw.toString('utf8'));
  check(exact(request,['contract','job','tools'])&&request.contract==='clued.independent-ci.contract-placement-container/2','FIXED_CONTAINER_REQUEST_REQUIRED');
  const job=validateEntryJob(request.job),tools=validateTools(request.tools);check(process.execPath===tools.node.path,'CONTAINER_NODE_PATH_CHANGED');
  for(const tool of Object.values(tools))await regularPin(tool);
  const env={PATH:[...new Set([path.dirname(tools.git.path),path.dirname(tools.node.path),path.dirname(tools.python.path),'/usr/bin','/bin'])].join(':'),HOME:'/scratch/home',TMPDIR:'/scratch',TMP:'/scratch',TEMP:'/scratch',LANG:'C',LC_ALL:'C',CI:'true',PYTHONDONTWRITEBYTECODE:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',ESBUILD_BINARY_PATH:tools.esbuildBinary.path};
  const execute=(command,collect=false)=>new Promise(resolve=>{
    let error=false,output='',overflow=false;const child=spawn(command.executable,command.args,{cwd:'/scratch/workspace',shell:false,env,stdio:['ignore',collect?'pipe':'inherit','inherit']});
    if(collect)child.stdout.on('data',b=>{output+=b.toString('utf8');if(output.length>4096){overflow=true;child.kill('SIGKILL');}});
    child.once('error',()=>{error=true;});child.once('close',(code,signal)=>resolve({code,signal,error:error||overflow,...(collect?{output}:{})}));
  });
  await fs.mkdir('/scratch/home',{mode:0o700});
  // The Root observer mounts a validated sealed tree plus newly packed head/base
  // Git objects. Candidate-writable files exist only in this disposable tmpfs.
  await fs.cp('/input','/scratch/workspace',{recursive:true,force:false,errorOnExist:true,dereference:false});
  const version=await execute({executable:tools.esbuildBinary.path,args:['--version']},true);
  check(version.code===0&&version.signal===null&&!version.error&&version.output.trim()==='0.28.1','PINNED_ESBUILD_VERSION_REQUIRED');
  const result=await executeSequence(job,tools,command=>execute(command));
  console.log(JSON.stringify({contract:'clued.independent-ci.contract-placement-container-summary/1',profile:PROFILE,...result}));process.exitCode=result.exitCode;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))main().catch(()=>{process.stderr.write('CONTRACT_PLACEMENT_CONTAINER_REFUSED\n');process.exitCode=125;});
