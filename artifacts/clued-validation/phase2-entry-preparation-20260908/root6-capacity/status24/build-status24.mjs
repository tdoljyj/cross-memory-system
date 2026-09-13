// Status24 载荷生成器 —— window 参数化版。默认 window12（root7 代际 / F12 冻结点）。
// 用法：
//   node build-status24.mjs --decisions <decisions.json> [--window <id>] [--pending] [--out <dir>]
//   node build-status24.mjs --selftest
// 语义：decisions.json 提供决策表全部「评审」项的裁定值；--pending 允许「待定钉」缺席，
//   此时**只出 pending 版、不出定稿、S24 恒为 null**（PENDING_MUST_NOT_EMIT_FINAL）。
// 只生成，不执行：不写库、不 append_event、不预留、不注册、不签发、不合并。
// R26-F1 教训内建：载荷任何对象禁止数组索引形键；产出前跑 stringify 往返断言。
import fs from 'node:fs';import crypto from 'node:crypto';import os from 'node:os';
import {fileURLToPath} from 'node:url';import path from 'node:path';
const HERE=path.dirname(fileURLToPath(import.meta.url)),REPO=path.resolve(HERE,'../../../../..');
const A='artifacts/clued-validation/phase2-entry-preparation-20260908';
const V='scripts/phase2-qualification/control-context-verifier-root6-linux-successor';
const BLOB='https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const blobSha1=b=>crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob '+b.length+'\0','utf8'),b])).digest('hex');
const sortKeys=v=>Array.isArray(v)?v.map(sortKeys):(v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sortKeys(v[k])])):v);
const canonLF=v=>sha(JSON.stringify(sortKeys(v))+'\n');
const eq=(a,b)=>JSON.stringify(sortKeys(a))===JSON.stringify(sortKeys(b));
const need=(ok,why)=>{if(!ok)throw Error(why);};
const rd=rel=>fs.readFileSync(path.join(REPO,rel));

// ── 待定钉花名册：显式枚举。每项 = {钉名, pending 占位符, 适用窗口, 落点}。────────────
// 原五项（R31）+ window12 新增的第六项（root7 注册体摘要，注册后才可算）。
const PIN_ROSTER=Object.freeze([
 {key:'as_of',                         token:'__PENDING_AS_OF__',
  windows:['window11-root6','window12-root7'], site:'payload.as_of（:349 STATUS_CURRENT_INPUTS）'},
 {key:'expires_at',                    token:'__PENDING_EXPIRES_AT__',
  windows:['window11-root6','window12-root7'], site:'payload.expires_at（:349 + append A4 恰等）'},
 {key:'runner_generation',             token:'__PENDING_RUNNER_GENERATION__',
  windows:['window11-root6','window12-root7'], site:'observations.runner_generation（:351 深等）'},
 {key:'credential_generation',         token:'__PENDING_CREDENTIAL_GENERATION__',
  windows:['window11-root6','window12-root7'], site:'observations.credential_generation（:351 深等）'},
 {key:'session_generation',            token:'__PENDING_SESSION_GENERATION__',
  windows:['window11-root6','window12-root7'], site:'observations.session_generation（:351 深等）'},
 {key:'root_registration_body_digest', token:'__PENDING_ROOT7_REGISTRATION_BODY_CANONICAL_SHA256__',
  windows:['window12-root7'],
  site:'source_digests[#8] / source_refs[#8] / expected_ga.authority_source_ref（:322 + :353）',
  since:'window12：#8 的值 = canonicalDigest(root7 注册体)。root7 代际 ctrgen_26769cc7 已造未烧，'
       +'注册后才可算，故升为待定钉；R31 所算 a93bfdda 转岗为 root7 注册体的 predecessor 钉。'},
]);

// ── 窗口参数面 ────────────────────────────────────────────────────────────────────
const WINDOWS={
 'window12-root7':{
  id:'window12-root7', generation:24, historical:false,
  root_set_id:'ctr_414bd3c724264a83894b0c55cf2ab878',
  root_generation:'ctrgen_26769cc7109ced40bc4016b2af678198',      // 已造未烧，注册后才生效
  predecessor_generation:'ctrgen_5e0440a95ac8ee257b9e4236cabd275b',
  status_schema_digest:'7e5df5dd2b2341fe38c7b2a86ef68542700ee878bec0c947b13d7c8311fecd2d',
  controller_digest:'73c05cada90b00915f8b352a2dac6f77bf82b44660950e7e9a1415f5cab99b35', // F12 冻结点
  profile_digest:'d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5',
  gate_digest:'3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a',
  scope_digest:'115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',
  acceptance_path:A+'/bootstrap/root7-runtime-v20/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json',
  status_issuer_ref:{uri:BLOB+'28ec4ccab807fbdbbb84c31e78e2a9a9070f2149',
   sha256:'3cb175ca0d3720773c9561840aa1e12bf3c04f2dd864d8bdde6d3e1690bf03b4'},
  predecessor_body_snapshot:A+'/root6-capacity/status24/Root6RegistrationBodySnapshot20260913.json',
  pending_pin_count:6, out_basename:'Status24Payload.window12',
 },
 'window11-root6':{  // R31 形态。留作对照：本树已实化 F12，故此档在本树上**不可复现**（见 NC8）。
  id:'window11-root6', generation:24, historical:true,
  root_set_id:'ctr_414bd3c724264a83894b0c55cf2ab878',
  root_generation:'ctrgen_5e0440a95ac8ee257b9e4236cabd275b',
  predecessor_generation:'ctrgen_e5df432221344996afc04b5638121d96',
  status_schema_digest:'510f3b90cdb026c8c4d44ffac2647502ff8003cdd972850dbe042edbd6c310ef',
  controller_digest:'68133f2d617718c8ea964e3cebb6abcdbe98671aa5c630d81f0ea2daa9eed24a',
  profile_digest:'d1c060b85f0b842a397a478105ea57a208e62eb0a5a2d4c2cd8f93f63eae88f5',
  gate_digest:'3487d9fc6ccee5478569021961eac93bf5ef6bd4bc2428559b20a44abb9c155a',
  scope_digest:'115408c69dcb2fa606fb0de34ec86c5239487d0cfa9a73abb267664a2482abe5',
  acceptance_path:A+'/bootstrap/root6-runtime-v19/ExactRoot5FinalPreentryControllerRuntimeAcceptance.json',
  status_issuer_ref:{uri:BLOB+'c1749399c047a5b88461ef8df54ea80b1b59938a',
   sha256:'1640995831b0c1f8ae616810e12eb7b97ee191e9f20b5c38eee32eb8bfac9d23'},
  predecessor_body_snapshot:A+'/root6-capacity/status24/Root5RegistrationBodySnapshot20260913.json',
  pending_pin_count:5, out_basename:'Status24Payload',
 },
};

function build({windowId='window12-root7',D,pending=false,outDir=HERE,write=false,windowPatch=null,inject=null}){
 const W={...(WINDOWS[windowId]??need(false,'UNKNOWN_WINDOW:'+windowId)),...(windowPatch??{})};
 const checks=[];const ck=(name,ok,why)=>{need(ok,why??name);checks.push(name);};

 // 1) 待定钉花名册：显式枚举 + 长度断言（原五项 + window12 的 root7 注册体摘要项）
 const ROSTER=PIN_ROSTER.filter(p=>p.windows.includes(W.id));
 ck('PENDING_PIN_ROSTER_LENGTH',ROSTER.length===W.pending_pin_count,
    'PENDING_PIN_ROSTER_LENGTH:'+W.id+' declared '+W.pending_pin_count+' got '+ROSTER.length);
 const rosterKeys=ROSTER.map(p=>p.key);
 const pinCache=new Map(),pendingKeys=[];
 const pinValue=key=>{
  if(pinCache.has(key))return pinCache.get(key);
  const spec=ROSTER.find(p=>p.key===key);need(spec,'PIN_NOT_ON_ROSTER_FOR_'+W.id+':'+key);
  const v=D[key];let out;
  if(v!==undefined&&v!==null)out=v;
  else{need(pending,'MISSING_DECISION:'+key);pendingKeys.push(key);out=spec.token;}
  pinCache.set(key,out);return out;};
 // decisions 里的 "@pin:<钉名>" 一律由同一个钉解析 —— 保证「一次实化、处处一致」。
 const deref=v=>typeof v==='string'&&v.startsWith('@pin:')?pinValue(v.slice(5))
  :Array.isArray(v)?v.map(deref)
  :(v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,deref(x)])):v);

 // 2) 本地 schema（F12 后 = 7e5df5dd）与受理件（window12 = root7-runtime-v20 重出件）
 const schemaRaw=rd(V+'/status-manifest.root5.schema.json');
 ck('LOCAL_SCHEMA_DIGEST',sha(schemaRaw)===W.status_schema_digest,
    'LOCAL_SCHEMA_DIGEST_MISMATCH:'+W.id+' wants '+W.status_schema_digest.slice(0,12)+' tree has '+sha(schemaRaw).slice(0,12));
 const acc=JSON.parse(rd(W.acceptance_path)),subject=acc.accepted_subject;
 const ga={...subject.expected_ga};
 // 受理件现值与本窗期望不一致时，决策文件以 expected_ga_overrides 显式给出；生成器绝不静默修正。
 if(D.expected_ga_overrides)Object.assign(ga,deref(D.expected_ga_overrides));

 // 3) 窗口参数 × 受理件 交叉核对（每条都是实测可失败的）
 ck('ROOT_SET_ID_DISAGREES_WITH_ACCEPTANCE',subject.root_id===W.root_set_id,
    'ROOT_SET_ID_DISAGREES_WITH_ACCEPTANCE:'+subject.root_id);
 ck('ROOT_GENERATION_DISAGREES_WITH_ACCEPTANCE',ga.control_trust_root_generation===W.root_generation,
    'ROOT_GENERATION_DISAGREES_WITH_ACCEPTANCE: acceptance '+ga.control_trust_root_generation+' vs window '+W.root_generation);
 ck('CONTROLLER_DIGEST_DISAGREES_WITH_ACCEPTANCE',ga.controller_digest===W.controller_digest,
    'CONTROLLER_DIGEST_DISAGREES_WITH_ACCEPTANCE: acceptance '+String(ga.controller_digest).slice(0,12)+' vs window '+W.controller_digest.slice(0,12));
 ck('PROFILE_DIGEST_DISAGREES_WITH_ACCEPTANCE',ga.profile_digest===W.profile_digest,
    'PROFILE_DIGEST_DISAGREES_WITH_ACCEPTANCE:'+String(ga.profile_digest).slice(0,12));
 ck('SCOPE_DIGEST_DISAGREES_WITH_ACCEPTANCE',ga.scope_digest===W.scope_digest,
    'SCOPE_DIGEST_DISAGREES_WITH_ACCEPTANCE:'+String(ga.scope_digest).slice(0,12));
 ck('ACCEPTED_STATUS_SCHEMA_DIGEST',subject.control_schema_refs?.StatusManifest?.sha256===W.status_schema_digest,
    'ACCEPTED_STATUS_SCHEMA_DIGEST_DISAGREES:'+String(subject.control_schema_refs?.StatusManifest?.sha256).slice(0,12));

 // 4) :317 的 STATUS issuer 资格件摘要就地量（不抄常量，直接读 context.mjs 的钉）
 const pin317=/purpose==='STATUS'\?'([0-9a-f]{64})':'([0-9a-f]{64})'/.exec(rd(V+'/context.mjs').toString('utf8'));
 ck('CONTEXT_317_ISSUER_PIN_FOUND',!!pin317,'CONTEXT_317_ISSUER_PIN_NOT_FOUND');
 ck('ISSUER_PIN_AT_CONTEXT_317',pin317[1]===W.status_issuer_ref.sha256,
    'ISSUER_PIN_AT_CONTEXT_317_MISMATCH: context.mjs '+pin317[1].slice(0,12)+' vs window '+W.status_issuer_ref.sha256.slice(0,12));

 // 5) 第六钉的占位符必须与受理件里同一处的占位符逐字相同，否则 pending 版的 :353 是假过
 const sixth=ROSTER.find(p=>p.key==='root_registration_body_digest');
 if(sixth){const av=subject.expected_ga.authority_source_ref?.sha256;
  if(/^__PENDING_/.test(String(av)))
   ck('PENDING_TOKEN_AGREES_WITH_ACCEPTANCE',av===sixth.token,'PENDING_TOKEN_DISAGREES_WITH_ACCEPTANCE: acceptance '+av+' vs roster '+sixth.token);}

 // 6) a93bfdda 的新岗位：root7 注册体的 predecessor 钉（对快照现算，不抄）
 if(W.predecessor_body_snapshot){
  const snap=JSON.parse(rd(W.predecessor_body_snapshot)),d=canonLF(snap);
  const dec=D.root_registration_predecessor??{};
  ck('REGISTRATION_PREDECESSOR_DIGEST',d===dec.sha256,
     'REGISTRATION_PREDECESSOR_DIGEST_MISMATCH: snapshot '+d.slice(0,12)+' vs decisions '+String(dec.sha256).slice(0,12));
  ck('REGISTRATION_PREDECESSOR_GENERATION',snap.control_trust_root_generation===W.predecessor_generation&&dec.generation_id===W.predecessor_generation,
     'REGISTRATION_PREDECESSOR_GENERATION_MISMATCH: snapshot '+snap.control_trust_root_generation+' decisions '+dec.generation_id);
  // predecessor 钉的形状按现任体自证：{sha256, generation_id}，root7 体应照此填 a93bfdda。
  ck('REGISTRATION_PREDECESSOR_SHAPE',
     typeof snap.predecessor?.sha256==='string'&&typeof snap.predecessor?.generation_id==='string'
     &&Object.keys(sortKeys(dec)).filter(k=>!k.startsWith('_')).join(',')==='generation_id,sha256',
     'REGISTRATION_PREDECESSOR_SHAPE_MISMATCH:'+Object.keys(sortKeys(dec)).join(','));}

 // 7) 供源实物核对：每条 provenance 声明的字节必须真算出那个摘要，并给出其 git blob sha1
 const provBlob=new Map();
 for(const [digest,rel] of Object.entries(D.source_provenance??{})){
  const buf=rd(rel);
  ck('PROVENANCE:'+digest.slice(0,12),sha(buf)===digest,
     'PROVENANCE_DIGEST_MISMATCH:'+rel+' -> '+sha(buf).slice(0,12)+' != declared '+digest.slice(0,12));
  provBlob.set(digest,blobSha1(buf));}

 // 8) source_digests / source_refs：从 Status23 出发按决策映射替换
 const s23=JSON.parse(rd(A+'/bootstrap/root5-final-runtime-v16/SignedStatus23.json'));
 const map=deref(D.source_digest_map);need(map&&typeof map==='object','source_digest_map required');
 const refMap=deref(D.source_ref_map)??{};
 const digests=s23.source_digests.map(h=>map[h]??h);
 const refs=s23.source_refs.map(r=>{const nr=refMap[r.sha256];
  return nr??(map[r.sha256]?need(false,'REF_MAP_MISSING_FOR_REPLACED_DIGEST:'+r.sha256.slice(0,12)):r);});
 ck('DUP_SOURCE_DIGESTS',new Set(digests).size===digests.length,'DUP_SOURCE_DIGESTS');
 ck('SOURCE_ARITY',digests.length===s23.source_digests.length&&refs.length===s23.source_refs.length,'SOURCE_ARITY_CHANGED');
 for(const r of refs){const b=provBlob.get(r.sha256),m=/git\/blobs\/([0-9a-f]{40})$/.exec(r.uri);
  if(b&&m)ck('REF_BLOB:'+r.sha256.slice(0,12),m[1]===b,
   'SOURCE_REF_BLOB_SHA1_MISMATCH:'+r.sha256.slice(0,12)+' uri '+m[1].slice(0,12)+' != file '+b.slice(0,12));}

 // 9) 载荷 issuer_ref：:341 钉 root.issuer_bindings[STATUS].qualification_ref —— root7 下必换新件
 const mappedIssuer=refMap[s23.issuer_ref.sha256]??s23.issuer_ref;
 ck('STATUS_ISSUER_REF_IS_THE_WINDOW_QUALIFICATION',eq(mappedIssuer,W.status_issuer_ref),
    'STATUS_ISSUER_REF_NOT_THE_WINDOW_STATUS_QUALIFICATION: mapped '+String(mappedIssuer.sha256).slice(0,12)
    +' vs window '+W.status_issuer_ref.sha256.slice(0,12));

 const payload={
  object_type:'StatusManifest',schema_version:'1.0',
  schema_digest:W.status_schema_digest,
  audience:s23.audience,control_trust_root_generation:W.root_generation,issuer_ref:W.status_issuer_ref,
  status_manifest_id:D.status_manifest_id??('sm_'+crypto.randomBytes(16).toString('hex')),
  issuer_purpose:'STATUS',as_of:pinValue('as_of'),expires_at:pinValue('expires_at'),
  generation:W.generation,source_digests:digests,source_refs:refs,
  observations:{root_set_id:W.root_set_id,root_generation:W.root_generation,
   profile_digest:W.profile_digest,gate_digest:W.gate_digest,
   controller_digest:W.controller_digest,scope_digest:W.scope_digest,
   runner_generation:pinValue('runner_generation'),
   credential_generation:pinValue('credential_generation'),
   session_generation:pinValue('session_generation'),
   stage_receipt_refs:ga.stage_receipt_refs},
 };
 if(inject)inject(payload);   // 仅 --selftest 用：注入坏形态以验判别器

 // 10) :351 四绑定摘要必须在 source_digests 内（改任一绑定摘要即炸）
 for(const h of [payload.observations.profile_digest,payload.observations.gate_digest,
                 payload.observations.controller_digest,payload.observations.scope_digest])
  ck('BINDING_DIGEST:'+h.slice(0,12),payload.source_digests.includes(h),'STATUS_MISSING_BINDING_DIGEST:'+h.slice(0,12));
 // 11) :353 statusSources ⊆ source_refs
 const must=[...ga.stage_receipt_refs,ga.scope_ref,ga.controller_qualification_ref,ga.authority_source_ref];
 for(const m of must)ck('SOURCE_REF:'+String(m.sha256).slice(0,12),
  payload.source_refs.some(x=>x.sha256===m.sha256&&x.uri===m.uri),'STATUS_MISSING_SOURCE_REF:'+String(m.sha256).slice(0,12));
 // 12) :81 附带 A：stage_receipt_refs 必须仍是 6 条（去重即炸）
 ck('EXACT_STAGE_INPUTS_ARITY',payload.observations.stage_receipt_refs.length===6,
    'EXACT_STAGE_INPUTS_WOULD_FAIL: stage_receipt_refs must stay 6 (context.mjs:81), got '+payload.observations.stage_receipt_refs.length);
 // 13) R26-F1：无数组索引形键 + stringify 往返
 const walk=o=>{if(o&&typeof o==='object'&&!Array.isArray(o))for(const k of Object.keys(o)){
   need(!/^\d+$/.test(k),'ARRAY_INDEX_LIKE_KEY:'+k);walk(o[k]);}else if(Array.isArray(o))o.forEach(walk);};
 walk(payload);checks.push('R26F1_NO_ARRAY_INDEX_LIKE_KEY');
 const raw=JSON.stringify(payload);ck('R26F1_ROUNDTRIP',JSON.stringify(JSON.parse(raw))===raw,'ROUNDTRIP');

 // 14) 有待定钉 → 只出 pending 版，S24 恒 null，绝不出定稿
 pendingKeys.sort((a,b)=>rosterKeys.indexOf(a)-rosterKeys.indexOf(b));
 const S24=pendingKeys.length?null:canonLF(payload);
 ck('PENDING_MUST_NOT_EMIT_FINAL',!(pendingKeys.length&&S24),'PENDING_MUST_NOT_EMIT_FINAL');
 const file=W.out_basename+(pendingKeys.length?'.pending.json':'.candidate.json');
 if(write)fs.writeFileSync(path.join(outDir,file),JSON.stringify(payload,null,2)+'\n');
 return {state:pendingKeys.length?'PENDING_PINS_LISTED':'PAYLOAD_FINAL',window:W.id,S24,
  written:write?file:null,
  pending_pins:pendingKeys,
  pending_pin_roster:ROSTER.map(p=>({pin:p.key,token:p.token,site:p.site})),
  pending_pin_roster_length:ROSTER.length,
  source_digest_replacements:Object.keys(map).length,
  checks_passed:checks.length,payload};
}

// ── 判别器（每条实测按预期失败；不失败或以错理由失败 → selftest 非零退出）────────────
function selftest(){
 const D=JSON.parse(fs.readFileSync(path.join(HERE,'decisions.final.json'),'utf8'));
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'s24-selftest-'));
 const clone=o=>JSON.parse(JSON.stringify(o));
 const R=build({windowId:'window12-root7',D,pending:true,outDir:tmp,write:true});
 need(R.state==='PENDING_PINS_LISTED','POSITIVE_CONTROL_NOT_PENDING');
 need(R.S24===null,'POSITIVE_CONTROL_EMITTED_S24');
 need(R.written==='Status24Payload.window12.pending.json','POSITIVE_CONTROL_WROTE_'+R.written);
 need(R.pending_pins.join(',')==='as_of,expires_at,runner_generation,credential_generation,session_generation,root_registration_body_digest',
      'POSITIVE_CONTROL_PIN_SET:'+R.pending_pins.join(','));
 // 全钉齐备 → 出定稿（合成值，非正式 S24）
 const synth={...D,as_of:'2026-09-13T06:00:00.000Z',expires_at:'2026-09-14T05:45:14Z',
  runner_generation:'runnergen_a256855f',credential_generation:'credgen_bac92a11',
  session_generation:'sessiongen_ffb02a90',
  root_registration_body_digest:'0'.repeat(64)};
 const F=build({windowId:'window12-root7',D:synth,pending:true,outDir:tmp,write:true});
 need(F.state==='PAYLOAD_FINAL'&&F.S24&&F.written==='Status24Payload.window12.candidate.json','POSITIVE_CONTROL_FINAL_'+F.state);

 const CASES=[
  {id:'NC1',why:'代际未参数化（仍 root6）',expect:/ROOT_GENERATION_DISAGREES_WITH_ACCEPTANCE/,
   run:()=>build({D,pending:true,windowPatch:{root_generation:WINDOWS['window11-root6'].root_generation}})},
  {id:'NC2',why:'控制器摘要仍 68133f2d（未换 F12 冻结点）',expect:/CONTROLLER_DIGEST_DISAGREES_WITH_ACCEPTANCE/,
   run:()=>build({D,pending:true,windowPatch:{controller_digest:WINDOWS['window11-root6'].controller_digest}})},
  {id:'NC3',why:'issuer 沿用旧 STATUS 件 1640995831（决策表 #17 未翻案）',expect:/STATUS_ISSUER_REF_NOT_THE_WINDOW_STATUS_QUALIFICATION/,
   run:()=>{const d=clone(D);delete d.source_ref_map['1640995831b0c1f8ae616810e12eb7b97ee191e9f20b5c38eee32eb8bfac9d23'];
            delete d.source_digest_map['1640995831b0c1f8ae616810e12eb7b97ee191e9f20b5c38eee32eb8bfac9d23'];
            return build({D:d,pending:true});}},
  {id:'NC4',why:'待定钉清单长度断言（仍按五项）',expect:/PENDING_PIN_ROSTER_LENGTH/,
   run:()=>build({D,pending:true,windowPatch:{pending_pin_count:5}})},
  {id:'NC5',why:'第六钉占位符与受理件不一致',expect:/PENDING_TOKEN_DISAGREES_WITH_ACCEPTANCE/,
   run:()=>{const saved=PIN_ROSTER[5].token;
            try{Object.defineProperty(PIN_ROSTER[5],'token',{value:'__PENDING_SOMETHING_ELSE__',configurable:true});
                return build({D,pending:true});}
            finally{Object.defineProperty(PIN_ROSTER[5],'token',{value:saved,configurable:true});}}},
  {id:'NC6',why:'供源摘要与实物字节不符',expect:/PROVENANCE_DIGEST_MISMATCH/,
   run:()=>{const d=clone(D);d.source_provenance['f'.repeat(64)]=V+'/status-manifest.root5.schema.json';return build({D:d,pending:true});}},
  {id:'NC7',why:':353 断链（authority 的 ref 映射被删）',expect:/STATUS_MISSING_SOURCE_REF/,
   run:()=>{const d=clone(D);delete d.source_ref_map['92186d46e92ee7d27427de813d14faeb1745fb3c1d08c6280ea86a84b258eff5'];
            delete d.source_digest_map['92186d46e92ee7d27427de813d14faeb1745fb3c1d08c6280ea86a84b258eff5'];
            return build({D:d,pending:true});}},
  {id:'NC8',why:'拿 window11(root6) 档跑已实化 F12 的树',expect:/LOCAL_SCHEMA_DIGEST_MISMATCH/,
   run:()=>build({windowId:'window11-root6',D,pending:true})},
  {id:'NC9',why:'缺钉且未给 --pending',expect:/MISSING_DECISION:root_registration_body_digest/,
   run:()=>build({D,pending:false})},
  {id:'NC10',why:'a93bfdda 的 predecessor 岗位被写错',expect:/REGISTRATION_PREDECESSOR_DIGEST_MISMATCH/,
   run:()=>{const d=clone(D);d.root_registration_predecessor.sha256='92186d46e92ee7d27427de813d14faeb1745fb3c1d08c6280ea86a84b258eff5';
            return build({D:d,pending:true});}},
  {id:'NC11',why:'R26-F1：载荷混入数组下标形键',expect:/ARRAY_INDEX_LIKE_KEY/,
   run:()=>build({D,pending:true,inject:p=>{p.observations['0']='x';}})},
  {id:'NC12',why:'附带 A 去重（stage_receipt_refs 6→5）',expect:/EXACT_STAGE_INPUTS_WOULD_FAIL/,
   run:()=>build({D,pending:true,inject:p=>{const s=p.observations.stage_receipt_refs;
            p.observations.stage_receipt_refs=s.filter((x,i)=>s.findIndex(y=>y.sha256===x.sha256)===i);}})},
 ];
 const report=[];
 for(const c of CASES){
  let err=null;try{c.run();}catch(e){err=e.message;}
  need(err,'DISCRIMINATOR_DID_NOT_FIRE:'+c.id+' ('+c.why+')');
  need(c.expect.test(err),'DISCRIMINATOR_FIRED_FOR_THE_WRONG_REASON:'+c.id+' expected '+c.expect+' got '+err);
  report.push({id:c.id,why:c.why,refused_with:err.length>120?err.slice(0,120)+'…':err});
 }
 fs.rmSync(tmp,{recursive:true,force:true});
 return {selftest:'SELFTEST_PASSED_NOT_A_SIGNING',window:'window12-root7',
  positive_controls:{pending:{state:R.state,pins:R.pending_pins,checks_passed:R.checks_passed},
   synthetic_final:{state:F.state,synthetic_S24:F.S24,note:'合成钉产物，不是正式 S24'}},
  discriminators:report,discriminator_count:report.length,tmp_dir_removed:true};
}

// ── CLI ───────────────────────────────────────────────────────────────────────────
const argv=process.argv.slice(2),arg=n=>argv.includes(n)?argv[argv.indexOf(n)+1]:null;
if(argv.includes('--selftest')){console.log(JSON.stringify(selftest(),null,2));}
else{
 const dPath=arg('--decisions');need(dPath,'--decisions required');
 const D=JSON.parse(fs.readFileSync(dPath,'utf8'));
 const windowId=arg('--window')??D.window??'window12-root7';
 const out=build({windowId,D,pending:argv.includes('--pending'),outDir:arg('--out')??HERE,write:true});
 delete out.payload;
 console.log(JSON.stringify(out,null,2));
}
