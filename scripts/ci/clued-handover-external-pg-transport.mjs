// Public fixed transport only. No environment, credentials, Client, connect,
// query, fallback, retry or budget is owned by this module.
import fs from 'node:fs';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const PG_IDENTITY_SQL='SELECT current_database() AS database, current_user AS "current_user", session_user AS "session_user"';
export const PG_CA_SHA256='700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7';
export const FIXED_PG_TRANSPORT=Object.freeze({platform_base:'supabase',supabase_project_ref:'qhddedibkuqoiiwlonwe',
  database_transport:'supabase-session-pooler-tls',database_host:'aws-0-ap-northeast-2.pooler.supabase.com',
  database_port:5432,database_name:'postgres',database_login:'postgres.qhddedibkuqoiiwlonwe',provisioner_role:'postgres'});
const databases=new Set(['postgres','template1']),certificates=new WeakMap();
const fail=code=>{throw Object.assign(new Error(code),{code});};
const caPath=fileURLToPath(new URL('./resources/supabase-official-prod-ca-2021.crt',import.meta.url));
export function assertPgTransportProfile(profile){
  for(const [key,value]of Object.entries(FIXED_PG_TRANSPORT))if(profile?.[key]!==value)fail('PG_TRANSPORT_PROFILE_REJECTED');
  if(profile.database_login!==profile.provisioner_role+'.'+profile.supabase_project_ref)fail('PG_LOGIN_ALIAS_REJECTED');
  return FIXED_PG_TRANSPORT;
}
function sameFile(a,b){return a.isFile()&&b.isFile()&&a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs;}
function fixedCa(){
  let descriptor;
  try{
    const before=fs.lstatSync(caPath,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink()||before.size!==1367n)fail('PG_CA_REJECTED');
    descriptor=fs.openSync(caPath,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    const opened=fs.fstatSync(descriptor,{bigint:true});
    if(!sameFile(before,opened))fail('PG_CA_REJECTED');
    const bytes=fs.readFileSync(descriptor),after=fs.lstatSync(caPath,{bigint:true});
    if(!sameFile(opened,after)||bytes.length!==1367||crypto.createHash('sha256').update(bytes).digest('hex')!==PG_CA_SHA256)
      fail('PG_CA_REJECTED');
    return bytes;
  }catch{fail('PG_CA_REJECTED');}finally{if(descriptor!==undefined)try{fs.closeSync(descriptor);}catch{}}
}
// Call before consulting any secret ingress or constructing any pg Client.
export function preparePgTransport(profile){
  assertPgTransportProfile(profile);const bytes=fixedCa();
  const prepared=Object.freeze({...FIXED_PG_TRANSPORT,ca_sha256:PG_CA_SHA256,ca_bytes:1367});
  certificates.set(prepared,bytes);return prepared;
}
export function makePgClientConfig(prepared,rawIngress,{database}={}){
  const certificate=certificates.get(prepared);
  if(!certificate)fail('PG_TRANSPORT_NOT_PREPARED');
  if(!databases.has(database))fail('PG_DATABASE_REJECTED');
  let password;
  try{
    if(typeof rawIngress!=='string'||rawIngress.length===0||rawIngress.includes('?')||rawIngress.includes('#'))
      fail('PG_INGRESS_REJECTED');
    const url=new URL(rawIngress);
    if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!==FIXED_PG_TRANSPORT.database_host||
      Number(url.port||5432)!==5432||decodeURIComponent(url.username)!==FIXED_PG_TRANSPORT.database_login||
      decodeURIComponent(url.pathname.slice(1))!=='postgres'||url.search||url.hash)
      fail('PG_INGRESS_REJECTED');
    password=decodeURIComponent(url.password);if(password.length===0)fail('PG_INGRESS_REJECTED');
  }catch{fail('PG_INGRESS_REJECTED');}
  return {host:FIXED_PG_TRANSPORT.database_host,port:5432,user:FIXED_PG_TRANSPORT.database_login,password,database,
    ssl:{ca:Buffer.from(certificate),servername:FIXED_PG_TRANSPORT.database_host,rejectUnauthorized:true},sslnegotiation:'postgres'};
}
// Execute PG_IDENTITY_SQL through the caller's original bounded query wrapper;
// this function performs no SQL and cannot reset or add any query allowance.
export function assertPgIdentity(result,database){
  if(!databases.has(database))fail('PG_DATABASE_REJECTED');
  try{
    if(!Array.isArray(result?.rows)||result.rows.length!==1)fail('PG_IDENTITY_REJECTED');
    const row=result.rows[0];
    if(!row||Object.keys(row).sort().join(',')!=='current_user,database,session_user'||row.database!==database||
      row.current_user!=='postgres'||row.session_user!=='postgres')fail('PG_IDENTITY_REJECTED');
    return {database:row.database,current_user:row.current_user,session_user:row.session_user};
  }catch{fail('PG_IDENTITY_REJECTED');}
}
