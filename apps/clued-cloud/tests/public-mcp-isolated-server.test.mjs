import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { allocateIsolatedPort, boundedLocalCommand, launchIsolatedWorker, launcherIdentity, localCredentials, spawnOwnedCommand,
  stopOwnedCommand, stopRecordedLauncher, waitForIsolatedReady } from '../evals/public-mcp/start-isolated.mjs';
import { localGatewayChildEnv } from '../evals/public-mcp/gateway-token.mjs';

const source = 'a'.repeat(40);
const serverCode = `import http from 'node:http';
const [mode,port,source]=process.argv.slice(1);
const server=http.createServer((req,res)=>{
  if(req.url==='/fixture-alive'){res.end('fixture-alive');return;}
  if(mode==='headers')return;
  if(mode==='body'){res.writeHead(200,{'content-type':'application/json'});res.write('{');return;}
  res.end(JSON.stringify({components:{source_commit:source}}));
});
server.listen(Number(port),'127.0.0.1',()=>process.send(JSON.stringify({event:'DEV_SERVER_READY',ip:'127.0.0.1',port:Number(port)})));`;
const credentials = async () => ({ key: 'synthetic-local-public', gateway: 'synthetic-local-gateway' });
async function fixture(t, mode = 'ready', port) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clued-isolated-subprocess-'));
  const secretFile = path.join(directory, '.dev.vars.public-mcp');
  port ??= await allocateIsolatedPort();
  const launched = await launchIsolatedWorker({ port, sourceCommit: source, secretFile, credentialProvider: credentials,
    workerCommand: { command: process.execPath, args: ['--input-type=module','-e',serverCode,mode,String(port),source] } });
  t.after(async () => { await launched.stop(); await fs.rm(directory,{recursive:true,force:true}); });
  return { ...launched, port, secretFile, url: `http://127.0.0.1:${port}/mcp` };
}
const ready = (f, extra = {}) => waitForIsolatedReady({ url:f.url, pid:f.child.pid, child:f.child, sourceCommit:source, timeoutMs:3000, requestTimeoutMs:200, ...extra });

test('allocated instance starts on its own port, verifies exact source and stop deletes only its local secret file',async t=>{
  const f=await fixture(t);await ready(f);
  assert.ok(f.port>0);assert.equal(await fs.readFile(f.secretFile,'utf8'),'SUPABASE_PUBLISHABLE_KEY=synthetic-local-public\nCLUED_DB_GATEWAY_TOKEN=synthetic-local-gateway\n');
  await f.stop();await assert.rejects(fs.stat(f.secretFile),{code:'ENOENT'});
  await assert.rejects(fetch(f.url,{signal:AbortSignal.timeout(500)}));
  await assert.rejects(stopOwnedCommand({pid:process.pid}),/not owned/);
});
test('occupied foreign port cannot pass readiness or be killed; another allocated instance still works',async t=>{
  // Even an old listener on the same source commit is not this child binding.
  const foreign=http.createServer((req,res)=>res.end(JSON.stringify({components:{source_commit:source}})));
  await new Promise(resolve=>foreign.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{foreign.close(resolve);foreign.closeAllConnections();}));
  const port=foreign.address().port,f=await fixture(t,'ready',port);
  await assert.rejects(ready(f),/source mismatch|exited before readiness|startup deadline exceeded/);
  await f.stop();assert.equal((await fetch(`http://127.0.0.1:${port}`)).status,200);
  const isolated=await fixture(t);assert.notEqual(isolated.port,port);await ready(isolated);
});
test('stalled headers and stalled JSON bodies respect single-request and overall deadlines',async t=>{
  for(const mode of ['headers','body']){
    const f=await fixture(t,mode),bootDeadline=Date.now()+3000;
    let started=false;
    while(Date.now()<bootDeadline){try{if(await(await fetch(new URL('/fixture-alive',f.url),{signal:AbortSignal.timeout(100)})).text()==='fixture-alive'){started=true;break;}}catch{}
      await new Promise(r=>setTimeout(r,20));}
    assert.equal(started,true,'the stalled-response fixture is actually serving before measuring its deadline');
    const start=Date.now();
    await assert.rejects(ready(f,{timeoutMs:400,requestTimeoutMs:80}),/startup deadline exceeded/);
    assert.ok(Date.now()-start<2000,`${mode} exceeded the bounded startup window`);
    await f.stop();await assert.rejects(fs.stat(f.secretFile),{code:'ENOENT'});
  }
});
test('a dead current child cannot accept a foreign listener as readiness',async t=>{
  const child=spawnOwnedCommand(process.execPath,['-e','process.exit(7)']);t.after(()=>stopOwnedCommand(child));
  await once(child,'exit');
  await assert.rejects(waitForIsolatedReady({url:'http://127.0.0.1:1/mcp',pid:child.pid,child,sourceCommit:source,timeoutMs:10000}),/exited before readiness/);
});
test('local status subprocess deadline is bounded and production credentials are not inherited',async()=>{
  const start=Date.now();
  await assert.rejects(boundedLocalCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:100}),/deadline exceeded/);
  assert.ok(Date.now()-start<4000);
  const output=await boundedLocalCommand(process.execPath,['-e',`console.log(JSON.stringify({tracked:!!process.env.RUNNER_TRACKING_ID,run:process.env.GITHUB_RUN_ID==='fixture-run',secret:!!process.env.GITHUB_TOKEN||!!process.env.CLUED_STORAGE_CONNECTOR_ISSUER||!!process.env.SUPABASE_SERVICE_ROLE_KEY}))`],
    {env:{...process.env,RUNNER_TRACKING_ID:'synthetic-marker',GITHUB_RUN_ID:'fixture-run',GITHUB_TOKEN:'must-not-pass',CLUED_STORAGE_CONNECTOR_ISSUER:'must-not-pass',SUPABASE_SERVICE_ROLE_KEY:'must-not-pass'}});
  assert.deepEqual(JSON.parse(output),{tracked:true,run:true,secret:false});
  assert.equal(localGatewayChildEnv({RUNNER_TRACKING_ID:'synthetic-marker',GITHUB_TOKEN:'must-not-pass'}).GITHUB_TOKEN,undefined);
  await assert.rejects(boundedLocalCommand(process.execPath,['-e',"process.stdout.write('x'.repeat(65537))"]),/output exceeds bound/);
  for(const sourceCommit of [undefined,null,'local-unversioned'])
    await assert.rejects(waitForIsolatedReady({url:'http://127.0.0.1:1/mcp',pid:process.pid,sourceCommit}),/configuration invalid/);
});
test('owned process tree stop closes a grandchild listener and forwards its runner marker',async t=>{
  const grandchild=`const h=require('node:http').createServer((q,r)=>r.end('fixture'));h.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:h.address().port,tracked:process.env.RUNNER_TRACKING_ID==='synthetic-tree-marker'})));`;
  const parent=`const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','pipe','ignore']});c.stdout.pipe(process.stdout);setInterval(()=>{},1000);`;
  const child=spawnOwnedCommand(process.execPath,['-e',parent],{capture:true,env:{...process.env,RUNNER_TRACKING_ID:'synthetic-tree-marker'}});
  t.after(()=>stopOwnedCommand(child));
  const output=await Promise.race([once(child.stdout,'data').then(([data])=>JSON.parse(data.toString())),new Promise((_,reject)=>setTimeout(()=>reject(Error('fixture child did not start')),4000))]);
  assert.equal(output.tracked,true);assert.equal((await fetch(`http://127.0.0.1:${output.port}`)).status,200);
  await stopOwnedCommand(child);await assert.rejects(fetch(`http://127.0.0.1:${output.port}`,{signal:AbortSignal.timeout(500)}));
});
test('recorded launcher refuses an unrelated ownership marker before sending any signal',async t=>{
  const child=spawnOwnedCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{...process.env,RUNNER_TRACKING_ID:'synthetic-owner-marker'}});
  t.after(()=>stopOwnedCommand(child));await once(child,'spawn');
  const identity=process.platform==='linux'?launcherIdentity(child.pid):`${child.pid}:1`;
  await assert.rejects(stopRecordedLauncher(identity,'wrong-marker'),/ownership mismatch|ownership unavailable/);
  assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
  // Same job marker and own process group still cannot authorize a different program.
  await assert.rejects(stopRecordedLauncher(identity,'synthetic-owner-marker'),/ownership mismatch|ownership unavailable/);
});

test('recorded PATH-invoked node launcher verifies its real executable and stops successfully',async t=>{
  if(process.platform!=='linux'){
    await assert.rejects(stopRecordedLauncher(`${process.pid}:1`,'synthetic-path-marker'),/ownership unavailable/);return;
  }
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clued-isolated-path-node-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const statusMarker=path.join(directory,'status-started'),statusScript=path.join(directory,'status.mjs');
  // The real CLI waits on a synthetic local status process, without contacting
  // Supabase or creating Worker credentials. Its argv[0] is exactly "node".
  await fs.writeFile(statusScript,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(statusMarker)},'started');setInterval(()=>{},1000);`);
  const quote=value=>`'${value.replaceAll("'","'\\''")}'`;
  await fs.writeFile(path.join(directory,'npx'),`#!/bin/sh\nexec ${quote(process.execPath)} ${quote(statusScript)}\n`,{mode:0o700});
  const launcher=fileURLToPath(new URL('../evals/public-mcp/start-isolated.mjs',import.meta.url));
  const child=spawnOwnedCommand('node',[launcher],{capture:true,env:{...process.env,
    PATH:[directory,path.dirname(process.execPath),process.env.PATH].join(path.delimiter),RUNNER_TRACKING_ID:'synthetic-path-marker'}});
  t.after(()=>stopOwnedCommand(child));await once(child,'spawn');
  const identity=launcherIdentity(child.pid),deadline=Date.now()+3000;
  while(Date.now()<deadline){try{await fs.stat(statusMarker);break;}catch{await new Promise(r=>setTimeout(r,20));}}
  assert.equal(await fs.readFile(statusMarker,'utf8'),'started','the real CLI has entered its own status collection');
  const argv=(await fs.readFile(`/proc/${child.pid}/cmdline`)).toString().split('\0').filter(Boolean);
  assert.equal(argv[0],'node');assert.equal(argv[1],launcher);
  assert.equal(await fs.realpath(`/proc/${child.pid}/exe`),await fs.realpath(process.execPath));
  await stopRecordedLauncher(identity,'synthetic-path-marker');
  const stopped=Date.now()+3000;
  while(child.exitCode===null&&child.signalCode===null&&Date.now()<stopped)await new Promise(r=>setTimeout(r,20));
  assert.equal(child.exitCode,0);assert.equal(child.signalCode,null);
});
test('cancellation during actual status collection cannot retry status or create a secret file/Worker afterward',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clued-isolated-cancel-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const countFile=path.join(directory,'status-count'),secretFile=path.join(directory,'.dev.vars');
  const code=`require('node:fs').appendFileSync(${JSON.stringify(countFile)},'status\\n');setInterval(()=>{},1000);`;
  const cancellation=new AbortController();
  const launched=launchIsolatedWorker({port:await allocateIsolatedPort(),sourceCommit:source,secretFile,signal:cancellation.signal,
    credentialProvider:({signal})=>localCredentials({signal,command:process.execPath,args:['-e',code]})});
  const deadline=Date.now()+3000;
  while(Date.now()<deadline){try{await fs.stat(countFile);break;}catch{await new Promise(r=>setTimeout(r,20));}}
  cancellation.abort();await assert.rejects(launched,/cancelled/);
  await new Promise(r=>setTimeout(r,200));
  assert.equal(await fs.readFile(countFile,'utf8'),'status\n');await assert.rejects(fs.stat(secretFile),{code:'ENOENT'});
});
test('same-source foreign listener cannot pass while the launcher is still waiting for its own credential subprocess',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clued-isolated-unbound-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let requests=0;
  const foreign=http.createServer((req,res)=>{requests++;res.end(JSON.stringify({components:{source_commit:source}}));});
  await new Promise(resolve=>foreign.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{foreign.close(resolve);foreign.closeAllConnections();}));
  const port=foreign.address().port,secretFile=path.join(directory,'.dev.vars'),readinessFile=path.join(directory,'ready.json');
  const credentialCode="setTimeout(()=>console.log(JSON.stringify({key:'synthetic-local-public',gateway:'synthetic-local-gateway'})),700)";
  const launching=launchIsolatedWorker({port,sourceCommit:source,secretFile,
    credentialProvider:async()=>JSON.parse(await boundedLocalCommand(process.execPath,['-e',credentialCode],{timeoutMs:3000})),
    workerCommand:{command:process.execPath,args:['--input-type=module','-e',serverCode,'ready',String(port),source]}});
  const identity=process.platform==='linux'?launcherIdentity(process.pid):`${process.pid}:1`;
  await assert.rejects(waitForIsolatedReady({url:`http://127.0.0.1:${port}/mcp`,pid:process.pid,sourceCommit:source,
    readinessFile,expectedIdentity:identity,timeoutMs:200,requestTimeoutMs:80}),/startup deadline exceeded/);
  assert.equal(requests,0,'HTTP is gated on the owned Wrangler IPC binding evidence');
  const launched=await launching;t.after(()=>launched.stop());await launched.stop();
  assert.equal((await fetch(`http://127.0.0.1:${port}`)).status,200);
});
test('owned binding metadata is created only after exact Wrangler IPC and removed with the secret on stop',async t=>{
  if(process.platform!=='linux'){
    const f=await fixture(t);await f.publishReady();await ready(f);return;
  }
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clued-isolated-birth-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const port=await allocateIsolatedPort(),secretFile=path.join(directory,'.dev.vars'),readinessFile=path.join(directory,'ready.json');
  const identity=launcherIdentity(process.pid);
  const f=await launchIsolatedWorker({port,sourceCommit:source,secretFile,readinessFile,identity,credentialProvider:credentials,
    workerCommand:{command:process.execPath,args:['--input-type=module','-e',serverCode,'ready',String(port),source]}});
  t.after(()=>f.stop());await f.publishReady();
  const metadata=JSON.parse(await fs.readFile(readinessFile,'utf8'));
  assert.equal(metadata.launcher_identity,identity);assert.equal(metadata.child_identity,launcherIdentity(f.child.pid));
  assert.equal(metadata.port,port);assert.equal(metadata.source_commit,source);
  assert.equal(JSON.stringify(metadata).includes('synthetic-local-gateway'),false);
  await waitForIsolatedReady({url:`http://127.0.0.1:${port}/mcp`,pid:process.pid,sourceCommit:source,readinessFile,expectedIdentity:identity,timeoutMs:1000});
  await f.stop();await assert.rejects(fs.stat(readinessFile),{code:'ENOENT'});await assert.rejects(fs.stat(secretFile),{code:'ENOENT'});
});
