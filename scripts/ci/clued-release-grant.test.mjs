import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ACTIONS, DOOR_RPC, admitted, checkGrant, commitResource, grantEnforced, main } from "./clued-release-grant.mjs";
import { resolvePublicSupabaseConfig, sha256Hex } from "./clued-work-admission.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC = resolvePublicSupabaseConfig({}, ROOT);
const DOOR = `${PUBLIC.url}/rest/v1/rpc/${DOOR_RPC}`;
const SHA = "a".repeat(40);
const REQUEST = "33333333-3333-4333-8333-333333333333";
const env = (overrides = {}) => ({ GITHUB_REPOSITORY: "o/r", GITHUB_SHA: SHA, CLUED_RELEASE_TOKEN: "clued_bnd_release",
  CLUED_RELEASE_GRANT_ENFORCE: "true", ...overrides });

function fakeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const r = responder ? responder() : { status: 599, body: null };
    const text = r.body === null || r.body === undefined ? "" : JSON.stringify(r.body);
    return { status: r.status ?? 200, text: async () => text };
  };
  return { fetchImpl, calls };
}
const run = (overrides, responder, mode = "deploy") => {
  const fake = fakeFetch(responder);
  return checkGrant({ env: env(overrides), mode, fetchImpl: fake.fetchImpl, workspace: ROOT }).then((r) => ({ r, calls: fake.calls }));
};

test("release grant: deploy consumes for the exact commit, migrate for the named files of it", async () => {
  assert.deepEqual(ACTIONS, { deploy: "release.production", migrate: "migration.production" });
  const files = "20261003170000_a.sql, 20261003180000_b.sql";
  for (const [mode, action, resources] of [
    ["deploy", "release.production", [`repo:o/r/${SHA}`]],
    ["migrate", "migration.production", [`repo:o/r/${SHA}/apps/clued-cloud/supabase/migrations/20261003170000_a.sql`,
      `repo:o/r/${SHA}/apps/clued-cloud/supabase/migrations/20261003180000_b.sql`]],
  ]) {
    const { r, calls } = await run({ MIGRATIONS: files }, () => ({ body: { status: "ok", consumed: true, grant: { grant_id: "g-1", use: 1, max_uses: 1 } } }), mode);
    assert.deepEqual([r.consumed, r.error, admitted(r)], [true, null, true]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, DOOR);
    assert.equal(calls[0].headers.apikey, PUBLIC.key);
    assert.deepEqual(calls[0].body, { p_token_hash: sha256Hex("clued_bnd_release"), p_input: { action, resources } });
  }
  for (const [migrations, message] of [["", /1 to 50/], ["x.sql", /Not a migration file name/], ["../a.sql", /Not a migration/]]) {
    const { r, calls } = await run({ MIGRATIONS: migrations }, null, "migrate");
    assert.match(r.error, message);
    assert.equal(calls.length, 0);
  }
});

test("release grant: no grant fails when enforced and prints the confirmation link", async () => {
  const pending = () => ({ body: { status: "ok", consumed: false,
    owner_request: { request_id: REQUEST, status: "pending", confirm_path: `/confirm/${REQUEST}` } } });
  let { r } = await run({}, pending);
  assert.deepEqual([r.consumed, admitted(r), r.request_id], [false, false, REQUEST]);
  assert.equal(r.confirm_url, `https://clued.pixelgrav.com/confirm/${REQUEST}`);
  ({ r } = await run({ CLUED_RELEASE_GRANT_ENFORCE: "" }, pending));
  assert.equal(admitted(r), true, "advisory until the Owner turns enforcement on");
  ({ r } = await run({ CLUED_CONFIRM_ORIGIN: "https://example.test/" }, pending));
  assert.equal(r.confirm_url, `https://example.test/confirm/${REQUEST}`);
  ({ r } = await run({}, () => ({ body: { status: "ok", consumed: false, owner_request: { confirm_path: "https://evil/x" } } })));
  assert.equal(r.confirm_url, null, "only a /confirm/<id> path becomes a link");
});

test("release grant: missing token, missing RPC and errors stop only when enforced", async () => {
  let { r, calls } = await run({ CLUED_RELEASE_TOKEN: "" });
  assert.equal(calls.length, 0);
  assert.match(r.reason, /CLUED_RELEASE_TOKEN is not set/);
  assert.equal(admitted(r), false);
  ({ r } = await run({ CLUED_RELEASE_TOKEN: "", CLUED_RELEASE_GRANT_ENFORCE: "false" }));
  assert.equal(admitted(r), true);
  ({ r } = await run({}, () => ({ status: 404, body: { code: "PGRST202" } })));
  assert.match(r.reason, /not deployed/);
  assert.equal(admitted(r), false);
  ({ r } = await run({}, () => ({ status: 401, body: { code: "42501", message: "binding_not_authorized" } })));
  assert.match(r.error, /401: binding_not_authorized/);
  ({ r } = await run({}, () => ({ status: 400, body: { code: "22023", message: "owner_grant_door_action_invalid" } })));
  assert.match(r.error, /owner_grant_door_action_invalid/);
  ({ r } = await run({}));
  assert.match(r.error, /returned 599/);
  ({ r } = await run({ GITHUB_SHA: "abc" }));
  assert.match(r.error, /full commit SHA/);
  assert.throws(() => commitResource({ GITHUB_REPOSITORY: "bad", GITHUB_SHA: SHA }), /owner\/name/);
  assert.equal(grantEnforced({ CLUED_RELEASE_GRANT_ENFORCE: "TRUE" }), true);
  assert.equal(grantEnforced({}), false);
});

test("release grant: main exit codes and summary", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-grant-"));
  const summary = path.join(dir, "summary.md");
  const log = console.log; const error = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    assert.equal(await main(["--mode", "backup"], env()), 2);
    const base = env({ GITHUB_STEP_SUMMARY: summary, GITHUB_WORKSPACE: ROOT, MIGRATIONS: "20261003200000_x.sql" });
    assert.equal(await main(["--mode", "deploy"], base,
      fakeFetch(() => ({ body: { status: "ok", consumed: true, grant: { grant_id: "g-9", use: 1, max_uses: 1 } } })).fetchImpl), 0);
    assert.match(fs.readFileSync(summary, "utf8"), /Consumed grant `g-9`, use 1 of 1/);
    assert.equal(await main(["--mode", "migrate"], base, fakeFetch(() => ({ body: { status: "ok", consumed: false,
      owner_request: { request_id: REQUEST, confirm_path: `/confirm/${REQUEST}` } } })).fetchImpl), 1);
    assert.match(fs.readFileSync(summary, "utf8"), new RegExp(`Ask the Owner to approve: https://clued.pixelgrav.com/confirm/${REQUEST}`));
  } finally { console.log = log; console.error = error; }
});
