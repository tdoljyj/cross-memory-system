#!/usr/bin/env node
// Owner Credential v0.1, rollout step 4 (development/contracts/
// owner-authorization/OwnerCredential.v0.1.md §6.1, Task 2a31ca2a).
//
// The first step of the deploy and migrate modes of
// clued-cloud-production-release.yml: before anything changes production,
// the run consumes one use of an Owner Grant for this exact commit
// (repo:<owner>/<name>/<40-hex sha>) and action (release.production for
// deploy, migration.production for migrate). For migrate the resources are
// the named migration files of that commit
// (repo:<owner>/<name>/<sha>/apps/clued-cloud/supabase/migrations/<file>), so
// the Owner approves which migrations run, not only the commit (re-review N6). It calls
// clued_owner_grant_door_consume_v1 on the Clued database's PostgREST
// endpoint with the public publishable key and the SHA-256 of the Binding
// token in CLUED_RELEASE_TOKEN (the clued-release environment), the same way
// the admission check calls verify. With no grant, Clued opens a pending
// request and the run prints its confirmation link; only the Owner approves.
//
// For migrate the call also names the deploy of the same commit (`with`), so
// when no grant admits the run, Clued opens one bundle and the Owner approves
// the migration and the deploy with one click (PermissionSimplification §3.3,
// Task 23045c17). A database without `with` refuses the input; the run then
// asks again without it.
//
// Enforcement is the Owner's switch, the repository variable
// CLUED_RELEASE_GRANT_ENFORCE=true (Owner choice 2026-10-03). Until it is on,
// the result is reported and the run continues. Once on, a missing grant, a
// missing token, a missing RPC or a transport error all stop the run.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePublicSupabaseConfig, sha256Hex } from "./clued-work-admission.mjs";

export const DOOR_RPC = "clued_owner_grant_door_consume_v1";
export const ACTIONS = { deploy: "release.production", migrate: "migration.production" };
const DEFAULT_ORIGIN = "https://kooyumi.pixelgrav.com";

export function grantEnforced(env) {
  return /^(1|true|on|enabled)$/i.test((env.CLUED_RELEASE_GRANT_ENFORCE ?? "").trim());
}

export const MIGRATIONS_DIR = "apps/clued-cloud/supabase/migrations";
const MIGRATION_NAME = /^[0-9]{14}_[a-z0-9_]+\.sql$/;

export function migrationResources(env) {
  const names = String(env.MIGRATIONS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  if (names.length === 0 || names.length > 50) throw new Error("MIGRATIONS must name 1 to 50 migration files.");
  for (const name of names) if (!MIGRATION_NAME.test(name)) throw new Error(`Not a migration file name: ${name}`);
  const commit = commitResource(env);
  return names.map((name) => `${commit}/${MIGRATIONS_DIR}/${name}`);
}

export function commitResource(env) {
  const repository = (env.GITHUB_REPOSITORY ?? "").trim();
  const sha = (env.GITHUB_SHA ?? "").trim().toLowerCase();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GITHUB_REPOSITORY is not owner/name.");
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("GITHUB_SHA is not a full commit SHA.");
  return `repo:${repository}/${sha}`;
}

export async function checkGrant({ env, mode, fetchImpl, workspace }) {
  const result = {
    mode, action: ACTIONS[mode] ?? null, resource: null, resources: [], enforced: grantEnforced(env),
    consumed: false, grant: null, request_id: null, confirm_url: null, bundle: [], reason: null, error: null,
  };
  try {
    if (!result.action) throw new Error(`mode ${mode} needs no Owner Grant`);
    result.resources = mode === "migrate" ? migrationResources(env) : [commitResource(env)];
    result.resource = result.resources.join(", ");
    if (!(env.CLUED_RELEASE_TOKEN ?? "").trim()) {
      result.reason = "CLUED_RELEASE_TOKEN is not set (clued-release environment)";
      return result;
    }
    const { url: base, key } = resolvePublicSupabaseConfig(env, workspace);
    const call = async (input) => {
      const response = await fetchImpl(`${base}/rest/v1/rpc/${DOOR_RPC}`, {
        method: "POST",
        headers: {
          apikey: key,
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "clued-release-grant",
        },
        body: JSON.stringify({ p_token_hash: sha256Hex(env.CLUED_RELEASE_TOKEN.trim()), p_input: input }),
      });
      let body = null;
      try {
        const text = await response.text();
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { response, body };
    };
    const input = { action: result.action, resources: result.resources };
    if (mode === "migrate") input.with = [{ action: ACTIONS.deploy, resources: [commitResource(env)] }];
    let { response, body } = await call(input);
    if (input.with && response.status === 400 && body?.message === "owner_grant_door_input_invalid") {
      delete input.with;
      ({ response, body } = await call(input));
    }
    if (response.status === 404 && body && body.code === "PGRST202") {
      result.reason = `${DOOR_RPC} is not deployed`;
      return result;
    }
    if (response.status !== 200 || !body || typeof body !== "object" || body.status !== "ok") {
      const detail = body && typeof body === "object" ? (body.message ?? body.error_code ?? body.code ?? body.status) : null;
      throw new Error(`Clued ${DOOR_RPC} returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    if (body.consumed === true) {
      result.consumed = true;
      result.grant = body.grant ?? null;
      return result;
    }
    const request = body.owner_request ?? {};
    result.request_id = typeof request.request_id === "string" ? request.request_id : null;
    if (Array.isArray(request.bundle)) {
      result.bundle = request.bundle.filter((m) => m && typeof m.action === "string")
        .map((m) => ({ action: m.action, request_id: typeof m.request_id === "string" ? m.request_id : null }));
    }
    if (typeof request.confirm_path === "string" && /^\/confirm\/[0-9a-f-]{36}$/.test(request.confirm_path)) {
      result.confirm_url = (env.CLUED_CONFIRM_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/$/, "") + request.confirm_path;
    }
    result.reason = "no Owner Grant admits this commit";
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

// Proceed when the grant was consumed, or while enforcement is off.
export function admitted(result) {
  return result.consumed || !result.enforced;
}

export function renderSummary(result) {
  const lines = [`## Owner Grant for ${result.mode}`, ""];
  lines.push(`- Action: \`${result.action ?? "n/a"}\``, `- Resource: \`${result.resource ?? "n/a"}\``);
  lines.push(`- Enforced: ${result.enforced ? "yes" : "no (CLUED_RELEASE_GRANT_ENFORCE is not true)"}`);
  if (result.consumed) {
    lines.push(`- Consumed grant \`${result.grant?.grant_id ?? "?"}\`, use ${result.grant?.use ?? "?"}${result.grant?.max_uses ? ` of ${result.grant.max_uses}` : ""}.`);
  } else {
    if (result.reason) lines.push(`- ${result.reason}`);
    if (result.error) lines.push(`- Error: ${result.error}`);
    if (result.confirm_url) lines.push(`- Ask the Owner to approve: ${result.confirm_url}`);
    if (result.bundle.length > 1) lines.push(`- The link covers ${result.bundle.map((m) => `\`${m.action}\``).join(" and ")}: one approval.`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2), env = process.env, fetchImpl = globalThis.fetch) {
  const modeIndex = argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? argv[modeIndex + 1] : "";
  if (!ACTIONS[mode]) {
    console.error("usage: clued-release-grant.mjs --mode deploy|migrate");
    return 2;
  }
  const result = await checkGrant({ env, mode, fetchImpl, workspace: env.GITHUB_WORKSPACE });
  console.log(JSON.stringify(result, null, 2));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, renderSummary(result));
  const text = result.error ?? result.reason ?? "";
  if (admitted(result)) {
    if (!result.consumed) console.error(`::warning title=Owner Grant (not enforced)::${text}${result.confirm_url ? ` Approve: ${result.confirm_url}` : ""}`);
    return 0;
  }
  console.error(`::error title=Owner Grant required::${text}${result.confirm_url ? ` Approve: ${result.confirm_url}` : ""}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}
