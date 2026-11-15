import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ACTIONS, DOOR_RPC, admitted, checkGrant, checkRelease, commitResource, grantEnforced, main, releaseAdmitted } from "./clued-release-grant.mjs";
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
    const input = mode === "migrate" ? { action, resources, with: [{ action: "release.production", resources: [`repo:o/r/${SHA}`] }] }
      : { action, resources };
    assert.deepEqual(calls[0].body, { p_token_hash: sha256Hex("clued_bnd_release"), p_input: input });
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
  assert.equal(r.confirm_url, `https://kooyumi.pixelgrav.com/confirm/${REQUEST}`);
  ({ r } = await run({ CLUED_RELEASE_GRANT_ENFORCE: "" }, pending));
  assert.equal(admitted(r), true, "advisory until the Owner turns enforcement on");
  ({ r } = await run({ CLUED_CONFIRM_ORIGIN: "https://example.test/" }, pending));
  assert.equal(r.confirm_url, `https://example.test/confirm/${REQUEST}`);
  ({ r } = await run({ CLUED_CONFIRM_ORIGIN: "https://clued.pixelgrav.com/" }, pending));
  assert.equal(r.confirm_url, `https://clued.pixelgrav.com/confirm/${REQUEST}`);
  assert.equal(admitted(r), false, "an explicit legacy link still requires the Owner Grant");
  ({ r } = await run({}, () => ({ body: { status: "ok", consumed: false, owner_request: { confirm_path: "https://evil/x" } } })));
  assert.equal(r.confirm_url, null, "only a /confirm/<id> path becomes a link");
});

test("release grant: migrate opens one bundle with the deploy; an older door is asked again without it", async () => {
  const OTHER = "44444444-4444-4444-8444-444444444444";
  const bundled = () => ({ body: { status: "ok", consumed: false, owner_request: { request_id: REQUEST, status: "pending",
    confirm_path: `/confirm/${REQUEST}`, bundle: [{ request_id: REQUEST, action: "migration.production" },
      { request_id: OTHER, action: "release.production" }] } } });
  let { r, calls } = await run({ MIGRATIONS: "20261003170000_a.sql" }, bundled, "migrate");
  assert.equal(calls.length, 1);
  assert.deepEqual(r.bundle, [{ action: "migration.production", request_id: REQUEST }, { action: "release.production", request_id: OTHER }]);
  assert.equal(r.confirm_url, `https://kooyumi.pixelgrav.com/confirm/${REQUEST}`);
  // A door that does not know `with` yet: one retry without it.
  let first = true;
  ({ r, calls } = await run({ MIGRATIONS: "20261003170000_a.sql" }, () => {
    if (first) { first = false; return { status: 400, body: { code: "22023", message: "owner_grant_door_input_invalid" } }; }
    return { body: { status: "ok", consumed: true, grant: { grant_id: "g-1", use: 1, max_uses: 1 } } };
  }, "migrate"));
  assert.equal(calls.length, 2);
  assert.ok(calls[0].body.p_input.with);
  assert.equal("with" in calls[1].body.p_input, false);
  assert.deepEqual([r.consumed, r.error], [true, null]);
  // Deploy never names other actions, and is not retried.
  ({ r, calls } = await run({}, () => ({ status: 400, body: { code: "22023", message: "owner_grant_door_input_invalid" } })));
  assert.equal(calls.length, 1);
  assert.match(r.error, /owner_grant_door_input_invalid/);
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
    assert.match(fs.readFileSync(summary, "utf8"), new RegExp(`Ask the Owner to approve: https://kooyumi.pixelgrav.com/confirm/${REQUEST}`));
  } finally { console.log = log; console.error = error; }
});

test("release grant: release mode uses the one bundle approval once, migrations first, deploy only without them", async () => {
  const consumed = (id) => ({ body: { status: "ok", consumed: true, grant: { grant_id: id, use: 1, max_uses: 1 } } });
  const pending = { body: { status: "ok", consumed: false, owner_request: { request_id: REQUEST, confirm_path: `/confirm/${REQUEST}`,
    bundle: [{ request_id: REQUEST, action: "migration.production" }, { request_id: "44444444-4444-4444-8444-444444444444", action: "release.production" }] } } };
  const call = async (overrides, answers) => {
    const fake = fakeFetch(() => answers.shift());
    const results = await checkRelease({ env: env(overrides), fetchImpl: fake.fetchImpl, workspace: ROOT });
    return { results, calls: fake.calls };
  };
  const migrationResource = `repo:o/r/${SHA}/apps/clued-cloud/supabase/migrations/20261003170000_a.sql`;
  // With migrations: the migration grant (asking for the deploy with it), then the deploy grant; each once.
  let { results, calls } = await call({ MIGRATIONS: "20261003170000_a.sql" }, [consumed("g-m"), consumed("g-d")]);
  assert.deepEqual(calls.map((c) => c.body.p_input.action), ["migration.production", "release.production"]);
  assert.deepEqual(calls[0].body.p_input, { action: "migration.production", resources: [migrationResource],
    with: [{ action: "release.production", resources: [`repo:o/r/${SHA}`] }] });
  assert.deepEqual(calls[1].body.p_input, { action: "release.production", resources: [`repo:o/r/${SHA}`] });
  assert.deepEqual(results.map((r) => [r.mode, r.consumed, r.grant.grant_id]), [["migrate", true, "g-m"], ["deploy", true, "g-d"]]);
  assert.equal(releaseAdmitted(results), true);
  // Without migrations: only the deploy of the commit.
  ({ results, calls } = await call({ MIGRATIONS: "" }, [consumed("g-d")]));
  assert.deepEqual(calls.map((c) => c.body.p_input), [{ action: "release.production", resources: [`repo:o/r/${SHA}`] }]);
  assert.equal(releaseAdmitted(results), true);
  // No grant yet: one bundle link for both, and the deploy grant is not asked for separately.
  ({ results, calls } = await call({ MIGRATIONS: "20261003170000_a.sql" }, [pending]));
  assert.equal(calls.length, 1);
  assert.equal(releaseAdmitted(results), false);
  assert.equal(results[0].confirm_url, `https://kooyumi.pixelgrav.com/confirm/${REQUEST}`);
  assert.deepEqual(results[0].bundle.map((m) => m.action), ["migration.production", "release.production"]);
  // The migration grant alone does not admit the release.
  ({ results } = await call({ MIGRATIONS: "20261003170000_a.sql" }, [consumed("g-m"), pending]));
  assert.equal(releaseAdmitted(results), false);
  assert.equal(releaseAdmitted(results.map((r) => ({ ...r, enforced: false }))), true, "advisory until enforced");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-grant-"));
  const summary = path.join(dir, "summary.md");
  const log = console.log; const error = console.error;
  console.log = () => {}; console.error = () => {};
  try {
    const base = env({ GITHUB_STEP_SUMMARY: summary, GITHUB_WORKSPACE: ROOT, MIGRATIONS: "20261003170000_a.sql" });
    const answers = [consumed("g-m"), consumed("g-d")];
    assert.equal(await main(["--mode", "release"], base, fakeFetch(() => answers.shift()).fetchImpl), 0);
    const text = fs.readFileSync(summary, "utf8");
    assert.match(text, /Owner Grant for release[\s\S]*migration\.production[\s\S]*Consumed grant `g-m`[\s\S]*release\.production[\s\S]*Consumed grant `g-d`/);
    assert.equal(await main(["--mode", "release"], base, fakeFetch(() => pending).fetchImpl), 1);
  } finally { console.log = log; console.error = error; }
});
