/* Captured Host-only coordinator: no Node import or CLI authority. */
globalThis.RootOwnedSupervisor216=(()=>{
 const need=(v,c)=>{if(v!==true)throw Error(c)},clone=v=>JSON.parse(JSON.stringify(v));
 const keys=(v,k)=>need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...k].sort().join('|'),'SUPERVISOR_CLOSED_FIELDS');
 const hash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
 function create(tools,captured){
  const B=globalThis.RootMcpBridge181,N=globalThis.RootNodeAuthority212;
  need(B&&N&&captured?.owner_packet!=null,'ACTUAL_SOURCE_OWNER_CI_PRIVATE_CAPTURE_REQUIRED');
  const gate=B.createHostGate(tools,captured),c=clone(captured),owner=B.validateAcceptance(c.owner_packet);
  need(owner.phase==='STANDARD_RUNNER_SELF_QUALIFICATION_ONCE','QUALIFICATION_OWNER_PHASE_ONLY214');
  need(c.source_record?.id===owner.source_acceptance_ref&&hash(c.source_record.body_sha256),'ACTUAL_SOURCE_CAPTURE_REQUIRED');
  need(hash(c.expected_parent_package_sha256)&&c.local_capture?.parent_package_sha256===c.expected_parent_package_sha256&&c.local_capture?.packet_sha256===owner.packet_sha256&&c.local_capture?.target_sid===c.target_sid&&hash(c.accepted_child_bootstraps?.observer)&&hash(c.accepted_child_bootstraps?.relay),'EXACT_ACCEPTED_PARENT_PACKAGE_REQUIRED');
  let selectorPublished=false;let sid=null,closed=false,failure=null,sendSeq=0,eventSeq=0,rpcSeq=0,binding=null,nodePeer=null,rootHello=null,parent=null,plan=null,planWrites=0,ready=null,phase='PREFLIGHT',final=null,proof=null,baSession=null,selfSession=null;
  const metas={},captures={},terminals={},pending=new Map(),waiters=new Set(),reader=B.createConsoleReader();let writes=Promise.resolve();
  const wake=()=>{for(const f of waiters)f();waiters.clear()};
  function stop(e){if(closed)return;closed=true;failure=e||Error('OWNED_SUPERVISOR_CLOSED');for(const p of pending.values())p.reject(failure);pending.clear();wake()}
  const asyncRun=fn=>{const p=Promise.resolve().then(fn);p.catch(stop);return p};
  async function wait(check,ms){const until=Date.now()+ms;while(!check()){if(closed)throw failure;need(Date.now()<until,'OWNED_SUPERVISOR_WAIT_BOUND');await new Promise(resolve=>{const f=()=>{clearTimeout(t);resolve()},t=setTimeout(()=>{waiters.delete(f);resolve()},100);waiters.add(f)})}}
  async function current(){const [a,r]=await Promise.all([gate(),tools.mcp__codex_apps__kooyumi_clued_record_list({level:'project',project_id:owner.scope.slice(8),record_type:'decision',limit:100})]);need(a.canonical_receipt_id===c.receipt_id&&r?.isError!==true&&Array.isArray(r?.structuredContent?.records),'CURRENT_SUPERVISOR_SOURCE_REQUIRED');const found=r.structuredContent.records.filter(x=>x.id===c.source_record.id);need(found.length===1,'EXACT_SOURCE_RECORD_REQUIRED');const s=found[0];need(s.version===c.source_record.version&&s.status==='active'&&s.record_type==='decision'&&s.authoritative===true&&s.record_currentness==='CURRENT'&&s.projection_currentness==='CURRENT'&&typeof s.body==='string'&&B.sha256(s.body)===c.source_record.body_sha256,'CURRENT_SUPERVISOR_SOURCE_DRIFT');return a}
  function write(kind,body){need(!closed&&Number.isSafeInteger(sid),'OWNED_CONSOLE_REQUIRED');const raw=JSON.stringify({schema:'clued.root-supervisor-command214/1',seq:++sendSeq,packet_sha256:owner.packet_sha256,kind,body});need(raw.length<=16384&&sendSeq<=2048,'CONSOLE_COMMAND_BOUND');const p=writes.then(async()=>{need(!closed,'OWNED_CONSOLE_CLOSED');const r=await tools.write_stdin({session_id:sid,chars:raw+'\n',yield_time_ms:1,max_output_tokens:20000});consume(r)});writes=p.catch(stop);return p}
  function child(role,value){need(['OBSERVER','RELAY'].includes(role),'FIXED_CHILD_ROLE');return write('CHILD_STDIN',{role,line:JSON.stringify(value)})}
  async function call(kind,body){const id=B.sha256(owner.attempt_id+':'+String(++rpcSeq)).slice(0,32);need(rpcSeq<=512,'OWNED_RPC_BOUND');const result=new Promise((resolve,reject)=>{const t=setTimeout(()=>{pending.delete(id);reject(Error('OWNED_RPC_TIMEOUT'))},20000);pending.set(id,{kind,resolve:v=>{clearTimeout(t);resolve(v)},reject:e=>{clearTimeout(t);reject(e)}})});if(kind==='READ_READY_AGE')await write(kind,{request_id:id});else await child('RELAY',{schema:'clued.root-owned-relay-command214/1',kind,request_id:id,body});return result}
  function done(id,kind,v){const p=pending.get(id);need(p&&p.kind===kind,'OWNED_RPC_CORRELATION');pending.delete(id);p.resolve(clone(v))}
  function meta(role,m){keys(m,['pid','start','image','packet_sha256']);need(!metas[role]&&Number.isSafeInteger(m.pid)&&m.pid>0&&typeof m.start==='string'&&/^[1-9][0-9]{0,18}$/.test(m.start)&&typeof m.image==='string'&&m.image.toLowerCase()==='c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe'&&m.packet_sha256===owner.packet_sha256,'ACTUAL_CHILD_META');metas[role]=clone(m);if(metas.OBSERVER&&metas.RELAY)need(metas.OBSERVER.pid!==metas.RELAY.pid,'BA_RELAY_DISTINCT')}
  function capture(role,v){const m=metas[role],p=role==='OBSERVER'?'ba':'relay';need(parent&&m&&!captures[role]&&v.host===c.binding.host&&v[p+'_pid']===m.pid&&v[p+'_start']===m.start&&v[p+'_sid']===parent.sid&&v[p+'_elevated']===1&&v.parent_pid===parent.pid&&v.authority_granted===false,'ACTUAL_CAPTURED_CHILD_CHAIN');if(role==='OBSERVER')need(v.source_capture_sha256===c.binding.observer_capture_sha256,'ACTUAL_BA_CAPTURE_SOURCE');captures[role]=clone(v);wake()}
  function validateProof(v){keys(v,['schema','status','entry_exit_code','native_exit_code','child_exit_code','proof_sha256','export_sha256']);need(v.schema==='clued.standard-runner-actor-native-proof/1'&&v.status==='INDEPENDENT_NATIVE_PROOF_VALIDATED'&&v.entry_exit_code===0&&v.native_exit_code===0&&v.child_exit_code===0&&hash(v.proof_sha256)&&hash(v.export_sha256),'ACTUAL_NATIVE_PROOF_REQUIRED')}
  async function authorizePlan(q){
   need(q.packet_sha256===owner.packet_sha256&&['NEW_CHILD_READ_ACCESS','NEW_CHILD_READ_ACCESS_WRITE'].includes(q.operation),'NEW_OBJECT_SCOPE');const p=q.plan;
   keys(p,['Schema','TargetSid','Parent','Observer','Relay','ProcessAddedMask','TokenAddedMask','BeforeAclSha256','ProposedAclSha256','ObserverBootstrapSha256','RelayBootstrapSha256','PlanSha256','FixtureOnly']);
   need(parent&&p.Schema==='clued.new-owned-child-read-access-plan181/1'&&p.TargetSid===c.target_sid&&p.ProcessAddedMask===0x101000&&p.TokenAddedMask===8&&p.FixtureOnly===false&&p.ObserverBootstrapSha256===c.accepted_child_bootstraps.observer&&p.RelayBootstrapSha256===c.accepted_child_bootstraps.relay,'EXACT_FOUR_NEW_OBJECT_READ_SCOPE');
   for(const n of ['Parent','Observer','Relay']){const i=p[n];keys(i,['Pid','ParentPid','Sid','Elevated','CreationFileTime','Image','TokenId']);need(Number.isSafeInteger(i.Pid)&&i.Pid>0&&i.Sid===parent.sid&&i.Elevated===1&&typeof i.CreationFileTime==='string'&&typeof i.Image==='string'&&i.Image.toLowerCase()===parent.image.toLowerCase()&&typeof i.TokenId==='string'&&/^[a-f0-9]{16}$/.test(i.TokenId),'ACTUAL_NEW_OBJECT_IDENTITY')}
   need(p.Parent.Pid===parent.pid&&p.Parent.CreationFileTime===parent.start&&p.Observer.ParentPid===parent.pid&&p.Relay.ParentPid===parent.pid&&new Set([p.Parent.Pid,p.Observer.Pid,p.Relay.Pid]).size===3&&new Set([p.Parent.TokenId,p.Observer.TokenId,p.Relay.TokenId]).size===3,'DISTINCT_NEW_PROCESSES_TOKENS');
   for(const k of ['BeforeAclSha256','ProposedAclSha256'])need(Array.isArray(p[k])&&p[k].length===4&&p[k].every(hash),'FOUR_NEW_OBJECT_ACL_HASH_BOUND');
   need(p.PlanSha256===B.sha256([p.TargetSid,p.ObserverBootstrapSha256,p.RelayBootstrapSha256,p.Parent.Pid,p.Parent.CreationFileTime,p.Parent.TokenId,p.Observer.Pid,p.Observer.CreationFileTime,p.Observer.TokenId,p.Relay.Pid,p.Relay.CreationFileTime,p.Relay.TokenId,...p.BeforeAclSha256,...p.ProposedAclSha256].join('|')),'NEW_OBJECT_PLAN_DIGEST');
   if(q.operation==='NEW_CHILD_READ_ACCESS'){need(plan===null,'NEW_OBJECT_PLAN_ONCE');plan=clone(p)}else need(plan!==null&&JSON.stringify(plan)===JSON.stringify(p)&&++planWrites<=5,'NEW_OBJECT_WRITE_SCOPE');
   await current();return {status:'CURRENT',packet_sha256:owner.packet_sha256};
  }
  function onChild(f){keys(f,['role','kind','body']);need(['OBSERVER','RELAY'].includes(f.role),'FIXED_OWNED_CHILD');if(f.kind==='META'){meta(f.role,f.body);return}
   if(f.kind==='TERMINAL'){keys(f.body,['exit_code','stdout_eof','stderr_eof','stderr_bytes','stderr_sha256']);need(!terminals[f.role]&&Number.isInteger(f.body.exit_code)&&f.body.stdout_eof===true&&f.body.stderr_eof===true&&Number.isSafeInteger(f.body.stderr_bytes)&&hash(f.body.stderr_sha256),'ACTUAL_CHILD_TERMINAL');terminals[f.role]=clone(f.body);need(f.body.exit_code===0,'OWNED_CHILD_NONZERO');wake();return}
   need(f.kind==='STDOUT','OWNED_CHILD_FRAME_KIND');keys(f.body,['line']);const v=B.strictJson(f.body.line);
   if(v.schema==='clued.root-owned-ba-capture-ready181/1'||v.schema==='clued.root-owned-relay-capture-ready181/1'){capture(f.role,v);return}
   if(f.role==='OBSERVER'&&v.schema==='clued.windows-self-entry-ready181/1'){
    keys(v,['schema','role','host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','predecessor_r9_index_sha256','request_sha256','source_capture_sha256','phase']);need(binding&&!ready&&v.role==='BA_OBSERVER'&&v.phase==='FACTORY_PREFLIGHT_READY_WAITING_SELF_REGISTERED','ACTUAL_BA_READY_ONCE');for(const k of ['host','node_id','attempt_id','accepted_subject_sha256','owner_receipt_id','predecessor_r9_index_sha256','request_sha256'])need(v[k]===binding[k],'BA_READY_BINDING');need(v.source_capture_sha256===binding.observer_capture_sha256,'BA_READY_SOURCE');ready=clone(v);phase='WAITING_SELF_REGISTERED';wake();return;
   }
   if(f.role==='OBSERVER'&&v.schema==='clued.root-owned-ba-phase181/1'){need(binding&&ready&&v.session_id===binding.session_id&&v.attempt_id===binding.attempt_id&&v.accepted_subject_sha256===binding.accepted_subject_sha256&&v.phase==='AWAITING_INSTANCE'&&['ORIGINAL_ACK_CALLBACK_RETURNED','BEFORE_NATIVE_RELEASE'].includes(v.source),'BA_REAL_ACK_PHASE');phase='AWAITING_INSTANCE';wake();return}
   if(f.role==='OBSERVER'&&v.schema==='clued.windows-self-observer-entry-result181/1'){need(!final&&v.status==='OBSERVER_COMPLETED_REVIEW_REQUIRED'&&v.exit_code===0&&v.installation===false&&v.automatic_retry===false,'BA_FINAL_NOT_PROOF');final=clone(v);wake();return}
   if(v.schema==='clued.root-owned-authority-request181/1'){
    const s=f.role==='OBSERVER'?baSession:selfSession;need(!!s,'AUTHORITY_BEFORE_BOUND');asyncRun(async()=>{const reply=await s.handle(f.body.line);await child(f.role,f.role==='OBSERVER'?reply:{schema:'clued.root-owned-relay-command214/1',kind:'SELF_REPLY',request_id:v.request_id,body:reply})});return;
   }
   if(f.role==='RELAY'&&v.schema==='clued.root-node-request212/1'){
    if(nodePeer)need(JSON.stringify(nodePeer)===JSON.stringify(v.actual_node),'NODE_PEER_DRIFT');else nodePeer=clone(v.actual_node);
    asyncRun(async()=>{const reply=await nodeAuthority.handle(v);await child('RELAY',{schema:'clued.root-owned-relay-command214/1',kind:'NODE_REPLY',request_id:B.strictJson(v.raw).request_id,body:reply})});return;
   }
   if(f.role==='RELAY'&&v.schema==='clued.root-owned-relay-result214/1'){keys(v,['schema','kind','request_id','value']);done(v.request_id,v.kind==='BOUND_SELF'?'BIND_SELF':v.kind,v.value);return}
   if(f.role==='RELAY'&&v.schema==='clued.root-owned-relay-listening181/1'){need(binding&&v.pid===binding.relay_pid&&v.session_id===binding.session_id&&v.attempt_id===binding.attempt_id&&v.packet_sha256===binding.packet_sha256&&v.authority_from_message===false,'ACTUAL_SELF_RELAY_LISTENING');return}
   if(f.role==='RELAY'&&v.schema==='clued.root-owned-relay-ingress-listening214/1'){need(v.session_id===c.binding.session_id&&v.host===c.binding.host&&v.attempt_id===c.binding.attempt_id&&v.packet_sha256===c.binding.packet_sha256&&v.pid===metas.RELAY.pid&&v.authority_from_message===false,'ACTUAL_NODE_INGRESS_LISTENING');return}
   if(f.role==='RELAY'&&v.schema==='clued.root-owned-node-peer214/1'){need(v.session_id===c.binding.session_id&&v.authority_from_message===false&&!nodePeer,'ACTUAL_NODE_PEER_ONCE');nodePeer=clone(v.actual_node);return}
   if(f.role==='RELAY'&&v.schema==='clued.root-owned-self-eof214/1'){need(binding&&v.session_id===binding.session_id&&v.exit_code===0&&v.automatic_retry===false,'ACTUAL_SELF_EOF');return}
   if(f.role==='RELAY'&&v.schema==='clued.root-owned-relay-mux-complete214/1'){need(binding&&proof&&v.session_id===binding.session_id&&v.proof_reopened===true&&v.self_exit_code===0&&v.automatic_retry===false,'ACTUAL_MUX_COMPLETE_AFTER_PROOF');return}
   throw Error('UNEXPECTED_OWNED_CHILD_EVENT');
  }
  function consume(r){need(r&&typeof r.output==='string'&&(r.session_id===undefined||r.session_id===sid),'OWNED_CONSOLE_SESSION_DRIFT');for(const f of reader.push(r.output)){const e=f.value;keys(e,['schema','seq','kind','body']);need(e.schema==='clued.root-supervisor-event214/1'&&e.seq===++eventSeq,'ROOT_CONSOLE_SEQUENCE');
   if(e.kind==='READY'){need(!rootHello&&e.body.sid===c.local_capture.owner_sid&&e.body.packet_sha256===owner.packet_sha256&&e.body.elevated===0,'ACTUAL_ROOT_HELLO');rootHello=clone(e.body);wake()}
   else if(e.kind==='PARENT_HELD'){need(!parent&&rootHello&&e.body.sid===rootHello.sid&&e.body.elevated===1&&e.body.pid!==rootHello.pid,'ACTUAL_PARENT_HELD');parent=clone(e.body);wake()}
   else if(e.kind==='PARENT_AUTH')asyncRun(async()=>{const q=e.body;keys(q,['request_id','operation','packet_sha256','plan']);need(q.packet_sha256===owner.packet_sha256,'PARENT_AUTH_PACKET');let value;if(q.operation==='START_PARENT'||q.operation==='START_PAIR'){await current();value={status:'CURRENT',packet_sha256:owner.packet_sha256}}else value=await authorizePlan(q);await write('AUTHORIZATION',{request_id:q.request_id,value})});
   else if(e.kind==='CHILD_FRAME')onChild(e.body);
   else if(e.kind==='READY_AGE'){keys(e.body,['request_id','age_ms']);need(Number.isSafeInteger(e.body.age_ms)&&e.body.age_ms>=0&&e.body.age_ms<120000,'ACTUAL_MONOTONIC_READY_AGE');done(e.body.request_id,'READ_READY_AGE',e.body.age_ms)}
   else if(e.kind==='TERMINAL'){need(e.body.parent_exit_code===0,'ACTUAL_PARENT_EXIT');closed=true;wake()}
   else throw Error('ROOT_SUPERVISOR_REFUSED');
  }if(r.exit_code!==undefined){reader.finish();need(r.exit_code===0,'OWNED_CONSOLE_NONZERO');closed=true;wake()}}
  const owned=Object.freeze({
   async bindAndStartObserver(m){
    need(binding===null&&nodePeer!==null&&captures.OBSERVER!==undefined&&captures.RELAY!==undefined,'ACTUAL_PAIR_AND_NODE_BEFORE_BIND');
    // NodeHost's authenticated handler has just refreshed currentness. The
    // original BA VerifyLive below refreshes its own exact-role authority.
    const actual=await call('INSPECT_SELF',{metadata:clone(m),actual_node:clone(nodePeer)});
    keys(actual,['schema','node_pid','node_start','node_sid','node_image','ps_pid','ps_start','ps_sid','ps_parent_pid']);need(actual.schema==='clued.root-owned-self-held214/1'&&actual.node_pid===nodePeer.node_pid&&actual.ps_pid===m.ps_pid&&actual.ps_parent_pid===nodePeer.node_pid&&actual.node_sid===c.target_sid&&actual.ps_sid===c.target_sid,'REOPENED_SELF_DISTINCT_BROKER');
    binding={...clone(c.binding),node_pid:actual.node_pid,node_start:actual.node_start,node_image:actual.node_image,ps_pid:actual.ps_pid,ps_start:actual.ps_start,ba_pid:captures.OBSERVER.ba_pid,ba_start:captures.OBSERVER.ba_start,ba_sid:captures.OBSERVER.ba_sid,relay_pid:captures.RELAY.relay_pid,relay_start:captures.RELAY.relay_start,relay_sid:captures.RELAY.relay_sid};
    baSession=B.createSession(binding,current,owned.readOwnedObserver,Date.now,'BA_OBSERVER');selfSession=B.createSession(binding,current,owned.readOwnedObserver,Date.now,'SELF_RELAY');
    const start=await call('BIND_SELF',clone(binding));keys(start,['attempt_id','node_pid','node_start','node_image','relay_pid','relay_start','relay_sid']);for(const k of Object.keys(start))need(start[k]===binding[k],'EXACT_SELF_START');
    await child('OBSERVER',{schema:'clued.root-owned-ba-observer-start181/1',binding});await wait(()=>ready!==null,120000);return clone(start);
   },
   async readOwnedObserver(){need(!closed,'OWNED_OBSERVER_CHANNEL_CLOSED');if(!ready)return {ready:null,observer_phase:'PREFLIGHT',ready_age_ms:null};need(!terminals.OBSERVER&&!final,'OWNED_OBSERVER_TERMINAL');const age=await call('READ_READY_AGE',{});return {ready:clone(ready),observer_phase:phase,ready_age_ms:age}},
   async proofStatus(){if(!final||!terminals.OBSERVER)return {status:'PENDING_NATIVE_PROOF'};need(binding&&terminals.OBSERVER.exit_code===0,'ACTUAL_BA_TERMINAL_REQUIRED');const v=await call('REOPEN_PROOF',{binding:clone(binding),mode:'STATUS'});if(v.status==='PENDING_NATIVE_PROOF')return v;validateProof(v);proof=clone(v);return clone(v)},
   async reopenProof(q){need(proof!==null&&binding!==null,'REOPEN_ONLY_AFTER_ACTUAL_PROOF');const v=await call('REOPEN_PROOF',{binding:clone(binding),mode:'REOPEN'});validateProof(v);need(v.proof_sha256===proof.proof_sha256&&v.export_sha256===proof.export_sha256&&q.outcome.proof_sha256===v.proof_sha256&&q.outcome.export_sha256===v.export_sha256,'ORIGINAL_PROOF_BYTES_CHANGED');return {status:'EXACT_NATIVE_PROOF_REOPENED',proof_sha256:v.proof_sha256,export_sha256:v.export_sha256}}
  });
  const nodeAuthority=N.create(tools,captured,owned);
  async function pump(){try{while(!closed){const poll=writes.then(async()=>{if(closed)return;const r=await tools.write_stdin({session_id:sid,chars:'',yield_time_ms:1000,max_output_tokens:20000});consume(r)});writes=poll.catch(stop);await poll}}catch(e){stop(e)}}
  return Object.freeze({owned,
   async start(){need(sid===null,'ROOT_CONTROLLER_START_ONCE');await current();need(c.host_launch?.tty===true&&c.host_launch?.max_output_tokens===20000&&typeof c.host_launch?.cmd==='string'&&c.host_launch.cmd.length<=65536,'EXACT_CAPTURED_HOST_LAUNCH_REQUIRED');const r=await tools.exec_command(clone(c.host_launch));need(Number.isSafeInteger(r.session_id)&&r.session_id>0,'ACTUAL_OWNED_CONSOLE_SESSION');sid=r.session_id;consume(r);asyncRun(pump);await wait(()=>captures.OBSERVER&&captures.RELAY,120000);
    await current();const selector={schema:'clued.node-ingress-selector212/1',attempt_id:owner.attempt_id,root_pid:captures.RELAY.relay_pid,root_start:captures.RELAY.relay_start,root_sid:captures.RELAY.relay_sid,packet_sha256:owner.packet_sha256,owner_receipt_id:c.receipt_id,source_acceptance_ref:owner.source_acceptance_ref};
    const published=await call('PUBLISH_SELECTOR',selector);keys(published,['status','path','payload_sha256','directory_created','file_created','parent_acl_changed','automatic_retry','execution_authority']);
    need(published.status==='CREATED_PUBLIC_ROOT_LOCATOR_NOT_AUTHORITY'&&published.path==='C:\\ProgramData\\CluedIndependentCI\\standard-runner-actor\\root-node-selector212.json'&&hash(published.payload_sha256)&&published.directory_created===true&&published.file_created===true&&published.parent_acl_changed===false&&published.automatic_retry===false&&published.execution_authority===false,'ACTUAL_SELECTOR_PUBLICATION_NOT_PROVEN');selectorPublished=true;
    return {status:'OWNED_PAIR_SELECTOR_PUBLISHED_NOT_QUALIFICATION',observer_pid:metas.OBSERVER.pid,relay_pid:metas.RELAY.pid,selector_published:true}},
   async getOwnedSelector(){
    need(captures.RELAY!==undefined,'ACTUAL_RELAY_CAPTURE_BEFORE_PUBLIC_LOCATOR');await current();
    return {schema:'clued.node-ingress-selector212/1',attempt_id:owner.attempt_id,root_pid:captures.RELAY.relay_pid,root_start:captures.RELAY.relay_start,root_sid:captures.RELAY.relay_sid,packet_sha256:owner.packet_sha256,owner_receipt_id:c.receipt_id,source_acceptance_ref:owner.source_acceptance_ref};
   },
   async runUntilComplete(){
    need(sid!==null,'START_OWNED_SUPERVISOR_FIRST');
    // Keep this promise awaited in the same functions.exec lifetime. Genuine
    // CI WeakMap/owned callbacks cannot survive a serialized store/load cycle.
    await wait(()=>closed,360000);if(failure)throw failure;
    need(selectorPublished&&proof!==null&&terminals.OBSERVER?.exit_code===0&&terminals.RELAY?.exit_code===0,'TERMINAL_WITHOUT_ACTUAL_REOPENED_EVIDENCE');
    return {status:'ROOT_OWNED_ATTEMPT_TERMINAL_EVIDENCE_REOPENED',proof_sha256:proof.proof_sha256,export_sha256:proof.export_sha256,qualification:false,installation:false,automatic_retry:false};
   },
   snapshot(){return {closed,started:sid!==null,selector_published:selectorPublished,bound:binding!==null,node_peer:nodePeer!==null,observer_capture:!!captures.OBSERVER,relay_capture:!!captures.RELAY,actual_ba_ready:ready!==null,actual_ba_terminal:!!terminals.OBSERVER,proof_reopened:proof!==null,qualification:false}},
   close(){stop(Error('ROOT_OWNER_CLOSED_NO_RETRY'))}
  });
 }
 return Object.freeze({create});
})();
