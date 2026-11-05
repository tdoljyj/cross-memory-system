// Installed, fixed Host launcher. The only caller input is one JSON job on stdin.
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createGoogleDrivePilotCredential } from "../../../kernel/host/resource-center-google-drive-credential.mjs";
import { createResourceCenterGoogleDriveNativeWriterToolHost } from "../../../kernel/host/resource-center-online-tool-host.mjs";
import { createResourceCenterRecoveryStore, createResourceCenterProviderAttemptStore } from "../../../kernel/host/resource-center-recovery-store.mjs";
import { runDailyJob, validateDailyJob, settleDailyJob } from "../../../kernel/host/resource-center-daily-job.mjs";
import { createResourceCenterWriteClient } from "../../../kernel/host/resource-center-write-client.mjs";
import { withResourceCenterLifecycle, openRenewalStore, activeRenewalCredentials, renewResourceCenter, stopResourceCenter, assertResourceCenterNotStopped, guardedResourceCenterFetch, callRenewal } from "../../../kernel/host/resource-center-renewal.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = code => { throw new Error(code); };
async function safeFile(filename) {
  const st = await fs.lstat(filename);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail("DAILY_HOST_FILE_UNSAFE");
  return fs.readFile(filename);
}
function decrypt(bytes) {
  const script = "$ErrorActionPreference='Stop'; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))";
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script],
    { input: bytes, encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) fail("DAILY_HOST_SECRET_UNAVAILABLE");
  try { return JSON.parse(result.stdout); } catch { fail("DAILY_HOST_SECRET_INVALID"); }
}
function seal(value) {
  const script = "$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); $b=[Security.Cryptography.ProtectedData]::Protect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($b))";
  const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script],
    { input: JSON.stringify(value), encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  if (r.status !== 0 || r.error) fail("DAILY_RENEWAL_SEAL_FAILED");return r.stdout;
}
async function notifyRenewal(c) {
  // One notification per unresolved incident; a successful renewal clears only
  // this marker, never a write/recovery lock or journal.
  const file = path.join(c.state_directory, "renewal-notified.json");
  let f;try { f = await fs.open(file, "wx"); } catch (e) { if (e.code === "EEXIST") return;throw e; }
  try { await f.writeFile(JSON.stringify({ code: "DAILY_RENEWAL_NEEDS_ATTENTION", time: new Date().toISOString() }));await f.sync(); } finally { await f.close(); }
  spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('Clued 资料中心自动续签需要处理，受控写入保持关闭。请查看受控入口状态。','Clued 连接提醒') | Out-Null"], { windowsHide: true, stdio: "ignore" }).unref();
}
export const toWsl = p => {
  const normalized = p.replaceAll("\\", "/");
  const prefix = "//wsl.localhost/Ubuntu-24.04/";
  if (normalized.startsWith(prefix)) return "/" + normalized.slice(prefix.length);
  if (/^[A-Za-z]:\//.test(normalized)) return normalized.replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
  fail("DAILY_WSL_PATH_UNSUPPORTED");
};

export function validateDailyCredentials(secrets, profileId, now = Date.now()) {
  if (secrets?.profile_id !== profileId || !/^clued_rcb_[a-f0-9]{64}$/.test(secrets?.reader ?? "") ||
    !/^clued_rcw_[a-f0-9]{64}$/.test(secrets?.writer ?? "") || !Number.isFinite(Date.parse(secrets?.expires_at)) ||
    !Number.isFinite(now) || Date.parse(secrets.expires_at) - now < 10 * 60 * 1000) fail("DAILY_BINDING_RENEWAL_REQUIRED");
}

export async function loadDailyHostConfig(configPath, expectedHash, { stopOnly = false } = {}) {
  if (!path.isAbsolute(configPath ?? "") || !/^[a-f0-9]{64}$/.test(expectedHash ?? "")) fail("DAILY_CONFIG_PIN_REQUIRED");
  const bytes = await safeFile(configPath);
  if (hash(bytes) !== expectedHash) fail("DAILY_CONFIG_PIN_MISMATCH");
  const c = JSON.parse(bytes);
  if (!path.isAbsolute(c.activation_path ?? "") || (!stopOnly && hash(await safeFile(c.activation_path)) !== c.activation_sha256)) fail("DAILY_ACTIVATION_REQUIRED");
  if (c.contract !== "clued.resource-center-daily-host/1" || c.enabled !== true ||
    c.profile?.registration_status !== "registered" || !path.isAbsolute(c.profile.managed_root ?? "") ||
    !c.root_folder_id || !c.root_parent_id || c.distribution !== "Ubuntu-24.04" ||
    !/^[0-9a-f-]{36}$/i.test(c.profile.profile_id ?? "")) fail("DAILY_CONFIG_INVALID");
  for (const name of ["state_directory", "recovery_path", "attempt_path", "client_secret_path", "google_tokens_path", "bindings_path", "consumer_path", "probe_path", "bwrap_path"])
    if (!path.isAbsolute(c[name] ?? "")) fail("DAILY_CONFIG_PATH_INVALID");
  for (const name of stopOnly ? [] : ["consumer", "probe", "bwrap"])
    if (hash(await safeFile(c[`${name}_path`])) !== c[`${name}_sha256`]) fail("DAILY_RUNTIME_PIN_MISMATCH");
  for (const name of stopOnly ? [] : ["jobs.jsonl", "recovery.jsonl", "attempts.jsonl"]) {
    const st = await fs.lstat(path.join(c.state_directory, name));
    const pin = c.journal_identity?.[name];
    if (!pin || !st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.dev !== pin.dev || st.ino !== pin.ino) fail("DAILY_JOURNAL_IDENTITY_CHANGED");
  }
  if (c.recovery_path !== path.join(c.state_directory, "recovery.jsonl") || c.attempt_path !== path.join(c.state_directory, "attempts.jsonl")) fail("DAILY_JOURNAL_IDENTITY_CHANGED");
  if (c.renewal && (!path.isAbsolute(c.renewal.path ?? "") || !c.renewal.identity)) fail("DAILY_RENEWAL_CONFIG_INVALID");
  // A missing/disconnected mount cannot be misreported as a clean watcher.
  for (const root of stopOnly ? [] : [c.profile.managed_root, ...c.profile.boundary_scan_roots]) {
    const st = await fs.lstat(root);
    if (!st.isDirectory() || st.isSymbolicLink()) fail("DAILY_SCAN_ROOT_UNAVAILABLE");
  }
  return c;
}

export async function runIsolatedDailyConsumer(c, { job, tools, call_tool: callTool }) {
  const child = spawn("wsl", ["-d", c.distribution, "--exec", toWsl(c.bwrap_path),
    "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--clearenv", "--setenv", "PATH", "/usr/bin", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", toWsl(c.probe_path), "/probe.py", "--ro-bind", toWsl(c.consumer_path), "/consumer.py", "--chdir", "/", "--",
    "/usr/bin/python3", "-c", "import os,resource; os.closerange(3,resource.getrlimit(resource.RLIMIT_NOFILE)[0]); os.execv('/usr/bin/python3',['python3','/consumer.py'])"],
  { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise(resolve => {
    child.once("error", () => resolve({ error: true }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stderr.resume();
  let bytes = 0; let booted = false; let finished = false; let result;
  const expectedChecks = ["windows_disk_hidden", "drive_mount_hidden", "host_home_hidden", "host_credentials_hidden", "host_process_root_hidden", "wsl_interop_hidden", "host_tmp_hidden", "capabilities_removed", "no_new_privileges", "environment_scrubbed", "inherited_fds_limited_to_stdio", "system_runtime_readonly", "network_isolated", "nested_user_namespace_denied"];
  const timer = setTimeout(() => child.kill(), 180000);
  const lines = readline.createInterface({ input: child.stdout });
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line);
      if (bytes > 4 * 1024 * 1024 || finished) fail("DAILY_CONSUMER_PROTOCOL_INVALID");
      const m = JSON.parse(line); let value;
      if (m.kind === "bootstrap" && !booted) {
        if (Object.keys(m.os_checks ?? {}).length !== expectedChecks.length || expectedChecks.some(key => m.os_checks[key] !== true)) fail("DAILY_OS_ISOLATION_FAILED");
        booted = true; value = { job, tools };
      } else if (m.kind === "tool_call" && booted) {
        value = await callTool(m.name, m.arguments);
      } else if (m.kind === "finished" && booted) {
        result = m.result; finished = true; continue;
      } else fail("DAILY_CONSUMER_PROTOCOL_INVALID");
      child.stdin.write(JSON.stringify({ kind: "reply", value }) + "\n");
    }
    const exit = await exited;
    if (!finished || exit.error || exit.code !== 0 || exit.signal !== null) fail("DAILY_CONSUMER_INCOMPLETE");
    return result;
  } finally {
    clearTimeout(timer); lines.close(); child.stdin.end(); if (!finished) child.kill();
  }
}

export async function main(configPath, expectedHash, mode) {
  if (process.platform !== "win32") fail("DAILY_WINDOWS_HOST_REQUIRED");
  const c = await loadDailyHostConfig(configPath, expectedHash, { stopOnly: mode === "--stop-renewal" });
  if (mode === "--stop-renewal") {
    if (!c.renewal) fail("DAILY_RENEWAL_NOT_INSTALLED");
    const result = await stopResourceCenter({ directory: c.state_directory, filename: c.renewal.path,
      identity: c.renewal.identity, unseal: decrypt });
    process.stdout.write(JSON.stringify(result) + "\n");return;
  }
  return withResourceCenterLifecycle(c.state_directory, async () => {
    let store;
    try {
      assertResourceCenterNotStopped(c.state_directory);
      if (c.renewal) store = await openRenewalStore(c.renewal.path, c.renewal.identity, { seal, unseal: decrypt });
      if (["--renew", "--stop-renewal"].includes(mode)) {
        if (!store) fail("DAILY_RENEWAL_NOT_INSTALLED");
        let lock;
        // Stop only attenuates privileges and must remain available when an
        // executor fence exists. It never removes that fence.
        if (mode === "--renew") lock = await fs.open(path.join(c.state_directory, "executor.lock"), "wx");
        try {
          if (lock) { await lock.writeFile(JSON.stringify({ pid: process.pid, profile_id: c.profile.profile_id }));await lock.sync(); }
          const result = await renewResourceCenter({ store, profile_id: c.profile.profile_id,
            jobs: await fs.readFile(path.join(c.state_directory, "jobs.jsonl"), "utf8"), stop: mode === "--stop-renewal", notify: () => notifyRenewal(c),
            assert_active: () => assertResourceCenterNotStopped(c.state_directory),
            request: (token, request) => callRenewal(token, request, guardedResourceCenterFetch(c.state_directory)) });
          if (result.status === "rotated") await fs.unlink(path.join(c.state_directory, "renewal-notified.json")).catch(e => { if (e.code !== "ENOENT") throw e; });
          if (result.status === "needs_attention") process.exitCode = 2;
          process.stdout.write(JSON.stringify(result) + "\n");return;
        } finally { if (lock) { await lock.close();await fs.unlink(path.join(c.state_directory, "executor.lock")); } }
      }
      return await runWithCredentials(c, mode, store ? activeRenewalCredentials(store.read(), c.profile.profile_id) : decrypt(await safeFile(c.bindings_path)));
    } catch (error) { if (mode === "--renew" || mode === "--stop-renewal") await notifyRenewal(c);throw error; }
    finally { await store?.close(); }
  });
}
// Host-bootstrap composition only; neither factory is an Agent tool or accepts
// an endpoint from a job. Fixed endpoints override any caller-owned options.
export function createDailyNativeWriterToolHost(options) {
  return createResourceCenterGoogleDriveNativeWriterToolHost({ ...options,
    authority_endpoint: "https://kooyumi.pixelgrav.com/v1/resource-center/authority",
    writer_endpoint: "https://kooyumi.pixelgrav.com/v1/resource-center/write" });
}
export function createDailySettlementInspector(writer, fetchImpl = globalThis.fetch) {
  return createResourceCenterWriteClient({ endpoint: "https://kooyumi.pixelgrav.com/v1/resource-center/write", binding_token: writer, fetch: fetchImpl,
    resolve_provider_identity: () => fail("DAILY_SETTLEMENT_READ_ONLY"), verify_postcondition: () => fail("DAILY_SETTLEMENT_READ_ONLY"), persist_recovery: () => fail("DAILY_SETTLEMENT_READ_ONLY") });
}
async function runWithCredentials(c, mode, secrets) {
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length; if (length > 2 * 1024 * 1024) fail("DAILY_INPUT_LIMIT"); chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assertResourceCenterNotStopped(c.state_directory);
  validateDailyCredentials(secrets, c.profile.profile_id);
  if (mode === "--settle") {
    if (!input || Object.keys(input).sort().join(",") !== "job_id,request_key" ||
      !/^[0-9a-f-]{36}$/i.test(input.job_id ?? "") || !/^[0-9a-f-]{36}$/i.test(input.request_key ?? "")) fail("DAILY_SETTLEMENT_INVALID");
    const recovery = createResourceCenterRecoveryStore(c.recovery_path);
    const ticket = await recovery.read_recovery(input.request_key);
    if (ticket.job_id !== input.job_id.toLowerCase() || ticket.profile_id !== c.profile.profile_id) fail("DAILY_SETTLEMENT_JOB_MISMATCH");
    if (ticket.mutation?.artifact_role !== "clued_resource") fail("DAILY_SETTLEMENT_JOB_MISMATCH");
    const { artifact_role: _role, ...originalArguments } = ticket.mutation;
    const originalJob = validateDailyJob({ job_id: ticket.job_id, tool: "clued_resource_center_mutate", arguments: originalArguments });
    const inspector = createDailySettlementInspector(secrets.writer);
    const result = await settleDailyJob({ state_directory: c.state_directory, job_id: originalJob.job_id, trusted_profile: c.profile,
      inspect_committed_job: async prior => {
        if (hash(JSON.stringify(originalJob)) !== prior.request_sha256) fail("DAILY_SETTLEMENT_JOB_MISMATCH");
        const observed = await inspector.inspect_recovery(ticket);
        if (observed.status !== "committed" || observed.final_result?.status !== "committed" ||
          observed.request_sha256 !== ticket.request_sha256) fail("DAILY_CANONICAL_SETTLEMENT_UNPROVEN");
        return { status: "committed", job_id: prior.job_id, profile_id: prior.profile_id, job_sha256: prior.request_sha256,
          canonical_receipt_id: observed.receipt_id, intent_id: observed.intent_id };
      } });
    process.stdout.write(JSON.stringify(result) + "\n");return;
  }
  if (mode !== undefined) fail("DAILY_MODE_INVALID");
  const job = validateDailyJob(input);
  const client = decrypt(await safeFile(c.client_secret_path));
  const getCredential = createGoogleDrivePilotCredential({ ...client,
    load_tokens: async () => decrypt(await safeFile(c.google_tokens_path)) });
  const recovery = createResourceCenterRecoveryStore(c.recovery_path);
  const attempts = createResourceCenterProviderAttemptStore(c.attempt_path);
  const host = createDailyNativeWriterToolHost({ trusted_profile: c.profile,
    drive_fetch: guardedResourceCenterFetch(c.state_directory), authority_fetch: guardedResourceCenterFetch(c.state_directory),
    root_folder_id: c.root_folder_id, root_parent_id: c.root_parent_id, get_drive_credential: getCredential,
    authority_binding_token: secrets.reader, writer_binding_token: secrets.writer,
    persist_recovery: ticket => recovery.persist_recovery({ ...ticket, job_id: job.job_id }),
    persist_provider_attempt: attempt => attempts.persist_provider_attempt({ ...attempt, job_id: job.job_id }) });
  const result = await runDailyJob({ job, state_directory: c.state_directory, trusted_profile: c.profile, host,
    run_isolated: args => runIsolatedDailyConsumer(c, args) });
  process.stdout.write(JSON.stringify(result) + "\n");
}
if (import.meta.main) {
  main(process.argv[2], process.argv[3], process.argv[4]).catch(error => {
    // No raw provider response, stack, file path or secret reaches the caller.
    const code = /^DAILY_[A-Z_]+$/.test(error?.message ?? "") ? error.message : "DAILY_HOST_FAILED_CLOSED";
    process.stdout.write(JSON.stringify({ status: "deny", error_code: code }) + "\n"); process.exitCode = 2;
  });
}
