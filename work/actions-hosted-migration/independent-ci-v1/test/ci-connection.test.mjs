import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { canonical, digest } from '../src/proof.mjs';
import { probeRole } from '../src/resident-v2/role-probe-entry.mjs';
import { controllerPrincipal } from '../src/resident-v2/entry-runtime.mjs';
import { assertProtectedPaths, readProtected } from '../runtime/protected-files.mjs';
import { fixtureRecord } from './resident-v2-fixtures.mjs';
import { nodeIdentityOf, nodeIdentitySha256 } from '../../../independent-ci-resident-v1/src/node-identity.mjs';

const pin = token => digest('clued.independent-ci.ci-binding-pin/1\0' + token);
const oldToken = 'clued_bnd_fixture_previous';
const newToken = 'clued_bnd_fixture_rebound';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyBytes = privateKey.export({ type: 'pkcs8', format: 'pem' });
const keyPin = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
const { files } = fixtureRecord({ ciTokenPinSha256: pin(oldToken), appPublicKeySha256Base64: keyPin });
const record = { config: JSON.parse(files['installation.json']), accepted: JSON.parse(files['acceptance.json']),
  hashes: { acceptanceSha256: digest(files['acceptance.json']) } };
const connection = { contract: 'clued.independent-ci.ci-connection/1',
  baseNodeIdentitySha256: nodeIdentitySha256(nodeIdentityOf(record.config, record.accepted, record.hashes.acceptanceSha256)),
  bindingId: '97422e7a-250d-46a1-8205-efe28713d117', bindingGeneration: 2,
  rebindReceiptId: '07c17825-c99c-45c8-a6d0-24f8d62708dc', tokenPinSha256: pin(newToken),
  previousSha256: null, activatedAt: '2026-11-18T01:02:03.000Z' };

async function disk(t, connectionText, token) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-connection-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secrets = path.join(root, 'secrets');
  await fs.mkdir(secrets);
  const keyFile = path.join(root, 'fixture.pem');
  await fs.writeFile(keyFile, keyBytes);
  await fs.writeFile(path.join(secrets, 'ci-admission.token'), token);
  if (connectionText !== null) await fs.writeFile(path.join(secrets, 'ci-admission.connection.json'), connectionText);
  const reads = [];
  const tokenReader = async file => {
    // A pre-change reader still sees the fixture, never an installed secret.
    const leaf = path.basename(file);
    reads.push(leaf);
    return fs.readFile(leaf === 'fixture.pem' ? keyFile : path.join(secrets, leaf), 'utf8');
  };
  const protect = async (_root, _paths, _state, optionalFile) => {
    if (!optionalFile) return;
    const stat = await fs.lstat(optionalFile, { throwIfNoEntry: false }).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (stat && !stat.isFile()) throw Error('fixture_boundary');
    return Boolean(stat);
  };
  return { root, tokenFile: path.join(secrets, 'ci-admission.token'), keyFile, reads, tokenReader, protect };
}

test('换绑后真实角色探测只读取一份记录和一个令牌，向只读接口使用新令牌', async t => {
  const io = await disk(t, canonical(connection), newToken);
  let calls = 0;
  const result = await probeRole({ record, ...io, live() {}, fetchImpl: async (url, opts) => {
    calls++;
    assert.ok(url.endsWith('/rpc/clued_work_merge_slot_holders_v1'));
    assert.equal(JSON.parse(opts.body).p_token_hash, digest(newToken));
    return Response.json({ status: 'ok', holders: [], reason: 'admission_binding_required' });
  } });
  assert.equal(result.reason, 'ROLE_PROBE_NOT_HELD');
  assert.equal(calls, 1);
  assert.deepEqual(io.reads.sort(), ['ci-admission.connection.json', 'ci-admission.token']);
});

test('控制、签发和发布共用的凭据读取器接受新代次，对中途旧令牌拒绝', async t => {
  const io = await disk(t, canonical(connection), newToken);
  // 凭据读取和路径检查均经夹具，入口本身负责比较应用公钥和 CI 指纹。
  const actual = await controllerPrincipal(record, io);
  assert.equal(actual.bindingId, connection.bindingId);
  assert.equal(actual.nativeToken, newToken);
  assert.deepEqual(io.reads.sort(), ['ci-admission.connection.json', 'ci-admission.token', 'fixture.pem']);
  await fs.writeFile(path.join(io.root, 'secrets', 'ci-admission.token'), oldToken);
  await assert.rejects(controllerPrincipal(record, io), { code: 'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED' });
  await assert.rejects(probeRole({ record, ...io, live() {}, fetchImpl: assert.fail }), { code: 'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED' });
});

test('坏记录和不可确认的记录必须拒绝，即使盘上的旧令牌仍匹配安装记录', async t => {
  const io = await disk(t, ' {}', oldToken);
  const invoke = () => probeRole({ record, ...io, live() {}, fetchImpl: assert.fail });
  await assert.rejects(invoke(), { code: 'CI_CONNECTION_RECORD_REFUSED' });
  const target = path.join(io.root, 'secrets', 'ci-admission.connection.json');
  await fs.unlink(target);
  await fs.mkdir(target);
  await assert.rejects(invoke(), { code: 'CI_CONNECTION_RECORD_REFUSED' });
});

test('缺少记录时角色入口只读安装时的令牌一次', async t => {
  const io = await disk(t, null, oldToken);
  const result = await probeRole({ record, ...io, live() {}, fetchImpl: async (_url, opts) => {
    assert.equal(JSON.parse(opts.body).p_token_hash, digest(oldToken));
    return Response.json({ status: 'ok', holders: [], reason: 'admission_binding_required' });
  } });
  assert.equal(result.reason, 'ROLE_PROBE_NOT_HELD');
  assert.deepEqual(io.reads, ['ci-admission.token']);
});

test('Windows 拒读记录和目录联接均在使用令牌之前停止', { skip: process.platform !== 'win32' }, async t => {
  const io = await disk(t, canonical(connection), oldToken);
  const file = path.join(io.root, 'secrets', 'ci-admission.connection.json');
  const invoke = () => probeRole({ record, ...io, live() {}, fetchImpl: assert.fail });
  const system32 = path.join(process.env.SystemRoot, 'System32');
  const account = execFileSync(path.join(system32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
  const sid = '*' + account.match(/S-1-(?:\d+-)+\d+/)[0];
  const aclTool = path.join(system32, 'icacls.exe');
  execFileSync(aclTool, [file, '/deny', sid + ':(RD)']);
  try {
    await assert.rejects(fs.readFile(file), error => ['EACCES', 'EPERM'].includes(error.code));
    await assert.rejects(invoke(), { code: 'CI_CONNECTION_RECORD_REFUSED' });
    assert.deepEqual(io.reads, ['ci-admission.connection.json']);
  } finally { execFileSync(aclTool, [file, '/remove:d', sid]); }
  await fs.unlink(file);
  const target = path.join(io.root, 'fixture-target');
  await fs.mkdir(target);
  await fs.symlink(target, file, 'junction');
  try {
    await assert.rejects(assertProtectedPaths(io.root, [file]), { code: 'installation_link_refused' });
    io.protect = async (_root, _paths, _state, optional) => {
      if (optional) await assertProtectedPaths(io.root, [optional]);
    };
    await assert.rejects(invoke(), { code: 'CI_CONNECTION_RECORD_REFUSED' });
    assert.deepEqual(io.reads, ['ci-admission.connection.json']);
  } finally { await fs.unlink(file); }
});

const entries = {
  'control-checks': '../src/independent-control-checks-v2/startup.mjs',
  'scanner-issuer': '../worker/protected-job-bridge-v4/windows-issuer.mjs',
  'check-publisher': '../runtime/one-shot-v2.mjs',
};
for (const [role, rel] of Object.entries(entries)) test(role + ' 的正式入口只将同一代次交给准入端口', async t => {
  const io = await disk(t, canonical(connection), newToken);
  const entry = new URL(rel, import.meta.url);
  entry.searchParams.set('fixture', role);
  const stop = new Error('fixture_ports_observed');
  let calls = 0;
  const ctx = { inputs: { record, jobs: [{ id: 'fixture' }] }, held: { policyText: '{}' }, live() {}, sourceRoot: io.root };
  // 只替换入口的宿主依赖。在创建端口时结束，不创建效果日志、邮箱或外部请求。
  globalThis.ciConnectionEntryFixture = {
    runEntry: opts => opts.body(ctx),
    controllerPrincipal: r => controllerPrincipal(r, io),
    observationLog() {},
    controllerPorts(opts) {
      calls++;
      assert.equal(opts.bindingId, connection.bindingId);
      assert.equal(opts.nativeToken, newToken);
      throw stop;
    },
  };
  const exportsFor = new Map([
    ['entry-runtime.mjs', 'export const {runEntry, controllerPrincipal, observationLog, controllerPorts} = globalThis.ciConnectionEntryFixture;'],
    ['batch-claim-v2.mjs', 'export async function readBatchClaim() { return {}; }'],
    ['boundary.mjs', 'export const createWindowsContext = ({inputs}) => ({job: inputs.jobs[0]});'],
  ]);
  const hook = registerHooks({ resolve(spec, context, next) {
    const url = next(spec, context);
    const replacement = context.parentURL === entry.href && exportsFor.get(spec.split('/').pop());
    if (!replacement) return url;
    const program = 'export * from ' + JSON.stringify(url.url) + ';' + replacement + '\n// ' + role;
    return { url: 'data:text/javascript,' + encodeURIComponent(program), shortCircuit: true };
  } });
  try {
    const { main } = await import(entry.href);
    await assert.rejects(main([]), error => error === stop);
    assert.equal(calls, 1);
    assert.deepEqual(io.reads.sort(), ['ci-admission.connection.json', 'ci-admission.token', 'fixture.pem']);
    await fs.writeFile(path.join(io.root, 'secrets', 'ci-admission.token'), oldToken);
    await assert.rejects(main([]), { code: 'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED' });
    assert.equal(calls, 1);
  } finally { hook.deregister(); delete globalThis.ciConnectionEntryFixture; }
});

test('旧版控制消费者用轮换后的令牌拒绝，零外部效果', { skip: process.platform !== 'win32' }, async t => {
  const io=await disk(t,canonical(connection),newToken);
  const entry=new URL('../src/independent-control-checks-v1/publisher.mjs?v1-fixture',import.meta.url);
  const selector={repository:'tdoljyj/cross-memory-system',pr:2,headSha:'b'.repeat(40),baseSha:'c'.repeat(40),name:'kooyumi-admission-verified'};
  const roles=['control-admission','control-merge-slot'];
  const checks=Object.fromEntries(Object.entries({'gitleaks':'gitleaks','trivy':'trivy','work-admission':'kooyumi-work-admission',
    'contract-placement':'contract-placement','control-admission':selector.name,'control-merge-slot':'kooyumi-merge-slot'})
    .map(([role,name])=>[role,{name,appId:5368905}]));
  const manifest=JSON.stringify({repo:selector.repository,roles:Object.fromEntries(roles.map(r=>[r,{}]))});
  const accepted={ciTokenPinSha256:pin(oldToken),expiresAt:'2027-01-01',appPublicKeySha256Base64:keyPin};
  const config={checks,sourceManifestSha256:digest(manifest),acceptanceSha256:digest(JSON.stringify(accepted)),evaluatorSha256:'e',policySha256:'p'};
  const pins=new Map([['scripts/ci/clued-work-admission.mjs','e'],['config/merge-admission-policy.json','p']]);
  const jobs=roles.map(role=>({role,attempt:1,sourceManifestSha256:config.sourceManifestSha256,repo:selector.repository}));
  const docs={'installation.json':JSON.stringify(config),'acceptance.json':JSON.stringify(accepted),'source-manifest.json':manifest};
  let effects=0, reader=io.tokenReader;
  globalThis.ciV1Fixture={pins,lease:{data:{documents:Object.fromEntries(Object.entries(docs).map(([k,v])=>[k,Buffer.from(v)])),
    expiresAt:accepted.expiresAt,sourceHashes:pins},close(){}}, read:async (file,options)=>file.endsWith('jobs.json')?JSON.stringify(jobs):reader(file,options),
    effect:()=>{effects++;throw Error('unexpected effect')}};
  const mocks=new Map([
    ['held-source.mjs','export const openHeldSource=async()=>f.lease,takeHeldSource=x=>x;'],
    ['boundary.mjs','export const validateFormalAcceptance=()=>{},validateSourcePins=()=>f.pins;'],
    ['mailbox.mjs','export const WINDOWS_ROOT="fixture",validateRelayDescriptor=()=>{};'],
    ['protected-files.mjs','export const INSTALL_ROOT="fixture",APP_KEY_FILE="fixture.pem",assertProtectedPaths=()=>{},readProtected=f.read;'],
    ['queue.mjs','export const validateJob=()=>{};'],
    ['node:child_process','export const execFile=(...args)=>args.at(-1)(null,"","");'],
    ['github.mjs','export const createGitHubChecksPort=f.effect;'],
    ['effect-journal.mjs','export const EffectJournal={open:f.effect};']
  ]);
  const hook=registerHooks({resolve(spec,context,next) {
    const source=context.parentURL===entry.href && mocks.get(spec.split('/').pop());
    return source ? {url:'data:text/javascript,'+encodeURIComponent('const f=globalThis.ciV1Fixture;'+source),shortCircuit:true} : next(spec,context);
  }});
  try {
    const {consumeInstalledControlCheck}=await import(entry.href);
    const r=await consumeInstalledControlCheck(selector);
    assert.equal(r.reason,'ACTUAL_NATIVE_CHECK_PRINCIPAL_CHANGED');
    assert.equal(r.sideEffects,0); assert.equal(effects,0);
    assert.deepEqual(io.reads,['fixture.pem','ci-admission.token']);
    reader=(_file,options)=>readProtected(io.keyFile,{...options,secretRoot:io.root});
    const guarded=await consumeInstalledControlCheck(selector);
    assert.equal(guarded.reason,'secret_file_boundary_unconfirmed');
    assert.equal(guarded.sideEffects,0); assert.equal(effects,0);
  } finally { hook.deregister();delete globalThis.ciV1Fixture; }
});

for (const version of [2,3]) test('旧版 bridge v'+version+' 在 Windows 密钥边界及安装指纹处分别拒绝', {skip:process.platform!=='win32'},async t=>{
  const io=await disk(t,canonical(connection),newToken);
  const entry=new URL('../worker/protected-job-bridge-v'+version+'/windows-issuer.mjs?rotation',import.meta.url);
  let effects=0;
  const f={root:io.root,key:io.keyFile,read:readProtected,
    context:{config:record.config,accepted:record.accepted},effect:()=>{effects++;throw Error('unexpected effect')}};
  globalThis.ciLegacyIssuer=f;
  const mocks=new Map([
    ['boundary.mjs','export const loadWindowsContext=async()=>f.context,takeAcceptedBridgeContext=x=>x,assertWindowsContextLive=()=>{},closeWindowsContext=()=>{};'],
    ['mailbox.mjs','export const openAcceptedMailbox=async()=>({lock:async()=>{},write:f.effect}),takeActualMailbox=x=>x;'],
    ['protected-files.mjs','export const INSTALL_ROOT=f.root,APP_KEY_FILE=f.key,assertProtectedPaths=()=>{},readProtected=(...args)=>f.read(...args);'],
    ['github.mjs','export const createGitHubChecksPort=f.effect;'],
  ]);
  const hook=registerHooks({resolve(spec,ctx,next){
    const src=ctx.parentURL===entry.href && mocks.get(spec.split('/').pop());
    return src?{url:'data:text/javascript,'+encodeURIComponent('const f=globalThis.ciLegacyIssuer;'+src+'\n// bridge '+version),shortCircuit:true}:next(spec,ctx);
  }});
  try {
    const {openWindowsJobIssuer}=await import(entry.href);
    for (const [reader,reason] of [[readProtected,'secret_file_boundary_unconfirmed'],[io.tokenReader,'ACTUAL_ISSUER_PRINCIPAL_CHANGED']]) {
      f.read=reader;
      const r=await openWindowsJobIssuer({});
      assert.equal(r.reason,reason);
      assert.equal(r.jobIssued,false); assert.equal(r.checksWritten,false); assert.equal(effects,0);
    }
  } finally {hook.deregister();delete globalThis.ciLegacyIssuer;}
});
