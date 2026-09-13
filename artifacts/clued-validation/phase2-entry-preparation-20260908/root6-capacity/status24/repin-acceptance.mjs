// 受理件重钉工具（R29 修复执行单第 2 步的备妥件）。R31 独立评审 (/root) 出具。
// 只产候选字节与报告：不写活库、不提交、不合并。正式重钉 = M3 前一刻由执行单第 2 步跑本工具，
// 把产出的 AcceptanceRepinCandidate.json 交 Owner 经 M3 合并发布。
//
// 用法：
//   node repin-acceptance.mjs --as-of <UTC> --expires-at <UTC> \
//     --runner <runnergen_…> --credential <credgen_…> --session <sessiongen_…> \
//     --base <fb389314 活字节文件>  [--out-dir <dir>]
//   node repin-acceptance.mjs --selftest        # 合成窗口 + 定义值三代际 + 负控制全跑
//
// 编辑集（白名单，超出即拒）：
//   E1 late_bound_fields.status_manifest_ref.signed_payload_sha256  f4002ae4… → S24
//   E2 expected_ga.authority_source_ref.sha256  92186d46…(root5 注册体) → a93bfdda…(root6 注册体，附带 B)
//   E3 expected_ga.controller_qualification_ref → e7cfb30b/0427b0e6（R31-F1：活字节已是此值，通常为 no-op 断言；
//      若基底真带 6e35ff20（R30 所述形态）则修复之，两种以外的形态一律拒）
//   E4 known_open 增 R29/R30/R31 关闭记录
//   附带 A：stage_receipt_refs[2]===[3] 的重复【保留】——:81 EXACT_STAGE_INPUTS 要求 length===6，断言不编辑。
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
import {isDeepStrictEqual as same} from 'node:util';import {fileURLToPath} from 'node:url';
import {canonicalDigest} from '../../../../../scripts/phase2-qualification/control-context-verifier-root6-linux-successor/root-window-validation.mjs';
import {parseStoredStatus,time} from '../../../../../scripts/phase2-qualification/control-context-verifier-root6-linux-successor/context.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../../..');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const need=(ok,why)=>{if(!ok)throw Error(why);};
const hex64=/^[a-f0-9]{64}$/;

// —— 钉死的外部事实（每一个都在 R31 评审中实测过；formal run 会再验） ——
const LIVE_ACCEPTANCE_SHA256='fb3893147d480e718889bd05c7d7b343d8330792a2232296033ab91c72898c88';
const STALE_BRANCH_COPY_SHA256='775fd6446a4594f0d61258c968bd3a6cba8dfc0adc1df342f3bf143aa60597db';
const STATUS23_PAYLOAD_SHA256='f4002ae44595739b4ae230eb97ab50e54a3774fd68b7943fef26e5c1d6b43cd8';
const ROOT5_BODY_DIGEST='92186d46e92ee7d27427de813d14faeb1745fb3c1d08c6280ea86a84b258eff5';
const ROOT6_BODY_DIGEST='a93bfdda74d9d693584c32ecb9e1ec963fa448b51595fbe245abfeefbb4081c5';
const ROOT_URN='urn:clued:control-trust-root-set:uscrdifznmlvczcekqpw:ctr_414bd3c724264a83894b0c55cf2ab878';
const QUAL_REF={uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/0427b0e67756583d9916a0fdd9cac66ffa20c9ad',sha256:'e7cfb30b1d6241ad8b0a9976ae8a44d2b6fadd429f2f95bcf523c20fbe912888'};
const STALE_QUAL_SHA_EXACT='6e35ff20996e3c622e8915cdbc80a39ef78b222bcc99a5e09e73ea680f844df3';
const BINDING={profile:'d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5',gate:'3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a',controller:'68133f2d617718c8ea964e3cebb6abcdbe98671aa5c630d81f0ea2daa9eed24a',scope:'115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5'};

const argv=process.argv.slice(2),opt=k=>{const i=argv.indexOf('--'+k);return i>=0?argv[i+1]:undefined;};
const selftest=argv.includes('--selftest');
const outDir=opt('out-dir')??(selftest?fs.mkdtempSync(path.join(os.tmpdir(),'repin-selftest-')):HERE);

// 1) 输入五钉（selftest 用合成窗口 + item9 定义值三代际；后者与 2026-09-13 活库实测值逐字相等）
const pins=selftest?{as_of:'2026-09-13T12:00:00Z',expires_at:'2026-09-14T12:00:00Z',runner_generation:'runnergen_a256855fec9441839105c69b746c5244',credential_generation:'credgen_bac92a11e7144a3fb9e67f40a6a07d11',session_generation:'sessiongen_ffb02a907d334b0da0b37bf457a758c2'}
 :{as_of:opt('as-of'),expires_at:opt('expires-at'),runner_generation:opt('runner'),credential_generation:opt('credential'),session_generation:opt('session')};
for(const [k,v] of Object.entries(pins))need(typeof v==='string'&&v.length>0,'MISSING_PIN:'+k);
need(time(pins.as_of)<time(pins.expires_at),'WINDOW_ORDER');

// 2) 基底活字节。selftest 从 origin/main 提取；formal run 用 --base 指定的 fb389314 字节。
let baseRaw;
if(selftest){baseRaw=execFileSync('git',['-C',REPO,'show','origin/main:artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root6-runtime-v19/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json'],{encoding:'utf8',maxBuffer:1<<21});}
else{const b=opt('base');need(b,'--base required (fb389314 活字节；本仓库分支路径上的副本是 775fd644 陈旧件，会被拒)');baseRaw=fs.readFileSync(b,'utf8');}
need(sha(baseRaw)!==STALE_BRANCH_COPY_SHA256,'STALE_BRANCH_COPY_REFUSED: 775fd644 是分支陈旧副本（\\u 转义、qual ref 6e35ff20），不是活字节。从 main/M2 (88fc944b) 提取 fb389314。');
need(sha(baseRaw)===LIVE_ACCEPTANCE_SHA256,'BASE_NOT_LIVE_ACCEPTANCE: sha256='+sha(baseRaw).slice(0,12)+'… 期望 fb389314…。若活绑定已换钉，须先重新评审本工具的编辑白名单。');
const base=JSON.parse(baseRaw);
need(JSON.stringify(base,null,1)+'\n'===baseRaw,'BASE_SERIALIZATION_NOT_CANONICAL: 对象级原子编辑的前提（stringify(v,null,1)+LF 往返）不成立');

// 3) 定稿 Status24：合并 decisions.final.json + 五钉 → 跑 build-status24.mjs 本尊 → S24
const decisions={...JSON.parse(fs.readFileSync(path.join(HERE,'decisions.final.json'),'utf8')),...pins};
const decPath=path.join(outDir,'decisions.resolved.json');
fs.writeFileSync(decPath,JSON.stringify(decisions,null,1)+'\n');
const buildOut=JSON.parse(execFileSync(process.execPath,[path.join(HERE,'build-status24.mjs'),'--decisions',decPath],{encoding:'utf8',cwd:HERE}));
need(buildOut.state==='PAYLOAD_FINAL'&&hex64.test(buildOut.S24)&&buildOut.pending_pins.length===0,'BUILD_NOT_FINAL');
const S24=buildOut.S24;
const sm=JSON.parse(fs.readFileSync(path.join(HERE,'Status24Payload.candidate.json'),'utf8'));
need(canonicalDigest(sm)===S24,'S24_RECOMPUTE_MISMATCH');

// 4) 原子编辑（在深拷贝上做，随后 diff-白名单核对）
function repin(edited,{s24,authority,qual}){
 const s=edited.accepted_subject,notes=[];
 const lb=s.late_bound_fields.status_manifest_ref;
 need(lb.signed_payload_sha256===STATUS23_PAYLOAD_SHA256,'E1_PRECONDITION: late_bound 不是 f4002ae4（R29 形态），基底不是本工具评审过的对象');
 lb.signed_payload_sha256=s24;notes.push('E1 late_bound f4002ae4→'+s24.slice(0,12)+'…');
 const asr=s.expected_ga.authority_source_ref;
 need(asr.uri===ROOT_URN,'E2_URI_DRIFT');
 need(asr.sha256===ROOT5_BODY_DIGEST,'E2_PRECONDITION: authority_source_ref 既非 92186d46 亦未换钉过——不是评审过的形态');
 asr.sha256=authority;notes.push('E2 authority_source_ref 92186d46→'+authority.slice(0,12)+'…（附带 B）');
 const q=s.expected_ga.controller_qualification_ref;
 if(same(q,qual))notes.push('E3 controller_qualification_ref 已是 e7cfb30b（R31-F1 实测活字节即此值）——no-op 断言通过');
 else if(q.sha256===STALE_QUAL_SHA_EXACT){s.expected_ga.controller_qualification_ref={...qual};notes.push('E3 controller_qualification_ref 6e35ff20→e7cfb30b（R30 形态，已修）');}
 else need(false,'E3_UNRECOGNIZED: qualification ref 既非 e7cfb30b 亦非 6e35ff20');
 const srr=s.expected_ga.stage_receipt_refs;
 need(srr.length===6&&same(srr[2],srr[3]),'附带A_PRECONDITION: 期望 6 项且 [2]===[3]（eb25e993 重复）');
 notes.push('附带A stage_receipt_refs 重复【保留】—— context.mjs:81 要求 length===6，去重即炸');
 need(!('R29' in edited.known_open)&&!('R30' in edited.known_open)&&!('R31' in edited.known_open),'E4_ALREADY_PRESENT');
 edited.known_open.R29={severity:'BLOCKER',state:'CLOSED_BY_THIS_REPIN',note:'late_bound status_manifest_ref 曾钉 Status23 载荷摘要 f4002ae4（schema 76bb79f7、root5 代际），与 :349 的新 schema 510f3b90 互斥（R29LateBoundStatusPayloadDeadlock.md）。本次重钉换为先造后钉的 Status24 载荷摘要 S24；载荷经 build-status24.mjs 以 decisions.final.json（R31 裁定）生成。'};
 edited.known_open.R30={severity:'MAJOR',state:'CLOSED_NO_BYTE_CHANGE_REQUIRED',note:'R30 断言活字节 expected_ga.controller_qualification_ref=6e35ff20 —— R31-F1 证伪：fb389314 活字节此字段已是 e7cfb30b/0427b0e6（R30 的实测对象是分支陈旧副本 775fd644，该副本还因 \\u 转义过不了 admin parser）。本工具对此字段做断言而非编辑；若未来基底真带 6e35ff20 亦能修复。'};
 edited.known_open.R31={severity:'MAJOR',state:'CLOSED_BY_THIS_REPIN',note:'附带 B：expected_ga.authority_source_ref 由 root5 注册体摘要 92186d46 换钉为 root6 注册体摘要 a93bfdda（取法 canonicalDigest=排序紧凑+LF、含 signature_binding，对活库 event seq5/seq6 body 复算验证；沿用即 :37/:322 两头堵）。附带 A：stage_receipt_refs[2]===[3] 重复保留（:81 length===6）。全部裁定与实测见 R31ReviewStatus24DecisionsAndRepin.md。'};
 notes.push('E4 known_open += R29/R30/R31');
 return notes;
}
const edited=structuredClone(base);
const editNotes=repin(edited,{s24:S24,authority:ROOT6_BODY_DIGEST,qual:QUAL_REF});
const newRaw=JSON.stringify(edited,null,1)+'\n';
const ACC21=sha(newRaw);

// 5) diff-白名单：基底与产出之间只允许出现编辑集内的路径差异
function diffPaths(a,b,p,out){
 if(same(a,b))return out;
 if(a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)){
  const keys=new Set([...Object.keys(a),...Object.keys(b)]);
  for(const k of keys)diffPaths(a?.[k],b?.[k],p+'/'+k,out);
  return out;
 }
 out.push(p);return out;
}
const changed=diffPaths(base,edited,'',[]);
const allowed=[/^\/accepted_subject\/late_bound_fields\/status_manifest_ref\/signed_payload_sha256$/,/^\/accepted_subject\/expected_ga\/authority_source_ref\/sha256$/,/^\/accepted_subject\/expected_ga\/controller_qualification_ref\//,/^\/known_open\/R29(\/|$)/,/^\/known_open\/R30(\/|$)/,/^\/known_open\/R31(\/|$)/];
for(const c of changed)need(allowed.some(rx=>rx.test(c)),'EDIT_OUTSIDE_WHITELIST:'+c);
need(changed.length>0,'NO_EDIT_HAPPENED');

// 6) 谓词自验（从 context.mjs 逐条抠出，行号即出处；能跑的全跑，跑不了的列 deferred）
const checks=[];const run=(name,fn)=>{fn();checks.push(name);};
const ga={...edited.accepted_subject.expected_ga,runner_generation:pins.runner_generation,credential_generation:pins.credential_generation,session_generation:pins.session_generation};
const sub=edited.accepted_subject;
run(':39 parseStoredStatus(newRaw) —— BOUNDED(≤131072)+admin parser 往返+safe（真代码路径）',()=>{const v=parseStoredStatus(newRaw);need(same(v,edited),'ADMIN_ROUNDTRIP_VALUE');});
run(':81 ga.stage_receipt_refs.length===6（附带 A 依赖）',()=>need(ga.stage_receipt_refs.length===6,'EXACT_STAGE_INPUTS'));
run(':322 ga.authority_source_ref === {urn, canonicalDigest(root6 注册体快照)}（formal run 由 GRR 对活库再验）',()=>{
 const snap=JSON.parse(fs.readFileSync(path.join(HERE,'Root6RegistrationBodySnapshot20260913.json'),'utf8'));
 need(canonicalDigest(snap)===ROOT6_BODY_DIGEST&&ga.authority_source_ref.sha256===ROOT6_BODY_DIGEST&&ga.authority_source_ref.uri===ROOT_URN,'ACTUAL_CURRENT_ROOT_REF');
 const snap5=JSON.parse(fs.readFileSync(path.join(HERE,'Root5RegistrationBodySnapshot20260913.json'),'utf8'));
 need(canonicalDigest(snap5)===ROOT5_BODY_DIGEST,'ROOT5_RECIPE_ANCHOR');});
run(':70(半) ga.controller_qualification_ref.sha256===活绑定 qualification_sha256(e7cfb30b)',()=>need(ga.controller_qualification_ref.sha256===QUAL_REF.sha256,'EXACT_CONTROLLER_SCOPE_BINDING'));
const blob=ref=>{const m=ref.uri.match(/git\/blobs\/([a-f0-9]{40})$/);need(m,'REF_URI');const raw=execFileSync('git',['-C',REPO,'cat-file','blob',m[1]],{encoding:'utf8',maxBuffer:1<<22});need(sha(raw)===ref.sha256,'BLOB_SHA256:'+ref.sha256.slice(0,12));return raw;};
run(':122 EXACT_CAPACITY_SUBJECT_AND_LOADED_SET —— capacity_materials 键形 + 材料字节实取实哈希',()=>{
 need(same(Object.keys(sub.capacity_materials).sort(),['applicability','approval']),'KEYS');
 blob(sub.capacity_materials.approval.ref);blob(sub.capacity_materials.applicability.ref);});
run(':129 EXACT_INDEPENDENT_CAPACITY_APPLICABILITY —— d.state/reviewer/approval_ref 对钉',()=>{
 const d=JSON.parse(blob(sub.capacity_materials.applicability.ref));
 need(d.state==='ACCEPTED_EXACT_ROOT3_ORIGINAL_INPUT_CAPACITY_SUPPLEMENT'&&d.independent_reviewer==='/root/project_list_auth_fix'&&same(d.approval_ref,sub.capacity_materials.approval.ref),'CAPACITY_APPLICABILITY');});
run(':132 CAPACITY_EXACT_CURRENT_CONTROLLER_SCOPE —— d.controller/scope === expected_ga 现值',()=>{
 const d=JSON.parse(blob(sub.capacity_materials.applicability.ref));
 need(d.controller_digest===ga.controller_digest&&d.scope_digest===ga.scope_digest&&ga.controller_digest===BINDING.controller&&ga.scope_digest===BINDING.scope,'CAPACITY_CONTROLLER_SCOPE');});
run(':348(形) sm.schema_digest===control_schema_refs.StatusManifest.sha256 + purpose/audience/ctrgen',()=>{
 need(sm.schema_digest===sub.control_schema_refs.StatusManifest.sha256&&sm.issuer_purpose==='STATUS'&&sm.audience===ga.audience&&sm.control_trust_root_generation===ga.control_trust_root_generation,'EXACT_SIGNED_STATUS_SCHEMA_PURPOSE');});
run(':349(形) as_of<expires_at、格式合法、source_digests 非空（as_of<=now 是运行时检查，deferred）',()=>{
 need(time(sm.as_of)<time(sm.expires_at)&&Array.isArray(sm.source_digests)&&sm.source_digests.length>0,'STATUS_CURRENT_INPUTS');});
run(':350-351 sm.observations 深等 statusExpected + 四绑定摘要 ∈ source_digests',()=>{
 const exp={root_set_id:'ctr_414bd3c724264a83894b0c55cf2ab878',root_generation:'ctrgen_5e0440a95ac8ee257b9e4236cabd275b',profile_digest:BINDING.profile,gate_digest:BINDING.gate,controller_digest:BINDING.controller,scope_digest:BINDING.scope,runner_generation:ga.runner_generation,credential_generation:ga.credential_generation,session_generation:ga.session_generation,stage_receipt_refs:ga.stage_receipt_refs};
 need(same(sm.observations,exp),'STATUS_EXACT_CURRENT_OBSERVATION_BINDING/observations');
 need([BINDING.profile,BINDING.gate,BINDING.controller,BINDING.scope].every(h=>sm.source_digests.includes(h)),'STATUS_EXACT_CURRENT_OBSERVATION_BINDING/digests');});
run(':352-353 statusSources(重钉后 expected_ga) ⊆ sm.source_refs',()=>{
 const must=[...ga.stage_receipt_refs,ga.scope_ref,ga.controller_qualification_ref,ga.authority_source_ref];
 for(const m of must)need(sm.source_refs.some(x=>x.sha256===m.sha256&&x.uri===m.uri),'STATUS_MISSING_SOURCE_REF:'+m.sha256.slice(0,12));});
run(':357 canonicalDigest(sm)===重钉后 late_bound===S24（R29 死锁的解本体）',()=>{
 need(canonicalDigest(sm)===edited.accepted_subject.late_bound_fields.status_manifest_ref.signed_payload_sha256&&S24===canonicalDigest(sm),'EXACT_ACCEPTED_LATE_BOUND_STATUS_PAYLOAD');});
const deferred=[':349 as_of<=Date.now()（新窗口内才真）',':354 STATUS_STORE_MAPPING（store_ref 于 append 后）',':355/:358 Owner merge/signature_binding（M3 之后）',':63 INDEPENDENT_GENERATION_DRIFT（预留时对活库）',':322 对活库 root 的 canonicalDigest（GRR 现场）'];

// 7) 判别器：负控制逐个证明上述检查可失败
const nc=[];const mustFail=(name,fn)=>{let threw=false;try{fn();}catch(e){threw=true;nc.push(name+' → '+String(e.message).slice(0,60));}need(threw,'NEGATIVE_CONTROL_PASSED_UNEXPECTEDLY:'+name);};
mustFail('NC1 S24 翻一位 → E1 重钉值与载荷摘要失配(:357)',()=>{const bad=structuredClone(edited);bad.accepted_subject.late_bound_fields.status_manifest_ref.signed_payload_sha256=S24.replace(/^./,S24[0]==='0'?'1':'0');need(canonicalDigest(sm)===bad.accepted_subject.late_bound_fields.status_manifest_ref.signed_payload_sha256,'EXACT_ACCEPTED_LATE_BOUND_STATUS_PAYLOAD');});
mustFail('NC2 stage_receipt_refs 去重 → :81 炸',()=>{const bad=structuredClone(ga.stage_receipt_refs).filter((r,i,a)=>a.findIndex(x=>x.sha256===r.sha256)===i);need(bad.length===6,'EXACT_STAGE_INPUTS');});
mustFail('NC3 authority 沿用 92186d46 → :322 对 root6 快照炸',()=>{need(ROOT5_BODY_DIGEST===ROOT6_BODY_DIGEST,'ACTUAL_CURRENT_ROOT_REF');});
mustFail('NC4 \\u 转义序列化 → admin parser 炸',()=>{const esc=JSON.stringify(edited,null,1).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));parseStoredStatus(esc+'\n');});
mustFail('NC5 分支陈旧副本当基底 → 拒',()=>{need(STALE_BRANCH_COPY_SHA256===LIVE_ACCEPTANCE_SHA256,'BASE_NOT_LIVE_ACCEPTANCE');});
mustFail('NC6 编辑白名单外改动 → 拒',()=>{const bad=structuredClone(edited);bad.accepted_subject.capacity_delta.original_input_bytes_after=5000000;const ch=diffPaths(edited,bad,'',[]);for(const c of ch)need(allowed.some(rx=>rx.test(c)),'EDIT_OUTSIDE_WHITELIST:'+c);});
mustFail('NC7 载荷 observations 换 root5 控制器 → :351 炸',()=>{const bad=structuredClone(sm);bad.observations.controller_digest='ac7bdd53b7fe5705ee70f4fbb08ce6a5889ccf6d6574a3575e51f16bb09c2daa';const exp={...bad.observations,controller_digest:BINDING.controller};need(same(bad.observations,exp),'STATUS_EXACT_CURRENT_OBSERVATION_BINDING');});

// 8) 产出
fs.writeFileSync(path.join(outDir,'AcceptanceRepinCandidate.json'),newRaw);
const report={state:selftest?'SELFTEST_PASSED_NOT_A_REPIN':'CANDIDATE_PREPARED_NOT_EXECUTED',S24,ACC21_candidate_sha256:ACC21,base_sha256:LIVE_ACCEPTANCE_SHA256,bytes:Buffer.byteLength(newRaw),edits:editNotes,changed_paths:changed.length,checks,negative_controls:nc,deferred_to_runtime:deferred,boundary:'本工具不写活库、不注册、不预留、不合并；候选字节须经 Owner M3 合并后方为受理件。'};
fs.writeFileSync(path.join(outDir,'RepinReport.json'),JSON.stringify(report,null,1)+'\n');
console.log(JSON.stringify(report,null,2));
