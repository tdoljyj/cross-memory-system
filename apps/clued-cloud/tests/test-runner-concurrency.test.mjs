import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { boundedTestArgs } from "../scripts/run-tests.mjs";

test("test wrapper bounds defaults but preserves explicit limits and non-test invocations", () => {
  assert.deepEqual(boundedTestArgs(["--test", "a.test.mjs"]), ["--test-concurrency=2", "--test", "a.test.mjs"]);
  for (const args of [
    ["--test", "--test-concurrency=1", "a.test.mjs"],
    ["--test", "--test-concurrency", "3", "a.test.mjs"],
    ["script.mjs"], ["script.mjs", "--test"],
    ["--eval", "--test"], ["--", "--test"],
  ]) assert.deepEqual(boundedTestArgs(args), args);
});

test("the real wrapper completes every file with at most two simultaneous test processes and cleans its scratch", { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clued-test-concurrency-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const scratch = path.join(root, "scratch"); await fs.mkdir(scratch);
  const fixture = `
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
test('bounded fixture',async()=>{
  const root=process.env.CLUED_CONCURRENCY_FIXTURE;
  let slot=null;
  for(let i=0;i<2;i++){
    const candidate=path.join(root,'slot-'+i);
    try{await fs.mkdir(candidate);slot=candidate;break;}catch(e){if(e.code!=='EEXIST')throw e;}
  }
  assert.notEqual(slot,null,'more than two fixture files are executing together');
  try{
    await fs.writeFile(path.join(os.tmpdir(),'owned-scratch'),'fixture');
    await new Promise(resolve=>setTimeout(resolve,300));
    await fs.writeFile(path.join(root,'completed-'+path.basename(import.meta.filename)),'complete',{flag:'wx'});
  }finally{await fs.rmdir(slot);}
});
`;
  const files = [];
  for (let i = 0; i < 6; i++) {
    const file = path.join(root, `fixture-${i}.test.mjs`);
    await fs.writeFile(file, fixture); files.push(file);
  }
  const wrapper = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));
  const result = await new Promise((resolve, reject) => {
    const env = { ...process.env, CLUED_CONCURRENCY_FIXTURE: root, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [wrapper, "--test", ...files], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; const timer = setTimeout(() => { child.kill(); }, 25000);
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
  assert.equal(result.code, 0, result.output); assert.equal(result.signal, null);
  assert.equal((await fs.readdir(root)).filter(name => name.startsWith("completed-")).length, files.length);
  assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith("slot-")), []);
  assert.deepEqual(await fs.readdir(scratch), [], "wrapper-owned temporary files remain");
});
