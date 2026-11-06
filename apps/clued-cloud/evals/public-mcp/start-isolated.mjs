import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLocalGatewayUrl, createLocalGatewayToken, localGatewayChildEnv } from './gateway-token.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)), cloudRoot=path.resolve(here,'../..');
const secretPath=path.join(here,'.dev.vars.public-mcp'), owned=new Set(), stopping=new WeakMap(), observed=new WeakMap();
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);
  if(process.platform==='linux'){const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');if(stat.slice(stat.lastIndexOf(')')+1).trim().startsWith('Z '))return false;}
  return true;}catch{return false;}};
export async function allocateIsolatedPort(){
  const server=net.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
// Only a ChildProcess created here is stoppable; never adopt/kill a port owner.
export function spawnOwnedCommand(command,args,{cwd=cloudRoot,env=process.env,capture=false,logPath,ipc=false}={}){
  const child=spawn(command,args,{cwd,windowsHide:true,detached:process.platform!=='win32',shell:process.platform==='win32'&&/\.cmd$/i.test(command),
    env:localGatewayChildEnv(env,logPath?{WRANGLER_LOG_PATH:logPath}:{}),
    stdio:ipc?(capture?['ignore','pipe','pipe','ipc']:['ignore','ignore','ignore','ipc']):(capture?['ignore','pipe','pipe']:'ignore')});
  owned.add(child);return child;
}
function watchOwnedServer(child){
  observed.set(child,null);
  child.on('message',message=>{
    let value;try{value=typeof message==='string'&&message.length<=4096?JSON.parse(message):message;}catch{return;}
    if(value?.event==='DEV_SERVER_READY'&&value.ip==='127.0.0.1'&&Number.isSafeInteger(value.port))observed.set(child,{ip:value.ip,port:value.port});
  });
}
const boundHere=(child,port)=>owned.has(child)&&observed.get(child)?.port===port&&child.exitCode===null&&child.signalCode===null;
export async function stopOwnedCommand(child){
  if(!owned.has(child))throw Error('isolated command is not owned by this launcher');
  if(stopping.has(child))return stopping.get(child);
  const operation=(async()=>{
    if(!child.pid)return;
    if(process.platform==='win32'){
      if(child.exitCode===null&&child.signalCode===null){
        try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true,env:localGatewayChildEnv(),timeout:3000});}
        catch{if(alive(child.pid))throw Error('isolated command stop unconfirmed');}
      }
    }else{
      try{process.kill(-child.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}
      await delay(250);
      try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
    }
    const deadline=Date.now()+3000;
    while(child.exitCode===null&&child.signalCode===null&&Date.now()<deadline)await delay(20);
    if(child.exitCode===null&&child.signalCode===null)throw Error('isolated command stop unconfirmed');
  })();stopping.set(child,operation);return operation;
}
// The workflow's PID file names a setsid launcher from this job. A reused or
// unrelated PID must not be signalled, even when it happens to occupy our port.
export function launcherIdentity(pid){
  if(process.platform!=='linux'||!Number.isSafeInteger(pid)||pid<1)throw Error('isolated launcher identity unavailable');
  const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');
  return `${pid}:${stat.slice(stat.lastIndexOf(')')+1).trim().split(/\s+/)[19]}`;
}
export async function stopRecordedLauncher(identity,trackingId=process.env.RUNNER_TRACKING_ID){
  if(process.platform!=='linux'||!/^\d+:\d+$/.test(identity)||!trackingId)throw Error('isolated launcher ownership unavailable');
  const [pidText,started]=identity.split(':'),pid=Number(pidText);
  if(!Number.isSafeInteger(pid)||pid<1)throw Error('isolated launcher ownership unavailable');
  if(!alive(pid))return;
  const root=`/proc/${pid}`;
  let metadata;
  try{metadata=fs.readFileSync(`${root}/stat`,'utf8');}catch(error){if(error.code==='ENOENT')return;throw error;}
  const group=Number(metadata.slice(metadata.lastIndexOf(')')+1).trim().split(/\s+/)[2]);
  const argv=fs.readFileSync(`${root}/cmdline`).toString().split('\0').filter(Boolean),cwd=fs.readlinkSync(`${root}/cwd`);
  const marker=fs.readFileSync(`${root}/environ`).toString().split('\0').find(item=>item.startsWith('RUNNER_TRACKING_ID='));
  if(group!==pid||launcherIdentity(pid)!==identity||!started||marker!==`RUNNER_TRACKING_ID=${trackingId}`||argv.length!==2||
    fs.realpathSync(path.resolve(cwd,argv[1]))!==fs.realpathSync(fileURLToPath(import.meta.url))||fs.realpathSync(`${root}/exe`)!==fs.realpathSync(process.execPath))throw Error('isolated launcher ownership mismatch');
  process.kill(-pid,'SIGTERM');
  const deadline=Date.now()+5000;
  while(alive(pid)&&Date.now()<deadline)await delay(25);
  if(alive(pid))throw Error('isolated launcher stop unconfirmed');
}
export async function boundedLocalCommand(command,args,{timeoutMs=3500,signal,...options}={}){
  if(signal?.aborted)throw Error('local command cancelled');
  const child=spawnOwnedCommand(command,args,{...options,capture:true});let timer,size=0;const chunks=[];
  let cancelled;
  try{return await new Promise((resolve,reject)=>{
    cancelled=()=>reject(Error('local command cancelled'));signal?.addEventListener('abort',cancelled,{once:true});
    if(signal?.aborted){cancelled();return;}
    timer=setTimeout(()=>reject(Error('local command deadline exceeded')),timeoutMs);
    child.on('error',()=>reject(Error('local command could not start')));
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>65536)reject(Error('local command output exceeds bound'));else chunks.push(chunk);});
    child.stderr.on('data',()=>{}); // Consume, never print status stderr or credentials.
    child.on('close',code=>code===0?resolve(Buffer.concat(chunks).toString('utf8')):reject(Error('local command failed')));
  });}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancelled);await stopOwnedCommand(child);}
}
export async function waitForIsolatedReady({url,pid,sourceCommit,child,readinessFile,expectedIdentity,timeoutMs=60000,requestTimeoutMs=1000}){
  const target=new URL('/.well-known/clued-continuity',url);assertLocalGatewayUrl(target.origin);
  if(!Number.isSafeInteger(pid)||pid<1||!/^[a-f0-9]{40}$/.test(sourceCommit)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000||
    !Number.isSafeInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>2000||
    (!child&&!readinessFile)||(child&&(!owned.has(child)||child.pid!==pid)))throw Error('isolated readiness configuration invalid');
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(!alive(pid))throw Error('isolated launcher exited before readiness');let body;
    let bound=child?boundHere(child,Number(target.port)):false;
    if(!child)try{
      const bytes=fs.readFileSync(readinessFile);if(bytes.length>4096)throw Error('readiness metadata exceeds bound');
      const metadata=JSON.parse(bytes.toString());
      bound=metadata.launcher_identity===expectedIdentity&&metadata.port===Number(target.port)&&metadata.source_commit===sourceCommit&&
        /^\d+:\d+$/.test(metadata.child_identity)&&launcherIdentity(Number(metadata.child_identity.split(':')[0]))===metadata.child_identity&&alive(Number(metadata.child_identity.split(':')[0]));
    }catch{}
    if(!bound){await delay(Math.min(100,Math.max(1,deadline-Date.now())));continue;}
    try{
      const response=await fetch(target,{redirect:'error',signal:AbortSignal.timeout(Math.min(requestTimeoutMs,Math.max(1,deadline-Date.now())))});
      if(response.status===200){
        const reader=response.body.getReader(),chunks=[];let size=0;
        try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536)throw Error('readiness response exceeds bound');chunks.push(part.value);}
          body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{await reader.cancel().catch(()=>{});}
      }else await response.body?.cancel();
    }catch{} // Single-request and total deadlines also cover a stalled JSON body.
    if(body){if(body.components?.source_commit!==sourceCommit)throw Error('isolated readiness source mismatch');
      if(!alive(pid))throw Error('isolated launcher exited before readiness');return;}
    await delay(Math.min(100,Math.max(1,deadline-Date.now())));
  }throw Error('isolated startup deadline exceeded');
}
export async function localCredentials({signal,command,args:providedArgs}={}){
  const deadline=Date.now()+20000;
  const args=providedArgs??(process.platform==='linux'&&process.arch==='x64'
    ?['--yes','--package=supabase@2.115.0','--package=@supabase/cli-linux-x64@2.115.0','supabase','status','--output','json']
    :['--yes','supabase@2.115.0','status','--output','json']);
  while(Date.now()<deadline&&!signal?.aborted){let status;
    try{status=JSON.parse(await boundedLocalCommand(command??(process.platform==='win32'?'npx.cmd':'npx'),args,{signal,timeoutMs:Math.min(3500,Math.max(1,deadline-Date.now()))}));}catch{}
    if(signal?.aborted)throw Error('local credential collection cancelled');
    const key=status?.PUBLISHABLE_KEY??status?.ANON_KEY;
    if(key&&status.JWT_SECRET){const origin=assertLocalGatewayUrl(status.API_URL),config=JSON.parse(fs.readFileSync(path.join(here,'wrangler.jsonc'),'utf8'));
      if(assertLocalGatewayUrl(config.vars.SUPABASE_URL)!==origin)throw Error('isolated Worker and local Supabase origins differ');
      return {key,gateway:createLocalGatewayToken({apiUrl:origin,jwtSecret:status.JWT_SECRET})};}
    await delay(Math.min(1000,Math.max(1,deadline-Date.now())));
  }throw Error(signal?.aborted?'local credential collection cancelled':'local Supabase credential deadline exceeded');
}
// Optional command/credential providers are trusted in-process test seams. They
// are never selected by browser data, environment secrets or CLI arguments.
export async function launchIsolatedWorker({port,sourceCommit,credentialProvider=localCredentials,secretFile=secretPath,workerCommand,signal,readinessFile,identity}={}){
  if(signal?.aborted)throw Error('isolated launch cancelled');
  if(!Number.isSafeInteger(port)||port<1||port>65535)throw Error('isolated loopback port invalid');
  if(sourceCommit!==undefined&&!/^[a-f0-9]{40}$/.test(sourceCommit))throw Error('isolated source commit invalid');
  const credentials=await credentialProvider({signal});
  if(signal?.aborted)throw Error('isolated launch cancelled');
  fs.writeFileSync(secretFile,`SUPABASE_PUBLISHABLE_KEY=${credentials.key}\nCLUED_DB_GATEWAY_TOKEN=${credentials.gateway}\n`,{mode:0o600});
  if(process.platform!=='win32')fs.chmodSync(secretFile,0o600);
  let child;
  try{child=spawnOwnedCommand(workerCommand?.command??process.execPath,workerCommand?.args??[
    path.join(cloudRoot,'node_modules/wrangler/bin/wrangler.js'),'dev','--config','evals/public-mcp/wrangler.jsonc','--env','public-mcp',
    '--ip','127.0.0.1','--port',String(port),'--inspector-port','0','--var',`CLUED_ALLOWED_ORIGINS:http://127.0.0.1:${port},http://localhost:${port}`,
    ...(sourceCommit?['--define',`__CLUED_BUILD_SHA__:${JSON.stringify(sourceCommit)}`]:[]),'--local','--show-interactive-dev-session','false','--log-level','error'],
    {ipc:true,logPath:path.join(cloudRoot,'.wrangler','public-mcp.log')});watchOwnedServer(child);}
  catch(error){fs.rmSync(secretFile,{force:true});throw error;}
  let published=false;
  const stop=async()=>{try{await stopOwnedCommand(child);}finally{fs.rmSync(secretFile,{force:true});if(published)fs.rmSync(readinessFile,{force:true});}};
  child.once('exit',()=>void stop().catch(()=>{}));child.once('error',()=>void stop().catch(()=>{}));
  const publishReady=async()=>{
    const deadline=Date.now()+60000;
    while(!boundHere(child,port)){
      if(signal?.aborted||!alive(child.pid))throw Error('isolated Worker exited before binding');
      if(Date.now()>=deadline)throw Error('isolated Worker binding deadline exceeded');await delay(25);
    }
    if(signal?.aborted)throw Error('isolated launch cancelled');
    if(readinessFile){
      fs.writeFileSync(readinessFile,JSON.stringify({launcher_identity:identity,child_identity:launcherIdentity(child.pid),port,source_commit:sourceCommit}),{mode:0o600,flag:'wx'});published=true;
    }
  };
  return {child,stop,publishReady};
}
async function start(){
  let shutting=false,launched;const cancellation=new AbortController();
  async function shutdown(code){if(shutting)return;shutting=true;
    cancellation.abort();
    const results=await Promise.allSettled([...owned].map(stopOwnedCommand).concat(launched?[launched.stop()]:[]));fs.rmSync(secretPath,{force:true});
    process.exit(results.some(result=>result.status==='rejected')?1:code);}
  process.once('SIGTERM',()=>void shutdown(0));process.once('SIGINT',()=>void shutdown(0));
  process.once('exit',()=>fs.rmSync(secretPath,{force:true}));
  try{
    const port=process.env.MCP_ISOLATED_PORT===undefined?8787:Number(process.env.MCP_ISOLATED_PORT);
    if(!Number.isSafeInteger(port)||port<1||port>65535)throw Error('isolated loopback port invalid');
    const source=process.env.GITHUB_SHA;if(source!==undefined&&!/^[a-f0-9]{40}$/.test(source))throw Error('isolated source commit invalid');
    const readinessFile=process.platform==='linux'?path.join(process.env.RUNNER_TEMP??os.tmpdir(),`public-mcp-ready-${process.pid}.json`):undefined;
    launched=await launchIsolatedWorker({port,sourceCommit:source,signal:cancellation.signal,readinessFile,
      identity:readinessFile?launcherIdentity(process.pid):undefined});const {child}=launched;
    child.once('error',()=>{console.error('isolated Worker could not start');void shutdown(1);});
    child.once('exit',code=>{if(!shutting){console.error('isolated Worker exited');void shutdown(code||1);}});
    await launched.publishReady();
  }catch(error){console.error(error.message);await shutdown(1);}
}
if(import.meta.main??process.argv[1]?.split(/[\\/]/).pop()===decodeURIComponent(import.meta.url.split('/').pop())){
  try{if(process.argv[2]==='allocate')console.log(await allocateIsolatedPort());
    else if(process.argv[2]==='record')console.log(launcherIdentity(Number(process.argv[3])));
    else if(process.argv[2]==='ready'){
      const identity=process.argv[3];if(!/^\d+:\d+$/.test(identity)||launcherIdentity(Number(identity.split(':')[0]))!==identity)throw Error('isolated launcher identity mismatch');
      const pid=Number(identity.split(':')[0]);
      await waitForIsolatedReady({url:process.env.MCP_ISOLATED_URL,pid,sourceCommit:process.env.GITHUB_SHA,expectedIdentity:identity,
        readinessFile:path.join(process.env.RUNNER_TEMP??os.tmpdir(),`public-mcp-ready-${pid}.json`)});
    }
    else if(process.argv[2]==='stop')await stopRecordedLauncher(process.argv[3]);
    else if(process.argv[2]===undefined)await start();else throw Error('isolated launcher mode invalid');
  }catch(error){console.error(error.message);process.exitCode=1;}
}
