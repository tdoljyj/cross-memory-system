// Offline checks for the v5-host package. Run on the Linux Host as root with the
// pinned node: node offline-checks-v5.mjs <v5-dir> <v4-dir>
// Reads the real `systemctl show` output of the installed (v4) template unit
// once, then exercises the v5 parser on it and on fixed mutations. No unit is
// started, nothing is written outside stdout.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const [v5,v4]=process.argv.slice(2);
const hash=b=>createHash('sha256').update(b).digest('hex');
const results=[];const check=(name,ok,detail='')=>results.push({name,ok:!!ok,detail});
const files=['install-once.mjs','payload/release/existing-release-entry-v1/fixed-currentness-ports.mjs','payload/release/existing-release-entry-v1/v3/existing-stages.mjs','payload/release/existing-release-entry-v1/v3-host/host-files.mjs','payload/release/existing-release-entry-v1/v3-host/release-once.mjs','payload/release/linux-process-manager.mjs','payload/release/verify-currentness-external.mjs'];
for(const f of files){const r=spawnSync(process.execPath,['--check',path.join(v5,f)],{encoding:'utf8'});check('syntax:'+f,r.status===0,r.stderr.trim());}
for(const f of files.filter(f=>!f.endsWith('linux-process-manager.mjs')&&!f.endsWith('existing-stages.mjs')))
 check('unchanged:'+f,fs.readFileSync(path.join(v5,f)).equals(fs.readFileSync(path.join(v4,f))));
const m=JSON.parse(fs.readFileSync(path.join(v5,'package-manifest.json'),'utf8'));
for(const f of files)check('manifest:'+f,m.files[f]?.sha256===hash(fs.readFileSync(path.join(v5,f)))&&m.files[f].bytes===fs.statSync(path.join(v5,f)).size);
const managerSha=m.files['payload/release/linux-process-manager.mjs'].sha256;
check('existing-stages pins new manager',fs.readFileSync(path.join(v5,'payload/release/existing-release-entry-v1/v3/existing-stages.mjs'),'utf8').includes(`[MANAGER,'${managerSha}']`));
const mgr=await import(path.join(v5,'payload/release/linux-process-manager.mjs'));
const c=JSON.parse(fs.readFileSync('/etc/clued/currentness-manager.json','utf8'));
const props=['Id','LoadState','ActiveState','SubState','Result','MainPID','ExecMainCode','ExecMainStatus','InvocationID','ControlGroup','User','Group','KillMode','NoNewPrivileges','ProtectControlGroups','FragmentPath','Delegate','Slice','RemainAfterExit','Type','ExecStart','WorkingDirectory','DropInPaths','NeedDaemonReload','ExecStartPre','ExecStartPost','ExecCondition','ExecStop','ExecStopPost','ExecReload','Environment','EnvironmentFiles','PassEnvironment','UnsetEnvironment','CapabilityBoundingSet','AmbientCapabilities','SupplementaryGroups','ProtectSystem','ProtectHome','PrivateDevices','PrivateTmp','ProtectProc','RestrictSUIDSGID','LockPersonality','UMask','ReadWritePaths','RootDirectory','RootImage','BindPaths','BindReadOnlyPaths','TemporaryFileSystem'];
const real=spawnSync('/usr/bin/systemctl',['--no-ask-password','--no-pager','show','clued-currentness@head.service','--property='+props.join(',')],{encoding:'utf8'}).stdout;
const attempt=text=>{try{mgr.parseSystemdShow(text,c,'head');return 'PASS';}catch(e){return e.code;}};
check('real systemd 255 output passes',attempt(real)==='PASS',attempt(real));
const nl='\n';
const omitted=['ExecStartPre','ExecStartPost','ExecCondition','ExecStop','ExecStopPost','ExecReload','EnvironmentFiles'];
const present=omitted.filter(k=>real.split(nl).some(l=>l.startsWith(k+'=')));
check('real output omits exactly the seven',present.length===0,JSON.stringify(present));
check('explicit empty lines also pass',attempt(real.trimEnd()+nl+omitted.map(k=>k+'=').join(nl))==='PASS');
check('non-empty ExecStop refused',attempt(real.trimEnd()+nl+'ExecStop={ path=/bin/true ; argv[]=/bin/true ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }')==='MANAGER_LOADED_UNIT_MISMATCH');
check('non-empty EnvironmentFiles refused',attempt(real.trimEnd()+nl+'EnvironmentFiles=/etc/x (ignore_errors=no)')==='MANAGER_LOADED_UNIT_MISMATCH');
const drop=k=>real.split(nl).filter(l=>!l.startsWith(k+'=')).join(nl);
for(const k of ['Environment','PassEnvironment','SupplementaryGroups','BindPaths','DropInPaths','ExecStart','User'])check('missing '+k+' still refused',attempt(drop(k))!=='PASS',attempt(drop(k)));
check('unknown key still refused',attempt(real.trimEnd()+nl+'Foo=bar')==='MANAGER_SYSTEMD_REPLY_INVALID');
check('duplicate key still refused',attempt(real.trimEnd()+nl+'User=994')==='MANAGER_SYSTEMD_REPLY_INVALID');
for(const [f,expect] of [['payload/release/existing-release-entry-v1/v3-host/release-once.mjs','DISABLED'],['install-once.mjs','DISABLED']]){
 const r=spawnSync(process.execPath,[path.join(v5,f)],{encoding:'utf8',cwd:v5});check('default disabled:'+f,r.stdout.includes(`"status":"${expect}"`),r.stdout.trim());
}
const g=spawnSync(process.execPath,[path.join(v5,'payload/release/linux-process-manager.mjs')],{encoding:'utf8'});
check('manager CLI blocked without systemd job',g.stdout.includes('PROTECTED_SYSTEMD_CONFIG_AND_PUBLISHER_REQUIRED'),g.stdout.trim());
const pass=results.every(r=>r.ok);
process.stdout.write(JSON.stringify({contract:'clued.existing-release-v5-host-offline-checks/1',packageManifestSha256:hash(fs.readFileSync(path.join(v5,'package-manifest.json'))),managerSha256:managerSha,checks:results.length,pass,results},null,1)+'\n');
process.exitCode=pass?0:1;
