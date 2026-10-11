import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
const hash = s => createHash("sha256").update(s).digest("hex");

export async function testRenewalDatabase(t, admin, server, user, decision) {
  const call = async (fn, args, db = admin) => (await db.query(`select public.${fn}($1,$2::jsonb) value`, [args[0], JSON.stringify(args[1])])).rows[0].value;
  const adminCall = input => call("clued_resource_center_admin_v1", [user, { idempotency_key: randomUUID(), source_decision_id: decision, ...input }]);
  const project = (await admin.query("select project_id from public.clued_memories where id=$1", [decision])).rows[0].project_id;
  const registered = await adminCall({ action: "profile_register", project_id: project, profile_version: "renewal/1", managed_root: "/test/Clued_资料中心", root_folder_id: "renew-root", root_parent_id: "renew-parent", root_folder_version: "1" });
  const profile = registered.target_refs.find(r => r.role === "primary").id;
  const oldReader = hash("renew-reader"), oldWriter = hash("renew-writer"), token = hash("renew-token");
  const read = await adminCall({ action: "binding_issue", profile_id: profile, token_hash: oldReader, expires_at: new Date(Date.now() + 3600000).toISOString() });
  const reader = read.target_refs.find(r => r.role === "primary").id;
  const write = await call("clued_resource_center_writer_admin_v1", [user, { action: "issue", authority_binding_id: reader, token_hash: oldWriter, source_decision_id: decision, expires_at: new Date(Date.now() + 3500000).toISOString(), idempotency_key: randomUUID() }]);
  const writer = write.target_refs.find(r => r.role === "primary").id;
  const renew = (h, input, db = admin) => call("clued_resource_center_renew_v1", [h, input], db);
  const enroll = await call("clued_resource_center_renewal_admin_v1", [user, { action: "enroll", profile_id: profile, reader_id: reader, writer_id: writer, token_hash: token, source_decision_id: decision, idempotency_key: randomUUID() }]);
  assert.equal(enroll.status, "committed");
  const req = { action: "rotate", request_id: randomUUID(), generation: 0, reader_hash: hash("next-reader"), writer_hash: hash("next-writer"), renewal_hash: hash("next-renewal") };
  const status = () => ({ action: "status", request_id: randomUUID() });
  await t.test("renewal opt-in forbids public bootstrap, role confusion and supplied profile", async () => {
    const anon = server.getPgClient();await anon.connect();await anon.query("set role anon");
    try {
      await assert.rejects(call("clued_resource_center_renewal_admin_v1", [user, {}], anon), /permission denied/);
      for (const tok of [oldReader, oldWriter, hash("unknown")]) assert.equal((await renew(tok, req, anon)).status, "denied");
      assert.equal((await renew(token, { ...req, profile_id: profile }, anon)).status, "denied");
      assert.equal((await renew(token, status(), anon)).status, "active");
    } finally { await anon.end(); }
  });
  await t.test("rotation is blocked by durable unresolved intent and preserves original bindings", async () => {
    // Exact temporary fixture; no provider effect. It exercises the shared root fence.
    await admin.query("insert into clued_private.resource_center_mutations_v1(user_id,profile_id,writer_binding_id,request_key,request_sha256,exact_request,authority_request,authority_result,authority_token_hash,profile_version,source_decision_id,state,expires_at,receipt_id) values($1,$2,$3,'renew-fence',$4,'{}','{}','{}',$5,1,$6,'uncertain',now(),$7)", [user,profile,writer,"f".repeat(64),oldReader,decision,enroll.receipt_id]);
    assert.equal((await renew(token, req)).status, "fenced");
    assert.equal((await admin.query("select token_hash=clued_private.credential_verifier_v1($2) same from clued_private.resource_center_writer_bindings_v1 where id=$1", [writer, oldWriter])).rows[0].same, true);
    await admin.query("update clued_private.resource_center_mutations_v1 set state='cancelled' where profile_id=$1", [profile]);
  });
  let result;
  await t.test("same-generation competing rotations produce one generation; exact replay is metadata only", async () => {
    const competitor = server.getPgClient();await competitor.connect();
    try {
      const changed = { ...req, request_id: randomUUID(), reader_hash: hash("competitor-reader"), writer_hash: hash("competitor-writer"), renewal_hash: hash("competitor-renew") };
      await admin.query("begin");result = await renew(token, req);
      const pending = renew(token, changed, competitor);await admin.query("commit");
      assert.equal(result.status, "rotated");assert.equal((await pending).status, "denied");
    } finally { await competitor.end(); }
    assert.deepEqual(await renew(token, req), result);
    assert.equal((await renew(token, { ...req, writer_hash: hash("altered") })).status, "denied");
    assert.equal((await renew(token, status())).status, "denied");
    assert.equal((await renew(req.renewal_hash, status())).generation, 1);
    assert.equal((await renew(req.renewal_hash, { ...req, generation: 1, request_id: randomUUID() })).status, "denied"); // too early
    assert.equal(JSON.stringify(result).includes("hash"), false);
    const audit = (await admin.query("select canonical_result from public.clued_audit_receipts where id=$1", [result.receipt_id])).rows[0].canonical_result;
    for (const secret of [oldReader, oldWriter, token, req.reader_hash, req.writer_hash, req.renewal_hash]) assert.equal(JSON.stringify(audit).includes(secret), false);
    const rows = (await admin.query("select b.id,b.source_decision_id,b.expires_at,w.id writer,w.expires_at writer_expiry from clued_private.resource_center_bindings_v1 b join clued_private.resource_center_writer_bindings_v1 w on w.authority_binding_id=b.id where b.id=$1 and w.id=$2", [reader,writer])).rows;
    assert.equal(rows[0].id, reader);assert.equal(rows[0].writer, writer);assert.equal(rows[0].source_decision_id, decision);
    assert.ok(Date.parse(rows[0].expires_at) - Date.now() <= 24 * 3600000);
    assert.equal((await admin.query("select count(*)::int n from clued_private.resource_center_rotations_v1 where grant_id=$1", [enroll.grant_id])).rows[0].n, 1);
    assert.equal((await call("clued_resource_center_write_v1", [oldWriter, { action: "inspect" }])).status, "denied");
  });
  await t.test("Decision version drift denies enrolled credentials without legacy fallback", async () => {
    await admin.query("begin");
    try {
      await admin.query("update public.clued_memories set version=version+1 where id=$1", [decision]);
      assert.equal((await renew(req.renewal_hash, status())).status, "denied");
      assert.equal((await admin.query("select clued_private.resource_center_renewal_current_v1($1) ok", [reader])).rows[0].ok, false);
    } finally { await admin.query("rollback"); }
  });
  await t.test("Decision close winning a real row-lock wait denies the waiting status", async () => {
    const competitor = server.getPgClient();await competitor.connect();
    const pid = (await competitor.query("select pg_backend_pid() pid")).rows[0].pid;
    const version = (await admin.query("select version from public.clued_memories where id=$1", [decision])).rows[0].version;
    try {
      await admin.query("begin");await admin.query("select id from public.clued_memories where id=$1 for update", [decision]);
      const pending = renew(req.renewal_hash, status(), competitor);let waiting = false;
      for (let i=0;i<100;i++) { waiting=(await admin.query("select exists(select 1 from pg_locks where pid=$1 and not granted) waiting",[pid])).rows[0].waiting;if(waiting)break;await new Promise(r=>setTimeout(r,10)); }
      assert.equal(waiting,true);
      await admin.query("update public.clued_memories set version=version+1 where id=$1", [decision]);await admin.query("commit");
      assert.equal((await pending).status,"denied");
    } finally {
      await admin.query("rollback");await competitor.end();
      // Isolated fixture reset only, never a production authority operation.
      await admin.query("update public.clued_memories set version=$2 where id=$1", [decision,version]);
    }
  });
  await t.test("expiry after waiting for profile lock denies renewal", async () => {
    const competitor = server.getPgClient();await competitor.connect();
    try {
      await admin.query("begin");await admin.query("select id from clued_private.resource_center_profiles_v1 where id=$1 for update", [profile]);
      const pending = renew(req.renewal_hash, status(), competitor);
      await admin.query("update clued_private.resource_center_renewals_v1 set expires_at=clock_timestamp()-interval '1 second' where id=$1", [enroll.grant_id]);
      await admin.query("commit");assert.equal((await pending).status, "denied");
    } finally { await competitor.end(); }
  });
  await t.test("stop is available after expiry and uncertain delivery; historical receipt cannot resurrect", async () => {
    const stopped = await renew(token, { action: "stop", request_id: randomUUID() });assert.equal(stopped.status, "stopped");
    assert.equal((await renew(token, req)).status, "denied");assert.equal((await renew(req.renewal_hash, status())).status, "denied");
    assert.equal((await admin.query("select clued_private.resource_center_renewal_current_v1($1) ok", [reader])).rows[0].ok, false);
    assert.ok((await admin.query("select revoked_at from clued_private.resource_center_writer_bindings_v1 where id=$1", [writer])).rows[0].revoked_at);
  });
}
