import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
const hash = value => createHash("sha256").update(value).digest("hex");

export async function testStorageOAuth(t, admin, server, user, decision) {
  const session = randomUUID(), otherSession = randomUUID(), issuer = hash(randomUUID());
  await admin.query("insert into auth.sessions(id,user_id) values($1,$3),($2,$3)", [session, otherSession, user]);
  const profile = (await admin.query("select id from clued_private.resource_center_profiles_v1 where profile_version='account/1' and user_id=$1", [user])).rows[0].id;
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri) values($1,'fixture-client','https://clued.invalid/storage/google/callback')", [issuer]);
  const native = server.getPgClient(); await native.connect();
  await native.query("set role authenticated");
  const login = async current => native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [user, JSON.stringify({ sub: user, session_id: current })]);
  await login(session);
  const account = async input => (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
  const rpc = async (input, secret = issuer) => (await native.query("select public.clued_storage_oauth_v1($1,$2::jsonb) value", [secret, JSON.stringify(input)])).rows[0].value;
  // Synthetic ciphertext only. Actual AES-GCM authentication is tested at the trusted Worker boundary.
  const envelope = { contract: "clued.storage-credential/1", key_id: "fixture", nonce: "A".repeat(16), ciphertext: "A".repeat(24) };
  let connection;
  const setup = async () => {
    if (connection) {
      const previous = (await account({ action: "list" })).connections.find(c => c.id === connection);
      if (previous && previous.state !== "revoked") await account({ action: "revoke_connection", connection_id: connection, base_version: previous.version, idempotency_key: randomUUID() });
    }
    const registered = await account({ action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() });
    connection = registered.target_refs[0].id;
    const descriptor = await rpc({ action: "describe", connection_id: connection });
    const state_hash = hash(randomUUID()), attempt_id = randomUUID();
    await rpc({ action: "prepare", connection_id: connection, connection_version: descriptor.connection_version, state_hash, attempt_id, verifier_envelope: envelope });
    return { state_hash, attempt_id };
  };
  const complete = state_hash => rpc({ action: "complete", state_hash, provider_subject: "fixture-subject", credential_envelope: envelope });
  try {
    await t.test("OAuth issuer and originating live native session are both mandatory", async () => {
      const { state_hash } = await setup();
      await assert.rejects(rpc({ action: "claim", state_hash }, hash("wrong")), /storage_oauth_denied/);
      await login(otherSession);
      await assert.rejects(rpc({ action: "claim", state_hash }), /storage_oauth_denied/);
      await login(session);
      await assert.rejects(rpc({ action: "describe", connection_id: connection, managed_root: "/other" }), /storage_oauth_denied/);
      await assert.rejects(complete(state_hash), /storage_oauth_denied/);
      assert.equal((await rpc({ action: "claim", state_hash })).status, "claimed");
      await assert.rejects(rpc({ action: "claim", state_hash }), /storage_oauth_denied/);
      const result = await complete(state_hash);
      assert.equal(result.status, "completed");
      assert.deepEqual(await rpc({ action: "claim", state_hash }), result);
      await assert.rejects(complete(state_hash), /storage_oauth_denied/);
      const stored = (await admin.query("select * from clued_private.storage_connections_v1 where id=$1", [connection])).rows[0];
      assert.equal(stored.state, "active"); assert.equal(stored.credential_version, "1");
      assert.deepEqual(stored.credential_envelope, envelope);
      assert.equal(Object.keys(result).sort().join(), "receipt_id,status");
      const receipt = (await admin.query("select status from public.clued_audit_receipts where id=$1", [result.receipt_id])).rows[0];
      assert.equal(receipt.status, "committed");
    });
    await t.test("revocation and policy drift prohibit a pending OAuth activation", async () => {
      const { state_hash } = await setup(); await rpc({ action: "claim", state_hash });
      await account({ action: "revoke_connection", connection_id: connection, base_version: 1, idempotency_key: randomUUID() });
      await assert.rejects(complete(state_hash), /storage_oauth_denied/);
      const next = await setup(); await rpc({ action: "claim", state_hash: next.state_hash });
      await admin.query("update public.clued_memories set lifecycle_status='revoked' where id=$1", [decision]);
      try { await assert.rejects(complete(next.state_hash), /storage_oauth_denied/); }
      finally { await admin.query("update public.clued_memories set lifecycle_status='active' where id=$1", [decision]); }
    });
    await t.test("expired OAuth attempt and logged-out session cannot activate or expose credentials", async () => {
      const { state_hash, attempt_id } = await setup(); await rpc({ action: "claim", state_hash });
      await admin.query("update clued_private.storage_oauth_attempts_v1 set expires_at=clock_timestamp()-interval '1 second' where id=$1", [attempt_id]);
      await assert.rejects(complete(state_hash), /storage_oauth_denied/);
      await assert.rejects(native.query("select * from clued_private.storage_oauth_attempts_v1"), /permission denied/);
      await assert.rejects(native.query("select * from clued_private.storage_oauth_apps_v1"), /permission denied/);
      await admin.query("delete from auth.sessions where id=$1", [session]);
      await assert.rejects(rpc({ action: "describe", connection_id: connection }), /storage_native_session_required/);
    });
  } finally { await native.end(); }
}
