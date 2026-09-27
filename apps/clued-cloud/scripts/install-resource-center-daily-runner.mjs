// Operator-only installation. Never exposed in the two-tool consumer manifest.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = code => { throw new Error(code); };
const ps = value => "'" + value.replaceAll("'", "''") + "'";
async function regular(filename) {
  const st = await fs.lstat(filename);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail("INSTALL_FILE_UNSAFE");
  return fs.readFile(filename);
}
async function freshFile(filename, bytes) {
  const file = await fs.open(filename, "wx", 0o600);
  try { await file.writeFile(bytes);await file.sync(); } finally { await file.close(); }
}

/** Source hashes are supplied by the reviewing operator, not the job caller.
 * Fresh directory only: an upgrade must preserve the existing state separately,
 * and this installer deliberately does not implement upgrades or credential renewal. */
export async function installDailyHost({ destination, artifacts, host_config: input, node_path: nodePath }) {
  if (!path.isAbsolute(destination ?? "") || !path.isAbsolute(nodePath ?? "") || !input || input.enabled !== true)
    fail("INSTALL_ARGUMENT_INVALID");
  const parent = await fs.lstat(path.dirname(destination));
  if (!parent.isDirectory() || parent.isSymbolicLink()) fail("INSTALL_PARENT_UNSAFE");
  const data = {};
  for (const key of ["bundle", "consumer", "probe", "bwrap"]) {
    const artifact = artifacts?.[key];
    if (!path.isAbsolute(artifact?.path ?? "") || !/^[a-f0-9]{64}$/.test(artifact?.sha256 ?? "")) fail("INSTALL_PIN_REQUIRED");
    data[key] = await regular(artifact.path);
    if (hash(data[key]) !== artifact.sha256) fail("INSTALL_SOURCE_CHANGED");
  }
  const nodeHash = hash(await regular(nodePath));
  // No recursive mkdir or reuse: an existing target is a hard error.
  await fs.mkdir(destination, { mode: 0o700 });
  const state = path.join(destination, "state");await fs.mkdir(state, { mode: 0o700 });
  const names = { bundle: "runner.mjs", consumer: "consumer.py", probe: "probe.py", bwrap: "bwrap" };
  for (const key of Object.keys(names)) await freshFile(path.join(destination, names[key]), data[key]);
  await fs.chmod(path.join(destination, "bwrap"), 0o700);
  for (const name of ["jobs.jsonl", "recovery.jsonl", "attempts.jsonl"]) await freshFile(path.join(state, name), "");
  // Separate process verifies pre-provisioned entries before any launcher exists.
  const check = spawnSync(nodePath, ["--input-type=module", "-e", `import fs from 'node:fs/promises';import path from 'node:path';const ids={};for(const n of ['jobs.jsonl','recovery.jsonl','attempts.jsonl']){const p=path.join(process.argv[1],n),s=await fs.lstat(p),f=await fs.open(p,'r+');try{const t=await f.stat();if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.dev!==t.dev||s.ino!==t.ino||(await f.readFile()).length!==0)throw Error('UNSAFE');await f.sync();ids[n]={dev:s.dev,ino:s.ino};}finally{await f.close();}}process.stdout.write(JSON.stringify(ids));`, state],
  { windowsHide: true, encoding: "utf8", timeout: 15000, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" } });
  if (check.status !== 0 || check.error) fail("INSTALL_STATE_READBACK_FAILED");
  const journalIdentity = JSON.parse(check.stdout);
  const c = { ...structuredClone(input), state_directory: state,
    recovery_path: path.join(state, "recovery.jsonl"), attempt_path: path.join(state, "attempts.jsonl"), journal_identity: journalIdentity };
  const activation = JSON.stringify({ contract: "clued.resource-center-daily-activation/1", profile_id: c.profile.profile_id, destination });
  c.activation_path = path.join(destination, "activation.json");c.activation_sha256 = hash(activation);
  await freshFile(path.join(destination, "activation.pending.json"), activation);
  for (const key of ["consumer", "probe", "bwrap"]) {
    c[`${key}_path`] = path.join(destination, names[key]);c[`${key}_sha256`] = artifacts[key].sha256;
  }
  const configPath = path.join(destination, "host.json"), bundlePath = path.join(destination, names.bundle);
  const configBytes = JSON.stringify(c, null, 2) + "\n";await freshFile(configPath, configBytes);
  // Pin node, bundle and config before process startup. No caller-selected config,
  // command arguments, NODE_OPTIONS/preload hooks or inherited TLS bypass.
  const invoke = `& ${ps(nodePath)} --use-env-proxy ${ps(bundlePath)} ${ps(configPath)} '${hash(configBytes)}'`;
  const launcher = `# Reviewed fixed Clued daily entry. One UTF-8 JSON job on stdin.\n$ErrorActionPreference = 'Stop'\nif ($args.Count -ne 0) { throw 'DAILY_LAUNCHER_ARGUMENTS_FORBIDDEN' }\n[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Text.UTF8Encoding]::new($false)\nforeach ($pin in @(\n  @{ Path = ${ps(nodePath)}; Hash = '${nodeHash}' },\n  @{ Path = ${ps(bundlePath)}; Hash = '${artifacts.bundle.sha256}' },\n  @{ Path = ${ps(configPath)}; Hash = '${hash(configBytes)}' },\n  @{ Path = ${ps(c.activation_path)}; Hash = '${c.activation_sha256}' }\n)) {\n  $item = Get-Item -LiteralPath $pin.Path\n  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Get-FileHash -LiteralPath $pin.Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.Hash) { throw 'DAILY_LAUNCHER_PIN_MISMATCH' }\n}\nforeach ($key in @('NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_TLS_REJECT_UNAUTHORIZED','SSL_CERT_FILE','SSL_CERT_DIR')) { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }\nif ($MyInvocation.ExpectingInput) {\n  $jobText = ($input | ForEach-Object { [string]$_ }) -join [Environment]::NewLine\n  $jobText | ${invoke}\n} else {\n  ${invoke}\n}\nexit $LASTEXITCODE\n`;
  // Deliberately inactive until the operator completes provision/readback checks.
  await freshFile(path.join(destination, "Invoke-CluedResourceCenter.disabled.ps1"), launcher);
  const settlementLauncher = launcher.replace("# Reviewed fixed Clued daily entry.", "# Operator-only committed-intent settlement. No provider writes.")
    .replaceAll(invoke, `${invoke} --settle`);
  await freshFile(path.join(destination, "Repair-CluedResourceCenter.disabled.ps1"), settlementLauncher);
  const manifest = { contract: "clued.resource-center-daily-install/1", state: "staged-not-enabled",
    destination, node_path: nodePath, node_sha256: nodeHash, config_sha256: hash(configBytes),
    bundle_sha256: artifacts.bundle.sha256, launcher_sha256: hash(launcher), settlement_launcher_sha256: hash(settlementLauncher),
    runtime: Object.fromEntries(["consumer", "probe", "bwrap"].map(key => [key, artifacts[key].sha256])),
    activation_requires: "reviewed CI + independent process state/runtime readback + exact live profile/bindings qualification",
    boundary: "dedicated-isolated-consumer-not-whole-codex" };
  await freshFile(path.join(destination, "installation.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const request = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
  installDailyHost(request).then(result => process.stdout.write(JSON.stringify(result) + "\n")).catch(() => {
    process.stderr.write("INSTALL_FAILED_CLOSED\n");process.exitCode = 2;
  });
}
