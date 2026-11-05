import crypto from "node:crypto";
import pg from "pg";

const { Client } = pg;

export const FIXTURE = {
  ownerA: "aa000000-0000-4000-8000-000000000001",
  ownerB: "bb000000-0000-4000-8000-000000000002",
  bindingA: "aa100000-0000-4000-8000-000000000001",
  bindingB: "bb100000-0000-4000-8000-000000000002",
  sessionA: "aa200000-0000-4000-8000-000000000001",
  contextA: "accept-pos-project",
  contextB: "accept-neg-owner-b",
  bindingTokenA: `clued_bnd_${"a".repeat(48)}`,
  bindingTokenB: `clued_bnd_${"b".repeat(48)}`,
  sessionTokenA: `clued_ses_${"c".repeat(64)}`,
  ownerBMarker: "OWNER_B_PRIVATE_MARKER_MUST_NOT_LEAK",
};

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function resetAcceptanceFixture(connectionString = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres") {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("delete from auth.users where id = any($1::uuid[])", [[FIXTURE.ownerA, FIXTURE.ownerB]]);
    await client.query("insert into auth.users(id,email,created_at,updated_at) values ($1,$2,now(),now()),($3,$4,now(),now())", [
      FIXTURE.ownerA, "accept-pos@example.invalid", FIXTURE.ownerB, "accept-neg@example.invalid",
    ]);
    await client.query(`insert into public.clued_agent_bindings
      (id,user_id,vendor,agent_name,token_hash,scopes,context_keys)
      values ($1,$2,'Acceptance','Positive',$3,array['context:read','context:write','audit:read'],array[$4]),
             ($5,$6,'Acceptance','Negative',$7,array['context:read','context:write','audit:read'],array[$8])`, [
      FIXTURE.bindingA, FIXTURE.ownerA, sha256(FIXTURE.bindingTokenA), FIXTURE.contextA,
      FIXTURE.bindingB, FIXTURE.ownerB, sha256(FIXTURE.bindingTokenB), FIXTURE.contextB,
    ]);
    // Raw fixture Bindings work only with an explicit raw grant (migration 20261009050000, P0-4 step 7b).
    await client.query(`insert into clued_private.raw_binding_grants_v1(binding_id,context_key,actions,reason)
      select id,null,array['read','write','close','restore','audit','feedback_submit'],'public MCP acceptance fixture'
        from unnest($1::uuid[]) id`, [[FIXTURE.bindingA, FIXTURE.bindingB]]);
    await client.query("insert into public.clued_context_streams(user_id,context_key,version) values ($1,$2,0),($3,$4,1)", [
      FIXTURE.ownerA, FIXTURE.contextA, FIXTURE.ownerB, FIXTURE.contextB,
    ]);
    await client.query(`insert into public.clued_continuity_sessions
      (id,user_id,binding_id,context_key,token_hash,restored_version,expires_at)
      values ($1,$2,$3,$4,$5,0,now()+interval '1 hour')`, [
      FIXTURE.sessionA, FIXTURE.ownerA, FIXTURE.bindingA, FIXTURE.contextA, sha256(FIXTURE.sessionTokenA),
    ]);
    await client.query(`insert into public.clued_context_events
      (user_id,binding_id,context_key,event_type,payload,base_version,version,idempotency_key)
      values ($1,$2,$3,'note',jsonb_build_object('marker',$4::text),0,1,'ANEG-owner-b-seed')`, [
      FIXTURE.ownerB, FIXTURE.bindingB, FIXTURE.contextB, FIXTURE.ownerBMarker,
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
  return { owners: 2, bindings: 2, contexts: 2, synthetic_only: true };
}

if (import.meta.main ?? process.argv[1]?.split(/[\\/]/).pop() === decodeURIComponent(import.meta.url.split('/').pop())) {
  console.log(JSON.stringify(await resetAcceptanceFixture()));
}
