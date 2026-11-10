// Real default-branch source selection and existing C1 forward-epoch intake.
// No packet-provided source/window, new token, retry, trigger or budget pool.
import {createHash} from 'node:crypto';
import {WORKFLOW_PROFILES_MAX_BYTES} from './clued-workflow-profile.mjs';
export const R9_RUNTIME_CONFIG='scripts/ci/merge-admission-r9-source.json';
// The accepted Worker authenticates the revocable audit Binding and owns its
// gateway database identity. A public Supabase caller cannot invoke GW80.
const CLOCK_AUDIT_URL='https://clued.pixelgrav.com/v1/continuity/audit';
const hash=x=>createHash('sha256').update(x).digest('hex');
// RPC's plain token hash is itself a credential. Never publish it. This
// domain-separated pin cannot be submitted as p_token_hash to that RPC.
export const r9CredentialFingerprint=token=>hash('clued.r9-minimum-credential-pin/1\0'+token);
const blob=x=>createHash('sha1').update('blob '+Buffer.byteLength(x)+'\0').update(x).digest('hex');
const sha=x=>typeof x==='string'&&/^[a-f0-9]{40}$/.test(x);
const digest=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const safe=x=>typeof x==='string'&&/^[A-Za-z0-9_.\/-]+$/.test(x)&&!x.split('/').some(p=>!p||p==='.'||p==='..');
const iso=us=>{const x=BigInt(us);return new Date(Number(x/1000000n)*1000).toISOString().slice(0,19)+'.'+(x%1000000n).toString().padStart(6,'0')+'Z';};
const partial=reason=>({status:'PARTIAL',reason_code:reason,source_contract_raw:null,window:null,clock:null,
  source_authenticated:false,official_metric:false,t0:null});

export async function loadIndependentR9RuntimeInputs({request,budget,repository,env={},workspace,fetchImpl=fetch}={}){
  let stage='INDEPENDENT_MAIN_SOURCE_UNAVAILABLE';
  try {
    if(typeof request!=='function'||!budget||budget.source!=='app'||! /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))return partial(stage);
    const get=async route=>{const r=await request(route);if(!r.ok)throw Error();return r.body;};
    const meta=await get(`/repos/${repository}`);if(meta.full_name!==repository||!safe(meta.default_branch)||meta.default_branch.includes('/'))throw Error();
    const ref=await get(`/repos/${repository}/git/ref/heads/${meta.default_branch}`);if(ref.object?.type!=='commit'||!sha(ref.object.sha))throw Error();
    const subject=ref.object.sha,tree=await get(`/repos/${repository}/git/trees/${subject}?recursive=1`);
    if(tree.truncated!==false||!Array.isArray(tree.tree)||new Set(tree.tree.map(x=>x.path)).size!==tree.tree.length)throw Error();
    const files=new Map(tree.tree.map(x=>[x.path,x]));
    const read=async file=>{const f=files.get(file);if(!safe(file)||f?.type!=='blob'||f.mode!=='100644'||!sha(f.sha))throw Error();
      const r=await get(`/repos/${repository}/git/blobs/${f.sha}`);if(r.sha!==f.sha||r.encoding!=='base64'||!Number.isSafeInteger(r.size)||r.size>(file==='scripts/ci/clued-gated-proof-profiles.json'?WORKFLOW_PROFILES_MAX_BYTES:1024*1024))throw Error();
      const raw=Buffer.from(r.content,'base64'),text=raw.toString();if(raw.length!==r.size||!Buffer.from(text).equals(raw)||blob(text)!==f.sha)throw Error();return text;};
    stage='INDEPENDENT_R9_SOURCE_CONFIG_NOT_INSTALLED';const cfg=JSON.parse(await read(R9_RUNTIME_CONFIG));
    stage='INDEPENDENT_R9_SOURCE_CONFIG_INVALID';
    if(cfg.schema!=='clued.r9-runtime-source-selection/1'||cfg.repository!==repository||!uuid(cfg.scope?.project_id)||
      cfg.scope.queue_ref!==`merge:${repository.toLowerCase()}:${meta.default_branch}`||cfg.admission_source?.grammar!=='clued.work-admission.evaluate-observation/1')throw Error();
    const s=cfg.admission_source,source={...s,source_checkout_sha:subject,default_branch:meta.default_branch};
    const admissionTexts={};for(const k of ['script','workflow','reverify_workflow','policy']){
      admissionTexts[k]=await read(s[k+'_path']);if(blob(admissionTexts[k])!==s[k+'_blob'])throw Error();}
    const admissionBytes={texts:admissionTexts,...Object.fromEntries(['script','workflow','reverify_workflow','policy'].map(k=>[k+'_blob',s[k+'_blob']]))};
    const profiles=await read('scripts/ci/clued-gated-proof-profiles.json'),roles=await read('scripts/ci/clued-gated-proof-role-specs.json');
    if(hash(profiles)!==cfg.execution_source?.profiles_sha256||hash(roles)!==cfg.execution_source?.role_specs_sha256)throw Error();
    const hasExecutionHistory=Object.hasOwn(cfg,'previous_execution_sources'),previousExecutionSources=cfg.previous_execution_sources;
    if(hasExecutionHistory){
      if(!Array.isArray(previousExecutionSources)||previousExecutionSources.length>4)throw Error();
      const checkouts=new Set([subject]),pairs=new Set([cfg.execution_source.profiles_sha256+':'+cfg.execution_source.role_specs_sha256]);
      for(const s of previousExecutionSources){
        if(s===null||typeof s!=='object'||Array.isArray(s)||Object.keys(s).length!==3||
          !['source_checkout_sha','profiles_sha256','role_specs_sha256'].every(k=>Object.hasOwn(s,k))||
          !sha(s.source_checkout_sha)||!digest(s.profiles_sha256)||!digest(s.role_specs_sha256)||checkouts.has(s.source_checkout_sha)||pairs.has(s.profiles_sha256+':'+s.role_specs_sha256))throw Error();
        checkouts.add(s.source_checkout_sha);pairs.add(s.profiles_sha256+':'+s.role_specs_sha256);
      }
    }
    const currentExecutionSource=hasExecutionHistory?{source_checkout_sha:subject,profiles_sha256:cfg.execution_source.profiles_sha256,role_specs_sha256:cfg.execution_source.role_specs_sha256}:
      {source_checkout_sha:subject,...cfg.execution_source};
    const expected={schema:'clued.merge-admission-four-source-expectations/'+(hasExecutionHistory?'2':'1'),repository,scope:cfg.scope,
      admission_sources:[source,...(cfg.previous_admission_sources??[])],execution_source:currentExecutionSource,
      ...(hasExecutionHistory?{previous_execution_sources:previousExecutionSources}:{})};
    const naturalProducers=cfg.natural_producers??[];
    if(!Array.isArray(naturalProducers))throw Error();
    for(const d of naturalProducers)if(!safe(d.workflow_path)||files.get(d.workflow_path)?.sha!==d.workflow_blob||
      !Array.isArray(d.source_paths)||d.source_paths.some(p=>!safe(p)||files.get(p)?.type!=='blob'))throw Error();
    const naturalSelection={repository,head_sha:subject,default_branch:meta.default_branch,natural_producers:naturalProducers,profiles_raw:profiles,admission_source:s,
      workflow_blobs:Object.fromEntries([...files].filter(([p,v])=>p.startsWith('.github/workflows/')&&v.type==='blob').map(([p,v])=>[p,v.sha]))};
    if(hasExecutionHistory){
      naturalSelection.execution_source_templates=[currentExecutionSource,...previousExecutionSources];
      naturalSelection.current_execution_snapshot={source_checkout_sha:subject,proof_profiles_raw:profiles,role_specs_raw:roles,
        workflow_directory:[...files].filter(([p,v])=>p.startsWith('.github/workflows/')&&v.type==='blob').map(([path,v])=>({path,sha:v.sha,type:v.type,mode:v.mode})),
        main_history:{base_commit:subject,head_commit:subject,merge_base_commit:subject,status:'identical'}};
    }
    // Activation is a separately qualified real open, then a reviewed durable
    // pointer. The scheduled collector never creates/restarts it implicitly.
    const epoch=cfg.forward_epoch;
    if(!epoch)return {...partial('FORWARD_EPOCH_NOT_ESTABLISHED'),reviewed_expected_sources_raw:JSON.stringify(expected),source_checkout_sha:subject,natural_selection:naturalSelection};
    if(!uuid(epoch.epoch_id)||!uuid(epoch.activation_receipt_id)||!epoch.pins||epoch.pins.epoch_id!==epoch.epoch_id||
      !digest(cfg.clock?.foundation_digest)||!digest(cfg.clock?.catalog_digest)||!digest(cfg.clock?.transport_definition_digest))throw Error();
    if(!(env.CLUED_CONTEXT_READ_TOKEN??'').trim())return partial('EXISTING_MINIMAL_CLOCK_CREDENTIAL_NOT_CONFIGURED');
    if(!digest(cfg.minimum_clock_binding?.credential_fingerprint)||!digest(cfg.minimum_clock_binding?.binding_scope_fingerprint)||
      !Number.isSafeInteger(cfg.minimum_clock_binding?.contributor_count)||cfg.minimum_clock_binding.contributor_count<1)
      return partial('ACCEPTED_MINIMAL_CLOCK_BINDING_NOT_INSTALLED');
    if(r9CredentialFingerprint(env.CLUED_CONTEXT_READ_TOKEN)!==cfg.minimum_clock_binding.credential_fingerprint)return partial('CLOCK_CREDENTIAL_IS_NOT_THE_ACCEPTED_MINIMAL_BINDING');
    stage='CLOCK_TYPED_TRANSPORT_UNAVAILABLE';
    const rpc=async measurement=>{
      if(budget.stopped||budget.deadline!==null&&budget.clock()>=budget.deadline)throw Error();
      const timeout=budget.deadline===null?10000:Math.max(1,Math.min(10000,Math.floor(budget.deadline-budget.clock())));
      const response=await fetchImpl(CLOCK_AUDIT_URL,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeout),
        headers:{authorization:`Bearer ${env.CLUED_CONTEXT_READ_TOKEN}`,'content-type':'application/json'},
        body:JSON.stringify({context_key:'project:'+cfg.scope.project_id,measurement})});
      if(!response.ok)throw Error();const r=await response.json(),a=r.server_auth;
      if(r.status!=='ok'||a?.schema!=='clued.clock-audit-transport-auth/1'||a.status!=='AUTHENTICATED_TARGET_READ'||
        a.context_key!=='project:'+cfg.scope.project_id||a.queue_ref!==cfg.scope.queue_ref||a.transport_definition_digest!==cfg.clock.transport_definition_digest||
        a.binding_scope_fingerprint!==cfg.minimum_clock_binding.binding_scope_fingerprint||a.contributor_count!==cfg.minimum_clock_binding.contributor_count)throw Error();return r;};
    const sealed=await rpc({operation:'clock_seal',queue_ref:cfg.scope.queue_ref,epoch_id:epoch.epoch_id,pins:epoch.pins});
    if(sealed.operation!=='clock_seal'||sealed.pins?.epoch_id!==epoch.epoch_id||!sealed.seal_pins||!uuid(sealed.measurement?.seal_id))throw Error();
    const transport=[],pages=[];let after=0;
    for(let page=0;page<20;page++){
      const r=await rpc({operation:'clock_page',queue_ref:cfg.scope.queue_ref,seal_id:sealed.measurement.seal_id,pins:epoch.pins,
        seal_pins:sealed.seal_pins,after_sequence:after,limit:500});const p=r.measurement;
      if(r.operation!=='clock_page'||p?.status!=='ok'||p.epoch?.epoch_id!==epoch.epoch_id||p.epoch.queue_ref!==cfg.scope.queue_ref||
        p.after_sequence!==after||p.epoch.opening_us!==epoch.opening_us||p.seal?.closing_us!==sealed.seal_pins.closing_us)throw Error();
      pages.push(p);transport.push(r);if(!p.has_more)break;if(!Number.isSafeInteger(p.next_sequence)||p.next_sequence<=after||page===19)throw Error();after=p.next_sequence;
    }
    const window={start:iso(epoch.opening_us),end:iso(sealed.seal_pins.closing_us)};
    if(Date.parse(window.end)<=Date.parse(window.start))throw Error();
    const contract={schema:'clued.merge-admission-r9-source-contract/1',repository,scope:cfg.scope,window,four_expected_sources_raw:JSON.stringify(expected),clock:cfg.clock};
    return {status:'R9_RUNTIME_INPUT_CANDIDATE',source_contract_raw:JSON.stringify(contract),window,
      // Owner Decision e18b9f8f sets the successor observation to 24 hours.
      // Epoch coverage remains diagnostic; this return never starts formal T0.
      forward_epoch:{epoch_id:epoch.epoch_id,activation_receipt_id:epoch.activation_receipt_id,required_continuous_hours:24,
        observed_hours:(Date.parse(window.end)-Date.parse(window.start))/3600000},
      clock:{pages_raw:JSON.stringify(pages),transport_raw:JSON.stringify(transport),options_raw:JSON.stringify({queueRef:cfg.scope.queue_ref,
        expectedFoundationDigest:cfg.clock.foundation_digest,expectedCatalogDigest:cfg.clock.catalog_digest})},
      operation_coverage:cfg.operation_coverage??null,admission_source_bytes:{[subject]:admissionBytes},source_checkout_sha:subject,natural_selection:naturalSelection,proof_profiles_raw:profiles,role_specs_raw:roles,
      execution_workflow_blobs:Object.fromEntries([...files].filter(([p,v])=>p.startsWith('.github/workflows/')&&v.type==='blob').map(([p,v])=>[p,v.sha])),
      source_authenticated:false,official_metric:false,t0:null};
  }catch{return partial(stage);}
}
