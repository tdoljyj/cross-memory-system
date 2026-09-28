import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export const STORAGE_ADMIN_API = "clued_private.storage_admin_designate_v2";
export const storageAdminCall = async (db, input) => (await db.query(
  `select ${STORAGE_ADMIN_API}($1::jsonb) value`, [JSON.stringify(input)])).rows[0].value;

// Real M1 approval contracts, synthetic subjects and a disposable database only.
export async function storageAdminApproval(db, subject, project, action, base = 0) {
  const request = { operation: "create", record_type: "decision", record_schema_version: 1,
    scope: `project:${project}`, lifecycle_status: "active", authority: "user_explicit", user_confirmed: true,
    confidence_reason: "Synthetic explicit storage administration approval", idempotency_key: randomUUID(),
    source_refs: [], source_unavailable_reason: "Disposable PostgreSQL fixture",
    mutation: { title: "Storage-only administrator fixture", content: "Synthetic approval; no production authority",
      type_fields: { rationale: "Test exact approval binding", storage_admin_subject_id: subject, storage_admin_action: action } } };
  const result = (await db.query("select clued_private.record_mutation_core($1,null,$2::jsonb,clued_private.m1_sha256($2::jsonb)) value",
    [subject, JSON.stringify(request)])).rows[0].value;
  assert.equal(result.status, "committed", JSON.stringify(result));
  const decision = result.target_refs.find(ref => ref.kind === "record" && ref.role === "primary").id;
  const receipt = (await db.query("select request_sha256 from public.clued_audit_receipts where id=$1", [result.receipt_id])).rows[0];
  return { action, subject_id: subject, base_version: base, idempotency_key: randomUUID(), decision_id: decision,
    decision_version: Number(result.committed_versions[decision]), approval_receipt_id: result.receipt_id,
    approval_sha256: receipt.request_sha256 };
}

export async function testStorageAdmin(t, db, server, user, project) {
  await db.query("update auth.users set email_confirmed_at=clock_timestamp() where id=$1", [user]);
  const row = async () => (await db.query("select * from clued_private.storage_admin_v2")).rows;
  const isolated = async fn => { await db.query("begin"); try { await fn(); } finally { await db.query("rollback"); } };
  const rejected = async (input, regex) => {
    await db.query("savepoint admin_rejected");
    try { await assert.rejects(storageAdminCall(db, input), regex); }
    finally { await db.query("rollback to savepoint admin_rejected"); }
  };
  await t.test("storage administration is private invoker-only; even the designated account cannot call it through native or service roles", async () => {
    await isolated(async () => {
      const input = await storageAdminApproval(db, user, project, "designate");
      assert.equal((await storageAdminCall(db, input)).status, "committed");
      const acl = (await db.query(`select prosecdef,has_function_privilege('anon',oid,'execute') anon,
        has_function_privilege('authenticated',oid,'execute') native,has_function_privilege('service_role',oid,'execute') service
        from pg_proc where oid=$1::regprocedure`, [`${STORAGE_ADMIN_API}(jsonb)`])).rows[0];
      assert.deepEqual(acl, { prosecdef: false, anon: false, native: false, service: false });
      const tableAcl = (await db.query(`select relrowsecurity,
        has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE') anon,
        has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE') native,
        has_table_privilege('service_role',oid,'SELECT,INSERT,UPDATE,DELETE') service
        from pg_class where oid='clued_private.storage_admin_v2'::regclass`)).rows[0];
      assert.deepEqual(tableAcl, { relrowsecurity: true, anon: false, native: false, service: false });
      for (const role of ["anon", "authenticated", "service_role"]) {
        await db.query("savepoint role_denied");
        try {
          await db.query(`grant usage on schema clued_private to ${role}; grant execute on function ${STORAGE_ADMIN_API}(jsonb) to ${role}; set local role ${role}`);
          await db.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
          await assert.rejects(storageAdminCall(db, input), /offline_database_operator_required/);
        } finally { await db.query("rollback to savepoint role_denied"); }
      }
      assert.equal((await db.query("select count(*)::int n from clued_private.platform_admin_v13")).rows[0].n, 0);
    });
  });
  await t.test("designation CAS and exact latest Receipt replay cannot reactivate revoked authority or reuse an approval", async () => {
    await isolated(async () => {
      const enable = await storageAdminApproval(db, user, project, "designate"), result = await storageAdminCall(db, enable);
      assert.equal(result.status, "committed");
      assert.equal((await storageAdminCall(db, enable)).receipt_id, result.receipt_id);
      const beforeConflict = await row();
      assert.equal((await storageAdminCall(db, { ...enable, approval_sha256: "a".repeat(64) })).status, "rejected");
      assert.deepEqual(await row(), beforeConflict);
      const stop = await storageAdminApproval(db, user, project, "revoke", 1);
      assert.equal((await storageAdminCall(db, stop)).status, "committed");
      await rejected(enable, /storage_admin_version_conflict/);
      await rejected({ ...enable, base_version: 2, idempotency_key: randomUUID() }, /storage_admin_approval_required/);
      const resume = await storageAdminApproval(db, user, project, "designate", 2);
      assert.equal((await storageAdminCall(db, resume)).status, "committed");
      assert.equal((await row())[0].version, "3"); assert.equal((await row())[0].state, "active");
      await rejected(stop, /storage_admin_version_conflict/);
      await rejected({ ...resume, subject_id: randomUUID(), idempotency_key: randomUUID() }, /storage_admin_scope_denied/);
      for (const sql of ["delete from clued_private.storage_admin_v2", "update clued_private.storage_admin_v2 set version=1"]) {
        await db.query("savepoint immutable_admin");
        try { await assert.rejects(db.query(sql), /storage_admin_history_immutable/); }
        finally { await db.query("rollback to savepoint immutable_admin"); }
      }
    });
  });
  await t.test("approval must be current, explicit, exact subject/action/version and bound to its immutable committed Receipt", async () => {
    await isolated(async () => {
      const input = await storageAdminApproval(db, user, project, "designate");
      for (const extra of [{ approval_receipt_id: randomUUID() }, { approval_sha256: "a".repeat(64) },
        { decision_version: 2 }, { decision_id: randomUUID() }, { action: "revoke" }, { approval_ref: "arbitrary text" }]) {
        await rejected({ ...input, ...extra }, /storage_admin_approval_required|storage_admin_version_conflict|storage_admin_input_invalid/);
      }
      for (const change of ["authority='inferred'", "lifecycle_status='revoked'",
        "type_fields=type_fields||'{\"storage_admin_subject_id\":\"00000000-0000-4000-8000-000000000000\"}'::jsonb",
        "type_fields=type_fields||'{\"storage_admin_action\":\"revoke\"}'::jsonb"]) {
        await db.query("savepoint wrong_approval");
        try {
          await db.query(`update public.clued_memories set ${change} where id=$1`, [input.decision_id]);
          await rejected(input, /storage_admin_approval_required/);
        } finally { await db.query("rollback to savepoint wrong_approval"); }
      }
      assert.deepEqual(await row(), []);
    });
  });
  await t.test("anonymous, deleted and banned subjects cannot activate; an unavailable subject can still be revoked", async () => {
    for (const column of ["is_anonymous boolean", "deleted_at timestamptz", "banned_until timestamptz"]) {
      await isolated(async () => {
        await db.query(`alter table auth.users add column if not exists ${column}`);
        const field = column.split(" ")[0], value = field === "is_anonymous" ? "true" : "clock_timestamp()+interval '1 day'";
        const enable = await storageAdminApproval(db, user, project, "designate");
        await db.query(`update auth.users set ${field}=${value} where id=$1`, [user]);
        await rejected(enable, /storage_admin_verified_account_required|account_not_available/);
        await db.query(`update auth.users set ${field}=null where id=$1`, [user]);
        assert.equal((await storageAdminCall(db, enable)).status, "committed");
        const stop = await storageAdminApproval(db, user, project, "revoke", 1);
        await db.query(`update auth.users set ${field}=${value} where id=$1`, [user]);
        assert.equal((await storageAdminCall(db, stop)).status, "committed");
        assert.equal((await row())[0].state, "revoked");
      });
    }
  });
  await t.test("unverified activation and audit failure leave no designation or successful Receipt", async () => {
    await isolated(async () => {
      const input = await storageAdminApproval(db, user, project, "designate");
      await db.query("update auth.users set email_confirmed_at=null where id=$1", [user]);
      await rejected(input, /storage_admin_verified_account_required/);
      await db.query("update auth.users set email_confirmed_at=clock_timestamp() where id=$1", [user]);
      for (const target of ["event", "receipt"]) {
        await db.query("savepoint fail_audit");
        try {
          await db.query(`create function pg_temp.admin_fail() returns trigger language plpgsql as $$ begin
            if ${target === "event" ? "true" : "new.status='committed'"} then raise exception 'synthetic_admin_failure'; end if; return new; end $$`);
          await db.query(target === "event" ? "create trigger admin_fail before insert on public.clued_context_events for each row execute function pg_temp.admin_fail()"
            : "create trigger admin_fail before update on public.clued_audit_receipts for each row execute function pg_temp.admin_fail()");
          await rejected(input, /storage_admin_failed/);
          assert.deepEqual(await row(), []);
          assert.equal((await db.query("select count(*)::int n from public.clued_audit_receipts where idempotency_key=$1 and status='committed'", [input.idempotency_key])).rows[0].n, 0);
        } finally { await db.query("rollback to savepoint fail_audit"); }
      }
    });
  });
}
