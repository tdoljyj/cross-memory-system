// 在演练来宾收集的公开观测可离线核验。输入目录只有七份 JSON，没有凭据。
import fs from 'node:fs/promises';
import path from 'node:path';
import { keyCheck } from '../src/connection-renewal.mjs';

const directory=process.argv[2];
if (process.argv.length!==3) throw new Error('需要演练证据目录');
async function load(name) {
  const file=path.join(directory,name);
  const stat=await fs.lstat(file);
  if(!stat.isFile() || stat.size>8192 || stat.nlink!==1) throw new Error('演练观测无效');
  return JSON.parse(await fs.readFile(file,'utf8'));
}
try {
  const [profile,system,resident,controller,companion,probe,record]=await Promise.all(
    ['profile.json','system.json','resident.json','controller.json','companion.json','probe.json','record.json'].map(load));
  const now=Date.now();
  const validSid=s=>typeof s==='string' && /^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/.test(s);
  const distinct=validSid(profile.controllerSid) && validSid(profile.ownerSid) && profile.ownerSid!==profile.controllerSid;
  const checks=keyCheck(system,resident,controller,companion,profile,now);
  // 未登记来宾收到网关的 403 身份拒绝，证明 DNS、TLS、路由、限速绑定存在以及 SYSTEM 出站可达。
  // 已登记身份签名能否被接受仍需真实验证，首次验证安排在 11-25 的 TURING 升级中。
  const probeAt=Date.parse(probe.at);
  const reachable=probe.code==='RENEW_IDENTITY_REFUSED' && probeAt<=now && now-probeAt<=86_400_000;
  // 令牌文件必须实测“拒绝访问”。连接记录以来宾管理员侧实读（record.json）为准（裁定补“对路八处”第 8 处）：存在则陪伴必须
  // “拒绝访问”，不存在则必须报“不存在”，对不上即失败。首装时记录不存在，“记录的拒绝访问”如实登记为未验到；它的真机证据是
  // 已激活节点每天的 keyCheck。
  const admin=record['ci-admission.connection.json'], seen=companion['ci-admission.connection.json'];
  const denial=admin==='PRESENT' && seen==='DENIED' ? 'VERIFIED' : admin==='ABSENT' && seen==='ABSENT' ? 'NOT_VERIFIED_RECORD_ABSENT' : null;
  const filesDenied=companion['ci-admission.token']==='DENIED' && denial!==null;
  const tpm=system?.provider==='Microsoft Platform Crypto Provider';
  const passed=tpm && distinct && reachable && filesDenied && checks.result==='PASS';
  console.log(JSON.stringify({result:passed?'PASS':'FAIL',identities:distinct,gateway:reachable,checks,
    record:{admin:admin??null,companion:seen??null,consistent:denial!==null,denial},
    ...(!tpm && {code:'DRILL_TPM_PROVIDER_REQUIRED'})}));
  process.exitCode=passed?0:1;
} catch {console.log('{"result":"FAIL","code":"DRILL_EVIDENCE_UNAVAILABLE"}');process.exitCode=1;}
