import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const sha = value => createHash("sha256").update(value).digest("hex");
const NORMAL_DISCLOSURE = "clued.storage-normal-use-disclosure/1";
const READ_DISCLOSURE = "clued.storage-read-disclosure/1";

// StorageNormalUse.v0.1 N1a at the database layer: re-consent of an EXISTING
// account-policy connection to the normal scope set, the outermost OAuth
// wrapper (busy, requested profile binding, refresh-token count, delegation
// carry), the old envelope leaving no residue, clued_storage_normal_use_v1,
// set_classes not downgrading normal/1, and the content-search admission.
// Synthetic, disposable PostgreSQL only.
export async function testStorageNormalUse(t, admin, server, user, decision) {
  const clients = [], session = randomUUID(), issuer = sha(randomUUID()), clientIssuer = sha(randomUUID());
  const oauthClient = `normal-use-${randomUUID()}`, resource = "https://normal-use.invalid/mcp";
  const project = (await admin.query("select project_id from public.clued_memories where id=$1", [decision])).rows[0].project_id;
  const connect = async role => {
    const database = server.getPgClient(); clients.push(database); await database.connect();
    await database.query("set statement_timeout='10s'");
    if (role) await database.query(`set role ${role}`);
    return database;
  };
  const native = await connect("authenticated"), caller = await connect("anon");
  await admin.query("insert into auth.sessions(id,user_id) values($1,$2)", [session, user]);
  await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
    [user, JSON.stringify({ sub: user, session_id: session })]);
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'normal-use-fixture')", [clientIssuer, resource]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,read_enabled) values($1,$2,'https://normal-use.invalid/storage/google/callback',true)", [issuer, oauthClient]);
  const register = async input => {
    const result = (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
      JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
    assert.equal(result.status, "committed", JSON.stringify(result)); return result;
  };
  const suffix = randomUUID(), rootId = `normal-root-${suffix}`, root = `/normal-use-${suffix}/Clued_资料中心`;
  const profile = (await register({ action: "profile_register", project_id: project, profile_version: `normal-use/${suffix}`,
    managed_root: root, root_folder_id: rootId, root_parent_id: `normal-parent-${suffix}`, root_folder_version: "1" }))
    .target_refs.find(ref => ref.role === "primary").id;
  await register({ action: "artifact_register", profile_id: profile, path: root + "/20_P_产品与体验", provider_file_id: `normal-track-${suffix}`,
    provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
  assert.equal((await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
    profile_id: profile, base_version: 1, allowed_root_children: ["20_P_产品与体验"], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value.status, "committed");
  const connected = (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify({
    action: "register", profile_id: profile, source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
  assert.equal(connected.status, "committed");
  const connection = connected.target_refs.find(ref => ref.role === "primary").id, receipt = connected.receipt_id;

  const envelope = tag => ({ contract: "clued.storage-credential/1", key_id: "fixture", nonce: "N".repeat(16),
    ciphertext: tag + randomBytes(48).toString("base64url") });
  const oauth = async (input, database = native) => (await database.query("select public.clued_storage_oauth_v1($1,$2::jsonb) value", [issuer, JSON.stringify(input)])).rows[0].value;
  const row = async () => (await admin.query("select * from clued_private.storage_connections_v1 where id=$1", [connection])).rows[0];
  const prepare = async (extra = {}) => {
    const described = await oauth({ action: "describe", connection_id: connection });
    const state_hash = sha(randomUUID()), attempt_id = randomUUID();
    const prepared = await oauth({ action: "prepare", connection_id: connection, connection_version: described.connection_version, attempt_id,
      state_hash, verifier_envelope: envelope("V"), ...extra });
    assert.equal(prepared.status, "prepared");
    return { state_hash, attempt_id };
  };
  const complete = (state_hash, credential_envelope, provider_scope_profile) => oauth({ action: "complete", state_hash, provider_subject: "normal-subject",
    credential_envelope, ...(provider_scope_profile ? { provider_scope_profile } : {}) });
  const tokenCount = async () => (await admin.query("select clued_private.storage_refresh_token_count_v1($1,'normal-subject',$2) n", [user, oauthClient])).rows[0].n;

  // First activation through the real connection-consent path (legacy set).
  const OLD = envelope("OLDenv");
  const first = await prepare({ requested_scope_profile: "legacy" });
  assert.equal(await tokenCount(), 0);
  const firstClaim = await oauth({ action: "claim", state_hash: first.state_hash });
  assert.equal(firstClaim.requested_scope_profile, "legacy");
  assert.equal(await tokenCount(), 1, "a claim counts one refresh token before any exchange");
  const activated = await complete(first.state_hash, OLD, "legacy");
  assert.equal(activated.status, "completed"); assert.equal(activated.provider_scope_profile, "legacy");
  assert.equal(activated.refresh_enabled, false); assert.equal("normal_use_enabled" in activated, false);
  assert.equal((await admin.query("select provider_subject from clued_private.storage_refresh_token_issuance_v1 where oauth_attempt_id=$1", [first.attempt_id])).rows[0].provider_subject,
    "normal-subject", "completion attaches the provider subject to the counted claim");

  // Account policy (reviewed transition shape) and a standing refresh delegation.
  const policy = randomUUID();
  await admin.query("begin");
  try {
    await admin.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,
      scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id)
      select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,
        c.source_decision_id,c.decision_version,'reviewed_transition','normal-use-fixture/1',c.receipt_id
      from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`, [policy, connection]);
    await admin.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1", [policy, receipt]);
    await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [connection, policy]);
    await admin.query("commit");
  } catch (error) { await admin.query("rollback"); throw error; }
  await admin.query("insert into clued_private.storage_refresh_delegations_v1(connection_id,issuer_hash,enabled,receipt_id) values($1,$2,true,$3)", [connection, issuer, receipt]);
  const delegation = async () => (await admin.query("select enabled,version,receipt_id from clued_private.storage_refresh_delegations_v1 where connection_id=$1", [connection])).rows[0];

  const access = async input => (await native.query("select public.clued_storage_read_access_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
  const normalUse = async input => (await native.query("select public.clued_storage_normal_use_v1($1::jsonb) value", [JSON.stringify(input)])).rows[0].value;
  const status = () => normalUse({ action: "status", connection_id: connection });
  const toggle = async (action, extra = {}) => normalUse({ action, connection_id: connection, base_generation: (await status()).read_generation,
    disclosure_version: NORMAL_DISCLOSURE, idempotency_key: randomUUID(), ...extra });
  const activeRead = async () => (await admin.query("select classes,content_profile,disclosure_version,read_generation from clued_private.storage_read_access_v1 where connection_id=$1 and state='active'", [connection])).rows[0];
  assert.equal((await access({ action: "set_classes", connection_id: connection, classes: ["read"], base_generation: 0,
    disclosure_version: READ_DISCLOSURE, idempotency_key: randomUUID() })).status, "committed");

  const mutation = async () => (await admin.query(`insert into clued_private.resource_center_mutations_v1(user_id,profile_id,request_key,request_sha256,exact_request,
    authority_request,authority_result,authority_token_hash,profile_version,source_decision_id,state,expires_at,receipt_id)
    values($1,$2,$3,$4,'{}','{}','{}',$4,1,$5,'prepared',clock_timestamp()+interval '1 minute',$6) returning id`,
    [user, profile, randomUUID(), sha(randomUUID()), decision, receipt])).rows[0].id;
  const settle = id => admin.query("update clued_private.resource_center_mutations_v1 set state='cancelled' where id=$1", [id]);

  const bind = async () => {
    const token = sha(randomUUID()), clientId = `normal-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: sha(randomUUID()), client_id: clientId, client_name: "Normal use fixture", redirect_uri: "https://normal-use.invalid/client-callback",
      resource, requested_scopes: ["context:write"] })])).rows[0].value;
    const approved = (await native.query("select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) value", [clientIssuer,
      prepared.request_id, prepared.version, JSON.stringify([{ resource_kind: "scope", resource_id: "project:" + project, environment: "canonical", actions: ["write", "close"] }]),
      token, new Date(Date.now() + 3 * 3600000).toISOString()])).rows[0].value;
    const lineage = randomUUID(), digest = (await admin.query("select clued_private.storage_client_request_digest_v2($1) value", [prepared.request_id])).rows[0].value;
    await admin.query("insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,metadata_digest,review_receipt_id) values($1,1,$2,$3,$4,$5,$6)",
      [lineage, clientIssuer, resource, clientId, digest, receipt]);
    await admin.query("insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,review_receipt_id) values($1,$2,1,$3,$4)",
      [prepared.request_id, lineage, digest, receipt]);
    await admin.query("insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,receipt_id) values($1,1,$2)", [lineage, receipt]);
    return { token, id: approved.binding_id, lineage };
  };
  const search = (client, extra = {}) => caller.query("select public.clued_storage_read_v1($1,$2,$3::jsonb) value", [issuer, client.token,
    JSON.stringify({ action: "admit", connection_id: connection, operation: "search", condition_hmac: sha("cond"), key_id: "k1", content_search: true, ...extra })]);

  try {
    await t.test("normal use needs a normal credential: a legacy connection answers reconsent_required and writes nothing", async () => {
      const before = await status();
      assert.equal(before.provider_scope_profile, "legacy"); assert.equal(before.reconsent_required, true);
      assert.equal(before.normal_use, false); assert.equal(before.disclosure_version, NORMAL_DISCLOSURE);
      assert.equal(before.content_profile, "text/1"); assert.deepEqual(before.classes, ["read"]);
      const answer = await toggle("enable");
      assert.deepEqual(answer, { status: "reconsent_required", connection_id: connection, provider_scope_profile: "legacy", execution_permitted: false });
      assert.deepEqual(await activeRead(), { classes: ["read"], content_profile: "text/1", disclosure_version: READ_DISCLOSURE, read_generation: "1" });
      await assert.rejects(toggle("enable", { disclosure_version: "clued.storage-normal-use-disclosure/0" }), /storage_normal_use_disclosure_changed/);
      await assert.rejects(toggle("disable"), /storage_owner_version_conflict/, "nothing to disable");
      await assert.rejects(normalUse({ action: "status", connection_id: connection, extra: 1 }), /storage_owner_input_invalid/);
    });

    await t.test("re-consent prepare validates normal use and refuses while the root is busy", async () => {
      const described = await oauth({ action: "describe", connection_id: connection });
      const base = { action: "prepare", connection_id: connection, connection_version: described.connection_version, verifier_envelope: envelope("V") };
      for (const bad of [{ requested_scope_profile: "full" }, { requested_scope_profile: 1 }, { normal_use: { disclosure_version: NORMAL_DISCLOSURE } },
        { requested_scope_profile: "legacy", normal_use: { disclosure_version: NORMAL_DISCLOSURE } },
        { requested_scope_profile: "normal", normal_use: { disclosure_version: NORMAL_DISCLOSURE, extra: true } }]) {
        await assert.rejects(oauth({ ...base, attempt_id: randomUUID(), state_hash: sha(randomUUID()), ...bad }), /storage_oauth_denied/, JSON.stringify(bad));
      }
      await assert.rejects(oauth({ ...base, attempt_id: randomUUID(), state_hash: sha(randomUUID()), requested_scope_profile: "normal",
        normal_use: { disclosure_version: "other/1" } }), /storage_normal_use_disclosure_changed/);
      const busy = await mutation();
      try {
        await assert.rejects(prepare({ requested_scope_profile: "normal", normal_use: { disclosure_version: NORMAL_DISCLOSURE } }),
          /storage_root_has_unresolved_mutation/, "prepare gives the early busy answer");
      } finally { await settle(busy); }
      const { state_hash } = await prepare({ requested_scope_profile: "normal", normal_use: { disclosure_version: NORMAL_DISCLOSURE } });
      await oauth({ action: "claim", state_hash });
      const before = await row(), again = await mutation();
      try {
        await assert.rejects(complete(state_hash, envelope("BUSY"), "normal"), /storage_root_has_unresolved_mutation/);
      } finally { await settle(again); }
      const after = await row();
      assert.deepEqual(after.credential_envelope, OLD, "a refused completion keeps the old credential");
      assert.equal(after.credential_version, before.credential_version); assert.equal(after.provider_scope_profile, "legacy");
      assert.deepEqual(await delegation(), { enabled: true, version: "1", receipt_id: receipt });
    });

    await t.test("the granted profile must be the requested one or legacy; any failure keeps the old credential", async () => {
      const legacyAttempt = await prepare({ requested_scope_profile: "legacy" });
      assert.equal((await oauth({ action: "claim", state_hash: legacyAttempt.state_hash })).requested_scope_profile, "legacy");
      await assert.rejects(complete(legacyAttempt.state_hash, envelope("UP"), "normal"), /storage_oauth_denied/, "a legacy request cannot silently become normal");
      const plain = await prepare();
      assert.equal((await admin.query("select requested_scope_profile,normal_use_requested from clued_private.storage_oauth_attempts_v1 where id=$1", [plain.attempt_id])).rows[0].requested_scope_profile,
        "legacy", "an attempt without a requested profile is bound to legacy");
      await oauth({ action: "claim", state_hash: plain.state_hash });
      await assert.rejects(complete(plain.state_hash, envelope("UP"), "normal"), /storage_oauth_denied/);
      await assert.rejects(complete(plain.state_hash, { ...envelope("BAD"), nonce: "short" }, "legacy"), /storage_oauth_denied/);
      const stored = await row();
      assert.deepEqual(stored.credential_envelope, OLD); assert.equal(stored.provider_scope_profile, "legacy");
      assert.deepEqual(await delegation(), { enabled: true, version: "1", receipt_id: receipt });
    });

    let MID; const olds = [OLD];
    await t.test("partial grant: normal requested, legacy granted -> credential replaced, profile legacy, normal use stays off, delegation carried", async () => {
      const { state_hash, attempt_id } = await prepare({ requested_scope_profile: "normal", normal_use: { disclosure_version: NORMAL_DISCLOSURE } });
      const attempt = (await admin.query("select * from clued_private.storage_oauth_attempts_v1 where id=$1", [attempt_id])).rows[0];
      assert.equal(attempt.requested_scope_profile, "normal"); assert.equal(attempt.normal_use_requested, true);
      assert.equal(attempt.disclosure_version, NORMAL_DISCLOSURE); assert.equal(attempt.normal_use_read_generation, "1");
      assert.deepEqual(attempt.carry_snapshot, { provider_subject: "normal-subject", oauth_client_id: oauthClient, root_folder_id: rootId });
      assert.equal((await oauth({ action: "claim", state_hash })).requested_scope_profile, "normal");
      const before = await row();
      MID = envelope("MIDenv");
      const done = await complete(state_hash, MID, "legacy"); olds.push(MID);
      assert.equal(done.status, "completed"); assert.equal(done.provider_scope_profile, "legacy");
      assert.equal(done.normal_use_enabled, false); assert.equal(done.refresh_enabled, true);
      const after = await row();
      assert.deepEqual(after.credential_envelope, MID); assert.equal(Number(after.credential_version), Number(before.credential_version) + 1);
      assert.equal(after.provider_scope_profile, "legacy");
      assert.deepEqual(await activeRead(), { classes: ["read"], content_profile: "text/1", disclosure_version: READ_DISCLOSURE, read_generation: "1" });
      const carried = await delegation();
      assert.equal(carried.enabled, true); assert.equal(carried.version, "3", "disabled by the inner wrapper, then carried");
      assert.equal(carried.receipt_id, done.refresh_carry_receipt_id);
      const carry = (await admin.query("select operation,status from public.clued_audit_receipts where id=$1", [done.refresh_carry_receipt_id])).rows[0];
      assert.deepEqual(carry, { operation: "storage_refresh_delegation_carry", status: "committed" });
      assert.equal((await admin.query("select count(*)::int n from public.clued_context_events where receipt_id=$1 and canonical_event_type='extension:storage:refresh_delegation_carry'",
        [done.refresh_carry_receipt_id])).rows[0].n, 1);
      assert.notEqual(done.refresh_carry_receipt_id, done.receipt_id);
    });

    await t.test("carry needs all four conditions: a disabled delegation or a changed prepare snapshot stays disabled", async () => {
      await admin.query("update clued_private.storage_refresh_delegations_v1 set enabled=false,version=version+1 where connection_id=$1", [connection]);
      const off = await prepare({ requested_scope_profile: "legacy" });
      await oauth({ action: "claim", state_hash: off.state_hash });
      const noCarry = await complete(off.state_hash, envelope("MIDenv"), "legacy");
      assert.equal(noCarry.refresh_enabled, false); assert.equal("refresh_carry_receipt_id" in noCarry, false);
      olds.push((await row()).credential_envelope);
      await admin.query("update clued_private.storage_refresh_delegations_v1 set enabled=true,version=version+1 where connection_id=$1", [connection]);
      const drift = await prepare({ requested_scope_profile: "legacy" });
      await admin.query("update clued_private.storage_oauth_attempts_v1 set carry_snapshot=jsonb_set(carry_snapshot,'{oauth_client_id}','\"other-client\"') where id=$1", [drift.attempt_id]);
      await oauth({ action: "claim", state_hash: drift.state_hash });
      const drifted = await complete(drift.state_hash, envelope("MIDenv"), "legacy");
      assert.equal(drifted.refresh_enabled, false, "a snapshot that differs from the connection before completion is not carried");
      olds.push((await row()).credential_envelope);
      await admin.query("update clued_private.storage_refresh_delegations_v1 set enabled=true,version=version+1 where connection_id=$1", [connection]);
    });

    let NEW;
    await t.test("full re-consent: normal granted -> normal profile, normal/1 read access in the same transaction, carry, and no residue of old envelopes", async () => {
      const { state_hash } = await prepare({ requested_scope_profile: "normal", normal_use: { disclosure_version: NORMAL_DISCLOSURE } });
      await oauth({ action: "claim", state_hash });
      const before = await row();
      NEW = envelope("NEWenv");
      const done = await complete(state_hash, NEW, "normal");
      assert.equal(done.status, "completed"); assert.equal(done.provider_scope_profile, "normal");
      assert.equal(done.normal_use_enabled, true); assert.equal(done.refresh_enabled, true);
      const after = await row();
      assert.equal(after.provider_scope_profile, "normal"); assert.deepEqual(after.credential_envelope, NEW);
      assert.equal(Number(after.credential_version), Number(before.credential_version) + 1);
      assert.equal(after.auth_mode, "account_policy"); assert.equal(after.auth_generation, before.auth_generation, "the write policy is untouched");
      const read = await activeRead();
      assert.deepEqual(read.classes, ["read", "read_content"]); assert.equal(read.content_profile, "normal/1");
      assert.equal(read.disclosure_version, NORMAL_DISCLOSURE);
      const normalReceipt = (await admin.query("select operation,status from public.clued_audit_receipts where id=$1", [done.normal_use_receipt_id])).rows[0];
      assert.deepEqual(normalReceipt, { operation: "storage_normal_use_v1", status: "committed" });
      assert.deepEqual(await oauth({ action: "claim", state_hash }), { status: "completed", receipt_id: done.receipt_id, refresh_enabled: true });
      const current = await status();
      assert.equal(current.normal_use, true); assert.equal(current.reconsent_required, false);
      // §2.4 item 5: no copy of an old envelope anywhere (digests excepted).
      const columns = (await admin.query(`select c.table_schema s,c.table_name t,c.column_name n,c.data_type d from information_schema.columns c
        join information_schema.tables tb on tb.table_schema=c.table_schema and tb.table_name=c.table_name and tb.table_type='BASE TABLE'
        where c.table_schema in ('clued_private','public') and c.data_type in ('jsonb','json','text','character varying','bytea')`)).rows;
      assert.ok(columns.length > 20);
      assert.equal(olds.length, 4);
      for (const old of olds) {
        const needles = [old.ciphertext, old.ciphertext.slice(0, 24), old.ciphertext.slice(-24)];
        for (const needle of needles) {
          let hits = 0;
          for (const column of columns) {
            const target = `${JSON.stringify(column.s)}.${JSON.stringify(column.t)}`, name = JSON.stringify(column.n);
            const where = column.d === "bytea" ? `position(convert_to($1,'UTF8') in ${name})>0` : `${name}::text like '%'||$1||'%'`;
            hits += (await admin.query(`select count(*)::int n from ${target} where ${where}`, [needle])).rows[0].n;
          }
          assert.equal(hits, 0, "old envelope fragment found after re-consent");
        }
      }
      let newHits = 0;
      for (const column of columns.filter(c => c.d === "jsonb")) {
        newHits += (await admin.query(`select count(*)::int n from ${JSON.stringify(column.s)}.${JSON.stringify(column.t)} where ${JSON.stringify(column.n)}::text like '%'||$1||'%'`,
          [NEW.ciphertext])).rows[0].n;
      }
      assert.equal(newHits, 1, "the search does find the current envelope, only on the connection row");
    });

    await t.test("clued_storage_normal_use_v1: disable keeps browsing, enable restores normal/1, CAS and replay", async () => {
      const on = await status();
      await assert.rejects(toggle("enable"), /storage_owner_version_conflict/, "already enabled");
      await assert.rejects(normalUse({ action: "disable", connection_id: connection, base_generation: on.read_generation + 5,
        disclosure_version: NORMAL_DISCLOSURE, idempotency_key: randomUUID() }), /storage_owner_version_conflict/);
      const key = randomUUID(), request = { action: "disable", connection_id: connection, base_generation: on.read_generation,
        disclosure_version: NORMAL_DISCLOSURE, idempotency_key: key };
      const off = await normalUse(request);
      assert.equal(off.status, "committed");
      assert.deepEqual(await normalUse(request), off, "a replay returns the committed result");
      const read = await activeRead();
      assert.deepEqual(read.classes, ["read"]); assert.equal(read.content_profile, "text/1"); assert.equal(read.disclosure_version, READ_DISCLOSURE);
      assert.equal((await status()).normal_use, false);
      const enabled = await toggle("enable");
      assert.equal(enabled.status, "committed");
      assert.deepEqual((await activeRead()).classes, ["read", "read_content"]); assert.equal((await activeRead()).content_profile, "normal/1");
      const event = (await admin.query("select change_summary from public.clued_context_events where receipt_id=$1", [enabled.receipt_id])).rows[0].change_summary;
      assert.equal(event.normal_use, true); assert.equal(event.content_profile, "normal/1"); assert.equal(event.source, "owner");
    });

    await t.test("set_classes never silently rewrites normal/1 as text/1; status reports both profiles", async () => {
      const current = await access({ action: "status", connection_id: connection });
      assert.equal(current.content_profile, "normal/1"); assert.equal(current.provider_scope_profile, "normal");
      await assert.rejects(access({ action: "set_classes", connection_id: connection, classes: ["read", "read_content"], base_generation: current.read_generation,
        disclosure_version: "clued.storage-read-content-disclosure/1", idempotency_key: randomUUID() }), /storage_normal_use_managed/);
      assert.equal((await activeRead()).content_profile, "normal/1");
    });

    await t.test("content search admission: normal/1 and a normal credential are required, with a condition HMAC", async () => {
      const client = await bind();
      const admitted = (await search(client)).rows[0].value;
      assert.equal(admitted.class, "read"); assert.equal(admitted.content_profile, "normal/1"); assert.equal(admitted.provider_scope_profile, "normal");
      await assert.rejects(search(client, { condition_hmac: undefined, key_id: undefined }), /storage_read_input_invalid/);
      await assert.rejects(search(client, { operation: "list" }), /storage_read_input_invalid/);
      await assert.rejects(search(client, { content_search: false }), /storage_read_input_invalid/);
      // A per-client read_content deny also stops content search.
      const deny = (await native.query("select public.clued_storage_read_access_v1($1::jsonb) value", [JSON.stringify({ action: "deny_class",
        binding_id: client.id, class: "read_content", denied: true, base_generation: 0, idempotency_key: randomUUID() })])).rows[0].value;
      assert.equal(deny.status, "committed");
      await assert.rejects(search(client), /storage_read_denied/);
      const plain = (await caller.query("select public.clued_storage_read_v1($1,$2,$3::jsonb) value", [issuer, client.token,
        JSON.stringify({ action: "admit", connection_id: connection, operation: "search", condition_hmac: sha("cond"), key_id: "k1" })])).rows[0].value;
      assert.equal(plain.class, "read", "a name search is still a read-level operation");
      const other = await bind();
      assert.equal((await toggle("disable")).status, "committed");
      await assert.rejects(search(other), /storage_read_scope_upgrade_required/, "text/1 read access cannot search by content");
      assert.equal((await toggle("enable")).status, "committed");
      await admin.query("update clued_private.storage_connections_v1 set provider_scope_profile='legacy' where id=$1", [connection]);
      try { await assert.rejects(search(other), /storage_read_scope_upgrade_required/, "a legacy credential cannot search by content"); }
      finally { await admin.query("update clued_private.storage_connections_v1 set provider_scope_profile='normal' where id=$1", [connection]); }
    });

    await t.test("refresh-token count per account x client: warning at 50, new re-consent refused at 90", async () => {
      const counted = await tokenCount();
      assert.ok(counted >= 6, "every claim above was counted");
      assert.equal((await status()).refresh_token_count, counted);
      const fill = async n => admin.query(`with a as (insert into clued_private.storage_oauth_attempts_v1(id,connection_id,owner_id,session_id,issuer_hash,connection_version,
        state_hash,verifier_envelope,expires_at,status) select gen_random_uuid(),$1,$2,$3,$4,1,encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),
        '{}'::jsonb,clock_timestamp(),'completed' from generate_series(1,$5::int) returning id)
        insert into clued_private.storage_refresh_token_issuance_v1(oauth_attempt_id,owner_id,oauth_client_id,provider_subject,connection_id,purpose)
        select id,$2,$6,'normal-subject',$1,'connection' from a`, [connection, user, session, issuer, n, oauthClient]);
      await fill(50 - counted);
      const warned = await status();
      assert.equal(warned.refresh_token_count, 50); assert.equal(warned.refresh_token_warning, true); assert.equal(warned.refresh_token_blocked, false);
      await fill(40);
      const blocked = await status();
      assert.equal(blocked.refresh_token_count, 90); assert.equal(blocked.refresh_token_blocked, true);
      await assert.rejects(prepare({ requested_scope_profile: "normal", normal_use: { disclosure_version: NORMAL_DISCLOSURE } }), /storage_refresh_token_limit/);
      // Another Google account of the same owner is counted separately.
      assert.equal((await admin.query("select clued_private.storage_refresh_token_count_v1($1,'someone-else',$2) n", [user, oauthClient])).rows[0].n, 0);
      await admin.query("update clued_private.storage_refresh_token_issuance_v1 set cleared_at=clock_timestamp() where owner_id=$1 and oauth_client_id=$2", [user, oauthClient]);
      assert.equal((await status()).refresh_token_count, 0);
      await assert.rejects(native.query("select * from clued_private.storage_refresh_token_issuance_v1"), /permission denied/);
    });
  } finally {
    for (const database of clients) await database.end();
  }
}
