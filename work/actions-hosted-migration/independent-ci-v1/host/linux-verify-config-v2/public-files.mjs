import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';

export const MAX=1048576;
export const ROOT='/etc/clued-independent-ci';
export const SPOOL='/var/lib/clued-independent-ci/verify-spool';
export const NODE='/opt/actions-runner/externals/node24/bin/node';
export const ENTRY='/opt/clued-independent-ci/verify-worker.mjs';
export const KEY_ID='turing-first-run-1f79dd8e6c5099474a0e0962';
export const PUBLIC_SHA='a8bc91a25b167b2d722184b518d4771a30e28bd47dcc9efaa9e1806a5bc615c1';
export const RUNTIME={
  [NODE]:'bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12',
  '/usr/bin/docker':'7ed12b00293d64742419a6601ae97960a367a0ce97c88b06e3278cc0a409557b',
  '/usr/bin/git':'2a8c18fbf43da9f692d75474c72bea9dfd796c260b0f3dfe456376abc3bbd668',
  [ENTRY]:'aeb5719d49a7070258fe93d6a541fa3f26125b53e180f3130d94e57929949ab3',
  '/opt/clued-independent-ci/worker-source.mjs':'67803ba150f0b22af5459af4b83f7910835221caea845a54a46a70d39ec7608c'
};
export const SHA=/^[a-f0-9]{64}$/;
export const fail=code=>{throw Object.assign(new Error(code),{code});};
export const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
export function canonical(v){
  if(v===null||typeof v==='string'||typeof v==='boolean')return JSON.stringify(v);
  if(typeof v==='number'&&Number.isFinite(v))return JSON.stringify(v);
  if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;
  if(v&&Object.getPrototypeOf(v)===Object.prototype)return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  fail('JSON_VALUE_REFUSED');
}
export function decode(bytes,maximum=MAX){
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>maximum)fail('PUBLIC_BYTES_BOUND');
  const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes))fail('UTF8_REQUIRED');
  try{return JSON.parse(text);}catch{fail('JSON_REQUIRED');}
}
export async function readBounded(filename,maximum=MAX){
  const before=await fsp.lstat(filename);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size<1||before.size>maximum)fail('PUBLIC_FILE_BOUNDARY');
  const h=await fsp.open(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const same=s=>s.dev===before.dev&&s.ino===before.ino&&s.size===before.size&&s.mtimeMs===before.mtimeMs&&s.nlink===1;
    if(!same(await h.stat()))fail('PUBLIC_INPUT_CHANGED');const b=Buffer.allocUnsafe(before.size);let offset=0;
    while(offset<b.length){const {bytesRead}=await h.read(b,offset,b.length-offset,null);if(!bytesRead)fail('PUBLIC_INPUT_CHANGED');offset+=bytesRead;}
    if(!same(await h.stat())||!same(await fsp.lstat(filename))||b.length!==before.size)fail('PUBLIC_INPUT_CHANGED');return b;
  }finally{await h.close();}
}
export async function protectedPath(filename,{directory=false,privateFile=false,metadataOnly=false}={}){
  if(process.platform!=='linux'||process.getuid?.()!==0||!path.posix.isAbsolute(filename)||path.posix.normalize(filename)!==filename)fail('ROOT_FIXED_LINUX_REQUIRED');
  let p='/';for(const part of filename.split('/').filter(Boolean)){p=path.join(p,part);const s=await fsp.lstat(p);
    if(s.isSymbolicLink()||s.uid!==0||(s.mode&0o022))fail('ROOT_PROTECTION_REQUIRED');}
  const s=await fsp.lstat(filename);
  if(directory?!s.isDirectory():!s.isFile()||s.nlink!==1)fail('PROTECTED_TYPE_REQUIRED');
  if(privateFile&&(s.mode&0o077))fail('PRIVATE_FILE_METADATA_REQUIRED');
  return s; // metadataOnly documents that private-key contents are never opened.
}
export async function syncDir(directory){const h=await fsp.open(directory,'r');try{await h.sync();}finally{await h.close();}}
export async function publishCompletedNew(temporary,filename){await fsp.link(temporary,filename);}
// The final name is linked only after a complete fsynced temporary file exists.
// link() has create-new semantics: pre-existing names are never replaced.
export async function atomicNew(filename,bytes,mode=0o600){
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX)fail('PUBLIC_BYTES_BOUND');
  const temp=path.join(path.dirname(filename),`.public-transfer-${randomBytes(16).toString('hex')}.tmp`);
  let created=false;
  try{
    const h=await fsp.open(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,mode);created=true;
    try{await h.chmod(mode);await h.writeFile(bytes);await h.sync();}finally{await h.close();}
    await publishCompletedNew(temp,filename);await syncDir(path.dirname(filename));
  }finally{if(created){await fsp.unlink(temp);await syncDir(path.dirname(filename));}}
}
export async function checkInstalled(){
  if(process.platform!=='linux'||process.getuid?.()!==0||process.execPath!==NODE)fail('FIXED_ROOT_NODE_REQUIRED');
  for(const [file,pin] of Object.entries(RUNTIME)){
    await protectedPath(file);if(sha(await readBounded(file,134217728))!==pin)fail('ACTUAL_RUNTIME_DRIFT');
  }
  for(const dir of ['/etc/clued-independent-ci','/var/lib/clued-independent-ci/trusted-source','/var/lib/clued-independent-ci/workspaces',
    '/var/lib/clued-independent-ci/verify-once-state',SPOOL,path.join(SPOOL,'results')])await protectedPath(dir,{directory:true});
  await protectedPath(ROOT+'/verify-result-key.pem',{privateFile:true,metadataOnly:true});
  await protectedPath(ROOT+'/verify-result-public.pem');
  if(sha(await readBounded(ROOT+'/verify-result-public.pem',16384))!==PUBLIC_SHA)fail('ACTUAL_PUBLIC_KEY_DRIFT');
}
