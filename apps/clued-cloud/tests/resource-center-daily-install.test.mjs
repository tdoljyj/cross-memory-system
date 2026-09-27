import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { installDailyHost } from "../scripts/install-resource-center-daily-runner.mjs";
import { loadDailyHostConfig } from "../scripts/resource-center-daily-runner.mjs";
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
