// Fixed Docker transport only. Killing this CLI never proves container cleanup;
// an unknown transport result returns to the existing container observer.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const environment=()=>({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',HOME:'/nonexistent',DOCKER_CONFIG:'/nonexistent'});
// Pure child observation is exported for offline lifecycle tests. Production
// never accepts an injected spawn, executable, environment or process object.
export function observeDockerChild(p,{timeoutMs=10000,maxOutputBytes=65536,digestOnly=false,signal}={}){
  return new Promise(resolve=>{
    const streams=Object.fromEntries(['stdout','stderr'].map(k=>[k,{hash:createHash('sha256'),bytes:0,truncated:false}]));
    const parts=[];let total=0,timedOut=false,overflow=false,error=false,ended=false,timer,settleTimer;
    const finish=code=>{if(ended)return;ended=true;clearTimeout(timer);clearTimeout(settleTimer);signal?.removeEventListener('abort',abort);
      resolve({code,timedOut,overflow,error,stdout:digestOnly?'':Buffer.concat(parts).toString('utf8'),logs:Object.fromEntries(Object.entries(streams).map(([k,v])=>[k,{sha256:v.hash.digest('hex'),bytes:v.bytes,truncated:v.truncated}]))});};
    const stop=()=>{if(ended)return;try{p.kill('SIGKILL');}catch{error=true;}
      // Keep this bounded timer referenced: even a missing close must settle.
      if(!settleTimer)settleTimer=setTimeout(()=>finish(null),250);};
    const abort=()=>{if(ended)return;timedOut=true;stop();};
    timer=setTimeout(abort,timeoutMs);
    for(const key of ['stdout','stderr'])p[key].on('data',chunk=>{if(ended)return;streams[key].hash.update(chunk);streams[key].bytes+=chunk.length;total+=chunk.length;
      if(total>maxOutputBytes){overflow=true;streams[key].truncated=true;stop();}else if(!digestOnly&&key==='stdout')parts.push(chunk);});
    p.once('error',()=>{error=true;finish(null);});p.once('close',finish);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}
export function dockerInvoke(args,options={}){
  const child=spawn('/usr/bin/docker',['--host','unix:///run/docker.sock',...args],{shell:false,env:environment(),stdio:['ignore','pipe','pipe']});
  return observeDockerChild(child,options);
}
