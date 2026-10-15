import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readCanonicalGate,assertCanonicalGateFact,createEvidenceReaders,createImmutableSourceReaderCache} from './clued-handover-external-gate-evidence.mjs';
import {repository,root,main,admissionHead,head,claim,task,project,workflow,dispatch,branch,gatePath,now,sha,iso,empty,gateOutcome,admitOutcome,content,profile,step,logs,fixture,transportFixture} from './clued-handover-external-gate-evidence.fixture.mjs';

test('actual API/log chain derives only public canonical facts; masks outside Outcome are harmless',async()=>{
  const f=fixture(),fact=await f.read();assert.equal(fact.canonical_claim_id,claim);assert.equal(fact.task_id,task);
  assert.equal(fact.claim_status,'ACTIVE');assert.equal(fact.fence,7);assert.equal(fact.checkout_main_commit,main);
  assert.equal(fact.admission_head_sha,admissionHead);assert.equal(fact.admission_run_id,'2');assert.equal(f.getCount,16);
  assert.equal(f.downloaded.length,2);assert.ok(!JSON.stringify(fact).includes('PRIVATE_SIGNED_URL'));
  assert.ok(!Object.hasOwn(fact,'claim')&&!Object.hasOwn(fact,'write_set')&&!Object.hasOwn(fact,'logs'));
  assert.equal(assertCanonicalGateFact(f.profile,fact,{now}),fact);
});
test('stored original tuple survives wall-clock expiry; fresh reader remains expired',async()=>{
  const f=fixture(),fact=await f.read(),late=now+3600000;
  assert.equal(assertCanonicalGateFact(f.profile,fact,{fresh:false,now:late}),fact);
  assert.throws(()=>assertCanonicalGateFact(f.profile,fact,{fresh:true,now:late}),/ADMISSION_EXPIRED/);
  const invalid={...fact,claim_expires_at:'2026-10-14T15:00:00Z'};
  assert.throws(()=>assertCanonicalGateFact(f.profile,invalid,{fresh:false}),/CLAIM_EXPIRED_DURING_ADMISSION/);
});
test('main publisher/revoker uses its own exact workflow/ref/head admission chain',async()=>{
  const f=fixture(),target=f.profile.qualifier_workflow;
  f.run.path='.github/workflows/'+target;f.run.head_branch='main';f.run.head_sha=main;f.gate.head_sha=main;
  f.admission.display_title='admit '+target+' main '+claim;f.gateOutcome.head_sha=main;f.admitOutcome.head_sha=main;
  f.annotations[0].message=main;
  const fact=await readCanonicalGate({profile:f.profile,runId:'1',targetWorkflow:target,targetRef:'main',targetHead:main,
    api:f.api,apiResponse:f.apiResponse,realFetch:f.realFetch,now});
  assert.equal(fact.workflow,target);assert.equal(fact.ref,'main');assert.equal(fact.head_sha,main);
  assert.equal(fact.canonical_claim_id,claim);assert.equal(fact.fence,7);
});
test('freshness is rechecked after the bounded reads rather than frozen at start',async()=>{
  const f=fixture();let reads=0;
  await assert.rejects(readCanonicalGate({profile:f.profile,runId:'1',targetWorkflow:workflow,targetRef:branch,targetHead:head,
    api:f.api,apiResponse:f.apiResponse,realFetch:f.realFetch,now:()=>reads++===0?now:now+3600000}),/ADMISSION_EXPIRED/);
});
test('missing, duplicate, truncated, masked and duplicate-key outcomes fail closed',async()=>{
  for(const kind of ['missing','multiple','truncated','masked','duplicate-key']){
    const f=fixture();let text=logs('gate',f.gateOutcome);
    if(kind==='missing')text=text.replace(/.* "mode": "gate",\n/,'');
    if(kind==='multiple')text=logs('gate',f.gateOutcome,main,{duplicate:true});
    if(kind==='truncated')text=text.slice(0,text.indexOf('Post job cleanup.'));
    if(kind==='masked')text=text.replace(claim,'***');
    if(kind==='duplicate-key')text=text.replace('  "mode": "gate",','  "mode": "gate",\n2026-10-14T16:00:49.0000001Z   "mode": "gate",');
    f.gateLog=text;await assert.rejects(f.read());
  }
});
test('Outcome in another step or under another command is never selected',async()=>{
  for(const outside of [true,false]){const f=fixture();f.gateLog=logs('gate',f.gateOutcome).replace(outside?'16:00:49.':'--mode gate',outside?'16:00:55.':'--mode required');
    await assert.rejects(f.read());}
});
test('rejected/not applicable/error verdict and unknown stdout fields are rejected',async()=>{
  for(const verdict of ['REJECTED','NOT_APPLICABLE','ERROR']){const f=fixture();f.gateOutcome.verdict=verdict;await assert.rejects(f.read());}
  const f=fixture();f.gateOutcome.extra='NO_EXTRA_DTO';await assert.rejects(f.read(),/OUTCOME_FIELDS/);
});
test('claim Task/Scope/fence/status/bound PR are exact canonical identities',async()=>{
  for(const [field,value]of [['task_id',claim],['status','DRAINING'],['status','active'],['fence',0],['fence',Number.MAX_SAFE_INTEGER+1],['bound_pr','other/repo#999']]){
    const f=fixture();f.admitOutcome.claim[field]=value;await assert.rejects(f.read());}
  const f=fixture();f.admitOutcome.scope='global';await assert.rejects(f.read());
});
test('wrong Actor, attempt, title, workflow, ref, head, or stale admission cannot substitute',async()=>{
  for(const change of [f=>f.run.actor={id:99},f=>f.admission.run_attempt=2,f=>f.admission.display_title='admit other main '+claim,
    f=>f.admission.path='.github/workflows/other.yml',f=>f.admission.head_branch='other',f=>f.run.head_sha=main,
    f=>f.admission.created_at='2026-10-14T15:00:00Z']){const f=fixture();change(f);await assert.rejects(f.read());}
});
test('admitted head needs one exact notice annotation and matching native notice',async()=>{
  for(const notes of [[],[{title:'clued-admitted-head',message:main,annotation_level:'notice'}],
    [{title:'clued-admitted-head',message:head,annotation_level:'notice'},{title:'clued-admitted-head',message:head,annotation_level:'notice'}]]){
    const f=fixture();f.annotations=notes;await assert.rejects(f.read());}
  const f=fixture();f.admitLog=logs('dispatch-admit',f.admitOutcome).replace('##[notice]'+head,'##[notice]'+main);await assert.rejects(f.read(),/ADMITTED_NOTICE_HEAD_MISMATCH/);
});
test('actual checkoutmain and immutable source raw hashes must bind accepted Source',async()=>{
  const wrong=fixture();wrong.gateLog=logs('gate',wrong.gateOutcome,admissionHead);await assert.rejects(wrong.read(),/GATE_CHECKOUT_SOURCE_MISMATCH/);
  const hash=fixture();hash.profile.gate_source_pins[gatePath]='f'.repeat(64);await assert.rejects(hash.read(),/SOURCE_NOT_ACCEPTED/);
  const bytes=fixture();bytes.sourceMutator=file=>{file.content=Buffer.from('DIFFERENT_BYTES').toString('base64');};await assert.rejects(bytes.read());
});
test('unaccepted hosts, non-HTTPS, URL authority, redirects and API permission failure do not download',async()=>{
  for(const url of ['https://evil.example/file','http://results-receiver.actions.githubusercontent.com/file',
    'https://user:PRIVATE@results-receiver.actions.githubusercontent.com/file','https://results-receiver.actions.githubusercontent.com:444/file']){
    const f=fixture();f.signedUrl=url;await assert.rejects(f.read());assert.equal(f.downloaded.length,0);}
  for(const status of [200,403,404]){const f=fixture();f.status=status;await assert.rejects(f.read(),/LOG_API_REDIRECT_REQUIRED/);}
  const f=fixture();f.profile.fixture_selection_policy.log_download_policy='caller_url_v1';await assert.rejects(f.read(),/LOG_DOWNLOAD_POLICY_NOT_ACCEPTED/);assert.equal(f.getCount,0);
  const redirected=fixture();redirected.downloadMutator=text=>{const response=new Response(text,{headers:{'content-type':'text/plain'}});
    Object.defineProperty(response,'redirected',{value:true});return response;};await assert.rejects(redirected.read(),/LOG_DOWNLOAD_REDIRECTED/);
});
test('complete bounded stream rejects over-limit, incomplete length, invalid UTF8 and truncated marker',async()=>{
  for(const mutate of [text=>new Response(text,{headers:{'content-type':'text/plain','content-length':String(Buffer.byteLength(text)+1)}}),
    ()=>new Response('x'.repeat(262145),{headers:{'content-type':'text/plain'}}),
    ()=>new Response(Buffer.from([0xff,0x0a]),{headers:{'content-type':'text/plain'}}),
    text=>new Response(text+'2026-10-14T16:00:50Z [truncated]\n',{headers:{'content-type':'text/plain'}})]){
    const f=fixture();f.downloadMutator=mutate;await assert.rejects(f.read());}
});
test('network errors redact signed download URL and DTO serialization errors retain no original content',async()=>{
  const f=fixture();f.realFetch=async()=>{throw new Error('failed '+f.signedUrl);};await assert.rejects(f.read(),error=>error.message==='LOG_DOWNLOAD_FAILED');
  const g=fixture();g.gateLog=logs('gate',g.gateOutcome).replace('  "mode": "gate",',' "mode": "gate",');
  await assert.rejects(g.read(),error=>error.message==='OUTCOME_NOT_CANONICAL_STDOUT'&&!error.message.includes(claim));
});
test('unbranded uppercase or multiline transport errors cannot supply public error code or message',async()=>{
  for(const message of ['MOCK_PRIVATE_UPPERCASE_VALUE','MOCK_PRIVATE_UPPERCASE_VALUE\nprivate second line',
    'ADMISSION_EXPIRED\nprivate second line']){
    const readers=createEvidenceReaders({repository,token:'MOCK_GITHUB_ONLY',
      realFetch:async()=>{throw new Error(message);}});
    for(const invoke of [()=>readers.api(root+'/actions/runs/1'),
      ()=>readers.apiResponse(root+'/actions/jobs/11/logs',{redirect:'manual'})]){
      await assert.rejects(invoke(),error=>error.message==='GITHUB_API_GET_FAILED'&&error.code==='GITHUB_API_GET_FAILED'
        &&!JSON.stringify(error).includes('MOCK_PRIVATE')&&!error.stack.includes('private second line'));
    }
    const f=fixture();f.api=async()=>{throw new Error(message);};
    await assert.rejects(f.read(),error=>error.message==='CANONICAL_GATE_EVIDENCE_REJECTED'
      &&error.code==='CANONICAL_GATE_EVIDENCE_REJECTED'&&!error.stack.includes('private second line'));
  }
  const f=fixture();f.api=async()=>{throw {get message(){throw new Error('MOCK_PRIVATE_GETTER_VALUE');}};};
  await assert.rejects(f.read(),error=>error.message==='CANONICAL_GATE_EVIDENCE_REJECTED');
});
test('native storage family permits dynamic actual origins and freezes each observed origin as a fact',async()=>{
  const f=fixture();let index=0;
  const origins=['https://first-storage.blob.core.windows.net','https://second-results.actions.githubusercontent.com'];
  f.apiResponse=async(route,options)=>{
    f.getCount++;assert.equal(options.redirect,'manual');
    assert.ok([root+'/actions/jobs/11/logs',root+'/actions/jobs/21/logs'].includes(route));
    return new Response(null,{status:302,headers:{location:origins[index++]+'/private/signed?sig=MOCK_ONLY'}});
  };
  const first=await f.read();assert.equal(first.gate_log_download_origin,origins[0]);assert.equal(first.admission_log_download_origin,origins[1]);
  const later={...first,gate_log_download_origin:'https://later-storage.blob.core.windows.net',
    admission_log_download_origin:'https://different-results.actions.githubusercontent.com'};
  assert.equal(assertCanonicalGateFact(f.profile,later,{fresh:false}),later,'new fresh Main may have different origins; caller compares canonical core only');
  for(const origin of ['https://api.github.com','https://github.com'])
    assert.equal(assertCanonicalGateFact(f.profile,{...first,gate_log_download_origin:origin},{fresh:false}).gate_log_download_origin,origin);
});
test('caller-selected URL or untrusted suffix cannot replace the one native job redirect',async()=>{
  for(const url of ['https://evil.blob.core.windows.net.attacker.example/log','https://evil.actions.githubusercontent.com.attacker.example/log',
    'https://blob.core.windows.net/log','https://actions.githubusercontent.com/log','https://github.com:444/log','https://api.github.com/log#fragment']){
    const f=fixture();f.signedUrl=url;await assert.rejects(f.read());assert.equal(f.downloaded.length,0);
  }
  const f=fixture();f.profile.fixture_selection_policy.log_download_url='https://trusted.blob.core.windows.net/caller';
  await assert.rejects(f.read(),/FIXTURE_POLICY_FIELDS/);assert.equal(f.getCount,0);
  const p=fixture();delete p.profile.gate_source_pins['scripts/ci/clued-gated-proof-runtime.mjs'];
  await assert.rejects(p.read(),/ACCEPTED_SOURCE_HASH_MISSING/);assert.equal(p.getCount,0);
});
test('native job detail id/run/attempt/completed/conclusion must still match immediately before the 302',async()=>{
  for(const [field,value]of [['id',99],['run_id',99],['run_attempt',2],['status','in_progress'],['conclusion','failure']]){
    const f=fixture(),api=f.api;let redirects=0;
    f.api=async route=>route===root+'/actions/jobs/11'?{...f.gate,[field]:value}:api(route);
    f.apiResponse=async()=>{redirects++;throw new Error('MUST_NOT_REQUEST_LOCATION');};
    await assert.rejects(f.read());assert.equal(redirects,0);assert.equal(f.downloaded.length,0);
  }
});
test('stored origins contain only canonical public origins, never signed URL paths or parameters',async()=>{
  const f=fixture(),fact=await f.read();
  for(const value of ['https://good.blob.core.windows.net/log?sig=PRIVATE','https://user:PRIVATE@good.blob.core.windows.net',
    'http://good.blob.core.windows.net','https://good.blob.core.windows.net:444','https://evil.example'])
    assert.throws(()=>assertCanonicalGateFact(f.profile,{...fact,gate_log_download_origin:value},{fresh:false}));
  assert.ok(!JSON.stringify(fact).includes('sig=')&&!JSON.stringify(fact).includes('PRIVATE_SIGNED_URL'));
});

test('fixed evidence readers share the original GET160 transport; repeat chain keeps all mutable reads',async()=>{
  const t=transportFixture(),shared=createImmutableSourceReaderCache({repository});
  const first=createEvidenceReaders({repository,token:t.token,realFetch:t.realFetch,sourceCache:shared});
  const read=readers=>readCanonicalGate({profile:t.f.profile,runId:'1',targetWorkflow:workflow,targetRef:branch,targetHead:head,
    ...readers,realFetch:t.realFetch,now});
  const fact1=await read(first);assert.equal(t.count,16);assert.equal(shared.size,5);
  const second=createEvidenceReaders({repository,token:t.token,realFetch:t.realFetch,sourceCache:shared});
  const fact2=await read(second);assert.equal(t.count,27);assert.deepEqual(fact2,fact1);
  assert.equal(t.hits.filter(hit=>hit.path.endsWith('/logs')).length,4,'302 logs must never cache');
  assert.equal(t.hits.filter(hit=>hit.path.startsWith('/job/')).length,4,'signed bytes must never cache');
  assert.equal(t.hits.filter(hit=>hit.path.endsWith('/actions/runs/1')).length,2,'run must never cache');
  for(let i=t.count;i<160;i++)await second.api(root+'/actions/runs/1');
  assert.equal(t.count,160);await assert.rejects(second.api(root+'/actions/runs/1'),/GITHUB_API_GET_FAILED/);assert.equal(t.count,160);
});
test('shared immutable source hits reduce a different main target chain to twelve GETs',async()=>{
  const t=transportFixture(),shared=createImmutableSourceReaderCache({repository}),r=createEvidenceReaders({repository,token:t.token,realFetch:t.realFetch,sourceCache:shared});
  await readCanonicalGate({profile:t.f.profile,runId:'1',targetWorkflow:workflow,targetRef:branch,targetHead:head,...r,realFetch:t.realFetch,now});
  const target=t.f.profile.qualifier_workflow;
  t.f.run.path='.github/workflows/'+target;t.f.run.head_branch='main';t.f.run.head_sha=main;t.f.gate.head_sha=main;
  t.f.admission.display_title='admit '+target+' main '+claim;t.f.gateOutcome.head_sha=main;t.f.admitOutcome.head_sha=main;t.f.annotations[0].message=main;
  await readCanonicalGate({profile:t.f.profile,runId:'1',targetWorkflow:target,targetRef:'main',targetHead:main,...r,realFetch:t.realFetch,now});
  assert.equal(t.count,28);assert.equal(shared.size,6,'second target has one new immutable key');
});
test('immutable cache is capped at 64 complete verified entries, returns clones and excludes mutable routes',()=>{
  assert.throws(()=>createImmutableSourceReaderCache({repository,maxEntries:65}),/SOURCE_CACHE_LIMIT_INVALID/);
  const c=createImmutableSourceReaderCache({repository}),routes=[];
  for(let i=1;i<=64;i++){
    const route=root+'/contents/'+gatePath+'?ref='+i.toString(16).padStart(40,'0');routes.push(route);
    assert.equal(c.remember(route,content(gatePath)),true);
  }
  assert.equal(c.size,64);assert.equal(c.remember(root+'/contents/'+gatePath+'?ref='+'f'.repeat(40),content(gatePath)),false);
  assert.equal(c.size,64);const clone=c.get(routes[0]);clone.content='MUTATED_CALLER_COPY';
  assert.notEqual(c.get(routes[0]).content,clone.content);
  for(const route of [root+'/actions/runs/1',root+'/pulls/999',root+'/actions/jobs/11/logs']){
    assert.equal(c.remember(route,content(gatePath)),false);assert.equal(c.get(route),undefined);
  }
});
test('cache only accepts exact immutable routes and complete source DTOs; conflicting bytes fail',()=>{
  const c=createImmutableSourceReaderCache({repository}),route=root+'/contents/'+gatePath+'?ref='+main;
  for(const [path,dto]of [[route+'&other=1',content(gatePath)],[root+'/contents/unknown.mjs?ref='+main,content('unknown.mjs')],
    [route,{...content(gatePath),extra:'UNKNOWN_FIELD'}],[route,{...content(gatePath),size:1}],
    [route,{...content(gatePath),sha:'f'.repeat(40)}],[route,{...content(gatePath),content:'AA=A'}]]){
    assert.equal(c.remember(path,dto),false);assert.equal(c.size,0);
  }
  const observed={...content(gatePath),download_url:'https://raw.githubusercontent.com/public',_links:{self:'public'}};
  assert.equal(c.remember(route,observed),true);assert.ok(!Object.hasOwn(c.get(route),'download_url'));
  const other=content(gatePath);const bytes=Buffer.from('OTHER_VALID_SOURCE\n');other.content=bytes.toString('base64');other.size=bytes.length;
  other.sha=crypto.createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
  assert.throws(()=>c.remember(route,other),/IMMUTABLE_SOURCE_CONTENT_CONFLICT/);
});
test('source hits still pass final accepted raw pins, and invalid paths never consume transport',async()=>{
  const t=transportFixture(),r=createEvidenceReaders({repository,token:t.token,realFetch:t.realFetch});
  await r.api(root+'/contents/'+gatePath+'?ref='+main);
  t.f.profile.gate_source_pins[gatePath]='f'.repeat(64);
  await assert.rejects(readCanonicalGate({profile:t.f.profile,runId:'1',targetWorkflow:workflow,targetRef:branch,targetHead:head,
    ...r,realFetch:t.realFetch,now}),/SOURCE_NOT_ACCEPTED/);
  const before=t.count;
  for(const route of ['https://evil.example/file','/repos/other/repo/actions/runs/1',root+'/contents/../secret?ref='+main,
    root+'/contents/'+gatePath+'?ref=main',root+'/actions/jobs/11/logs'])await assert.rejects(r.api(route),/GITHUB_JSON_ROUTE_NOT_ALLOWED/);
  await assert.rejects(r.apiResponse(root+'/actions/runs/1/logs'),/GITHUB_LOG_ROUTE_NOT_ALLOWED/);
  await assert.rejects(r.apiResponse(root+'/actions/jobs/11/logs',{redirect:'follow'}));assert.equal(t.count,before);
});
test('mutable PR responses remain current and unknown source DTO fields are never cached',async()=>{
  let calls=0,current=1;
  const source=content(gatePath);
  const r=createEvidenceReaders({repository,token:'MOCK',realFetch:async(url,options)=>{
    calls++;const body=url.includes('/contents/')?{...source,unknown_field:'NO_CACHE'}:{number:current++};
    return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
  }});
  assert.equal((await r.api(root+'/pulls/999')).number,1);assert.equal((await r.api(root+'/pulls/999')).number,2);
  const route=root+'/contents/'+gatePath+'?ref='+main;
  await r.api(route);await r.api(route);assert.equal(calls,4);assert.equal(r.sourceCache.size,0);
});
