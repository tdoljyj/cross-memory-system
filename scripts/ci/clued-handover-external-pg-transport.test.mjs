import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {FIXED_PG_TRANSPORT,PG_CA_SHA256,PG_IDENTITY_SQL,preparePgTransport,makePgClientConfig,assertPgTransportProfile,assertPgIdentity}
  from './clued-handover-external-pg-transport.mjs';
import {platformDescriptor} from './clued-handover-external-bootstrap.mjs';
const sourceDir=path.dirname(fileURLToPath(import.meta.url));
const uri='postgresql://postgres.qhddedibkuqoiiwlonwe:MOCK_ONLY_PASSWORD@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres';
const row=database=>({rows:[{database,current_user:'postgres',session_user:'postgres'}]});
test('composed public platform descriptor uses the new transport without granting qualification or early locator authority',()=>{
  const profile=JSON.parse(fs.readFileSync(path.resolve(sourceDir,'../../config/clued-handover-external-profile.json'),'utf8'));
  const descriptor=platformDescriptor(profile);assert.equal(descriptor.transport,'supabase-session-pooler-tls');
  assert.equal(descriptor.login,'postgres.qhddedibkuqoiiwlonwe');assert.equal(descriptor.canonical_role,'postgres');
  assert.equal(profile.qualified,false);for(const field of ['pr_number','head_sha','disposable_branch','idle_run_id'])assert.equal(profile[field],null);
  assert.throws(()=>platformDescriptor({...profile,database_transport:'direct-session-tls'}));
});
test('fixed public profile separates alias login from canonical postgres role',()=>{
  assertPgTransportProfile({...FIXED_PG_TRANSPORT});
  for(const [key,value]of [['database_host','db.qhddedibkuqoiiwlonwe.supabase.co'],['database_port',6543],
    ['supabase_project_ref','differentprojectref00'],['database_login','postgres.otherproject'],
    ['provisioner_role',FIXED_PG_TRANSPORT.database_login],['database_name','template1'],
    ['database_transport','direct-session-tls']])
    assert.throws(()=>assertPgTransportProfile({...FIXED_PG_TRANSPORT,[key]:value}),/PG_TRANSPORT_PROFILE_REJECTED/);
});
test('pinned CA produces explicit TLS postgres-negotiation config for exactly two DBs without connectionString',()=>{
  const prepared=preparePgTransport({...FIXED_PG_TRANSPORT});
  for(const database of ['postgres','template1']){
    const cfg=makePgClientConfig(prepared,uri,{database}),observed=[];
    class FakeClient{constructor(config){observed.push(config);}}
    new FakeClient(cfg);assert.equal(observed.length,1);assert.equal(cfg.host,FIXED_PG_TRANSPORT.database_host);
    assert.equal(cfg.user,FIXED_PG_TRANSPORT.database_login);assert.equal(cfg.database,database);
    assert.equal(cfg.ssl.servername,cfg.host);assert.equal(cfg.ssl.rejectUnauthorized,true);assert.equal(cfg.sslnegotiation,'postgres');
    assert.equal(crypto.createHash('sha256').update(cfg.ssl.ca).digest('hex'),PG_CA_SHA256);
    assert.equal(Object.hasOwn(cfg,'connectionString'),false);assert.equal(cfg.password,'MOCK_ONLY_PASSWORD');
  }
  assert.throws(()=>makePgClientConfig(prepared,uri,{database:'template0'}),/PG_DATABASE_REJECTED/);
  assert.throws(()=>makePgClientConfig({...prepared},uri,{database:'postgres'}),/PG_TRANSPORT_NOT_PREPARED/);
});
test('wrong host/alias/port/database/query/hash/additional options/empty password and malformed ingress fail without echo',()=>{
  const prepared=preparePgTransport({...FIXED_PG_TRANSPORT});
  for(const raw of [uri.replace('aws-0-','aws-1-'),uri.replace('qhddedibkuqoiiwlonwe:','otherproject:'),uri.replace(':5432/',':6543/'),
    uri.replace('/postgres','/template1'),uri+'?sslmode=disable',uri+'?options=PRIVATE_VALUE',uri+'?',uri+'#PRIVATE_FRAGMENT',uri+'#',
    uri.replace(':MOCK_ONLY_PASSWORD@',':@'),'PRIVATE_INVALID_URI_VALUE']){
    assert.throws(()=>makePgClientConfig(prepared,raw,{database:'postgres'}),error=>error.message==='PG_INGRESS_REJECTED'
      &&!JSON.stringify(error).includes('PRIVATE')&&!error.stack.includes('MOCK_ONLY_PASSWORD'));
  }
});
test('identity query is supplied to the caller; exact one-row real DB and canonical session roles are required',()=>{
  assert.equal(PG_IDENTITY_SQL,'SELECT current_database() AS database, current_user AS "current_user", session_user AS "session_user"');
  for(const database of ['postgres','template1'])assert.deepEqual(assertPgIdentity(row(database),database),row(database).rows[0]);
  for(const result of [{rows:[]},{rows:[...row('postgres').rows,...row('postgres').rows]},row('postgres'),
    {rows:[{database:'template1',current_user:FIXED_PG_TRANSPORT.database_login,session_user:'postgres'}]},
    {rows:[{database:'template1',current_user:'postgres',session_user:FIXED_PG_TRANSPORT.database_login}]},
    {rows:[{database:'template1',current_user:'postgres',session_user:'postgres',extra:'PRIVATE'}]}])
    assert.throws(()=>assertPgIdentity(result,'template1'),error=>error.message==='PG_IDENTITY_REJECTED');
});
test('caller first identity goes through its original query wrapper; failure closes fake client before later SQL',async()=>{
  const queries=[];let ended=0,later=0;
  const client={query:async sql=>{queries.push(sql);return row('postgres');},end:async()=>{ended++;}};
  const wrapper=async sql=>client.query(sql);
  try{assertPgIdentity(await wrapper(PG_IDENTITY_SQL),'template1');later++;await wrapper('LATER_SQL_MUST_NOT_EXECUTE');}
  catch(error){await client.end();assert.equal(error.message,'PG_IDENTITY_REJECTED');}
  assert.deepEqual(queries,[PG_IDENTITY_SQL]);assert.equal(ended,1);assert.equal(later,0);
});
test('missing, changed and symlink CA refuse preparation before secret ingress or Client construction',async t=>{
  const root=path.resolve(sourceDir,'.test-temporary');fs.mkdirSync(root,{recursive:true});
  const scratch=fs.mkdtempSync(path.join(root,'transport-ca-'));let secretReads=0,clients=0;
  try{
    for(const kind of ['missing','changed','symlink']){
      const dir=path.join(scratch,kind);fs.mkdirSync(path.join(dir,'resources'),{recursive:true});
      const moduleFile=path.join(dir,'transport.mjs');fs.copyFileSync(path.join(sourceDir,'clued-handover-external-pg-transport.mjs'),moduleFile);
      const caFile=path.join(dir,'resources','supabase-official-prod-ca-2021.crt');
      const originalCa=path.join(sourceDir,'resources','supabase-official-prod-ca-2021.crt');
      if(kind==='changed'){const bytes=fs.readFileSync(originalCa);bytes[0]^=1;fs.writeFileSync(caFile,bytes);}
      let restore;
      if(kind==='symlink'){
        try{fs.symlinkSync(originalCa,caFile,'file');}catch(error){
          assert.ok(['EPERM','EACCES'].includes(error.code));fs.copyFileSync(originalCa,caFile);
          const real=fs.lstatSync;restore=t.mock.method(fs,'lstatSync',(name,options)=>{
            const actual=real(name,options);return String(name)===caFile?{...actual,isFile:()=>true,isSymbolicLink:()=>true}:actual;
          });
        }
      }
      const module=await import(pathToFileURL(moduleFile).href);
      assert.throws(()=>{const prepared=module.preparePgTransport({...FIXED_PG_TRANSPORT});secretReads++;
        const cfg=module.makePgClientConfig(prepared,uri,{database:'postgres'});clients++;void cfg;},/PG_CA_REJECTED/);
      if(restore)restore.mock.restore();
    }
    assert.equal(secretReads,0);assert.equal(clients,0);
  }finally{const resolved=path.resolve(scratch);assert.ok(resolved.startsWith(root+path.sep));fs.rmSync(resolved,{recursive:true,force:true});}
});
