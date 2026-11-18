// Shared offline checks for the v7 and v8 Host packages. Run on the Linux Host as the publisher
// (uid 995) inside a transient unit that carries every [Service] setting of the
// installed clued-existing-release-once.service except ExecStart, after the candidate is
// installed and systemd reloaded, before the first release:
//   node offline-checks-v7.mjs <candidate-dir> <v6-dir> [/run/WSL/<pid>_interop ...]
// Root lists the interop sockets outside the sandbox and passes their paths.
// Nothing is written except one /dev/shm probe that must fail.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const [v7,v6,...sockets]=process.argv.slice(2);
const hash=b=>createHash('sha256').update(b).digest('hex');
const results=[];const check=(name,ok,detail='')=>results.push({name,ok:!!ok,detail:String(detail).slice(0,300)});
const code=run=>{try{run();return 'PASS';}catch(e){return e.code??e.message;}};
const files=['install-once.mjs','payload/release/existing-release-entry-v1/fixed-currentness-ports.mjs','payload/release/existing-release-entry-v1/v3/existing-stages.mjs','payload/release/existing-release-entry-v1/v3-host/host-files.mjs','payload/release/existing-release-entry-v1/v3-host/release-once.mjs','payload/release/linux-process-manager.mjs','payload/release/verify-currentness-external.mjs'];
const MANAGER='payload/release/linux-process-manager.mjs',HOST_FILES='payload/release/existing-release-entry-v1/v3-host/host-files.mjs';
const changed=[MANAGER,HOST_FILES,'payload/release/existing-release-entry-v1/v3-host/release-once.mjs','payload/release/existing-release-entry-v1/v3/existing-stages.mjs'];
for(const f of files){const r=spawnSync(process.execPath,['--check',path.join(v7,f)],{encoding:'utf8'});check('syntax:'+f,r.status===0,r.stderr.trim());}
for(const f of files.filter(f=>!changed.includes(f)))check('unchanged-from-v6:'+f,fs.readFileSync(path.join(v7,f)).equals(fs.readFileSync(path.join(v6,f))));
check('v6 dir is the installed revision 6',hash(fs.readFileSync(path.join(v6,'package-manifest.json')))==='71ee46c6c0d5bb0bafa5a85a5445b11c4f0b534141eb25010b06b51da04b8bf4');
const context=JSON.parse(fs.readFileSync('/etc/clued-production-release/existing-release.json','utf8'));
check('runs as the publisher',process.getuid()===context.publisherUid&&process.getgid()===context.publisherGid,process.getuid()+':'+process.getgid());
const m=JSON.parse(fs.readFileSync(path.join(v7,'package-manifest.json'),'utf8'));
for(const f of files)check('manifest:'+f,m.files[f]?.sha256===hash(fs.readFileSync(path.join(v7,f)))&&m.files[f].bytes===fs.statSync(path.join(v7,f)).size);
const revision8=m.revision===8;
const manifestHash=hash(fs.readFileSync(path.join(v7,'package-manifest.json')));
const v7Manifest='c9b1a43105bdfcf8631e1abeec0c3552a56797bb259f3bccd767899953bacc8c';
check('candidate manifest and predecessor', revision8
 ? manifestHash==='41a8368c6e14d7f704b3dc9fc56d8db73b2c2d20956dde40fc0bc7cae38eef7b' && m.previousPackageManifestSha256===v7Manifest
 : m.revision===7 && manifestHash===v7Manifest && m.previousPackageManifestSha256==='71ee46c6c0d5bb0bafa5a85a5445b11c4f0b534141eb25010b06b51da04b8bf4');
const stages=fs.readFileSync(path.join(v7,'payload/release/existing-release-entry-v1/v3/existing-stages.mjs'),'utf8');
check('existing-stages pins the v7 manager',stages.includes(`[MANAGER,'${m.files[MANAGER].sha256}']`));
for(const f of files.filter(f=>f.startsWith('payload/')))check('installed:'+f,fs.readFileSync('/opt/clued-production-release-v3/'+f.slice('payload/'.length)).equals(fs.readFileSync(path.join(v7,f))));
check('installed manifest matches candidate',fs.readFileSync('/opt/clued-production-release-v3/package-manifest.json').equals(fs.readFileSync(path.join(v7,'package-manifest.json'))));
check('manager config pins the v7 manager',JSON.parse(fs.readFileSync('/etc/clued/currentness-manager.json','utf8')).manager?.sha256===m.files[MANAGER].sha256);
const manager=await import(path.join(v7,MANAGER)),host=await import(path.join(v7,HOST_FILES));
// The installed unit files, and what systemd loaded from them.
const want=host.INACCESSIBLE.join(' ');
for(const unit of ['clued-currentness@.service','clued-existing-release-once.service']){
 const lines=fs.readFileSync('/etc/systemd/system/'+unit,'utf8').split('\n');
 check('unit file blocks /run/WSL and /dev/shm:'+unit,lines.filter(l=>l.startsWith('InaccessiblePaths=')).join('|')==='InaccessiblePaths='+want);
 check('nothing else names /run/WSL or /dev/shm:'+unit,lines.every(l=>l.startsWith('InaccessiblePaths=')||!/\/run\/WSL|\/dev\/shm/.test(l)));
}
const systemctl=args=>spawnSync('/usr/bin/systemctl',['--no-ask-password','--no-pager','show',...args],{encoding:'utf8'});
const props=JSON.parse(fs.readFileSync(path.join(v7,MANAGER),'utf8').match(/const UNIT_PROPERTIES=(\[[^\]]*\])/)[1].replaceAll("'",'"'));
const config=JSON.parse(fs.readFileSync('/etc/clued/currentness-manager.json','utf8'));
const shown=systemctl(['clued-currentness@head.service','--property='+props.join(',')]);
check('v7 manager accepts the loaded currentness unit',shown.status===0&&code(()=>manager.parseSystemdShow(shown.stdout,config,'head'))==='PASS',code(()=>manager.parseSystemdShow(shown.stdout,config,'head')));
const release=systemctl(['clued-existing-release-once.service','--property=InaccessiblePaths']).stdout.trim();
check('loaded release unit blocks /run/WSL and /dev/shm',release.startsWith('InaccessiblePaths=')&&release.slice('InaccessiblePaths='.length).split(/\s+/).sort().join('|')===[...host.INACCESSIBLE].sort().join('|'),release);
// This process runs in the release unit's sandbox: both channels are closed.
check('host-files boundary passes in the release sandbox',code(()=>host.interopBoundary())==='PASS',code(()=>host.interopBoundary()));
check('manager boundary passes in the release sandbox',code(()=>manager.interopBoundary())==='PASS',code(()=>manager.interopBoundary()));
check('interop sockets were listed outside the sandbox',sockets.length>0&&sockets.every(s=>/^\/run\/WSL\/[0-9]+_interop$/.test(s)),sockets.join(','));
for(const s of sockets){
 const r=await new Promise(done=>{const c=net.connect(s);const t=setTimeout(()=>{c.destroy();done('TIMEOUT');},5000);
  c.once('connect',()=>{clearTimeout(t);c.destroy();done('CONNECTED');});c.once('error',e=>{clearTimeout(t);done(e.code);});});
 check('interop socket unreachable:'+s,r==='EACCES'||r==='ENOENT',r);
}
// End to end: the binfmt handler (/init) cannot reach interop, so a Windows program does not start.
const exe='/mnt/c/Windows/System32/whoami.exe',win=spawnSync(exe,[],{encoding:'utf8',timeout:15000});
check('a Windows program cannot start here',fs.existsSync(exe)&&win.status!==0&&win.error?.code!=='ETIMEDOUT',`status=${win.status} error=${win.error?.code??''} ${(win.stderr??'').trim()}`);
// ProtectProc=invisible hides only other users' processes: a publisher process
// outside this unit would expose both paths through /proc/<pid>/root.
const own=fs.readFileSync('/proc/self/cgroup','utf8');
const outside=fs.readdirSync('/proc').filter(p=>/^[0-9]+$/.test(p)).filter(p=>{try{return fs.statSync('/proc/'+p).uid===process.getuid()&&fs.readFileSync(`/proc/${p}/cgroup`,'utf8')!==own;}catch{return false;}});
check('no publisher process outside this unit',outside.length===0,outside.join(','));
const shm=code(()=>fs.writeFileSync('/dev/shm/clued-v7-probe','x',{flag:'wx',mode:0o600}));
if(shm==='PASS')fs.unlinkSync('/dev/shm/clued-v7-probe');
check('/dev/shm not writable',shm==='EACCES'||shm==='ENOENT',shm);
for(const [f,expect] of [['payload/release/existing-release-entry-v1/v3-host/release-once.mjs','DISABLED'],['install-once.mjs','DISABLED']]){
 const r=spawnSync(process.execPath,[path.join(v7,f)],{encoding:'utf8',cwd:v7});check('default disabled:'+f,r.stdout.includes(`"status":"${expect}"`),r.stdout.trim());
}
const pass=results.every(x=>x.ok);
process.stdout.write(JSON.stringify({contract:revision8?'clued.existing-release-v8-host-offline-checks/1':'clued.existing-release-v7-host-offline-checks/1',uid:process.getuid(),packageManifestSha256:hash(fs.readFileSync(path.join(v7,'package-manifest.json'))),checks:results.length,pass,results},null,1)+'\n');
process.exitCode=pass?0:1;
