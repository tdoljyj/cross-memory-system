import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fixture, ids, root } from "./resource-center-cloud-executor.fixture.mjs";
import { createResourceCenterCloudExecutor } from "../../../kernel/host/resource-center-cloud-executor.mjs";
import { createResourceCenterHostAdapter } from "../../../kernel/host/resource-center-mutation-host.mjs";
import { scopeString } from "../../../kernel/host/resource-center-google-scopes.mjs";

const NAV = "00_从这里开始";
const NAME = "Clued_资料中心使用前必读.md";
const ENTRY = `${root}/${NAV}/${NAME}`;
const FOLDER = "application/vnd.google-apps.folder";
const OLD = "# Navigation\n\nPrevious naming standard.\n";
const NEXT = "# Navigation\n\nCurrent reviewed naming standard.\n";
const sha = text => createHash("sha256").update(text).digest("hex");
const md5 = text => createHash("md5").update(text).digest("hex");
const artifact = "70000000-0000-4000-8000-000000000001";
const authority = () => ({ artifact_id: null, artifact_role: "clued_resource", governance_class: "ordinary",
  delete_authority: false, authority_version: "parent/1", currentness_identity: "decision/1", workspace_version: "workspace/1" });
const profile = tracks => ({ registration_status: "registered", profile_id: ids.profile, profile_version: "test/1",
  managed_root: root, allowed_root_children: tracks });
const adopt = (path = ENTRY) => ({ operation: "adopt", target_kind: "file", source_path: path, source_file_id: "nav-file" });
const replace = (path = ENTRY, version = "19") => ({ operation: "replace", target_kind: "file", destination_path: path,
  destination_file_version: version, content: NEXT });

// Real cloud executor, identity traversal, admission, native adopt/replace effects,
// and provider proof verifiers against synthetic Drive metadata. The RPC journal
// and registration below are an explicit in-memory double, not SQL/live acceptance.
function navigationCloud({ registered = false, credentialScope = "full", onAuthority, denyAuthority, beforeAttempt } = {}) {
  const base = fixture({ credential: { scope: scopeString(credentialScope) } });
  const files = base.files, trace = [], writes = [], attempts = [], proofs = [];
  for (const file of files.values()) Object.assign(file, { shared: false, permissionIds: ["owner"], ownedByMe: true });
  files.set("nav-parent", { id: "nav-parent", name: NAV, parents: ["root"], version: "7", trashed: false,
    mimeType: FOLDER, shared: false, permissionIds: ["owner"], ownedByMe: true });
  files.set("nav-file", { id: "nav-file", name: NAME, parents: ["nav-parent"], version: "19", trashed: false,
    mimeType: "text/markdown", size: String(Buffer.byteLength(OLD)), sha256Checksum: sha(OLD), md5Checksum: md5(OLD),
    headRevisionId: "head-19", ownedByMe: true, shared: false, permissionIds: ["owner"] });
  const revisions = new Map([["head-19", { id: "head-19", keepForever: false,
    size: String(Buffer.byteLength(OLD)), md5Checksum: md5(OLD) }]]);
  const registry = { registered, version: registered ? 1 : 0, providerVersion: registered ? "19" : null };
  let status = "queued", job = 0, reference = base.reference, activeMutation, prepare, proof, lookups = 0, starts = 0;
  const originalFetch = base.config.drive_fetch;
  const config = { ...base.config, verified_result_mode: true,
    load_job: async ref => {
      const descriptor = await base.config.load_job(ref);
      return { ...descriptor, job_id: ref.job_id, status, mutation: activeMutation,
        ...(activeMutation.operation === "replace" ? { revision_releases: registry.registered ? [] : null } : {}) };
    },
    rpc: async input => {
      trace.push(input.action);
      assert.equal(input.connection_id, ids.connection);
      assert.equal(input.job_id, reference.job_id);
      if (input.action === "authority") {
        lookups++;
        if (denyAuthority?.(lookups)) return { status: "denied", reason: "artifact_decision_not_current" };
        const current = { ...authority(), ...(registry.registered ? { artifact_id: artifact,
          authority_version: `artifact/${registry.version}` } : {}) };
        onAuthority?.({ count: lookups, authority: current, request: input.request, files, registry });
        return { status: "resolved", request: input.request, authority: current };
      }
      if (input.action === "begin") {
        assert.equal(status, "queued");
        assert.equal(input.prepare.authority_request.provider_identity.root_folder_id, "root");
        starts++; status = "started"; prepare = input.prepare;
        return { status: "committed", state: "started", execution_permitted: true, version: 2, intent_id: ids.intent,
          job_id: reference.job_id, job_request_digest: "a".repeat(64), request_sha256: prepare.request_sha256 };
      }
      if (input.action === "provider_attempt") {
        assert.equal(status, "started");
        assert.equal(writes.length, 0, "attempt must be durable before any provider write");
        assert.equal(input.attempt.parent_id, "nav-parent");
        assert.equal(input.attempt.provider_file_id, "nav-file");
        attempts.push(input.attempt); beforeAttempt?.({ files });
        return { status: "committed", attempt_recorded: true, receipt_id: ids.receipt, attempt: input.attempt };
      }
      if (input.action === "verified_record") {
        assert.equal(status, "started");
        assert.equal(input.proof.provider_file_id, "nav-file");
        assert.equal(input.proof.parent_id, "nav-parent");
        assert.equal(input.proof.path, ENTRY);
        assert.equal(input.proof.checks.identity, true);
        assert.equal(input.proof.checks.ancestors, true);
        assert.equal(input.proof.checks.stable_state, true);
        proof = input.proof; proofs.push(proof);
        return { status: "verified", intent_id: ids.intent, verified_receipt_id: ids.receipt,
          verified_digest: "b".repeat(64), version: 3, execution_permitted: false };
      }
      assert.equal(input.action, "settle_verified");
      assert.ok(proof);
      registry.registered = true; registry.version++; registry.providerVersion = proof.provider_file_version;
      status = "committed";
      return { status: "committed", state: "committed", intent_id: ids.intent,
        request_sha256: prepare.request_sha256, final_result: { status: "committed" }, receipt_id: ids.receipt };
    },
    drive_fetch: async (url, init) => {
      const u = new URL(url), revision = /\/files\/nav-file\/revisions(?:\/([^/?]+))?$/.exec(u.pathname);
      if (init.method === "PATCH") {
        assert.equal(status, "started");
        assert.equal(attempts.length, 1);
        if (revision?.[1]) {
          const item = revisions.get(revision[1]); assert.ok(item);
          Object.assign(item, JSON.parse(init.body)); writes.push("keep-previous-revision");
          return Response.json(item);
        }
        assert.equal(u.pathname, "/upload/drive/v3/files/nav-file");
        assert.equal(u.searchParams.get("uploadType"), "media");
        assert.equal(init.headers["content-type"], "text/markdown");
        assert.equal(Buffer.from(init.body).toString("utf8"), NEXT);
        const file = files.get("nav-file");
        Object.assign(file, { version: "20", headRevisionId: "head-20", size: String(Buffer.byteLength(NEXT)),
          sha256Checksum: sha(NEXT), md5Checksum: md5(NEXT) });
        revisions.set("head-20", { id: "head-20", keepForever: false, size: file.size, md5Checksum: file.md5Checksum });
        writes.push("replace-content");
        return Response.json(file);
      }
      assert.equal(init.method, "GET", "no create/move/delete provider write is allowed in this fixture");
      if (revision) return Response.json(revision[1] ? revisions.get(revision[1]) : { revisions: [...revisions.values()] });
      return originalFetch(url, init);
    },
  };
  return { files, registry, revisions, trace, writes, attempts, proofs,
    info: () => ({ status, lookups, starts }),
    run: async mutation => {
      activeMutation = mutation; status = "queued"; lookups = 0; prepare = null; proof = null; job++;
      // Every run is a new synthetic service job; all source/target IDs remain unchanged.
      reference = { ...base.reference, job_id: `10000000-0000-4000-8000-${String(job).padStart(12, "0")}` };
      attempts.length = 0; writes.length = 0;
      return createResourceCenterCloudExecutor(config).run(reference);
    } };
}

test("navigation entry: cloud adopt registers without a Drive write, then replace keeps the same object and old revision", async () => {
  const f = navigationCloud(), before = structuredClone(f.files.get("nav-file"));
  const adopted = await f.run(adopt());
  assert.equal(adopted.status, "committed");
  assert.equal(f.info().starts, 1);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.files.get("nav-file"), before);
  assert.equal(f.attempts[0].contract, "clued.storage-adopt-attempt/1");
  assert.equal(f.proofs[0].contract, "clued.storage-adopt-verified/1");
  assert.deepEqual(f.registry, { registered: true, version: 1, providerVersion: "19" });
  const replaced = await f.run(replace());
  assert.equal(replaced.status, "committed");
  assert.deepEqual(f.writes, ["keep-previous-revision", "replace-content"]);
  assert.equal(f.info().starts, 2);
  const after = f.files.get("nav-file");
  assert.equal(after.id, before.id); assert.equal(after.name, before.name);
  assert.deepEqual(after.parents, before.parents);
  assert.equal(after.version, "20"); assert.equal(after.sha256Checksum, sha(NEXT));
  assert.equal(f.revisions.get("head-19").keepForever, true);
  assert.equal(f.revisions.get("head-19").md5Checksum, md5(OLD));
  assert.equal(f.proofs[1].contract, "clued.storage-replace-verified/1");
  assert.equal(f.proofs[1].checks.previous_revision_kept, true);
  assert.deepEqual(f.registry, { registered: true, version: 2, providerVersion: "20" });
});

test("navigation entry: replace still requires prior registration", async () => {
  const f = navigationCloud(), result = await f.run(replace());
  assert.equal(result.error_code, "CLOUD_REPLACE_TARGET_UNREGISTERED");
  assert.equal(f.info().starts, 0); assert.deepEqual(f.attempts, []); assert.deepEqual(f.writes, []);
});

test("navigation entry: adopt still requires the full provider grant and the exact Drive file ID", async () => {
  for (const [label, fixtureOptions, mutation, expected] of [
    ["no full scope", { credentialScope: "normal" }, adopt(), "ADOPT_SCOPE_UPGRADE_REQUIRED"],
    ["wrong source ID", {}, { ...adopt(), source_file_id: "another-file" }, "ARTIFACT_AUTHORITY_RESOLUTION_FAILED"],
  ]) {
    const f = navigationCloud(fixtureOptions), result = await f.run(mutation);
    assert.equal(result.error_code, expected, label);
    assert.equal(f.info().starts, 0, label); assert.deepEqual(f.attempts, [], label); assert.deepEqual(f.writes, [], label);
  }
});

test("navigation entry: stale observed replace version is refused before durable start or provider writes", async () => {
  const f = navigationCloud({ registered: true }), result = await f.run(replace(ENTRY, "18"));
  assert.equal(result.error_code, "ARTIFACT_AUTHORITY_RESOLUTION_FAILED");
  assert.equal(f.info().starts, 0); assert.deepEqual(f.attempts, []); assert.deepEqual(f.writes, []);
  assert.equal(f.files.get("nav-file").version, "19");
});

test("navigation entry: an online authority denial still stops the exact allowed path", async () => {
  for (const count of [1, 2, 3]) {
    const f = navigationCloud({ denyAuthority: n => n === count }), result = await f.run(adopt());
    assert.notEqual(result.status, "committed", `authority lookup ${count}`);
    assert.deepEqual(f.attempts, []); assert.deepEqual(f.writes, []);
    assert.equal(f.registry.registered, false);
    assert.equal(f.info().starts, count === 3 ? 1 : 0);
  }
});

test("navigation entry: authority changed after preflight cannot reuse the original admission", async () => {
  const f = navigationCloud({ onAuthority: ({ count, authority: current }) => {
    if (count >= 2) current.authority_version = "parent/2";
  } }), result = await f.run(adopt());
  assert.equal(result.error_code, "ADMISSION_BINDING_MISMATCH");
  assert.equal(f.info().starts, 1);
  assert.deepEqual(f.attempts, []); assert.deepEqual(f.writes, []);
  assert.equal(f.registry.registered, false);
});

test("navigation entry: changed source identity after initial authority is refused with zero provider writes", async () => {
  const f = navigationCloud({ onAuthority: ({ count, files }) => {
    if (count === 1) {
      const original = files.get("nav-file"); files.delete("nav-file");
      files.set("impostor", { ...original, id: "impostor" });
    }
  } }), result = await f.run(adopt());
  assert.equal(result.error_code, "ARTIFACT_AUTHORITY_REVALIDATION_FAILED");
  assert.equal(f.info().starts, 0); assert.deepEqual(f.attempts, []); assert.deepEqual(f.writes, []);
});

test("navigation entry: a changed replace target after durable attempt is not overwritten", async () => {
  const f = navigationCloud({ registered: true, beforeAttempt: ({ files }) => { files.get("nav-file").version = "21"; } });
  const result = await f.run(replace());
  assert.notEqual(result.status, "committed");
  assert.equal(f.info().starts, 1); assert.equal(f.attempts.length, 1); assert.deepEqual(f.writes, []);
  assert.equal(f.files.get("nav-file").sha256Checksum, sha(OLD));
  assert.equal(f.revisions.get("head-19").keepForever, false);
});

test("navigation namespace: only the exact file's adopt/replace can reach an effect, even when a profile lists 00 as a track", async () => {
  for (const tracks of [["track"], ["track", NAV]]) {
    let effects = 0;
    const host = createResourceCenterHostAdapter({ trusted_profile: profile(tracks), resolve_artifact: authority,
      effect: async () => { effects++; return { done: true }; } });
    const requests = [];
    for (const path of [`${root}/${NAV}`, `${root}/${NAV}/other.md`, `${ENTRY}.bak`,
      `${root}/${NAV}/Clued_资料中心使用前必读_v2.md`, `${root}/${NAV}/nested/${NAME}`,
      `${root}/${NAV}/current/${NAME}`, `${root}/${NAV}/clued_资料中心使用前必读.md`]) {
      requests.push(adopt(path), replace(path));
    }
    requests.push({ ...adopt(), target_kind: "directory" }, { ...replace(), target_kind: "directory", directory_semantics: "topic" });
    for (const operation of ["create", "write"]) {
      requests.push({ operation, target_kind: "file", destination_path: ENTRY, content: NEXT });
      requests.push({ operation, target_kind: "directory", destination_path: `${root}/${NAV}/topic`, directory_semantics: "topic" });
    }
    for (const operation of ["delete", "restore"]) requests.push({ operation, target_kind: "file", source_path: ENTRY });
    requests.push({ operation: "restore", target_kind: "file", source_path: `${root}/track/old.md`,
      destination_path: ENTRY, restore_mode: "folder" });
    requests.push({ operation: "restore", target_kind: "file", source_path: ENTRY,
      destination_path: `${root}/track/restored.md`, restore_mode: "folder" });
    for (const operation of ["move", "rename"]) {
      requests.push({ operation, target_kind: "file", source_path: ENTRY, destination_path: `${root}/track/moved.md` });
      requests.push({ operation, target_kind: "file", source_path: `${root}/track/moved.md`, destination_path: ENTRY });
      requests.push({ operation, target_kind: "directory", source_path: `${root}/${NAV}`, destination_path: `${root}/track/topic`,
        ...(operation === "rename" ? { directory_semantics: "topic" } : {}) });
    }
    for (const request of requests) {
      const result = await host.guardedMutation({ ...request, artifact_role: "clued_resource" });
      assert.equal(result.error_code, "RESOURCE_CENTER_NAVIGATION_ENTRY_PROTECTED", JSON.stringify({ tracks, request }));
      assert.equal(effects, 0);
    }
    for (const request of [adopt(), replace()]) {
      const result = await host.guardedMutation({ ...request, artifact_role: "clued_resource" });
      assert.equal(result.status, "committed");
    }
    assert.equal(effects, 2);
  }
});

test("navigation exception grants no authority from caller fields or outside the registered root", async () => {
  let effects = 0;
  const host = createResourceCenterHostAdapter({ trusted_profile: profile(["track"]), resolve_artifact: authority,
    effect: async () => { effects++; return {}; } });
  for (const field of ["profile", "managed_root", "allowed_root_children", "artifact_id", "currentness_identity", "governance_class"]) {
    const result = await host.guardedMutation({ ...adopt(), artifact_role: "clued_resource", [field]: "caller-assertion" });
    assert.equal(result.error_code, "CALLER_AUTHORITY_FIELDS_FORBIDDEN");
  }
  const outside = await host.guardedMutation({ ...adopt(`G:/unregistered/${NAV}/${NAME}`), artifact_role: "clued_resource" });
  assert.equal(outside.error_code, "SIBLING_ISLAND_FORBIDDEN");
  const rootFile = await host.guardedMutation({ ...adopt(`${root}/${NAME}`), artifact_role: "clued_resource" });
  assert.equal(rootFile.error_code, "RESOURCE_CENTER_ROOT_CHILD_FORBIDDEN");
  assert.equal(effects, 0);
});
