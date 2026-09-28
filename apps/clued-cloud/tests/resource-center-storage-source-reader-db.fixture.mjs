import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROLE = "clued_storage_source_reader_v2";
const API = "clued_storage_source.authorization_request_snapshot_v2(uuid)";

// Run only in resource-center-authority-db.test.mjs's disposable PostgreSQL.
export async function testStorageSourceReader(t, admin) {
  await t.test("storage source reader is a non-login, exact-function-only capability", async () => {
    const role = (await admin.query(`select rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls
      from pg_roles where rolname=$1`, [ROLE])).rows[0];
    assert.deepEqual(role, { rolcanlogin: false, rolsuper: false, rolcreatedb: false,
      rolcreaterole: false, rolinherit: false, rolreplication: false, rolbypassrls: false });
    const acl = (await admin.query(`select p.prosecdef,p.provolatile,p.proconfig,
      has_function_privilege($1,p.oid,'EXECUTE') dedicated,
      has_function_privilege('anon',p.oid,'EXECUTE') anon,
      has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,
      has_function_privilege('service_role',p.oid,'EXECUTE') service,
      exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where a.grantee=0 and a.privilege_type='EXECUTE') public
      from pg_proc p where p.oid=$2::regprocedure`, [ROLE, API])).rows[0];
    assert.equal(acl.prosecdef, true); assert.equal(acl.provolatile, "s");
    assert.ok(acl.proconfig?.some(value => /^search_path=(""|)$/.test(value)));
    assert.equal(acl.dedicated, true); assert.equal(acl.anon, false);
    assert.equal(acl.authenticated, false); assert.equal(acl.service, false); assert.equal(acl.public, false);
    assert.equal((await admin.query("select has_schema_privilege($1,'clued_storage_source','USAGE') value", [ROLE])).rows[0].value, true);
    for (const table of ["clued_private.authorization_requests_v12", "clued_private.authorization_issuers_v12",
      "clued_private.authorizations_v12", "public.clued_agent_bindings"]) {
      assert.equal((await admin.query("select has_table_privilege($1,$2,'SELECT') value", [ROLE, table])).rows[0].value, false);
    }
    const migration = await readFile(path.join(process.cwd(), "supabase", "migrations",
      "20260928113000_resource_center_storage_source_reader_v2.sql"), "utf8");
    await assert.rejects(admin.query(migration), /already exists/);
  });

  await t.test("storage source reader resolves only an exact live request and cannot read base tables", async () => {
    const candidate = (await admin.query(`select r.id,r.request_digest,r.client_id,r.client_name,r.redirect_uri,
      r.resource,r.requested_scopes,r.status
      from clued_private.authorization_requests_v12 r
      join clued_private.authorization_issuers_v12 i on i.token_hash=r.issuer_hash and i.resource=r.resource
      join clued_private.authorizations_v12 a on a.request_id=r.id and a.binding_id=r.binding_id and a.owner_id=r.owner_id
      join public.clued_agent_bindings b on b.id=a.binding_id and b.user_id=r.owner_id
      where r.status='approved' and i.revoked_at is null and a.revoked_at is null and b.revoked_at is null
        and a.client_id=r.client_id and a.resource=r.resource limit 1`)).rows[0];
    assert.ok(candidate, "capability fixture must leave one live approved request");
    await admin.query("begin");
    try {
      await admin.query(`set local role ${ROLE}`);
      const exact = (await admin.query(`select * from ${API.replace('(uuid)', '')}($1::uuid)`, [candidate.id])).rows;
      assert.deepEqual(exact, [candidate]);
      assert.deepEqual((await admin.query(`select * from ${API.replace('(uuid)', '')}($1::uuid)`, [randomUUID()])).rows, []);
    } finally { await admin.query("rollback"); }
    await admin.query("begin");
    try {
      await admin.query(`set local role ${ROLE}`);
      await assert.rejects(admin.query("select id from clued_private.authorization_requests_v12 limit 1"), /permission denied/);
    } finally { await admin.query("rollback"); }
  });
}
