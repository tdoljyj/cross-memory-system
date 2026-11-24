// 在演练来宾收集的公开观测可离线核验。输入目录有八份 JSON，没有凭据：七份是来宾观测，network.json 由宿主写，内容只有演练
// 在来宾里切断的主机名单（kit 的 server.blackholeHosts）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyCheck } from '../src/connection-renewal.mjs';

const directory=process.argv[2];
if (process.argv.length!==3) throw new Error('需要演练证据目录');
async function load(name) {
  const file=path.join(directory,name);
  const stat=await fs.lstat(file);
  if(!stat.isFile() || stat.size>8192 || stat.nlink!==1) throw new Error('演练观测无效');
  return JSON.parse(await fs.readFile(file,'utf8'));
}
// 续期网关的主机只有一处来源：包内 windows/SwapBroker.cs 的 Route 常量（写死，谁也冒充不了），这里直接读它，不另抄。
async function gatewayHost() {
  try {
    const text=await fs.readFile(fileURLToPath(new URL('../windows/SwapBroker.cs', import.meta.url)),'utf8');
    return /const\s+string\s+Route\s*=\s*"https:\/\/([a-z0-9.-]+)\//i.exec(text)?.[1]?.toLowerCase() ?? null;
  } catch { return null; }
}
const host=await gatewayHost();
if (host===null) {
  console.log('{"result":"FAIL","code":"DRILL_GATEWAY_ROUTE_UNREADABLE"}');
  process.exitCode=1;
} else try {
  const [profile,system,resident,controller,companion,probe,record,network]=await Promise.all(
    ['profile.json','system.json','resident.json','controller.json','companion.json','probe.json','record.json','network.json'].map(load));
  const hosts=network?.blackholeHosts;
  if (!Array.isArray(hosts) || !hosts.every(h=>typeof h==='string')) throw new Error('演练名单无效');
  const now=Date.now();
  const validSid=s=>typeof s==='string' && /^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/.test(s);
  const distinct=validSid(profile.controllerSid) && validSid(profile.ownerSid) && profile.ownerSid!==profile.controllerSid;
  const checks=keyCheck(system,resident,controller,companion,profile,now);
  // 网关一项按演练是否切断了网关主机双向判定（FABLE-drill-r13-a8-m5-20261125.md 第 2 节），探针时间新鲜两种情况都要求：
  // 未切断：未登记来宾必须收到网关的 403 身份拒绝，证明 DNS、TLS、路由、限速绑定存在以及 SYSTEM 出站可达（gateway=true）。
  // 已切断：探针必须恰为 RENEW_GATEWAY_UNAVAILABLE（SYSTEM 已打开密钥签了名才会发送，SwapBroker.cs 先签名后发送），记为
  // 'NOT_VERIFIED_GATEWAY_CUT_OFF'，如实登记来宾到网关的可达未验到；这时拿到 403 或别的码说明隔离破了，即失败。
  const probeAt=Date.parse(probe.at);
  const fresh=probeAt<=now && now-probeAt<=86_400_000;
  const cutOff=hosts.some(h=>h.toLowerCase()===host);
  const gateway=!fresh ? false : cutOff ? (probe.code==='RENEW_GATEWAY_UNAVAILABLE' ? 'NOT_VERIFIED_GATEWAY_CUT_OFF' : false)
    : probe.code==='RENEW_IDENTITY_REFUSED';
  // 令牌文件必须实测“拒绝访问”。连接记录以来宾管理员侧实读（record.json）为准（裁定补“对路八处”第 8 处）：存在则陪伴必须
  // “拒绝访问”，不存在则必须报“不存在”，对不上即失败。首装时记录不存在，“记录的拒绝访问”如实登记为未验到；它的真机证据是
  // 已激活节点每天的 keyCheck。
  const admin=record['ci-admission.connection.json'], seen=companion['ci-admission.connection.json'];
  const denial=admin==='PRESENT' && seen==='DENIED' ? 'VERIFIED' : admin==='ABSENT' && seen==='ABSENT' ? 'NOT_VERIFIED_RECORD_ABSENT' : null;
  const filesDenied=companion['ci-admission.token']==='DENIED' && denial!==null;
  const tpm=system?.provider==='Microsoft Platform Crypto Provider';
  const passed=tpm && distinct && gateway!==false && filesDenied && checks.result==='PASS';
  console.log(JSON.stringify({result:passed?'PASS':'FAIL',identities:distinct,gateway,checks,
    record:{admin:admin??null,companion:seen??null,consistent:denial!==null,denial},
    ...(!tpm && {code:'DRILL_TPM_PROVIDER_REQUIRED'})}));
  process.exitCode=passed?0:1;
} catch {console.log('{"result":"FAIL","code":"DRILL_EVIDENCE_UNAVAILABLE"}');process.exitCode=1;}
