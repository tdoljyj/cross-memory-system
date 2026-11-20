import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { NodeDuty, validMemory } from '../src/node-duty.mjs';
import { events } from '../src/pr-status.mjs';
import { heartbeatPayload, parseHeartbeatReply } from '../src/companion-heartbeat.mjs';
import { intakePauseRequest, INTAKE_PAUSE_CONTRACT, INTAKE_RESUME_CONTRACT } from '../src/intake-pause.mjs';
import { parseStatus, readVersionState, StatusBoard } from '../src/status.mjs';
import { nodeProfileSha256 } from '../src/node-profile.mjs';
import { parseRoleProbe } from '../../actions-hosted-migration/independent-ci-v1/src/independent-control-checks-v2/merge-slot-native.mjs';
import { CI_SOURCE, HEAD, RESIDENT, TEST_NODE, WINDOWS_CLEAN, executorFixture, fakeEngine, rawPolicy } from './helpers.mjs';

const resident = fileURLToPath(new URL('../', import.meta.url));
const w = path.join(resident, 'windows');
const source = path.resolve(resident, '../actions-hosted-migration/independent-ci-v1/src/resident-v2/windows');
// 续期合同的单一来源（D2c 裁定 B1）：夹具一律取服务端这份，包构建时也取它。
const serverContract = path.resolve(resident, '../../apps/clued-cloud/worker/ci-connection-renew.contract.json');
function compileBrokerFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renew-fixture-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const framework = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319');
  const exe = path.join(dir, 'fixture.exe');
  const result = spawnSync(path.join(framework, 'csc.exe'), ['/nologo','/noconfig','/optimize+','/target:exe','/main:RenewalTests','/out:'+exe,
    ...['System.dll','System.Core.dll','System.ServiceProcess.dll','System.Web.Extensions.dll'].map(f => '/r:'+path.join(framework,f)),
    path.join(w,'SwapBroker.cs'),...['ResidentScmV2.cs','ScmPidHandshakeV2.cs','NodeProfileV2.cs'].map(f=>path.join(source,f)),
    path.join(resident,'test/RenewalTests.cs')], {encoding:'utf8', windowsHide:true});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  fs.copyFileSync(serverContract,path.join(dir,'ci-connection-renew.contract.json'));
  return exe;
}
test('按冻结引用编译 Broker，离线执行续期、拒绝和崩溃恢复', {skip:process.platform !== 'win32'}, t => {
  const run = spawnSync(compileBrokerFixture(t), [], {encoding:'utf8', windowsHide:true});
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'RENEWAL_FIXTURE_PASS');
});

import { keyCheck, parseRenewalStatus, renewalWatch } from '../src/connection-renewal.mjs';
test('自检要求身份正确、观测新鲜，且两个 KSP 都打不开密钥', () => {
  const at=new Date().toISOString(), now=Date.parse(at);
  const service='S-1-5-80-'+Array.from({length:5},(_,i)=>sidHash.readUInt32LE(4*i)).join('-');
  const profile={ownerSid:'companion',controllerSid:'controller'};
  const observation=sid=>({at,sid,tpm:'DENIED',software:'ABSENT'});
  const system={at,sid:'S-1-5-18',provider:'Microsoft Platform Crypto Provider',code:null};
  const rows=[observation(service),observation(profile.controllerSid),{...observation(profile.ownerSid),
    'ci-admission.token':'DENIED','ci-admission.connection.json':'DENIED'}];
  const verdict=(s,r)=>keyCheck(s,...r,profile,now).result;
  assert.equal(verdict(system,rows),'PASS');
  for (let i=0;i<3;i++) for(const edit of [{tpm:'UNKNOWN'},{software:'UNKNOWN'},{tpm:'OPEN'},{software:'OPEN'},{sid:'wrong'},{at:'2000-01-01T00:00:00Z'}]) {
    const changed=structuredClone(rows);Object.assign(changed[i],edit);assert.equal(verdict(system,changed),'FAIL');
  }
  for(const field of ['ci-admission.token','ci-admission.connection.json']) {
    const changed=structuredClone(rows);changed[2][field]='OPEN';assert.equal(verdict(system,changed),'FAIL');
  }
  assert.equal(verdict(null,rows),'FAIL');
  assert.equal(verdict({...system,sid:service},rows),'FAIL');
  const maxAge=30*60_000;
  for (const [offset, expected] of [[-maxAge,true],[-maxAge-1,false],[1,false],[86_400_000,false]]) {
    const retime = row => ({...row,at:new Date(now+offset).toISOString()});
    const checks=keyCheck(retime(system),...rows.map(retime),profile,now);
    assert.deepEqual([checks.system,checks.resident,checks.controller,checks.companion],
      [expected,expected,expected,expected],`观测时间偏移 ${offset} 毫秒`);
  }
});

test('TURING 21:16 反向观测中常驻在两个 KSP 都找不到密钥时通过', () => {
  const at='2026-11-19T13:16:50.000Z', now=Date.parse(at);
  const service='S-1-5-80-'+Array.from({length:5},(_,i)=>sidHash.readUInt32LE(4*i)).join('-');
  const profile={ownerSid:'companion',controllerSid:'controller'};
  const origin={at,tpm:'DENIED',software:'ABSENT'};
  const checks=keyCheck({at,sid:'S-1-5-18',provider:'Microsoft Platform Crypto Provider',code:null},
    {...origin,sid:service,tpm:'ABSENT'}, {...origin,sid:profile.controllerSid},
    {...origin,sid:profile.ownerSid,'ci-admission.token':'DENIED','ci-admission.connection.json':'DENIED'},profile,now);
  assert.equal(checks.resident,true);
  assert.equal(checks.result,'PASS');
});

test('常驻轮次开始后产生的四项密钥观测仍可通过自检', async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'renew-fresh-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const root=path.join(directory,'resident');
  for (const dir of ['resident/state','resident/broker/requests','resident/mailbox/responses','state/v2/receipts'])
    fs.mkdirSync(path.join(directory,dir),{recursive:true});
  const service='S-1-5-80-'+Array.from({length:5},(_,i)=>sidHash.readUInt32LE(4*i)).join('-');
  const profile={ownerSid:'companion',controllerSid:'controller'};
  let now=Date.parse('2026-11-20T00:32:06.000Z');
  const iso=()=>new Date(now).toISOString();
  const row=sid=>({at:iso(),sid,tpm:'DENIED',software:'ABSENT'});
  const put=(file,value)=>fs.writeFileSync(path.join(directory,file),JSON.stringify(value));
  const step=renewalWatch({root,profile,mode:()=>'STANDBY',clock:()=>now,source:CI_SOURCE,uptime:()=>10*60_000,observe:async()=>{
    now+=40;
    return row(service);
  }});
  // 启动轮次先读时钟，挂起读取状态后，独立的写入方发布另外三项观测。
  const checking=step();
  now+=80;
  put('resident/broker/renew-key.json',{at:iso(),sid:'S-1-5-18',provider:'Microsoft Platform Crypto Provider',code:null});
  put('state/v2/receipts/renew-key-controller.json',row(profile.controllerSid));
  put('resident/mailbox/responses/renew-key.json',{...row(profile.ownerSid),
    'ci-admission.token':'DENIED','ci-admission.connection.json':'DENIED'});
  await checking;
  const {keys,checkedAt}=JSON.parse(fs.readFileSync(path.join(root,'state','connection-renewal.json'),'utf8'));
  assert.deepEqual({resident:keys.resident,system:keys.system,controller:keys.controller,companion:keys.companion,result:keys.result},
    {resident:true,system:true,controller:true,companion:true,result:'PASS'});
  assert.equal(checkedAt,iso());
});

test('常驻状态原样记录 SYSTEM 失败诊断，并在 Broker 恢复后清空', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'renew-failure-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['state','broker/requests','broker/responses']) fs.mkdirSync(path.join(root,dir),{recursive:true});
  let now=Date.now();
  const failure={step:'open',attempts:[{provider:'tpm',hresult:'0x8028400F'},{provider:'software',hresult:'0x80090016'}]};
  const systemFile=path.join(root,'broker/renew-key.json');
  fs.writeFileSync(systemFile,JSON.stringify({at:new Date(now).toISOString(),sid:'S-1-5-18',provider:null,
    code:'RENEW_IDENTITY_KEY_UNAVAILABLE',failure}));
  const step=renewalWatch({root,profile:{},mode:()=>'STANDBY',clock:()=>now,source:CI_SOURCE,uptime:()=>10*60_000,observe:async()=>null});
  const keys=()=>JSON.parse(fs.readFileSync(path.join(root,'state/connection-renewal.json'))).keys;
  await step();
  assert.deepEqual(keys().systemFailure,failure);
  assert.equal(keys().result,'FAIL');
  now+=10*60_000;
  fs.writeFileSync(systemFile,JSON.stringify({at:new Date(now).toISOString(),sid:'S-1-5-18',
    provider:'Microsoft Platform Crypto Provider',code:null,failure:null}));
  await step();
  assert.equal(keys().system,true);
  assert.equal(keys().systemFailure,null);
});

import { createHash } from 'node:crypto';
const sidHash=createHash('sha1').update(Buffer.from('CLUEDCIRESIDENT','utf16le')).digest();
// D2c 裁定 B2：常驻不再自己判断窗口和当班。两类连接同样直接投递，是否进窗口、是否当班只由 Broker 的新鲜探询判断。
test('两类连接每天各投一次；续期请求只含类别，拒绝不会阻塞另一类，当班或积压照常投递', async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'renew-watch-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const d of ['state','broker/requests','broker/responses']) fs.mkdirSync(path.join(root,d),{recursive:true});
  let mode='ACTIVE',idle=false,now=Date.now();
  const step=renewalWatch({root,profile:{},mode:()=>mode,drained:async()=>idle,clock:()=>now,source:CI_SOURCE,uptime:()=>10*60_000,observe:async()=>null});
  await step();
  const req=kind=>{
    const book=JSON.parse(fs.readFileSync(path.join(root,'state/connection-renewal.json')));
    assert.equal(book.pending?.kind??null,kind);
    if(kind) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'broker/requests',book.pending.id+'.json'))),{kind});
    return book.pending?.id;
  };
  const reject=(kind,id)=>fs.writeFileSync(path.join(root,'broker/responses',id+'.json'),JSON.stringify({
    contract:'clued.independent-ci.connection-renew-response/1',requestId:id,kind,code:'RENEW_GATEWAY_REFUSED'}));
  reject('ci',req('ci'));await step();
  reject('upgrade',req('upgrade'));await step();req(null);
  mode='STANDBY';idle=true;await step();req(null);
  now+=86_400_000-1;await step();req(null);
  now++;await step();req('ci');
});
function drillFixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'renew-drill-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const at=new Date().toISOString(), profile={ownerSid:'S-1-5-21-1-2-3-101',controllerSid:'S-1-5-21-1-2-3-102'};
  const row=sid=>({at,sid,tpm:'DENIED',software:'ABSENT'});
  const put=(name,value)=>fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(value));
  put('profile',profile);
  put('system',{at,sid:'S-1-5-18',provider:'Microsoft Platform Crypto Provider',code:null});
  put('resident',row('S-1-5-80-'+Array.from({length:5},(_,i)=>sidHash.readUInt32LE(4*i)).join('-')));
  put('controller',row(profile.controllerSid));
  put('companion',{...row(profile.ownerSid),'ci-admission.token':'DENIED','ci-admission.connection.json':'DENIED'});
  put('probe',{at,code:'RENEW_IDENTITY_REFUSED'});
  const drill=()=>spawnSync(process.execPath,[path.join(resident,'test','renewal-drill.mjs'),dir],{encoding:'utf8'});
  return {drill, put, profile, row};
}
test('演练以未登记来宾收到的网关拒绝观测判定可达性', async t=>{
  const {drill, put}=drillFixture(t);
  const now=Date.now();
  for (const [name, code, at, reachable] of [
    ['403 身份拒绝', 'RENEW_IDENTITY_REFUSED', now, true],
    ['503 或传输失败', 'RENEW_GATEWAY_UNAVAILABLE', now, false],
    ['限流拒绝', 'RENEW_RATE_LIMITED', now, false],
    ['成功探询', null, now, false],
    ['超过 24 小时', 'RENEW_IDENTITY_REFUSED', now-24*HOUR-1, false],
    ['未来时刻', 'RENEW_IDENTITY_REFUSED', now+HOUR, false],
  ]) {
    await t.test(name, ()=>{
      const probe={code,at:new Date(at).toISOString()};
      if (code===null) Object.assign(probe,{bindingId,expiresAt:new Date(now+HOUR).toISOString()});
      put('probe',probe);
      const result=drill();
      const verdict=JSON.parse(result.stdout);
      assert.equal(verdict.gateway,reachable);
      assert.equal(verdict.checks.result,'PASS');
      assert.equal(verdict.result,reachable?'PASS':'FAIL');
      assert.equal(result.status,reachable?0:1);
    });
  }
});
test('演练夹具只凭公开的同轮身份和网关观测判定', t=>{
  const {drill, put, profile, row} = drillFixture(t);
  let result=drill();assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).result,'PASS');
  put('companion',{...row(profile.ownerSid),'ci-admission.token':'DENIED','ci-admission.connection.json':'ABSENT'});
  result=drill();assert.equal(result.status,1);
  put('companion',{...row(profile.ownerSid),'ci-admission.token':'DENIED','ci-admission.connection.json':'DENIED'});
  put('controller',row(profile.ownerSid));
  result=drill();assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).result,'FAIL');
});

test('M5 来宾使用软件 KSP 时即使日常自检通过也会拒绝', t=>{
  const {drill,put}=drillFixture(t);
  put('system',{at:new Date().toISOString(),sid:'S-1-5-18',provider:'Microsoft Software Key Storage Provider',code:null});
  const result=drill();
  const verdict=JSON.parse(result.stdout);
  assert.equal(verdict.checks.result,'PASS');
  assert.equal(verdict.result,'FAIL');
  assert.equal(verdict.code,'DRILL_TPM_PROVIDER_REQUIRED');
  assert.equal(result.status,1);
});

const HOUR = 3_600_000;
const bindingId = '10000000-0000-4000-8000-000000000001';
const confirmationId = '10000000-0000-4000-8000-000000000002';

function handoverFixture(t, {now = Date.now(), currentBinding = bindingId, mode, drained, onHandover} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renew-handover-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const dir of ['state', 'broker/requests', 'broker/responses']) fs.mkdirSync(path.join(root, dir), {recursive: true});
  const f = {root, now, mode: 'ACTIVE', drained: false, holds: 0, source: CI_SOURCE, startedAt: now - 10 * 60_000, observe: async () => null};
  const expiresAt = new Date(f.now + 10 * 24 * HOUR).toISOString();
  const put = (name, value) => fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  f.restart = () => {
    f.tick = renewalWatch({root, profile: {}, mode: mode ?? (() => f.mode), drained: drained ?? (async () => f.drained),
      clock: () => f.now, observe: () => f.observe(), onHandover: onHandover ?? (() => { f.holds++; f.mode = 'UNCERTAIN'; }), source: f.source,
      uptime: () => f.now - f.startedAt, readResponse: f.readResponse ? (file => f.readResponse(file)) : undefined});
  };
  f.restart();
  f.book = () => JSON.parse(fs.readFileSync(path.join(root, 'state/connection-renewal.json')));
  f.request = kind => { // 在途请求；已放弃、只待换号的旧请求号不算在途
    const pending = f.book().pending?.abandoned ? null : f.book().pending;
    assert.equal(pending?.kind ?? null, kind);
    if (!kind) return;
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'broker/requests', pending.id + '.json'))), {kind});
    return pending.id;
  };
  f.reply = (kind, reply) => {
    const requestId = f.request(kind);
    put('broker/responses/' + requestId + '.json', {contract: 'clued.independent-ci.connection-renew-response/1',
      requestId, kind, code: null, bindingId: currentBinding, expiresAt, ...reply});
  };
  return f;
}

test('当班、窗口已开，第一次投递遇 503：1 小时后重投并让班，而不是 24 小时后', async t => {
  const f = handoverFixture(t);
  await f.tick();
  f.reply('ci', {code: 'RENEW_GATEWAY_UNAVAILABLE'});
  await f.tick();
  assert.equal(f.holds, 0);
  f.reply('upgrade', {}); await f.tick(); f.request(null);
  f.now += HOUR - 1; await f.tick(); f.request(null);
  f.now++; await f.tick();
  f.reply('ci', {outcome: 'yielded', effectiveAt: new Date(f.now + 300_000).toISOString()});
  await f.tick();
  assert.equal(f.holds, 1);
  assert.equal(f.book().lanes.ci.code, 'RENEW_HANDOVER_WAITING');
});
test('当班、窗口未开：每天投一次，Broker 只回当前连接，不停接单、不换令牌', async t => {
  const f = handoverFixture(t);
  await f.tick();
  f.reply('ci', {}); // 窗口未开时 Broker 返回当前连接（closed-window 场景断言 Broker 零写入）
  await f.tick();
  f.reply('upgrade', {}); await f.tick();
  const lane = f.book().lanes.ci;
  assert.deepEqual([f.holds, lane.code, lane.waiting, lane.bindingId], [0, null, false, bindingId]);
  for (let hour = 1; hour < 24; hour++) { f.now += HOUR; await f.tick(); f.request(null); }
  f.now += HOUR - 1; await f.tick(); f.request(null);
  f.now++; await f.tick(); f.request('ci');
  assert.equal(fs.readdirSync(path.join(f.root, 'broker/requests')).length, 3, '一天只投一次 CI，外加一次升级');
});
test('无候选与未确认类失败（含升级道回包丢失）1 小时后重投，两类连接同一节奏；忙两分钟后重投', async t => {
  const hourly = ['RENEW_GATEWAY_UNAVAILABLE', 'RENEW_RESPONSE_UNAVAILABLE', 'RENEW_INTERRUPTED', 'RENEW_UNAVAILABLE', 'RENEW_HANDOVER_NO_CANDIDATE'];
  for (const kind of ['ci', 'upgrade']) for (const [code, wait] of [...hourly.map(c => [c, HOUR]), ['RENEW_BUSY', 120_000]]) {
    if (kind === 'upgrade' && code === 'RENEW_HANDOVER_NO_CANDIDATE') continue;
    const f = handoverFixture(t);
    await f.tick();
    if (kind === 'upgrade') { f.reply('ci', {}); await f.tick(); }
    if (code === 'RENEW_RESPONSE_UNAVAILABLE') { f.request(kind); f.now += HOUR; } // 回包满一小时未到
    else f.reply(kind, {code});
    await f.tick();
    if (kind === 'ci') { f.reply('upgrade', {}); await f.tick(); }
    assert.equal(f.book().lanes[kind].code, code, kind + ' ' + code);
    assert.equal(f.holds, 0, '从不为续期强行停止当班');
    f.now += wait - 1; await f.tick(); f.request(null);
    f.now++; await f.tick(); f.request(kind);
  }
});
test('待批按应答间隔重启续等，两种连接均在约定时刻重投', async t => {
  for(const kind of ['ci','upgrade']) {
    const f=handoverFixture(t);
    const retryAfterSeconds=kind==='ci'?3600:723;
    await f.tick();
    if(kind==='upgrade') { f.reply('ci',{}); await f.tick(); }
    f.reply(kind,{code:'RENEW_PENDING_APPROVAL',grantRequestId:confirmationId,retryAfterSeconds});
    await f.tick();
    if(kind==='ci') { f.reply('upgrade',{}); await f.tick(); }
    f.restart(); f.now+=retryAfterSeconds*1000-1; await f.tick(); f.request(null);
    f.now++; await f.tick(); f.request(kind);
    assert.equal(f.book().lanes[kind].grantRequestId,confirmationId);
  }
});
const targetCodes=['HALTED','INTAKE_PAUSED','NOT_HEARD','PAUSED','SOURCE_NOT_ACCEPTED','SOURCE_UNKNOWN','STATE_UNKNOWN']
  .map(s=>'CI_ADMISSION_TARGET_'+s);
// 审查 N1：拒绝原码按网关同一形状 ^[A-Z_]{3,80}$ 透传，不再在节点上另列白名单（服务端码表的副本会分叉）。
const passedCodes=[...targetCodes,'CI_ADMISSION_TARGET_FUTURE','CI_RENEW_STANDING_DECISION_UNRESOLVED','CI_REBIND_TARGET_IN_USE',
  'CI_IDEMPOTENCY_CONFLICT','CI_BINDING_UNAVAILABLE','CI_NODE_NOT_FOUND','CI_NODE_TRANSITION_INVALID','BROKER_CONFIG_CHANGED','ABC','A'.repeat(80)];
test('状态按形状透传拒绝原码和服务端窗口', () => {
  const at=new Date().toISOString();
  for(const code of [...passedCodes,'AB','A'.repeat(81),'renew_lower','RENEW-DASH','RENEW_1']) {
    const view=parseRenewalStatus({keyCheck:'PASS',checkedAt:at,connections:{ci:{code,renewalWindowOpensAt:at}}});
    assert.equal(view.connections.ci.code,passedCodes.includes(code)?code:null,code);
    assert.equal(view.connections.ci.renewalWindowOpensAt,at);
  }
});
test('Broker 给出的原码原样留在通道状态，不压成回包不可用', async t => {
  for (const code of ['CI_RENEW_STANDING_DECISION_UNRESOLVED', 'BROKER_CONFIG_CHANGED']) {
    const f = handoverFixture(t);
    await f.tick();
    f.reply('ci', {code});
    await f.tick();
    assert.deepEqual([f.book().lanes.ci.code, f.book().lanes.ci.waiting, f.holds], [code, false, 0]);
  }
});
test('让班无候选保留当班和拒绝码，1 小时后重投，升级连接独立巡检', async t => {
  const f = handoverFixture(t);
  await f.tick();
  f.reply('ci', {code: 'RENEW_HANDOVER_NO_CANDIDATE'});
  await f.tick();
  assert.equal(f.book().lanes.ci.code, 'RENEW_HANDOVER_NO_CANDIDATE');
  assert.equal(f.book().lanes.ci.bindingId, null);
  assert.equal(f.holds, 0);
  f.reply('upgrade', {});
  await f.tick();
  f.now += HOUR - 1;
  await f.tick(); f.request(null);
  f.now++; await f.tick(); f.request('ci');
});
// 审查 N2：让班回执不完整或不匹配时，常驻不停接单。Broker 侧的四项反向校验见“独立审查的 Broker 行为回归”。
test('让班回执缺字段、时刻不可解析或带拒绝码时不触发停接单', async t => {
  const later = () => new Date(Date.now() + 300_000).toISOString();
  for (const reply of [{outcome: 'yielded'}, {outcome: 'yielded', effectiveAt: 'soon'}, {outcome: 'yielded', effectiveAt: later(), code: 'RENEW_CONNECTION_MISMATCH'},
    {outcome: 'yielded', effectiveAt: later(), bindingId: 'not-a-binding'}, {outcome: 'yielded', effectiveAt: later(), expiresAt: 'never'}]) {
    const f = handoverFixture(t);
    await f.tick();
    f.reply('ci', reply);
    await f.tick();
    assert.equal(f.holds, 0, JSON.stringify(reply));
    assert.equal(f.book().lanes.ci.effectiveAt, null, JSON.stringify(reply));
  }
});

// 冷启动、角色未知、积压时投递照常；不发生本地停接单（只有确切让班回执才停），也不换令牌（只在待命且已排空时确认）。
test('让班回执触发角色复核；重启、角色未知或积压时不再停接单、不换令牌', async t => {
  const f = handoverFixture(t);
  await f.tick();
  f.reply('ci', {outcome: 'yielded', effectiveAt: new Date(f.now + 300_000).toISOString()});
  await f.tick();
  assert.equal(f.holds, 1);
  f.reply('upgrade', {}); await f.tick();
  f.restart(); f.now += HOUR;
  await f.tick(); f.request(null); // 冷启动还未取得角色事实
  f.mode = 'STANDBY';
  await f.tick();
  f.reply('ci', {outcome: 'confirm-standby', confirmationId});
  await f.tick(); f.request(null); // 本机尚有工作
  f.now += HOUR - 1; await f.tick(); f.request(null);
  f.now++; await f.tick(); assert.notEqual(f.request('ci'), confirmationId); // 等待期间按小时重投，不是确认
  assert.equal(f.holds, 1, '只因那一张让班回执停过一次');
  f.drained = true;
  f.reply('ci', {outcome: 'confirm-standby', confirmationId});
  await f.tick();
  assert.equal(f.request('ci'), confirmationId);
  f.reply('ci', {bindingId: '10000000-0000-4000-8000-000000000009'});
  await f.tick(); f.request(null);
  assert.equal(f.book().lanes.ci.bindingId, '10000000-0000-4000-8000-000000000009');
  assert.equal(f.holds, 1);
});

test('服务端先见待命，本机角色仍为当班时不能确认换令牌', async t => {
  const f = handoverFixture(t);
  await f.tick();
  f.reply('ci', {outcome: 'confirm-standby', confirmationId});
  f.drained = true;
  await f.tick(); f.request('upgrade');
  assert.equal(f.holds, 0);
});
test('回包丢失不停止当班，每小时复核；失效的排空确认不连续投递', async t => {
  const f = handoverFixture(t);
  await f.tick(); f.request('ci');
  f.now += HOUR; await f.tick();
  assert.equal(f.holds, 0);
  assert.equal(f.book().lanes.ci.code, 'RENEW_RESPONSE_UNAVAILABLE');
  f.reply('upgrade', {}); await f.tick(); f.request(null);
  f.mode = 'STANDBY'; f.drained = true;
  f.now += HOUR; await f.tick();
  f.reply('ci', {outcome: 'confirm-standby', confirmationId}); await f.tick();
  assert.equal(f.request('ci'), confirmationId);
  const replacement = '10000000-0000-4000-8000-000000000006';
  f.reply('ci', {outcome: 'confirm-standby', confirmationId: replacement});
  await f.tick(); f.request(null);
});
test('通用包移除人工令牌输入入口', () => {
  assert.ok(!fs.existsSync(path.join(w, 'replace-ci-token.ps1')));
});

async function residentNode(t, roleFact, now, nodeName = 'turing') {
  let node;
  const board = new StatusBoard({clock: () => node?.clock() ?? now});
  const engine = fakeEngine();
  engine.runRoleProbe = async () => {
    const fact = roleFact();
    return {ok: true, proof: WINDOWS_CLEAN, roleProbe: fact,
      outcome: {status: 'BLOCKED', reason: fact.code, sideEffects: 0, mayHavePublished: false}};
  };
  const profile = {...TEST_NODE, nodeName};
  const policy = rawPolicy({node: profile, nodeProfileSha256: nodeProfileSha256(profile)});
  node = await executorFixture(t, {engine, status: board, now, policy});
  node.exec.versions = async () => ({view: {consistent: true, windows: {
    residentManifestSha256: RESIDENT, ciSourceManifestSha256: CI_SOURCE}}});
  node.status = () => parseStatus(Buffer.from(JSON.stringify(board.snapshot())));
  node.beat = () => heartbeatPayload({nodeName, status: node.status(), now: node.clock(), serviceRunning: true, scope: 'global'});
  return node;
}

const held = {result: 'held', code: 'ROLE_PROBE_HELD'};
const standby = {result: 'not-held', code: 'ROLE_PROBE_NOT_HELD'};
const expired = {result: 'uncertain', code: 'ROLE_PROBE_CONNECTION_UNAUTHORIZED'};

test('7.7 首次到期恢复：旧连接已过期、无在途事务、网关确认不当班且已排空，可发起 CI 自续', async t => {
  let fact = standby;
  const node = await residentNode(t, () => fact, Date.now() - 28 * HOUR);
  await node.exec.tick();
  fact = parseRoleProbe(403, {code: '42501', message: 'authorization_revoked_or_expired'});
  node.advance(28 * HOUR); await node.exec.tick();
  assert.deepEqual([node.beat().mode, node.beat().probe], ['STANDBY', 'uncertain']);
  const watch = handoverFixture(t, {now: node.clock(), mode: () => node.exec.renewalMode(),
    drained: async () => (await node.ledger.open()).length === 0});
  await watch.tick();
  assert.equal(watch.book().pending?.kind, 'ci', JSON.stringify(watch.book().lanes.ci));
  watch.reply('ci', {outcome: 'confirm-standby', confirmationId, expiresAt: new Date(watch.now - 28 * HOUR).toISOString()});
  await watch.tick();
  assert.equal(watch.request('ci'), confirmationId);
});

// 以陪伴进程重启时已有的双活锁开场。另一台一直报告当班，只有本机的角色变化可以解锁。
function companionWithLock(node) {
  const requests = [];
  const duty = new NodeDuty({repo: 'fixture/ci', ghExe: 'fixture-gh', memory: validMemory({lock: {other: 'desk', heads: [HEAD]}}, node.clock()),
    clock: node.clock, staleMs: 300_000, inBudget: () => true,
    run: async argv => ({code: 0, stdout: argv[4] === 'user' ? 'fixture' : JSON.stringify([{
      context: 'resident-queue/desk (info only)', description: '当班：运行中', login: 'fixture',
      created_at: new Date(node.clock()).toISOString()}])}),
    writeRequest: async request => {
      requests.push([request.holder, request.contract]);
      await node.drop(Buffer.from(JSON.stringify(request)), 'requests');
    }});
  const pass = () => duty.prepare({status: node.status(), now: node.clock(), pulls: []});
  return {pass, requests};
}

test('陪伴进程停止续双活保持后，最后一毫秒仍暂停，到两小时自行恢复', async t => {
  let fact = expired;
  const node = await residentNode(t, () => fact, Date.now());
  await node.exec.tick();
  const companion = companionWithLock(node);
  await companion.pass(); await node.exec.tick();
  const until = node.status().intakePause.until;
  assert.equal(until - node.clock(), 2 * HOUR);
  fact = standby;
  node.advance(2 * HOUR - 1); await node.exec.tick();
  assert.equal(node.beat().probe, 'not-held');
  assert.equal(node.beat().state, 'INTAKE_PAUSED');
  node.advance(1); await node.exec.tick();
  assert.equal(node.beat().state, 'NORMAL');
  assert.deepEqual(companion.requests, [['dual-active', INTAKE_PAUSE_CONTRACT]]);
});

test('确认待命只解除双活保持，独立保持满两小时失效，紧急停继续生效', async t => {
  let fact = expired;
  const node = await residentNode(t, () => fact, Date.now());
  const companion = companionWithLock(node);
  for (const holder of ['owner', 'desk']) {
    await node.drop(Buffer.from(JSON.stringify(intakePauseRequest({holder, minutes: 120, reason: '演练'}, node.clock))), 'requests');
  }
  await node.exec.tick(); await companion.pass(); await node.exec.tick();
  const holders = () => node.status().intakePause?.holders.map(h => h.holder).sort();
  assert.deepEqual(holders(), ['desk', 'dual-active', 'owner']);
  node.advance(60_000); fact = standby;
  await node.exec.tick(); await companion.pass(); await node.exec.tick();
  assert.deepEqual(holders(), ['desk', 'owner']);
  assert.equal(node.beat().state, 'INTAKE_PAUSED');
  await node.ledger.pause({reason: 'Owner 急停', requestSha256: 'a'.repeat(64)});
  const emergency = (await node.ledger.paused()).sha256;
  node.advance(2 * HOUR - 60_001); await node.exec.tick(); await companion.pass();
  assert.deepEqual(holders(), ['desk', 'owner']);
  node.advance(1); await node.exec.tick(); await companion.pass();
  assert.equal(node.status().intakePause, null);
  assert.equal(node.beat().state, 'PAUSED');
  assert.equal((await node.ledger.paused()).sha256, emergency);
  assert.deepEqual(companion.requests, [['dual-active', INTAKE_PAUSE_CONTRACT], ['dual-active', INTAKE_RESUME_CONTRACT]]);
});

test('7.7 已提交的 TURING 自续恢复、NORMAL 心跳、候选、DESK 让班及排空后两类自续', {skip: process.platform !== 'win32'}, async t => {
  const start = Date.now();
  const deskId = '20000000-0000-4000-8000-000000000001';
  const deskNext = '20000000-0000-4000-8000-000000000002';
  const upgradeNext = '30000000-0000-4000-8000-000000000002';
  let turingConnection = bindingId, member = bindingId, heartbeatLink = bindingId, serving = deskId;
  const enabled = true;
  const turing = await residentNode(t, () => turingConnection === bindingId ? expired : serving === turingConnection ? held : standby, start);
  const desk = await residentNode(t, () => serving === deskId ? held : standby, start, 'desk');
  const advance = ms => { turing.advance(ms); desk.advance(ms); };
  const companion = companionWithLock(turing);
  await turing.exec.tick(); await companion.pass(); await turing.exec.tick();
  assert.equal(turing.beat().probe, 'uncertain');
  assert.equal(turing.beat().state, 'INTAKE_PAUSED');
  advance(31 * 60_000);
  await turing.exec.tick(); await companion.pass(); await turing.exec.tick();
  const lastUntil = turing.status().intakePause.until;
  assert.equal(lastUntil - turing.clock(), 2 * HOUR);
  assert.deepEqual(companion.requests, Array(2).fill(['dual-active', INTAKE_PAUSE_CONTRACT]));

  // Broker 以已提交事务修复本地连接。服务端替身按换绑协议迁移该行的两个引用。
  const recovery = spawnSync(compileBrokerFixture(t), ['--recover-committed-ci'], {encoding: 'utf8', windowsHide: true});
  assert.equal(recovery.status, 0, recovery.stderr);
  const recovered = JSON.parse(recovery.stdout);
  assert.notEqual(recovered.bindingId, member);
  assert.equal(recovered.generation, 2);
  turingConnection = member = heartbeatLink = recovered.bindingId;
  await desk.exec.tick();
  const receive = () => ({binding: heartbeatLink, at: turing.clock(), payload: turing.beat()});
  // 两台同源、无冷却/排除且 DESK 活跃的夹具，按 ci_failover_candidates_v1 的本次条件判定。
  const candidate = report => {
    const p = report.payload;
    return enabled && report.binding === member && member !== serving && Date.parse(recovered.expiresAt) > desk.clock()
      && desk.clock() - report.at < 20 * 60_000 && p.service_running && p.mode === 'STANDBY' && p.probe === 'not-held'
      && p.state === 'NORMAL' && p.ci_source_manifest_sha256 === CI_SOURCE && p.ci_source_manifest_sha256 === desk.beat().ci_source_manifest_sha256
      ? member : null;
  };
  assert.equal(candidate(receive()), null);
  advance(2 * 60_000);
  await turing.exec.tick();
  assert.equal(turing.beat().probe, 'not-held');
  assert.equal(candidate(receive()), null, '明确待命但仍有保持');
  await companion.pass(); await turing.exec.tick();
  assert.ok(turing.clock() < lastUntil);
  const ready = receive();
  assert.deepEqual([ready.payload.state, ready.payload.mode, ready.payload.probe], ['NORMAL', 'STANDBY', 'not-held']);
  const ack = parseHeartbeatReply({status: 'ok', node_binding_id: ready.binding, via_link: true});
  assert.deepEqual([ack.ok, ack.viaLink, ack.nodeBindingId], [true, true, recovered.bindingId]);
  const target = candidate(ready);
  assert.equal(target, recovered.bindingId);

  let runnerBusy = true;
  const watch = handoverFixture(t, {now: desk.clock(), currentBinding: deskId, mode: () => desk.exec.renewalMode(),
    drained: async () => !runnerBusy && (await desk.ledger.open()).length === 0, onHandover: () => desk.exec.requestHandoverProbe()});
  // 升级连接日检在交班后才轮到。两个类别的续期回执分别绑定到本轮邮箱请求。
  fs.writeFileSync(path.join(watch.root, 'state/connection-renewal.json'), JSON.stringify({
    lanes: {upgrade: {at: watch.now - 22 * HOUR}}, pending: null}));
  await watch.tick(); watch.request('ci');
  const effective = desk.clock() + 300_000;
  watch.reply('ci', {outcome: 'yielded', effectiveAt: new Date(effective).toISOString()});
  serving = null;
  await watch.tick(); watch.request(null);
  assert.equal(desk.exec.renewalMode(), 'UNCERTAIN');
  advance(300_000); serving = target;
  await turing.exec.tick(); await desk.exec.tick();
  assert.equal(turing.exec.nodeMode(), 'ACTIVE');
  assert.equal(desk.exec.renewalMode(), 'STANDBY');
  advance(HOUR - 300_000); watch.now = desk.clock();
  await watch.tick(); watch.request('ci');
  watch.reply('ci', {outcome: 'confirm-standby', confirmationId});
  await watch.tick(); watch.request(null);
  assert.equal(watch.book().lanes.ci.code, 'CI_REBIND_NOT_DRAINED');
  runnerBusy = false;
  advance(HOUR); watch.now = desk.clock(); await watch.tick();
  const afterDrain = '20000000-0000-4000-8000-000000000003';
  watch.reply('ci', {outcome: 'confirm-standby', confirmationId: afterDrain});
  await watch.tick(); assert.equal(watch.request('ci'), afterDrain);
  watch.reply('ci', {bindingId: deskNext}); await watch.tick();
  watch.reply('upgrade', {bindingId: upgradeNext}); await watch.tick(); watch.request(null);
  const lanes = watch.book().lanes;
  assert.deepEqual([lanes.ci.bindingId, lanes.upgrade.bindingId, lanes.ci.code, lanes.upgrade.code], [deskNext, upgradeNext, null, null]);
  advance(2 * HOUR);
  await turing.exec.tick(); await companion.pass(); await turing.exec.tick();
  assert.equal(turing.beat().state, 'NORMAL');
  assert.deepEqual(companion.requests.slice(2), [['dual-active', INTAKE_RESUME_CONTRACT]]);
  const check = drillFixture(t).drill();
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.equal(JSON.parse(check.stdout).result, 'PASS');
});

test('独立审查的 Broker 行为回归', {skip:process.platform !== 'win32'}, async t => {
  const exe = compileBrokerFixture(t);
  const run = (...args) => {
    const r = spawnSync(exe,args,{encoding:'utf8',windowsHide:true});
    assert.equal(r.status,0,r.stderr);
    return r.stdout.trim();
  };
  await t.test('T1 TURING PCP 公钥块准入',()=>run('turing-key-admission',path.join(resident,'test/fixtures/renew-key-facts-turing-pcp.json')));
  await t.test('T2 拒绝曲线、用途、导出策略、机器属性和公钥块尺寸不符',()=>run('key-admission-facts'));
  await t.test('T3 软件 KSP 三把临时密钥只有 ECDSA P-256 公钥块通过',()=>run('key-software-facts'));
  await t.test('T4 Broker 续期密钥准入禁止使用提供程序自报的算法属性',()=>run('key-admission-source',path.join(w,'SwapBroker.cs')));
  await t.test('T5 打不开密钥时记录两个 KSP 原始 HResult',()=>run('key-open-failure'));
  await t.test('T5 准入失败指明拒绝项',()=>run('key-admit-failure'));
  const contract=JSON.parse(fs.readFileSync(serverContract,'utf8'));
  await t.test('S1 网关属于正式路由且路径与 D1 相同', () => {
    const url = new URL(run('route'));
    const repo = path.resolve(resident, '../..');
    const config = JSON.parse(fs.readFileSync(path.join(repo, 'apps/clued-cloud/wrangler.production.jsonc'),'utf8'));
    assert.ok(config.routes.some(r => r.custom_domain && r.pattern === url.host), url.host);
    assert.equal(url.href, contract.endpoint);
    assert.equal(url.href, 'https://'+url.host+url.pathname);
  });
  await t.test('C# 对服务端固定让班向量逐字节验签',()=>run('signature-vector',serverContract));
  for(const scenario of ['closed-window','missing-window','yield-evidence','probe-evidence','yield-clear-marker','probe-clear-marker','prior-superseded'])
    await t.test('Broker '+scenario,()=>run('gateway-scenario',scenario,'ci'));
  // 审查 N2：让班回执的反向校验，每次只坏一个字段；Broker 拒绝、零写入、不给出让班结果（常驻因此不停接单）。
  for(const scenario of ['yield-ack-from','yield-ack-to-invalid','yield-ack-to-self','yield-ack-receipt','yield-ack-effective'])
    await t.test('让班回执反向校验 '+scenario,()=>run('gateway-scenario',scenario,'ci'));
  await t.test('升级连接也消费服务端窗口',()=>run('gateway-scenario','closed-window','upgrade'));
  await t.test('在途事务已替换时保留新事务',()=>run('changed-in-flight'));
  await t.test('待批必须提供有效请求编号和重试间隔',()=>run('bad-pending'));
  // 审查 N1：任何拒绝应答的原码按网关同一形状 ^[A-Z_]{3,80}$ 透传；形状不符才压成 RENEW_GATEWAY_REFUSED。
  const wireCases=[[403,'RENEW_SOURCE_REQUIRED'],[429,'RENEW_RATE_LIMITED'],[409,'RENEW_DISCOVERY_AMBIGUOUS'],
    ...passedCodes.map(code=>[409,code]),[404,'RENEW_ROUTE_INVALID'],[400,'RENEW_TIME_INVALID'],
    ...['AB','A'.repeat(81),'renew_lower','RENEW-DASH','RENEW_1',''].map(code=>[409,code,'RENEW_GATEWAY_REFUSED']),
    [403,'renew_lower','RENEW_GATEWAY_REFUSED'],
    [503,'RENEW_INTERNAL_RETRY','RENEW_GATEWAY_UNAVAILABLE'],[503,'RENEW_UNAVAILABLE','RENEW_GATEWAY_UNAVAILABLE'],
    [503,'','RENEW_GATEWAY_UNAVAILABLE','empty']];
  for(const [status,code,expected=code,body='json'] of wireCases)
    await t.test('网关 '+status+' '+(code||'空响应'),()=>run('wire-code',String(status),code,expected,body));
  await t.test('换发清理矩阵覆盖合同全表、标志类型和未确认传输',()=>{
    for(const code of contract.clear_intent.codes) for(const marker of ['false','absent','true','text'])
      run('intent-evidence',code,marker,marker==='false'?'clear':'keep','409',code);
    for(const code of ['RENEW_REPLACEMENT_UNUSABLE','RENEW_PROOF_REFUSED','RENEW_INTERNAL_RETRY'])
      run('intent-evidence',code,'false','keep',code==='RENEW_INTERNAL_RETRY'?'503':'409',code==='RENEW_INTERNAL_RETRY'?'RENEW_GATEWAY_UNAVAILABLE':code);
  });
  for (const name of ['pin','clear','readback','without-replay','extra-self','terminal','changed-local','wire','files','swap','interrupt'])
    await t.test(name, () => run(name,path.dirname(exe)));
});

test('S2 角色不确定且旧连接过期：未排空时照常投递但不停接单、不换令牌，排空后完成两次邮箱投递', async t => {
  const f = handoverFixture(t);
  f.mode='UNCERTAIN';
  const expired=()=>new Date(f.now-HOUR).toISOString();
  await f.tick();
  f.reply('ci',{outcome:'confirm-standby',confirmationId,expiresAt:expired()});
  await f.tick();
  assert.deepEqual([f.holds,f.book().lanes.ci.code],[0,'CI_REBIND_NOT_DRAINED']);
  f.reply('upgrade',{}); await f.tick(); f.request(null);
  f.drained=true; f.now+=HOUR; await f.tick(); assert.notEqual(f.request('ci'),confirmationId);
  f.reply('ci',{outcome:'confirm-standby',confirmationId,expiresAt:expired()});
  await f.tick(); assert.equal(f.request('ci'),confirmationId);
});

test('M3 陪伴文件缺席与当班控制观测', () => {
  const now=Date.now(), at=new Date(now).toISOString();
  const system={at,sid:'S-1-5-18',provider:'Microsoft Platform Crypto Provider',code:null};
  const row=sid=>({at,sid,tpm:'DENIED',software:'ABSENT'});
  const service='S-1-5-80-'+Array.from({length:5},(_,i)=>sidHash.readUInt32LE(4*i)).join('-');
  const companion={...row('helper'),'ci-admission.token':'DENIED','ci-admission.connection.json':'ABSENT'};
  const controller={...row('controller'),at:new Date(now-4*HOUR).toISOString()};
  const check=mode=>keyCheck(system,row(service),controller,companion,{controllerSid:'controller',ownerSid:'helper'},now,mode);
  assert.equal(check('ACTIVE').result,'PASS');
  assert.equal(check('STANDBY').controller,false);
  const priorAt=controller.at;
  controller.at=new Date(now+86_400_000).toISOString();
  assert.equal(check('ACTIVE').controller,false);
  controller.at=priorAt;
  controller.tpm='OPEN'; assert.equal(check('ACTIVE').controller,false);
});

test('M3 续期通知独立于用完即弃自检', async t=>{
  const f=handoverFixture(t);
  const dir=path.join(f.root,'upgrade/mailbox/responses');
  fs.mkdirSync(dir,{recursive:true});
  const at=new Date(f.now).toISOString();
  fs.writeFileSync(path.join(dir,'selfcheck.json'),JSON.stringify({contract:'clued.independent-ci.node-selfcheck/1',
    at,observedAt:at,view:{ok:true,code:null,failures:[]},containers:{count:0,code:null}}));
  const options={root:f.root,policy:{residentManifestSha256:RESIDENT,ciSourceManifestSha256:CI_SOURCE},clock:()=>f.now};
  const before=await readVersionState(options);
  assert.equal(before.view.selfcheck.result,'PASS');
  await f.tick();
  const after=await readVersionState(options);
  assert.deepEqual(after.view.selfcheck,before.view.selfcheck);
  const notice=after.notices.find(n=>n.kind==='renewal-failed' && n.code==='RENEW_KEY_CHECK_FAILED');
  assert.ok(notice);
  const toast=events({status:{writtenAt:f.now,pending:[],notices:[notice]},now:f.now});
  assert.match(toast[0].title,/连接续期/);
  assert.match(toast[0].body,/versions\.renewal/);
});

// 缺陷 c7ea4ea1（Fable 11-20“补：续期不等”B）：升级正是为修上一代得到的拒绝，上一代写下的拒绝不再让本代等满退避；
// 通道记录跨升级保留，让班等待、生效时间、绑定、到期原样生效。代的标识是本代 Source 摘要（policy.ciSourceManifestSha256）。
const OTHER_SOURCE = 'a'.repeat(64);
const refusedLane = (at, extra = {}) => ({at, waiting: false, effectiveAt: null, code: 'RENEW_IDENTITY_KEY_UNAVAILABLE', bindingId: null,
  expiresAt: null, renewalWindowOpensAt: null, grantRequestId: null, retryAfterSeconds: null, ...extra});
const seedBook = (f, lanes) => fs.writeFileSync(path.join(f.root, 'state/connection-renewal.json'), JSON.stringify({lanes, pending: null}));
test('上一代写下的拒绝（标识不同或缺失）不计退避：本代启动第一轮即投，两类连接依次重投', async t => {
  for (const marker of [{}, {source: OTHER_SOURCE}]) {
    const f = handoverFixture(t);
    seedBook(f, {ci: refusedLane(f.now - HOUR, marker), upgrade: refusedLane(f.now - HOUR, marker)});
    f.restart();
    await f.tick(); f.request('ci');
    f.reply('ci', {code: 'RENEW_IDENTITY_KEY_UNAVAILABLE'});
    await f.tick(); f.request('upgrade');
    assert.equal(f.book().lanes.ci.source, CI_SOURCE, '本代写下的通道记录带本代标识');
    f.reply('upgrade', {code: 'RENEW_IDENTITY_KEY_UNAVAILABLE'});
    await f.tick(); f.request(null);
    assert.equal(f.book().lanes.upgrade.source, CI_SOURCE);
    f.now += 24 * HOUR - 1; await f.tick(); f.request(null);
    f.now++; await f.tick(); f.request('ci');
  }
});
test('本代写下的拒绝仍按原退避：密钥不可用一小时前，满一天才重投', async t => {
  const f = handoverFixture(t);
  seedBook(f, {ci: refusedLane(f.now - HOUR, {source: CI_SOURCE}), upgrade: refusedLane(f.now - HOUR, {source: CI_SOURCE})});
  f.restart();
  await f.tick(); f.request(null);
  f.now += 23 * HOUR - 1; await f.tick(); f.request(null);
  f.now++; await f.tick(); f.request('ci');
});
test('上一代的让班等待、生效时间、绑定、到期跨代原样生效，不因换代提前投递；上一代的成功续期仍按日', async t => {
  const f = handoverFixture(t);
  f.mode = 'UNCERTAIN';
  const ci = {at: f.now - 10 * 60_000, waiting: true, effectiveAt: new Date(f.now + 300_000).toISOString(), code: 'RENEW_HANDOVER_WAITING',
    bindingId, expiresAt: new Date(f.now + 10 * 24 * HOUR).toISOString(), renewalWindowOpensAt: null, grantRequestId: null, retryAfterSeconds: null};
  const upgrade = {...refusedLane(f.now - HOUR), code: null, bindingId: confirmationId, expiresAt: new Date(f.now + 20 * 24 * HOUR).toISOString()};
  seedBook(f, {ci, upgrade});
  f.restart();
  await f.tick(); f.request(null);
  assert.deepEqual(f.book().lanes, {ci, upgrade});
  f.now += HOUR; await f.tick(); f.request(null); // 旧连接仍可用：等角色探询，不投
  assert.deepEqual(f.book().lanes, {ci, upgrade});
  f.now += 23 * HOUR - 10 * 60_000; await f.tick(); f.request('upgrade');
});
test('常驻必须带上本代 Source 摘要才能续期', () => {
  for (const source of [undefined, null, 'E'.repeat(64), 'e'.repeat(63)])
    assert.throws(() => renewalWatch({root: os.tmpdir(), profile: {}, mode: () => 'STANDBY', source}), /RENEW_SOURCE_REQUIRED/);
});

// Task eb73b396（Fable 11-20“补：升级中续期——不读升级状态，改用本进程启动后的宽限”）：换代必然重启常驻进程；
// 本进程启动后满一个检查周期才发起第一条新的续期。判据只用进程启动时刻与单调时钟。让班等待中的重投与确认、自检不受宽限约束。
const CHECK = 10 * 60_000;
const requestFiles = f => fs.readdirSync(path.join(f.root, 'broker/requests'));
test('进程刚启动未满一个检查周期：不投、请求邮箱无新文件、不写通道记录、不计退避；自检照写', async t => {
  const f = handoverFixture(t);
  f.startedAt = f.now; f.restart();
  await f.tick(); f.request(null);
  assert.deepEqual([requestFiles(f), f.book().lanes, f.book().pending], [[], {}, null]);
  assert.deepEqual([typeof f.book().keys?.result, f.book().checkedAt], ['string', new Date(f.now).toISOString()], '宽限内自检照写');
  f.now += CHECK - 1; await f.tick(); f.request(null);
  assert.deepEqual([requestFiles(f), f.book().lanes], [[], {}]);
  f.now += 1; await f.tick(); f.request('ci');
  assert.equal(requestFiles(f).length, 1);
});
test('进程已启动满一个检查周期：第一轮即投', async t => {
  const f = handoverFixture(t);
  f.startedAt = f.now - CHECK; f.restart();
  await f.tick(); f.request('ci');
});
test('让班等待中进程重启：已有的等待重投与确认不受宽限影响，宽限只挡新的投递', async t => {
  const f = handoverFixture(t);
  f.mode = 'STANDBY'; f.drained = true;
  seedBook(f, {ci: {at: f.now - HOUR, source: CI_SOURCE, waiting: true, effectiveAt: null, code: 'CI_REBIND_NOT_DRAINED', bindingId,
    expiresAt: new Date(f.now + 10 * 24 * HOUR).toISOString(), renewalWindowOpensAt: null, grantRequestId: null, retryAfterSeconds: null},
  upgrade: {...refusedLane(f.now - 24 * HOUR, {source: CI_SOURCE}), code: null}});
  f.startedAt = f.now; f.restart();
  await f.tick();
  f.reply('ci', {outcome: 'confirm-standby', confirmationId});
  await f.tick(); assert.equal(f.request('ci'), confirmationId);
  f.reply('ci', {}); await f.tick();
  assert.deepEqual([f.book().lanes.ci.code, f.book().lanes.ci.waiting], [null, false]);
  f.request(null);
  assert.equal(requestFiles(f).length, 2, '宽限内只有等待重投与确认两份请求');
  f.now = f.startedAt + CHECK; await f.tick(); f.request('upgrade');
});

// Task a75da4bd（Fable 11-20“补：让班回包迟到”(2)）：DESK 11-20 10:42:32 投出 ci 请求，服务端 10:45:14 提交让班，常驻只等 120 秒就把
// 请求号丢了。超时不再丢弃请求号：120 秒后只改对外显示，之后每轮都看这一个回包；满一小时仍无回包才按“回包不可用”。
import { renewalStatus } from '../src/connection-renewal.mjs';
const RENEW_RESPONSE = 'clued.independent-ci.connection-renew-response/1';
const answer = (f, id, kind, reply) => fs.writeFileSync(path.join(f.root, 'broker/responses', id + '.json'), JSON.stringify({
  contract: RENEW_RESPONSE, requestId: id, kind, code: null, bindingId, expiresAt: new Date(f.now + 10 * 24 * HOUR).toISOString(), ...reply}));
test('让班回包在第 160 秒到达（120 秒内无回包）：按已让班处理，交出接单并记生效时刻', async t => {
  const f = handoverFixture(t);
  await f.tick(); const id = f.request('ci');
  f.now += 120_000; await f.tick(); // 到点无回包
  f.now += 40_000;
  assert.equal(requestFiles(f).length, 1, '等回包期间没有投新请求');
  const effectiveAt = new Date(f.now + 301_000).toISOString();
  answer(f, id, 'ci', {outcome: 'yielded', effectiveAt});
  await f.tick();
  assert.equal(f.holds, 1, '迟到的让班回包照常交出接单资格');
  assert.deepEqual([f.book().lanes.ci.code, f.book().lanes.ci.waiting, f.book().lanes.ci.effectiveAt], ['RENEW_HANDOVER_WAITING', true, effectiveAt]);
});
test('已续上的回包在第 150 秒到达：按已续上处理，记新绑定与到期', async t => {
  const f = handoverFixture(t);
  const renewed = '10000000-0000-4000-8000-000000000007';
  await f.tick(); const id = f.request('ci');
  f.now += 120_000; await f.tick();
  f.now += 30_000;
  const expiresAt = new Date(f.now + 30 * 24 * HOUR).toISOString();
  answer(f, id, 'ci', {bindingId: renewed, expiresAt});
  await f.tick();
  const lane = f.book().lanes.ci;
  assert.deepEqual([lane.code, lane.waiting, lane.bindingId, lane.expiresAt, f.holds], [null, false, renewed, expiresAt, 0]);
});
test('等回包期间不投新请求；120 秒后对外显示“等回包”，满一小时前一直等同一请求号', async t => {
  const f = handoverFixture(t);
  await f.tick(); const id = f.request('ci');
  f.now += 120_000 - 1; await f.tick();
  assert.equal((await renewalStatus(f.root, f.now)).connections.ci, undefined, '120 秒内对外不显示');
  f.now += 1; await f.tick();
  assert.equal((await renewalStatus(f.root, f.now)).connections.ci.code, 'RENEW_RESPONSE_WAITING');
  while (f.now - f.startedAt < 10 * 60_000 + HOUR - 15_000) { f.now += 15_000; await f.tick(); }
  assert.deepEqual([f.book().pending?.id, requestFiles(f).length, f.book().lanes.ci], [id, 1, undefined]);
  assert.equal(f.holds, 0);
});
test('一小时内回包始终不出现：满一小时才按回包不可用处理，进入每小时复核，不交出当班', async t => {
  const f = handoverFixture(t);
  await f.tick(); const id = f.request('ci');
  f.now += HOUR - 1; await f.tick();
  assert.deepEqual([f.book().pending?.id, f.book().lanes.ci], [id, undefined]);
  f.now += 1; await f.tick();
  assert.deepEqual([f.book().lanes.ci.code, f.book().lanes.ci.waiting, f.holds], ['RENEW_RESPONSE_UNAVAILABLE', true, 0]);
  f.reply('upgrade', {}); await f.tick(); f.request(null);
  answer(f, id, 'ci', {outcome: 'yielded', effectiveAt: new Date(f.now + 300_000).toISOString()}); // 已放弃、状态里不再记着这个请求号：不再认
  f.now += HOUR - 1; await f.tick(); f.request(null);
  assert.equal(f.holds, 0);
  f.now += 1; await f.tick(); assert.notEqual(f.request('ci'), id);
});
test('只认状态里记着的请求号：别的请求号的回包、文件内请求号不符的回包都不认', async t => {
  const f = handoverFixture(t);
  const other = '10000000-0000-4000-8000-000000000008';
  await f.tick(); const id = f.request('ci');
  f.now += 120_000; await f.tick();
  f.now += 20_000;
  answer(f, other, 'ci', {outcome: 'yielded', effectiveAt: new Date(f.now + 300_000).toISOString()});
  fs.writeFileSync(path.join(f.root, 'broker/responses', id + '.json'), JSON.stringify({contract: RENEW_RESPONSE, requestId: other, kind: 'ci',
    code: null, bindingId, expiresAt: new Date(f.now + 10 * 24 * HOUR).toISOString(), outcome: 'yielded', effectiveAt: new Date(f.now + 300_000).toISOString()}));
  await f.tick();
  assert.deepEqual([f.holds, f.book().pending?.id, f.book().lanes.ci], [0, id, undefined]);
  f.now += 20_000;
  answer(f, id, 'ci', {outcome: 'yielded', effectiveAt: new Date(f.now + 300_000).toISOString()});
  await f.tick();
  assert.equal(f.holds, 1);
});
test('等回包期间常驻重启：恢复同一请求号继续等，启动宽限不妨碍读回包', async t => {
  const f = handoverFixture(t);
  await f.tick(); const id = f.request('ci');
  f.now += 120_000; await f.tick();
  f.now += 10_000; f.startedAt = f.now; f.restart();
  await f.tick();
  assert.deepEqual([f.book().pending?.id, requestFiles(f).length], [id, 1], '重启后仍等同一请求号');
  f.now += 30_000;
  answer(f, id, 'ci', {outcome: 'yielded', effectiveAt: new Date(f.now + 300_000).toISOString()});
  await f.tick();
  assert.equal(f.holds, 1);
  assert.equal(f.book().lanes.ci.code, 'RENEW_HANDOVER_WAITING');
});

// Fable 11-20“让班回包迟到——一小时截止的语义”：采纳与否不看时间，只看是不是状态里还在等的那个请求号的回包。
// 很晚才读到的已让班照常处理：生效时刻已过也立即交出接单资格（含重启后）。
test('按请求号采纳：第 3599 秒空读、第 3601 秒写入让班、第 3610 秒读到——采纳；生效时刻已过也立即交出接单', async t => {
  for (const [restart, effectiveIn] of [[false, 300_000], [true, 300_000], [false, -3_000_000]]) {
    const f = handoverFixture(t);
    await f.tick(); const id = f.request('ci');
    const at = f.now;
    f.now = at + 3_599_000; await f.tick();
    assert.equal(f.book().pending?.id, id);
    f.now = at + 3_601_000;
    const effectiveAt = new Date(f.now + effectiveIn).toISOString();
    answer(f, id, 'ci', {outcome: 'yielded', effectiveAt});
    f.now = at + 3_610_000;
    if (restart) { f.startedAt = f.now; f.restart(); }
    await f.tick();
    assert.equal(f.holds, 1, JSON.stringify({restart, effectiveIn}));
    assert.deepEqual([f.book().lanes.ci.code, f.book().lanes.ci.waiting, f.book().lanes.ci.effectiveAt], ['RENEW_HANDOVER_WAITING', true, effectiveAt]);
  }
});
// 中2：在途请求归属投出它的那一代。B 代消费 A 代请求的拒绝，通道记录记 A 代的 Source，B 代不按本代退避；旧格式在途记录（无 Source）按跨代。
test('A 代投出、B 代消费 A 代请求的密钥不可用拒绝：记为 A 代，B 代宽限一过即重投；旧格式在途记录同样按跨代', async t => {
  for (const legacy of [false, true]) {
    const f = handoverFixture(t);
    await f.tick(); const id = f.request('ci');
    f.now += 120_000; await f.tick();
    if (legacy) {
      const book = f.book(); delete book.pending.source;
      fs.writeFileSync(path.join(f.root, 'state/connection-renewal.json'), JSON.stringify(book));
    }
    f.source = OTHER_SOURCE; f.now += 10_000; f.startedAt = f.now; f.restart(); // 换代：常驻以 B 代重启
    f.now += 30_000;
    answer(f, id, 'ci', {code: 'RENEW_IDENTITY_KEY_UNAVAILABLE'});
    await f.tick(); f.request(null);
    assert.deepEqual([f.book().lanes.ci.code, f.book().lanes.ci.source ?? null], ['RENEW_IDENTITY_KEY_UNAVAILABLE', legacy ? null : CI_SOURCE]);
    f.now = f.startedAt + CHECK - 1; await f.tick(); f.request(null);
    f.now += 1; await f.tick();
    assert.equal(f.request('ci') === id, false);
    assert.equal(f.book().pending.kind, 'ci', 'B 代不为 A 代的拒绝退避一天');
  }
});
// 低1：“等回包”不是失败，不发 renewal-failed 通知；状态视图照样显示等待码。
test('等回包超过 120 秒：状态视图显示等待码，但不产生续期失败通知', async t => {
  const f = handoverFixture(t);
  await f.tick(); f.request('ci');
  f.now += 120_000; await f.tick();
  const {view, notices} = await readVersionState({root: f.root, policy: {residentManifestSha256: RESIDENT, ciSourceManifestSha256: CI_SOURCE}, clock: () => f.now});
  assert.equal(view.renewal.connections.ci.code, 'RENEW_RESPONSE_WAITING');
  assert.deepEqual(notices.filter(n => n.kind === 'renewal-failed' && n.code === 'RENEW_RESPONSE_WAITING'), []);
});
// 低2：迟到的确认待命、迟到的拒绝各走原分支。
test('确认待命的回包在第 160 秒到达：待命且已排空即投确认号', async t => {
  const f = handoverFixture(t);
  f.mode = 'STANDBY'; f.drained = true;
  await f.tick(); const id = f.request('ci');
  f.now += 120_000; await f.tick();
  f.now += 40_000;
  answer(f, id, 'ci', {outcome: 'confirm-standby', confirmationId});
  await f.tick();
  assert.equal(f.request('ci'), confirmationId);
  assert.deepEqual([f.book().lanes.ci.code, f.book().lanes.ci.waiting, f.holds], ['CI_REBIND_NOT_DRAINED', true, 0]);
});
test('拒绝的回包在第 160 秒到达：原码落盘，不交出当班，按该码节奏重投', async t => {
  const f = handoverFixture(t);
  await f.tick(); const id = f.request('ci');
  f.now += 120_000; await f.tick();
  f.now += 40_000;
  answer(f, id, 'ci', {code: 'RENEW_HANDOVER_NO_CANDIDATE'});
  await f.tick();
  assert.deepEqual([f.book().lanes.ci.code, f.book().lanes.ci.waiting, f.holds], ['RENEW_HANDOVER_NO_CANDIDATE', false, 0]);
  f.reply('upgrade', {}); await f.tick(); f.request(null);
  f.now += HOUR - 1; await f.tick(); f.request(null);
  f.now += 1; await f.tick(); assert.notEqual(f.request('ci'), id);
});

// Codex 复审 3d59ee58e 的两个跨界时序，按 Fable 截止语义一律采纳。
test('按请求号采纳：重启首轮第 3599 秒开始、自检期间第 3601 秒写入让班、第 3603 秒读到——采纳', async t => {
  const f = handoverFixture(t);
  await f.tick(); const id = f.request('ci');
  const at = f.now;
  f.now = at + 3_590_000; await f.tick();
  f.now = at + 3_599_000; f.startedAt = f.now;
  f.observe = async () => { // 重启后的首轮先做自检（最长 10 秒），Broker 在这期间发布回包
    f.now = at + 3_601_000;
    answer(f, id, 'ci', {outcome: 'yielded', effectiveAt: new Date(f.now + 300_000).toISOString()});
    f.now = at + 3_603_000;
    return null;
  };
  f.restart(); await f.tick();
  assert.equal(f.holds, 1);
  assert.equal(f.book().lanes.ci.code, 'RENEW_HANDOVER_WAITING');
});
test('按请求号采纳：第 3590 秒空读、第 3599 秒写入让班、第 3605 秒读到——采纳', async t => {
  const f = handoverFixture(t);
  await f.tick(); const id = f.request('ci');
  const at = f.now;
  f.now = at + 3_590_000; await f.tick();
  assert.equal(f.book().pending?.id, id);
  f.now = at + 3_599_000;
  answer(f, id, 'ci', {outcome: 'yielded', effectiveAt: new Date(f.now + 300_000).toISOString()});
  f.now = at + 3_605_000; await f.tick();
  assert.equal(f.holds, 1);
  assert.equal(f.book().lanes.ci.code, 'RENEW_HANDOVER_WAITING');
});
test('按请求号采纳：第 3599 秒开始的一轮读到让班——采纳', async t => {
  const f = handoverFixture(t);
  await f.tick(); const id = f.request('ci');
  const at = f.now;
  f.now = at + 3_598_000;
  answer(f, id, 'ci', {outcome: 'yielded', effectiveAt: new Date(f.now + 300_000).toISOString()});
  f.now = at + 3_599_000; await f.tick();
  assert.equal(f.holds, 1);
  assert.equal(f.book().lanes.ci.code, 'RENEW_HANDOVER_WAITING');
});
test('一小时到点的那一轮回包恰好出现：采纳，不进入回包不可用', async t => {
  for (const reply of [{outcome: 'yielded', effectiveAt: null}, {code: 'RENEW_HANDOVER_NO_CANDIDATE'}]) {
    const f = handoverFixture(t);
    await f.tick(); const id = f.request('ci');
    const at = f.now;
    f.now = at + HOUR - 15_000; await f.tick();
    f.now = at + HOUR;
    answer(f, id, 'ci', {...reply, ...(reply.outcome ? {effectiveAt: new Date(f.now + 300_000).toISOString()} : {})});
    await f.tick();
    assert.deepEqual([f.book().lanes.ci.code, f.holds], reply.outcome ? ['RENEW_HANDOVER_WAITING', 1] : ['RENEW_HANDOVER_NO_CANDIDATE', 0]);
  }
});
test('放弃后已换成新请求号：旧请求号的回包不采纳，只认新请求号', async t => {
  const f = handoverFixture(t);
  await f.tick(); const old = f.request('ci');
  f.now += HOUR; await f.tick(); // 满一小时仍无回包：放弃，按回包不可用
  assert.equal(f.book().lanes.ci.code, 'RENEW_RESPONSE_UNAVAILABLE');
  f.reply('upgrade', {}); await f.tick();
  f.now += HOUR; await f.tick(); const fresh = f.request('ci');
  assert.notEqual(fresh, old);
  answer(f, old, 'ci', {outcome: 'yielded', effectiveAt: new Date(f.now + 300_000).toISOString()});
  f.now += 15_000; await f.tick();
  assert.deepEqual([f.holds, f.book().pending?.id], [0, fresh]);
  answer(f, fresh, 'ci', {});
  f.now += 15_000; await f.tick();
  assert.deepEqual([f.holds, f.book().lanes.ci.code, f.book().pending], [0, null, null]);
});
// 低1：没有回包时常驻自己记下的“回包不可用”不是服务端的拒绝，按结清它的当前代记，照常每小时复核；只有服务端回包里的拒绝才按投递代记。
test('A 代投出升级请求、B 代重启后满一小时仍无回包：按当前代记回包不可用，每小时复核，不当轮重投', async t => {
  for (const legacy of [false, true]) {
    const f = handoverFixture(t);
    await f.tick(); f.reply('ci', {}); await f.tick();
    const id = f.request('upgrade'), at = f.now;
    if (legacy) {
      const book = f.book(); delete book.pending.source;
      fs.writeFileSync(path.join(f.root, 'state/connection-renewal.json'), JSON.stringify(book));
    }
    f.now = at + 10 * 60_000; f.source = OTHER_SOURCE; f.startedAt = f.now; f.restart(); await f.tick();
    f.now = at + HOUR; await f.tick();
    assert.deepEqual([f.book().lanes.upgrade.code, f.book().lanes.upgrade.waiting, f.book().lanes.upgrade.source], ['RENEW_RESPONSE_UNAVAILABLE', false, OTHER_SOURCE]);
    f.request(null);
    f.now += HOUR - 1; await f.tick(); f.request(null);
    f.now += 1; await f.tick(); assert.notEqual(f.request('upgrade'), id);
  }
});

// 协调者按裁定字面对齐（规则 3）：放弃（记回包不可用、每小时复核）时旧请求号仍留在状态里，直到投出新请求换成新号；
// 期间任何一轮读到旧号的匹配回包照常采纳（让班生效已过也立即交出接单资格）；换号后旧号的回包不采纳。
test('放弃后、新请求投出前读到旧号回包：采纳；新号投出后再读到旧号回包：不采纳', async t => {
  const upgradeFresh = f => ({upgrade: {...refusedLane(f.now - HOUR, {source: CI_SOURCE}), code: null}}); // 升级通道一天内不到期
  for (const effectiveIn of [300_000, -3_000_000]) {
    const f = handoverFixture(t);
    seedBook(f, upgradeFresh(f)); f.restart();
    await f.tick(); const old = f.request('ci');
    f.now += HOUR; await f.tick(); // 满一小时仍无回包：放弃
    assert.deepEqual([f.book().lanes.ci.code, f.book().lanes.ci.waiting, f.holds], ['RENEW_RESPONSE_UNAVAILABLE', true, 0]);
    assert.equal(requestFiles(f).length, 1, '放弃后尚未投新请求');
    assert.equal((await renewalStatus(f.root, f.now)).connections.ci.code, 'RENEW_RESPONSE_UNAVAILABLE', '放弃后对外显示不可用而非等回包');
    f.now += 20 * 60_000; await f.tick();
    const effectiveAt = new Date(f.now + effectiveIn).toISOString();
    answer(f, old, 'ci', {outcome: 'yielded', effectiveAt});
    f.now += 15_000; await f.tick();
    assert.equal(f.holds, 1, '放弃后、换号前读到的旧号让班照常采纳' + effectiveIn);
    assert.deepEqual([f.book().lanes.ci.code, f.book().lanes.ci.effectiveAt, f.book().pending], ['RENEW_HANDOVER_WAITING', effectiveAt, null]);
  }
  const f = handoverFixture(t);
  seedBook(f, upgradeFresh(f)); f.restart();
  await f.tick(); const old = f.request('ci');
  f.now += HOUR; await f.tick();
  f.now += HOUR; await f.tick(); const fresh = f.request('ci');
  assert.notEqual(fresh, old);
  answer(f, old, 'ci', {outcome: 'yielded', effectiveAt: new Date(f.now + 300_000).toISOString()});
  f.now += 15_000; await f.tick();
  assert.deepEqual([f.holds, f.book().pending?.id], [0, fresh], '换号后旧号回包不采纳');
});

// Codex 复审 076827ffe（中1）：准备投递与已成功投出分开。新请求号先记为“准备”，旧号（在途或已放弃）留到新请求文件确实建成才被替换；
// 建文件失败或两步之间退出，按未投出处理：不阻塞投递，仍认旧号；请求文件已建成的，重启后接上，不丢号。
const abandonCi = async f => { // 升级通道一天内不到期；ci 请求满一小时无回包而放弃
  seedBook(f, {upgrade: {...refusedLane(f.now - HOUR, {source: CI_SOURCE}), code: null}}); f.restart();
  await f.tick(); const old = f.request('ci');
  f.now += HOUR; await f.tick();
  assert.equal(f.book().lanes.ci.code, 'RENEW_RESPONSE_UNAVAILABLE');
  return old;
};
test('建新请求文件失败：按未投出处理，旧号仍可采纳，也不挡下一次投递', async t => {
  for (const variant of ['old-reply', 'repost']) {
    const f = handoverFixture(t);
    const old = await abandonCi(f);
    const box = path.join(f.root, 'broker/requests'), aside = box + '-aside';
    fs.renameSync(box, aside); fs.writeFileSync(box, ''); // 请求邮箱暂时建不了文件
    f.now += HOUR;
    await assert.rejects(f.tick());
    fs.rmSync(box); fs.renameSync(aside, box);
    assert.equal(requestFiles(f).length, 1, '新请求没有投出');
    if (variant === 'old-reply') {
      answer(f, old, 'ci', {outcome: 'yielded', effectiveAt: new Date(f.now + 300_000).toISOString()});
      f.now += 15_000; await f.tick();
      assert.equal(f.holds, 1, '旧号的让班回包照常采纳');
    } else {
      f.now += 15_000; await f.tick();
      const fresh = f.request('ci');
      assert.notEqual(fresh, old);
      assert.equal(requestFiles(f).length, 2, '未投出的请求不挡下一次投递');
    }
  }
});
test('准备好新请求号后、建文件前后退出：未建成按未投出（仍认旧号），已建成则接上新号不丢', async t => {
  const prepared = '10000000-0000-4000-8000-00000000000b';
  for (const built of [false, true]) {
    const f = handoverFixture(t);
    const old = await abandonCi(f);
    f.now += HOUR;
    const book = f.book(); book.next = {id: prepared, kind: 'ci', at: f.now, confirming: false, source: CI_SOURCE};
    fs.writeFileSync(path.join(f.root, 'state/connection-renewal.json'), JSON.stringify(book));
    if (built) fs.writeFileSync(path.join(f.root, 'broker/requests', prepared + '.json'), JSON.stringify({kind: 'ci'}));
    f.startedAt = f.now; f.restart(); // 退出后重启（启动宽限内）
    answer(f, built ? prepared : old, 'ci', {outcome: 'yielded', effectiveAt: new Date(f.now + 300_000).toISOString()});
    await f.tick();
    assert.equal(f.holds, 1, built ? '已建成的新请求接上，其回包采纳' : '未建成的不算投出，旧号回包采纳');
    assert.equal(f.book().next ?? null, null);
  }
});
// 复审低2：业务字段不合格、由常驻自己判成“回包不可用”的，也归当前代，按每小时复核。
test('A 代投出升级请求、B 代读到待批字段不全的回包：记回包不可用归当前代，不当轮重投', async t => {
  const f = handoverFixture(t);
  await f.tick(); f.reply('ci', {}); await f.tick();
  const id = f.request('upgrade'), at = f.now;
  f.now = at + 10 * 60_000; f.source = OTHER_SOURCE; f.startedAt = f.now; f.restart(); await f.tick();
  f.now = at + 20 * 60_000;
  answer(f, id, 'upgrade', {code: 'RENEW_PENDING_APPROVAL'});
  await f.tick();
  assert.deepEqual([f.book().lanes.upgrade.code, f.book().lanes.upgrade.source], ['RENEW_RESPONSE_UNAVAILABLE', OTHER_SOURCE]);
  f.request(null);
  f.now += HOUR - 1; await f.tick(); f.request(null);
  f.now += 1; await f.tick(); assert.notEqual(f.request('upgrade'), id);
});
// 复审低3：放弃前的第二次读要真的生效——同一轮第一次读空、第二次读到，采纳。
test('一小时到点那一轮：第一次读空、放弃前再读读到回包——采纳，不进入回包不可用', async t => {
  const f = handoverFixture(t);
  await f.tick(); const id = f.request('ci');
  const at = f.now;
  let reads = 0;
  f.readResponse = async file => { // 到点那一轮的第二次读之前，回包还没出现
    if (f.now < at + HOUR || ++reads < 2) return null;
    answer(f, id, 'ci', {outcome: 'yielded', effectiveAt: new Date(f.now + 300_000).toISOString()});
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  f.restart();
  f.now = at + HOUR - 15_000; await f.tick();
  f.now = at + HOUR; await f.tick();
  assert.deepEqual([reads, f.holds, f.book().lanes.ci.code], [2, 1, 'RENEW_HANDOVER_WAITING']);
});

// Codex 第四轮（中1）：以完整正文为准。请求文件已建但正文为空或只写了一半（写失败、或写到一半退出）＝未投出：
// 旧号照旧可采纳；残件不再复用，下次投递用新号。正文只能是 {"kind":...}（Broker 的 MatchKind 只认这一种），请求号就是文件名。
test('请求文件已建、正文为空或写了一半：按未投出处理，旧号回包照常采纳；同进程写失败与退出后重启两种', async t => {
  const box = f => path.join(f.root, 'broker', 'requests');
  const realWrite = fs.promises.writeFile;
  t.after(() => { fs.promises.writeFile = realWrite; });
  for (const torn of ['', '{"kind":"c']) for (const restart of [false, true]) {
    const f = handoverFixture(t);
    const old = await abandonCi(f);
    f.now += HOUR;
    let tornId = null;
    if (!restart) { // 同进程：建出文件、写了 torn 后写失败
      fs.promises.writeFile = async (file, data, options) => {
        if (path.dirname(String(file)) !== box(f)) return realWrite(file, data, options);
        tornId = path.basename(String(file), '.json');
        await realWrite(file, torn, {flag: 'wx'});
        throw Object.assign(new Error('torn write'), {code: 'EIO'});
      };
      await assert.rejects(f.tick());
      fs.promises.writeFile = realWrite;
    } else { // 准备好新号、建出文件写了一半时退出，然后重启
      tornId = '10000000-0000-4000-8000-00000000000c';
      const book = f.book(); book.next = {id: tornId, kind: 'ci', at: f.now, confirming: false, source: CI_SOURCE};
      fs.writeFileSync(path.join(f.root, 'state/connection-renewal.json'), JSON.stringify(book));
      fs.writeFileSync(path.join(box(f), tornId + '.json'), torn);
      f.startedAt = f.now - CHECK; f.restart();
    }
    const label = JSON.stringify({torn, restart});
    answer(f, old, 'ci', {outcome: 'yielded', effectiveAt: new Date(f.now + 300_000).toISOString()});
    f.now += 15_000; await f.tick();
    assert.equal(f.holds, 1, '旧号回包照常采纳 ' + label);
    assert.deepEqual([f.book().next ?? null, f.book().pending], [null, null], label);
    assert.ok(requestFiles(f).includes(tornId + '.json'), label);
  }
});
test('残件不再复用：正文写坏的那次之后，下一次投递换新号、正文完整', async t => {
  const realWrite = fs.promises.writeFile;
  t.after(() => { fs.promises.writeFile = realWrite; });
  const f = handoverFixture(t);
  const old = await abandonCi(f);
  f.now += HOUR;
  let tornId = null;
  fs.promises.writeFile = async (file, data, options) => {
    if (path.dirname(String(file)) !== path.join(f.root, 'broker', 'requests')) return realWrite(file, data, options);
    tornId = path.basename(String(file), '.json');
    await realWrite(file, '', {flag: 'wx'});
    throw Object.assign(new Error('torn write'), {code: 'EIO'});
  };
  await assert.rejects(f.tick());
  fs.promises.writeFile = realWrite;
  f.now += 15_000; await f.tick();
  const fresh = f.request('ci'); // f.request 同时核对新请求文件正文为 {kind:'ci'}
  assert.ok(![old, tornId].includes(fresh));
});
