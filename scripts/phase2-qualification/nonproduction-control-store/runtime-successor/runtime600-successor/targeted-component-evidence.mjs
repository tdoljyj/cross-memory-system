// One local engineering observation of five missing raw fault/transaction records.
// Never an outer GA entry, real Root, issuer, credential, Skill or production channel.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createBudgetStore,projectRef,rootId} from '../budget-reservation-successor/client.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../../../../..');
const require=createRequire(path.join(repo,'apps/clued-cloud/package.json'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const nonce=crypto.randomBytes(16).toString('hex'),folder=path.join(here,'work',nonce),data=path.join(folder,'data'),temp=path.join(folder,'temp');
fs.mkdirSync(folder,{recursive:true});fs.mkdirSync(temp);
const fixedEnv={SystemRoot:'C:\\Windows',WINDIR:'C:\\Windows',TEMP:temp,TMP:temp,PATH:'C:\\Windows\\System32',ComSpec:'C:\\Windows\\System32\\cmd.exe',HOMEDRIVE:'',HOMEPATH:'',LOGONSERVER:'',SYSTEMDRIVE:'C:',USERDOMAIN:'',USERNAME:'',USERPROFILE:'',LC_MESSAGES:'C',LANG:'C',PGPASSFILE:path.join(folder,'empty-auth'),PGSERVICEFILE:path.join(folder,'empty-auth')};
fs.writeFileSync(fixedEnv.PGPASSFILE,'',{flag:'wx'});
// The test's child processes and pg defaults cannot inherit host credentials.
for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,fixedEnv);
const {Client}=require('pg');
const native=path.join(repo,'apps/clued-cloud/node_modules/@embedded-postgres/windows-x64/native/bin');
const binary={initdb:path.join(native,'initdb.exe'),postgres:path.join(native,'postgres.exe'),pg_ctl:path.join(native,'pg_ctl.exe')};
const started=Date.now(),deadline=started+30000,clients=[],rawEvents=[];
const persist=(name,value)=>{const fd=fs.openSync(path.join(folder,name),'wx');try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
const sourceRefs=['../../install.candidate.sql','../budget-reservation-successor/install.candidate.sql','alter.candidate.sql','targeted-component-evidence.mjs'].map(p=>{const full=path.resolve(here,p),b=fs.readFileSync(full);return{path:full,sha256:hash(b),bytes:b.length};});
persist('Intent.json',{kind:'L26_SYNTHETIC_COMPONENT_ENGINEERING_OBSERVATION',nonce,started_at:new Date(started).toISOString(),deadline:new Date(deadline).toISOString(),sourceRefs,binaries:Object.fromEntries(Object.entries(binary).map(([k,p])=>[k,{path:p,sha256:hash(fs.readFileSync(p))}])),outer_ga:null,authority_effect:'NONE'});
function run(exe,args,max=6000){return new Promise((resolve,reject)=>{
 const remaining=Math.min(max,deadline-Date.now());if(remaining<=0)return reject(Error('engineering_deadline'));
 const p=spawn(exe,args,{env:fixedEnv,windowsHide:true,stdio:['ignore','pipe','pipe'],cwd:folder});let out='',err='';
 const timer=setTimeout(()=>{p.kill();reject(Error('process_timeout_unknown'));},remaining);
 p.stdout.on('data',b=>{out+=b;if(out.length>262144)p.kill();});p.stderr.on('data',b=>{err+=b;if(err.length>262144)p.kill();});
 p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('exit',code=>{clearTimeout(timer);resolve({exit_code:code,stdout:out,stderr:err,pid:p.pid});});
});}
const availablePort=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;};
const password=crypto.randomBytes(32).toString('hex');
let server=null,port=null,stop=null;
const queries=[];
const wrap=client=>async(sql,values=[])=>{const record={at:new Date().toISOString(),connection:clients.indexOf(client),sql,values};try{const r=await client.query(sql,values);record.rows=r.rows;queries.push(record);return r;}catch(e){record.error={code:e.code??null,message:e.message};queries.push(record);throw e;}};
try{
 // Windows named pipe keeps the random password out of argv, files and evidence.
 const pipe='\\\\.\\pipe\\clued-component-password-'+nonce;
 const secretServer=net.createServer(socket=>socket.end(password+'\n'));
 await new Promise((resolve,reject)=>{secretServer.once('error',reject);secretServer.listen(pipe,resolve);});
 let init;try{init=await run(binary.initdb,['-D',data,'--auth=scram-sha-256','--username=postgres','--pwfile='+pipe,'--no-locale','--encoding=UTF8','--wal-segsize=1'],10000);}finally{await new Promise(r=>secretServer.close(r));}
 persist('Initdb.json',init);assert.equal(init.exit_code,0);
 port=await availablePort();
 const args=['-D',data,'-p',String(port),'-h','127.0.0.1','-c','io_method=sync','-c','shared_buffers=16MB','-c','work_mem=1MB','-c','maintenance_work_mem=16MB','-c','max_connections=6','-c','autovacuum=off','-c','max_wal_size=8MB','-c','min_wal_size=2MB','-c','fsync=on','-c','synchronous_commit=on'];
 server=spawn(binary.postgres,args,{env:fixedEnv,windowsHide:true,stdio:['ignore','pipe','pipe'],cwd:folder});
 let serverOut='',serverErr='';server.stdout.on('data',b=>{serverOut+=b;});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('PG_start_unknown')),5000);server.once('error',e=>{clearTimeout(timer);reject(e);});server.once('exit',()=>{clearTimeout(timer);reject(Error('PG_exited_before_ready'));});server.stderr.on('data',b=>{serverErr+=b;if(serverErr.includes('database system is ready to accept connections')){clearTimeout(timer);resolve();}});});
 persist('PostgresStarted.json',{at:new Date().toISOString(),pid:server.pid,port,host:'127.0.0.1',data_directory:data,args,stdout:serverOut,stderr:serverErr,environment_keys:Object.keys(fixedEnv),inherited_credentials:false,authority_effect:'NONE'});
 const connect=async()=>{const c=new Client({host:'127.0.0.1',port,user:'postgres',password,database:'postgres',ssl:false,connectionTimeoutMillis:2000,query_timeout:3000});clients.push(c);await c.connect();return c;};
 const admin=await connect(),writer=await connect(),other=await connect();
 const aq=wrap(admin),wq=wrap(writer),oq=wrap(other),store=createBudgetStore({project:projectRef,query:wq}),second=createBudgetStore({project:projectRef,query:oq});
 await aq('create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls');
 await aq("set clued_control.target_project='uscrdifznmlvczcekqpw'");
 // Install exact observed components into this throwaway process only.
 await admin.query(fs.readFileSync(path.resolve(here,'../../install.candidate.sql'),'utf8'));
 await admin.query(fs.readFileSync(path.resolve(here,'../budget-reservation-successor/install.candidate.sql'),'utf8'));
 const h='a'.repeat(64),gen='ctrgen_dd30fbc7e0ba43fa8ba9f734867bcf12';
 await aq(`insert into clued_control.accepted_binding values($1,$2,'SKILL_COEXISTENCE_QUALIFICATION','ISOLATED_TEST','e4ab25ecb1fa6709435d0318ad431d14343482cbe84e232f638e55c3c4ba1e1f','4d7f93c17cf7d126e771cf8aca6299c868cba0a9',clock_timestamp()-interval '1 minute',least(clock_timestamp()+interval '30 minutes','2026-09-09T09:28:59Z'),'SYNTHETIC_ISSUER','SYNTHETIC_AUDIENCE','SYNTHETIC_CONFIG',$3,$3,$3,$3,$3)`,[rootId,projectRef,h]);
 await aq('insert into clued_control.current_head values($1,2,$2,false)',[rootId,gen]);
 await aq('begin');await admin.query(fs.readFileSync(path.join(here,'alter.candidate.sql'),'utf8'));await aq('commit');
 await aq("insert into clued_control.execution_binding values($1,$2,$2,$2,$2,'G-PREENTRY-SKILL-QUALIFICATION','SYNTHETIC_NOT_ACCEPTED',$2,$2,1500,287700424)",[rootId,h]);
 await aq("insert into clued_control.execution_current values($1,'runner-initial','credential-initial','session-initial',0,null,null,1500,287700424)",[rootId]);
 await wq('set role service_role');await oq('set role service_role');
 const sm={object_type:'StatusManifest',schema_version:'1.0',schema_digest:'6ba12ed51b3fc0e457c13e83f47e1ad1aa6cc680d8f28c668f8c65d12742ecc2',status_manifest_id:'sm_component',issuer_purpose:'STATUS',audience:'urn:clued:audience:skill-coexistence-qualification:'+projectRef,control_trust_root_generation:gen,generation:1,as_of:new Date(Date.now()-1000).toISOString(),expires_at:new Date(Date.now()+600000).toISOString(),signature_binding:{synthetic_only:true}};
 const smRaw=JSON.stringify(sm)+'\n';await store.appendStatus(smRaw);
 const allocation={controller_digest:h,credential_generation:'credential-initial',environment:'ISOLATED_TEST',evidence_bytes:134217728,expires_at:new Date(Date.now()+600000).toISOString(),idempotency_key:'engineering_budget',not_before:new Date(Date.now()-1000).toISOString(),profile_digest:h,purpose:'SKILL_COEXISTENCE_QUALIFICATION',root_generation:gen,runner_generation:'runner-initial',scope_digest:h,seconds:600,session_generation:'session-initial'};
 const ga={gate_authorization_id:'ga_component',idempotency_key:'component',authorization_status:'AUTHORIZED',purpose:'SKILL_COEXISTENCE_QUALIFICATION',environment:'ISOLATED_TEST',profile_digest:h,controller_digest:h,scope_digest:h,gate_id:'G-PREENTRY-SKILL-QUALIFICATION',controller_qualification_ref:{sha256:h},control_trust_root_generation:gen,runner_generation:'runner-initial',credential_generation:'credential-initial',session_generation:'session-initial',issued_at:new Date(Date.now()-100).toISOString(),deadline:new Date(Date.now()+1800).toISOString(),expires_at:new Date(Date.now()+1800).toISOString(),status_manifest_ref:{uri:'control://status-manifests/sm_component',sha256:hash(smRaw)}};
 const record=async(id,action)=>{const from=queries.length,before=await store.read(),at=new Date().toISOString();await action();const after=await second.read();const value={case_id:id,kind:'ACTUAL_SYNTHETIC_COMPONENT_OBSERVATION_NOT_OUTER_GA_EXECUTION',started_at:at,ended_at:new Date().toISOString(),before,queries:queries.slice(from),after,original_source_refs:sourceRefs,authority_effect:'NONE'};persist(id+'.json',value);rawEvents.push({case_id:id,path:path.join(folder,id+'.json'),sha256:hash(fs.readFileSync(path.join(folder,id+'.json')))});};
 await record('PQUAL-11',async()=>{
  await assert.rejects(store.reserveExactGa(JSON.stringify(ga)+'\n'),/actual_pending_budget_required/);
  await assert.rejects(store.reserveBudget(JSON.stringify({...allocation,seconds:601})+'\n'),/fixed_budget_scope_required/);
  const reserved=await store.reserveBudget(JSON.stringify(allocation)+'\n');ga.budget_reservation_ref=reserved.budget_reservation_ref;
  assert.equal((await second.reserveBudget(JSON.stringify(allocation)+'\n')).status,'DUPLICATE');assert.equal((await store.read()).current.charged_seconds,2100);
 });
 await store.reserveExactGa(JSON.stringify(ga)+'\n');
 const intentRaw=JSON.stringify({ga_id:ga.gate_authorization_id,ga_sha256:hash(JSON.stringify(ga)+'\n'),operation:'CREATE'})+'\n';
 const intent={operation:'CREATE',raw:intentRaw,sha256:hash(intentRaw)};
 await record('PQUAL-17',async()=>{
  const count=(await store.read()).events.length;await wq('begin read only');
  await assert.rejects(store.recordIntent({gaId:ga.gate_authorization_id,key:'sink_readonly',body:intent}),/read-only transaction/);await wq('rollback');
  assert.equal((await second.read()).events.length,count);
  await assert.rejects(wq('delete from clued_control.execution_events'),/permission denied/);
  assert.equal((await second.read()).attempts[0].phase,'PENDING');
 });
 let sent;
 await record('PQUAL-16',async()=>{
  const saved=await store.recordIntent({gaId:ga.gate_authorization_id,key:'intent_original',body:intent});
  assert.equal((await second.read()).events.at(-1).request.body.raw,intentRaw);
  sent=await store.dispatchIntent({gaId:ga.gate_authorization_id,operation:'CREATE',key:'sent_original',sequence:saved.sequence,digest:intent.sha256});
  queries.push({at:new Date().toISOString(),synthetic_transport_fault:'response lost after actual committed CREATE_SENT; no Docker call is made in this component fixture'});
  const state=await second.read();await store.transition({ga_id:ga.gate_authorization_id,idempotency_key:'unknown',operation:'UNKNOWN',body:{},expected_sequence:state.current.sequence});
  await assert.rejects(second.dispatchIntent({gaId:ga.gate_authorization_id,operation:'CREATE',key:'new_blind_send',sequence:saved.sequence,digest:intent.sha256}),/phase_conflict/);
  assert.equal((await store.read()).current.active_ga_id,ga.gate_authorization_id);
  assert.equal((await store.read()).events.filter(e=>e.request.operation==='CREATE_SENT').length,1);
 });
 await record('PQUAL-13',async()=>{
  const before=await store.read();await second.rotate({idempotency_key:'rotate',expected_sequence:before.current.sequence,generation_kind:'credential_generation',previous:'credential-initial',replacement:'credential-next',signed_source_sha256:h});
  await assert.rejects(store.transition({ga_id:ga.gate_authorization_id,idempotency_key:'stale_effect',operation:'CREATE_SENT',body:{},expected_sequence:(await store.read()).current.sequence}),/current_authority_or_generation_changed/);
  await assert.rejects(second.rotate({idempotency_key:'rollback',expected_sequence:(await store.read()).current.sequence,generation_kind:'credential_generation',previous:'credential-next',replacement:'credential-initial',signed_source_sha256:h}),/generation_rollback_or_conflict/);
 });
 // Restore only synthetic fixture setup, never a current real Root/generation.
 await aq("update clued_control.execution_current set credential_generation='credential-initial' where root_id=$1",[rootId]);
 await record('PQUAL-15',async()=>{
  const old=await store.read();await assert.rejects(store.transition({ga_id:ga.gate_authorization_id,idempotency_key:'wrong_renew',operation:'RENEW_WITH_NEW_FENCE',body:{},expected_sequence:old.current.sequence}),/unsupported_transition/);
  const wait=Math.max(0,Date.parse(ga.deadline)-Date.now()+20);await new Promise(r=>setTimeout(r,wait));
  const expired=await second.read();assert.equal(expired.current.active_ga_id,ga.gate_authorization_id);assert.equal(expired.current.charged_seconds,2100);assert.equal(expired.attempts[0].phase,'UNKNOWN');assert.equal(expired.current.credential_generation,old.current.credential_generation);
 });
}catch(error){persist('Failure.json',{at:new Date().toISOString(),error:{message:error.message,stack:error.stack},queries,completed:rawEvents,authority_effect:'NONE'});process.exitCode=1;}
finally{
 for(const c of clients)await c.end().catch(()=>{});
 if(server){stop=await run(binary.pg_ctl,['-D',data,'-m','fast','-w','-t','5','stop'],6000).catch(e=>({state:'UNKNOWN',message:e.message}));persist('Stop.json',stop);if(stop.exit_code!==0)process.exitCode=1;}
 const status=server?await run(binary.pg_ctl,['-D',data,'status'],2000).catch(e=>({state:'UNKNOWN',message:e.message})):null;
 const result={kind:'ACTUAL_ENGINEERING_COMPONENT_EVIDENCE',started_at:new Date(started).toISOString(),ended_at:new Date().toISOString(),elapsed_ms:Date.now()-started,completed:rawEvents,original_sources:sourceRefs,postgres_pid:server?.pid??null,port,stop,status,stopped:!!server&&stop?.exit_code===0&&status?.exit_code===3,outer_ga:null,pqual_pass_issued:false,authority_effect:'NONE'};
 persist('Result.json',result);console.log(JSON.stringify({folder,completed:rawEvents.length,stopped:result.stopped,result_sha256:hash(fs.readFileSync(path.join(folder,'Result.json'))),elapsed_ms:result.elapsed_ms}));
}
