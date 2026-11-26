import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { readBounded } from './store.mjs';
import { HEX64 } from './canonical.mjs';

const run = promisify(execFile);
const DAY = 86_400_000;
const HOUR = DAY / 24;
const CHECK_INTERVAL = 10 * 60_000;
const KINDS = ['ci', 'upgrade'];
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
// Refusal codes pass through in the gateway's one shape (review N1): no list of the server's codes here to drift from it.
const CODE = /^[A-Z_]{3,80}$/;
// One cadence for both connections (D2c ruling B2): daily; hourly while waiting on a handover or after an unconfirmed outcome
// or no candidate; RENEW_BUSY after two minutes; a pending approval after the server's interval.
const HOURLY = ['RENEW_GATEWAY_UNAVAILABLE', 'RENEW_RESPONSE_UNAVAILABLE', 'RENEW_INTERRUPTED', 'RENEW_UNAVAILABLE', 'RENEW_HANDOVER_NO_CANDIDATE'];
// Task a75da4bd（Fable 11-20“补：让班回包迟到”(2)）：回包什么时候到都是对该请求号的权威答复。等过 REPLY_OVERDUE 只改对外显示
// （RENEW_RESPONSE_WAITING），请求号留在状态里每轮照看；满 REPLY_LIMIT 仍无回包（Broker 没了、文件永远不来）才按回包不可用。
// 采纳与否不看时间（Fable 11-20“一小时截止的语义”）：状态里记着的还是这个请求号，任何一轮读到它的回包都采纳；REPLY_LIMIT 只决定
// 何时不再等，放弃前再读一次，读不到才放弃（记回包不可用、每小时复核）。放弃后旧号仍留在状态里，直到投出新请求换成新号，期间读到
// 它的回包照常采纳；换号后旧号的回包不再采纳。判据只用常驻自己的时钟。
// 等待码不是失败，状态不发失败通知（独审 4a83b3e08 低1）。
const REPLY_OVERDUE = 120_000, REPLY_LIMIT = HOUR;
export const RESPONSE_WAITING = 'RENEW_RESPONSE_WAITING';
const retrySeconds = value => Number.isInteger(value) && value > 0 && value <= 2_147_483_647;
// 缺陷 c7ea4ea1（Fable 11-20“补：续期不等”B）：每条通道记录带写入它的那一代的 Source 摘要（source）。别的代写下的拒绝
// （标识不同，或旧格式记录没有标识）不计退避，本代即可再投——升级往往正是为修这个拒绝。其余字段原样使用：让班等待中的仍按等待节奏，
// 生效时间、绑定、到期跨代不变，续上的连接仍按日。
const retryAfter = (last, source) => last.source !== source && typeof last.code === 'string' && !last.waiting ? 0
  : last.code === 'RENEW_PENDING_APPROVAL' && retrySeconds(last.retryAfterSeconds) ? last.retryAfterSeconds * 1000
  : last.waiting || HOURLY.includes(last.code) ? HOUR : last.code === 'RENEW_BUSY' ? 120_000 : DAY;
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const serviceHash = createHash('sha1').update(Buffer.from('CLUEDCIRESIDENT', 'utf16le')).digest();
const residentSid = 'S-1-5-80-' + Array.from({length:5}, (_,i)=>serviceHash.readUInt32LE(4*i)).join('-');

export async function writeObservation(file, value) {
  const tmp = file + '.' + randomUUID();
  try {
    await fs.writeFile(tmp, JSON.stringify(value), {flag:'wx'});
    await fs.rename(tmp,file);
  } finally { await fs.rm(tmp,{force:true}); }
}
async function read(file) {
  try { return JSON.parse(await readBounded(file, 4096, 'RENEW_STATUS_UNAVAILABLE')); }
  catch { return null; }
}
export async function observeOwnKey(root, companion = false) {
  const { stdout } = await run(path.join(root,'bin','SwapBroker.exe'), [companion ? '--renew-companion-check' : '--renew-key-check'],
    {windowsHide:true,timeout:10000,maxBuffer:4096});
  return JSON.parse(stdout);
}
export function keyCheck(system, resident, controller, companion, profile, now, mode) {
  const fresh = (v, maxAge = 3*CHECK_INTERVAL) => typeof v?.at === 'string' && Date.parse(v.at) <= now && now-Date.parse(v.at) <= maxAge;
  const knownProvider = ['Microsoft Platform Crypto Provider','Microsoft Software Key Storage Provider'].includes(system?.provider);
  const cannotOpen = (v,sid,maxAge) => fresh(v,maxAge) && v.sid===sid && knownProvider
    && [v.tpm,v.software].every(value => value==='DENIED' || value==='ABSENT');
  const checks = {system:fresh(system) && system.sid==='S-1-5-18' && system.code===null && knownProvider,
    resident:cannotOpen(resident,residentSid), controller:cannotOpen(controller,profile.controllerSid,mode==='ACTIVE' ? Infinity : undefined), companion:cannotOpen(companion,profile.ownerSid),
    companionToken:['DENIED','ABSENT'].includes(companion?.['ci-admission.token']), companionRecord:['DENIED','ABSENT'].includes(companion?.['ci-admission.connection.json'])};
  return {result:Object.values(checks).every(Boolean)?'PASS':'FAIL',...checks};
}

export function companionKeyWatch(root, clock = Date.now) {
  let next = 0;
  return async () => {
    if (clock()<next) return;
    next=clock()+CHECK_INTERVAL;
    try { await writeObservation(path.join(root,'mailbox','responses','renew-key.json'), await observeOwnKey(root,true)); }
    catch { /* A missing or stale observation fails the resident check. */ }
  };
}

// One in-flight request. The resident can only create a new UUID file in this mailbox.
// Persist the UUID first so that restarting either service never loses track of an answer.
// source: this generation's Source digest (policy.ciSourceManifestSha256), the one the fleet upgrade names each generation by.
// uptime: how long this process has run, on a monotonic clock (the tests inject it). readResponse: reads one Broker answer (tests inject it).
export function renewalWatch({root, profile, mode, drained, onHandover, source, clock=Date.now, uptime=()=>performance.now(),
  observe=()=>observeOwnKey(root), readResponse=read}) {
  if (!HEX64.test(source ?? '')) throw new Error('RENEW_SOURCE_REQUIRED');
  const stateFile=path.join(root,'state','connection-renewal.json');
  let nextCheck=0, book=null;
  const save=()=>writeObservation(stateFile,book);
  const requestFile=id=>path.join(root,'broker','requests',id+'.json');
  const requestBody=kind=>JSON.stringify({kind}); // Broker 的 MatchKind 只认 {"kind":...} 这一种正文；请求号就是文件名
  // Codex 复审 076827ffe 中1、第四轮中1：准备投递与已成功投出分开。新请求号先记为 book.next 落盘，旧号（在途或已放弃）留在
  // book.pending；读回请求文件、正文与该号应有的正文逐字相同才算投出并换号。文件不存在、为空或只写了一半都按未投出：丢弃准备记录，
  // 旧号照旧可采纳，残件不再复用（常驻对已有请求文件只读，改不了也删不掉），下次投递另取新号。读不清（其他错误）留到下一轮再判，
  // 期间不投新请求。不采用“写完再原子出现”：请求邮箱的 ACL 只许新建、不许改名，从别处移入会带进常驻可写的 ACL，破坏“交出后不可改”。
  const settleNext = async () => {
    if (!book.next) return;
    let body;
    try { body=await fs.readFile(requestFile(book.next.id),'utf8'); }
    catch (e) { if (e?.code!=='ENOENT' && e?.code!=='ENOTDIR') return; body=null; }
    if (body===requestBody(book.next.kind)) book.pending=book.next;
    book.next=null; await save();
  };
  const post = async (kind, at, confirmationId) => {
    const id = confirmationId ?? randomUUID();
    // 在途请求记下投出它的那一代（中2）：结清时通道记录归这一代，换代后读到的旧代拒绝不计本代退避。
    book.next = {id, kind, at, confirming: confirmationId !== undefined, source};
    await save();
    try { await fs.writeFile(requestFile(id), requestBody(kind), {flag:'wx'}); }
    finally { await settleNext(); }
  };
  return async () => {
    const now=clock();
    book ??= await read(stateFile) ?? { lanes:{}, pending:null };
    if (now>=nextCheck) {
      const controller=path.join(path.dirname(root),'state','v2','receipts','renew-key-controller.json');
      const [system,r,c,h]=await Promise.all([read(path.join(root,'broker','renew-key.json')),observe().catch(()=>null),
        read(controller),read(path.join(root,'mailbox','responses','renew-key.json'))]);
      if(r) await writeObservation(path.join(root,'state','renew-key-resident.json'),r);
      const checkedAt=clock();
      const keys={...keyCheck(system,r,c,h,profile,checkedAt,mode()),systemFailure:system?.failure??null};
      // 启动宽限内（陪伴观测可能还没写出）的 FAIL 不落账、不推后下次检查，下一拍再查；PASS 立即落账，满一个周期后照旧。
      if (keys.result==='FAIL' && uptime()<CHECK_INTERVAL) nextCheck=0;
      else {
        nextCheck=now+CHECK_INTERVAL;
        book.keys=keys; book.checkedAt=new Date(checkedAt).toISOString(); await save();
      }
    }
    await settleNext(); // 上一轮准备了却没判清的新请求（含两步之间退出）
    if (book.next) return;
    let reply=null;
    if (book.pending) {
      const {id,kind,at,abandoned}=book.pending;
      if (!UUID.test(id) || !KINDS.includes(kind)) throw new Error('RENEW_STATE_REFUSED');
      // 只认状态里记着的这个请求号；没有结论前不为任何通道投新请求（Broker 那边本来也只处理一条）。重启后从状态恢复同一请求号。
      const readReply=async()=>{ const r=await readResponse(path.join(root,'broker','responses',id+'.json')); return r?.requestId===id ? r : null; };
      reply=await readReply();
      if (!reply && !abandoned) {
        if (now-at<REPLY_LIMIT) return;
        reply=await readReply(); // 放弃之前再读一次：读到就采纳，读不到才按回包不可用
      }
    }
    // 已放弃的请求号（abandoned）留在状态里，直到投出新请求换成新号（裁定规则 3）：期间不挡投递，每轮照看，读到它的回包照常采纳。
    if (book.pending && (reply || !book.pending.abandoned)) {
      const {id,kind,confirming}=book.pending;
      // 旧格式在途记录没有 Source：按别的代处理（不计本代退避）。
      const owner=typeof book.pending.source==='string' ? book.pending.source : null;
      const valid=reply?.requestId===id && reply.kind===kind && reply.contract==='clued.independent-ci.connection-renew-response/1';
      const bound = valid && reply.code === null && UUID.test(reply.bindingId) && Number.isFinite(Date.parse(reply.expiresAt));
      const yielded = bound && kind === 'ci' && reply.outcome === 'yielded' && Number.isFinite(Date.parse(reply.effectiveAt));
      const confirmation = bound && kind === 'ci' && reply.outcome === 'confirm-standby'
        && UUID.test(reply.confirmationId) && reply.confirmationId !== id;
      const done = bound && reply.outcome == null;
      const prior = book.lanes[kind];
      const pendingApproval = valid && reply.code==='RENEW_PENDING_APPROVAL' && UUID.test(reply.grantRequestId)
        && retrySeconds(reply.retryAfterSeconds);
      const refused = valid && CODE.test(reply.code) && (reply.code!=='RENEW_PENDING_APPROVAL' || pendingApproval)
        ? reply.code : 'RENEW_RESPONSE_UNAVAILABLE';
      // 回包丢失时，服务端可能已提交让班。每小时复核，收到确切让班回执才收回接单资格。
      const uncertain = ['RENEW_RESPONSE_UNAVAILABLE', 'RENEW_GATEWAY_UNAVAILABLE', 'RENEW_INTERRUPTED'].includes(refused);
      const waitForDrain = prior?.waiting === true && ['CI_REBIND_NOT_DRAINED','RENEW_BUSY'].includes(refused);
      const waiting = yielded || confirmation || (kind === 'ci' && !done && (uncertain || waitForDrain));
      // 服务端回包里的结论归投出请求的那一代；常驻自己判下的“回包不可用”（无回包、信封或业务字段不合格）归当前代，照常每小时复核。
      const answered = yielded || confirmation || done || (valid && refused === reply.code);
      if (yielded) await onHandover();
      book.lanes[kind] = {
        at: now, source: answered ? owner : source, waiting, effectiveAt: yielded ? reply.effectiveAt : waiting ? prior?.effectiveAt ?? null : null,
        code: yielded ? 'RENEW_HANDOVER_WAITING' : confirmation ? 'CI_REBIND_NOT_DRAINED' : done ? null : refused,
        bindingId: bound ? reply.bindingId : prior?.bindingId ?? null,
        expiresAt: bound ? reply.expiresAt : prior?.expiresAt ?? null,
        renewalWindowOpensAt: bound ? (validTime(reply.renewalWindowOpensAt) ? reply.renewalWindowOpensAt : null) : prior?.renewalWindowOpensAt ?? null,
        grantRequestId: pendingApproval ? reply.grantRequestId : null,
        retryAfterSeconds: pendingApproval ? reply.retryAfterSeconds : null,
      };
      book.pending = reply ? null : {...book.pending, abandoned: true};
      const canConfirm = () => {
        const role=mode();
        return role==='STANDBY' || (role==='UNCERTAIN' && (!prior?.effectiveAt || Date.parse(reply.expiresAt)<=now));
      };
      if (confirmation && !confirming && canConfirm() && await drained() && canConfirm()) {
        await post(kind, now, reply.confirmationId);
        return;
      }
      await save();
    }
    for (const kind of KINDS) {
      const last=book.lanes[kind];
      if (last && now-last.at < retryAfter(last, source)) continue;
      if (last?.waiting && now < Date.parse(last.effectiveAt)) continue;
      // During an acknowledged handover, await the role probe while the old connection is usable. After expiry
      // the server alone can confirm duty through the signed lane, once this node has drained.
      if (kind === 'ci' && last?.waiting && mode() === 'UNCERTAIN'
          && ((last.effectiveAt && Date.parse(last.expiresAt) > now) || !(await drained() && mode() !== 'ACTIVE'))) continue;
      // Task eb73b396（Fable 11-20“补：升级中续期”，进程启动宽限）：换代与回滚必然重启常驻，服务端要等收到带新 Source 的心跳才认它；
      // 本进程启动满一个检查周期前不发起新的投递（不写状态、不计退避）。让班等待中的重投与确认、自检不受此约束。
      if (!last?.waiting && uptime() < CHECK_INTERVAL) break;
      // 是否进窗口、是否当班只由 Broker 的新鲜签名探询判断（D2c 裁定 B2）：常驻对两类连接同样投递，不读 Broker 的每日观测。
      await post(kind, now);
      break;
    }
  };
}

export function parseRenewalStatus(input) {
  if (!input || !['PASS','FAIL'].includes(input.keyCheck) || !Number.isFinite(Date.parse(input.checkedAt))) return null;
  const view={keyCheck:input.keyCheck,checkedAt:new Date(input.checkedAt).toISOString(),connections:{}};
  for(const kind of KINDS) {
    const v=input.connections?.[kind];
    if(v) view.connections[kind]={bindingId:typeof v.bindingId==='string' && UUID.test(v.bindingId)?v.bindingId:null,
      expiresAt:typeof v.expiresAt==='string' && Number.isFinite(Date.parse(v.expiresAt))?new Date(v.expiresAt).toISOString():null,
      renewalWindowOpensAt:validTime(v.renewalWindowOpensAt)?new Date(v.renewalWindowOpensAt).toISOString():null,
      grantRequestId:v.code==='RENEW_PENDING_APPROVAL' && UUID.test(v.grantRequestId)?v.grantRequestId:null,
      retryAfterSeconds:v.code==='RENEW_PENDING_APPROVAL' && retrySeconds(v.retryAfterSeconds)?v.retryAfterSeconds:null,
      code:typeof v.code==='string' && CODE.test(v.code)?v.code:null};
  }
  return view;
}

export async function renewalStatus(root, now) {
  const book=await read(path.join(root,'state','connection-renewal.json'));
  if(!book) return null;
  const keys=book.keys;
  const ok=keys?.result==='PASS' && now>=Date.parse(book.checkedAt) && now-Date.parse(book.checkedAt)<3*CHECK_INTERVAL;
  const lanes={...book.lanes}, p=book.pending;
  if(p && !p.abandoned && KINDS.includes(p.kind) && now-p.at>=REPLY_OVERDUE) lanes[p.kind]={...lanes[p.kind],code:RESPONSE_WAITING};
  return parseRenewalStatus({keyCheck:ok?'PASS':'FAIL',checkedAt:book.checkedAt,connections:lanes});
}
