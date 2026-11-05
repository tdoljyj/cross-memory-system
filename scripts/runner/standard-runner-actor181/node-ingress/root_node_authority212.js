/* Host-only captured library. It uses the existing original CI WeakMap and
 * actual Root MCP verifier; Node cannot call this factory or pass tools/code. */
globalThis.RootNodeAuthority212=(()=>{
 const OPS=['Open','AcceptedSource','BindInvocation','Current','ObserverReady','BindCapturedSelf','ObserverPhase','LaunchReady','ProofStatus','ReopenProof'];
 const must=(v,c)=>{if(v!==true)throw Error(c)},copy=v=>JSON.parse(JSON.stringify(v));
 const exact=(v,k)=>must(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...k].sort().join('|'),'NODE_CLOSED_FIELDS');
 const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
 const QUALIFICATION_PURPOSE='standard_runner_self_s4u_qualification_once';
 const PURPOSE_PHASE=Object.freeze({standard_runner_self_s4u_qualification_once:'STANDARD_RUNNER_SELF_QUALIFICATION_ONCE'});
 function selectOwnRow(c){
  must(Array.isArray(c.accepted_rows)&&c.accepted_rows.length>0&&c.accepted_rows.length<=128,'ACCEPTED_ROWS_BOUND');
  const rows=c.accepted_rows.filter(r=>r.job===c.expected_context?.job&&r.sid===c.target_sid&&r.host===c.binding?.host);
  must(rows.length===1,'EXACT_CURRENT_JOB_SID_HOST_ROW');return copy(rows[0]);
 }
 function create(tools,captured,owned){
  const bridge=globalThis.RootMcpBridge181;must(bridge&&typeof bridge.createHostGate==='function','EXACT_ORIGINAL_ROOT_BRIDGE_REQUIRED');
  must(captured?.owner_packet!=null,'PHYSICAL_OWNER_PACKET_MISSING_NO_LAUNCH');
  // createHostGate accepts only its genuine CI-origin WeakMap handle and checks
  // actual canonical Owner/current claim/integration/epoch via original tools.
  const owner=bridge.validateAcceptance(captured.owner_packet),c=copy(captured);
  must(c.accepted_source_observation?.purpose===QUALIFICATION_PURPOSE&&owner.phase===PURPOSE_PHASE[QUALIFICATION_PURPOSE],'QUALIFICATION_PURPOSE_OWNER_PHASE_REQUIRED');
  const gate=bridge.createHostGate(tools,captured);
  must(Array.isArray(c.accepted_rows)&&c.accepted_rows.length>0&&c.accepted_rows.length<=128&&c.accepted_source_observation?.source_acceptance_ref===owner.source_acceptance_ref,'EXACT_ACCEPTED_SOURCE_ROWS_REQUIRED');
  must(UUID.test(c.source_record?.id)&&c.source_record.id===owner.source_acceptance_ref&&Number.isSafeInteger(c.source_record.version)&&c.source_record.version>0&&/^[a-f0-9]{64}$/.test(c.source_record.body_sha256),'ACTUAL_SOURCE_ACCEPTANCE_CAPTURE_REQUIRED');
  must(owned&&typeof owned.bindAndStartObserver==='function'&&typeof owned.readOwnedObserver==='function'&&typeof owned.proofStatus==='function'&&typeof owned.reopenProof==='function','ACTUAL_ROOT_OWNED_SUPERVISOR_REQUIRED');
  const selectedRow=selectOwnRow(c);
  let seq=0,closed=false,opened=false,actualNode=null,boundSelf=null,nativeBinding=null,launch=false,busy=false;
  async function current(){const [auth,records]=await Promise.all([gate(),tools.mcp__codex_apps__kooyumi_clued_record_list({level:'project',project_id:owner.scope.slice(8),record_type:'decision',limit:100})]);must(auth.canonical_receipt_id===c.receipt_id,'CURRENT_RECEIPT_BINDING');const rs=records?.structuredContent?.records;must(records?.isError!==true&&Array.isArray(rs),'SOURCE_CANONICAL_CURRENT_REQUIRED');const hits=rs.filter(r=>r.id===c.source_record.id);must(hits.length===1,'SOURCE_ACCEPTANCE_MISSING');const r=hits[0];must(r.version===c.source_record.version&&r.record_type==='decision'&&r.status==='active'&&r.authoritative===true&&r.record_currentness==='CURRENT'&&r.projection_currentness==='CURRENT'&&typeof r.body==='string'&&bridge.sha256(r.body)===c.source_record.body_sha256,'SOURCE_ACCEPTANCE_NOT_CURRENT');}
  function target(q){if(q.context!==undefined)must(same(q.context,c.expected_context),'NODE_CONTEXT_NOT_ORIGINAL_RUN');if(q.row!==undefined)must(same(q.row,selectedRow),'NODE_ROW_NOT_CURRENT_JOB');if(q.binding!==undefined&&q.binding!==null)must(nativeBinding!==null&&same(q.binding,nativeBinding),'NODE_BINDING_DRIFT');}
  async function handle(frame){
   try{
    must(!closed&&!busy,'NODE_CLOSED_OR_CONCURRENT');busy=true;exact(frame,['schema','raw','actual_node']);must(frame.schema==='clued.root-node-request212/1'&&typeof frame.raw==='string'&&frame.raw.length<=4096,'NODE_KERNEL_FRAME');
    const q=bridge.strictJson(frame.raw);exact(q,['schema','seq','request_id','operation','body']);must(q.schema==='clued.node-ingress-request212/1'&&q.seq===++seq&&seq<=1024&&typeof q.request_id==='string'&&/^[a-f0-9]{32}$/.test(q.request_id)&&OPS.includes(q.operation),'NODE_SEQUENCE_OR_DOMAIN');
    const peer=frame.actual_node;exact(peer,['broker_pid','broker_start','node_pid','node_start','node_sid','node_image']);must(Number.isSafeInteger(peer.broker_pid)&&Number.isSafeInteger(peer.node_pid)&&peer.broker_pid!==peer.node_pid&&peer.node_sid===c.target_sid&&typeof peer.node_start==='string'&&typeof peer.broker_start==='string','NODE_KERNEL_PEER_TARGET');
    if(actualNode)must(same(peer,actualNode),'NODE_KERNEL_PEER_CHANGED');else actualNode=copy(peer);
    let value;const b=q.body;must(b&&typeof b==='object'&&!Array.isArray(b),'NODE_BODY');
    if(q.operation==='ProofStatus'){
     must(opened&&launch&&boundSelf!==null,'NODE_PROOF_BEFORE_OWNED_START');target(b);value=await owned.proofStatus();
     if(value?.status!=='PENDING_NATIVE_PROOF'){await current();exact(value,['schema','status','entry_exit_code','native_exit_code','child_exit_code','proof_sha256','export_sha256']);must(value.status==='INDEPENDENT_NATIVE_PROOF_VALIDATED'&&value.entry_exit_code===0&&value.native_exit_code===0&&value.child_exit_code===0,'NO_QUALIFICATION_FROM_PARTIAL_SUCCESS');}
     else exact(value,['status']);
    }else{
     await current();
     if(q.operation==='Open'){
      must(!opened,'NODE_OPEN_ONCE');exact(b,['selector','actual_node','broker']);const s=b.selector;must(s.packet_sha256===owner.packet_sha256&&s.owner_receipt_id===c.receipt_id&&s.source_acceptance_ref===owner.source_acceptance_ref&&s.attempt_id===owner.attempt_id&&b.actual_node.pid===peer.node_pid&&b.actual_node.start===peer.node_start&&b.actual_node.sid===peer.node_sid&&b.broker.pid===peer.broker_pid&&b.broker.start===peer.broker_start,'NODE_OPEN_INDEPENDENT_HELD_BINDING');opened=true;value={status:'EXACT_SOURCE_OWNER_CI_CURRENT',packet_sha256:owner.packet_sha256,owner_receipt_id:c.receipt_id,source_acceptance_ref:owner.source_acceptance_ref,accepted_rows:[copy(selectedRow)]};
     }else{
      must(opened,'NODE_NOT_OPEN');target(b);
      if(q.operation==='AcceptedSource'){must(b.role===c.accepted_source_observation.role&&b.purpose===c.accepted_source_observation.purpose,'NODE_EXACT_ROLE_PURPOSE');value=copy(c.accepted_source_observation)}
      else if(q.operation==='BindInvocation'){
       must(nativeBinding===null,'NODE_BIND_ONCE');must(same(b.row,selectedRow),'NODE_ROW');const t=Date.now();nativeBinding={schema:'clued.standard-runner-actor-native-binding/1',role:c.accepted_source_observation.role,purpose:c.accepted_source_observation.purpose,binding_ref:c.holder_binding_id,context_sha256:c.context_sha256,claim_id:c.claim_id,fence:c.fence,execution_epoch:c.execution_epoch,owner_receipt_id:c.receipt_id,source_acceptance_ref:owner.source_acceptance_ref,accepted_actor_packet_sha256:owner.packet_sha256,attempt_id:owner.attempt_id,issued_at:new Date(t).toISOString(),expires_at:new Date(Math.min(t+300000,Date.parse(c.claim_expires_at))).toISOString(),node_id:b.row.node_id,runner_id:b.row.runner_id,runner_name:b.row.runner_name,request_sha256:b.row.request_sha256,predecessor_sha256:b.row.predecessor_sha256,tool_pins:copy(c.tool_pins)};value=copy(nativeBinding);
      }else if(q.operation==='Current'){must(nativeBinding!==null&&Date.parse(nativeBinding.expires_at)>Date.now()&&typeof b.phase==='string'&&c.allowed_phases.includes(b.phase),'NODE_CURRENT_PHASE');value={status:'CURRENT',binding_ref:nativeBinding.binding_ref,fence:c.fence,execution_epoch:c.execution_epoch,phase:b.phase}}
      else if(q.operation==='BindCapturedSelf'){
       must(boundSelf===null&&nativeBinding!==null,'NODE_SELF_BIND_ONCE');exact(b.metadata,['schema','host','ps_pid','ps_start','ps_parent_pid','ps_sid','ps_elevated','node_pid','node_start','node_sid','node_elevated','node_image','source_captured','authority_granted','runner_name']);const m=b.metadata;must(m.node_pid===peer.node_pid&&m.node_start===peer.node_start&&m.ps_parent_pid===peer.node_pid&&m.ps_pid!==peer.broker_pid&&m.node_sid===peer.node_sid&&m.ps_sid===peer.node_sid&&m.node_elevated===0&&m.ps_elevated===0&&m.authority_granted===false&&m.source_captured===true,'NODE_ACTUAL_SELF_DISTINCT_FROM_BROKER');
       // owned supervisor independently reopens this PS PID/start and proves
       // actual kernel parent/SID before starting its separately held BA.
       value=await owned.bindAndStartObserver(copy(m));boundSelf=copy(m);
      }else if(q.operation==='ObserverReady'){must(boundSelf!==null,'NODE_SELF_CAPTURE_BEFORE_BA_READY');const o=await owned.readOwnedObserver();must(o.observer_phase==='WAITING_SELF_REGISTERED','NODE_BA_NOT_WAITING');value=copy(o.ready)}
      else if(q.operation==='LaunchReady'){must(!launch&&boundSelf!==null,'NODE_LAUNCH_ONCE');const o=await owned.readOwnedObserver();must(o.observer_phase==='WAITING_SELF_REGISTERED','NODE_BA_NOT_WAITING');launch=true;value={status:'OWNED_BA_WAITING_AND_LOCAL_EFFECT_PERMITTED',packet_sha256:owner.packet_sha256}}
      else if(q.operation==='ObserverPhase'){must(boundSelf!==null&&['self-register','self-run'].includes(b.operation),'NODE_OPERATION_PHASE');const o=await owned.readOwnedObserver();must(o.observer_phase===(b.operation==='self-register'?'WAITING_SELF_REGISTERED':'AWAITING_INSTANCE'),'NODE_PHASE_MISMATCH');value={status:'VERIFIED_BY_TRUSTED_AUTHORITY'}}
      else if(q.operation==='ReopenProof'){must(launch&&boundSelf!==null,'NODE_PROOF_BEFORE_START');value=await owned.reopenProof(copy(b));exact(value,['status','proof_sha256','export_sha256']);must(value.status==='EXACT_NATIVE_PROOF_REOPENED'&&value.proof_sha256===b.outcome.proof_sha256&&value.export_sha256===b.outcome.export_sha256,'NODE_EXACT_PROOF_NOT_REOPENED')}
      else throw Error('NODE_OPERATION_NOT_IMPLEMENTED');
     }
    }
    const reply={schema:'clued.node-ingress-reply212/1',seq:q.seq,request_id:q.request_id,operation:q.operation,request_sha256:bridge.sha256(frame.raw),status:'CURRENT_FOR_EXACT_ROOT_OWNED_REQUEST',value};must(JSON.stringify(reply).length<=4096,'NODE_REPLY_BOUND');return reply;
   }catch{closed=true;throw Error('ROOT_NODE_REFUSED_OR_UNKNOWN_NO_RETRY')}finally{busy=false}
  }
  return Object.freeze({handle,close(){closed=true},snapshot(){return {closed,opened,self_bound:boundSelf!==null,launch_permitted:launch,sequence:seq,qualification:false}}});
 }
 return Object.freeze({create,selectOwnRow});
})();
