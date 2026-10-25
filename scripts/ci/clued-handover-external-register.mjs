// Operator-only candidate. Registers only an exact independently accepted
// empty disposable cluster. No production target or generic SQL entry.
import assert from 'node:assert/strict';
export const COMPONENT_VERSION = "1.0.2";
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {acceptedSourceCheck} from './clued-handover-external-source-check.mjs';
import {verifyEmptyCluster} from './clued-handover-external-catalog.mjs';
import {platformDescriptor,verifySupabasePlatform} from './clued-handover-external-bootstrap.mjs';
import {preparePgTransport,makePgClientConfig,PG_IDENTITY_SQL,assertPgIdentity} from './clued-handover-external-pg-transport.mjs';
const root=process.env.GITHUB_WORKSPACE;
let failureCategory='SOURCE_ACCEPTANCE',registrationState='NOT_STARTED';
async function evidence(value){
  const dir=path.join(process.env.RUNNER_TEMP??os.tmpdir(),'clued-handover-evidence');
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(dir,'registration.json'),JSON.stringify({
    schema:'clued.disposable-operator-registration-evidence/1',fixture_only:true,
    canonical_authority:'none',production_qualified:false,...value},null,2),{mode:0o600});
}
async function main(){
  const verified=acceptedSourceCheck(root,process.env),p=verified.profile;
  assert.equal(process.env.QUALIFICATION_OPERATOR_MODE,'register-empty-disposable');
  assert.equal(process.env.QUALIFICATION_IDLE_RUN_ID??'','');
  assert.match(process.env.GITHUB_RUN_ID,/^[1-9][0-9]{0,19}$/);
  assert.equal(p.fixture_mode,'continuous');
  platformDescriptor(p);
  const transport=preparePgTransport(p);
  const catalogue=JSON.parse(await fs.readFile(path.join(root,'config/clued-handover-external-catalog.json'),'utf8'));
  assert.equal(catalogue.operator_authority_receipt,p.operator_authority_receipt);
  const raw=process.env.QUALIFICATION_DISPOSABLE_PG_URL??'';
  const req=createRequire(path.join(root,'apps/clued-cloud/package.json'));
  const Pg=(await import(pathToFileURL(req.resolve('pg')).href)).default;
  const connect=async database=>{
    const c=new Pg.Client(makePgClientConfig(transport,raw,{database}));
    try{await c.connect();assertPgIdentity(await c.query(PG_IDENTITY_SQL),database);return c;}
    catch{await c.end().catch(()=>{});throw new Error('PG_CLIENT_CONNECTION_OR_IDENTITY_REJECTED');}
  };
  const db=await connect(p.database_name);
  try{
    // Both snapshots are independently accepted Source bytes, not caller
    // booleans. Before-registration includes NO qualification marker.
    failureCategory='INDEPENDENT_PLATFORM_CATALOG';
    await verifyEmptyCluster({admin:db,connectDatabase:connect,expected:catalogue.before_registration,targetDatabase:p.database_name});
    await verifySupabasePlatform(db,p);
    failureCategory='EXACT_OPERATOR_REGISTRATION';
    await db.query('begin');registrationState='TRANSACTION_OPEN';
    await db.query(await fs.readFile(path.join(root,'scripts/ci/fixtures/clued-handover-operator-registration.sql'),'utf8'));
    await db.query("insert into qualification_guard.registration_v1(realm,synthetic_only,registration,registered_run_id,database_name,registered_host,"+
      "profile_sha256,operator_authority_receipt,source_baseline,source_pins_sha256,engineering_task_id) "+
      "values('clued-handover-disposable',true,$1,$8,current_database(),$2,$3,$4,$5,$6,$7)",
      [p.disposable_pg_registration,p.database_host,verified.profile_sha256,p.operator_authority_receipt,
        p.source_baseline,p.source_pins_sha256,p.engineering_task_id,process.env.GITHUB_RUN_ID]);
    await verifyEmptyCluster({admin:db,connectDatabase:connect,expected:catalogue.before_bootstrap,targetDatabase:p.database_name});
    registrationState='COMMIT_RESPONSE_UNCERTAIN';
    await db.query('commit');registrationState='COMMITTED';
    await evidence({status:'REGISTERED_DISPOSABLE_CATALOG',registration_state:registrationState,
      acceptance_sha256:verified.acceptance_sha256,external_qualification:'NONE'});
    console.log(JSON.stringify({status:'REGISTERED_DISPOSABLE_CATALOG',fixture_only:true,production_qualified:false,
      acceptance_sha256:verified.acceptance_sha256}));
  }catch(error){await db.query('rollback').catch(()=>{});
    if(registrationState==='TRANSACTION_OPEN')registrationState='ROLLED_BACK';throw error;}
  finally{await db.end();}
}
main().catch(async error=>{
  await evidence({status:'FAILED',success:false,failure_category:failureCategory,
    error_type:error.name,registration_state:registrationState,external_qualification:'NONE'});
  console.error('OPERATOR_REGISTRATION_FAILED:'+error.name);process.exitCode=1;
});
