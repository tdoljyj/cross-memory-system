// Fixed files only. No credentials read, service enable/start, or authorization.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BASE,PACKAGE,CONTEXT,ROOT,RUN,SOURCE,APP,HASH,hash,fail,parents,protectedBytes,utf8,readContext,verifyPackage,verifyBuildFiles,renderPublisherUnit} from './payload/release/existing-release-entry-v1/v3-host/host-files.mjs';
function directory(p,uid,gid,mode){
 parents(p);
 if(fs.existsSync(p)){const s=fs.lstatSync(p);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||s.gid!==gid||(s.mode&0o777)!==mode)fail('EXISTING_DIRECTORY_DIFFERS_NO_CHANGE');return;}
 fs.mkdirSync(p,{mode});fs.chownSync(p,uid,gid);fs.chmodSync(p,mode);
}
function file(p,bytes,uid=0,gid=0,mode=0o444){
 parents(p);
 if(fs.existsSync(p)){const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==uid||s.gid!==gid||((s.mode&0o777)!==mode&&!(uid===0&&gid===0&&mode===0o444&&!(s.mode&0o022)&&(s.mode&0o004)))||!fs.readFileSync(p).equals(bytes))fail('EXISTING_FILE_DIFFERS_NO_CHANGE');return;}
 const fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,mode);
 try{fs.writeFileSync(fd,bytes);fs.fchownSync(fd,uid,gid);fs.fchmodSync(fd,mode);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 const d=fs.openSync(path.dirname(p),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
}
function installParents(p){const rel=path.relative(BASE,path.dirname(p));if(rel.startsWith('..')||path.isAbsolute(rel))fail('FIXED_INSTALL_ROOT_REQUIRED');let dir=BASE;for(const piece of rel.split(path.sep).filter(Boolean)){dir=path.join(dir,piece);directory(dir,0,0,0o755);}}
function actualUser(uid,gid){
 const rows=utf8(protectedBytes('/etc/passwd',1024*1024)).trim().split('\n').map(s=>s.split(':')),row=rows.filter(r=>Number(r[2])===uid);
 if(row.length!==1||Number(row[0][3])!==gid||!/^[a-z_][a-z0-9_-]*[$]?$/.test(row[0][0]))fail('EXISTING_DEDICATED_USER_REQUIRED');
 const name=row[0][0],groups=utf8(protectedBytes('/etc/group',1024*1024)).trim().split('\n').map(s=>s.split(':'));
 if(groups.some(g=>(Number(g[2])===0||g[0]==='docker')&&(Number(g[2])===gid||g[3].split(',').includes(name))))fail('ROOT_OR_DOCKER_GROUP_FORBIDDEN');return name;
}
export async function main(argv=[]){
 if(argv.length===0)return {status:'DISABLED',code:'NO_HOST_READ'};
 if(argv.length!==7||argv[0]!=='--install-once'||argv[1]!=='--fixed-scope'||argv[2]!=='existing-release-v3-host-install'||argv[3]!=='--reviewed-context-sha256'||!HASH.test(argv[4])||argv[5]!=='--reviewed-package-sha256'||!HASH.test(argv[6]))return {status:'BLOCKED',code:'FIXED_EXPLICIT_SCOPE_REQUIRED'};
 try{
  const c=readContext(argv[4],{install:true}),manifest=verifyPackage(argv[6],{install:true});verifyBuildFiles(c);
  const managerBytes=protectedBytes(PACKAGE+'/currentness-manager.json',65536);if(hash(managerBytes)!==c.managerConfigSha256)fail('REVIEWED_MANAGER_CONTEXT_CHANGED');
  const managerModule=await import('./payload/release/linux-process-manager.mjs');
  const m=managerModule.validateManagerConfig(JSON.parse(utf8(managerBytes)));
  if(m.uid!==c.publisherUid||m.job_gid===c.publisherGid||m.source_root!==SOURCE||m.source_commit!==c.sourceCommit||m.node.path!==c.node.path||m.node.sha256!==c.node.sha256||m.git.path!==c.git.path||m.git.sha256!==c.git.sha256||m.manager.path!==BASE+'/release/linux-process-manager.mjs'||m.manager.sha256!==manifest.files['payload/release/linux-process-manager.mjs'].sha256||m.state_dir!==ROOT+'/manager-state'||m.output_dir!==ROOT+'/manager-output'||m.environment.HOME!==ROOT+'/job-home'||m.environment.TMPDIR!==ROOT+'/job-tmp')fail('SAME_FIXED_MANAGER_BINDING_REQUIRED');
  const publisher=actualUser(c.publisherUid,c.publisherGid),job=actualUser(m.job_uid,m.job_gid);
  const publisherGroups=utf8(protectedBytes('/etc/group',1024*1024)).trim().split('\n').map(line=>line.split(':')).filter(row=>Number(row[2])===c.publisherGid);
  if(publisherGroups.length!==1||publisherGroups[0][3].split(',').includes(job))fail('JOB_MUST_NOT_READ_PUBLISHER_SECRETS');
  const managerUnit=Buffer.from(managerModule.renderFixedSystemdUnit(m));if(hash(managerUnit)!==m.unit_template.sha256)fail('REVIEWED_MANAGER_UNIT_CHANGED');
  for(const p of [m.systemctl.path,c.node.path,c.git.path])protectedBytes(p);
  if(hash(protectedBytes(m.systemctl.path))!==m.systemctl.sha256)fail('SYSTEMCTL_PIN_CHANGED');
  directory(BASE,0,0,0o755);
  for(const [name,pin] of Object.entries(manifest.files)){const dest=BASE+'/'+name.replace(/^payload\//,'');installParents(dest);file(dest,protectedBytes(PACKAGE+'/'+name));}
  file(BASE+'/package-manifest.json',protectedBytes(PACKAGE+'/package-manifest.json'));
  directory('/etc/clued-production-release',0,c.publisherGid,0o750);directory('/etc/clued-production-release/secrets',0,c.publisherGid,0o750);
  directory('/etc/clued',0,0,0o755);
  directory(ROOT,0,0,0o755);
  for(const leaf of ['run','currentness-evidence','publisher-home','publisher-tmp','manager-state'])directory(ROOT+'/'+leaf,c.publisherUid,c.publisherGid,0o700);
  for(const leaf of ['job-home','job-tmp'])directory(ROOT+'/'+leaf,m.job_uid,m.job_gid,0o700);
  directory(ROOT+'/manager-output',0,m.job_gid,0o750);
  for(const op of ['head','branch','status','tests'])for(const suffix of ['stdout','stderr','result.json'])file(ROOT+'/manager-output/'+op+'.'+suffix,Buffer.alloc(0),m.job_uid,m.job_gid,0o640);
  directory(APP+'/.wrangler',c.publisherUid,c.publisherGid,0o700);
  file(CONTEXT,protectedBytes(PACKAGE+'/existing-release.json'));
  file('/etc/clued/currentness-manager.json',managerBytes);file('/etc/systemd/system/clued-currentness@.service',managerUnit);
  const rule='polkit.addRule(function(action,subject){if(action.id==="org.freedesktop.systemd1.manage-units"&&subject.user==='+JSON.stringify(publisher)+'&&["start","stop"].indexOf(action.lookup("verb"))>=0&&["clued-currentness@head.service","clued-currentness@branch.service","clued-currentness@status.service","clued-currentness@tests.service"].indexOf(action.lookup("unit"))>=0)return polkit.Result.YES;});\n';
  file('/etc/polkit-1/rules.d/49-clued-currentness-release-v3.rules',Buffer.from(rule));
  const unit=Buffer.from(renderPublisherUnit(c,m,argv[4],argv[6]));file('/etc/systemd/system/clued-existing-release-once.service',unit);
  return {status:'PAYLOAD_FILES_INSTALLED_DISABLED',contextSha256:argv[4],packageSha256:argv[6],publisherUnitSha256:hash(unit),daemonReloadPerformed:false,serviceEnabled:false,serviceStarted:false,credentialsRead:false,sourceHostQualificationClaimed:false,productionAuthorized:false};
 }catch(e){return {status:'BLOCKED_OR_PARTIAL_INSTALL_RECONCILE',code:/^[A-Z][A-Z0-9_]{1,90}$/.test(e?.code??'')?e.code:'FIXED_INSTALL_UNCONFIRMED',automaticRetryAllowed:false};}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const r=await main(process.argv.slice(2));process.stdout.write(JSON.stringify(r)+'\n');process.exitCode=['DISABLED','PAYLOAD_FILES_INSTALLED_DISABLED'].includes(r.status)?0:2;}
