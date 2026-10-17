import assert from "node:assert/strict";
import test from "node:test";

import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";

const getCredential = async () => ({
  access_token: "read-only-metadata-token",
  scope: "https://www.googleapis.com/auth/drive.metadata.readonly",
});

test('registration permission reads paginate the actual GET endpoint with published permissions and no write capability', async () => {
  const calls = [], owner = { id: 'owner', type: 'user', role: 'owner' }, reader = { id: 'reader', type: 'user', role: 'reader' };
  const api = createGoogleDriveMetadataApi({ registration_details: true, get_credential: getCredential,
    fetch: async (input, init) => {
      const url = new URL(input); calls.push({ url, init });
      return Response.json(url.searchParams.has('pageToken') ? { permissions: [reader] } : { permissions: [owner], nextPageToken: 'next' });
    } });
  assert.deepEqual(await api.listPermissions('trashed-folder'), [owner, reader]);
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(url.pathname, '/drive/v3/files/trashed-folder/permissions');
    assert.equal(url.searchParams.get('includePermissionsForView'), 'published');
    assert.equal(url.searchParams.has('useDomainAdminAccess'), false);
    assert.ok(url.searchParams.get('fields').includes('pendingOwner,view'));
    assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.redirect, 'error');
  }
  assert.equal(calls[1].url.searchParams.get('pageToken'), 'next');
});

test('permission pagination never accepts incomplete, malformed, duplicate or looping responses', async () => {
  for (const body of [{}, { permissions: null }, { permissions: [], nextPageToken: '' }, { permissions: [], nextPageToken: false },
    { permissions: [null] }, { permissions: [{ id: 'owner' }, { id: 'owner' }] },
    { permissions: [], nextPageToken: 'repeated' }]) {
    const api = createGoogleDriveMetadataApi({ registration_details: true, get_credential: getCredential, fetch: async () => Response.json(body) });
    await assert.rejects(api.listPermissions('folder'), /DRIVE_PERMISSIONS_INVALID/);
  }
  let calls = 0;
  const lower = createGoogleDriveMetadataApi({ registration_details: true,
    get_credential: async () => ({ access_token: 'file-scoped-test-token', scope: 'https://www.googleapis.com/auth/drive.file' }),
    fetch: async () => { calls++; return Response.json({ permissions: [] }); } });
  await assert.rejects(lower.listPermissions('folder'), /DRIVE_NAMESPACE_VISIBILITY_UNPROVEN/); assert.equal(calls, 0);
  await assert.rejects(createGoogleDriveMetadataApi({ get_credential: getCredential }).listPermissions('folder'), /Registration permission read/);
});

test("exact-ID missing target requires opt-in and never hides authorization or transient failures", async () => {
  for (const status of [404, 403, 401, 500]) {
    const api = createGoogleDriveMetadataApi({ get_credential: getCredential,
      fetch: async () => new Response(null, { status }) });
    await assert.rejects(api.getFile("known-file"), /DRIVE_METADATA_UNAVAILABLE/);
    if (status === 404) assert.equal(await api.getFile("known-file", { allow_missing: true }), null);
    else await assert.rejects(api.getFile("known-file", { allow_missing: true }), /DRIVE_METADATA_UNAVAILABLE/);
    await assert.rejects(api.listChildren({ parent_id: "parent", name: "a.md" }), /DRIVE_METADATA_UNAVAILABLE/);
  }
});

test("semantic reads explicitly request private marker and explicit trash without changing legacy reads", async () => {
  for (const enabled of [false, true]) {
    let fields;
    const api = createGoogleDriveMetadataApi({ get_credential: getCredential, semantic_details: enabled,
      fetch: async url => { fields = new URL(url).searchParams.get("fields"); return Response.json({ id: "known-file" }); } });
    await api.getFile("known-file");
    assert.equal(fields.includes("explicitlyTrashed"), enabled);
    assert.equal(fields.includes("appProperties"), enabled);
  }
  assert.throws(() => createGoogleDriveMetadataApi({ get_credential: getCredential, semantic_details: "true" }), /semantic_details/);
});

test("registration observation requests listing/share capabilities and full ACL without inferring access", async () => {
  const legacy = "id,name,mimeType,parents,version,trashed,size,sha256Checksum,md5Checksum,headRevisionId";
  for (const authorization of [false, true]) {
    let fields;
    const response = { id: "known-folder", ownedByMe: false, capabilities: { canListChildren: false, canShare: false }, permissions: [] };
    const api = createGoogleDriveMetadataApi({ get_credential: getCredential, registration_details: true,
      authorization_details: authorization, fetch: async url => {
        fields = new URL(url).searchParams.get("fields"); return Response.json(response);
      } });
    assert.deepEqual(await api.getFile("known-folder"), response, "false or absent capabilities stay facts for the verifier to reject");
    assert.ok(fields.startsWith(legacy));
    for (const field of ["shared", "permissionIds", "ownedByMe", "driveId", "inheritedPermissionsDisabled", "canListChildren", "canShare",
      "explicitlyTrashed", "appProperties", "permissions(id,type,role,domain,allowFileDiscovery,expirationTime,deleted,pendingOwner,view)"])
      assert.ok(fields.includes(field), field);
    assert.equal((fields.match(/capabilities\(/g) ?? []).length, 1);
    assert.equal(fields.includes("canAddChildren"), authorization);
  }
  let defaultFields;
  await createGoogleDriveMetadataApi({ get_credential: getCredential, fetch: async url => {
    defaultFields = new URL(url).searchParams.get("fields"); return Response.json({ id: "known-file" });
  } }).getFile("known-file");
  assert.equal(defaultFields, legacy, "existing metadata callers keep their exact projection");
  assert.throws(() => createGoogleDriveMetadataApi({ get_credential: getCredential, registration_details: "true" }), /registration_details/);
});

test("drive.file and unknown grants never treat an empty search as absence", async () => {
  for (const scope of [undefined, "", "https://www.googleapis.com/auth/drive.file",
    "drive.metadata.readonly", "https://www.googleapis.com/auth/drive.metadata.readonly.evil"]) {
    let requests = 0;
    const api = createGoogleDriveMetadataApi({
      get_credential: async () => ({ access_token: "file-scoped-test-token", scope }),
      fetch: async () => { requests += 1; return Response.json({ files: [], incompleteSearch: false }); },
    });
    await assert.rejects(api.listChildren({ parent_id: "parent", name: "hidden.txt",
      scope: "https://www.googleapis.com/auth/drive.metadata.readonly" }), /DRIVE_NAMESPACE_VISIBILITY_UNPROVEN/);
    assert.equal(requests, 0);
  }
});

test("legacy token-only access allows exact-ID diagnostics but not namespace proof", async () => {
  let requests = 0;
  const api = createGoogleDriveMetadataApi({
    get_access_token: async () => "file-scoped-test-token",
    fetch: async () => { requests += 1; return Response.json({ id: "known-file" }); },
  });
  assert.equal((await api.getFile("known-file")).id, "known-file");
  await assert.rejects(api.listChildren({ parent_id: "parent", name: "a.md" }), /DRIVE_NAMESPACE_VISIBILITY_UNPROVEN/);
  assert.equal(requests, 1);
  assert.throws(() => createGoogleDriveMetadataApi({
    get_access_token: async () => "file-scoped-test-token", get_credential: getCredential,
  }), /Host-owned Drive credential/);
});

test("namespace lookup pins token through pagination and rechecks a reduced grant next time", async () => {
  let credentials = 0;
  let requests = 0;
  const api = createGoogleDriveMetadataApi({
    get_credential: async () => ({ access_token: "pinned-metadata-token",
      scope: ++credentials === 1 ? "https://www.googleapis.com/auth/drive.metadata.readonly"
        : "https://www.googleapis.com/auth/drive.file" }),
    fetch: async (_url, options) => {
      assert.equal(options.headers.authorization, "Bearer pinned-metadata-token");
      return Response.json(++requests === 1 ? { files: [], nextPageToken: "last" } : { files: [] });
    },
  });
  assert.deepEqual(await api.listChildren({ parent_id: "parent", name: "a.md" }), []);
  assert.equal(credentials, 1);
  assert.equal(requests, 2);
  await assert.rejects(api.listChildren({ parent_id: "parent", name: "a.md" }), /DRIVE_NAMESPACE_VISIBILITY_UNPROVEN/);
  assert.equal(requests, 2);
});

test("Drive authentication and malformed credential errors fail before absence claims", async () => {
  const denied = createGoogleDriveMetadataApi({ get_credential: getCredential,
    fetch: async () => new Response(null, { status: 403 }) });
  await assert.rejects(denied.listChildren({ parent_id: "parent", name: "a.md" }), /DRIVE_METADATA_UNAVAILABLE/);
  let requests = 0;
  const missing = createGoogleDriveMetadataApi({ get_credential: async () => null,
    fetch: async () => { requests += 1; } });
  await assert.rejects(missing.listChildren({ parent_id: "parent", name: "a.md" }), /DRIVE_CREDENTIAL_UNAVAILABLE/);
  assert.equal(requests, 0);
});

test("Drive metadata failures expose fixed categories without provider details", async () => {
  const cases = [
    { code: "DRIVE_METADATA_REQUEST_FAILED", fetch: async () => { throw new Error("private provider response"); } },
    { code: "DRIVE_METADATA_TIMEOUT", fetch: async () => { throw Object.assign(new Error("private timeout"), { name: "TimeoutError" }); } },
    { code: "DRIVE_METADATA_TIMEOUT", fetch: async () => ({ ok: true, json: async () => { throw Object.assign(new Error("private timeout"), { name: "TimeoutError" }); } }) },
    { code: "DRIVE_METADATA_RESPONSE_INVALID", fetch: async () => ({ ok: true, json: async () => { throw new Error("private response"); } }) },
    { code: "DRIVE_METADATA_SUBREQUEST_LIMIT", fetch: async () => { throw new Error("Too many subrequests."); } },
    { code: "DRIVE_METADATA_SUBREQUEST_LIMIT", fetch: async () => { throw new Error("Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits"); } },
    { code: "DRIVE_METADATA_REQUEST_FAILED", fetch: async () => { throw new Error("Too many subrequests from private provider"); } },
  ];
  for (const { code, fetch } of cases) {
    const api = createGoogleDriveMetadataApi({ get_credential: getCredential, fetch });
    await assert.rejects(api.getFile("known-file"), (error) => error.message === code);
  }
  const controller = new AbortController();
  const aborted = createGoogleDriveMetadataApi({ get_credential: getCredential, fetch: async () => {
    controller.abort();
    throw Object.assign(new Error("private abort"), { name: "AbortError" });
  } });
  await assert.rejects(aborted.getFile("known-file", { signal: controller.signal }), (error) => error.message === "DRIVE_METADATA_ABORTED");
});

test("Drive metadata lookup uses only a Host credential and checks every page", async () => {
  const urls = [];
  const api = createGoogleDriveMetadataApi({
    get_credential: getCredential,
    fetch: async (url, options) => {
      urls.push(new URL(url));
      assert.equal(options.headers.authorization, "Bearer read-only-metadata-token");
      assert.equal(options.redirect, "error");
      return { ok: true, json: async () => urls.length === 1
        ? { files: [], nextPageToken: "page-2" }
        : { files: [{ id: "child", name: "a.md", parents: ["parent"],
          version: "1", mimeType: "text/markdown", trashed: false }] } };
    },
  });
  const result = await api.listChildren({ parent_id: "parent", name: "a.md" });
  assert.equal(result[0].id, "child");
  assert.equal(urls.length, 2);
  assert.equal(urls[1].searchParams.get("pageToken"), "page-2");
  assert.match(urls[0].searchParams.get("fields"), /incompleteSearch/);
  assert.match(urls[0].searchParams.get("q"), /'parent' in parents and name = 'a.md'/);
});

test("Drive metadata search escapes quotes and rejects incomplete/looped results", async () => {
  const urls = [];
  const api = createGoogleDriveMetadataApi({
    get_credential: getCredential,
    fetch: async (url) => {
      urls.push(new URL(url));
      return { ok: true, json: async () => ({ files: [], nextPageToken: "same" }) };
    },
  });
  await assert.rejects(api.listChildren({ parent_id: "parent", name: "a'b" }), /DRIVE_PAGINATION_INVALID/);
  assert.match(urls[0].searchParams.get("q"), /name = 'a\\'b'/);

  const incomplete = createGoogleDriveMetadataApi({
    get_credential: getCredential,
    fetch: async () => ({ ok: true, json: async () => ({ files: [], incompleteSearch: true }) }),
  });
  await assert.rejects(incomplete.listChildren({ parent_id: "parent", name: "a.md" }), /DRIVE_LIST_INVALID/);
});

test("transient reads are retried only when asked, with capped backoff (Task ce5c725e)", async () => {
  const replies = (statuses) => {
    const calls = [];
    return { calls, fetch: async () => {
      const next = statuses[calls.length] ?? 200; calls.push(next);
      if (next === "timeout") { const error = new Error("t"); error.name = "TimeoutError"; throw error; }
      if (next === "reset") throw new TypeError("network reset");
      if (next === 200) return Response.json({ id: "known-file" });
      if (next === "403-rate") return Response.json({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, { status: 403 });
      return Response.json({ error: { errors: [{ reason: "forbidden" }] } }, { status: next });
    } };
  };
  const waits = [];
  const options = { get_credential: getCredential, sleep: async (ms) => { waits.push(ms); }, random: () => 0.5 };

  // Off by default: one request, the same error as before.
  const off = replies([503]);
  await assert.rejects(createGoogleDriveMetadataApi({ ...options, fetch: off.fetch }).getFile("known-file"), /^Error: DRIVE_METADATA_UNAVAILABLE$/);
  assert.equal(off.calls.length, 1); assert.deepEqual(waits, []);

  // 429, 5xx, a rate-limit 403, a timeout and a transport failure are retried.
  for (const first of [429, 500, 503, "403-rate", "timeout", "reset"]) {
    waits.length = 0;
    const on = replies([first, 200]);
    assert.equal((await createGoogleDriveMetadataApi({ ...options, fetch: on.fetch, transient_retries: 2 }).getFile("known-file")).id, "known-file");
    assert.equal(on.calls.length, 2, String(first)); assert.deepEqual(waits, [1500]);
  }

  // At most transient_retries retries, doubling waits; then the original error.
  waits.length = 0;
  const exhausted = replies([503, 503, 503, 200]);
  await assert.rejects(createGoogleDriveMetadataApi({ ...options, fetch: exhausted.fetch, transient_retries: 2 }).getFile("known-file"),
    /^Error: DRIVE_METADATA_UNAVAILABLE$/);
  assert.equal(exhausted.calls.length, 3); assert.deepEqual(waits, [1500, 2500]);

  // A permission 403, a 404 and a 400 are answers, never retried.
  for (const status of [403, 404, 400]) {
    waits.length = 0;
    const final = replies([status, 200]);
    await assert.rejects(createGoogleDriveMetadataApi({ ...options, fetch: final.fetch, transient_retries: 2 }).getFile("known-file"), /DRIVE_METADATA_UNAVAILABLE/);
    assert.equal(final.calls.length, 1, String(status)); assert.deepEqual(waits, []);
  }

  // The caller's abort stops retrying at once.
  const controller = new AbortController();
  const aborted = replies([503, 200]);
  const api = createGoogleDriveMetadataApi({ get_credential: getCredential, fetch: aborted.fetch, transient_retries: 2,
    sleep: async () => { controller.abort(); }, random: () => 0 });
  await assert.rejects(api.getFile("known-file", { signal: controller.signal }), /AbortError|DRIVE_METADATA_ABORTED|aborted/);
  assert.equal(aborted.calls.length, 1);

  for (const bad of [-1, 4, 1.5, "2"]) {
    assert.throws(() => createGoogleDriveMetadataApi({ get_credential: getCredential, transient_retries: bad }), /transient_retries/);
  }
});

test("storage step 2: getVersionedAccess reads version and permissions in one request", async () => {
  const urls = [];
  const permissions = [{ id: "owner", type: "user", role: "owner" }];
  const api = createGoogleDriveMetadataApi({ get_credential: getCredential, fetch: async (url) => {
    urls.push(new URL(url)); return Response.json({ id: "folder", version: "12", permissions, name: "ignored" }); } });
  assert.deepEqual(await api.getVersionedAccess("folder"), { id: "folder", version: "12", permissions });
  assert.equal(urls.length, 1);
  assert.equal(urls[0].searchParams.get("fields"),
    "id,version,permissions(id,type,role,domain,allowFileDiscovery,expirationTime,deleted)");
  const other = createGoogleDriveMetadataApi({ get_credential: getCredential,
    fetch: async () => Response.json({ id: "another", version: "12", permissions }) });
  await assert.rejects(other.getVersionedAccess("folder"), /DRIVE_METADATA_MISMATCH/);
  await assert.rejects(api.getVersionedAccess("bad id"), TypeError);
});
