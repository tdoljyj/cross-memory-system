// Candidate only. Importing performs no I/O. These two concrete ports confer no authority.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

export const ATTESTATION_CREDENTIAL='/etc/clued-production-release/secrets/attestation-database-url';
export const EVIDENCE_ROOT='/var/lib/clued-production-release/currentness-evidence';
const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
function publisherIdentity(){
  if(process.platform!=='linux'||!Number.isSafeInteger(process.getuid?.())||process.getuid()<1||!Number.isSafeInteger(process.getgid?.())||process.getgid()<1)fail('RELEASE_DEDICATED_LINUX_PUBLISHER_REQUIRED');
  return {uid:process.getuid(),gid:process.getgid()};
}
function rootParents(file){
  for(let p=path.dirname(file);;p=path.dirname(p)){
    const s=fs.lstatSync(p);
    if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))fail('RELEASE_ROOT_PROTECTED_PARENT_REQUIRED');
    if(p==='/')break;
  }
}
function readFixedDatabaseCredential(){
  const {gid}=publisherIdentity();rootParents(ATTESTATION_CREDENTIAL);
  const before=fs.lstatSync(ATTESTATION_CREDENTIAL);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.uid!==0||before.gid!==gid||(before.mode&0o777)!==0o440||before.size<1||before.size>8192)fail('RELEASE_ATTESTATION_CREDENTIAL_BOUNDARY_REQUIRED');
  const fd=fs.openSync(ATTESTATION_CREDENTIAL,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const held=fs.fstatSync(fd);
    if(!same(before,held)||held.nlink!==1||held.uid!==0||held.gid!==gid||(held.mode&0o777)!==0o440||held.size!==before.size)fail('RELEASE_ATTESTATION_CREDENTIAL_CHANGED');
    const bytes=fs.readFileSync(fd);
    if(bytes.length!==held.size||!same(held,fs.lstatSync(ATTESTATION_CREDENTIAL)))fail('RELEASE_ATTESTATION_CREDENTIAL_CHANGED');
    const text=bytes.toString('utf8');
    if(!Buffer.from(text).equals(bytes)||text!==text.trim()||/[\x00\r\n]/.test(text))fail('RELEASE_ATTESTATION_CREDENTIAL_FORMAT');
    let url;try{url=new URL(text);}catch{fail('RELEASE_ATTESTATION_CREDENTIAL_FORMAT');}
    if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||!url.password)fail('RELEASE_ATTESTATION_CREDENTIAL_FORMAT');
    return text;
  }finally{fs.closeSync(fd);}
}
function retainedDirectory(){
  const {uid}=publisherIdentity();rootParents(EVIDENCE_ROOT);
  const s=fs.lstatSync(EVIDENCE_ROOT);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||(s.mode&0o777)!==0o700)fail('RELEASE_PRIVATE_EVIDENCE_DIRECTORY_REQUIRED');
  return s;
}
export async function retainExistingCurrentnessEvidence(evidence,options){
  if(options?.exclusive!==true||options.domain!=='production')fail('RELEASE_EXCLUSIVE_PRODUCTION_EVIDENCE_REQUIRED');
  const bytes=Buffer.from(JSON.stringify(evidence));
  if(bytes.length<1||bytes.length>128*1024*1024)fail('RELEASE_EVIDENCE_BOUND');
  const digest=hash(bytes),before=retainedDirectory(),file=path.join(EVIDENCE_ROOT,digest+'.json');
  const directory=fs.openSync(EVIDENCE_ROOT,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  let fd;
  try{
    if(!same(before,fs.fstatSync(directory)))fail('RELEASE_EVIDENCE_DIRECTORY_CHANGED');
    fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);
    const s=fs.fstatSync(fd);
    if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o777)!==0o600||s.size!==bytes.length||!same(s,fs.lstatSync(file))||!same(before,retainedDirectory()))fail('RELEASE_EVIDENCE_COMMIT_UNCONFIRMED');
    fs.fsyncSync(directory);
    return Object.freeze({status:'RETAINED',domain:'production',evidence_sha256:digest,receipt_ref:'file:'+file+'#sha256='+digest});
  }catch(e){
    // Preserve an uncertain CreateNew file. No delete, overwrite or automatic retry.
    fail(e?.code==='EEXIST'?'RELEASE_EVIDENCE_ALREADY_EXISTS':'RELEASE_EVIDENCE_RETENTION_UNCONFIRMED');
  }finally{if(fd!==undefined)fs.closeSync(fd);fs.closeSync(directory);}
}
export async function connectExistingAttestation(sourceRoot){
  // sourceRoot belongs to the Source-accepted publisher, never request/CLI data.
  if(typeof sourceRoot!=='string'||!path.isAbsolute(sourceRoot)||path.normalize(sourceRoot)!==sourceRoot)fail('RELEASE_ACCEPTED_SOURCE_ROOT_REQUIRED');
  publisherIdentity();
  let client;
  try{
    const require=createRequire(path.join(sourceRoot,'apps/clued-cloud/package.json'));
    const {Client}=require('pg');
    client=new Client({connectionString:readFixedDatabaseCredential(),connectionTimeoutMillis:10000,application_name:'clued-existing-release-currentness'});
    await client.connect();return client;
  }catch{if(client){try{await client.end();}catch{}}fail('RELEASE_ATTESTATION_CONNECTION_UNCONFIRMED');}
}
export function attachExistingCurrentnessPorts(trustedPublisher){
  if(!trustedPublisher||typeof trustedPublisher.authorizeCurrentness!=='function'||typeof trustedPublisher.sourceRoot!=='string'||!trustedPublisher.processManager)fail('EXISTING_NATIVE_CURRENTNESS_AUTHORITY_SOURCE_REQUIRED');
  if('retainEvidence' in trustedPublisher||'connectAttestation' in trustedPublisher)fail('RELEASE_EXISTING_PORT_REPLACEMENT_REFUSED');
  return Object.freeze({...trustedPublisher,retainEvidence:retainExistingCurrentnessEvidence,connectAttestation:()=>connectExistingAttestation(trustedPublisher.sourceRoot)});
}
