import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const moduleUrl = new URL("../../../kernel/host/resource-center-daily-job.mjs", import.meta.url).href;
const manifestUrl = new URL("../../../kernel/host/resource-center-governed-tool-surface.mjs", import.meta.url).href;
const script = `
import fs from 'node:fs/promises'; import path from 'node:path';
import { runDailyJob, settleDailyJob } from ${JSON.stringify(moduleUrl)};
import { RESOURCE_CENTER_GOVERNED_TOOL_MANIFEST as tools } from ${JSON.stringify(manifestUrl)};
const [dir, id, mode] = process.argv.slice(1);
const job = {job_id:id,tool:tools[0].name,arguments:{operation:'create',destination_path:'/resource/10_E/topic/new.md',target_kind:'file',content:'fixture'}};
const profile = {registration_status:'registered',profile_id:'official',profile_version:'1',managed_root:'/resource',allowed_root_children:['10_E']};
try {
 if(mode==='settle' || mode==='unproven'){
  const r=await settleDailyJob({state_directory:dir,job_id:id,trusted_profile:profile,
   inspect_committed_job:async prior=>({status:mode==='settle'?'committed':'started',job_id:prior.job_id,profile_id:prior.profile_id,job_sha256:prior.request_sha256,
   canonical_receipt_id:'22222222-2222-4222-8222-222222222222',intent_id:'33333333-3333-4333-8333-333333333333'})});
  process.stdout.write(JSON.stringify(r));process.exit(0);
 }
 const result = await runDailyJob({job,state_directory:dir,trusted_profile:profile,
 host:{listTools:()=>tools,callTool:async name=>{
   if(name===tools[1].name)return [];
   const effect=await fs.open(path.join(dir,'effects.jsonl'),'a');
   await effect.writeFile(JSON.stringify({id})+'\\n');await effect.sync();await effect.close();
   if(mode==='crash_after_effect')process.exit(73);
   return {status:'committed',canonical_receipt_id:'11111111-1111-4111-8111-111111111111'};
 }},run_isolated:async({job,call_tool:call})=>{
   if(mode==='crash_before_effect')process.exit(72);
   await call(tools[1].name,{});return call(job.tool,job.arguments);
 }});
 process.stdout.write(JSON.stringify(result));
}catch(e){process.stdout.write(JSON.stringify({error:e.code??e.message}));process.exitCode=2;}
`;
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clued-daily-process-"));
  await fs.writeFile(path.join(dir, "jobs.jsonl"), "");
  await fs.writeFile(path.join(dir, "effects.jsonl"), "");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test("operator settlement only releases a dead process fence after proven committed receipt", async t => {
  const dir = await fixture(t), id = randomUUID();
  assert.equal((await invoke(dir, id, "crash_after_effect")).code, 73);
  assert.equal(JSON.parse((await invoke(dir, id, "unproven")).stdout).error, "DAILY_CANONICAL_SETTLEMENT_UNPROVEN");
  const settled = await invoke(dir, id, "settle");assert.equal(settled.code, 0, settled.stderr + settled.stdout);
  assert.equal(JSON.parse(settled.stdout).write_gate_released, true);
  const replay = await invoke(dir, id);assert.equal(replay.code, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).replayed, true);
  assert.equal((await fs.readFile(path.join(dir, "effects.jsonl"), "utf8")).trim().split("\n").length, 1);
});
function invoke(dir, id, mode = "normal") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, id, mode], { windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.on("data", b => { stdout += b; });child.stderr.on("data", b => { stderr += b; });
    child.once("error", reject);
    child.once("close", code => { clearTimeout(timer);resolve({code,stdout,stderr}); });
  });
}
test("separate OS processes replay one committed job without repeating effect", async t => {
  const dir = await fixture(t), id = randomUUID();
  const first = await invoke(dir, id);assert.equal(first.code, 0, first.stderr);
  const replay = await invoke(dir, id);assert.equal(replay.code, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).replayed, true);
  assert.equal((await fs.readFile(path.join(dir, "effects.jsonl"), "utf8")).trim().split("\n").length, 1);
});
for (const mode of ["crash_before_effect", "crash_after_effect"]) {
  test(`real abrupt process exit ${mode} fences later independent process`, async t => {
    const dir = await fixture(t), id = randomUUID();
    assert.equal((await invoke(dir, id, mode)).code, mode === "crash_before_effect" ? 72 : 73);
    assert.equal(JSON.parse((await invoke(dir, id)).stdout).error, "EEXIST");
    // Simulated lost lock directory entry, NOT an operator recovery procedure.
    await fs.unlink(path.join(dir, "executor.lock"));
    assert.equal(JSON.parse((await invoke(dir, randomUUID())).stdout).error, "DAILY_JOB_RECONCILIATION_REQUIRED");
    const effects = (await fs.readFile(path.join(dir, "effects.jsonl"), "utf8")).split("\n").filter(Boolean);
    assert.equal(effects.length, mode === "crash_before_effect" ? 0 : 1);
  });
}
