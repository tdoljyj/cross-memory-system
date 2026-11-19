// 在演练来宾收集的公开观测可离线核验。输入目录只有六份 JSON，没有凭据。
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
  const [profile,system,resident,controller,companion,probe]=await Promise.all(
    ['profile.json','system.json','resident.json','controller.json','companion.json','probe.json'].map(load));
  const now=Date.now();
  const validSid=s=>typeof s==='string' && /^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/.test(s);
  const distinct=validSid(profile.controllerSid) && validSid(profile.ownerSid) && profile.ownerSid!==profile.controllerSid;
  const checks=keyCheck(system,resident,controller,companion,profile,now);
  // 未登记来宾收到网关的 403 身份拒绝，证明 DNS、TLS、路由、限速绑定存在以及 SYSTEM 出站可达。
  // 已登记身份签名能否被接受仍需真实验证，首次验证安排在 11-25 的 TURING 升级中。
  const probeAt=Date.parse(probe.at);
  const reachable=probe.code==='RENEW_IDENTITY_REFUSED' && probeAt<=now && now-probeAt<=86_400_000;
  // The drill must exercise both installed files. ABSENT is sufficient for the daily
  // pre-renewal check, but cannot demonstrate a denied file open in the guest.
  const filesDenied=companion['ci-admission.token']==='DENIED' && companion['ci-admission.connection.json']==='DENIED';
  const tpm=system?.provider==='Microsoft Platform Crypto Provider';
  const passed=tpm && distinct && reachable && filesDenied && checks.result==='PASS';
  console.log(JSON.stringify({result:passed?'PASS':'FAIL',identities:distinct,gateway:reachable,checks,
    ...(!tpm && {code:'DRILL_TPM_PROVIDER_REQUIRED'})}));
  process.exitCode=passed?0:1;
} catch {console.log('{"result":"FAIL","code":"DRILL_EVIDENCE_UNAVAILABLE"}');process.exitCode=1;}
