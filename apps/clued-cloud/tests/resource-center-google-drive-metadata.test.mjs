import assert from "node:assert/strict";
import test from "node:test";

import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";

const getCredential = async () => ({
  access_token: "read-only-metadata-token",
  scope: "https://www.googleapis.com/auth/drive.metadata.readonly",
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
