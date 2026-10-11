// Synthetic database transport only. Native and CI callers must opt into their own roles.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const GATEWAY_ROLE = 'clued_worker_gateway';
export const CLOSEOUT_MIGRATION = '20261010161848_worker_gateway_closeout_v1.sql';
export const CI_SIGNATURES = [
  'clued_owner_grant_admission_door_v1(text,jsonb)', 'clued_owner_grant_door_consume_v1(text,jsonb)',
  'clued_work_verify_v1(text,jsonb)', 'clued_work_claim_adopt_v1(text,jsonb)',
  'clued_work_merge_slot_return_v1(text,jsonb)', 'clued_work_claims_active_v1(text,jsonb)',
  'clued_work_merge_slot_touch_v1(text,jsonb)', 'clued_work_merge_slot_holders_v1(text,jsonb)',
].sort();
const cloud = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transition = await fs.readFile(path.join(cloud,'supabase/migrations/20261009070002_worker_gateway_transition_v1.sql'),'utf8');
export const WORKER_SIGNATURES = [...transition.matchAll(/'(public\.clued_[a-z0-9_]+\([^']*\))'/g)].map(m=>m[1].replace(/^public\./,'')).sort();
assert.equal(WORKER_SIGNATURES.length,80);
assert.equal(new Set(WORKER_SIGNATURES).size,80);

export async function findGatewayCloseoutMigration(cloudRoot=cloud) {
  const names=(await fs.readdir(path.join(cloudRoot,'supabase/migrations'))).filter(n=>n.endsWith('_worker_gateway_closeout_v1.sql'));
  assert.deepEqual(names,[CLOSEOUT_MIGRATION],'the exact formal stage-2 migration must be present once');
  return CLOSEOUT_MIGRATION;
}
export async function setWorkerGatewayCaller(client) {
  await client.query('set role clued_worker_gateway');
  await client.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:GATEWAY_ROLE})]);
}
export async function workerGatewayRpc(client,name,proof,input) {
  assert.match(name,/^clued_[a-z0-9_]+$/,'only fixed public RPC names');
  const signature=name+(input===undefined?'(text)':'(text,jsonb)');
  assert.ok(WORKER_SIGNATURES.includes(signature),'RPC must be a C1 Worker overload: '+signature);
  await setWorkerGatewayCaller(client);
  const result=input===undefined
    ?await client.query(`select public.${name}($1::text) as value`,[proof])
    :await client.query(`select public.${name}($1::text,$2::jsonb) as value`,[proof,JSON.stringify(input)]);
  return result.rows[0].value;
}
export async function snapshotCallerCatalog(db) {
  return (await db.query(`select n.nspname,p.oid::regprocedure::text signature,
    pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,p.proacl::text acl,
    encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') source_hash
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='public' and p.proname like 'clued_%') or n.nspname='clued_private'
      or (n.nspname='auth' and p.proname in ('uid','jwt')) order by 1,2`)).rows;
}
export async function assertGatewayCloseoutBoundary(db) {
  const signatures=async(role,definersOnly)=> (await db.query(`select p.oid::regprocedure::text signature
    from pg_proc p where p.pronamespace='public'::regnamespace
    and ($2::boolean=false or p.prosecdef) and has_function_privilege($1,p.oid,'EXECUTE') order by 1`,[role,definersOnly])).rows.map(r=>r.signature.replace(/^public\./,''));
  assert.deepEqual(await signatures(GATEWAY_ROLE,false),WORKER_SIGNATURES,'GW remains exactly 80');
  assert.deepEqual(await signatures('anon',true),CI_SIGNATURES,'Clued anon definer surface is exactly CI8');
}
