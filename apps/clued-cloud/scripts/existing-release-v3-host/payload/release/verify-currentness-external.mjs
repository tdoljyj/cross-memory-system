// Minimal external successor of verify-currentness-transport.mjs.
// The original CLI has top-level test/DB effects and cannot safely be imported.
// Reuse its pinned TEST_FILES bytes and currentness-live-build module instead.
// This candidate never supplies invented GitHub Actions environment or IDs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const ORIGINAL_VERIFIER='apps/clued-cloud/scripts/verify-currentness-transport.mjs';
export const ORIGINAL_VERIFIER_SHA256='f5c59bdcd09834aa88f466879a072e30318d799ad8ab65c1c4e6337396a5a54a';
export const LIVE_VERIFIER='apps/clued-cloud/scripts/currentness-live-build.mjs';
export const PRODUCTION_HEALTH_URL='https://kooyumi.pixelgrav.com/healthz';
const hash=x=>createHash('sha256').update(x).digest('hex');
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const ref=x=>typeof x==='string'&&x.length>0&&x.length<=512&&!/[\u0000-\u0020\u007f]/.test(x);
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const errors=new WeakSet();
function failure(code){const e=new Error(code);errors.add(e);return e;}
const deny=code=>{throw failure(code);};
const codeOf=e=>errors.has(e)?e.message:'CURRENTNESS_EXTERNAL_PORT_FAILED';

export function readOriginalTestFiles(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length>65536||hash(bytes)!==ORIGINAL_VERIFIER_SHA256)deny('CURRENTNESS_ORIGINAL_SOURCE_PIN');
  const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))deny('CURRENTNESS_ORIGINAL_SOURCE_UTF8');
  const markers=[...text.matchAll(/^const TEST_FILES = Object\.freeze\(\[([\s\S]*?)^\]\);/gm)];
  if(markers.length!==1)deny('CURRENTNESS_ORIGINAL_TEST_DECLARATION');
  const body=markers[0][1],pattern=/'(tests\/[a-z0-9-]+\.test\.mjs)'/g;
  const files=[...body.matchAll(pattern)].map(m=>m[1]);
  if(files.length!==19||new Set(files).size!==19||body.replace(pattern,'').replace(/[\s,]/g,''))deny('CURRENTNESS_ORIGINAL_NINETEEN_TESTS_REQUIRED');
  return Object.freeze(files);
}

function safeChildEnv(env){
  const keep=['PATH','HOME','USERPROFILE','LANG','LC_ALL','TMPDIR','TEMP','TMP','SystemRoot','ComSpec'];
  return {...Object.fromEntries(keep.filter(k=>typeof env[k]==='string').map(k=>[k,env[k]])),NODE_OPTIONS:'',NODE_PATH:''};
}
// No direct spawn or TERM-based cleanup assumption. A protected manager must
// establish its own Source/Host qualification and authenticate whole-tree cleanup.
export async function boundedProcess(file,args,{manager,domain,cwd,env={},timeoutMs=10000,maxBytes=65536}={}){
  if(!manager||!ref(manager.ref)||!ref(manager.qualificationRef)||typeof manager.runManaged!=='function'||typeof manager.verifyCleanup!=='function')
    deny('CURRENTNESS_PROTECTED_PROCESS_MANAGER_REQUIRED');
  if(!['production','fixture'].includes(domain)||!path.isAbsolute(file)||!Array.isArray(args)||!args.every(a=>typeof a==='string')||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2700000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>64*1024*1024)
    deny('CURRENTNESS_FIXED_PROCESS_BOUNDS');
  const controller=new AbortController();let timer;
  try{
    const operation=(async()=>{
    const r=await manager.runManaged({file,args,cwd,env,timeoutMs,maxBytes,domain},{signal:controller.signal});
    if(r?.domain!==domain||r.manager_ref!==manager.ref||!ref(r.process_tree_ref)||r.cleanupConfirmed!==true||!ref(r.cleanup_receipt_ref))
      deny('CURRENTNESS_CHILD_UNCERTAIN');
    const proof=await manager.verifyCleanup({receipt_ref:r.cleanup_receipt_ref,process_tree_ref:r.process_tree_ref,domain});
    if(proof?.status!=='VERIFIED'||proof.domain!==domain||proof.manager_ref!==manager.ref||proof.process_tree_ref!==r.process_tree_ref||
      proof.receipt_ref!==r.cleanup_receipt_ref)deny('CURRENTNESS_CHILD_UNCERTAIN');
    if(typeof r.stdout!=='string'||typeof r.stderr!=='string'||Buffer.byteLength(r.stdout)+Buffer.byteLength(r.stderr)>maxBytes)
      deny('CURRENTNESS_CHILD_OUTPUT_BOUND');
    return r;
    })();
    return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>{
      controller.abort();reject(failure('CURRENTNESS_CHILD_UNCERTAIN'));
    },timeoutMs);})]);
  }catch(e){if(errors.has(e))throw e;deny('CURRENTNESS_CHILD_UNCERTAIN');}
  finally{clearTimeout(timer);}
}

export function requireCompleteTap(text){
  if(typeof text!=='string'||Buffer.byteLength(text)>64*1024*1024||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/.test(text))deny('CURRENTNESS_TAP_INVALID');
  const lines=text.replace(/\r\n/g,'\n').trimEnd().split('\n');
  if(lines[0]!=='TAP version 13'||lines.some(line=>/^\s*(?:not ok)\b/.test(line)||/^\s*(?:ok|not ok)\b.*#\s*(?:SKIP|TODO)\b/i.test(line)||/^Bail out!/i.test(line)))
    deny('CURRENTNESS_UNAPPROVED_TEST_OUTCOME');
  const plans=lines.filter(line=>/^1\.\.[0-9]+(?:\s*#.*)?$/.test(line));
  const cases=lines.filter(line=>/^ok [0-9]+(?:\s|$)/.test(line));
  if(plans.length!==1||plans[0]!==`1..${cases.length}`||!cases.length||cases.some((line,i)=>!line.startsWith(`ok ${i+1} `)&&line!==`ok ${i+1}`))
    deny('CURRENTNESS_TAP_INCOMPLETE');
  const counts={};for(const name of ['tests','suites','pass','fail','cancelled','skipped','todo']){
    const found=lines.filter(line=>new RegExp(`^# ${name} [0-9]+$`).test(line));
    if(found.length!==1)deny('CURRENTNESS_TAP_INCOMPLETE');counts[name]=Number(found[0].split(' ').at(-1));
  }
  if(!Number.isSafeInteger(counts.tests)||counts.tests<cases.length||counts.pass!==counts.tests||
    ['fail','cancelled','skipped','todo'].some(k=>counts[k]!==0)||!/^# duration_ms [0-9]+(?:\.[0-9]+)?$/.test(lines.at(-1)))
    deny('CURRENTNESS_UNAPPROVED_TEST_OUTCOME');
  return Object.freeze(counts);
}

// publisher is installed trusted code, not PR/request data. In production it
// must verify live Native release authorization and protected Host/Source facts.
// There is intentionally no --identity, --policy or --qualified CLI bypass.
export function createCurrentnessExternal({publisher,domain='production',clock=()=>Date.now(),env=process.env,
  readFile=fs.readFileSync,loadLiveModule=url=>import(url),
  actualIdentity=()=>({platform:process.platform,hostname:os.hostname(),uid:process.getuid?.()??null})}={}){
  if(!['production','fixture'].includes(domain))deny('CURRENTNESS_EXTERNAL_DOMAIN');
  const result=(status,code,extra={})=>Object.freeze({status,code,domain,attested:false,production_authorized:false,...extra});
  // A caller cannot retry this instance after an unproven child/DB outcome.
  // Cross-process recovery remains the protected manager/publisher's duty.
  let uncertainOutcome=null;
  const configured=()=>publisher&&path.isAbsolute(publisher.sourceRoot??'')&&path.isAbsolute(publisher.gitExecutable??'')&&
    ['authorizeCurrentness','retainEvidence',domain==='fixture'?'connectFixtureAttestation':'connectAttestation'].every(k=>typeof publisher[k]==='function');
  const managed=()=>publisher.processManager&&ref(publisher.processManager.ref)&&ref(publisher.processManager.qualificationRef)&&
    ['runManaged','verifyCleanup'].every(k=>typeof publisher.processManager[k]==='function');
  const runProcess=(file,args,options)=>boundedProcess(file,args,{...options,manager:publisher.processManager,domain});
  async function authorize(phase,expected){
    const a=await publisher.authorizeCurrentness({phase,expected_source_commit:expected??null});
    const now=clock(),observed=Date.parse(a?.observed_at),expires=Date.parse(a?.expires_at);
    if(a?.status!=='VERIFIED_NATIVE_AUTHORIZATION'||a.domain!==domain||!Number.isFinite(now)||!Number.isFinite(observed)||!Number.isFinite(expires)||
      observed>now||now-observed>60000||expires<=now||expires-now>300000||!sha(a.source_commit)||a.main_commit!==a.source_commit||
      a.repository!=='tdoljyj/cross-memory-system'||a.default_branch!=='main'||expected&&a.source_commit!==expected)deny('CURRENTNESS_NATIVE_AUTHORIZATION_REQUIRED');
    if(!ref(a.provider_id)||a.provider_id==='github-actions'||!ref(a.job_id)||!ref(a.host_qualification_ref)||!ref(a.source_acceptance_ref)||
      !ref(a.context_ref)||a.protected_publisher_context!==true||a.source_pins_verified!==true||
      !Number.isSafeInteger(a.source_pin_count)||a.source_pin_count<17||a.source_pin_count>512||
      a.claim?.live!==true||!ref(a.claim.id)||!Number.isSafeInteger(a.claim.fence)||a.claim.fence<1||!Number.isSafeInteger(a.claim.execution_epoch)||a.claim.execution_epoch<1)
      deny('CURRENTNESS_TRUSTED_EXECUTION_IDENTITY_REQUIRED');
    const resource=`repo:${a.repository}/${a.source_commit}`;
    if(a.grant?.consumed!==true||a.grant.action!=='release.production'||!same(a.grant.resources,[resource])||!ref(a.grant.receipt_ref))deny('CURRENTNESS_NATIVE_RELEASE_GRANT_REQUIRED');
    if(a.process_manager_ref!==publisher.processManager.ref||a.process_manager_qualification_ref!==publisher.processManager.qualificationRef)
      deny('CURRENTNESS_PROTECTED_PROCESS_MANAGER_UNQUALIFIED');
    const actual=actualIdentity();
    if(actual.platform!=='linux'||!Number.isSafeInteger(actual.uid)||actual.uid<1||!Number.isSafeInteger(a.principal_uid)||a.principal_uid<1)
      deny('CURRENTNESS_LINUX_VALID_UID_REQUIRED');
    if(a.hostname!==actual.hostname||a.principal_uid!==actual.uid)deny('CURRENTNESS_ACTUAL_HOST_PRINCIPAL_MISMATCH');
    return a;
  }
  async function run(...args){
    if(args.length)return result('BLOCKED','CURRENTNESS_CALLER_IDENTITY_NOT_ACCEPTED');
    if(uncertainOutcome)return uncertainOutcome;
    if(!configured())return result('BLOCKED','CURRENTNESS_PROTECTED_PUBLISHER_CONTEXT_REQUIRED');
    if(!managed())return result('BLOCKED','CURRENTNESS_PROTECTED_PROCESS_MANAGER_REQUIRED');
    let client=null,began=false,writeAttempted=false;
    try{
      const authority=await authorize('before_source');
      const processEnv=safeChildEnv(env),git=async command=>{
        const r=await runProcess(publisher.gitExecutable,command,{cwd:publisher.sourceRoot,env:processEnv,timeoutMs:10000,maxBytes:65536});
        if(r.exitCode!==0||r.exitSignal)deny('CURRENTNESS_SOURCE_GIT_FAILED');return r.stdout.trim();
      };
      const commit=await git(['rev-parse','HEAD']);
      if(commit!==authority.source_commit||await git(['branch','--show-current'])!=='main'||await git(['status','--porcelain','--untracked-files=all']))deny('CURRENTNESS_REAL_CLEAN_MAIN_REQUIRED');
      const original=readFile(path.join(publisher.sourceRoot,ORIGINAL_VERIFIER)),tests=readOriginalTestFiles(original);
      const live=await loadLiveModule(pathToFileURL(path.join(publisher.sourceRoot,LIVE_VERIFIER)).href);
      if(live.PRODUCTION_HEALTH_URL!==PRODUCTION_HEALTH_URL||typeof live.waitForLiveSourceCommit!=='function')deny('CURRENTNESS_EXISTING_LIVE_VERIFIER_REQUIRED');
      await live.waitForLiveSourceCommit(commit);
      const testArgs=['--test','--test-force-exit','--test-reporter=tap',...tests],testResult=await runProcess(process.execPath,testArgs,{
        cwd:path.join(publisher.sourceRoot,'apps/clued-cloud'),env:processEnv,timeoutMs:2700000,maxBytes:64*1024*1024});
      if(testResult.exitCode!==0||testResult.exitSignal||typeof testResult.stdout!=='string'||typeof testResult.stderr!=='string')deny('CURRENTNESS_ORIGINAL_TESTS_FAILED');
      const terminal=requireCompleteTap(testResult.stdout);
      // Same two real deployed-source observations as the original verifier.
      await live.waitForLiveSourceCommit(commit);
      if(await git(['rev-parse','HEAD'])!==commit||await git(['status','--porcelain','--untracked-files=all']))deny('CURRENTNESS_SOURCE_CHANGED_DURING_TESTS');
      const current=await authorize('before_attestation',commit);
      for(const key of ['context_ref','provider_id','job_id','host_qualification_ref','source_acceptance_ref'])if(current[key]!==authority[key])deny('CURRENTNESS_PUBLISHER_CONTEXT_CHANGED');
      if(!same(current.claim,authority.claim)||current.grant.receipt_ref!==authority.grant.receipt_ref)deny('CURRENTNESS_AUTHORIZATION_CHANGED');
      const output=`${testResult.stdout||''}\n${testResult.stderr||''}`;
      // Preserve the original test digest formula, status and production context.
      const digest=hash(JSON.stringify({commit,dirty:false,test_files:tests,output}));
      const identity={provider_id:current.provider_id,job_id:current.job_id,hostname:current.hostname,principal_uid:current.principal_uid,
        host_qualification_ref:current.host_qualification_ref,source_acceptance_ref:current.source_acceptance_ref,context_ref:current.context_ref,
        grant_receipt_ref:current.grant.receipt_ref,claim:current.claim};
      const evidence={source_commit:commit,source_worktree_dirty:false,verification_context:'production_post_deploy',deployed_commit:commit,
        live_health_url:PRODUCTION_HEALTH_URL,test_digest:digest,verification_status:'passed',test_files:tests,
        test_command:[process.execPath,...testArgs],test_terminal:terminal,ci_run:null,execution_provider:'independent-publisher',execution_identity:identity,
        checked_at:new Date(clock()).toISOString()};
      const verifiedBy=`independent-publisher:${current.provider_id}:${current.job_id}:host-source:${hash(JSON.stringify(identity))}`;
      // Match the old verifier's ordering: retain the actual test evidence before
      // installing its attestation. This record alone never proves DB commit.
      const retained=await publisher.retainEvidence(evidence,{exclusive:true,domain});
      if(retained?.status!=='RETAINED'||retained.domain!==domain||retained.evidence_sha256!==hash(JSON.stringify(evidence))||!ref(retained.receipt_ref))
        deny('CURRENTNESS_EVIDENCE_RETENTION_UNPROVEN');
      // The existing protected publisher supplies this client, not request/env data.
      client=domain==='fixture'?await publisher.connectFixtureAttestation():await publisher.connectAttestation();
      if(!client||!['connect','query','end'].every(k=>typeof client[k]==='function'))deny('CURRENTNESS_ATTESTATION_CLIENT_REQUIRED');
      if(domain==='fixture'&&(client.disposableOnly!==true||!/^fixture:/.test(client.fixtureDatabaseRef??'')))deny('CURRENTNESS_DISPOSABLE_FIXTURE_DATABASE_REQUIRED');
      if(domain==='production'&&client.disposableOnly===true)deny('CURRENTNESS_PRODUCTION_DATABASE_REQUIRED');
      await client.connect();await client.query('begin');began=true;writeAttempted=true;
      if(domain==='fixture')await client.query(`create temporary table clued_currentness_external_fixture (environment text primary key,source_commit text,test_digest text,all_paths_enforced boolean,evidence jsonb,verified_at timestamptz,verified_by text) on commit drop`);
      const table=domain==='fixture'?'pg_temp.clued_currentness_external_fixture':'clued_private.currentness_transport_attestations';
      await client.query(`insert into ${table}
        (environment,source_commit,test_digest,all_paths_enforced,evidence,verified_at,verified_by)
        values('production',$1,$2,true,$3::jsonb,now(),$4)
        on conflict (environment) do update set source_commit=excluded.source_commit,
          test_digest=excluded.test_digest,all_paths_enforced=excluded.all_paths_enforced,
          evidence=excluded.evidence,verified_at=excluded.verified_at,verified_by=excluded.verified_by`,
        [commit,digest,JSON.stringify(evidence),verifiedBy]);
      const readback=await client.query(`select source_commit,test_digest,all_paths_enforced,evidence,verified_by
        from ${table} where environment='production'`);
      const row=readback?.rows?.[0];
      if(readback.rows?.length!==1||row.source_commit!==commit||row.test_digest!==digest||row.all_paths_enforced!==true||
        row.verified_by!==verifiedBy||!same(row.evidence,evidence))deny('CURRENTNESS_ATTESTATION_READBACK_MISMATCH');
      const final=await authorize('before_commit',commit);
      if(!same(final.claim,current.claim)||final.context_ref!==current.context_ref||final.job_id!==current.job_id||final.grant.receipt_ref!==current.grant.receipt_ref)
        deny('CURRENTNESS_AUTHORIZATION_CHANGED');
      for(const key of ['provider_id','host_qualification_ref','source_acceptance_ref','hostname','principal_uid'])
        if(final[key]!==current[key])deny('CURRENTNESS_PUBLISHER_CONTEXT_CHANGED');
      await client.query('commit');began=false;
      return result(domain==='fixture'?'FIXTURE_PASSED':'PASSED','CURRENTNESS_EXTERNAL_VERIFIED',{
        attested:domain==='production',production_authorized:domain==='production',source_commit:commit,test_digest:digest,test_count:tests.length,
        execution_identity:identity,receipt_ref:retained.receipt_ref});
    }catch(e){
      if(began){try{await client.query('rollback');}catch{}}
      const code=codeOf(e);
      const outcome=result(writeAttempted||code==='CURRENTNESS_CHILD_UNCERTAIN'?'UNCERTAIN':'BLOCKED',code);
      if(outcome.status==='UNCERTAIN')uncertainOutcome=outcome;
      return outcome;
    }finally{if(client){try{await client.end();}catch{}}}
  }
  return Object.freeze({run});
}

// No installed protected publisher context is exposed by an ordinary CLI.
// The existing qualified publisher imports the core; flags cannot self-authorize it.
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  process.stdout.write(JSON.stringify({status:'BLOCKED',code:'CURRENTNESS_PROTECTED_PUBLISHER_CONTEXT_REQUIRED',attested:false,production_authorized:false})+'\n');
  process.exitCode=1;
}
