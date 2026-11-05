// Synthetic database transport only. Native and CI callers must opt into their own roles.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const GATEWAY_ROLE = 'clued_worker_gateway';
export const CLOSEOUT_MIGRATION = '20261010161848_worker_gateway_closeout_v1.sql';
export const AUTHORIZATION_SUCCESSOR_MIGRATIONS = [
  '20261014044323_all_contexts_authorization_v2.sql',
  '20261014045157_all_contexts_serialization_v2.sql',
  '20261015172722_consent_future_owned_policies.sql',
];
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
// The historical gateway closeout stays exactly 80. Only the explicit later
// physical-start migration adds these two authenticated serving-Worker doors;
// it adds no anon/Binding/public definer access.
export const SCAN_START_GATEWAY_SIGNATURES = ['clued_ci_scan_start_hosted_v1(jsonb)', 'clued_ci_scan_start_policy_v1(jsonb)'].sort();

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
// The sealed closeout (20261010161848) refuses any caller privilege outside its
// own manifest, so replaying it after the full chain fails on the privileges
// that explicit later successors add on purpose: the two scan-start serving
// doors for the Worker gateway (20261102151506). These are exactly those
// privileges; a later successor that adds one names it here.
export const CLOSEOUT_SUCCESSOR_GRANTS = [
  ['public.clued_ci_scan_start_hosted_v1(jsonb)', GATEWAY_ROLE],
  ['public.clued_ci_scan_start_policy_v1(jsonb)', GATEWAY_ROLE],
];
// Replays the sealed closeout SQL unchanged. Where a successor is installed,
// its own privilege is set aside for the replay and put back afterwards (same
// grantor, so the ACL text is unchanged); the closeout still checks every
// other function, role and ACL exactly. Before the successors this is a plain
// replay.
export async function replayGatewayCloseout(db, closeoutSql) {
  const present = [];
  for (const [signature, role] of CLOSEOUT_SUCCESSOR_GRANTS) {
    const {rows:[row]} = await db.query(`select to_regprocedure($1) is not null
      and has_function_privilege($2,to_regprocedure($1),'EXECUTE') granted`, [signature, role]);
    if (row.granted) present.push([signature, role]);
  }
  for (const [signature, role] of present) await db.query(`revoke execute on function ${signature} from ${role}`);
  try {
    return await db.query(closeoutSql);
  } finally {
    for (const [signature, role] of present) await db.query(`grant execute on function ${signature} to ${role}`);
  }
}
export async function assertGatewayCloseoutBoundary(db) {
  const signatures=async(role,definersOnly)=> (await db.query(`select p.oid::regprocedure::text signature
    from pg_proc p where p.pronamespace='public'::regnamespace
    and ($2::boolean=false or p.prosecdef) and has_function_privilege($1,p.oid,'EXECUTE') order by 1`,[role,definersOnly])).rows.map(r=>r.signature.replace(/^public\./,''));
  const successor = (await db.query("select to_regclass('clued_private.ci_scan_start_keys_v1') is not null present")).rows[0].present;
  const expected = successor ? [...WORKER_SIGNATURES, ...SCAN_START_GATEWAY_SIGNATURES].sort() : WORKER_SIGNATURES;
  assert.deepEqual(await signatures(GATEWAY_ROLE,false),expected,successor ? 'GW is exactly historical 80 + the two scan-start successor RPCs' : 'historical GW remains exactly 80');
  assert.deepEqual(await signatures('anon',true),CI_SIGNATURES,'Clued anon definer surface is exactly CI8');
}

// The historical closeout is source-bound and must be proved before successors.
// For the current authorization pair, observe actual catalog identity and ACLs
// rather than replaying the old source fingerprint against deliberately changed bodies.
export async function snapshotAuthorizationCallerBoundary(db) {
  return (await db.query(`select p.oid::text oid,p.oid::regprocedure::text signature,
    pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,p.proacl::text acl
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'clued_%'
    order by signature`)).rows;
}
export async function assertAuthorizationSuccessorBoundary(db, before) {
  assert.deepEqual(await snapshotAuthorizationCallerBoundary(db),before,
    'the authorization successors preserve every public RPC OID, owner, definer configuration and ACL');
  await assertGatewayCloseoutBoundary(db);
  assert.equal((await db.query('select clued_private.authorization_serialization_ready_v2() ready')).rows[0].ready,true);
  const entrances = [
    ['public.clued_development_owner_v14(jsonb)','authorization_writer_native_context_v2'],
    ['public.clued_authorization_manage_v12(jsonb)','authorization_writer_guard_v2'],
    ['public.clued_user_project_mutate_v2(jsonb,text)','authorization_writer_guard_v2'],
    ['public.clued_project_mutate_v2(text,jsonb)','authorization_writer_project_hint_v2(p_token_hash,true)'],
    ['clued_private.ii_pub_clued_authorization_approve_v12(text,uuid,bigint,jsonb,text,timestamptz)','authorization_writer_guard_v2'],
  ];
  for (const [signature,anchor] of entrances) {
    const row=(await db.query(`select pg_get_userbyid(proowner) owner,prosecdef,proconfig,prosrc
      from pg_proc where oid=$1::regprocedure`,[signature])).rows[0];
    assert.equal(row.owner,'postgres',signature);
    assert.equal(row.prosecdef,true,signature);
    assert.deepEqual(row.proconfig,['search_path=""'],signature);
    assert.ok(row.prosrc.includes(anchor),'actual qualified early entrance: '+signature);
  }
  for (const signature of ['public.clued_authorization_manage_v12(jsonb)',
    'public.clued_development_owner_v14(jsonb)','public.clued_user_project_mutate_v2(jsonb,text)']) {
    for (const role of ['anon','authenticated','service_role',GATEWAY_ROLE])
      assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed",[role,signature])).rows[0].allowed,
        role==='authenticated',signature+' '+role);
  }
  for (const signature of ['clued_private.authorization_writer_guard_v2(uuid)',
    'clued_private.authorization_writer_lock_fanout_v2(uuid,uuid[])',
    'clued_private.authorization_reduce_sources_v2(uuid,uuid,jsonb,uuid)']) {
    for (const role of ['anon','authenticated','service_role',GATEWAY_ROLE])
      assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') allowed",[role,signature])).rows[0].allowed,false,
        'private helper remains unreachable: '+signature+' '+role);
  }
}
