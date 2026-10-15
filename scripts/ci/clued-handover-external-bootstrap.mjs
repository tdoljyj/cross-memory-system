// Explicit independent Supabase project platform; no auth/role replacement.
import assert from 'node:assert/strict';
import {assertPgTransportProfile} from './clued-handover-external-pg-transport.mjs';

export function platformDescriptor(p){
  assert.equal(p.platform_base,'supabase','UNSUPPORTED_PLATFORM_BASE');
  assert.match(p.supabase_project_ref??'',/^[a-z0-9]{20}$/,'EXACT_DISPOSABLE_PROJECT_REQUIRED');
  assert.equal(p.supabase_organization_id,'mqpgmvkdjrhukwmzvrug');
  assert.equal(p.supabase_project_name,'clued-handover-qualification');
  assert.equal(p.supabase_region,'ap-northeast-2');
  assert.equal(p.supabase_data_api_enabled,false);
  assertPgTransportProfile(p);
  assert.equal(p.recovery_support,'UNSUPPORTED_STATE_CLOSURE_UNPROVEN');
  return {project_ref:p.supabase_project_ref,host:p.database_host,port:p.database_port,
    database:p.database_name,transport:p.database_transport,login:p.database_login,canonical_role:p.provisioner_role};
}
export function assertPlatformFacts(facts){
  assert.deepEqual(facts.roles,['anon','authenticated','authenticator','service_role']);
  assert.equal(facts.auth_users,true);assert.equal(facts.auth_uid,true);assert.equal(facts.auth_jwt,true);
  assert.equal(facts.pgcrypto_schema,'extensions');
  assert.equal(facts.auth_users_count,'0','NONEMPTY_DISPOSABLE_AUTH');
  assert.equal(facts.clued_object_count,'0','EXISTING_CLUED_REALM');
  return {status:'SUPABASE_PLATFORM_PREEXISTING_NO_REPLACEMENT',platform_modified:false};
}
export async function verifySupabasePlatform(db,p){
  platformDescriptor(p);
  const roles=(await db.query("select rolname from pg_roles where rolname=any(array['anon','authenticated','authenticator','service_role']) order by rolname")).rows.map(r=>r.rolname);
  const facts=(await db.query("select to_regclass('auth.users') is not null auth_users,"+
    "to_regprocedure('auth.uid()') is not null auth_uid,to_regprocedure('auth.jwt()') is not null auth_jwt,"+
    "(select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto') pgcrypto_schema,"+
    "(select count(*)::text from auth.users) auth_users_count,"+
    "(select count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace "+
    "where n.nspname='clued_private' or (n.nspname='public' and left(c.relname,6)='clued_')) clued_object_count")).rows[0];
  return assertPlatformFacts({...facts,roles});
}
