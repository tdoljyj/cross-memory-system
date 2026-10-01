import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const sha = value => createHash("sha256").update(value).digest("hex");
const ONBOARD_DISCLOSURE = "clued.storage-onboard-disclosure/1";
const NORMAL_DISCLOSURE = "clued.storage-normal-use-disclosure/1";
const READ_DISCLOSURE = "clued.storage-read-disclosure/1";

// StorageNormalUse.v0.1 N0 at the database layer: the onboard attempt, the
// onboard dispatch of the outermost OAuth wrapper, idempotent directory
// effects with orphans, the single activation transaction and its rollback,
// legacy -> text/1, the default refresh delegation, the allowlist gate, the
// Host /clued-cloud/ refusal and the Owner's existing connections staying
// unchanged. Synthetic, disposable PostgreSQL only.
export async function testStorageOnboard(t, admin, server, user, decision) {
  const clients = [], session = randomUUID(), otherSession = randomUUID();
  const issuerSecret = randomBytes(32).toString("hex"), issuer = sha(issuerSecret), clientIssuer = sha(randomUUID());
  const oauthClient = `onboard-${randomUUID()}`, resource = "https://onboard.invalid/mcp";
  const project = (await admin.query("select project_id from public.clued_memories where id=$1", [decision])).rows[0].project_id;
  const connect = async (role, sid) => {
    const database = server.getPgClient(); clients.push(database); await database.connect();
    await database.query("set statement_timeout='20s'");
    if (role) await database.query(`set role ${role}`);
    if (sid) await database.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",
      [user, JSON.stringify({ sub: user, session_id: sid })]);
    return database;
  };
  await admin.query("insert into auth.sessions(id,user_id) values($1,$2),($3,$2)", [session, user, otherSession]);
  const native = await connect("authenticated", session), other = await connect("authenticated", otherSession), caller = await connect("anon");
  await admin.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'onboard-fixture')", [clientIssuer, resource]);
  await admin.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,read_enabled,execution_enabled) values($1,$2,'https://onboard.invalid/storage/google/callback',true,true)",
    [issuer, oauthClient]);

  const envelope = tag => ({ contract: "clued.storage-credential/1", key_id: "fixture", nonce: "N".repeat(16),
    ciphertext: tag + randomBytes(48).toString("base64url") });
  const row = async id => (await admin.query("select * from clued_private.storage_onboard_attempts_v1 where id=$1", [id])).rows[0];
  // The run calls carry the current run token unless a test passes one (or
  // run_token: undefined to send none); the lease tests pass stale ones.
  const runActions = new Set(["effect_intent", "effect_result", "activate", "fail"]);
  const onboard = async (input, database = native) => {
    if (runActions.has(input.action) && !("run_token" in input)) {
      const token = (await row(input.onboard_attempt_id))?.run_token;
      if (token) input = { ...input, run_token: token };
    }
    if ("run_token" in input && input.run_token === undefined) { input = { ...input }; delete input.run_token; }
    return (await database.query("select public.clued_storage_onboard_v1($1,$2::jsonb) value", [issuerSecret, JSON.stringify(input)])).rows[0].value;
  };
  const sweep = async (hash = issuer, database = caller) =>
    (await database.query("select public.clued_storage_onboard_sweep_v1($1) value", [hash])).rows[0].value;
  const callback = async (input, database = native) => (await database.query("select public.clued_storage_oauth_callback_v2($1,$2::jsonb) value",
    [issuerSecret, JSON.stringify(input)])).rows[0].value;
  const outer = async input => (await native.query("select public.clued_storage_oauth_v1($1,$2::jsonb) value", [issuer, JSON.stringify(input)])).rows[0].value;

  // The Worker renders the disclosure (storage-onboard-disclosure.ts); here any
  // text naming the root in 「」 with its SHA-256 stands in for it.
  const begin = async ({ name = `Clued_资料中心_${randomUUID().slice(0, 8)}`, mode = "new", folder_id, tracks = ["资料", "项目", "归档"],
    normal = true, refresh = true, database = native, overrides = {} } = {}) => {
    const text = `点击“确认并连接 Google Drive”即表示你确认：Clued 使用你 Google 云端硬盘中的「${name}」作为资料根目录。`;
    const input = { action: "begin", owner_id: user, onboard_attempt_id: randomUUID(), oauth_attempt_id: randomUUID(), connection_id: randomUUID(),
      state_hash: sha(randomUUID()), verifier_envelope: envelope("V"), root: mode === "new" ? { mode, name } : { mode, name, folder_id },
      tracks, normal_use_requested: normal, default_refresh_requested: refresh, disclosure_version: ONBOARD_DISCLOSURE,
      disclosure_text: text, disclosure_sha256: sha(text), ...overrides };
    const begun = await onboard(input, database);
    return { ...input, begun, name, tracks };
  };
  const claimAndStage = async (attempt, granted = attempt.normal_use_requested ? "normal" : "legacy", subject = "onboard-subject") => {
    const claimed = await callback({ action: "claim", state_hash: attempt.state_hash });
    assert.equal(claimed.status, "claimed"); assert.equal(claimed.purpose, "onboard");
    const credential = envelope("CRED");
    const staged = await onboard({ action: "stage_credential", state_hash: attempt.state_hash, provider_subject: subject,
      credential_envelope: credential, provider_scope_profile: granted });
    assert.equal(staged.status, "credential_staged"); assert.match(staged.run_token, /^[0-9a-f-]{36}$/);
    return { claimed, staged, credential };
  };
  const ids = new Map();
  const driveId = role => { if (!ids.has(role)) ids.set(role, `drv-${randomUUID()}`); return ids.get(role); };
  const effects = async (attempt, { rootId, parent = "my-drive-root", picked = false } = {}) => {
    const root = rootId ?? driveId(attempt.onboard_attempt_id + ":root");
    if (!picked) await onboard({ action: "effect_intent", onboard_attempt_id: attempt.onboard_attempt_id, role: "root" });
    await onboard({ action: "effect_result", onboard_attempt_id: attempt.onboard_attempt_id, role: "root", provider_file_id: root,
      version: "3", parents: [parent], created: !picked });
    for (const track of attempt.tracks) {
      const role = "track:" + track;
      await onboard({ action: "effect_intent", onboard_attempt_id: attempt.onboard_attempt_id, role });
      await onboard({ action: "effect_result", onboard_attempt_id: attempt.onboard_attempt_id, role,
        provider_file_id: driveId(attempt.onboard_attempt_id + ":" + role), version: "1", parents: [root], created: true });
    }
    return { root, parent };
  };
  const activate = (attempt, ancestors = ["my-drive-root"], database = native) =>
    onboard({ action: "activate", onboard_attempt_id: attempt.onboard_attempt_id, ancestors }, database);
  // Canonical rows of this owner: everything activation may create.
  const canonical = async () => (await admin.query(`select
      (select count(*) from public.clued_projects where user_id=$1)::int projects,
      (select count(*) from public.clued_memories where user_id=$1)::int memories,
      (select count(*) from clued_private.resource_center_profiles_v1 where user_id=$1)::int profiles,
      (select count(*) from clued_private.resource_center_artifacts_v1 where user_id=$1)::int artifacts,
      (select count(*) from clued_private.storage_connections_v1 where owner_id=$1)::int connections,
      (select count(*) from clued_private.storage_account_policies_v2 where owner_id=$1)::int policies,
      (select count(*) from clued_private.storage_read_access_v1 where owner_id=$1)::int read_access,
      (select count(*) from clued_private.storage_refresh_delegations_v1 d join clued_private.storage_connections_v1 c on c.id=d.connection_id where c.owner_id=$1)::int delegations,
      (select count(*) from public.clued_audit_receipts where user_id=$1)::int receipts,
      (select count(*) from public.clued_context_events where user_id=$1)::int events`, [user])).rows[0];
  // The Owner's existing connections (every fixture before this one, plus one
  // account-policy connection with a delegation created here).
  const existing = async () => (await admin.query(`select c.id,c.version,c.state,c.auth_mode,c.auth_generation,c.account_policy_id,c.credential_version,
      c.provider_scope_profile,c.credential_envelope,
      (select to_jsonb(array_agg(jsonb_build_object('id',ra.id,'state',ra.state,'classes',ra.classes,'content_profile',ra.content_profile) order by ra.id))
        from clued_private.storage_read_access_v1 ra where ra.connection_id=c.id) read_access,
      (select to_jsonb(array_agg(jsonb_build_object('id',ap.id,'state',ap.state,'generation',ap.policy_generation) order by ap.id))
        from clued_private.storage_account_policies_v2 ap where ap.connection_id=c.id) policies,
      (select jsonb_build_object('enabled',d.enabled,'version',d.version,'receipt_id',d.receipt_id) from clued_private.storage_refresh_delegations_v1 d where d.connection_id=c.id) delegation
    from clued_private.storage_connections_v1 c where c.owner_id=$1 order by c.id`, [user])).rows;

  const register = async input => (await admin.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) value", [user,
    JSON.stringify({ source_decision_id: decision, idempotency_key: randomUUID(), ...input })])).rows[0].value;
  const suffix = randomUUID(), ownerRoot = `owner-root-${suffix}`, ownerManaged = `/onboard-owner-${suffix}/Clued_资料中心`;
  const ownerProfile = (await register({ action: "profile_register", project_id: project, profile_version: `onboard-owner/${suffix}`,
    managed_root: ownerManaged, root_folder_id: ownerRoot, root_parent_id: `owner-parent-${suffix}`, root_folder_version: "1" }))
    .target_refs.find(ref => ref.role === "primary").id;
  await register({ action: "artifact_register", profile_id: ownerProfile, path: ownerManaged + "/20_P_产品与体验", provider_file_id: `owner-track-${suffix}`,
    provider_file_version: "1", target_kind: "directory", governance_class: "ordinary", delete_authority: false });
  assert.equal((await admin.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) value", [user, JSON.stringify({
    profile_id: ownerProfile, base_version: 1, allowed_root_children: ["20_P_产品与体验"], source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value.status, "committed");
  const registered = (await native.query("select public.clued_storage_account_v1($1::jsonb) value", [JSON.stringify({
    action: "register", profile_id: ownerProfile, source_decision_id: decision, idempotency_key: randomUUID() })])).rows[0].value;
  const ownerConnection = registered.target_refs.find(ref => ref.role === "primary").id;
  // The 145426 describe answer for a fresh awaiting connection, before activation.
  const describedEligible = (await outer({ action: "describe", connection_id: ownerConnection })).default_refresh_eligible;
  const helperEligible = (await admin.query("select clued_private.storage_default_refresh_eligible_v1($1,$2) v", [user, ownerConnection])).rows[0].v;
  {
    const described = await outer({ action: "describe", connection_id: ownerConnection }), state_hash = sha(randomUUID());
    await outer({ action: "prepare", connection_id: ownerConnection, connection_version: described.connection_version, attempt_id: randomUUID(),
      state_hash, verifier_envelope: envelope("V"), requested_scope_profile: "legacy", default_refresh_consent: true });
    await outer({ action: "claim", state_hash });
    const done = await outer({ action: "complete", state_hash, provider_subject: "onboard-subject", credential_envelope: envelope("OWNER"), provider_scope_profile: "legacy" });
    assert.equal(done.refresh_enabled, true);
    const policy = randomUUID();
    await admin.query("begin");
    try {
      await admin.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,
        scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id,activation_receipt_id,state)
        select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,
          c.source_decision_id,c.decision_version,'reviewed_transition','onboard-fixture/1',c.receipt_id,c.receipt_id,'active'
        from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`, [policy, ownerConnection]);
      await admin.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1", [ownerConnection, policy]);
      await admin.query("commit");
    } catch (error) { await admin.query("rollback"); throw error; }
  }
  const ownerBefore = await existing();
  assert.ok(ownerBefore.length >= 1);

  const bind = async () => {
    const token = sha(randomUUID()), clientId = `onboard-client-${randomUUID()}`;
    const prepared = (await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) value", [clientIssuer, JSON.stringify({
      request_digest: sha(randomUUID()), client_id: clientId, client_name: "Onboard fixture", redirect_uri: "https://onboard.invalid/client-callback",
      resource, requested_scopes: ["context:write"] })])).rows[0].value;
    const approved = (await native.query("select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) value", [clientIssuer,
      prepared.request_id, prepared.version, JSON.stringify([{ resource_kind: "scope", resource_id: "project:" + project, environment: "canonical", actions: ["write", "close"] }]),
      token, new Date(Date.now() + 3 * 3600000).toISOString()])).rows[0].value;
    const lineage = randomUUID(), digest = (await admin.query("select clued_private.storage_client_request_digest_v2($1) value", [prepared.request_id])).rows[0].value;
    await admin.query("insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,metadata_digest,review_receipt_id) values($1,1,$2,$3,$4,$5,$6)",
      [lineage, clientIssuer, resource, clientId, digest, registered.receipt_id]);
    await admin.query("insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,review_receipt_id) values($1,$2,1,$3,$4)",
      [prepared.request_id, lineage, digest, registered.receipt_id]);
    await admin.query("insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,receipt_id) values($1,1,$2)", [lineage, registered.receipt_id]);
    return { token, id: approved.binding_id };
  };

  try {
    await t.test("N0 gate: an owner who is not on the allowlist (and no verified opening) is refused before any row", async () => {
      const before = await canonical();
      await assert.rejects(begin(), /storage_onboard_not_allowed/);
      assert.deepEqual(await canonical(), before);
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_onboard_attempts_v1 where owner_id=$1", [user])).rows[0].n, 0);
      const listed = await onboard({ action: "list" });
      assert.equal(listed.allowed, false);
      await admin.query("insert into clued_private.storage_onboard_allowlist_v1(owner_id,note) values($1,'test user')", [user]);
      assert.equal((await onboard({ action: "list" })).allowed, true);
      await assert.rejects(native.query("select * from clued_private.storage_onboard_allowlist_v1"), /permission denied/);
    });

    await t.test("helper eligibility equals the 145426 describe answer (verbatim predicate)", async () => {
      assert.equal(describedEligible, true); assert.equal(helperEligible, true);
      const after = (await admin.query("select clued_private.storage_default_refresh_eligible_v1($1,$2) v", [user, ownerConnection])).rows[0].v;
      assert.equal(after, false, "an active connection is not eligible, as in 145426");
    });

    await t.test("Host profile_register refuses the /clued-cloud/ prefix", async () => {
      for (const managed_root of ["/clued-cloud/google-drive/x", "/clued-cloud", "/Clued-Cloud/x"]) {
        const result = await register({ action: "profile_register", project_id: project, profile_version: "host/" + randomUUID(), managed_root,
          root_folder_id: "host-" + randomUUID().slice(0, 8), root_parent_id: "host-parent", root_folder_version: "1" });
        assert.notEqual(result.status, "committed", managed_root);
        assert.match(JSON.stringify(result), /resource_center_profile_root_reserved/);
      }
    });

    let main;
    await t.test("begin writes no canonical row; the OAuth attempt is purpose onboard with no connection", async () => {
      const before = await canonical();
      main = await begin();
      assert.equal(main.begun.status, "begun"); assert.equal(main.begun.oauth_client_id, oauthClient);
      assert.equal(main.begun.requested_scope_profile, "normal");
      assert.deepEqual(await canonical(), before);
      const attempt = (await admin.query("select purpose,connection_id,onboard_attempt_id,status,connection_version from clued_private.storage_oauth_attempts_v1 where id=$1",
        [main.oauth_attempt_id])).rows[0];
      assert.deepEqual(attempt, { purpose: "onboard", connection_id: null, onboard_attempt_id: main.onboard_attempt_id, status: "prepared", connection_version: "0" });
      const stored = await row(main.onboard_attempt_id);
      assert.equal(stored.state, "begun"); assert.equal(stored.disclosure_sha256, main.disclosure_sha256);
      assert.ok(new Date(stored.expires_at) - Date.now() > 25 * 60000);
      // (purpose='onboard') = (connection_id is null).
      await assert.rejects(admin.query("update clued_private.storage_oauth_attempts_v1 set connection_id=$2 where id=$1", [main.oauth_attempt_id, ownerConnection]),
        /storage_oauth_onboard_connection_v1/);
      await assert.rejects(admin.query("update clued_private.storage_oauth_attempts_v1 set onboard_attempt_id=null where id=$1", [main.oauth_attempt_id]),
        /check constraint/);
    });

    await t.test("begin validates its input, disclosure and digest", async () => {
      await assert.rejects(begin({ overrides: { disclosure_version: "clued.storage-onboard-disclosure/0" } }), /storage_onboard_disclosure_changed/);
      await assert.rejects(begin({ overrides: { disclosure_sha256: sha("other") } }), /storage_onboard_input_invalid/);
      await assert.rejects(begin({ overrides: { owner_id: randomUUID() } }), /storage_onboard_input_invalid/);
      await assert.rejects(begin({ tracks: [] }), /storage_onboard_input_invalid/);
      await assert.rejects(begin({ tracks: ["a/b"] }), /storage_onboard_input_invalid/);
      await assert.rejects(begin({ tracks: ["x", "x"] }), /storage_onboard_input_invalid/);
      await assert.rejects(begin({ mode: "picked", folder_id: "bad id!" }), /storage_onboard_input_invalid/);
      await assert.rejects(begin({ overrides: { connection_id: ownerConnection } }), /storage_onboard_input_invalid/);
      await assert.rejects(begin({ mode: "picked", folder_id: ownerRoot }), /storage_onboard_root_overlaps_existing/);
    });

    await t.test("onboard claim is one-shot, counted before exchange, and dispatched by the outermost wrapper only", async () => {
      const count = async () => (await admin.query("select count(*)::int n from clued_private.storage_refresh_token_issuance_v1 where oauth_attempt_id=$1", [main.oauth_attempt_id])).rows[0].n;
      assert.equal(await count(), 0);
      // Another native session cannot claim.
      await assert.rejects(callback({ action: "claim", state_hash: main.state_hash }, other), /storage_oauth_denied/);
      const claimed = await callback({ action: "claim", state_hash: main.state_hash });
      assert.equal(claimed.status, "claimed"); assert.equal(claimed.connection_id, main.connection_id);
      assert.equal(claimed.credential_version, 1); assert.equal(claimed.provider_subject, null);
      assert.equal(claimed.owner_id, user); assert.equal(claimed.requested_scope_profile, "normal");
      assert.deepEqual(claimed.verifier_envelope, main.verifier_envelope);
      assert.equal(await count(), 1, "the claim is counted (§2.4 item 8)");
      await assert.rejects(callback({ action: "claim", state_hash: main.state_hash }), /storage_oauth_denied/, "single use");
      await assert.rejects(callback({ action: "inspect", state_hash: main.state_hash }), /storage_oauth_denied/);
      // The staged profile must be the requested one or legacy; envelope and subject checked.
      await assert.rejects(onboard({ action: "stage_credential", state_hash: main.state_hash, provider_subject: "bad subject!",
        credential_envelope: envelope("X"), provider_scope_profile: "normal" }), /storage_oauth_denied/);
      await assert.rejects(onboard({ action: "stage_credential", state_hash: main.state_hash, provider_subject: "onboard-subject",
        credential_envelope: { ...envelope("X"), nonce: "short" }, provider_scope_profile: "normal" }), /storage_oauth_denied/);
      const staged = await outer({ action: "complete", state_hash: main.state_hash, provider_subject: "onboard-subject",
        credential_envelope: (main.credential = envelope("CRED")), provider_scope_profile: "normal" });
      assert.equal(staged.status, "credential_staged"); assert.deepEqual(staged.active_roots.includes(ownerRoot), true);
      assert.equal("credential_envelope" in staged, false, "the staged envelope never leaves the database here");
      const stored = await row(main.onboard_attempt_id);
      assert.equal(stored.state, "credential_staged"); assert.deepEqual(stored.credential_envelope, main.credential);
      assert.equal((await admin.query("select provider_subject from clued_private.storage_refresh_token_issuance_v1 where oauth_attempt_id=$1", [main.oauth_attempt_id])).rows[0].provider_subject,
        "onboard-subject");
    });

    await t.test("directory effects are idempotent: replayed intents and results never create a second record", async () => {
      await assert.rejects(onboard({ action: "effect_intent", onboard_attempt_id: main.onboard_attempt_id, role: "track:资料" }),
        /storage_onboard_input_invalid/, "tracks need the root first");
      await assert.rejects(onboard({ action: "effect_result", onboard_attempt_id: main.onboard_attempt_id, role: "root",
        provider_file_id: "x1", version: "1", parents: ["p"], created: true }), /storage_onboard_input_invalid/, "a created object needs its intent first");
      const first = await onboard({ action: "effect_intent", onboard_attempt_id: main.onboard_attempt_id, role: "root" });
      const again = await onboard({ action: "effect_intent", onboard_attempt_id: main.onboard_attempt_id, role: "root" });
      assert.deepEqual(again.effect, first.effect, "a replayed intent keeps the original intent");
      await assert.rejects(onboard({ action: "effect_intent", onboard_attempt_id: main.onboard_attempt_id, role: "track:unknown" }), /storage_onboard_input_invalid/);
      // Another session cannot drive this attempt.
      await assert.rejects(onboard({ action: "effect_intent", onboard_attempt_id: main.onboard_attempt_id, role: "root" }, other), /storage_onboard_denied/);
      main.ids = await effects(main);
      const replay = await onboard({ action: "effect_result", onboard_attempt_id: main.onboard_attempt_id, role: "root", provider_file_id: main.ids.root,
        version: "3", parents: ["my-drive-root"], created: true });
      assert.equal(replay.status, "recorded");
      await assert.rejects(onboard({ action: "effect_result", onboard_attempt_id: main.onboard_attempt_id, role: "root", provider_file_id: "another-root",
        version: "3", parents: ["my-drive-root"], created: true }), /storage_onboard_effect_ambiguous/);
      const stored = await row(main.onboard_attempt_id);
      assert.equal(Object.keys(stored.effects).length, 4);
    });

    await t.test("activation failing at its last step rolls back every step: zero canonical rows; the failure records orphans", async () => {
      const before = await canonical();
      await admin.query(`create function public.onboard_fixture_fail() returns trigger language plpgsql as $$
        begin raise exception 'onboard_fixture_injected'; end $$`);
      await admin.query("create trigger onboard_fixture_fail before insert on clued_private.storage_refresh_delegations_v1 for each row execute function public.onboard_fixture_fail()");
      try {
        await assert.rejects(activate(main), /onboard_fixture_injected/);
      } finally {
        await admin.query("drop trigger onboard_fixture_fail on clued_private.storage_refresh_delegations_v1; drop function public.onboard_fixture_fail()");
      }
      assert.deepEqual(await canonical(), before, "Project, Decision, profile, artifacts, connection, policy, read access, receipts and events all rolled back");
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_connections_v1 where id=$1", [main.connection_id])).rows[0].n, 0);
      assert.equal((await row(main.onboard_attempt_id)).state, "credential_staged");
      // Overlap is re-checked under the root lock from the reported ancestors.
      await assert.rejects(activate(main, ["my-drive-root", ownerRoot]), /storage_onboard_root_overlaps_existing/);
      await assert.rejects(activate(main, ["other-parent"]), /storage_onboard_effect_incomplete/, "the first ancestor is the recorded parent");
      const failed = await onboard({ action: "fail", onboard_attempt_id: main.onboard_attempt_id, code: "activation_failed" });
      assert.equal(failed.state, "failed"); assert.equal(failed.failure_code, "activation_failed");
      assert.deepEqual(failed.orphans.map(o => o.role).sort(), ["root", "track:归档", "track:资料", "track:项目"].sort());
      assert.ok(failed.orphans.every(o => typeof o.provider_file_id === "string" && o.recorded_at));
      assert.deepEqual(await canonical(), before);
      assert.equal((await onboard({ action: "list" })).attempts.some(a => a.onboard_attempt_id === main.onboard_attempt_id && a.orphans.length === 4), true);
      await assert.rejects(activate(main), /storage_onboard_denied/, "a failed attempt must be resumed first");
    });

    await t.test("resume reuses the staged credential and effects; activation creates the whole object graph once", async () => {
      const resumed = await onboard({ action: "resume", onboard_attempt_id: main.onboard_attempt_id });
      assert.equal(resumed.state, "credential_staged"); assert.deepEqual(resumed.credential_envelope, main.credential);
      assert.equal(resumed.effects.root.provider_file_id, main.ids.root); assert.deepEqual(resumed.orphans, []);
      const before = await canonical();
      const done = await activate(main);
      assert.equal(done.status, "completed"); assert.equal(done.connection_id, main.connection_id);
      assert.equal(done.provider_scope_profile, "normal"); assert.equal(done.normal_use_enabled, true);
      assert.equal(done.content_profile, "normal/1"); assert.equal(done.refresh_enabled, true); assert.equal(done.refresh_eligible, true);
      const after = await canonical();
      assert.equal(after.projects, before.projects + 1); assert.equal(after.memories, before.memories + 1);
      assert.equal(after.profiles, before.profiles + 1); assert.equal(after.artifacts, before.artifacts + 4);
      assert.equal(after.connections, before.connections + 1); assert.equal(after.policies, before.policies + 1);
      assert.equal(after.read_access, before.read_access + 1); assert.equal(after.delegations, before.delegations + 1);
      // Project and Decision through the current entries, user_explicit + user_confirmed.
      const decisionRow = (await admin.query("select record_type,authority,canonical_scope,lifecycle_status,content,type_fields from public.clued_memories where id=$1", [done.decision_id])).rows[0];
      assert.equal(decisionRow.record_type, "decision"); assert.equal(decisionRow.authority, "user_explicit");
      assert.equal(decisionRow.canonical_scope, "project:" + done.project_id); assert.equal(decisionRow.lifecycle_status, "active");
      assert.ok(decisionRow.content.startsWith(main.disclosure_text)); assert.match(decisionRow.content, new RegExp(main.ids.root));
      assert.equal(decisionRow.type_fields.onboard_attempt_id, main.onboard_attempt_id);
      assert.equal(decisionRow.type_fields.disclosure_version, ONBOARD_DISCLOSURE); assert.equal(decisionRow.type_fields.disclosure_sha256, main.disclosure_sha256);
      assert.deepEqual(decisionRow.type_fields.tracks, main.tracks);
      assert.equal((await admin.query("select clued_private.resource_center_decision_current_v1($1,$2,$3) v", [user, done.project_id, done.decision_id])).rows[0].v, true);
      assert.equal((await admin.query("select name from public.clued_projects where id=$1", [done.project_id])).rows[0].name, "Clued 资料中心：" + main.name);
      const profile = (await admin.query("select * from clued_private.resource_center_profiles_v1 where id=$1", [done.profile_id])).rows[0];
      assert.equal(profile.managed_root, "/clued-cloud/google-drive/" + main.ids.root); assert.equal(profile.profile_version, "clued.storage-onboard/1");
      assert.equal(profile.root_folder_id, main.ids.root); assert.equal(profile.root_parent_id, "my-drive-root");
      assert.equal(profile.project_id, done.project_id); assert.equal(profile.source_decision_id, done.decision_id); assert.equal(profile.display_name, main.name);
      assert.equal(profile.cloud_runtime.contract, "clued.storage-cloud-runtime/1"); assert.deepEqual(profile.cloud_runtime.allowed_root_children, main.tracks);
      assert.equal(String(profile.cloud_runtime.profile_version), String(profile.version)); assert.equal(profile.cloud_runtime.source_decision_id, done.decision_id);
      const artifacts = (await admin.query("select path,provider_file_id,provider_file_version,governance_class,target_kind,delete_authority from clued_private.resource_center_artifacts_v1 where profile_id=$1 order by path", [done.profile_id])).rows;
      assert.deepEqual(artifacts[0], { path: profile.managed_root, provider_file_id: main.ids.root, provider_file_version: "3", governance_class: "governance", target_kind: "directory", delete_authority: false });
      assert.ok(artifacts.slice(1).every(a => a.governance_class === "ordinary" && a.target_kind === "directory" && !a.delete_authority));
      const connection = (await admin.query("select * from clued_private.storage_connections_v1 where id=$1", [done.connection_id])).rows[0];
      assert.equal(connection.state, "active"); assert.equal(connection.provider_subject, "onboard-subject"); assert.equal(connection.oauth_client_id, oauthClient);
      assert.equal(connection.credential_version, "1"); assert.deepEqual(connection.credential_envelope, main.credential);
      assert.equal(connection.provider_scope_profile, "normal"); assert.equal(connection.auth_mode, "account_policy"); assert.equal(connection.auth_generation, "1");
      assert.equal(connection.account_policy_id, done.policy_id); assert.equal(connection.source_decision_id, done.decision_id);
      const policy = (await admin.query("select * from clued_private.storage_account_policies_v2 where id=$1", [done.policy_id])).rows[0];
      assert.equal(policy.consent_source, "native_connection"); assert.equal(policy.state, "active"); assert.equal(policy.policy_generation, "1");
      assert.deepEqual(policy.actions, ["inspect", "create_file", "create_topic"]); assert.equal(policy.disclosure_version, ONBOARD_DISCLOSURE);
      assert.match(policy.scope_digest, /^[0-9a-f]{64}$/, "scope_digest is non-empty");
      assert.equal(policy.scope_digest, (await admin.query("select clued_private.storage_policy_scope_digest_v2($1) d", [done.connection_id])).rows[0].d);
      assert.notEqual(policy.consent_receipt_id, policy.activation_receipt_id);
      const read = (await admin.query("select classes,content_profile,disclosure_version,read_generation,account_policy_id from clued_private.storage_read_access_v1 where connection_id=$1 and state='active'", [done.connection_id])).rows[0];
      assert.deepEqual(read, { classes: ["read", "read_content"], content_profile: "normal/1", disclosure_version: NORMAL_DISCLOSURE, read_generation: "1", account_policy_id: done.policy_id });
      const delegation = (await admin.query("select enabled,version,failures,issuer_hash,receipt_id from clued_private.storage_refresh_delegations_v1 where connection_id=$1", [done.connection_id])).rows[0];
      assert.deepEqual(delegation, { enabled: true, version: "1", failures: 0, issuer_hash: issuer, receipt_id: done.refresh_receipt_id });
      assert.equal((await admin.query("select operation from public.clued_audit_receipts where id=$1", [done.refresh_receipt_id])).rows[0].operation, "storage_default_refresh");
      const refreshEvent = (await admin.query("select canonical_event_type,change_summary from public.clued_context_events where receipt_id=$1", [done.refresh_receipt_id])).rows[0];
      assert.equal(refreshEvent.canonical_event_type, "extension:storage:default_refresh_enable");
      assert.deepEqual(Object.keys(refreshEvent.change_summary).sort(), ["connection_id", "oauth_attempt_id", "oauth_receipt_id", "until_revoked"], "145426 event shape");
      // Every step has its own committed receipt and one event.
      const operations = (await admin.query(`select r.operation,count(e.*)::int events from public.clued_audit_receipts r left join public.clued_context_events e on e.receipt_id=r.id
        where r.user_id=$1 and r.idempotency_key like '%'||$2 and r.status='committed' group by r.operation order by r.operation`, [user, main.onboard_attempt_id])).rows;
      assert.deepEqual(operations.map(o => o.operation), ["project_mutation_v2", "record_mutation", "storage_normal_use_v1", "storage_onboard_cloud_runtime",
        "storage_onboard_connection", "storage_onboard_consent", "storage_onboard_policy", "storage_onboard_profile", "storage_onboard_tracks"]);
      assert.ok(operations.every(o => o.events === 1));
      const stored = await row(main.onboard_attempt_id);
      assert.equal(stored.state, "completed"); assert.equal(stored.credential_envelope, null, "the staged envelope is deleted");
      assert.deepEqual((await admin.query("select status,receipt_id from clued_private.storage_oauth_attempts_v1 where id=$1", [main.oauth_attempt_id])).rows[0],
        { status: "completed", receipt_id: done.receipt_id });
      const issued = (await admin.query("select connection_id,provider_subject,completed_at is not null done from clued_private.storage_refresh_token_issuance_v1 where oauth_attempt_id=$1", [main.oauth_attempt_id])).rows[0];
      assert.deepEqual(issued, { connection_id: done.connection_id, provider_subject: "onboard-subject", done: true });
      // Replays: the callback claim and activate return the committed result only.
      const replay = await callback({ action: "claim", state_hash: main.state_hash });
      assert.equal(replay.status, "completed"); assert.equal(replay.receipt_id, done.receipt_id); assert.equal(replay.connection_id, done.connection_id);
      await assert.rejects(activate(main), /storage_onboard_denied/);
      main.done = done;
    });

    await t.test("the activated connection is usable: page list name, write admission, read admission and refresh claim", async () => {
      const listed = (await native.query("select public.clued_storage_owner_manage_v2('{\"action\":\"connections\"}'::jsonb) value")).rows[0].value.connections
        .find(c => c.id === main.done.connection_id);
      assert.equal(listed.root_name, main.name); assert.equal(listed.policy_active, true); assert.equal(listed.refresh_enabled, true);
      const client = await bind();
      const evaluated = (await admin.query("select clued_private.storage_policy_evaluate_v2($1,$2,'create_file',$3) v", [client.token, main.done.connection_id, randomUUID()])).rows[0].v;
      assert.equal(evaluated.policy_id, main.done.policy_id); assert.equal(evaluated.scope_digest, (await admin.query("select scope_digest from clued_private.storage_account_policies_v2 where id=$1", [main.done.policy_id])).rows[0].scope_digest);
      const admitted = (await caller.query("select public.clued_storage_read_v1($1,$2,$3::jsonb) value", [issuer, client.token,
        JSON.stringify({ action: "admit", connection_id: main.done.connection_id, operation: "list", object_id: main.ids.root })])).rows[0].value;
      assert.equal(admitted.content_profile, "normal/1"); assert.equal(admitted.provider_scope_profile, "normal");
      // The default delegation lets the refresh worker renew the token (the
      // read agent refuses tokens within 60 s of expiry, so without it the
      // connection would stop after about an hour).
      const worker = async input => (await caller.query("select public.clued_storage_refresh_worker_v1($1,$2::jsonb) value", [issuer, JSON.stringify(input)])).rows[0].value;
      const due = await worker({ action: "due" });
      assert.ok(due.connections.includes(main.done.connection_id));
      const claim = await worker({ action: "claim", connection_id: main.done.connection_id, attempt_id: randomUUID() });
      assert.equal(claim.status, "acquired"); assert.deepEqual(claim.credential_envelope, main.credential);
    });

    await t.test("legacy granted although normal use was requested -> text/1 {read}; no refresh delegation when unticked", async () => {
      const attempt = await begin({ refresh: false });
      await claimAndStage(attempt, "legacy");
      await effects(attempt);
      const done = await activate(attempt);
      assert.equal(done.status, "completed"); assert.equal(done.provider_scope_profile, "legacy"); assert.equal(done.requested_scope_profile, "normal");
      assert.equal(done.normal_use_enabled, false); assert.equal(done.content_profile, "text/1"); assert.equal(done.refresh_enabled, false);
      const read = (await admin.query("select classes,content_profile,disclosure_version from clued_private.storage_read_access_v1 where connection_id=$1 and state='active'", [done.connection_id])).rows[0];
      assert.deepEqual(read, { classes: ["read"], content_profile: "text/1", disclosure_version: READ_DISCLOSURE });
      assert.equal((await admin.query("select count(*)::int n from clued_private.storage_refresh_delegations_v1 where connection_id=$1", [done.connection_id])).rows[0].n, 0);
      assert.equal((await admin.query("select provider_scope_profile from clued_private.storage_connections_v1 where id=$1", [done.connection_id])).rows[0].provider_scope_profile, "legacy");
    });

    await t.test("normal use unticked -> legacy request; a normal grant for a legacy request is refused", async () => {
      const attempt = await begin({ normal: false });
      assert.equal(attempt.begun.requested_scope_profile, "legacy");
      await callback({ action: "claim", state_hash: attempt.state_hash });
      await assert.rejects(onboard({ action: "stage_credential", state_hash: attempt.state_hash, provider_subject: "onboard-subject",
        credential_envelope: envelope("X"), provider_scope_profile: "normal" }), /storage_oauth_denied/);
    });

    await t.test("picked root: an observed (not created) root; overlap with an active root and a reused root are refused", async () => {
      const picked = `picked-${randomUUID()}`;
      const attempt = await begin({ mode: "picked", folder_id: picked });
      await claimAndStage(attempt);
      await assert.rejects(onboard({ action: "effect_intent", onboard_attempt_id: attempt.onboard_attempt_id, role: "root" }), /storage_onboard_input_invalid/);
      await assert.rejects(onboard({ action: "effect_result", onboard_attempt_id: attempt.onboard_attempt_id, role: "root", provider_file_id: "not-the-picked",
        version: "9", parents: ["somewhere"], created: false }), /storage_onboard_input_invalid/);
      await effects(attempt, { rootId: picked, parent: "folder-parent", picked: true });
      await assert.rejects(activate(attempt, ["folder-parent", main.ids.root]), /storage_onboard_root_overlaps_existing/,
        "a picked root inside an active root");
      const done = await activate(attempt, ["folder-parent", "my-drive-root"]);
      assert.equal(done.status, "completed");
      const orphanless = await row(attempt.onboard_attempt_id);
      assert.deepEqual(orphanless.orphans, []);
      assert.equal((await admin.query("select root_parent_id from clued_private.resource_center_profiles_v1 where id=$1", [done.profile_id])).rows[0].root_parent_id, "folder-parent");
      // The same folder cannot be onboarded twice.
      await assert.rejects(begin({ mode: "picked", folder_id: picked }), /storage_onboard_root_overlaps_existing/);
    });

    await t.test("expiry drops the staged credential and keeps orphans; a failure keeps a 30-minute retry", async () => {
      const attempt = await begin();
      await claimAndStage(attempt);
      await onboard({ action: "effect_intent", onboard_attempt_id: attempt.onboard_attempt_id, role: "root" });
      await onboard({ action: "effect_result", onboard_attempt_id: attempt.onboard_attempt_id, role: "root", provider_file_id: driveId(attempt.onboard_attempt_id),
        version: "1", parents: ["my-drive-root"], created: true });
      await admin.query("update clued_private.storage_onboard_attempts_v1 set expires_at=clock_timestamp()-interval '1 second' where id=$1", [attempt.onboard_attempt_id]);
      // The in-call expiry of a call that then raises is rolled back with it:
      // the abandoned attempt still holds its sealed refresh token.
      await assert.rejects(onboard({ action: "resume", onboard_attempt_id: attempt.onboard_attempt_id }), /storage_onboard_denied|storage_onboard_run_active|storage_onboard_expired/);
      await assert.rejects(onboard({ action: "effect_intent", onboard_attempt_id: attempt.onboard_attempt_id, role: "track:资料" }), /storage_onboard_expired/);
      assert.notEqual((await row(attempt.onboard_attempt_id)).credential_envelope, null);
      // The cron sweep (its own transaction, issuer hash only) expires it.
      await assert.rejects(sweep(sha(randomUUID())), /storage_onboard_denied/);
      await assert.rejects(sweep("not-a-hash"), /storage_onboard_denied/);
      await assert.rejects(sweep(issuer, native), /permission denied/, "the sweep is the Worker's (anon + issuer hash), not a native RPC");
      const swept = await sweep();
      assert.equal(swept.status, "ok"); assert.ok(swept.expired >= 1);
      const stored = await row(attempt.onboard_attempt_id);
      assert.equal(stored.state, "expired"); assert.equal(stored.credential_envelope, null); assert.equal(stored.run_token, null);
      assert.deepEqual(stored.orphans.map(o => o.role), ["root"]);
      assert.equal(stored.orphans[0].provider_file_id, driveId(attempt.onboard_attempt_id));
      const expired = await onboard({ action: "status", onboard_attempt_id: attempt.onboard_attempt_id });
      assert.equal(expired.state, "expired"); assert.equal(expired.retryable, false);
      assert.equal((await sweep()).expired, 0, "nothing left to expire");
      // An expired failed attempt (retryable failure) also loses its envelope; a row
      // locked by a running call is skipped, not waited for.
      const failed = await begin();
      await claimAndStage(failed);
      await onboard({ action: "fail", onboard_attempt_id: failed.onboard_attempt_id, code: "activation_unconfirmed", retryable: true });
      assert.notEqual((await row(failed.onboard_attempt_id)).credential_envelope, null);
      await admin.query("update clued_private.storage_onboard_attempts_v1 set expires_at=clock_timestamp()-interval '1 second' where id=$1", [failed.onboard_attempt_id]);
      const holder = await connect();
      await holder.query("begin");
      try {
        await holder.query("select 1 from clued_private.storage_onboard_attempts_v1 where id=$1 for update", [failed.onboard_attempt_id]);
        assert.equal((await sweep()).expired, 0, "SKIP LOCKED");
      } finally { await holder.query("rollback"); }
      assert.equal((await sweep()).expired, 1);
      assert.equal((await row(failed.onboard_attempt_id)).credential_envelope, null);
    });

    await t.test("a failure no resume can fix drops the staged credential at once; a retryable one keeps it for resume", async () => {
      const attempt = await begin();
      await claimAndStage(attempt);
      await onboard({ action: "effect_intent", onboard_attempt_id: attempt.onboard_attempt_id, role: "root" });
      await assert.rejects(onboard({ action: "fail", onboard_attempt_id: attempt.onboard_attempt_id, code: "root_not_owned", retryable: "no" }),
        /storage_onboard_input_invalid/);
      const failed = await onboard({ action: "fail", onboard_attempt_id: attempt.onboard_attempt_id, code: "root_not_owned", retryable: false });
      assert.equal(failed.state, "failed"); assert.equal(failed.retryable, false); assert.deepEqual(failed.orphans.map(o => o.role), ["root"]);
      const stored = await row(attempt.onboard_attempt_id);
      assert.equal(stored.credential_envelope, null); assert.equal(stored.run_token, null);
      await assert.rejects(onboard({ action: "resume", onboard_attempt_id: attempt.onboard_attempt_id }), /storage_onboard_denied/);
      // A second fail is a no-op (the first code stays).
      assert.equal((await onboard({ action: "fail", onboard_attempt_id: attempt.onboard_attempt_id, code: "other" })).failure_code, "root_not_owned");
    });

    await t.test("one run at a time: the run token and its lease serialise the callback, resume and a stopped Worker", async () => {
      const attempt = await begin(), id = attempt.onboard_attempt_id;
      const { staged } = await claimAndStage(attempt);
      const first = staged.run_token;
      assert.equal(staged.retryable, false, "the callback run holds the lease");
      // The callback run holds the lease: a resume (another tab, a retry) is refused.
      await assert.rejects(onboard({ action: "resume", onboard_attempt_id: id }), /storage_onboard_run_active/);
      await assert.rejects(onboard({ action: "effect_intent", onboard_attempt_id: id, role: "root", run_token: undefined }), /storage_onboard_run_superseded/);
      await assert.rejects(onboard({ action: "effect_intent", onboard_attempt_id: id, role: "root", run_token: randomUUID() }), /storage_onboard_run_superseded/);
      const before = (await row(id)).run_lease_until;
      await onboard({ action: "effect_intent", onboard_attempt_id: id, role: "root", run_token: first });
      assert.ok((await row(id)).run_lease_until >= before, "every effect call refreshes the lease");
      // The Worker stops between intent and result; its lease lapses.
      await admin.query("update clued_private.storage_onboard_attempts_v1 set run_lease_until=clock_timestamp()-interval '1 second' where id=$1", [id]);
      assert.equal((await onboard({ action: "status", onboard_attempt_id: id })).retryable, true);
      const resumed = await onboard({ action: "resume", onboard_attempt_id: id });
      const second = resumed.run_token;
      assert.match(second, /^[0-9a-f-]{36}$/); assert.notEqual(second, first);
      await assert.rejects(onboard({ action: "resume", onboard_attempt_id: id }), /storage_onboard_run_active/, "the resumed run holds it now");
      // The old run is superseded: no effect, no activation, and its fail never fails the new run.
      await assert.rejects(onboard({ action: "effect_result", onboard_attempt_id: id, role: "root", run_token: first, provider_file_id: "old-run-root",
        version: "1", parents: ["my-drive-root"], created: true }), /storage_onboard_run_superseded/);
      await assert.rejects(onboard({ action: "activate", onboard_attempt_id: id, ancestors: ["my-drive-root"], run_token: first }), /storage_onboard_run_superseded/);
      await assert.rejects(onboard({ action: "fail", onboard_attempt_id: id, code: "activation_unconfirmed", run_token: first }), /storage_onboard_run_superseded/);
      await assert.rejects(onboard({ action: "fail", onboard_attempt_id: id, code: "activation_unconfirmed", run_token: undefined }), /storage_onboard_run_superseded/);
      assert.equal((await row(id)).state, "credential_staged");
      // The folder the old run created is reported as a stray (no token needed) and kept.
      await assert.rejects(onboard({ action: "effect_stray", onboard_attempt_id: id, role: "track:unknown", provider_file_id: "x" }), /storage_onboard_input_invalid/);
      await assert.rejects(onboard({ action: "effect_stray", onboard_attempt_id: id, role: "root", provider_file_id: "bad id!" }), /storage_onboard_input_invalid/);
      await assert.rejects(onboard({ action: "effect_stray", onboard_attempt_id: id, role: "root", provider_file_id: "old-run-root" }, other), /storage_onboard_denied/);
      await onboard({ action: "effect_stray", onboard_attempt_id: id, role: "root", provider_file_id: "old-run-root" });
      await onboard({ action: "effect_stray", onboard_attempt_id: id, role: "root", provider_file_id: "old-run-root" });
      // A stray later found by its marker and recorded is that effect, not an orphan.
      await onboard({ action: "effect_stray", onboard_attempt_id: id, role: "track:资料", provider_file_id: "found-later" });
      assert.deepEqual((await row(id)).strays.map(x => x.provider_file_id), ["old-run-root", "found-later"]);
      const rootId = driveId(id + ":new-root");
      await onboard({ action: "effect_result", onboard_attempt_id: id, role: "root", run_token: second, provider_file_id: rootId,
        version: "1", parents: ["my-drive-root"], created: true });
      for (const track of attempt.tracks) {
        const role = "track:" + track;
        await onboard({ action: "effect_intent", onboard_attempt_id: id, role, run_token: second });
        await onboard({ action: "effect_result", onboard_attempt_id: id, role, run_token: second,
          provider_file_id: track === "资料" ? "found-later" : driveId(id + ":" + role), version: "1", parents: [rootId], created: true });
      }
      assert.deepEqual((await row(id)).strays.map(x => x.provider_file_id), ["old-run-root"]);
      // An already recorded effect is never a stray.
      await onboard({ action: "effect_stray", onboard_attempt_id: id, role: "root", provider_file_id: rootId });
      const done = await onboard({ action: "activate", onboard_attempt_id: id, ancestors: ["my-drive-root"], run_token: second });
      assert.equal(done.status, "completed");
      const completed = await row(id);
      assert.equal(completed.run_token, null); assert.equal(completed.run_lease_until, null);
      assert.deepEqual(completed.orphans.map(o => [o.role, o.provider_file_id]), [["root", "old-run-root"]], "a completed attempt lists its stray");
      // A stray reported after completion is still kept, and listed.
      await onboard({ action: "effect_stray", onboard_attempt_id: id, role: "track:项目", provider_file_id: "late-stray" });
      assert.deepEqual((await row(id)).orphans.map(o => o.provider_file_id), ["old-run-root", "late-stray"]);
      assert.ok((await onboard({ action: "list" })).attempts.some(a => a.onboard_attempt_id === id && a.orphans.length === 2));
      // A failed run's orphans are its unactivated effects plus its strays.
      const lost = await begin(), lostId = lost.onboard_attempt_id;
      await claimAndStage(lost);
      await onboard({ action: "effect_intent", onboard_attempt_id: lostId, role: "root" });
      await onboard({ action: "effect_stray", onboard_attempt_id: lostId, role: "root", provider_file_id: "ambiguous-root" });
      const failed = await onboard({ action: "fail", onboard_attempt_id: lostId, code: "onboard_effect_ambiguous" });
      assert.deepEqual(failed.orphans.map(o => [o.role, o.provider_file_id]), [["root", "ambiguous-root"]],
        "an intent without a result whose folder is a stray is listed once");
      assert.equal(failed.retryable, true);
    });

    await t.test("the token limit is re-checked at claim under the per-owner lock", async () => {
      const counted = (await admin.query("select clued_private.storage_refresh_token_count_v1($1,null,$2) n", [user, oauthClient])).rows[0].n;
      const filler = async n => admin.query(`with a as (insert into clued_private.storage_oauth_attempts_v1(id,connection_id,owner_id,session_id,issuer_hash,connection_version,
        state_hash,verifier_envelope,expires_at,status) select gen_random_uuid(),$1,$2,$3,$4,1,encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),
        '{}'::jsonb,clock_timestamp(),'completed' from generate_series(1,$5::int) returning id)
        insert into clued_private.storage_refresh_token_issuance_v1(oauth_attempt_id,owner_id,oauth_client_id,provider_subject,connection_id,purpose)
        select id,$2,$6,'onboard-subject',$1,'connection' from a`, [ownerConnection, user, session, issuer, n, oauthClient]);
      try {
        await filler(89 - counted);
        // Both begin at 89 (each sees room for one more).
        const one = await begin(), two = await begin();
        assert.equal(one.begun.refresh_token_count, 89); assert.equal(two.begun.refresh_token_count, 89);
        assert.equal((await callback({ action: "claim", state_hash: one.state_hash })).status, "claimed");
        await assert.rejects(callback({ action: "claim", state_hash: two.state_hash }), /storage_refresh_token_limit/);
        assert.equal((await admin.query("select status from clued_private.storage_oauth_attempts_v1 where id=$1", [two.oauth_attempt_id])).rows[0].status, "prepared",
          "the refused claim is not counted");
        // Concurrent claims serialise on the per-owner lock: the second sees the first's count.
        await admin.query("update clued_private.storage_refresh_token_issuance_v1 set cleared_at=clock_timestamp() where oauth_attempt_id=$1", [one.oauth_attempt_id]);
        const three = await begin();
        const first = await connect("authenticated", session), second = await connect("authenticated", session);
        await first.query("begin");
        try {
          assert.equal((await callback({ action: "claim", state_hash: two.state_hash }, first)).status, "claimed");
          const racing = callback({ action: "claim", state_hash: three.state_hash }, second).then(() => "claimed", error => error.message);
          const waited = await Promise.race([racing, new Promise(resolve => setTimeout(() => resolve("waiting"), 300))]);
          assert.equal(waited, "waiting", "the second claim waits for the per-owner lock");
          await first.query("commit");
          assert.match(await racing, /storage_refresh_token_limit/);
        } catch (error) { await first.query("rollback").catch(() => {}); throw error; }
      } finally {
        await admin.query("update clued_private.storage_refresh_token_issuance_v1 set cleared_at=clock_timestamp() where owner_id=$1 and oauth_client_id=$2 and cleared_at is null", [user, oauthClient]);
      }
    });

    await t.test("nested roots: a parent and its child activating concurrently are serialised; the second sees the overlap", async () => {
      const parent = await begin(), child = await begin();
      await claimAndStage(parent); await claimAndStage(child);
      const parentIds = await effects(parent);
      await effects(child, { parent: parentIds.root });
      const first = await connect("authenticated", session), second = await connect("authenticated", session);
      await first.query("begin");
      try {
        assert.equal((await activate(parent, ["my-drive-root"], first)).status, "completed");
        const racing = activate(child, [parentIds.root, "my-drive-root"], second).then(value => value.status, error => error.message);
        const waited = await Promise.race([racing, new Promise(resolve => setTimeout(() => resolve("waiting"), 300))]);
        assert.equal(waited, "waiting", "the child's activation waits for the per-owner onboard lock");
        await first.query("commit");
        assert.match(await racing, /storage_onboard_root_overlaps_existing/);
      } catch (error) { await first.query("rollback").catch(() => {}); throw error; }
      assert.equal((await row(child.onboard_attempt_id)).state, "credential_staged");
    });

    await t.test("activation re-checks the allowlist / verified-opening gate", async () => {
      const attempt = await begin();
      await claimAndStage(attempt);
      await effects(attempt);
      const before = await canonical();
      await admin.query("delete from clued_private.storage_onboard_allowlist_v1 where owner_id=$1", [user]);
      try {
        await assert.rejects(activate(attempt), /storage_onboard_not_allowed/);
        assert.deepEqual(await canonical(), before);
        await admin.query("update clued_private.storage_oauth_apps_v1 set onboard_open=true where issuer_hash=$1", [issuer]);
        try { assert.equal((await activate(attempt)).status, "completed", "the verified opening admits"); }
        finally { await admin.query("update clued_private.storage_oauth_apps_v1 set onboard_open=false where issuer_hash=$1", [issuer]); }
      } finally {
        await admin.query("insert into clued_private.storage_onboard_allowlist_v1(owner_id,note) values($1,'test user') on conflict do nothing", [user]);
      }
    });

    await t.test("gate v2: onboarding needs read_enabled only; the executor switch execution_enabled does not gate it", async () => {
      await admin.query("update clued_private.storage_oauth_apps_v1 set execution_enabled=false where issuer_hash=$1", [issuer]);
      try {
        const attempt = await begin();
        assert.equal(attempt.begun.status, "begun", "begin with the executor switch off");
        await claimAndStage(attempt);
        await effects(attempt);
        assert.equal((await activate(attempt)).status, "completed", "activation with the executor switch off");
        await admin.query("update clued_private.storage_oauth_apps_v1 set read_enabled=false where issuer_hash=$1", [issuer]);
        try { await assert.rejects(begin(), /storage_onboard_unavailable/, "read_enabled off refuses begin"); }
        finally { await admin.query("update clued_private.storage_oauth_apps_v1 set read_enabled=true where issuer_hash=$1", [issuer]); }
      } finally {
        await admin.query("update clued_private.storage_oauth_apps_v1 set execution_enabled=true where issuer_hash=$1", [issuer]);
      }
    });

    await t.test("the token-count limit refuses a new onboarding at 90 (unknown Google account counts every claim)", async () => {
      const counted = (await admin.query("select clued_private.storage_refresh_token_count_v1($1,null,$2) n", [user, oauthClient])).rows[0].n;
      await admin.query(`with a as (insert into clued_private.storage_oauth_attempts_v1(id,connection_id,owner_id,session_id,issuer_hash,connection_version,
        state_hash,verifier_envelope,expires_at,status) select gen_random_uuid(),$1,$2,$3,$4,1,encode(extensions.digest(gen_random_uuid()::text,'sha256'),'hex'),
        '{}'::jsonb,clock_timestamp(),'completed' from generate_series(1,$5::int) returning id)
        insert into clued_private.storage_refresh_token_issuance_v1(oauth_attempt_id,owner_id,oauth_client_id,provider_subject,connection_id,purpose)
        select id,$2,$6,'onboard-subject',$1,'connection' from a`, [ownerConnection, user, session, issuer, 90 - counted, oauthClient]);
      await assert.rejects(begin(), /storage_refresh_token_limit/);
      await admin.query("update clued_private.storage_refresh_token_issuance_v1 set cleared_at=clock_timestamp() where owner_id=$1 and oauth_client_id=$2", [user, oauthClient]);
    });

    await t.test("the Owner's existing connections are unchanged: policy, read access, delegation, auth_generation, credential", async () => {
      const now = (await existing()).filter(c => ownerBefore.some(b => b.id === c.id));
      assert.deepEqual(now, ownerBefore);
    });

    await t.test("an unverified-open app still refuses a removed owner; the verified opening admits without the allowlist", async () => {
      await admin.query("delete from clued_private.storage_onboard_allowlist_v1 where owner_id=$1", [user]);
      await assert.rejects(begin(), /storage_onboard_not_allowed/);
      await admin.query("update clued_private.storage_oauth_apps_v1 set onboard_open=true where issuer_hash=$1", [issuer]);
      try { assert.equal((await begin()).begun.status, "begun"); }
      finally { await admin.query("update clued_private.storage_oauth_apps_v1 set onboard_open=false where issuer_hash=$1", [issuer]); }
    });
  } finally {
    for (const database of clients) await database.end();
  }
}
