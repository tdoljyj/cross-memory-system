const O='https://kooyomi.com',CURRENT_UPSTREAM_ORIGIN='https://kooyumi.pixelgrav.com',TTL=3600,KEEP=2592000,MAX_RECOVERY_AGE=86400000,REV='0.2.16';
// Public links use kooyomi.com; existing OAuth origins, MCP paths and audiences stay pinned.
const LEGACY_ORIGIN='https://clued.pixelgrav.com';
function trustedOrigin(value){return value===CURRENT_UPSTREAM_ORIGIN||value===LEGACY_ORIGIN}
function upstreamOrigin(e,s){
  if(s){
    const hasOrigin=Object.hasOwn(s,'upstream_origin'),hasResource=Object.hasOwn(s,'upstream_resource');
    if(!hasOrigin&&!hasResource)return LEGACY_ORIGIN;
    if(!hasOrigin||!hasResource||!trustedOrigin(s.upstream_origin)||s.upstream_resource!==s.upstream_origin+'/mcp')throw new Error('invalid_request_upstream');
    return s.upstream_origin;
  }
  const value=e.KOOYUMI_UPSTREAM_ORIGIN||CURRENT_UPSTREAM_ORIGIN;
  if(!trustedOrigin(value))throw new Error('invalid_upstream_origin');
  return value;
}
function mcpPath(origin){if(origin===CURRENT_UPSTREAM_ORIGIN)return '/connect/mcp/kooyumi';if(origin===LEGACY_ORIGIN)return '/connect/mcp/legacy';throw new Error('invalid_request_upstream')}
// Expiring installation evidence is separate from a long-lived, audience-specific MCP endpoint.
async function requestSelection(r,e){
  const u=new URL(r.url),id=u.searchParams.get('request_id')||'',c=u.searchParams.get('challenge')||'';
  if(!u.searchParams.has('request_id')&&!u.searchParams.has('challenge'))return {valid:true,state:null,selected:false};
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)||! /^[0-9a-f]{48}$/i.test(c))return {valid:false};
  const s=await get(e,id);
  if(!s)return {valid:true,state:null,selected:true};
  return s.challenge===c?{valid:true,state:s,selected:true}:{valid:false};
}
async function selectedState(r,e){
  const selection=await requestSelection(r,e);
  return !selection.valid||(selection.selected&&!selection.state)?undefined:selection.state;
}
const H={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
const J=(x,s=200,h={})=>new Response(JSON.stringify(x),{status:s,headers:{...H,...h}});
const T=(x,s=200,ct='text/plain; charset=utf-8',h={})=>new Response(x,{status:s,headers:{'content-type':ct,'cache-control':'no-store','x-content-type-options':'nosniff',...h}});
const now=()=>new Date().toISOString(), key=id=>'req:'+id, clean=(v,n=160)=>typeof v==='string'?v.trim().slice(0,n):'';
function normHost(v){let x=clean(v,80),l=x.toLowerCase();if(l.includes('workbuddy'))return 'WorkBuddy';if(l.includes('chatgpt')||l.includes('openai'))return 'ChatGPT';if(l.includes('cursor'))return 'Cursor';if(l.includes('codex'))return 'Codex';if(l.includes('claude code'))return 'Claude Code';if(l.includes('claude.ai')||l.includes('claude desktop')||l.includes('cowork')||l==='claude'||l.includes('anthropic'))return 'Claude';return x||'Other'}
function connectorHost(s){return s.host==='ChatGPT'||s.host==='Claude'}
function activationRequired(s){return s.host==='WorkBuddy'}
function claudePluginVerified(s){return !!(s&&s.host==='Claude'&&s.plugin_package_downloaded_at&&s.plugin_package_sha256&&s.plugin_mcp_verified_at&&s.plugin_behavior_verified_at&&s.usage_contract_verified_at)}
function contractVerified(s){if(s.host==='Claude')return claudePluginVerified(s);return connectorHost(s)?!!s.usage_contract_verified_at:!!s.skill_verified_at}
function readyEligible(s){return !!(contractVerified(s)&&s.mcp_verified_at&&s.account_verified_at)&&(!activationRequired(s)||!!s.host_activation_verified_at)}
function recoveryNext(s){if(s.host==='Claude'&&!claudePluginVerified(s))return 'claude_plugin';return !contractVerified(s)?(connectorHost(s)?'oauth_mcp':'skill'):!s.mcp_verified_at?'oauth_mcp':activationRequired(s)&&!s.host_activation_verified_at?'host_activation':'verify'}
function recoveryApply(s,ts=Date.now()){if(s.ready_at)return{ok:false,code:'already_ready',state:s};if(ts-Date.parse(s.created_at)>MAX_RECOVERY_AGE)return{ok:false,code:'recovery_window_closed',state:s};if((s.recovery_count||0)>=5)return{ok:false,code:'recovery_limit_reached',state:s};let n={...s};n.recovery_count=(n.recovery_count||0)+1;n.last_recovered_at=new Date(ts).toISOString();n.expires_at=new Date(ts+TTL*1000).toISOString();n.last_error=null;return{ok:true,state:n,continue_from:recoveryNext(n)}}
async function sha(x){let b=x instanceof ArrayBuffer?x:new TextEncoder().encode(String(x)),d=await crypto.subtle.digest('SHA-256',b);return[...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('')}
async function get(e,id){const s=/^[0-9a-f-]{36}$/i.test(id||'')?await e.CONNECT_KV.get(key(id),'json'):null;if(s)upstreamOrigin(e,s);return s}
async function put(e,s){await e.CONNECT_KV.put(key(s.request_id),JSON.stringify(s),{expirationTtl:KEEP})}
function valid(s,c){return !!(s&&c&&s.challenge===c&&Date.now()<=Date.parse(s.expires_at))}
async function ready(e,s){
  let eligible=readyEligible(s);
  if(eligible&&!s.ready_at){s.ready_at=now();s.receipt_id='clued_connect_rcpt_'+crypto.randomUUID();s.verification={policy:'server-evidence-v4',issued_at:s.ready_at,host_activation_required:activationRequired(s),usage_contract_mode:s.host==='Claude'?'claude-plugin-behavior-v1':connectorHost(s)?'connector-protected-call':'local-skill-sha',skill_evidence_mode:s.host==='Claude'?'host-managed-request-scoped-plugin-v1':s.skill_verified_at?'local-skill-sha':null};await put(e,s)}
  return s
}
function pub(s){
  let expired=Date.now()>Date.parse(s.expires_at),contract=contractVerified(s),core=!!(contract&&s.mcp_verified_at&&s.account_verified_at),act=!activationRequired(s)||!!s.host_activation_verified_at,claude=s.host==='Claude',partial=!!(claude&&s.usage_contract_verified_at&&s.mcp_verified_at&&s.account_verified_at&&!claudePluginVerified(s));
  return{
    request_id:s.request_id,revision:REV,created_at:s.created_at,expires_at:s.expires_at,expired,host:s.host||null,
    phase:s.ready_at?'ready':partial?'partial':claude&&!claudePluginVerified(s)?'plugin':core&&!act?'host_activation':contract?'authorization':connectorHost(s)?'authorization':'installation',
    evidence:{installation_request:!!s.contract_fetched_at,skill_package:claude?!!s.plugin_package_downloaded_at:!!s.skill_downloaded_at,skill:claude?!!s.plugin_behavior_verified_at:!!s.skill_verified_at,usage_contract:!!s.usage_contract_verified_at||(!connectorHost(s)&&!!s.skill_verified_at),plugin_package:!!s.plugin_package_downloaded_at,plugin_mcp:!!s.plugin_mcp_verified_at,behavior:!!s.plugin_behavior_verified_at,partial_connector:partial,mcp:!!s.mcp_verified_at,account:!!s.account_verified_at,host_activation:!!s.host_activation_verified_at},
    ready:!!(s.ready_at&&s.receipt_id),ready_at:s.ready_at||null,receipt_id:s.receipt_id||null,last_error:s.last_error||null,
    recovery:{recoverable:!s.ready_at&&(expired||!!s.last_error),count:s.recovery_count||0,continue_from:recoveryNext(s)},
    details:{skill_path:connectorHost(s)?null:(s.skill_path||null),skill_sha256:s.skill_sha256||null,usage_contract_sha256:s.usage_contract_sha256||null,usage_contract_policy:s.usage_contract_policy||null,plugin_package_sha256:s.plugin_package_sha256||null,plugin_skill_source_sha256:s.plugin_skill_source_sha256||null,plugin_evidence_mode:claude?'host-managed-plugin-or-existing-auth-rebind-v2':null,rebind_mode:s.rebind_mode||null,resume_receipt_id:s.resume_receipt_id||null,mcp_tool:s.mcp_tool||null,mcp_user_agent:s.mcp_user_agent||null}
  }
}
async function create(r,e){
  let id=crypto.randomUUID(),a=new Uint8Array(24);crypto.getRandomValues(a);
  let c=[...a].map(b=>b.toString(16).padStart(2,'0')).join(''),created=now(),expires=new Date(Date.now()+TTL*1000).toISOString();
  let origin=upstreamOrigin(e),s={request_id:id,challenge:c,created_at:created,expires_at:expires,upstream_origin:origin,upstream_resource:origin+'/mcp',requester_ip_hash:await sha(r.headers.get('cf-connecting-ip')||'unknown'),protocol_revision:REV};
  await put(e,s);
  let u=`${O}/connect/install/${id}/${c}`;
  return J({request_id:id,challenge:c,created_at:created,expires_at:expires,protocol_revision:REV,install_url:u,copy_text:`我想把 BeamingFace 连接到当前 AI / Agent。\n\nBeamingFace 用来让不同会话、Agent 和设备在我授权的范围内继续使用我的上下文、项目状态和相关记录。\n\n请按当前主机支持的方式连接 BeamingFace。支持自定义远程 MCP 的，就添加 BeamingFace；使用本地 Agent 集成的，就按照 Installation Request 里的对应方式完成连接。BeamingFace 不需要先出现在公开连接器目录中。\n\n这是我主动发起的连接。如果过程中需要主机自身的添加或信任确认、BeamingFace OAuth，或其他正常安全确认，我会按正常流程完成。\n\n不要向我索取密码、Bearer Token 或其他登录凭据。\n\nInstallation Request：\n${u}\n\n请完成连接，并以 BeamingFace 服务端显示 READY 为准。`},201)
}
async function status(r,e,id){
  let s=await get(e,id),c=new URL(r.url).searchParams.get('challenge')||'';
  if(!s||s.challenge!==c)return J({error:'not_found'},404);
  s=await ready(e,s);return J(pub(s))
}
function hostProfile(host,o,id,c,upstream){
  let mcp=o+mcpPath(upstream)+'?request_id='+id+'&challenge='+c,activate=o+'/connect/api/activate/'+id,skill=o+'/connect/skill/'+id+'/'+c,proof=o+'/connect/api/skill-proof/'+id;
  if(host==='ChatGPT')return{host,mode:'connector',persistent_local_write_required:false,directory_listing_required:false,usage_contract:{verification:'server_verified_on_authenticated_protected_mcp_call'},authorization:{oauth:'if_required',user_consent:'host_or_clued_oauth_ui'},activation:{method:'POST',url:activate,body:{challenge:c,host}},mcp:{transport:'streamable_http',url:mcp+'&host=ChatGPT'},host_confirmation:'only_if_host_requires_it'};
  if(host==='Claude'){
    let remote=mcp+'&host=Claude&carrier=plugin',pkg=o+'/connect/plugin/claude/'+id+'/'+c+'.zip',fallbackRemote=mcp+'&host=Claude&carrier=connector',native='https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=BeamingFace&connectorUrl='+encodeURIComponent(fallbackRemote);
    return{host,mode:'plugin_carrier',persistent_local_write_required:false,directory_listing_required:false,clued_skills:{included:true,source:skill,format:'claude-plugin-skill',source_integrity:'server_sha256'},plugin:{name:'BeamingFace',version:'0.1.6',package_url:pkg,request_scoped:true,components:['BeamingFace Skills','BeamingFace Remote MCP'],install:{provider:'Claude',method:'upload_custom_plugin',ui_path:'Customize > Plugins > + > Upload custom plugin',user_review_required:true,grants_permissions:false},verification:'package_download + request_scoped_plugin_nonce + protected_mcp_resume'},authorization:{oauth:'if_required',client_registration:'CIMD preferred; DCR fallback'},mcp:{transport:'streamable_http',url:remote},fallback:{mode:'connector_only',partial_only:true,host_native_install:{provider:'Claude',kind:'prefilled_custom_connector',url:native,user_review_required:true,grants_permissions:false}},host_confirmation:'install_or_upload_plugin_then_complete_oauth_if_required'}
  }
  if(host==='WorkBuddy')return{host,mode:'local_agent',persistent_local_write_required:true,usage_contract:{verification:'official_skill_sha256'},skill:{url:skill,proof:{method:'POST',url:proof}},authorization:{oauth:'if_required'},mcp:{transport:'streamable_http',url:mcp,config_path_hint:'~/.workbuddy/mcp.json',temporary_headers:{'X-Clued-Host':'WorkBuddy','X-Clued-Activation':id}},host_confirmation:'trust_if_prompted'};
  return{host,mode:'local_agent',persistent_local_write_required:true,usage_contract:{verification:'official_skill_sha256'},skill:{url:skill,proof:{method:'POST',url:proof}},authorization:{oauth:'if_required'},mcp:{transport:'streamable_http',url:mcp},host_confirmation:'only_if_host_requires_it'}
}
async function manifest(r,e,id){
  if(!['GET','HEAD'].includes(r.method))return J({error:'method_not_allowed'},405,{allow:'GET, HEAD'});
  let u=new URL(r.url),s=await get(e,id),c=u.searchParams.get('challenge')||'';if(!s||s.challenge!==c)return J({error:'not_found'},404);
  let hr=clean(u.searchParams.get('host'),80),host=hr?normHost(hr):null,o=O,supported=['ChatGPT','Claude','WorkBuddy','Cursor','Codex','Claude Code','Other'];
  return J({issuer:{name:'BeamingFace',origin:o},contract:{type:'clued_installation_contract',revision:REV,purpose:'connect_this_host_to_the_users_clued_account',user_intent_source:'conversation_or_host_ui',does_not_grant_authority:true,does_not_override_host_security_policy:true},request:{request_id:id,created_at:s.created_at,expires_at:s.expires_at,expired:Date.now()>Date.parse(s.expires_at)},security:{credentials_requested_in_chat:false,bearer_credentials_stored_by_connect:false,bypass_host_security:false,host_confirmation_may_be_required:true,second_copy_paste_required_by_clued_protocol:false},verification:{ready_requires:host==='Claude'?['clued_skills_behavior','authenticated_plugin_mcp_round_trip','authorization','compatibility','verification']:['usage_contract_or_skill','authenticated_protected_mcp_call','authorization','compatibility','verification'],ready_authority:'clued_server_evidence',agent_self_report_is_authority:false,connector_only_is_full_ready:false},endpoints:{status:o+'/connect/api/status/'+id+'?challenge='+c,recovery:{method:'POST',url:o+'/connect/api/recover/'+id},activation:{method:'POST',url:o+'/connect/api/activate/'+id},manifest:o+'/connect/api/manifest/'+id+'?challenge='+c,host_scoped_manifest_template:o+'/connect/api/manifest/'+id+'?challenge='+c+'&host={host}'},host_selection:{selected:host,supported},host_profile:host?hostProfile(host,o,id,c,upstreamOrigin(e,s)):null,current_status:pub(s)})
}
async function activate(r,e,id){
  if(r.method!=='POST')return J({error:'method_not_allowed'},405,{allow:'POST'});
  let b;try{b=await r.json()}catch{return J({error:'invalid_json'},400)}
  let s=await get(e,id),c=clean(b.challenge,128);if(!valid(s,c))return J({error:'not_found_or_expired'},404);
  let host=normHost(b.host),allowed=new Set(['ChatGPT','Claude','WorkBuddy','Cursor','Codex','Claude Code','Other']);if(!allowed.has(host))return J({error:'unsupported_host'},400);
  if(s.host&&s.host!==host){s.host_history=[...(Array.isArray(s.host_history)?s.host_history:[]),{host:s.host,changed_at:now(),reason:'activation_request'}].slice(-8)}
  s.host_requested=host;s.host=host;s.activation_requested_at=now();
  if(connectorHost(s)&&s.mcp_verified_at&&s.account_verified_at)s=await markConnectorContract(e,s);
  s=await ready(e,s);await put(e,s);
  return J({ok:true,host:s.host,usage_contract_verified:!!s.usage_contract_verified_at,behavior_verified:s.host==='Claude'?claudePluginVerified(s):contractVerified(s),integration:s.host==='Claude'&&!claudePluginVerified(s)&&s.mcp_verified_at?'partial':'full_or_pending',mcp_verified:!!s.mcp_verified_at,account_verified:!!s.account_verified_at,host_activation_required:activationRequired(s),ready:!!s.ready_at,receipt_id:s.receipt_id||null,continue_from:recoveryNext(s)})
}
async function rebind(r,e,id){if(r.method!=='POST')return J({error:'method_not_allowed'},405,{allow:'POST'});let b;try{b=await r.json()}catch{return J({error:'invalid_json'},400)}let s=await get(e,id),c=clean(b.challenge,128).toLowerCase(),pn=clean(b.plugin_nonce,128).toLowerCase(),aid=clean(b.activation_id,80);if(!valid(s,c))return J({error:'not_found_or_expired'},404);if(s.host!=='Claude'&&s.host_requested!=='Claude')return J({error:'claude_plugin_required'},409);if(!s.plugin_package_downloaded_at||!s.plugin_package_sha256||!s.plugin_nonce)return J({error:'plugin_package_not_issued'},409);if(pn!==s.plugin_nonce)return J({error:'plugin_nonce_mismatch'},403);if(!/^[0-9a-f-]{36}$/i.test(aid))return J({error:'invalid_activation_id'},400);let ch=await sha(c),nh=await sha(pn),vu=upstreamOrigin(e,s)+'/.well-known/clued-connect-activation/'+aid+'?request_id='+encodeURIComponent(id)+'&challenge_sha256='+ch+'&plugin_nonce_sha256='+nh,vr=await e.CLUED_CLOUD_SERVICE.fetch(new Request(vu,{headers:{accept:'application/json'}})),v;try{v=await vr.json()}catch{v=null}if(!vr.ok||!v||v.valid!==true||v.host!=='Claude'||v.resume_verified!==true)return J({error:'activation_attestation_invalid'},403);let ts=now();s.host='Claude';s.host_requested='Claude';s.plugin_mcp_verified_at=s.plugin_mcp_verified_at||ts;s.plugin_behavior_verified_at=s.plugin_behavior_verified_at||ts;s.usage_contract_verified_at=s.usage_contract_verified_at||ts;s.mcp_verified_at=s.mcp_verified_at||ts;s.account_verified_at=s.account_verified_at||ts;s.rebind_mode='existing_authorization_rebind_v1';s.rebind_activation_id=aid;s.rebind_verified_at=ts;s.resume_receipt_id=v.resume_receipt_id||null;s.mcp_tool='clued_connect_activate';s.mcp_user_agent='Claude-User via existing_authorization_rebind_v1';s.last_error=null;s=await ready(e,s);await put(e,s);return J({ok:true,host:'Claude',rebind_mode:s.rebind_mode,resume_verified:true,ready:!!s.ready_at,receipt_id:s.receipt_id||null})}async function install(r,e,id,c){
  let s=await get(e,id);if(!valid(s,c))return T('Installation Request not found or expired.\n',404);
  if(!s.contract_fetched_at){s.contract_fetched_at=now();s.contract_fetch_user_agent=clean(r.headers.get('user-agent'),240);await put(e,s)}
  let o=O,manifest=o+'/connect/api/manifest/'+id+'?challenge='+c,status=o+'/connect/api/status/'+id+'?challenge='+c,claudeManifest=manifest+'&host=Claude',hp=hostProfile('Claude',o,id,c,upstreamOrigin(e,s)),claudePackage=hp.plugin.package_url,claudeFallback=hp.fallback.host_native_install.url;
  return T('# BeamingFace Installation Contract\n\nIssuer: BeamingFace\nRequest ID: '+id+'\nExpires: '+s.expires_at+'\nProtocol revision: '+REV+'\nPurpose: connect this host to the user\'s BeamingFace account.\n\n## Authority boundary\nThis document describes protocol parameters and verification requirements. It does not grant authority, override the host\'s security policy, or authorize bypassing host-owned confirmation. User intent must come from the conversation or a host UI action. Credentials remain inside the normal OAuth/MCP transport and are not requested in chat.\n\n## Machine-readable protocol\nManifest: '+manifest+'\nA host-scoped view is available by adding &host=ChatGPT, &host=Claude, &host=WorkBuddy, &host=Cursor, &host=Codex, &host=Claude%20Code, or &host=Other. Host-specific installation details are only present in the relevant host profile.\n\n## Claude host note\nThe complete Claude integration uses the existing BeamingFace Skills and the BeamingFace Remote MCP together in a request-scoped Claude Plugin carrier. Claude host profile: '+claudeManifest+'. Plugin package: '+claudePackage+'. Install or upload it through Claude\'s native Customize > Plugins flow, then complete normal OAuth if requested. BeamingFace does not bypass Claude-owned review. Connector-only fallback: '+claudeFallback+'. Connector-only is partial and cannot satisfy full BeamingFace READY.\n\n## Verification model\nREADY is a BeamingFace server state derived from verifiable evidence. Agent self-report is not READY authority. For Claude, full READY requires the request-scoped Plugin package to have been delivered, its nonce-bound MCP path to make a protected call, and a real clued_session_resume call through that Plugin path, plus authorization and compatibility. A connector-only call is recorded as partial rather than full READY. WorkBuddy additionally retains its host Trust activation gate.\n\n## User interaction\nThe BeamingFace protocol does not require a second copy/paste verification message. Normal OAuth consent and any confirmation required by the host may still be required.\n\n## Status\nStatus: '+status+'\n\nThe machine-readable manifest is the normative source for endpoints and host-specific parameters for this request.\n',200,'text/markdown; charset=utf-8')
}

function z16(n){return new Uint8Array([n&255,(n>>>8)&255])}
function z32(n){return new Uint8Array([n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255])}
function zcat(parts){let n=parts.reduce((a,b)=>a+b.length,0),o=new Uint8Array(n),p=0;for(let b of parts){o.set(b,p);p+=b.length}return o}
function zcrc(bytes){let c=0xffffffff;for(let b of bytes){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0)}return(c^0xffffffff)>>>0}
function zipStore(files){let enc=new TextEncoder(),locals=[],centrals=[],offset=0;for(let f of files){let name=enc.encode(f.name),data=f.data instanceof Uint8Array?f.data:enc.encode(String(f.data)),crc=zcrc(data),lh=zcat([z32(0x04034b50),z16(20),z16(0),z16(0),z16(0),z16(0x21),z32(crc),z32(data.length),z32(data.length),z16(name.length),z16(0),name]),ch=zcat([z32(0x02014b50),z16(20),z16(20),z16(0),z16(0),z16(0),z16(0x21),z32(crc),z32(data.length),z32(data.length),z16(name.length),z16(0),z16(0),z16(0),z16(0),z32(0),z32(offset),name]);locals.push(lh,data);centrals.push(ch);offset+=lh.length+data.length}let central=zcat(centrals),end=zcat([z32(0x06054b50),z16(0),z16(0),z16(files.length),z16(files.length),z32(central.length),z32(offset),z16(0)]);return zcat([...locals,central,end])}
async function claudePlugin(r,e,id,c){
  if(!['GET','HEAD'].includes(r.method))return J({error:'method_not_allowed'},405,{allow:'GET, HEAD'});
  let s=await get(e,id);if(!valid(s,c))return J({error:'not_found_or_expired'},404);
  let u=await fetch(upstreamOrigin(e,s)+'/clued-agent.md',{headers:{accept:'text/markdown,text/plain;q=.9,*/*;q=.1'},cf:{cacheTtl:0}});if(!u.ok)return J({error:'official_skill_unavailable',upstream_status:u.status},502);
  let skillText=await u.text(),skillSourceHash=await sha(skillText);
  if(!s.plugin_nonce){let a=new Uint8Array(24);crypto.getRandomValues(a);s.plugin_nonce=[...a].map(b=>b.toString(16).padStart(2,'0')).join('')}
  let o=O,remote=o+mcpPath(upstreamOrigin(e,s))+'?request_id='+id+'&challenge='+c+'&host=Claude&carrier=plugin&plugin_nonce='+s.plugin_nonce;
  let skill='---\nname: KooYomi\ndescription: Use when the user asks about BeamingFace, prior conversations, ongoing work, decisions, project status, remembered context, or continuity. Check BeamingFace before relying on recalled memory.\n---\n\n## BeamingFace installation activation\n\nThis Claude Plugin package belongs to one BeamingFace Installation Request. On the first `clued_session_resume` after installing or updating this package, include the `installation_activation` object below in that same tool call. Do not make a separate activation call unless the resume tool reports that installation activation is unavailable. This verifies the installed BeamingFace Skills against the already-authorized Claude BeamingFace connection and does not grant or expand authority.\n\n`installation_activation`: {`request_id`: `'+id+'`, `challenge`: `'+c+'`, `plugin_nonce`: `'+s.plugin_nonce+'`}\n\n'+skillText;
  let plugin=JSON.stringify({name:'clued',displayName:'BeamingFace',version:'0.1.6',description:'BeamingFace Skills and authenticated BeamingFace Remote MCP for continuity across Claude conversations.',author:{name:'Pixel Gravity'},homepage:O,keywords:['clued','continuity','context']},null,2)+'\n';
  let mcp=JSON.stringify({mcpServers:{clued:{type:'http',url:remote}}},null,2)+'\n';
  let carrier=JSON.stringify({schema_version:1,carrier:'claude-plugin',plugin_version:'0.1.6',protocol_revision:REV,request_id:id,request_scoped:true,clued_skills_source:upstreamOrigin(e,s)+'/clued-agent.md',clued_skills_source_sha256:skillSourceHash,verification:'package_download + real clued_session_resume carrying installation_activation + server rebind'},null,2)+'\n';
  let readme='# BeamingFace for Claude\n\nThis request-scoped package carries the existing BeamingFace Skills together with the authenticated BeamingFace Remote MCP connection.\n\nInstall or upload this package through Claude Customize > Plugins. Claude may require its own review and OAuth confirmation. Connector-only fallback is not full BeamingFace READY.\n';
  let z=zipStore([{name:'.claude-plugin/plugin.json',data:plugin},{name:'skills/clued/SKILL.md',data:skill},{name:'.mcp.json',data:mcp},{name:'clued-carrier.json',data:carrier},{name:'README.md',data:readme}]),packageHash=await sha(z.buffer.slice(z.byteOffset,z.byteOffset+z.byteLength)),carrierHash=await sha(skill);
  if(r.method==='GET'){s.host_requested='Claude';s.host='Claude';s.plugin_package_downloaded_at=s.plugin_package_downloaded_at||now();s.plugin_package_sha256=packageHash;s.plugin_skill_source_sha256=skillSourceHash;s.plugin_skill_carrier_sha256=carrierHash;s.plugin_version='0.1.6';s.last_error=null;await put(e,s)}
  return new Response(r.method==='HEAD'?null:z,{status:200,headers:{'content-type':'application/zip','content-disposition':'attachment; filename="BeamingFace-for-Claude.zip"','cache-control':'no-store','x-content-type-options':'nosniff','x-clued-plugin-sha256':packageHash,'x-clued-skill-source-sha256':skillSourceHash}})
}
async function skill(r,e,id,c){
  let s=await get(e,id);if(!valid(s,c))return T('Skill request not found or expired.\n',404);
  let u=await fetch(upstreamOrigin(e,s)+'/clued-agent.md',{headers:{accept:'text/markdown,text/plain;q=.9,*/*;q=.1'},cf:{cacheTtl:0}});
  if(!u.ok)return J({error:'official_skill_unavailable',upstream_status:u.status},502);
  let b=await u.arrayBuffer();s.skill_downloaded_at=s.skill_downloaded_at||now();s.official_skill_sha256=await sha(b);await put(e,s);
  return new Response(b,{status:200,headers:{'content-type':u.headers.get('content-type')||'text/markdown; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}})
}
async function proof(r,e,id){
  if(r.method!=='POST')return J({error:'method_not_allowed'},405,{allow:'POST'});
  let b;try{b=await r.json()}catch{return J({error:'invalid_json'},400)}
  let s=await get(e,id),c=clean(b.challenge,128);if(!valid(s,c))return J({error:'not_found_or_expired'},404);
  let host=normHost(b.host),path=clean(b.skill_path,500),claim=clean(b.skill_sha256,64).toLowerCase();
  if(host==='ChatGPT'||host==='Claude')return J({error:'connector_host_use_activation',activate_url:'/connect/api/activate/'+id},409);
  if(!host||!path||!/^[0-9a-f]{64}$/.test(claim))return J({error:'invalid_proof'},400);
  let u=await fetch(upstreamOrigin(e,s)+'/clued-agent.md',{cf:{cacheTtl:0}});if(!u.ok)return J({error:'official_skill_unavailable'},502);
  let official=await sha(await u.arrayBuffer());
  if(claim!==official){s.skill_last_failed_at=now();s.last_error={stage:'skill',code:'skill_digest_mismatch',at:s.skill_last_failed_at,recoverable:true};await put(e,s);return J({error:'skill_digest_mismatch',recoverable:true},422)}
  s.host=host;s.skill_path=path;s.skill_sha256=official;s.skill_verified_at=now();s.last_error=null;s=await ready(e,s);await put(e,s);
  return J({ok:true,host:s.host,skill_verified:true,host_activation_required:activationRequired(s),ready:!!s.ready_at,receipt_id:s.receipt_id||null})
}
function tool(x){
  if(!x||x.jsonrpc!=='2.0'||x.method!=='tools/call')return null;
  let n=x.params?.name;return new Set(['clued_session_resume','clued_project_list','clued_record_list','clued_read_log','clued_search_context','clued_audit_receipts']).has(n)?n:null
}
function protectedResultSucceeded(response,request){
  const result=response?.result,value=result?.structuredContent;
  return response?.jsonrpc==='2.0'&&request?.id!==undefined&&response.id===request.id&&!Object.hasOwn(response,'error')&&
    result!==null&&typeof result==='object'&&!Array.isArray(result)&&
    (result.isError===undefined||result.isError===false)&&Array.isArray(result.content)&&
    value!==null&&typeof value==='object'&&!Array.isArray(value)&&value.error==null&&
    !['rejected','failed','blocked','denied'].includes(String(value.status).toLowerCase());
}
async function markConnectorContract(e,s){
  let u=await fetch(upstreamOrigin(e,s)+'/clued-agent.md',{cf:{cacheTtl:0}});if(!u.ok)throw new Error('official_usage_contract_unavailable');let b=await u.arrayBuffer();
  s.usage_contract_verified_at=s.usage_contract_verified_at||now();s.usage_contract_sha256=await sha(b);s.usage_contract_policy='connector-protected-call-v1';return s
}
async function mcp(r,e){
  let u=new URL(r.url),id=u.searchParams.get('request_id')||'',c=u.searchParams.get('challenge')||'',selection=await requestSelection(r,e),s=selection.state,active=valid(s,c),parsed=null;
  if(!selection.valid)return J({error:'not_found'},404);
  const fixed=u.pathname==='/connect/mcp/kooyumi'?CURRENT_UPSTREAM_ORIGIN:u.pathname==='/connect/mcp/legacy'?LEGACY_ORIGIN:null;
  const upstream=s?upstreamOrigin(e,s):fixed||(selection.selected?LEGACY_ORIGIN:upstreamOrigin(e));
  if(fixed&&fixed!==upstream)return J({error:'not_found'},404);
  if(r.method==='POST')try{parsed=await r.clone().json()}catch{}
  let n=tool(parsed),hv=clean(u.searchParams.get('host')||r.headers.get('x-clued-host')||s?.host_requested||'',80),requested=hv?normHost(hv):null,h=new Headers(r.headers);['host','cf-connecting-ip','cf-ray','cf-visitor','x-clued-activation','x-clued-host'].forEach(x=>h.delete(x));
  let init={method:r.method,headers:h,redirect:'manual'};if(!['GET','HEAD'].includes(r.method))init.body=r.body;
  let up=await fetch(new Request(upstream+'/mcp',init));
  if(active&&n){
    s.mcp_user_agent=clean(r.headers.get('user-agent'),240)||null;
    if(up.ok)try{
      let x=await up.clone().json();
      if(protectedResultSucceeded(x,parsed)){
        s.mcp_verified_at=s.mcp_verified_at||now();s.account_verified_at=s.account_verified_at||s.mcp_verified_at;s.mcp_tool=n;
        let auth=r.headers.get('authorization')||'';if(auth)s.credential_fingerprint=(await sha(auth)).slice(0,16);
        if(requested&&s.host!==requested){if(s.host)s.host_history=[...(Array.isArray(s.host_history)?s.host_history:[]),{host:s.host,changed_at:now(),reason:'protected_mcp_host'}].slice(-8);s.host=requested}
        if(connectorHost(s))s=await markConnectorContract(e,s);
        let carrier=clean(u.searchParams.get('carrier'),40),pn=clean(u.searchParams.get('plugin_nonce'),128);
        if((requested||s.host)==='Claude'&&carrier==='plugin'&&s.plugin_nonce&&pn===s.plugin_nonce){s.plugin_mcp_verified_at=s.plugin_mcp_verified_at||now();s.plugin_carrier='claude-plugin';if(n==='clued_session_resume')s.plugin_behavior_verified_at=s.plugin_behavior_verified_at||now()}
        let hh=requested||normHost(r.headers.get('x-clued-host')),act=clean(r.headers.get('x-clued-activation'),80);
        if(s.host==='WorkBuddy'&&hh==='WorkBuddy'&&act===s.request_id)s.host_activation_verified_at=s.host_activation_verified_at||now();
        s.last_error=null;s=await ready(e,s);await put(e,s)
      }
    }catch(err){s.last_error={stage:'verification',code:clean(err instanceof Error?err.message:'verification_failed',100),at:now(),recoverable:true};await put(e,s)}
    else{s.last_error={stage:'mcp',code:up.status===401?'authorization_required':'upstream_http_'+up.status,status:up.status,at:now(),recoverable:true};await put(e,s)}
  }
  let rh=new Headers(up.headers);rh.set('x-clued-connect-proxy','1');rh.set('cache-control','no-store');
  return new Response(up.body,{status:up.status,statusText:up.statusText,headers:rh})
}
async function recover(r,e,id){
  if(r.method!=='POST')return J({error:'method_not_allowed'},405,{allow:'POST'});
  let b;try{b=await r.json()}catch{return J({error:'invalid_json'},400)}
  let s=await get(e,id),c=clean(b.challenge,128);if(!s||s.challenge!==c)return J({error:'not_found'},404);
  let rr=recoveryApply(s);
  if(!rr.ok){if(rr.code==='already_ready')return J({ok:true,already_ready:true,status:pub(s)});return J({error:rr.code},rr.code==='recovery_window_closed'?410:429)}
  s=rr.state;await put(e,s);let o=O;
  return J({ok:true,recovered:true,recovery_count:s.recovery_count,expires_at:s.expires_at,install_url:`${o}/connect/install/${id}/${c}`,continue_from:rr.continue_from})
}
async function smoke(r,e){
  const s=await selectedState(r,e);if(s===undefined)return J({error:'not_found'},404);
  let [a,b,c]=await Promise.all([fetch(upstreamOrigin(e,s)+'/healthz',{cf:{cacheTtl:0}}),fetch(upstreamOrigin(e,s)+'/.well-known/clued-continuity',{cf:{cacheTtl:0}}),fetch(upstreamOrigin(e,s)+'/clued-agent.md',{cf:{cacheTtl:0}})]),d=null;if(c.ok)d=await sha(await c.arrayBuffer());
  let local={skill_verified_at:'x',mcp_verified_at:'x',account_verified_at:'x'},wb={...local,host:'WorkBuddy'},wbt={...wb,host_activation_verified_at:'x'},other={...local,host:'Cursor'},claudeCode={...local,host:'Claude Code'},chatgpt={host:'ChatGPT',usage_contract_verified_at:'x',mcp_verified_at:'x',account_verified_at:'x'},chatgptMissing={host:'ChatGPT',mcp_verified_at:'x',account_verified_at:'x'},claudeConnector={host:'Claude',usage_contract_verified_at:'x',mcp_verified_at:'x',account_verified_at:'x'},claudePlugin={host:'Claude',usage_contract_verified_at:'x',mcp_verified_at:'x',account_verified_at:'x',plugin_package_downloaded_at:'x',plugin_package_sha256:'x',plugin_mcp_verified_at:'x',plugin_behavior_verified_at:'x'},claudeMissing={host:'Claude',mcp_verified_at:'x',account_verified_at:'x'};let ts=Date.parse('2026-09-10T00:00:00.000Z'),rec0={request_id:'11111111-1111-4111-8111-111111111111',challenge:'c',created_at:new Date(ts-60000).toISOString(),expires_at:new Date(ts-1).toISOString(),host:'WorkBuddy',skill_verified_at:'x',last_error:{stage:'mcp',code:'authorization_required'}};let rr=recoveryApply(rec0,ts);
  let checks={workbuddy_without_trust_ready:readyEligible(wb),workbuddy_with_trust_ready:readyEligible(wbt),other_host_ready:readyEligible(other),claude_code_local_ready:readyEligible(claudeCode),chatgpt_connector_ready:readyEligible(chatgpt),chatgpt_without_contract_ready:readyEligible(chatgptMissing),chatgpt_recovery_next:recoveryNext(chatgptMissing),claude_connector_only_ready:readyEligible(claudeConnector),claude_plugin_ready:readyEligible(claudePlugin),claude_without_plugin_ready:readyEligible(claudeMissing),claude_recovery_next:recoveryNext(claudeMissing),workbuddy_recovery_next:recoveryNext(wb),recovery_ok:rr.ok,recovery_same_request:rr.state.request_id===rec0.request_id&&rr.state.challenge===rec0.challenge,recovery_count:rr.state.recovery_count,recovery_clears_error:rr.state.last_error===null,recovery_extends_seconds:(Date.parse(rr.state.expires_at)-ts)/1000,recovery_continue_from:rr.continue_from};
  let state_ok=checks.workbuddy_without_trust_ready===false&&checks.workbuddy_with_trust_ready===true&&checks.other_host_ready===true&&checks.claude_code_local_ready===true&&checks.chatgpt_connector_ready===true&&checks.chatgpt_without_contract_ready===false&&checks.chatgpt_recovery_next==='oauth_mcp'&&checks.claude_connector_only_ready===false&&checks.claude_plugin_ready===true&&checks.claude_without_plugin_ready===false&&checks.claude_recovery_next==='claude_plugin'&&checks.workbuddy_recovery_next==='host_activation'&&checks.recovery_ok===true&&checks.recovery_same_request===true&&checks.recovery_count===1&&checks.recovery_clears_error===true&&checks.recovery_extends_seconds===TTL&&checks.recovery_continue_from==='oauth_mcp',ok=a.ok&&b.ok&&c.ok&&state_ok;
  return J({ok,connect_service:'clued-connect',revision:REV,source_commit:typeof KOOYUMI_RELEASE_COMMIT==='string'?KOOYUMI_RELEASE_COMMIT:null,state_machine:{ok:state_ok,...checks},upstream:{origin:upstreamOrigin(e,s),resource:upstreamOrigin(e,s)+'/mcp',healthz:a.status,continuity_policy:b.status,official_skill:c.status,official_skill_sha256:d},checked_at:now()},ok?200:503)
}
function page(){return `<!doctype html><html lang=zh-CN><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><meta name=color-scheme content="light dark"><title>BeamingFace Connect</title><style>:root{font:16px system-ui;--b:#f4f4f1;--p:#fff;--t:#111;--m:#6b6b68;--l:#deded9;--s:#efefeb;--o:#18784b}html[data-theme=dark]{--b:#111210;--p:#191a18;--t:#f3f3ef;--m:#aaa;--l:#343530;--s:#22231f;--o:#65c995}@media(prefers-color-scheme:dark){html:not([data-theme=light]){--b:#111210;--p:#191a18;--t:#f3f3ef;--m:#aaa;--l:#343530;--s:#22231f;--o:#65c995}}*{box-sizing:border-box}body{margin:0;background:var(--b);color:var(--t)}main{max-width:900px;margin:auto;padding:28px 20px 60px}header{display:flex;justify-content:space-between;margin-bottom:64px;font-weight:700;font-size:20px}select,.card,.host{background:var(--p);color:var(--t);border:1px solid var(--l)}select{border-radius:99px;padding:7px 10px}h1{font-size:clamp(44px,8vw,76px);line-height:.98;letter-spacing:-.055em;margin:0 0 18px}.lead{color:var(--m);font-size:19px;line-height:1.6;max-width:700px}.card{margin-top:34px;padding:24px;border-radius:24px}.label{font-weight:700;margin-bottom:12px}.hosts{display:flex;flex-wrap:wrap;gap:8px}.host{border-radius:99px;padding:10px 14px;font-weight:650;cursor:pointer}.host.active{background:var(--t);color:var(--b);border-color:var(--t)}.action{margin-top:20px;padding:18px;border-radius:17px;background:var(--s)}.action h2{font-size:20px;margin:0 0 7px}.hint{color:var(--m);line-height:1.55;margin:0 0 14px}.primary,.secondary,.copy button{border:0;border-radius:12px;padding:12px 18px;font-weight:750;cursor:pointer}.primary{display:inline-block;text-decoration:none;background:var(--t);color:var(--b)}.secondary{display:inline-block;text-decoration:none;background:transparent;color:var(--t);border:1px solid var(--l);margin-left:7px}.copy{display:flex;gap:8px;background:var(--p);padding:8px;border-radius:15px;border:1px solid var(--l)}.copy code{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:12px}.copy button{background:var(--t);color:var(--b)}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}.i{border:1px solid var(--l);border-radius:15px;padding:15px}.i span{display:block;color:var(--m);font-size:13px;margin-top:4px}.i.ok{border-color:var(--o)}.i.ok span{color:var(--o)}.ready{margin-top:14px;padding:16px;border-radius:15px;background:var(--s)}.ready.ok{color:var(--o)}.meta,.foot{color:var(--m);font-size:13px;margin-top:12px;line-height:1.5}@media(max-width:620px){header{margin-bottom:44px}.grid{grid-template-columns:1fr}.copy{flex-direction:column}.copy button{height:44px}.copy code{white-space:normal;overflow-wrap:anywhere}.primary,.secondary{display:block;width:100%;text-align:center;margin:8px 0 0}.hosts{gap:7px}}</style><main><header><b>BeamingFace Connect</b><select id=theme><option value=system>系统</option><option value=light>浅色</option><option value=dark>深色</option></select></header><h1>连接 BeamingFace。</h1><div class=lead>选择你要使用 BeamingFace 的地方。BeamingFace 会按对应主机的正常方式完成连接，并用真实服务端证据自动验证。</div><section class=card><div class=label>在哪里使用 BeamingFace？</div><div class=hosts id=hosts><button class=host data-host=Claude>Claude</button><button class=host data-host=ChatGPT>ChatGPT</button><button class=host data-host=WorkBuddy>WorkBuddy</button><button class=host data-host=Codex>Codex</button><button class=host data-host=Cursor>Cursor</button><button class=host data-host="Claude Code">Claude Code</button><button class=host data-host=Other>其他</button></div><div class=action id=action><h2>选择一个主机继续</h2><p class=hint>Installation Request 正在后台创建。</p></div><div class=meta id=meta>正在创建 Installation Request…</div><div class=grid><div class=i id=skill><b>BeamingFace Skills / Usage Contract</b><span>等待连接</span></div><div class=i id=mc><b>BeamingFace MCP</b><span>等待真实连接</span></div><div class=i id=acc><b>Account</b><span>等待授权验证</span></div><div class=i id=ver><b>Verification</b><span>等待服务端 Receipt</span></div></div><div class=ready id=rd><b>等待连接</b><div class=meta id=detail>完成主机自己的确认或 OAuth 后，这里会自动更新。</div></div><div class=foot>READY 不由 Agent 自报。Claude 完整 READY 需要 BeamingFace Skills + request-scoped Plugin MCP 的真实行为证据；Connector-only 只算兼容连接。WorkBuddy 仍必须完成宿主 Trust 后的真实 MCP 调用。</div></section></main><script>const $=s=>document.querySelector(s);let id,c,t,copyText='',currentHost='';function th(v){v==='system'?document.documentElement.removeAttribute('data-theme'):document.documentElement.setAttribute('data-theme',v);localStorage.setItem('clued-theme',v)}let sv=localStorage.getItem('clued-theme')||'system';theme.value=sv;th(sv);theme.onchange=e=>th(e.target.value);function ok(x,s){$(x).classList.add('ok');$(x+' span').textContent=s}function esc(s){return String(s||'').replace(/[&<>]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[ch]))}async function copyRequest(btn){if(!copyText)return;await navigator.clipboard.writeText(copyText);let old=btn.textContent;btn.textContent='已复制';setTimeout(()=>btn.textContent=old,1200)}async function renderAction(){document.querySelectorAll('.host').forEach(b=>b.classList.toggle('active',b.dataset.host===currentHost));if(!currentHost){action.innerHTML='<h2>选择一个主机继续</h2><p class=hint>不同主机会走各自最自然的连接方式。</p>';return}if(!id){action.innerHTML='<h2>'+esc(currentHost)+'</h2><p class=hint>正在创建 Installation Request…</p>';return}if(currentHost==='Claude'){action.innerHTML='<h2>安装 BeamingFace for Claude</h2><p class=hint>完整安装包含现有 BeamingFace Skills + BeamingFace Remote MCP。先下载这次请求专属的 Plugin，然后在 Claude 的 Customize > Plugins 中上传；Claude 自己的安装确认和 OAuth 仍由 Claude 正常处理。</p><span id=pluginWrap>正在准备 BeamingFace Plugin…</span>';try{let r=await fetch('/connect/api/manifest/'+id+'?challenge='+c+'&host=Claude',{cache:'no-store'}),m=await r.json(),pkg=m.host_profile&&m.host_profile.plugin&&m.host_profile.plugin.package_url,fb=m.host_profile&&m.host_profile.fallback&&m.host_profile.fallback.host_native_install&&m.host_profile.fallback.host_native_install.url;if(!r.ok||!pkg)throw Error('plugin_package_unavailable');pluginWrap.innerHTML='<a class=primary href="'+esc(pkg)+'">下载 BeamingFace for Claude</a>'+(fb?'<a class=secondary target=_blank rel="noopener noreferrer" href="'+esc(fb)+'">仅连接 MCP（兼容）↗</a>':'')+'<div class=meta>下载后：Claude → Customize → Plugins → + → Upload custom plugin。完成 Claude 自己的确认与 OAuth 后，此页会等待真实 BeamingFace Skills 行为 + MCP 证据，再签发完整 READY。Connector-only 不会显示完整 READY。</div>'}catch(e){pluginWrap.innerHTML='<button class=secondary id=fallback>复制安装请求</button><div class=meta>Plugin 包暂时不可用，可保留 Installation Request 后重试；不会降级冒充完整 READY。</div>';fallback.onclick=()=>copyRequest(fallback)}return}action.innerHTML='<h2>连接到 '+esc(currentHost)+'</h2><p class=hint>把下面这段发给 '+esc(currentHost)+'，需要时按主机自己的正常确认流程继续。</p><div class=copy><code id=txt>'+esc(copyText)+'</code><button id=copy>复制安装请求</button></div>';copy.onclick=()=>copyRequest(copy)}async function selectHost(h){currentHost=h;localStorage.setItem('clued-host',h);await renderAction()}document.querySelectorAll('.host').forEach(b=>b.onclick=()=>selectHost(b.dataset.host));async function poll(){if(!id)return;try{let r=await fetch('/connect/api/status/'+id+'?challenge='+c,{cache:'no-store'});if(!r.ok)return;let s=await r.json(),isClaude=s.host==='Claude'||currentHost==='Claude';if(isClaude){if(s.evidence.behavior)ok('#skill','BeamingFace Skills 行为已由 Plugin 路径验证');else if(s.evidence.plugin_mcp)$('#skill span').textContent='Plugin MCP 已连接，等待首次 BeamingFace 恢复';else if(s.evidence.plugin_package)$('#skill span').textContent='BeamingFace Plugin 已领取，等待 Claude 安装并激活';else if(s.evidence.partial_connector)$('#skill span').textContent='仅 MCP 已连接；BeamingFace Skills 尚未验证';else if(s.evidence.installation_request)$('#skill span').textContent='安装请求已读取'}else{if(s.evidence.usage_contract)ok('#skill',s.evidence.skill?'官方 Skill 摘要匹配'+(s.host?' · '+s.host:''):'Usage Contract 已验证');else if(s.evidence.skill_package)$('#skill span').textContent='Skill 已领取，等待本地摘要证明';else if(s.evidence.installation_request)$('#skill span').textContent='安装请求已读取'}if(s.evidence.mcp)ok('#mc',isClaude&&s.evidence.plugin_mcp?'Plugin 的真实受保护 MCP 调用通过':'真实受保护 MCP 调用通过');if(s.evidence.account)ok('#acc','BeamingFace 授权通过');if(s.host==='WorkBuddy'&&!s.evidence.host_activation&&s.evidence.mcp)$('#ver span').textContent='等待 WorkBuddy Trust 后的真实连接';if(s.phase==='partial'&&!s.ready){rd.classList.remove('ok');rd.querySelector('b').textContent='已连接 MCP · 完整集成未就绪';detail.textContent='BeamingFace Skills / Plugin 行为尚未验证，因此不会签发完整 READY。'}if(s.ready){ok('#ver','Receipt 已签发');rd.classList.add('ok');rd.querySelector('b').textContent='✓ BeamingFace READY';detail.textContent=(s.host?s.host+' · ':'')+'BeamingFace Skills + MCP + 授权已通过真实验证 · '+s.receipt_id;clearInterval(t)}}catch{}}async function init(){let q=new URL(location.href).searchParams.get('host'),saved=localStorage.getItem('clued-host');if(q&&Array.from(document.querySelectorAll('.host')).some(b=>b.dataset.host===q))currentHost=q;else if(saved&&Array.from(document.querySelectorAll('.host')).some(b=>b.dataset.host===saved))currentHost=saved;renderAction();try{let r=await fetch('/connect/api/request',{method:'POST'}),x=await r.json();if(!r.ok)throw Error(x.error);id=x.request_id;c=x.challenge;copyText=x.copy_text;meta.textContent='Request · '+id.slice(0,8)+' · 有效至 '+new Date(x.expires_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});await renderAction();poll();t=setInterval(poll,1800)}catch(e){meta.textContent='创建失败：'+e.message}}init()</script></html>`}
export default{async fetch(r,e){
  let u=new URL(r.url),p=u.pathname;
  try{
    if(p==='/connect'||p==='/connect/'){if(!['GET','HEAD'].includes(r.method))return J({error:'method_not_allowed'},405);return T(page(),200,'text/html; charset=utf-8',{'content-security-policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",'referrer-policy':'no-referrer'})}
    if(p==='/connect/api/request')return r.method==='POST'?await create(r,e):J({error:'method_not_allowed'},405);
    if(p==='/connect/api/smoke')return r.method==='GET'?await smoke(r,e):J({error:'method_not_allowed'},405);
    let x;
    if(x=/^\/connect\/api\/status\/([0-9a-f-]{36})$/i.exec(p))return await status(r,e,x[1]);
    if(x=/^\/connect\/api\/manifest\/([0-9a-f-]{36})$/i.exec(p))return await manifest(r,e,x[1]);
    if(x=/^\/connect\/api\/activate\/([0-9a-f-]{36})$/i.exec(p))return await activate(r,e,x[1]);if(x=/^\/connect\/api\/rebind\/([0-9a-f-]{36})$/i.exec(p))return await rebind(r,e,x[1]);
    if(x=/^\/connect\/api\/recover\/([0-9a-f-]{36})$/i.exec(p))return await recover(r,e,x[1]);
    if(x=/^\/connect\/install\/([0-9a-f-]{36})\/([0-9a-f]{48})$/i.exec(p))return await install(r,e,x[1],x[2]);
    if(x=/^\/connect\/plugin\/claude\/([0-9a-f-]{36})\/([0-9a-f]{48})\.zip$/i.exec(p))return await claudePlugin(r,e,x[1],x[2]);
    if(x=/^\/connect\/skill\/([0-9a-f-]{36})\/([0-9a-f]{48})$/i.exec(p))return await skill(r,e,x[1],x[2]);
    if(x=/^\/connect\/api\/skill-proof\/([0-9a-f-]{36})$/i.exec(p))return await proof(r,e,x[1]);
    if(p==='/connect/mcp'||p==='/connect/mcp/kooyumi'||p==='/connect/mcp/legacy')return await mcp(r,e);
    return J({error:'not_found'},404)
  }catch(x){return J({error:'connect_internal_error',message:x instanceof Error?x.message:'unknown'},500)}
}};
