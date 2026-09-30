import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createResourceCenterGoogleDriveNativeWriterToolHost } from "../../../kernel/host/resource-center-online-tool-host.mjs";
import { RESOURCE_CENTER_MUTATION_TOOL as TOOL } from "../../../kernel/host/resource-center-governed-tool-surface.mjs";

test("prepare's third provider traversal cannot replace the admitted intermediate ancestor version", async () => {
  const root = "G:/review/Clued_资料中心";
  const profile = { registration_status: "registered", profile_id: "10000000-0000-4000-8000-000000000001",
    profile_version: "1", managed_root: root, allowed_root_children: ["track"] };
  const intent = "20000000-0000-4000-8000-000000000001";
  const authority = { artifact_id: null, artifact_role: "clued_resource", governance_class: "ordinary",
    delete_authority: false, authority_version: "authority/1", currentness_identity: "decision/1",
    workspace_version: "canonical-workspace/1" };
  const info = (id, name, parent, version = "1") => ({ id, name, parents: [parent], version,
    trashed: false, mimeType: "application/vnd.google-apps.folder" });
  let walks = 0, posts = 0, prepared;
  const host = createResourceCenterGoogleDriveNativeWriterToolHost({
    trusted_profile: profile, root_folder_id: "root", root_parent_id: "container",
    get_drive_credential: async () => ({ access_token: "synthetic-test-token", scope:
      "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly" }),
    authority_endpoint: "https://example.test/v1/resource-center/authority",
    authority_binding_token: "clued_rcb_" + "a".repeat(40),
    writer_endpoint: "https://example.test/v1/resource-center/write", writer_binding_token: "clued_rcw_" + "b".repeat(40),
    persist_recovery: async () => {}, persist_provider_attempt: async () => {},
    authority_fetch: async (url, options) => {
      const body = JSON.parse(options.body), r = body.request;
      if (url.endsWith("/authority")) return Response.json({ contract: r.contract, status: "resolved",
        request: r, request_sha256: body.request_sha256, authority });
      if (r.action === "prepare") {
        prepared = r;
        return Response.json({ ...body, outcome: { status: "committed", state: "prepared", intent_id: intent,
          version: 1, request_sha256: r.request_sha256 } });
      }
      assert.equal(r.action, "start");
      return Response.json({ ...body, outcome: { status: "committed", state: "started", execution_permitted: true,
        intent_id: intent, version: 2, request_sha256: r.request_sha256 } });
    },
    drive_fetch: async (url, options) => {
      const u = new URL(url);
      if (options.method === "POST") { posts++; throw new Error("storage POST forbidden"); }
      // Directory sharing reads are not provider traversals.
      if (u.searchParams.get("fields") === "id,shared,permissionIds") {
        return Response.json({ id: u.pathname.split("/").at(-1), shared: false, permissionIds: ["owner"] });
      }
      if (u.pathname.endsWith("/root")) { walks++; return Response.json(info("root", "Clued_资料中心", "container")); }
      const q = u.searchParams.get("q") ?? "";
      // Listed entries carry isAppAuthorized: the write path keeps only Clued's own entries.
      if (q.includes("'root' in parents")) return Response.json({ files: [{ ...info("track", "track", "root", walks >= 3 ? "2" : "1"), isAppAuthorized: true }] });
      if (q.includes("'track' in parents")) return Response.json({ files: [{ ...info("topic", "topic", "track"), isAppAuthorized: true }] });
      return Response.json({ files: [] });
    },
  });
  const request = { operation: "create", destination_path: root + "/track/topic/x.txt", target_kind: "file", content: "hi" };
  const result = await host.callTool(TOOL, request);
  const changedBinding = "provider+canonical:" + createHash("sha256").update(JSON.stringify([
    authority.workspace_version, prepared.authority_request.provider_identity])).digest("hex");
  assert.notEqual(prepared.exact_request.binding.workspace_version, changedBinding);
  assert.equal(result.error_code, "ADMISSION_BINDING_MISMATCH");
  assert.equal(posts, 0);
  assert.equal((await host.callTool(TOOL, request)).error_code, "POST_WRITE_RECONCILIATION_REQUIRED");
});
