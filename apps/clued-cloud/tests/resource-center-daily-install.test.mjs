import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { installDailyHost } from "../scripts/install-resource-center-daily-runner.mjs";
import { loadDailyHostConfig } from "../scripts/resource-center-daily-runner.mjs";
import { assertResourceCenterNotStopped } from "../../../kernel/host/resource-center-renewal.mjs";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "clued-install-test-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const artifacts = {};
  for (const key of ["bundle", "consumer", "probe", "bwrap"]) {
    const p = path.join(base, key);await fs.writeFile(p, key);artifacts[key] = {path:p,sha256:hash(key)};
  }
  return {destination:path.join(base,"version1"),node_path:process.execPath,artifacts,host_config:{
    contract:"clued.resource-center-daily-host/1",enabled:true,distribution:"Ubuntu-24.04",root_folder_id:"root",root_parent_id:"parent",
    profile:{registration_status:"registered",profile_id:randomUUID(),profile_version:"1",managed_root:base,boundary_scan_roots:[base]},
    client_secret_path:path.join(base,"client.dpapi"),google_tokens_path:path.join(base,"tokens.dpapi"),bindings_path:path.join(base,"bindings.dpapi")}};
}
test("installer stages pinned launchers and independently reopened journals without enabling", async t => {
  const request=await fixture(t),result=await installDailyHost(request);
  assert.equal(result.state,"staged-not-enabled");
  await assert.rejects(fs.stat(path.join(request.destination,"Invoke-CluedResourceCenter.ps1")),/ENOENT/);
  await assert.rejects(loadDailyHostConfig(path.join(request.destination,"host.json"),result.config_sha256),/ENOENT/);
  await fs.rename(path.join(request.destination,"activation.pending.json"),path.join(request.destination,"activation.json"));
  const c=await loadDailyHostConfig(path.join(request.destination,"host.json"),result.config_sha256);
  assert.equal(Object.keys(c.journal_identity).length,3);
  const launcher=await fs.readFile(path.join(request.destination,"Invoke-CluedResourceCenter.disabled.ps1"),"utf8");
  assert.equal(hash(launcher),result.launcher_sha256);
  assert.match(launcher,/NODE_OPTIONS/);assert.match(launcher, /DAILY_LAUNCHER_ARGUMENTS_FORBIDDEN/);
  const repair=await fs.readFile(path.join(request.destination,"Repair-CluedResourceCenter.disabled.ps1"),"utf8");
  assert.match(repair,/--settle/);assert.equal(hash(repair),result.settlement_launcher_sha256);
});
test("installer rejects changed artifacts before creating destination", async t => {
  const request=await fixture(t);await fs.writeFile(request.artifacts.bundle.path,"tampered");
  await assert.rejects(installDailyHost(request),/INSTALL_SOURCE_CHANGED/);
  await assert.rejects(fs.stat(request.destination),/ENOENT/);
});
test("WSL-visible consumer assets may be separate but never contain Host config or journals", async t => {
  const request=await fixture(t);request.consumer_runtime_directory=path.join(path.dirname(request.destination),"consumer-assets");
  await installDailyHost(request);
  assert.deepEqual((await fs.readdir(request.consumer_runtime_directory)).sort(),["bwrap","consumer.py","probe.py"]);
  const config=JSON.parse(await fs.readFile(path.join(request.destination,"host.json"),"utf8"));
  assert.equal(config.consumer_path,path.join(request.consumer_runtime_directory,"consumer.py"));
  assert.equal(config.state_directory,path.join(request.destination,"state"));
});
test("installer never overwrites an existing deployment or its logs", async t => {
  const request=await fixture(t);await installDailyHost(request);
  const ledger=path.join(request.destination,"state","jobs.jsonl");await fs.writeFile(ledger,"preserve existing work");
  await assert.rejects(installDailyHost(request),/EEXIST/);
  assert.equal(await fs.readFile(ledger,"utf8"),"preserve existing work");
});

test("explicit upgrade preserves old journal identities/content and runtime without enabling", async t => {
  const request = await fixture(t), renewalPath = path.join(path.dirname(request.destination), "renewal.dpapi.jsonl");
  const renewalBytes = "synthetic sealed renewal history\n";await fs.writeFile(renewalPath, renewalBytes);
  const renewalIdentity = await fs.stat(renewalPath);
  request.host_config.renewal = { path: renewalPath, identity: { dev: renewalIdentity.dev, ino: renewalIdentity.ino } };
  const original = await installDailyHost(request);
  await fs.rename(path.join(request.destination, "activation.pending.json"), path.join(request.destination, "activation.json"));
  const oldConfig = JSON.parse(await fs.readFile(path.join(request.destination, "host.json"), "utf8"));
  const journals = { "jobs.jsonl": "preserve old job history\n", "recovery.jsonl": "preserve original intent\n", "attempts.jsonl": "preserve original provider attempt\n" };
  for (const [name, text] of Object.entries(journals)) await fs.appendFile(path.join(oldConfig.state_directory, name), text);
  const stopPath = path.join(oldConfig.state_directory, "renewal-stop.json"), stopBytes = JSON.stringify({ request_id: randomUUID() }) + "\n";
  await fs.writeFile(stopPath, stopBytes);const stopIdentity = await fs.stat(stopPath);
  const nextBundle = path.join(path.dirname(request.destination), "next-bundle.mjs");await fs.writeFile(nextBundle, "Kooyumi candidate bundle");
  const upgrade = { ...request, destination: request.destination + "-upgrade", consumer_runtime_directory: request.destination,
    artifacts: { ...request.artifacts, bundle: { path: nextBundle, sha256: hash("Kooyumi candidate bundle") } },
    existing_host: { config_path: path.join(request.destination, "host.json"), config_sha256: original.config_sha256 },
    host_config: { ...request.host_config } };
  const next = await installDailyHost(upgrade);
  const c = JSON.parse(await fs.readFile(path.join(upgrade.destination, "host.json"), "utf8"));
  assert.equal(c.state_directory, oldConfig.state_directory);assert.deepEqual(c.journal_identity, oldConfig.journal_identity);
  for (const [name, text] of Object.entries(journals)) assert.equal(await fs.readFile(path.join(c.state_directory, name), "utf8"), text);
  assert.deepEqual(c.profile, oldConfig.profile);
  assert.deepEqual([c.root_folder_id, c.root_parent_id], [oldConfig.root_folder_id, oldConfig.root_parent_id]);
  assert.deepEqual(c.renewal, oldConfig.renewal);
  assert.equal(await fs.readFile(renewalPath, "utf8"), renewalBytes);
  const nextRenewalIdentity = await fs.stat(renewalPath);
  assert.deepEqual([nextRenewalIdentity.dev, nextRenewalIdentity.ino], [renewalIdentity.dev, renewalIdentity.ino]);
  for (const key of ["bindings_path", "client_secret_path", "google_tokens_path", "consumer_path", "probe_path", "bwrap_path"]) assert.equal(c[key], oldConfig[key]);
  assert.equal(hash(await fs.readFile(path.join(request.destination, "host.json"))), original.config_sha256);
  assert.equal(hash(await fs.readFile(path.join(request.destination, "runner.mjs"))), original.bundle_sha256);
  assert.equal(hash(await fs.readFile(path.join(upgrade.destination, "runner.mjs"))), next.bundle_sha256);
  assert.notEqual(next.bundle_sha256, original.bundle_sha256);
  const nextStopIdentity = await fs.stat(stopPath);
  assert.deepEqual([nextStopIdentity.dev, nextStopIdentity.ino], [stopIdentity.dev, stopIdentity.ino]);
  assert.equal(await fs.readFile(stopPath, "utf8"), stopBytes);
  assert.throws(() => assertResourceCenterNotStopped(c.state_directory), /DAILY_RENEWAL_STOPPED/);
  assert.equal(next.state, "staged-not-enabled");
  await assert.rejects(fs.stat(path.join(upgrade.destination, "activation.json")), /ENOENT/);
  await assert.rejects(fs.stat(path.join(upgrade.destination, "Invoke-CluedResourceCenter.ps1")), /ENOENT/);
  assert.match(await fs.readFile(path.join(upgrade.destination, "Renew-CluedResourceCenter.disabled.ps1"), "utf8"), /--renew/);
  assert.match(await fs.readFile(path.join(upgrade.destination, "Stop-CluedResourceCenter.disabled.ps1"), "utf8"), /--stop-renewal/);
  assert.doesNotMatch(await fs.readFile(path.join(upgrade.destination, "Stop-CluedResourceCenter.disabled.ps1"), "utf8"), /Path = '[^']*activation\.json'/);
  assert.match(await fs.readFile(path.join(upgrade.destination, "Stop-CluedResourceCenter.disabled.cmd"), "utf8"), /Stop-CluedResourceCenter.ps1/);
  await assert.rejects(installDailyHost({ ...upgrade, destination: upgrade.destination + "-bad", host_config: { ...upgrade.host_config, root_folder_id: "other" } }), /SCOPE_CHANGED/);
});
test("actual Windows launcher forwards UTF-8 OS stdin and PowerShell pipeline only after activation", {skip:process.platform!=="win32"}, async t => {
  const request=await fixture(t);
  const echo="const chunks=[];for await(const b of process.stdin)chunks.push(b);process.stdout.write(JSON.stringify({received:Buffer.concat(chunks).toString('utf8'),hooks:process.env.NODE_OPTIONS??null}));";
  await fs.writeFile(request.artifacts.bundle.path,echo);request.artifacts.bundle.sha256=hash(echo);
  await installDailyHost(request);
  const launcher=path.join(request.destination,"Invoke-CluedResourceCenter.disabled.ps1");
  const payload=JSON.stringify({content:"中文\n第二行 ' quote"});
  const args=["-NoProfile","-NonInteractive","-File",launcher];
  const options={input:payload,encoding:"utf8",windowsHide:true,timeout:15000};
  assert.notEqual(spawnSync("pwsh",args,options).status,0);
  await fs.rename(path.join(request.destination,"activation.pending.json"),path.join(request.destination,"activation.json"));
  const direct=spawnSync("pwsh",args,{...options,env:{...process.env,NODE_OPTIONS:"--require deliberately-missing.cjs"}});
  assert.equal(direct.status,0,direct.stderr);assert.deepEqual(JSON.parse(JSON.parse(direct.stdout).received),JSON.parse(payload));
  assert.ok(!JSON.parse(direct.stdout).hooks);
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  const piped=spawnSync("pwsh",["-NoProfile","-NonInteractive","-Command",`${quote(payload)} | & ${quote(launcher)}`],{...options,input:""});
  assert.equal(piped.status,0,piped.stderr);assert.deepEqual(JSON.parse(JSON.parse(piped.stdout).received),JSON.parse(payload));
});
