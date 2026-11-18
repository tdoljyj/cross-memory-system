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
  [source+'src/resident-v2/prepare-record.mjs','安装记录内部自洽：构造一致的两份安装记录'],
  ['work/independent-ci-resident-v1/src/node-identity.mjs','安装记录内部自洽：计算安装身份摘要'],
]);
test('受信 Source 的新增安装连接字段读取者必须登记文件和理由', () => {
  const findings=[];
  for (const file of computeClosure(root)) {
    if (file===resolver || reasons.has(file) || !/\.[cm]?js$/.test(file)) continue;
    const lines=fs.readFileSync(path.join(root,file),'utf8').split('\n');
    for (const [i,line] of lines.entries()) {
      if (/\.\s*(?:ciTokenPinSha256|ciPrincipalBindingId)\b|\[\s*["'](?:ciTokenPinSha256|ciPrincipalBindingId)["']\s*\]/.test(line)) findings.push(file+':'+(i+1));
    }
  }
  assert.deepEqual(findings,[],findings.join('\n'));
});
