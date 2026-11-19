import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ACTIONS, DOOR_FUNCTION, commitResource, doorInput, explain, main, migrationResources, renderSummary } from "./clued-release-grant.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = fs.readFileSync(path.join(ROOT, "scripts/ci/clued-release-grant.mjs"), "utf8");
const WORKFLOW = fs.readFileSync(path.join(ROOT, ".github/workflows/clued-cloud-production-release.yml"), "utf8");
const SHA = "a".repeat(40);
const REQUEST = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const env = (overrides = {}) => ({ GITHUB_REPOSITORY: "o/r", GITHUB_SHA: SHA, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", ...overrides });
const consumed = { status: "ok", consumed: true, grant: { grant_id: "g-1", use: 1, max_uses: 1 } };
const pending = { status: "ok", consumed: false, owner_request: { request_id: REQUEST, status: "pending", confirm_path: `/confirm/${REQUEST}`,
  bundle: [{ request_id: REQUEST, action: "migration.production" }, { request_id: OTHER, action: "release.production" }] } };

// FABLE-release-identity-autonomous-20261119 §3.1 test 12: the release
// identity is the database login of the clued-release environment. No token,
// no PostgREST door, no advisory switch remains in the workflow or the script.
test("release door v1: no release token, no PostgREST door, no advisory mode", () => {
  for (const [name, text] of [["workflow", WORKFLOW], ["script", SCRIPT]]) {
    for (const gone of [/CLUED_RELEASE_TOKEN/, /\/rest\/v1\//, /clued_owner_grant_door_consume_v1/, /CLUED_RELEASE_GRANT_ENFORCE/, /\bfetch\(/]) {
      assert.doesNotMatch(text, gone, `${name} still names ${gone}`);
    }
  }
  assert.equal(DOOR_FUNCTION, "clued_private.release_door_v1(jsonb)");
  // The script runs after npm ci with NODE_OPTIONS='' and loads only Node's own modules.
  const imports = [...SCRIPT.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
  assert.ok(imports.length > 0);
  for (const specifier of imports) assert.match(specifier, /^node:/, specifier);
});

test("release door v1: deploy asks for the exact commit, migrate for the named files of it with the deploy bundled", () => {
  assert.deepEqual(ACTIONS, { deploy: "release.production", migrate: "migration.production" });
  assert.deepEqual(doorInput(env(), "deploy"), { action: "release.production", resources: [`repo:o/r/${SHA}`], run_id: "123", run_attempt: "2" });
  const files = "20261003170000_a.sql, 20261003180000_b.sql";
  assert.deepEqual(doorInput(env({ MIGRATIONS: files }), "migrate", { requestOnly: true }), {
    action: "migration.production",
    resources: [`repo:o/r/${SHA}/apps/clued-cloud/supabase/migrations/20261003170000_a.sql`,
      `repo:o/r/${SHA}/apps/clued-cloud/supabase/migrations/20261003180000_b.sql`],
    with: [{ action: "release.production", resources: [`repo:o/r/${SHA}`] }],
    request_only: true, run_id: "123", run_attempt: "2" });
  // Run numbers are self-reported context; anything but digits is left out.
  assert.equal("run_id" in doorInput(env({ GITHUB_RUN_ID: "1; drop" }), "deploy"), false);
  // The door (PR-A) takes ^[1-9][0-9]{0,19}$ and ^[1-9][0-9]{0,5}$ and refuses anything else.
  assert.deepEqual(Object.keys(doorInput(env({ GITHUB_RUN_ID: "0", GITHUB_RUN_ATTEMPT: "1234567" }), "deploy")), ["action", "resources"]);
  for (const [migrations, message] of [["", /1 to 50/], ["x.sql", /Not a migration file name/], ["../a.sql", /Not a migration/]]) {
    assert.throws(() => migrationResources(env({ MIGRATIONS: migrations })), message);
  }
  assert.throws(() => doorInput(env(), "backup"), /needs no Owner Grant/);
  assert.throws(() => commitResource({ GITHUB_REPOSITORY: "bad", GITHUB_SHA: SHA }), /owner\/name/);
  assert.throws(() => commitResource({ GITHUB_REPOSITORY: "o/r", GITHUB_SHA: "abc" }), /full commit SHA/);
});

test("release door v1: a consumed grant admits, a pending request prints its link, a refusal says what to do", () => {
  let r = explain({ mode: "deploy", answerText: `${JSON.stringify(consumed)}\n`, errorText: "", env: env() });
  assert.deepEqual([r.consumed, r.grant.grant_id, r.reason], [true, "g-1", null]);
  assert.match(renderSummary(r), /已消费授权 `g-1`，第 1 次（共 1 次）/);

  r = explain({ mode: "migrate", answerText: JSON.stringify(pending), errorText: "", env: env({ MIGRATIONS: "20261003170000_a.sql" }) });
  assert.deepEqual([r.consumed, r.request_id], [false, REQUEST]);
  assert.equal(r.confirm_url, `https://kooyumi.pixelgrav.com/confirm/${REQUEST}`);
  assert.match(r.reason, /没有授权放行这次迁移/);
  assert.match(renderSummary(r), /同时覆盖 `migration.production` 和 `release.production`/);
  r = explain({ mode: "deploy", answerText: JSON.stringify(pending), errorText: "", env: env({ CLUED_CONFIRM_ORIGIN: "https://example.test/" }) });
  assert.equal(r.confirm_url, `https://example.test/confirm/${REQUEST}`);
  r = explain({ mode: "deploy", answerText: JSON.stringify({ status: "ok", consumed: false, owner_request: { confirm_path: "https://evil/x" } }), errorText: "", env: env() });
  assert.equal(r.confirm_url, null, "only a /confirm/<id> path becomes a link");
  // request_only that finds a live grant: nothing to approve, rerun.
  r = explain({ mode: "migrate", answerText: JSON.stringify({ status: "ok", consumed: false, admitted: true, action: "migration.production" }),
    errorText: "", env: env({ MIGRATIONS: "20261003170000_a.sql" }) });
  assert.deepEqual([r.consumed, r.confirm_url], [false, null]);
  assert.match(r.reason, /已有可用授权.*重跑/);

  for (const [errorText, expected] of [
    ["ERROR:  function clued_private.release_door_v1(jsonb) does not exist", /发布门.*不在这个数据库里.*自举/],
    ["ERROR:  permission denied for function release_door_v1", /登录角色无权调用发布门/],
    ["ERROR:  release_door_probe_failed", /探门失败.*回滚/],
    ["ERROR:  release_door_not_installed", /发布门却仍不存在/],
    ["psql: error: connection to server failed: password authentication failed", /连不上生产库/],
    ["ERROR:  release_door_resource_invalid", /发布门拒绝了这次调用：release_door_resource_invalid/],
    ["", /发布门没有回答/],
  ]) {
    r = explain({ mode: "deploy", answerText: "", errorText, env: env() });
    assert.equal(r.consumed, false);
    assert.match(r.reason, expected, errorText);
  }
  // An answer that is not the door's: not consumed, whatever it says.
  for (const answerText of ["{", "[]", JSON.stringify({ status: "error", consumed: true }), "t"]) {
    assert.equal(explain({ mode: "deploy", answerText, errorText: "", env: env() }).consumed, false, answerText);
  }
});

test("release door v1: main prints the input, reports the answer and exits 0 only when consumed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-grant-"));
  const summary = path.join(dir, "summary.md");
  const errorFile = path.join(dir, "error.txt");
  const out = [];
  const io = (stdin) => ({ stdin, write: (text) => out.push(text), error: () => {} });
  try {
    assert.equal(await main(["backup"], env(), io("")), 2);
    assert.equal(await main(["input", "--mode", "deploy"], env(), io("")), 0);
    assert.deepEqual(JSON.parse(out.at(-1)), doorInput(env(), "deploy"));
    assert.equal(out.at(-1).trim().split("\n").length, 1, "one COPY line");
    const base = env({ GITHUB_STEP_SUMMARY: summary, MIGRATIONS: "20261003200000_x.sql" });
    assert.equal(await main(["report", "--mode", "deploy"], base, io(JSON.stringify(consumed))), 0);
    assert.match(fs.readFileSync(summary, "utf8"), /已消费授权 `g-1`/);
    assert.equal(await main(["report", "--mode", "migrate"], base, io(JSON.stringify(pending))), 1);
    assert.match(fs.readFileSync(summary, "utf8"), new RegExp(`请 Owner 打开 https://kooyumi.pixelgrav.com/confirm/${REQUEST}`));
    fs.writeFileSync(errorFile, "ERROR:  function clued_private.release_door_v1(jsonb) does not exist\n");
    assert.equal(await main(["report", "--mode", "deploy", "--error-file", errorFile], base, io("")), 1);
    assert.match(fs.readFileSync(summary, "utf8"), /自举/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
