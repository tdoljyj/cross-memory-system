import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeClosure } from '../src/resident-v2/source-closure.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const source = 'work/actions-hosted-migration/independent-ci-v1/';
const resolver = source + 'src/resident-v2/ci-principal.mjs';
const reasons = new Map([
  ['scripts/ci/clued-independent-revocation-controller.mjs', '接收方比较：服务端撤销回包与已解析的端口编号'],
  [source+'src/full-admission-v2.mjs','接收方比较：配置与凭据端口的有效编号'],
  [source+'src/full-admission.mjs','旧代入口，不支持轮换'],
  [source+'src/independent-control-checks-v1/publisher.mjs','旧代入口，不支持轮换'],
  [source+'src/staged-check-publisher-v2.mjs','接收方比较：已解析的部署编号与 facts，并将比较过的编号绑定到发布摘要'],
  [source+'worker/protected-job-bridge-v2/boundary.mjs','安装记录内部自洽：旧版接受文件与配置互校'],
  [source+'src/resident-v2/record.mjs','安装记录内部自洽：加载两份安装记录'],
  [source+'src/resident-v2/windows/FormalPublicBoundaryV2.cs','安装记录内部自洽：核对 accepted、config 与 plan 的公开字段'],
  [source+'src/resident-v2/prepare-record.mjs','安装记录内部自洽：构造一致的两份安装记录'],
  ['work/independent-ci-resident-v1/src/node-identity.mjs','安装记录内部自洽：计算安装身份摘要'],
]);
function unregisteredReads(files, read) {
  const findings=[];
  for (const file of files) {
    if (file===resolver || reasons.has(file) || !/\.(?:[cm]?js|cs|ps1)$/i.test(file)) continue;
    const text=read(file);
    // JS 中的对象字面量也会向下游传递有效编号。只查成员读取、下标和解构。
    const member=/\.\s*(?:ciTokenPinSha256|ciPrincipalBindingId)\b|\[\s*["'](?:ciTokenPinSha256|ciPrincipalBindingId)["']\s*\]/g;
    const destructure=/\{[^{}]*?\b(?:ciTokenPinSha256|ciPrincipalBindingId)\b[^{}]*?\}\s*(?:=|of\b|(?:,[^();{}]*)?\)\s*(?:=>|\{))/g;
    const patterns=/\.[cm]?js$/.test(file)?[member,destructure]:[/\b(?:ciTokenPinSha256|ciPrincipalBindingId)\b/gi];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) findings.push(file+':'+text.slice(0,match.index).split('\n').length);
    }
  }
  return findings;
}
test('受信 Source 的新增安装连接字段读取者必须登记文件和理由', () => {
  const findings=unregisteredReads(computeClosure(root),file=>fs.readFileSync(path.join(root,file),'utf8'));
  assert.deepEqual(findings,[],findings.join('\n'));
});
for(const [file,code] of [
  ['new.mjs','const {\n  ciPrincipalBindingId: id\n} = accepted;'],
  ['param.mjs','function read({ciPrincipalBindingId: id}, other) { return id; }'],
  ['arrow.mjs','const read = (ctx, {ciTokenPinSha256}, extra) => ciTokenPinSha256;'],
  ['new.ps1',"$x = $config['ciTokenPinSha256']"],
  ['new.cs','return Text(config,"ciPrincipalBindingId");'],
]) test('静态守卫能发现 '+file+' 的读取',()=>{
  assert.equal(unregisteredReads([file],()=>code).length,1);
});
