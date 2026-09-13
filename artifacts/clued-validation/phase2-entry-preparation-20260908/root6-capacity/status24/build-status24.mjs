// Status24 载荷生成器。执行单第 1 步交付物。
// 用法：node build-status24.mjs --decisions <decisions.json> [--pending]
//   decisions.json 提供决策表里全部「评审」项的裁定值与两个窗口时间；--pending 允许
//   时间与 M3 字段缺席，输出占位版并列出待定钉清单（不产 S24）。
// R26-F1 教训内建：载荷任何对象禁止数组索引形键；产出前跑 stringify 往返断言。
import fs from 'node:fs';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';
import path from 'node:path';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../../..');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const canonLF=v=>sha(JSON.stringify(sortKeys(v))+'\n');
const sortKeys=v=>Array.isArray(v)?v.map(sortKeys):(v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sortKeys(v[k])])):v);
const need=(ok,why)=>{if(!ok)throw Error(why);};
const argv=process.argv.slice(2),pending=argv.includes('--pending');
const dPath=argv.includes('--decisions')?argv[argv.indexOf('--decisions')+1]:null;need(dPath,'--decisions required');
const D=JSON.parse(fs.readFileSync(dPath,'utf8'));
const s23=JSON.parse(fs.readFileSync(path.join(REPO,'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root5-final-runtime-v16/SignedStatus23.json'),'utf8'));
const acc=JSON.parse(fs.readFileSync(path.join(REPO,'artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/root6-runtime-v19/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json'),'utf8'));
const ga={...acc.accepted_subject.expected_ga};
// R30：受理件现值 expected_ga.controller_qualification_ref 为错钉（6e35ff20 != 活绑定 e7cfb30b）。
// 决策文件以 expected_ga_overrides 显式给出受理件重钉后的期望值；本生成器绝不静默修正。
if(D.expected_ga_overrides)Object.assign(ga,D.expected_ga_overrides);
const schemaRaw=fs.readFileSync(path.join(REPO,'scripts/phase2-qualification/control-context-verifier-root6-linux-successor/status-manifest.root5.schema.json'),'utf8');
need(sha(schemaRaw)==='510f3b90cdb026c8c4d44ffac2647502ff8003cdd972850dbe042edbd6c310ef','LOCAL_SCHEMA_MOVED');
const GEN='ctrgen_5e0440a95ac8ee257b9e4236cabd275b';
const pendingPins=[];
const pin=(k,v)=>{if(v!==undefined&&v!==null)return v;need(pending,'MISSING_DECISION:'+k);pendingPins.push(k);return '__PENDING_'+k.toUpperCase()+'__';};
// source_digests/source_refs：从 Status23 出发按决策映射替换
const map=D.source_digest_map;need(map&&typeof map==='object','source_digest_map required');
const digests=s23.source_digests.map(h=>map[h]??h);
const refs=s23.source_refs.map(r=>{const nr=D.source_ref_map?.[r.sha256];return nr??(map[r.sha256]?need(false,'REF_MAP_MISSING_FOR_REPLACED_DIGEST:'+r.sha256.slice(0,12)):r);});
need(new Set(digests).size===digests.length,'DUP_SOURCE_DIGESTS');
const payload={
 object_type:'StatusManifest',schema_version:'1.0',
 schema_digest:'510f3b90cdb026c8c4d44ffac2647502ff8003cdd972850dbe042edbd6c310ef',
 audience:s23.audience,control_trust_root_generation:GEN,issuer_ref:s23.issuer_ref,
 status_manifest_id:D.status_manifest_id??('sm_'+crypto.randomBytes(16).toString('hex')),
 issuer_purpose:'STATUS',as_of:pin('as_of',D.as_of),expires_at:pin('expires_at',D.expires_at),
 generation:24,source_digests:digests,source_refs:refs,
 observations:{root_set_id:'ctr_414bd3c724264a83894b0c55cf2ab878',root_generation:GEN,
  profile_digest:'d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5',
  gate_digest:'3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a',
  controller_digest:'68133f2d617718c8ea964e3cebb6abcdbe98671aa5c630d81f0ea2daa9eed24a',
  scope_digest:'115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',
  runner_generation:pin('runner_generation',D.runner_generation),
  credential_generation:pin('credential_generation',D.credential_generation),
  session_generation:pin('session_generation',D.session_generation),
  stage_receipt_refs:ga.stage_receipt_refs},
};
// :352 谓词自验（可失败：改任一绑定摘要即炸）
for(const h of [payload.observations.profile_digest,payload.observations.gate_digest,payload.observations.controller_digest,payload.observations.scope_digest])
 need(payload.source_digests.includes(h),'STATUS_MISSING_BINDING_DIGEST:'+h.slice(0,12));
// :353 statusSources ⊆ source_refs
const must=[...ga.stage_receipt_refs,ga.scope_ref,ga.controller_qualification_ref,ga.authority_source_ref];
for(const m of must)need(payload.source_refs.some(x=>x.sha256===m.sha256&&x.uri===m.uri),'STATUS_MISSING_SOURCE_REF:'+m.sha256.slice(0,12));
// R26-F1：无数组索引形键 + 往返
const walk=o=>{if(o&&typeof o==='object'&&!Array.isArray(o))for(const k of Object.keys(o)){need(!/^\d+$/.test(k),'ARRAY_INDEX_LIKE_KEY:'+k);walk(o[k]);}else if(Array.isArray(o))o.forEach(walk);};walk(payload);
const raw=JSON.stringify(payload);need(JSON.stringify(JSON.parse(raw))===raw,'ROUNDTRIP');
const out={payload,S24:pendingPins.length?null:canonLF(payload),pending_pins:pendingPins};
fs.writeFileSync(path.join(HERE,pending?'Status24Payload.pending.json':'Status24Payload.candidate.json'),JSON.stringify(out.payload,null,2)+'\n');
console.log(JSON.stringify({state:pendingPins.length?'PENDING_PINS_LISTED':'PAYLOAD_FINAL',S24:out.S24,pending_pins:pendingPins,source_digest_replacements:Object.keys(map).length},null,2));
