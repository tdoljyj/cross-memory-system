import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

// StorageNormalUse.v0.1 N0, Worker side: begin, the onboard OAuth callback,
// idempotent Drive directory effects, every root check of §8.1 step 5, overlap,
// orphans on failure and resume. Synthetic Google endpoints only.
const dir = await mkdtemp(path.join(os.tmpdir(), "clued-onboard-"));
const bundle = async (name, entry) => {
  const outfile = path.join(dir, name + ".mjs");
  await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], outfile, bundle: true, platform: "node", format: "esm" });
  return import(pathToFileURL(outfile));
};
// One bundle for both modules, as in the Worker: they share one error class.
const onboardOut = path.join(dir, "onboard.mjs");
await build({ stdin: { contents: 'export * from "./storage-google-onboard.ts"; export { createStorageGoogleOAuth } from "./storage-google-oauth.ts";',
  resolveDir: fileURLToPath(new URL("../worker/", import.meta.url)), loader: "ts" }, outfile: onboardOut, bundle: true, platform: "node", format: "esm" });
const { createStorageGoogleOnboard, ONBOARD_PAGE_REASONS, createStorageGoogleOAuth } = await import(pathToFileURL(onboardOut));
const { createStorageCredentialVault } = await bundle("vault", "../worker/storage-credential-vault.ts");
const { renderOnboardDisclosure, ONBOARD_DISCLOSURE_VERSION } = await bundle("disclosure", "../worker/storage-onboard-disclosure.ts");

const sha = value => createHash("sha256").update(value).digest("hex");
const CLIENT = "fixture.apps.googleusercontent.com", REDIRECT = "https://clued.example.invalid/storage/google/callback";
const LEGACY = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
const NORMAL = LEGACY + " https://www.googleapis.com/auth/drive.readonly";
const FOLDER = "application/vnd.google-apps.folder";
const OWNER = randomUUID();
const vaultConfig = { current_key_id: "k1", keys: { k1: randomBytes(32).toString("base64url") } };

// A synthetic Drive: folders by ID; "my-drive" is the My Drive root (no parents).
function drive(options = {}) {
  const files = new Map([["my-drive", { id: "my-drive", parents: [] }], ...(options.files ?? [])]);
  const calls = [];
  let next = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url)); calls.push({ url: u, init });
    assert.equal(init.redirect, "manual");
    if (u.pathname === "/token") {
      if (options.tokenFailure) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", token_type: "Bearer",
        expires_in: 3600, scope: options.scope ?? NORMAL });
    }
    assert.equal(init.headers.authorization, "Bearer fixture-access-token");
    if (u.pathname === "/drive/v3/about") return Response.json({ user: { me: true, permissionId: "provider-user" } });
    if (u.pathname === "/drive/v3/files" && (init.method ?? "GET") === "GET") {
      const q = u.searchParams.get("q");
      if (options.listFailure?.(q)) return new Response("{}", { status: 500 });
      const marker = /value='([^']+)' \} and appProperties has \{ key='clued_onboard_role' and value='([^']+)' \}/.exec(q);
      const child = /^'([^']+)' in parents and name = '([^']+)'/.exec(q);
      const result = [...files.values()].filter(f => !f.trashed && (marker
        ? f.appProperties?.clued_onboard_attempt_id === marker[1] && f.appProperties?.clued_onboard_role === marker[2]
        : child ? f.parents?.[0] === child[1] && f.name === child[2] && f.mimeType === FOLDER : false));
      return Response.json({ files: result });
    }
    if (u.pathname === "/drive/v3/files" && init.method === "POST") {
      const body = JSON.parse(init.body);
      await options.beforeCreate?.(body);
      if (options.createFailure?.(body)) return new Response("{}", { status: 500 });
      const file = { id: `created-${++next}`, name: body.name, mimeType: body.mimeType, parents: body.parents ?? ["my-drive"], trashed: false,
        version: "1", appProperties: body.appProperties, ...(options.permissions ? { permissions: structuredClone(options.permissions) } : {}) };
      files.set(file.id, file);
      return Response.json(file);
    }
    const id = decodeURIComponent(u.pathname.replace("/drive/v3/files/", ""));
    if (options.getFailure?.(id)) return new Response("{}", { status: 500 });
    const file = files.get(id);
    if (!file) return Response.json({ error: { code: 404 } }, { status: 404 });
    return Response.json(file);
  };
  return { fetch, files, calls, creates: () => calls.filter(c => c.init.method === "POST" && c.url.pathname === "/drive/v3/files") };
}

// A synthetic database implementing the clued_storage_onboard_v1 contract.
function database(options = {}) {
  const attempts = new Map(), calls = [];
  const rpc = async input => {
    calls.push(structuredClone(input));
    if (options.refuse?.[input.action]) throw new Error(options.refuse[input.action]);
    const a = attempts.get(input.onboard_attempt_id) ?? [...attempts.values()].find(x => x.state_hash === input.state_hash);
    const view = x => ({ onboard_attempt_id: x.id, connection_id: x.connection_id, root: x.root, tracks: x.tracks, effects: x.effects,
      orphans: x.orphans, state: x.state, active_roots: options.activeRoots ?? [] });
    // The run token: the run holding it drives effects, activation and fail.
    const holds = () => { if (input.run_token !== a.run_token) throw new Error("storage_onboard_run_superseded"); };
    const lease = () => { a.run_token = randomUUID(); a.lease = true; };
    switch (input.action) {
      case "begin":
        attempts.set(input.onboard_attempt_id, { ...input, id: input.onboard_attempt_id, effects: {}, orphans: [], strays: [], state: "begun" });
        return { status: "begun", onboard_attempt_id: input.onboard_attempt_id, oauth_client_id: CLIENT, redirect_uri: REDIRECT,
          requested_scope_profile: input.normal_use_requested ? "normal" : "legacy" };
      case "stage_credential":
        Object.assign(a, { state: "credential_staged", provider_subject: input.provider_subject, credential_envelope: input.credential_envelope,
          granted: input.provider_scope_profile });
        lease();
        return { ...view(a), status: "credential_staged", run_token: a.run_token };
      case "effect_intent":
        holds();
        a.effects[input.role] ??= { intent_at: "t" };
        return { status: "intent" };
      case "effect_result":
        options.beforeResult?.(input, a);
        holds();
        if (options.ambiguous?.(input)) throw new Error("storage_onboard_effect_ambiguous");
        if (a.effects[input.role]?.provider_file_id && a.effects[input.role].provider_file_id !== input.provider_file_id)
          throw new Error("storage_onboard_effect_ambiguous");
        a.effects[input.role] = { ...a.effects[input.role], provider_file_id: input.provider_file_id, parents: input.parents, created: input.created };
        return { status: "recorded", role: input.role, effect: a.effects[input.role] };
      case "effect_stray":
        if (!Object.values(a.effects).some(e => e.provider_file_id === input.provider_file_id)) a.strays.push({ role: input.role, provider_file_id: input.provider_file_id });
        return { status: "stray_recorded" };
      case "activate":
        holds();
        if (options.activateFailures > 0) { options.activateFailures--; throw new Error("transient"); }
        if ((options.activeRoots ?? []).some(r => input.ancestors.includes(r))) throw new Error("storage_onboard_root_overlaps_existing");
        a.state = "completed"; a.ancestors = input.ancestors; a.run_token = undefined;
        return { status: "completed", purpose: "onboard", receipt_id: randomUUID(), onboard_attempt_id: a.id, connection_id: a.connection_id,
          provider_scope_profile: a.granted, requested_scope_profile: a.normal_use_requested ? "normal" : "legacy",
          normal_use_enabled: a.normal_use_requested && a.granted === "normal", refresh_enabled: a.default_refresh_requested };
      case "fail":
        if (a.state === "credential_staged") holds();
        a.state = "failed"; a.failure = input.code; a.retryable = input.retryable; a.run_token = undefined; a.lease = false;
        if (input.retryable === false) a.credential_envelope = null;
        a.orphans = [...Object.entries(a.effects).filter(([role, e]) => e.created !== false && e.intent_at &&
          (e.provider_file_id || !a.strays.some(x => x.role === role))).map(([role, e]) => ({ role, provider_file_id: e.provider_file_id ?? null })),
          ...a.strays];
        return view(a);
      case "resume":
        if ((a.state !== "failed" && a.state !== "credential_staged") || !a.credential_envelope) throw new Error("storage_onboard_denied");
        if (a.state === "credential_staged" && a.lease) throw new Error("storage_onboard_run_active");
        a.state = "credential_staged"; lease();
        return { ...view(a), status: "credential_staged", run_token: a.run_token, owner_id: OWNER, provider_subject: a.provider_subject, oauth_client_id: CLIENT,
          credential_version: 1, credential_envelope: a.credential_envelope };
      default: throw new Error("unknown " + input.action);
    }
  };
  return { rpc, attempts, calls };
}

async function fixture(options = {}) {
  const google = drive(options.drive), db = database(options.db);
  const onboard = await createStorageGoogleOnboard({ client_id: CLIENT, client_secret: "fixture-only-client-secret", redirect_uri: REDIRECT,
    vault: vaultConfig, rpc: db.rpc, fetch: google.fetch, picker_configured: options.picker ?? true, refresh_available: options.refresh ?? true });
  const vault = await createStorageCredentialVault(vaultConfig);
  // The OAuth callback path: claim through the database, then the onboard hook.
  const claim = async (begun, attempt) => {
    const stored = db.attempts.get(begun.onboard_attempt_id);
    return { status: "claimed", purpose: "onboard", attempt_id: stored.oauth_attempt_id, verifier_envelope: stored.verifier_envelope,
      owner_id: OWNER, connection_id: stored.connection_id, credential_version: 1, provider_subject: null, oauth_client_id: CLIENT,
      redirect_uri: REDIRECT, requested_scope_profile: stored.normal_use_requested ? "normal" : "legacy", onboard_attempt_id: begun.onboard_attempt_id, ...attempt };
  };
  const run = async (choice = {}) => {
    const input = { root: { mode: "new", name: "Clued_资料中心" }, tracks: ["资料", "项目", "归档"], normal_use: true, default_refresh: true,
      disclosure_version: ONBOARD_DISCLOSURE_VERSION, ...choice };
    const begun = await onboard.begin(OWNER, input);
    const stored = db.attempts.get(begun.onboard_attempt_id);
    return { begun, input, stored, complete: async () => onboard.complete(await claim(begun), "fixture-code", stored.state_hash) };
  };
  return { google, db, onboard, vault, run, claim };
}
const reasonOf = async promise => { try { await promise; } catch (error) { return error.reason; } assert.fail("expected a refusal"); };

test("begin: no provider call, the rendered disclosure and its digest, PKCE and the requested scope set", async () => {
  const f = await fixture();
  const { begun, input, stored } = await f.run();
  assert.equal(f.google.calls.length, 0, "begin contacts no Google endpoint");
  const url = new URL(begun.authorization_url);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("scope"), NORMAL.split(" ").sort().join(" "));
  for (const [key, value] of [["access_type", "offline"], ["prompt", "consent"], ["include_granted_scopes", "false"], ["code_challenge_method", "S256"],
    ["client_id", CLIENT], ["redirect_uri", REDIRECT]]) assert.equal(url.searchParams.get(key), value);
  assert.equal(stored.state_hash, sha(url.searchParams.get("state")));
  const { disclosure_version, ...choice } = input;
  assert.equal(stored.disclosure_text, renderOnboardDisclosure(choice)); assert.equal(stored.disclosure_sha256, sha(stored.disclosure_text));
  assert.equal(disclosure_version, "clued.storage-onboard-disclosure/1");
  assert.match(stored.disclosure_text, /「Clued_资料中心」/); assert.match(stored.disclosure_text, /「资料」「项目」「归档」/);
  assert.match(stored.disclosure_text, /查看你 Google 云端硬盘中的所有文件/); assert.match(stored.disclosure_text, /后台自动续期/);
  const verifier = await f.vault.open(stored.verifier_envelope, { owner_id: OWNER, connection_id: stored.connection_id, provider: "google-drive",
    provider_subject: "oauth_" + stored.oauth_attempt_id, oauth_client_id: CLIENT, credential_version: 1 });
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));
  const legacy = await (await fixture()).run({ normal_use: false });
  assert.equal(new URL(legacy.begun.authorization_url).searchParams.get("scope"), LEGACY.split(" ").sort().join(" "));
  assert.equal(legacy.stored.disclosure_text.includes("查看你 Google 云端硬盘中的所有文件"), false);
});

test("begin refuses closed: Picker unconfigured, refresh unavailable, invalid input, changed disclosure, not allowlisted", async () => {
  const picked = { root: { mode: "picked", name: "Existing", folder_id: "picked-folder" } };
  const noPicker = await fixture({ picker: false });
  assert.equal(await reasonOf(noPicker.run(picked)), "picker_unconfigured"); assert.equal(noPicker.db.calls.length, 0);
  assert.equal(await reasonOf((await fixture({ refresh: false })).run()), "refresh_unavailable");
  for (const bad of [{ tracks: [] }, { tracks: ["a/b"] }, { tracks: ["x", "x"] }, { root: { mode: "new", name: " padded" } },
    { root: { mode: "picked", name: "x", folder_id: "bad id" } }, { extra: true }]) {
    assert.equal(await reasonOf((await fixture()).run(bad)), "onboard_input_invalid", JSON.stringify(bad));
  }
  assert.equal(await reasonOf((await fixture()).run({ disclosure_version: "clued.storage-onboard-disclosure/0" })), "onboard_disclosure_changed");
  const gated = await fixture({ db: { refuse: { begin: "storage_onboard_not_allowed" } } });
  assert.equal(await reasonOf(gated.run()), "onboard_not_allowed", "a user outside the allowlist is refused");
  assert.equal(await reasonOf((await fixture({ db: { refuse: { begin: "storage_refresh_token_limit" } } })).run()), "refresh_token_limit");
});

test("new root: one root and its tracks are created with markers, then one activation with the ancestor chain", async () => {
  const f = await fixture();
  const flow = await f.run();
  const done = await flow.complete();
  assert.deepEqual({ status: done.status, purpose: done.purpose, profile: done.provider_scope_profile, normal: done.normal_use_enabled, refresh: done.refresh_enabled },
    { status: "completed", purpose: "onboard", profile: "normal", normal: true, refresh: true });
  const creates = f.google.creates().map(c => JSON.parse(c.init.body));
  assert.equal(creates.length, 4);
  assert.deepEqual(creates[0], { name: "Clued_资料中心", mimeType: FOLDER, appProperties: { clued_onboard_attempt_id: flow.begun.onboard_attempt_id, clued_onboard_role: "root" } },
    "the root has no parents: My Drive");
  assert.ok(creates.slice(1).every(body => body.parents[0] === "created-1" && body.appProperties.clued_onboard_role === "track:" + body.name));
  const stored = f.db.attempts.get(flow.begun.onboard_attempt_id);
  assert.deepEqual(stored.ancestors, ["my-drive"]);
  // Intent strictly before each create; result after it.
  const actions = f.db.calls.map(c => c.action + (c.role ? ":" + c.role : ""));
  const token = f.db.calls.find(c => c.action === "effect_intent").run_token;
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.ok(f.db.calls.filter(c => !["begin", "stage_credential"].includes(c.action)).every(c => c.run_token === token), "every run call carries the run token");
  assert.deepEqual(actions, ["begin", "stage_credential", "effect_intent:root", "effect_result:root", "effect_intent:track:资料", "effect_result:track:资料",
    "effect_intent:track:项目", "effect_result:track:项目", "effect_intent:track:归档", "effect_result:track:归档", "activate"]);
  const staged = f.db.calls.find(c => c.action === "stage_credential");
  assert.equal(staged.provider_scope_profile, "normal"); assert.equal(staged.provider_subject, "provider-user");
  const plain = JSON.parse(await f.vault.open(staged.credential_envelope, { owner_id: OWNER, connection_id: flow.stored.connection_id, provider: "google-drive",
    provider_subject: "provider-user", oauth_client_id: CLIENT, credential_version: 1 }));
  assert.equal(plain.refresh_token, "fixture-refresh-token"); assert.equal(plain.scope, NORMAL.split(" ").sort().join(" "));
});

test("callback replay and retry never create a directory twice; a failed activation records orphans and resumes", async () => {
  const f = await fixture({ db: { activateFailures: 1 } });
  const flow = await f.run();
  const failure = await flow.complete().catch(error => error);
  assert.equal(failure.reason, "activation_unconfirmed"); assert.equal(failure.onboard_attempt_id, flow.begun.onboard_attempt_id);
  const stored = f.db.attempts.get(flow.begun.onboard_attempt_id);
  assert.equal(stored.state, "failed"); assert.equal(stored.failure, "activation_unconfirmed");
  assert.equal(stored.retryable, true, "an unconfirmed activation keeps the staged credential for resume");
  assert.deepEqual(stored.orphans.map(o => o.role).sort(), ["root", "track:归档", "track:资料", "track:项目"].sort(), "created objects are orphans");
  assert.equal(f.google.creates().length, 4);
  const done = await f.onboard.resume(flow.begun.onboard_attempt_id);
  assert.equal(done.status, "completed");
  assert.equal(f.google.creates().length, 4, "resume finds every object by its marker and creates nothing");
  // A replay after a crash between create and effect_result also reuses.
  const crash = await fixture();
  const again = await crash.run();
  crash.google.files.set("pre-root", { id: "pre-root", name: "Clued_资料中心", mimeType: FOLDER, parents: ["my-drive"], trashed: false, version: "2",
    appProperties: { clued_onboard_attempt_id: again.begun.onboard_attempt_id, clued_onboard_role: "root" } });
  await again.complete();
  assert.equal(crash.google.creates().length, 3, "the existing root is reused, only tracks are created");
  assert.equal(crash.db.attempts.get(again.begun.onboard_attempt_id).effects.root.provider_file_id, "pre-root");
});

test("an effect failure is recorded with its orphans and never deletes anything", async () => {
  const f = await fixture({ drive: { createFailure: body => body.name === "项目" } });
  const flow = await f.run();
  assert.equal(await reasonOf(flow.complete()), "onboard_effect_unconfirmed");
  const stored = f.db.attempts.get(flow.begun.onboard_attempt_id);
  assert.equal(stored.failure, "onboard_effect_unconfirmed");
  assert.deepEqual(stored.orphans.map(o => [o.role, o.provider_file_id]), [["root", "created-1"], ["track:资料", "created-2"], ["track:项目", null]]);
  assert.equal(f.google.calls.some(c => c.init.method === "DELETE" || c.init.method === "PATCH"), false);
  assert.equal(f.db.calls.some(c => c.action === "activate"), false);
});

test("two marked objects for one role are ambiguous", async () => {
  const f = await fixture();
  const flow = await f.run();
  for (const id of ["a1", "a2"]) f.google.files.set(id, { id, name: "Clued_资料中心", mimeType: FOLDER, parents: ["my-drive"], trashed: false, version: "1",
    appProperties: { clued_onboard_attempt_id: flow.begun.onboard_attempt_id, clued_onboard_role: "root" } });
  assert.equal(await reasonOf(flow.complete()), "onboard_effect_ambiguous");
  assert.equal(f.google.creates().length, 0);
});

const pickedFolder = (changes = {}) => ["picked", { id: "picked", name: "我的资料", mimeType: FOLDER, trashed: false, ownedByMe: true, parents: ["my-drive"],
  isAppAuthorized: true, capabilities: { canAddChildren: true }, version: "7", ...changes }];
const pick = { root: { mode: "picked", name: "我的资料", folder_id: "picked" } };

test("picked root: each §8.1 step 5 check refuses before any directory is created", async () => {
  for (const [changes, reason] of [
    [{ driveId: "shared-drive" }, "root_shared_drive"],
    [{ ownedByMe: false }, "root_not_owned"],
    [{ parents: ["my-drive", "other"] }, "root_multiple_parents"],
    [{ name: "改过的名字" }, "root_name_changed"],
    [{ isAppAuthorized: false }, "root_not_authorized"],
    [{ capabilities: { canAddChildren: false } }, "root_not_writable"],
    [{ trashed: true }, "root_trashed"],
    [{ mimeType: "text/plain" }, "root_not_folder"],
  ]) {
    const f = await fixture({ drive: { files: [pickedFolder(changes)] } });
    const flow = await f.run(pick);
    assert.equal(await reasonOf(flow.complete()), reason, reason);
    assert.equal(f.google.creates().length, 0, reason + ": nothing created");
    assert.equal(f.db.attempts.get(flow.begun.onboard_attempt_id).failure, reason);
    assert.ok(ONBOARD_PAGE_REASONS.includes(reason));
    // A failure a resume cannot fix drops the staged credential at once.
    const terminal = !["root_multiple_parents", "root_not_authorized", "root_not_writable", "root_trashed"].includes(reason);
    assert.equal(f.db.attempts.get(flow.begun.onboard_attempt_id).retryable, !terminal, reason + ": retryable");
  }
  const ok = await fixture({ drive: { files: [pickedFolder()] } });
  const done = await (await ok.run(pick)).complete();
  assert.equal(done.status, "completed");
  assert.equal(ok.google.creates().length, 3, "only the tracks are created under a picked root");
  const result = ok.db.calls.find(c => c.action === "effect_result" && c.role === "root");
  assert.deepEqual({ id: result.provider_file_id, created: result.created, parents: result.parents }, { id: "picked", created: false, parents: ["my-drive"] });
  assert.equal(ok.db.calls.some(c => c.action === "effect_intent" && c.role === "root"), false);
});

test("track name conflict: an existing folder with a track name refuses; our own marked folder is reused", async () => {
  const f = await fixture({ drive: { files: [pickedFolder(), ["foreign", { id: "foreign", name: "项目", mimeType: FOLDER, parents: ["picked"], trashed: false, version: "1" }]] } });
  const flow = await f.run(pick);
  assert.equal(await reasonOf(flow.complete()), "onboard_track_name_conflict");
  assert.equal(f.google.creates().length, 1, "the track before the conflict was created and is an orphan");
  assert.deepEqual(f.db.attempts.get(flow.begun.onboard_attempt_id).orphans.map(o => o.role), ["track:资料"]);
});

test("overlap: equal to, inside or containing an active root of this Google account is refused; invisible roots are ignored", async () => {
  const nested = [["parent-a", { id: "parent-a", parents: ["my-drive"] }]];
  // Picked root inside an active root.
  const inside = await fixture({ db: { activeRoots: ["parent-a"] }, drive: { files: [...nested, pickedFolder({ parents: ["parent-a"] })] } });
  assert.equal(await reasonOf((await inside.run(pick)).complete()), "root_overlaps_existing");
  // Picked root containing an active root.
  const contains = await fixture({ db: { activeRoots: ["deep"] }, drive: { files: [pickedFolder(), ["child", { id: "child", parents: ["picked"] }],
    ["deep", { id: "deep", parents: ["child"], trashed: false }]] } });
  assert.equal(await reasonOf((await contains.run(pick)).complete()), "root_overlaps_existing");
  // Equal.
  const equal = await fixture({ db: { activeRoots: ["picked"] }, drive: { files: [pickedFolder()] } });
  assert.equal(await reasonOf((await equal.run(pick)).complete()), "root_overlaps_existing");
  for (const f of [inside, contains, equal]) assert.equal(f.google.creates().length, 0);
  // An active root this account cannot see (404) does not block; a failing lookup does.
  const invisible = await fixture({ db: { activeRoots: ["gone"] }, drive: { files: [pickedFolder()] } });
  assert.equal((await (await invisible.run(pick)).complete()).status, "completed");
  const failing = await fixture({ db: { activeRoots: ["flaky"] }, drive: { files: [pickedFolder(), ["flaky", { id: "flaky", parents: ["my-drive"] }]], getFailure: id => id === "flaky" } });
  assert.equal(await reasonOf((await failing.run(pick)).complete()), "root_ancestry_unavailable");
});

test("granted scopes: normal requested may come back legacy; any other set or an upgrade is refused before staging", async () => {
  const partial = await fixture({ drive: { scope: LEGACY } });
  const done = await (await partial.run()).complete();
  assert.equal(done.provider_scope_profile, "legacy"); assert.equal(done.normal_use_enabled, false);
  assert.equal(partial.db.calls.find(c => c.action === "stage_credential").provider_scope_profile, "legacy");
  for (const [scope, choice] of [[NORMAL + " https://www.googleapis.com/auth/drive", {}], [NORMAL, { normal_use: false }], ["openid", {}]]) {
    const f = await fixture({ drive: { scope } });
    const flow = await f.run(choice);
    assert.equal(await reasonOf(flow.complete()), "scope_mismatch", scope);
    assert.equal(f.db.calls.some(c => c.action === "stage_credential"), false);
    assert.equal(f.db.attempts.get(flow.begun.onboard_attempt_id).failure, "scope_mismatch");
  }
  const rejected = await fixture({ drive: { tokenFailure: true } });
  assert.equal(await reasonOf((await rejected.run()).complete()), "token_exchange_unconfirmed");
});

test("the OAuth callback dispatches a claimed onboard attempt to the onboard hook and maps its replay", async () => {
  const f = await fixture();
  const flow = await f.run();
  const state = new URL(flow.begun.authorization_url).searchParams.get("state");
  let claims = 0, completed;
  const oauth = await createStorageGoogleOAuth({ client_id: CLIENT, client_secret: "fixture-only-client-secret", redirect_uri: REDIRECT, vault: vaultConfig,
    onboard: f.onboard, fetch: f.google.fetch,
    rpc: async input => {
      assert.equal(input.action, "claim"); assert.equal(input.state_hash, flow.stored.state_hash);
      if (claims++ === 0) return await f.claim(flow.begun);
      return { ...completed, status: "completed", purpose: "onboard" };
    } });
  completed = await oauth.complete({ state, code: "fixture-code" });
  assert.equal(completed.status, "completed"); assert.equal(completed.purpose, "onboard"); assert.equal(completed.connection_id, flow.stored.connection_id);
  assert.equal(completed.normal_use_enabled, true); assert.equal(completed.provider_scope_profile, "normal");
  const replay = await oauth.complete({ state, code: "fixture-code" });
  assert.deepEqual(replay, completed, "a replayed callback returns the committed result and exchanges nothing");
  assert.equal(f.google.calls.filter(c => c.url.pathname === "/token").length, 1);
  // Without the onboard runtime (flag off) an onboard callback is refused.
  const off = await createStorageGoogleOAuth({ client_id: CLIENT, client_secret: "fixture-only-client-secret", redirect_uri: REDIRECT, vault: vaultConfig,
    rpc: async () => ({ ...(await f.claim(flow.begun)) }) });
  assert.equal(await reasonOf(off.complete({ state, code: "fixture-code" })), "attempt_unavailable");
  // An onboard failure keeps its own page reason and attempt through the callback.
  const g = await fixture({ drive: { files: [pickedFolder({ driveId: "x" })] } });
  const shared = await g.run(pick);
  const viaCallback = await createStorageGoogleOAuth({ client_id: CLIENT, client_secret: "fixture-only-client-secret", redirect_uri: REDIRECT, vault: vaultConfig,
    onboard: g.onboard, rpc: async () => await g.claim(shared.begun) });
  const error = await viaCallback.complete({ state: new URL(shared.begun.authorization_url).searchParams.get("state"), code: "fixture-code" }).catch(e => e);
  assert.equal(error.reason, "root_shared_drive"); assert.equal(error.onboard_attempt_id, shared.begun.onboard_attempt_id);
});

test("one run at a time: a resume while the callback run holds the lease is refused and creates nothing", async () => {
  let attempt, during;
  const f = await fixture({ drive: { beforeCreate: async body => {
    if (body.appProperties?.clued_onboard_role !== "root" || during) return;
    during = await reasonOf(f.onboard.resume(attempt));
  } } });
  const flow = await f.run();
  attempt = flow.begun.onboard_attempt_id;
  const done = await flow.complete();
  assert.equal(done.status, "completed");
  assert.equal(during, "onboard_run_active"); assert.ok(ONBOARD_PAGE_REASONS.includes("onboard_run_active"));
  assert.equal(f.google.creates().length, 4, "only the callback run created folders");
  assert.equal(f.db.calls.filter(c => c.action === "fail").length, 0, "a refused resume never fails the running attempt");
});

test("a superseded run records the folder it created as an orphan and never fails the run holding the lease", async () => {
  let taken = false;
  const f = await fixture({ db: { beforeResult: (input, a) => {
    if (input.role === "track:项目" && !taken) { taken = true; a.run_token = randomUUID(); }
  } } });
  const flow = await f.run();
  assert.equal(await reasonOf(flow.complete()), "onboard_run_superseded");
  const stored = f.db.attempts.get(flow.begun.onboard_attempt_id);
  const created = f.google.creates().map(c => JSON.parse(c.init.body).appProperties.clued_onboard_role);
  assert.deepEqual(created, ["root", "track:资料", "track:项目"]);
  assert.deepEqual(stored.strays, [{ role: "track:项目", provider_file_id: "created-3" }]);
  assert.equal(f.db.calls.some(c => c.action === "fail"), false);
  assert.equal(stored.state, "credential_staged");
});

test("an ambiguous result for a created folder keeps that folder as an orphan", async () => {
  const f = await fixture({ db: { ambiguous: input => input.role === "track:资料" } });
  const flow = await f.run();
  assert.equal(await reasonOf(flow.complete()), "onboard_effect_ambiguous");
  const stored = f.db.attempts.get(flow.begun.onboard_attempt_id);
  const stray = f.db.calls.find(c => c.action === "effect_stray");
  assert.deepEqual({ role: stray.role, id: stray.provider_file_id, token: "run_token" in stray }, { role: "track:资料", id: "created-2", token: false });
  assert.deepEqual(stored.orphans.map(o => [o.role, o.provider_file_id]), [["root", "created-1"], ["track:资料", "created-2"]]);
  assert.equal(stored.failure, "onboard_effect_ambiguous");
  // A create response that is not a valid folder but carries an ID is a stray too.
  const g = await fixture();
  const original = g.google.fetch;
  const bad = await createStorageGoogleOnboard({ client_id: CLIENT, client_secret: "fixture-only-client-secret", redirect_uri: REDIRECT, vault: vaultConfig,
    rpc: g.db.rpc, picker_configured: true, refresh_available: true,
    fetch: async (url, init = {}) => {
      const response = await original(url, init);
      if (init.method === "POST") { const file = await response.json(); return Response.json({ ...file, parents: [] }); }
      return response;
    } });
  const begun = await bad.begin(OWNER, { root: { mode: "new", name: "Clued_资料中心" }, tracks: ["资料"], normal_use: true, default_refresh: true,
    disclosure_version: ONBOARD_DISCLOSURE_VERSION });
  const reason = await reasonOf(bad.complete(await g.claim(begun), "fixture-code", g.db.attempts.get(begun.onboard_attempt_id).state_hash));
  assert.equal(reason, "onboard_effect_unconfirmed");
  assert.deepEqual(g.db.attempts.get(begun.onboard_attempt_id).strays, [{ role: "root", provider_file_id: "created-1" }]);
});

test("storage step 2: each folder's access digest comes from the same read as its version", async () => {
  const { googleDriveAccessDigest } = await import("../../../kernel/host/resource-center-google-drive-sharing.mjs");
  const permissions = [{ id: "owner-permission", type: "user", role: "owner" }];
  const f = await fixture({ drive: { permissions } });
  await (await f.run()).complete();
  const results = f.db.calls.filter(c => c.action === "effect_result");
  assert.equal(results.length, 4);
  for (const result of results) assert.equal(result.access_digest, googleDriveAccessDigest({ permissions }), result.role);
  for (const call of f.google.creates()) assert.match(call.url.searchParams.get("fields"), /,version,permissions\(id,type,role,domain,allowFileDiscovery,expirationTime,deleted\)$/);
  // Without a usable permission list (Drive omits it) the digest is null.
  const bare = await fixture();
  await (await bare.run()).complete();
  assert.ok(bare.db.calls.filter(c => c.action === "effect_result").every(c => c.access_digest === null));
  // A picked root reports its own.
  const picked = await fixture({ drive: { files: [pickedFolder({ permissions })] } });
  await (await picked.run(pick)).complete();
  const root = picked.db.calls.find(c => c.action === "effect_result" && c.role === "root");
  assert.equal(root.access_digest, googleDriveAccessDigest({ permissions }));
  assert.match(picked.google.calls.find(c => c.url.pathname === "/drive/v3/files/picked").url.searchParams.get("fields"), /,version,permissions\(/);
});
