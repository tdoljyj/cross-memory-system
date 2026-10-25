// Offline control: actual candidate provider/journal/locator/gate bytes run in
// an isolated tree. The explicit acceptedSourceCheck substitute does NOT prove A.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {repository,root,main,head,claim,workflow,branch,now,sha,iso,content,logs,fixture} from './clued-handover-external-gate-evidence.fixture.mjs';

test('actual provider cumulative one-commit preflight, canonical-to-synthetic mapping, uncertain POST and stale-current gate stay below GET160',async t=>{
  t.mock.method(Date,'now',()=>now);
  const sourceDir=path.dirname(fileURLToPath(import.meta.url));
  const temporaryRoot=path.resolve(sourceDir,'.test-temporary');fs.mkdirSync(temporaryRoot,{recursive:true});
  const directory=fs.mkdtempSync(path.join(temporaryRoot,'provider-budget-')),ci=path.join(directory,'scripts','ci');
  fs.mkdirSync(ci,{recursive:true});
  try{
    const actualNames=['clued-handover-external-provider.mjs','clued-handover-external-journal.mjs',
      'clued-handover-external-fixture-locator.mjs','clued-handover-external-gate-evidence.mjs'];
    for(const name of actualNames){const raw=fs.readFileSync(path.join(sourceDir,name));fs.writeFileSync(path.join(ci,name),raw);
      assert.equal(sha(fs.readFileSync(path.join(ci,name))),sha(raw),'actual candidate code copy changed');}
    // Only the three unavailable external dependencies are substitutes. They
    // cannot execute admission, publication or revocation Source in this test.
    fs.writeFileSync(path.join(ci,'clued-work-admission.mjs'),"export function postAppCheckCore(){throw Error('UNUSED_SHARED_PUBLICATION_STUB');}\n");
    fs.writeFileSync(path.join(ci,'clued-work-claim-handover.mjs'),"export function revokeHandover(){throw Error('UNUSED_SHARED_REVOKER_STUB');}\n");
    fs.writeFileSync(path.join(ci,'clued-handover-external-source-check.mjs'),
      "// TEST SUBSTITUTE ONLY: no A/Host/operator qualification is established.\n"+
      "import fs from 'node:fs';import path from 'node:path';\n"+
      "export function acceptedSourceCheck(workspace){return JSON.parse(fs.readFileSync(path.join(workspace,'mock-acceptance.json'),'utf8'));}\n"+
      "export function acceptedGateSourcePins(actual){return structuredClone(actual.gate_source_pins);}\n");
    const gate=await import(pathToFileURL(path.join(ci,'clued-handover-external-gate-evidence.mjs')).href);
    const journalModule=await import(pathToFileURL(path.join(ci,'clued-handover-external-journal.mjs')).href);
    const locatorModule=await import(pathToFileURL(path.join(ci,'clued-handover-external-fixture-locator.mjs')).href);
    const {guardedProvider,projectRegisteredRuntimeProfile}=await import(pathToFileURL(path.join(ci,'clued-handover-external-provider.mjs')).href);
    const idle=fixture(),current=fixture(),synthetic='22222222-2222-4222-8222-222222222222',scope='project:'+idle.profile.project_id;
    current.run.id=3;current.run.path='.github/workflows/'+current.profile.qualifier_workflow;
    current.run.head_sha=main;current.run.head_branch='main';
    current.gate.id=31;current.gate.run_id=3;current.gate.head_sha=main;
    current.admission.id=4;current.admission.display_title='admit '+current.profile.qualifier_workflow+' main '+claim;
    current.admit.id=41;current.admit.run_id=4;
    current.gateOutcome.admission_run.id=4;current.gateOutcome.head_sha=main;current.admitOutcome.head_sha=main;
    current.annotations[0].message=main;
    const p={...idle.profile,qualified:true,runtime_authority:'exact-owner-source-approval',provisioning_state:'PROJECT_CREATED_NOT_REGISTERED_OR_HOSTED_QUALIFIED',fixture_mode:'continuous',required_app_id:5164952,
      pr_number:null,head_sha:null,disposable_branch:null,idle_run_id:null,fixture_claim_id:synthetic,
      fixture_paths:['work/handover-protection/disposable-fixture/exact.txt'],accepted_source_commit:'d'.repeat(40),
      profile_hash:'a'.repeat(64),acceptance_sha256:'b'.repeat(64),database_name:'postgres',database_host:'mock-disposable.invalid',
      disposable_pg_registration:'mock-registered-disposable',operator_authority_receipt:'33333333-3333-4333-8333-333333333333',
      source_baseline:'e'.repeat(40),registration_run_id:'30',valid_until:'2026-10-14T17:00:00Z'};
    p.idle_selection_policy={...p.idle_selection_policy,mode:'late-bound-single-original-journal',workflow,
      workflow_blob:'97c39730ce75f2ea2427c9fa3845f9df32e998f8',source_sha256:'133554a025b122737198289925920b31992191a96a5321242d3c78cf119acf66',
      primary_definition_sha256:'d6dce50d38f3a75a290776243f8065ad69cbfd4fa68327f75a8ce3055965fd3d'};
    // The actual journal's original immutable idle YAML identity is exercised,
    // while the full-A acceptance dependency remains explicitly substituted.
    const sourceRoot=path.resolve(sourceDir,'../..');
    let idlePath=path.join(sourceRoot,'.github','workflows',workflow);
    if(!fs.existsSync(idlePath)){
      assert.equal(path.basename(sourceRoot),'fixture-locator-successor-candidate','formal repository must use its own Source tree');
      idlePath=path.resolve(sourceRoot,'../source-registration-repo/.github/workflows/'+workflow);
    }
    const idleBytes=fs.readFileSync(idlePath);
    const idleContent={type:'file',path:'.github/workflows/'+workflow,encoding:'base64',content:idleBytes.toString('base64'),size:idleBytes.length,
      sha:crypto.createHash('sha1').update(Buffer.from('blob '+idleBytes.length+'\0')).update(idleBytes).digest('hex')};
    assert.equal(sha(idleBytes),p.idle_selection_policy.source_sha256);assert.equal(idleContent.sha,p.idle_selection_policy.workflow_blob);
    p.gate_source_pins[idleContent.path]=sha(idleBytes);
    const pinsBytes=fs.readFileSync(path.join(sourceDir,'clued-handover-external-source-pins.json'));
    fs.writeFileSync(path.join(ci,'clued-handover-external-source-pins.json'),pinsBytes);p.source_pins_sha256=sha(pinsBytes);
    fs.writeFileSync(path.join(directory,'mock-acceptance.json'),JSON.stringify({
      test_substitute_only:true,does_not_prove_A:true,acceptance_sha256:p.acceptance_sha256,
      accepted_source_commit:p.accepted_source_commit,profile_sha256:p.profile_hash,profile:p,gate_source_pins:p.gate_source_pins}));
    const repo={full_name:repository},pull={number:999,state:'open',draft:true,auto_merge:null,commits:1,changed_files:1,
      head:{sha:head,ref:branch,repo},base:{ref:'main',repo},body:'Fixture only\nClued-Work-Claim: '+claim+'\nClued-Work-Scope: '+scope};
    const idleJob={id:12,run_id:1,run_attempt:1,head_sha:head,name:'disposable-idle',status:'in_progress',conclusion:null,
      started_at:iso('00:50'),completed_at:null,steps:[{name:'Bounded idle process to prove real provider cancellation',number:4,
        status:'in_progress',conclusion:null,started_at:iso('00:51'),completed_at:null}]};
    const checks=[],requests=[],posts=[],budget=journalModule.providerGetBudget(),sourceCache=gate.createImmutableSourceReaderCache({repository});
    const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
    const realFetch=async(url,init={})=>{
      const parsed=new URL(String(url)),method=init.method??'GET';
      if(method==='GET')budget.take();requests.push({method,origin:parsed.origin,path:parsed.pathname});
      if(parsed.origin==='https://mock-storage.blob.core.windows.net'){
        assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
        assert.ok(!Object.keys(init.headers??{}).some(key=>/authorization|cookie/i.test(key)));
        const job=parsed.pathname.split('/').at(-1),f=['11','21'].includes(job)?idle:current;
        return new Response(logs(['11','31'].includes(job)?'gate':'dispatch-admit',
          ['11','31'].includes(job)?f.gateOutcome:f.admitOutcome),{headers:{'content-type':'text/plain'}});
      }
      assert.equal(parsed.origin,'https://api.github.com','mock transport must never reach another origin');
      const route=parsed.pathname+parsed.search;
      const log=/\/actions\/jobs\/(11|21|31|41)\/logs$/.exec(route);
      if(log){assert.equal(init.redirect,'manual');return new Response(null,{status:302,
        headers:{location:'https://mock-storage.blob.core.windows.net/native/'+log[1]+'?sig=MOCK'}});}
      for(const f of [idle,current]){
        if(route===root+'/actions/runs/'+f.run.id)return json(f.run);
        if(route===root+'/actions/runs/'+f.admission.id)return json(f.admission);
        if(route===root+'/actions/jobs/'+f.gate.id)return json(f.gate);
        if(route===root+'/actions/jobs/'+f.admit.id)return json(f.admit);
        if(route===root+'/actions/runs/'+f.run.id+'/attempts/1/jobs?per_page=100&page=1')return json({total_count:2,jobs:[f.gate,idleJob]});
        if(route===root+'/actions/runs/'+f.admission.id+'/attempts/1/jobs?per_page=100&page=1')return json({total_count:1,jobs:[f.admit]});
        if(route===root+'/check-runs/'+f.admit.id+'/annotations?per_page=100&page=1')return json(f.annotations);
      }
      const source=/\/contents\/(.+)\?ref=[0-9a-f]{40}$/.exec(route);if(source)return json(source[1]===idleContent.path?idleContent:content(source[1]));
      if(route.startsWith(root+'/pulls?'))return json([pull]);
      if(route===root+'/pulls/999')return json(pull);
      if(route===root+'/pulls/999/commits?per_page=100&page=1')return json([{sha:head}]);
      if(route===root+'/pulls/999/files?per_page=100&page=1')return json(p.fixture_paths.map(filename=>({filename})));
      if(route===root+'/commits/'+head+'/check-runs?filter=all&per_page=100&page=1')return json({total_count:checks.length,check_runs:checks});
      if(route===root+'/actions/runs?head_sha='+head+'&per_page=100&page=1')return json({total_count:1,workflow_runs:[idle.run]});
      if(route===root+'/actions/runs/1/jobs?per_page=100&page=1')return json({total_count:2,jobs:[idle.gate,idleJob]});
      if(route===root+'/actions/runs/30')return json(registrationRun);
      if(route===root+'/actions/runs/30/jobs?per_page=100&page=1')return json(registrationJobs);
      if(route===root+'/installation')return json({id:123});
      if(method==='POST'&&route===root+'/check-runs'){
        const body=JSON.parse(init.body);posts.push(body);
        const check={...body,id:1000+posts.length,app:{id:5164952}};checks.push(check);return json(check);
      }
      throw Error('UNEXPECTED_OFFLINE_PROVIDER_ROUTE');
    };
    const readers=gate.createEvidenceReaders({repository,token:'MOCK_GITHUB_ONLY',realFetch,sourceCache});
    const idleFact=await gate.readCanonicalGate({profile:p,runId:'1',targetWorkflow:workflow,targetRef:branch,targetHead:head,...readers,realFetch});
    const mainFact=await gate.readCanonicalGate({profile:p,runId:'3',targetWorkflow:p.qualifier_workflow,targetRef:'main',targetHead:main,...readers,realFetch});
    const api=async route=>(await realFetch('https://api.github.com'+route,{method:'GET'})).json();
    const locator=await locatorModule.resolveFixtureLocator({profile:p,idleGateFact:idleFact,mainGateFact:mainFact,api});
    const selected={...journalModule.applyFixtureLocator(p,locator),idle_run_id:'1'};
    const registrationRun={id:30,repository:repo,head_repository:repo,event:'workflow_dispatch',run_attempt:1,
      path:'.github/workflows/'+p.qualifier_workflow,head_sha:main,head_branch:'main',actor:{id:10},triggering_actor:{id:10},
      status:'completed',conclusion:'success',created_at:'2026-10-14T15:59:00Z'};
    const registrationJobs={total_count:2,jobs:[
      {id:300,name:'admission-gate',run_id:30,run_attempt:1,head_sha:main,status:'completed',conclusion:'success',
        started_at:'2026-10-14T15:59:10Z',completed_at:'2026-10-14T15:59:20Z'},
      {id:301,name:'clued-handover-external2',run_id:30,run_attempt:1,head_sha:main,status:'completed',conclusion:'success',
        started_at:'2026-10-14T15:59:20Z',completed_at:'2026-10-14T15:59:30Z',steps:[
          {name:'Execute declared source-only or actual External2 path',status:'completed',conclusion:'success',
            started_at:'2026-10-14T15:59:21Z',completed_at:'2026-10-14T15:59:29Z'}]}]};
    const registrationRows=[{realm:'clued-handover-disposable',synthetic_only:true,registration:p.disposable_pg_registration,
      database_name:p.database_name,registered_host:p.database_host,profile_sha256:p.profile_hash,
      operator_authority_receipt:p.operator_authority_receipt,source_baseline:p.source_baseline,source_pins_sha256:p.source_pins_sha256,registered_run_id:'30'}];
    const initialProfileBytes=JSON.stringify(p),selectedBytes=JSON.stringify(selected);
    const runtime=projectRegisteredRuntimeProfile(selected,{registrationRows,run:registrationRun,jobs:registrationJobs});
    assert.equal(p.provisioning_state,'PROJECT_CREATED_NOT_REGISTERED_OR_HOSTED_QUALIFIED');assert.equal(JSON.stringify(p),initialProfileBytes);
    assert.equal(JSON.stringify(selected),selectedBytes);assert.equal(runtime.provisioning_state,'REGISTERED_DISPOSABLE');
    assert.deepEqual({...runtime,provisioning_state:selected.provisioning_state},selected,'only observed runtime registration state changes');
    for(const rows of [[],[registrationRows[0],registrationRows[0]],...['realm','synthetic_only','registration','database_name','registered_host','profile_sha256','operator_authority_receipt','source_baseline','source_pins_sha256','registered_run_id'].map(field=>[{...registrationRows[0],[field]:field==='synthetic_only'?false:'MISMATCH'}])])
      assert.throws(()=>projectRegisteredRuntimeProfile(selected,{registrationRows:rows,run:registrationRun,jobs:registrationJobs}));
    for(const change of [{status:'in_progress'},{conclusion:'failure'},{head_sha:head}])assert.throws(()=>projectRegisteredRuntimeProfile(selected,{registrationRows,run:{...registrationRun,...change},jobs:registrationJobs}));
    const failedJobs=structuredClone(registrationJobs);failedJobs.jobs[1].steps[0].conclusion='failure';
    assert.throws(()=>projectRegisteredRuntimeProfile(selected,{registrationRows,run:registrationRun,jobs:failedJobs}));
    for(const change of [{qualified:false},{runtime_authority:'none'}])assert.throws(()=>projectRegisteredRuntimeProfile({...selected,...change},{registrationRows,run:registrationRun,jobs:registrationJobs}));
    const binding=journalModule.makeIdleBinding(runtime,{run:idle.run,jobs:{total_count:2,jobs:[idle.gate,idleJob]},content:idleContent,
      registrationRun,registrationJobs,locator,mainGateFact:mainFact});
    let durableRow=null;const evidence=[],journalQueries=[];
    const journalDb={query:async(sql,values)=>{
      journalQueries.push({sql,values});
      if(sql.startsWith('create table if not exists qualification_guard.'))return {rows:[]};
      if(sql.startsWith('select * from qualification_guard.provider_cancellation_journal_v1'))return {rows:durableRow?[structuredClone(durableRow)]:[]};
      if(sql.startsWith('insert into qualification_guard.provider_cancellation_journal_v1')){
        assert.equal(durableRow,null);durableRow={profile_sha256:values[0],run_id:values[1],
          started_fact:JSON.parse(values[2]),binding_fact:JSON.parse(values[3]),attempted_at:null};return {rows:[],rowCount:1};}
      if(sql.startsWith('insert into qualification_guard.provider_evidence_journal_v1')){
        evidence.push({kind:values[1],fact:JSON.parse(values[2])});return {rows:[],rowCount:1};}
      throw Error('UNEXPECTED_OFFLINE_JOURNAL_QUERY');
    }};
    const actualJournal=await journalModule.cancellationJournal(journalDb,runtime);
    await actualJournal.bindIdle(binding);
    assert.equal(journalQueries.filter(q=>q.sql.startsWith('insert into qualification_guard.provider_cancellation_journal_v1')).length,1,'original CAS occurs once');
    const fixtureState={claim_id:synthetic,scope,publisher_run_id:'3'},queries=[];
    const identity={synthetic_only:true,realm:'clued-handover-disposable',database_name:p.database_name,registered_host:p.database_host,
      registration:p.disposable_pg_registration,operator_authority_receipt:p.operator_authority_receipt,
      source_baseline:p.source_baseline,source_pins_sha256:p.source_pins_sha256};
    const ciClient={query:async(sql,values)=>{queries.push({sql,values});
      if(sql==='select * from qualification_guard.runtime_identity_v1')return {rows:[identity]};
      assert.equal(sql,'select public.clued_work_verify_v1($1::text,$2::jsonb) v');
      assert.equal(values[1].claim_id,synthetic);assert.equal(values[1].scope,scope);
      return {rows:[{v:{status:'accepted',verdict:'ADMITTED',publication_id:'44444444-4444-4444-8444-444444444444'}}]};}};
    const env={GITHUB_WORKSPACE:directory,GITHUB_REPOSITORY:repository,GITHUB_TOKEN:'MOCK_GITHUB_ONLY',GITHUB_RUN_ID:'3',
      CLUED_ADMISSION_APP_ID:'5164952',CLUED_CONTEXT_READ_TOKEN:'MOCK_SYNTHETIC_CI_PROOF_ONLY'};
    const construct=loseNextCheckPostResponse=>guardedProvider({env,profile:runtime,fixture:fixtureState,ciClient,realFetch,
      journal:actualJournal,sourceCache,loseNextCheckPostResponse});
    const untouchedGetCount=budget.count;
    await assert.rejects(guardedProvider({env,profile:selected,fixture:fixtureState,ciClient,realFetch,journal:actualJournal,sourceCache}),/REGISTERED_DISPOSABLE/);
    assert.equal(budget.count,untouchedGetCount,'unprojected initial state rejects before API calls');
    const canonicalInput={action:'publication_begin',claim_id:claim,scope,pr_ref:repository+'#999',head_sha:head,target_branch:'main',run_id:'3'};
    const pgInit={method:'POST',body:JSON.stringify({p_token_hash:sha(env.CLUED_CONTEXT_READ_TOKEN),p_input:canonicalInput})};
    const checkInit={method:'POST',body:JSON.stringify({name:'clued-admission-verified',head_sha:head,status:'completed',conclusion:'success'})};
    const happy=await construct(false);
    const projected=await happy.fetchImpl('https://clued-handover-fixture.invalid/rest/v1/rpc/clued_work_verify_v1',pgInit);
    assert.equal(projected.status,200);assert.equal(queries.at(-1).values[1].claim_id,synthetic);assert.equal(canonicalInput.claim_id,claim);
    await happy.fetchImpl('https://api.github.com'+root+'/check-runs',checkInit);assert.equal(posts.length,1);
    await happy.fetchImpl('https://api.github.com'+root+'/installation',{method:'GET'});
    const happyReads=budget.count;
    const uncertain=await construct(true);
    await uncertain.fetchImpl('https://clued-handover-fixture.invalid/rest/v1/rpc/clued_work_verify_v1',pgInit);
    await assert.rejects(uncertain.fetchImpl('https://api.github.com'+root+'/check-runs',checkInit),/controlled reply loss/);
    assert.equal(posts.length,2,'each constructed scenario issued exactly one mock check POST');
    await uncertain.fetchImpl('https://api.github.com'+root+'/commits/'+head+'/check-runs?filter=all&per_page=100&page=1',{method:'GET'});
    assert.equal(posts.length,2,'uncertain response followed only by GET');
    assert.equal(uncertain.trace.filter(e=>e.kind==='controlled_response_loss').length,1);
    const unknownReads=budget.count;
    // Exercise the caller's observed read phases too, through the identical
    // transport/counter/cache: Host1 + registration2 + idle2 + Source3 per
    // publication scenario. These are actual mock GETs, not budget estimates.
    const callerPhases=[
      ['host-current-run',[root+'/actions/runs/3']],
      ['registration',[root+'/actions/runs/30',root+'/actions/runs/30/jobs?per_page=100&page=1']],
      ['idle-original',[root+'/actions/runs/1',root+'/actions/runs/1/jobs?per_page=100&page=1']],
      ['source-happy',[root+'/pulls/999',root+'/pulls/999/files?per_page=100&page=1',root+'/installation']],
      ['source-uncertain',[root+'/pulls/999',root+'/pulls/999/files?per_page=100&page=1',root+'/installation']]
    ];
    const callerPhaseFacts=[];
    for(const [phase,routes]of callerPhases){const before=budget.count;
      for(const route of routes){const observed=await realFetch('https://api.github.com'+route,{method:'GET'});assert.equal(observed.status,200);await observed.json();}
      callerPhaseFacts.push({phase,reads:budget.count-before});
    }
    assert.deepEqual(callerPhaseFacts.map(f=>f.reads),[1,2,2,3,3]);
    const normalCallerReads=budget.count,queryCount=queries.length,postCount=posts.length;
    current.admission.created_at='2026-10-14T15:00:00Z';
    await assert.rejects(construct(false),/ADMISSION_EXPIRED/);
    assert.equal(queries.length,queryCount+1,'stale guard may read mock identity only; never publication query');
    assert.equal(posts.length,postCount,'stale current main must not post');
    assert.ok(budget.count<160,'measured complete cumulative path must fit original GET160');
    assert.equal(budget.count,85);assert.equal(happyReads,49);assert.equal(unknownReads,68);assert.equal(normalCallerReads,79);
    assert.equal(requests.filter(r=>r.method==='GET').length,budget.count);
    t.diagnostic('OFFLINE ONLY / DOES_NOT_PROVE_A: happy GET49; happy+unknown GET68; actual caller phases +11 = normal GET79; plus stale rejection GET85; mock check POST2 (one per scenario); real network/SQL/secrets zero.');
  }finally{
    const resolved=path.resolve(directory);assert.ok(resolved.startsWith(temporaryRoot+path.sep),'temporary cleanup outside intended directory');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
});

// Behavioral seed regression only: actual seed function bytes, an isolated VM,
// and a PG-contract double. This is neither real PG nor External qualification.
test('actual disposable seed obeys the Auth v2 owner transaction before opening another connection',async t=>{
  const vm=await import('node:vm');
  const sourceDir=path.dirname(fileURLToPath(import.meta.url));
  const actual=fs.readFileSync(path.join(sourceDir,'clued-handover-external-driver.mjs'),'utf8');
  const oldInsert='  await db.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) "+\n'+
    '    "values($1,$2,\'Synthetic external fixture\',\'synthetic external fixture\',$3,\'confirmed\',now())",[p.project_id,owner,\'project:\'+p.project_id]);';
  const guardedInsert="  await db.query('begin isolation level read committed');\n  try{\n"+
    "    await db.query('select clued_private.authorization_writer_guard_v2($1)',[owner]);\n"+
    "    await db.query('select clued_private.authorization_writer_lock_fanout_v2($1)',[owner]);\n"+oldInsert+"\n"+
    "    await db.query('commit');\n  }catch(error){\n    await db.query('rollback').catch(()=>{});\n    throw error;\n  }";
  assert.equal(actual.split(guardedInsert).length,2,'negative control reverses exactly the reviewed nine-line insertion');
  const before=actual.replace(guardedInsert,oldInsert);
  const profile={project_id:'0597aa60-9b98-4da6-a4ab-63d7705b632f',
    engineering_task_id:'6176fdcc-c5b0-46c9-9769-d5e0bc0ce4f8',
    fixture_claim_id:'8a438e3d-3221-468d-9d23-d5b80a0c33c2',runtime_source_commit:'a'.repeat(40),
    fixture_paths:['work/handover-protection/disposable-fixture/seed-regression.txt'],
    repository:'tdoljyj/cross-memory-system',pr_number:'9001',head_sha:'b'.repeat(40),target_branch:'main'};
  const owner='60000000-0000-4000-8000-000000000001',proof='c'.repeat(64),publisher='7001';
  function compile(source){
    const start=source.indexOf('async function seedFixture(h,p,ciProof) {');
    const end=source.indexOf('\nasync function fixtureCi(',start);
    assert.ok(start>=0&&end>start,'actual complete seed function delimiters');
    let sequence=0;
    return new vm.Script('('+source.slice(start,end)+'\n)',{filename:'actual-driver-seed-fixture.mjs'})
      .runInNewContext({assert,crypto:{randomBytes:size=>Buffer.alloc(size,17)},
        uuid:()=>`60000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`,
        sha:value=>crypto.createHash('sha256').update(value).digest('hex'),
        process:{env:{GITHUB_RUN_ID:publisher}}},{timeout:1000});
  }
  function fixture(failureAt=null){
    const events=[],bindings=[],state={users:0,project:null,task:null,claim:null,tx:false,
      isolation:null,guard:null,fanout:false,pendingProject:null,leaseRequired:false};
    const fault=Object.assign(new Error('synthetic '+failureAt+' failure'),{code:'SYNTHETIC_FAILURE'});
    const rows=value=>({rows:value}),gateway={fixtureOnly:true};
    const db={async query(sql,args=[]){
      const q=sql.replace(/\s+/g,' ').trim().toLowerCase();
      if(q==='select count(*)::int n from auth.users'){events.push('count_users');return rows([{n:state.users}]);}
      if(q.startsWith('insert into auth.users(')){events.push('insert_user');assert.equal(args[0],owner);state.users++;return rows([]);}
      if(q==='begin isolation level read committed'){events.push('begin');assert.equal(state.tx,false);state.tx=true;state.isolation='read committed';return rows([]);}
      if(q==='select clued_private.authorization_writer_guard_v2($1)'){
        events.push('guard');assert.equal(state.tx,true);assert.equal(state.isolation,'read committed');assert.equal(args[0],owner);
        if(failureAt==='guard')throw fault;state.guard=owner;return rows([]);
      }
      if(q==='select clued_private.authorization_writer_lock_fanout_v2($1)'){
        events.push('fanout');assert.equal(state.tx,true);assert.equal(state.guard,args[0]);state.fanout=true;return rows([]);
      }
      if(q.startsWith('insert into public.clued_projects(')){
        events.push('insert_project');
        if(!state.tx||state.isolation!=='read committed'||state.guard!==args[1])
          throw Object.assign(new Error('authorization_early_writer_guard_required'),{code:'42501'});
        assert.equal(state.fanout,true);assert.deepEqual(Array.from(args),[profile.project_id,owner,'project:'+profile.project_id]);
        if(failureAt==='project')throw fault;state.pendingProject=args[0];return rows([]);
      }
      if(q==='commit'){
        events.push('commit');assert.equal(state.tx,true);assert.equal(state.pendingProject,profile.project_id);
        state.project=state.pendingProject;state.pendingProject=null;state.tx=false;state.guard=null;state.fanout=false;return rows([]);
      }
      if(q==='rollback'){
        events.push('rollback');assert.equal(state.tx,true);state.pendingProject=null;state.tx=false;state.guard=null;state.fanout=false;return rows([]);
      }
      assert.equal(state.tx,false,'all later seed writes and cross-connection RPC follow the project COMMIT');
      assert.equal(state.project,profile.project_id);
      if(q.startsWith('insert into public.clued_memories(')){
        events.push('insert_task');assert.deepEqual(Array.from(args),[profile.engineering_task_id,owner,profile.project_id,'project:'+profile.project_id]);
        state.task=args[0];return rows([]);
      }
      if(q.startsWith('insert into public.clued_agent_bindings(')){
        events.push('insert_binding');assert.equal(args[0],owner);const id=`61000000-0000-4000-8000-${String(bindings.length+1).padStart(12,'0')}`;
        bindings.push({id,hash:args[2],scopes:args[3]});return rows([{id}]);
      }
      if(q.startsWith('insert into public.clued_audit_receipts(')){events.push('insert_role_receipt');assert.equal(args[2],bindings[1].id);return rows([{id:'62000000-0000-4000-8000-000000000001'}]);}
      if(q.startsWith('insert into clued_private.binding_roles_v1(')){events.push('insert_role');assert.equal(args[1],bindings[1].id);return rows([]);}
      if(q.startsWith('insert into clued_private.work_claims_v1(')){
        events.push('insert_claim');assert.equal(state.task,profile.engineering_task_id);assert.equal(args[0],profile.fixture_claim_id);
        assert.equal(args[4],bindings[0].id);state.claim=args[0];return rows([]);
      }
      if(q==='select clued_private.work_claim_lease_key_issue_v1($1) k'){events.push('lease_key');assert.equal(args[0],state.claim);return rows([{k:'synthetic-fixture-proof-only'}]);}
      if(q==='select clued_private.work_claim_execution_activate_v1($1) v'){events.push('activate');assert.equal(args[0],profile.runtime_source_commit);return rows([{v:{status:'activated'}}]);}
      if(q.startsWith('update clued_private.work_claims_v1 set lease_key_required=true')){events.push('require_key');state.leaseRequired=true;return rows([]);}
      if(q==='select fence,lease_version from clued_private.work_claims_v1 where claim_id=$1'){events.push('generation');return rows([{fence:1,lease_version:1}]);}
      throw Error('unexpected PG-contract query');
    }};
    const h={admin:db,async client(){
      events.push('open_gateway');assert.equal(state.tx,false);assert.equal(state.project,profile.project_id);
      assert.equal(state.claim,profile.fixture_claim_id);assert.equal(bindings.length,2);return gateway;
    },sourceFixtures:{async workerGatewayRpc(client,name,hash,input){
      events.push('authorize_head');assert.equal(client,gateway);assert.equal(name,'clued_work_renew_v1');
      assert.equal(hash,bindings[0].hash);assert.equal(state.leaseRequired,true);assert.equal(state.tx,false);
      assert.equal(input.claim_id,profile.fixture_claim_id);assert.equal(input.pr_ref,profile.repository+'#'+profile.pr_number);
      assert.equal(input.head_sha,profile.head_sha);return {status:'committed'};
    }}};
    return {h,state,events,bindings,fault};
  }
  await t.test('original unguarded seed is refused by the new owner-lock contract at project INSERT',async()=>{
    const f=fixture();await assert.rejects(compile(before)(f.h,profile,proof),e=>e.code==='42501'&&e.message==='authorization_early_writer_guard_required');
    assert.deepEqual(f.events,['count_users','insert_user','insert_project']);assert.equal(f.state.project,null);assert.equal(f.state.task,null);
  });
  await t.test('complete actual successor seed commits its guarded project before all later writes and the second connection',async()=>{
    const f=fixture(),result=await compile(actual)(f.h,profile,proof);
    assert.deepEqual(f.events,['count_users','insert_user','begin','guard','fanout','insert_project','commit',
      'insert_task','insert_binding','insert_binding','insert_role_receipt','insert_role','insert_claim','lease_key',
      'activate','require_key','generation','open_gateway','authorize_head']);
    assert.equal(f.state.tx,false);assert.equal(f.state.guard,null);assert.equal(f.state.pendingProject,null);
    assert.equal(f.bindings.length,2);assert.equal(result.owner_id,owner);assert.equal(result.claim_id,profile.fixture_claim_id);
    assert.equal(result.scope,'project:'+profile.project_id);assert.equal(result.publisher_run_id,publisher);
  });
  for(const failureAt of ['guard','project'])await t.test(failureAt+' fault rolls the project transaction back and rethrows without continuing seed',async()=>{
    const f=fixture(failureAt);await assert.rejects(compile(actual)(f.h,profile,proof),error=>error===f.fault);
    assert.deepEqual(f.events,failureAt==='guard'?['count_users','insert_user','begin','guard','rollback']:
      ['count_users','insert_user','begin','guard','fanout','insert_project','rollback']);
    assert.equal(f.state.tx,false);assert.equal(f.state.guard,null);assert.equal(f.state.pendingProject,null);
    assert.equal(f.state.project,null);assert.equal(f.state.task,null);assert.equal(f.bindings.length,0);
  });
  t.diagnostic('PG-contract double only: no driver main/import, real env, network, SQL, Host or External acceptance. Real Auth migration/trigger behavior still requires the existing real-PG/qualification route.');
});
