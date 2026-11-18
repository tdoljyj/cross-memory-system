import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonical, digest } from '../src/proof.mjs';
import { nodeIdentityOf, nodeIdentitySha256 } from '../../../independent-ci-resident-v1/src/node-identity.mjs';
import { keyFingerprint } from '../../../independent-ci-resident-v1/registration/registration-core.mjs';
import { fixtureRecord } from './resident-v2-fixtures.mjs';

const resident = new URL('../../../independent-ci-resident-v1/', import.meta.url);
const shared = new URL('../../../../apps/clued-cloud/tests/fixtures/ci-connection-self-v1.json', import.meta.url);
const sample = () => JSON.parse(fs.readFileSync(shared));
const script = fileURLToPath(new URL('test/ci-token-activation.ps1', resident));
const old = 'clued_bnd_previous_fixture';
const fresh = 'clued_bnd_rebound_fixture';
const pin = t => digest('clued.independent-ci.ci-binding-pin/1\0' + t);
const recordName = 'ci-admission.connection.json';
const tokenName = 'ci-admission.token';
const win = { skip: process.platform !== 'win32' };
const pub = { kty:'EC', crv:'P-256', x:'axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpY', y:'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU' };
function setup(t, {upgrade, heartbeat, generation} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-activate-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const dir = path.join(root, 'secrets');
  for (const d of [dir, 'resident/record', 'resident/install'].map(d => path.resolve(root,d))) fs.mkdirSync(d,{recursive:true});
  const { files } = fixtureRecord({ciTokenPinSha256:pin(old)});
  const config = JSON.parse(files['installation.json']), accepted = JSON.parse(files['acceptance.json']);
  const identity = nodeIdentityOf(config, accepted, digest(files['acceptance.json']));
  for (const name of ['installation.json','acceptance.json']) fs.writeFileSync(path.join(root,'resident/record',name), files[name]);
  const receipt = { contract:'clued.independent-ci.resident-install-receipt/6', roleAssumption:'NONE', nodeIdentity:identity,
    nodeIdentitySha256:nodeIdentitySha256(identity), installationSha256:digest(files['installation.json']), acceptanceSha256:config.acceptanceSha256,
    upgradeToken:{placed:true,fingerprint:pin(upgrade ?? 'clued_bnd_upgrade_fixture')},
    heartbeatToken:{placed:!!heartbeat,fingerprint:heartbeat ? pin(heartbeat) : null,bindingId:null} };
  fs.writeFileSync(path.join(root,'resident/install/install-receipt.json'),JSON.stringify(receipt));
  fs.writeFileSync(path.join(dir,tokenName),old);
  if (generation) fs.writeFileSync(path.join(dir,recordName), canonical({activatedAt:'2026-01-01T00:00:00.000Z',baseNodeIdentitySha256:receipt.nodeIdentitySha256,
    bindingGeneration:generation,bindingId:config.ciPrincipalBindingId,contract:'clued.independent-ci.ci-connection/1',previousSha256:null,
    rebindReceiptId:'fabc1234-1234-1234-1234-123456789012',tokenPinSha256:pin(old)}));
  return {root,dir,scope:config.scope};
}
function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir).map(k=>[k,digest(fs.readFileSync(path.join(dir,k),'utf8'))]));
}
function run(ctx, {token=fresh, status=200, reply, point='', action='apply', sampleIdentity=null}={}) {
  const tokenFile = ctx.root + '.exercise.token';
  if (action==='apply') fs.writeFileSync(tokenFile,token+'\r\n');
  const p = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',script],{encoding:'utf8',windowsHide:true,
    input:JSON.stringify({root:ctx.root,tokenFile,reply:reply===undefined ? sample() : reply,status,point,action,sampleIdentity,publicJwk:pub})});
  assert.ok(!(p.stdout+p.stderr).includes(token),'输出含凭据');
  assert.equal(p.status,0,p.stderr);
  const result=JSON.parse(p.stdout);
  if(action==='apply') {
    const left=fs.existsSync(tokenFile);
    if(left) fs.unlinkSync(tokenFile);
    assert.equal(left,false,'演练输入应在读取后即删除 '+JSON.stringify(result));
  }
  for(const request of result.requests) {
    assert.deepEqual(request.body,{p_token_hash:digest(token),p_input:{scope:ctx.scope}});
    assert.match(request.uri,/\/rest\/v1\/rpc\/clued_ci_connection_self_v1$/);
  }
  return result;
}
function bound() {
  const reply=sample();
  reply.node.identity_fingerprint=keyFingerprint(pub);
  return reply;
}
test('迁移 B 共用应答文件的两层精确键集',()=>{
  const v=sample();
  assert.deepEqual(Object.keys(v).sort(),['binding_id','connection_expires_at','contract','node','status']);
  assert.deepEqual(Object.keys(v.node).sort(),['binding_generation','identity_fingerprint','name','node_id','rebind_receipt_id','state']);
  assert.equal(v.contract,'clued.ci.connection-self/1');
});
test('脚本的声明参数精确，普通窗口不需要令牌',win,t=>{
  const ctx=setup(t), before=snapshot(ctx.dir), r=run(ctx,{action:'plan',reply:null});
  assert.deepEqual(r.parameters.sort(),['Apply','ExpectedPlanSha256','TokenFile']);
  assert.match(r.plan.notice,/连接编号、代次、回执由服务端按令牌回答/);
  assert.match(r.current,/此窗口不可读/);
  assert.deepEqual(r.requests,[]); assert.deepEqual(snapshot(ctx.dir),before);
});
test('Windows CNG 公钥重算与登记指纹逐字相同',win,t=>{
  const r=run(setup(t),{action:'fingerprint',reply:null});
  const blob=Buffer.from(r.blob,'base64');
  assert.equal(r.fingerprint,keyFingerprint({kty:'EC',crv:'P-256',x:blob.subarray(8,40).toString('base64url'),y:blob.subarray(40).toString('base64url')}));
});
test('原样解析迁移 B 共用的完整应答',win,t=>{
  const v=sample();
  const result=run(setup(t),{sampleIdentity:v.node.identity_fingerprint});
  assert.equal(result.status,'CI_CONNECTION_ACTIVATED',JSON.stringify(result));
  assert.equal(result.nodeName,v.node.name);assert.equal(result.expiresAt,v.connection_expires_at);
});
test('重复的合同字段在 PS 5.1 解析覆盖之前拒绝',win,t=>{
  const ctx=setup(t),before=snapshot(ctx.dir);
  const text=JSON.stringify(bound()).replace('"status":','"status":"wrong","status":');
  assert.equal(run(ctx,{reply:text}).code,'CI_CONNECTION_SELF_UNAVAILABLE');
  assert.deepEqual(snapshot(ctx.dir),before);
});
test('下一次换绑保留前一份规范记录摘要，完整重复激活在联网前拒绝',win,t=>{
  const v=bound(),ctx=setup(t,{generation:v.node.binding_generation-1}),before=snapshot(ctx.dir);
  const first=run(ctx,{reply:v});
  assert.equal(first.status,'CI_CONNECTION_ACTIVATED',JSON.stringify(first));
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.dir,recordName))).previousSha256,before[recordName]);
  assert.equal(first.before.generation,v.node.binding_generation-1);
  const complete=snapshot(ctx.dir), repeated=run(ctx,{reply:v});
  assert.equal(repeated.code,'CI_CONNECTION_TOKEN_REUSED');
  assert.deepEqual(repeated.requests,[]);assert.deepEqual(snapshot(ctx.dir),complete);
});
for(const [name,status,change,expected] of [
  ['401',401,()=>{},'TOKEN_REFUSED'],['403',403,()=>{},'TOKEN_REFUSED'],['404',404,()=>{},'SELF_UNAVAILABLE'],
  ['多键',200,v=>v.extra=true,'SELF_UNAVAILABLE'],['缺键',200,v=>delete v.node.state,'SELF_UNAVAILABLE'],
  ['未知合同',200,v=>v.contract='v2','SELF_UNAVAILABLE'],['尚无节点',200,v=>v.node=null,'NOT_REBOUND'],
  ['首装无回执',200,v=>v.node.rebind_receipt_id=null,'NOT_REBOUND'],['别台节点',200,v=>v.node.identity_fingerprint='f'.repeat(64),'OTHER_NODE'],
  ['代次相等',200,()=>{},'GENERATION_NOT_NEWER'],['代次倒退',200,()=>{},'GENERATION_NOT_NEWER']
]) test('激活零写入 '+name,win,t=>{
  const v=bound(), ctx=setup(t,{generation:name.startsWith('代次') ? v.node.binding_generation + Number(name==='代次倒退') : null});
  change(v); const before=snapshot(ctx.dir), r=run(ctx,{status,reply:v});
  assert.equal(r.code,'CI_CONNECTION_'+expected); assert.equal(r.requests.length,1);
  assert.deepEqual(snapshot(ctx.dir),before);
});
for(const kind of ['upgrade','heartbeat','current']) test('重复指纹在联网前拒绝 '+kind,win,t=>{
  const ctx=setup(t,{[kind]:fresh}), before=snapshot(ctx.dir);
  const r=run(ctx,{token:kind==='current'?old:fresh,reply:bound()});
  assert.match(r.code,/TOKEN.*(SAME|REUSED)/); assert.deepEqual(r.requests,[]); assert.deepEqual(snapshot(ctx.dir),before);
});
for(const point of ['', 'staged','record','token']) test('服务端三值、ACL 和中断恢复 '+(point||'正常'),win,t=>{
  const v=bound(),ctx=setup(t),before=snapshot(ctx.dir);
  if(point) {
    const stopped=run(ctx,{reply:v,point}); assert.equal(stopped.code,'FIXTURE_INTERRUPTED');
    assert.deepEqual(stopped.requests[0].snapshot,before);
  }
  const result=run(ctx,{reply:v});
  assert.equal(result.status,'CI_CONNECTION_ACTIVATED',JSON.stringify(result));
  if(!point) assert.deepEqual(result.requests[0].snapshot,before);
  assert.deepEqual(fs.readdirSync(ctx.dir).sort(),[recordName,tokenName]);
  const rec=JSON.parse(fs.readFileSync(path.join(ctx.dir,recordName)));
  assert.deepEqual([rec.bindingId,rec.bindingGeneration,rec.rebindReceiptId],[v.binding_id,v.node.binding_generation,v.node.rebind_receipt_id]);
  assert.equal(rec.tokenPinSha256,pin(fresh));
  assert.equal(fs.readFileSync(path.join(ctx.dir,tokenName),'utf8'),fresh);
  assert.deepEqual(result.companionCanRead,[false,false]);
});
