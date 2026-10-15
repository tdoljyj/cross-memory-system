import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readCanonicalGate,assertCanonicalGateFact,createEvidenceReaders,createImmutableSourceReaderCache} from './clued-handover-external-gate-evidence.mjs';

const repository='tdoljyj/cross-memory-system', root='/repos/'+repository;
const main='a'.repeat(40), admissionHead='b'.repeat(40), head='c'.repeat(40);
const claim='11111111-1111-4111-8111-111111111111';
const task='6176fdcc-c5b0-46c9-9769-d5e0bc0ce4f8', project='0597aa60-9b98-4da6-a4ab-63d7705b632f';
const workflow='clued-handover-disposable-idle.yml', dispatch='clued-work-admission-dispatch.yml';
const branch='clued-handover-disposable-exact', gatePath='scripts/ci/clued-work-admission.mjs';
const now=Date.parse('2026-10-14T16:01:00Z'), sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const iso=(second,nano='')=>'2026-10-14T16:'+second+(nano?'.'+nano:'')+'Z';
const empty=(mode)=>({mode,event:'workflow_dispatch',admitted:true,enforced:true,verdict:'ADMITTED',reasons:[],notices:[],
  claim_id:claim,scope:null,head_sha:head,base_sha:null,pr_ref:null,changed_paths:[],applicable_workflows:[],error:null,admission_mode:null});
const gateOutcome=()=>({...empty('gate'),admission_run:{id:2,status:'completed',conclusion:'success',html_url:'https://github.com/'+repository+'/actions/runs/2'}});
const admitOutcome=()=>({...empty('dispatch-admit'),scope:'project:'+project,claim:{task_id:task,status:'ACTIVE',fence:7,
  expires_at:'2026-10-14T17:00:00.000000+00:00',base_commit:main,bound_pr:repository+'#999',write_set:['work/handover-protection/disposable-fixture/exact.txt']}});
const content=path=>{
  const bytes=Buffer.from('accepted fixed public bytes for '+path+'\n');
  return {type:'file',path,encoding:'base64',content:bytes.toString('base64'),size:bytes.length,
    sha:crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex')};
};
function profile(){return {repository,engineering_task_id:task,project_id:project,target_branch:'main',runtime_source_commit:main,
  fixture_idle_workflow:workflow,qualifier_workflow:'clued-handover-external-qualification.yml',
  fixture_selection_policy:{mode:'derive_from_admitted_idle_v1',task_id:task,scope:'project:'+project,repository,target_branch:'main',
    branch_prefix:'clued-handover-disposable-',pr_state:'open',draft:true,auto_merge:null,unique_match:true,claim_relation:'single_canonical_claim',
    log_download_policy:'github_native_job_log_single_redirect_v1'},
  idle_selection_policy:{idle_actor_id:'10',idle_triggering_actor_id:'10',qualifier_actor_id:'10',qualifier_triggering_actor_id:'10'},
  gate_source_pins:Object.fromEntries([gatePath,'.github/workflows/'+dispatch,'.github/workflows/'+workflow,
    '.github/workflows/clued-handover-external-qualification.yml','scripts/ci/clued-gated-proof-runtime.mjs'].map(path=>[path,sha(Buffer.from(content(path).content,'base64'))]))};}
function step(name,number,start,end){return {name,number,status:'completed',conclusion:'success',started_at:iso(start),completed_at:iso(end)};}
function logs(mode,outcome,checkout=main,{duplicate=false,notice=true}={}){
  const admit=mode==='dispatch-admit';
  const t=admit?['00:02','00:03','00:06','00:07','00:08']:['00:43','00:44','00:47','00:48','00:49'];
  const command='node '+gatePath+' --mode '+mode;
  const rows=[`${iso(t[0],'0000001')} ##[group]Run actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683`,
    `${iso(t[0],'0000002')} token: ***`,`${iso(t[0],'0000003')} ##[endgroup]`,
    `${iso(t[1],'0000001')} [command]/usr/bin/git log -1 --format=%H`,`${iso(t[1],'0000002')} ${checkout}`,
    `${iso(t[2],'0000001')} ##[group]Run ${command}`,`${iso(t[2],'0000002')} ${command}`,
    `${iso(t[2],'0000003')} shell: /usr/bin/bash -e {0}`,`${iso(t[2],'0000004')} env:`,
    `${iso(t[2],'0000005')}   GITHUB_TOKEN: ***`,`${iso(t[2],'0000006')} ##[endgroup]`];
  if(admit&&notice)rows.push(`${iso(t[3],'0000001')} ##[notice]${outcome.head_sha}`);
  for(const line of JSON.stringify(outcome,null,2).split('\n'))rows.push(`${iso(t[4],'0000001')} ${line}`);
  if(duplicate)for(const line of JSON.stringify(outcome,null,2).split('\n'))rows.push(`${iso(t[4],'0000002')} ${line}`);
  rows.push(`${iso(admit?'00:11':'00:50')} Post job cleanup.`);return rows.join('\n')+'\n';
}
function fixture(){
  const p=profile(), actor={id:10}, repo={full_name:repository};
  const run={id:1,repository:repo,head_repository:repo,path:'.github/workflows/'+workflow,event:'workflow_dispatch',run_attempt:1,
    head_sha:head,head_branch:branch,status:'in_progress',conclusion:null,created_at:iso('00:40'),actor,triggering_actor:actor};
  const admission={id:2,repository:repo,head_repository:repo,path:'.github/workflows/'+dispatch,event:'workflow_dispatch',run_attempt:1,
    head_sha:admissionHead,head_branch:'main',status:'completed',conclusion:'success',created_at:iso('00:00'),actor,triggering_actor:actor,
    display_title:'admit '+workflow+' '+branch+' '+claim};
  const gate={id:11,run_id:1,run_attempt:1,head_sha:head,name:'admission-gate',status:'completed',conclusion:'success',
    started_at:iso('00:42'),completed_at:iso('00:50'),steps:[step('Run actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',1,'00:43','00:45'),
      step('Run node '+gatePath+' --mode gate',4,'00:47','00:49')]};
  const admit={id:21,run_id:2,run_attempt:1,head_sha:admissionHead,name:'clued-work-admission-dispatch',status:'completed',conclusion:'success',
    started_at:iso('00:01'),completed_at:iso('00:12'),steps:[step('Run actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',1,'00:02','00:04'),
      step('Verify the work claim with Clued',4,'00:06','00:10')]};
  const f={profile:p,run,admission,gate,admit,gateOutcome:gateOutcome(),admitOutcome:admitOutcome(),
    gateLog:null,admitLog:null,annotations:[{title:'clued-admitted-head',message:head,annotation_level:'notice'}],
    signedUrl:'https://results-receiver.actions.githubusercontent.com/specific?sig=PRIVATE_SIGNED_URL',status:302,sourceMutator:null,
    downloaded:[],getCount:0,downloadMutator:null};
  f.api=async route=>{f.getCount++;
    if(route===root+'/actions/runs/1')return f.run;
    if(route===root+'/actions/runs/2')return f.admission;
    if(route===root+'/actions/jobs/11')return f.gate;
    if(route===root+'/actions/jobs/21')return f.admit;
    if(route===root+'/actions/runs/1/attempts/1/jobs?per_page=100&page=1')return {total_count:2,jobs:[f.gate,{id:12,name:'disposable-idle'}]};
    if(route===root+'/actions/runs/2/attempts/1/jobs?per_page=100&page=1')return {total_count:1,jobs:[f.admit]};
    if(route===root+'/check-runs/21/annotations?per_page=100&page=1')return f.annotations;
    const m=new RegExp('^'+root+'/contents/(.+)\\?ref=([a-f0-9]{40})$').exec(route);
    if(m){const file=content(m[1]);if(f.sourceMutator)f.sourceMutator(file,m[2]);return file;}
    throw new Error('UNEXPECTED_MOCK_API_ROUTE');};
  let downloadIndex=0;
  f.apiResponse=async(route,options)=>{f.getCount++;assert.deepEqual(options,{redirect:'manual'});
    assert.ok([root+'/actions/jobs/11/logs',root+'/actions/jobs/21/logs'].includes(route));
    return new Response(null,{status:f.status,headers:{location:f.signedUrl}});};
  f.realFetch=async(url,options)=>{f.getCount++;f.downloaded.push({url,options});
    assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
    assert.ok(!Object.keys(options.headers).some(key=>/authorization|cookie/i.test(key)));
    const text=downloadIndex++===0?(f.gateLog??logs('gate',f.gateOutcome)):(f.admitLog??logs('dispatch-admit',f.admitOutcome));
    return f.downloadMutator?f.downloadMutator(text):new Response(text,{status:200,headers:{'content-type':'text/plain'}});};
  f.read=()=>readCanonicalGate({profile:p,runId:'1',targetWorkflow:workflow,targetRef:branch,targetHead:head,
    api:f.api,apiResponse:f.apiResponse,realFetch:f.realFetch,now:()=>now});return f;
}

function transportFixture(){
  const f=fixture(), token='MOCK_TOKEN_ONLY', hits=[];let count=0;
  const realFetch=async(url,options)=>{
    assert.equal(options.method,'GET');if(count>=160)throw new Error('SHARED_GET160_LIMIT');count++;
    const parsed=new URL(url);hits.push({origin:parsed.origin,path:parsed.pathname,redirect:options.redirect});
    if(parsed.origin==='https://api.github.com'){
      assert.equal(options.headers.authorization,'Bearer '+token);assert.equal(options.headers['x-github-api-version'],'2022-11-28');
      assert.equal(options.headers.accept,'application/vnd.github+json');
      const route=parsed.pathname+parsed.search;
      const log=/\/actions\/jobs\/(11|21)\/logs$/.exec(route);
      if(log){assert.equal(options.redirect,'manual');return new Response(null,{status:302,
        headers:{location:'https://results-receiver.actions.githubusercontent.com/job/'+log[1]+'?sig=MOCK_SIGNED_PRIVATE'}});}
      assert.equal(options.redirect,'error');return new Response(JSON.stringify(await f.api(route)),{headers:{'content-type':'application/json'}});
    }
    assert.equal(parsed.origin,'https://results-receiver.actions.githubusercontent.com');
    assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
    assert.ok(!Object.keys(options.headers).some(key=>/authorization|cookie/i.test(key)));
    const text=parsed.pathname==='/job/11'?logs('gate',f.gateOutcome):logs('dispatch-admit',f.admitOutcome);
    return new Response(text,{headers:{'content-type':'text/plain'}});
  };
  return {f,token,realFetch,hits,get count(){return count;}};
}
export {repository,root,main,admissionHead,head,claim,task,project,workflow,dispatch,branch,gatePath,now,sha,iso,empty,gateOutcome,admitOutcome,content,profile,step,logs,fixture,transportFixture};
