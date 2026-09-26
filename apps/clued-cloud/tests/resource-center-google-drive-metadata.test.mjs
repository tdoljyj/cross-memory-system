import assert from "node:assert/strict";
import test from "node:test";

import { createGoogleDriveMetadataApi } from "../../../kernel/host/resource-center-google-drive-metadata.mjs";

test("Drive metadata lookup uses only a Host credential and checks every page", async () => {
  const urls = [];
  const api = createGoogleDriveMetadataApi({
    get_access_token: async () => "read-only-metadata-token",
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
  assert.match(urls[0].searchParams.get("q"), /'parent' in parents and name = 'a.md'/);
});

test("Drive metadata search escapes quotes and rejects incomplete/looped results", async () => {
  const urls = [];
  const api = createGoogleDriveMetadataApi({
    get_access_token: async () => "read-only-metadata-token",
    fetch: async (url) => {
      urls.push(new URL(url));
      return { ok: true, json: async () => ({ files: [], nextPageToken: "same" }) };
    },
  });
  await assert.rejects(api.listChildren({ parent_id: "parent", name: "a'b" }), /DRIVE_PAGINATION_INVALID/);
  assert.match(urls[0].searchParams.get("q"), /name = 'a\\'b'/);

  const incomplete = createGoogleDriveMetadataApi({
    get_access_token: async () => "read-only-metadata-token",
    fetch: async () => ({ ok: true, json: async () => ({ files: [], incompleteSearch: true }) }),
  });
  await assert.rejects(incomplete.listChildren({ parent_id: "parent", name: "a.md" }), /DRIVE_LIST_INVALID/);
});
