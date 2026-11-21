// Disposable PostgreSQL and synthetic identity/provider metadata only.
import { stopCluster, removeTestDirectory, EPHEMERAL_POSTGRES_FLAGS, EPHEMERAL_INITDB_FLAGS } from './cluster-cleanup.mjs';
import assert from "node:assert/strict";
import {randomUUID,randomBytes,createHash} from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import {fileURLToPath,pathToFileURL} from "node:url";
import {build,stop} from "esbuild";
import EmbeddedPostgres from "embedded-postgres";
import {allowTestIssuerCredentials} from "./issuer-credentials-fixture.mjs";
import {allowRawTestBindings} from "./raw-binding-grants-fixture.mjs";
import {setWorkerGatewayCaller,assertGatewayCloseoutBoundary} from "./worker-gateway-caller-fixture.mjs";
import {createGoogleDriveMetadataApi} from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
import {createGoogleDriveProviderIdentityResolver} from "../../../kernel/host/resource-center-google-drive-identity.mjs";
import {createResourceCenterCloudExecutor} from "../../../kernel/host/resource-center-cloud-executor.mjs";
import {RESOURCE_CENTER_POLICY_VERSION,bindResourceCenterMutation} from "../../../kernel/policy/resource-center-mutation-policy.mjs";
import {batchRequests,batchReply} from "./google-batch-fixture.mjs";
export const id=()=>randomUUID(),sha=v=>createHash("sha256").update(v).digest("hex");
const cloudRoot=fileURLToPath(new URL("..",import.meta.url));
async function freePort(){const s=net.createServer();await new Promise(resolve=>s.listen(0,"127.0.0.1",resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p;}

export async function withRegistrationDatabase(run){
 const temp=await fs.realpath(os.tmpdir()),dir=await fs.mkdtemp(path.join(temp,"kooyumi-registration-db-"));
 const server=new EmbeddedPostgres({databaseDir:dir,user:"postgres",password:sha(id()),port:await freePort(),persistent:true,
  initdbFlags: [...EPHEMERAL_INITDB_FLAGS], postgresFlags:[...EPHEMERAL_POSTGRES_FLAGS, "-c", "listen_addresses=127.0.0.1"],onLog(){},onError(){}}),clients=[];let started=false;
 try{
  await server.initialise();await server.start();started=true;
  const connect=async()=>{const c=server.getPgClient();clients.push(c);await c.connect();return c;},db=await connect();
  await db.query(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   create role authenticator nologin noinherit;create schema auth;create schema extensions;create extension pgcrypto with schema extensions;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
   create table auth.sessions(id uuid primary key,user_id uuid not null,not_after timestamptz);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   grant usage on schema auth,extensions to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
   create schema cron;create table cron.job(jobid bigserial primary key,jobname text unique,schedule text,command text,active boolean default true,database text default current_database(),username text default current_user);
   create function cron.schedule(text,text,text) returns bigint language sql as $$insert into cron.job(jobname,schedule,command) values($1,$2,$3)
    on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command,active=true returning jobid$$;`);
  for(const name of (await fs.readdir(path.join(cloudRoot,"supabase/migrations"))).filter(n=>n.endsWith(".sql")).sort()){
   try{await db.query(await fs.readFile(path.join(cloudRoot,"supabase/migrations",name),"utf8"));}
   catch(error){throw new Error("Migration "+name+": "+error.message,{cause:error});}
  }
  await allowTestIssuerCredentials(db);await allowRawTestBindings(db);await assertGatewayCloseoutBoundary(db);
  const owner=id(),other=id(),project=id(),decision=id(),session=id();
  await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'owner@synthetic.invalid',now()),($2,'other@synthetic.invalid',now())",[owner,other]);
  await db.query("insert into auth.sessions(id,user_id) values($1,$2)",[session,owner]);
  await db.query("insert into public.clued_projects(id,user_id,name,normalized_name,context_key,certainty_status,confirmed_at) values($1,$2,'Registration recovery','registration recovery',$3,'confirmed',now())",[project,owner,"project:"+project]);
  await db.query(`insert into public.clued_memories(id,user_id,title,content,scope,project_id,record_type,status,record_schema_version,lifecycle_status,
   canonical_scope,type_fields,relations,source_refs,authority,confidence_reason) values($1,$2,'Synthetic approval','Disposable only','project',$3,'decision','active',1,'active',
   $4,'{"rationale":"test fixture"}','{}','{}','user_explicit','Owner confirmed')`,[decision,owner,project,"project:"+project]);
  const native=await connect(),worker=await connect();await native.query("set role authenticated");
  await native.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[owner,JSON.stringify({sub:owner,session_id:session})]);
  await setWorkerGatewayCaller(worker);
  const issuer=sha(id()+id()),clientIssuer=sha(id()),client="registration-oauth-"+id(),resource="https://registration-fixture.invalid/mcp";
  await db.query("insert into clued_private.authorization_issuers_v12(token_hash,resource,name) values($1,$2,'registration-fixture')",[clientIssuer,resource]);
  await db.query("insert into clued_private.storage_oauth_apps_v1(issuer_hash,oauth_client_id,redirect_uri,execution_enabled) values($1,$2,'https://registration-fixture.invalid/storage/google/callback',true)",[issuer,client]);
  const register=async input=>{const value=(await db.query("select public.clued_resource_center_admin_v1($1,$2::jsonb) v",[owner,JSON.stringify({source_decision_id:decision,idempotency_key:id(),...input})])).rows[0].v;
   assert.equal(value.status,"committed",JSON.stringify(value));return value;};
  const suffix=id(),root="/registration-"+suffix+"/Clued_资料中心",rootId="root-"+suffix,parentId="parent-"+suffix,trackId="track-"+suffix,track="20_P_产品与体验";
  const registered=await register({action:"profile_register",project_id:project,profile_version:"registration/"+suffix,managed_root:root,root_folder_id:rootId,root_parent_id:parentId,root_folder_version:"1"});
  const profile=registered.target_refs.find(r=>r.role==="primary").id;
  await register({action:"artifact_register",profile_id:profile,path:root+"/"+track,provider_file_id:trackId,provider_file_version:"1",target_kind:"directory",governance_class:"ordinary",delete_authority:false});
  assert.equal((await db.query("select public.clued_storage_cloud_qualify_v1($1,$2::jsonb) v",[owner,JSON.stringify({profile_id:profile,base_version:1,allowed_root_children:[track],source_decision_id:decision,idempotency_key:id()})])).rows[0].v.status,"committed");
  const connected=(await native.query("select public.clued_storage_account_v1($1::jsonb) v",[JSON.stringify({action:"register",profile_id:profile,source_decision_id:decision,idempotency_key:id()})])).rows[0].v;
  assert.equal(connected.status,"committed",JSON.stringify(connected));const connection=connected.target_refs.find(r=>r.role==="primary").id;
  await db.query("update clued_private.storage_connections_v1 set state='active',provider_subject='registration-fixture-subject',oauth_client_id=$2,credential_version=1,credential_envelope=$3 where id=$1",[connection,client,{contract:"clued.storage-credential/1",key_id:"disposable",nonce:"abcdefghijklmnop",ciphertext:"abcdefghijklmnopqrstuvwxyz"}]);
  const clientId="registration-client-"+id(),token=sha(id());
  const prepared=(await native.query("select public.clued_authorization_prepare_v12($1,$2::jsonb) v",[clientIssuer,JSON.stringify({request_digest:sha(id()),client_id:clientId,client_name:"Disposable registration fixture",redirect_uri:"https://registration-fixture.invalid/client-callback",resource,requested_scopes:["context:write"]})])).rows[0].v;
  const approved=(await native.query("select public.clued_authorization_approve_v12($1,$2,$3,$4::jsonb,$5,$6) v",[clientIssuer,prepared.request_id,prepared.version,JSON.stringify([{resource_kind:"scope",resource_id:"project:"+project,environment:"canonical",actions:["write","close"]}]),token,new Date(Date.now()+10800000).toISOString()])).rows[0].v;
  assert.ok(approved.binding_id,JSON.stringify(approved));
  const lineage=id(),digest=(await db.query("select clued_private.storage_client_request_digest_v2($1) v",[prepared.request_id])).rows[0].v;
  await db.query("insert into clued_private.storage_client_registrations_v2(lineage_id,generation,issuer_hash,resource,client_id,metadata_digest,review_receipt_id) values($1,1,$2,$3,$4,$5,$6)",[lineage,clientIssuer,resource,clientId,digest,connected.receipt_id]);
  await db.query("insert into clued_private.storage_client_request_links_v2(request_id,lineage_id,registration_generation,metadata_digest,review_receipt_id) values($1,$2,1,$3,$4)",[prepared.request_id,lineage,digest,connected.receipt_id]);
  await db.query("insert into clued_private.storage_client_capabilities_v2(lineage_id,registration_generation,receipt_id) values($1,1,$2)",[lineage,connected.receipt_id]);
  const policy=id();await db.query("begin");try{
   await db.query(`insert into clued_private.storage_account_policies_v2(id,owner_id,connection_id,provider,provider_subject,root_folder_id,profile_id,scope_digest,policy_generation,source_decision_id,decision_version,consent_source,disclosure_version,consent_receipt_id)
    select $1,c.owner_id,c.id,c.provider,c.provider_subject,p.root_folder_id,p.id,clued_private.storage_policy_scope_digest_v2(c.id),1,c.source_decision_id,c.decision_version,'reviewed_transition','registration-fixture/1',c.receipt_id
    from clued_private.storage_connections_v1 c join clued_private.resource_center_profiles_v1 p on p.id=c.profile_id where c.id=$2`,[policy,connection]);
   await db.query("update clued_private.storage_account_policies_v2 set state='active',activation_receipt_id=$2 where id=$1",[policy,connected.receipt_id]);
   await db.query("update clued_private.storage_connections_v1 set auth_mode='account_policy',account_policy_id=$2,auth_generation=auth_generation+1 where id=$1",[connection,policy]);await db.query("commit");
  }catch(error){await db.query("rollback");throw error;}
  const status=(await native.query("select public.clued_storage_write_access_v1($1::jsonb) v",[JSON.stringify({action:"status",connection_id:connection})])).rows[0].v;
  assert.equal((await native.query("select public.clued_storage_write_access_v1($1::jsonb) v",[JSON.stringify({action:"set_classes",connection_id:connection,classes:[...status.classes,"overwrite"].sort(),base_generation:status.policy_generation,disclosure_version:status.overwrite_disclosure_version,idempotency_key:id()})])).rows[0].v.status,"committed");
  const folder=(id,name,parent)=>({id,name,parents:parent?[parent]:[],version:"1",trashed:false,mimeType:"application/vnd.google-apps.folder",isAppAuthorized:true});
  const files=new Map([[parentId,folder(parentId,"registration-"+suffix,null)],[rootId,folder(rootId,"Clued_资料中心",parentId)],[trackId,folder(trackId,track,rootId)]]),revisions=new Map();let writes=0;
  const newRevision=(file,bytes)=>{const revision="revision-"+id(),all=revisions.get(file.id)??new Map();revisions.set(file.id,all);
   all.set(revision,{id:revision,keepForever:false,bytes:Buffer.from(bytes)});Object.assign(file,{headRevisionId:revision,size:String(bytes.length),sha256Checksum:sha(bytes),md5Checksum:createHash("md5").update(bytes).digest("hex")});};
  const drive=async(url,init={})=>{const u=new URL(url),parts=u.pathname.split("/"),revisionIndex=parts.indexOf("revisions");
   if(u.pathname==="/batch/drive/v3"){
    assert.equal(init.method,"POST");const replies=[];for(const request of batchRequests(init.body)){
     const response=await drive(new URL(request.path,u.origin),{method:"GET"});replies.push({...request,status:response.status,value:await response.json()});
    }return batchReply(replies);
   }
   if(init.method==="PATCH"){
    writes++;const provider=revisionIndex>0?parts[revisionIndex-1]:parts.at(-1);
    assert.equal((await db.query("select count(*)::int n from clued_private.resource_center_mutations_v1 where state='started' and provider_attempt->>'provider_file_id'=$1",[provider])).rows[0].n,1,"provider write follows its durable original attempt");
    if(revisionIndex>0){const revision=revisions.get(provider).get(parts[revisionIndex+1]);revision.keepForever=JSON.parse(init.body).keepForever;return Response.json({id:revision.id,keepForever:revision.keepForever});}
    assert.equal(u.searchParams.get("uploadType"),"media");const file=files.get(provider);newRevision(file,Buffer.from(init.body));file.version=String(Number(file.version)+2);return Response.json(file);
   }
   if((init.method??"GET")==="POST"){
    writes++;const boundary=/boundary=(.+)$/.exec(new Headers(init.headers).get("content-type"))[1],raw=init.body,
     match=/\{[^\r\n]+"appProperties":\{[^\r\n]+\}\}/.exec(raw),metadata=JSON.parse(match?.[0]??raw),media=raw.split("--"+boundary)[2],content=media.slice(media.indexOf("\r\n\r\n")+4,media.lastIndexOf("\r\n"));
    const created={...metadata,version:"1",trashed:false,isAppAuthorized:true};newRevision(created,Buffer.from(content));files.set(created.id,created);return Response.json(created);
   }
   assert.equal(init.method??"GET","GET","fixture supports no recovery provider mutation");
   if(u.pathname.endsWith("/generateIds"))return Response.json({ids:["file-"+id()]});
   if(revisionIndex>0){const all=revisions.get(parts[revisionIndex-1])??new Map();if(revisionIndex===parts.length-1)return Response.json({revisions:[...all.values()].map(r=>({id:r.id,keepForever:r.keepForever}))});
    const revision=all.get(parts[revisionIndex+1]);if(!revision)return new Response("",{status:404});if(u.searchParams.get("alt")==="media")return new Response(revision.bytes);
    return Response.json({id:revision.id,keepForever:revision.keepForever,size:String(revision.bytes.length),md5Checksum:createHash("md5").update(revision.bytes).digest("hex")});}
   if(parts.at(-1)==="files"){
    const q=u.searchParams.get("q"),parent=/'([^']+)' in parents/.exec(q)?.[1],name=/name = '([^']+)'/.exec(q)?.[1];
    return Response.json({files:[...files.values()].filter(f=>f.parents.includes(parent)&&(!name||f.name===name)),incompleteSearch:false});
   }
   return files.has(parts.at(-1))?Response.json(files.get(parts.at(-1))):new Response("",{status:404});
  };
  const rpc=async(name,proof,input,caller=worker)=>(await caller.query(`select public.${name}($1,$2::jsonb) v`,[proof,JSON.stringify(input)])).rows[0].v;
  const cloud=input=>rpc("clued_storage_cloud_worker_router_v2",issuer,input);
  const submit=async mutation=>{const ref={connection_id:connection,job_id:id()};const out=await rpc("clued_storage_jobs_router_v2",token,{action:"submit",...ref,mutation});assert.equal(out.status,"queued",JSON.stringify(out));return ref;};
  const credential=async expected=>({...expected,access_token:"synthetic-registration-token",scope:"https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly",expires_at_ms:Date.now()+3600000});
  const metadata=createGoogleDriveMetadataApi({get_credential:credential,fetch:drive});
  const requestFor=async ref=>{const loaded=await cloud({action:"load",...ref});assert.equal(loaded.status,"queued",JSON.stringify(loaded));
   const resolve=createGoogleDriveProviderIdentityResolver({managed_root:root,root_folder_id:rootId,root_parent_id:parentId,get_file:metadata.getFile,list_children:metadata.listChildren,get_sharing:metadata.getSharing,get_access:metadata.getAccess,ancestor_match:loaded.ancestor_match});
   return {action:"authority",...ref,credential_version:loaded.credential_version,request:{contract:"clued.resource-center-authority/1",policy_version:RESOURCE_CENTER_POLICY_VERSION,profile_id:profile,profile_version:loaded.profile.profile_version,mutation:bindResourceCenterMutation({...loaded.mutation,artifact_role:"clued_resource"}),provider_identity:await resolve({profile:loaded.profile,mutation:loaded.mutation})}};
  };
  const createOriginal=async()=>{const mutation={operation:"create",target_kind:"file",destination_path:root+"/"+track+"/delivered-"+id()+".txt",content:"original delivered bytes"},ref=await submit(mutation);let loaded;
   const result=await createResourceCenterCloudExecutor({verified_result_mode:true,load_job:async input=>{loaded=await cloud({action:"load",...input});const d={...loaded};delete d.credential_envelope;delete d.oauth_client_id;return d;},get_credential:credential,drive_fetch:drive,rpc:async input=>cloud({...input,...(input.action==="settle_verified"?{}:{credential_version:loaded.credential_version})})}).run(ref);
   assert.equal(result.status,"committed",JSON.stringify(result));const a=(await db.query("select * from clued_private.resource_center_artifacts_v1 where profile_id=$1 and path=$2",[profile,mutation.destination_path])).rows[0];return {ref,mutation,artifact:a};};
  const addFile=async({registeredVersion="43",observedVersion="45",expectedVersion=observedVersion}={})=>{
   const provider="file-"+id(),name="mapping-"+id()+".json",filePath=root+"/"+track+"/"+name;
   await register({action:"artifact_register",profile_id:profile,path:filePath,provider_file_id:provider,provider_file_version:registeredVersion,target_kind:"file",governance_class:"ordinary",delete_authority:false});
   const item={id:provider,name,parents:[trackId],version:observedVersion,trashed:false,mimeType:"application/json",isAppAuthorized:true};newRevision(item,Buffer.from("0123456789"));files.set(provider,item);
   const ref=await submit({operation:"replace",target_kind:"file",destination_path:filePath,destination_file_version:expectedVersion,content:"replacement"}),input=await requestFor(ref);return {ref,input,provider,filePath};};
  const executeWorker=async(ref,observe=async()=>{},options={})=>{const loadModule=async name=>{const out=path.join(dir,name+".mjs");await build({entryPoints:[path.join(cloudRoot,"worker",name+".ts")],outfile:out,bundle:true,platform:"node",format:"esm"});stop();return import(pathToFileURL(out).href);};
   const {createStorageCloudWorker}=await loadModule("storage-cloud-executor"),{createStorageCredentialVault}=await loadModule("storage-credential-vault"),
    vaultConfig={current_key_id:"fixture",keys:{fixture:randomBytes(32).toString("base64url")}},vault=await createStorageCredentialVault(vaultConfig),
    context={owner_id:owner,connection_id:connection,provider:"google-drive",provider_subject:"registration-fixture-subject",oauth_client_id:client,credential_version:1};
   const envelope=await vault.seal(JSON.stringify({token_type:"Bearer",access_token:"synthetic-registration-token",scope:"https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly",expires_at_ms:Date.now()+3600000}),context);
   await db.query("update clued_private.storage_connections_v1 set credential_envelope=$2 where id=$1",[connection,envelope]);
   const actual=await createStorageCloudWorker({client_id:client,vault:vaultConfig,account_policy_v2:true,
    fetch:options.fetch?((...args)=>options.fetch(...args,drive)):drive,
    rpc:async input=>{await observe(input);return options.rpc?options.rpc(input,cloud):cloud(input);}});
   return actual.run(ref);
  };
  await run({db,native,worker,connect,server,owner,other,project,decision,session,issuer,client,token,profile,connection,root,rootId,parentId,trackId,track,
   cloud,rpc,submit,requestFor,addFile,createOriginal,executeWorker,register,files,metadata,getWrites:()=>writes,
   changeHead:(provider,bytes,version)=>{const item=files.get(provider);newRevision(item,Buffer.from(bytes));item.version=version;}});
 }finally{
  for(const c of clients.reverse())await c.end().catch(()=>{});
  if(started)await Promise.race([stopCluster(server),new Promise(resolve=>setTimeout(resolve,5000))]);
  const resolved=await fs.realpath(dir);assert.ok(resolved.startsWith(temp+path.sep),"cleanup remains inside the explicitly created temporary directory");
  await removeTestDirectory(resolved);
 }
}
