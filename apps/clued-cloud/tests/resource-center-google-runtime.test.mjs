import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// Native workerd fetch, not an injected JS mock: this catches RequestInit modes
// accepted by Node but rejected at the edge. Outbound IO is synthetic-only.
const { outputFiles } = await build({ stdin: { resolveDir: fileURLToPath(new URL("../", import.meta.url)),
  sourcefile: "google-runtime.ts", contents: `
import {createStorageGoogleOAuth} from './worker/storage-google-oauth.ts';
import {createStorageFetch} from './worker/storage-fetch.ts';
export default {async fetch(request){
 const mode=new URL(request.url).pathname;
 if(mode==='/legacy'){
   try{await fetch('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error'});return Response.json({rejected:false});}
   catch{return Response.json({rejected:true});}
 }
 if(mode==='/adapter'){
   try{await createStorageFetch()('https://www.googleapis.com/drive/v3/files',{method:'POST',redirect:'error',body:'fixture'});return Response.json({rejected:false});}
   catch{return Response.json({rejected:true});}
 }
 const owner=crypto.randomUUID(),connection=crypto.randomUUID();let pending,committed=0,claimed=false;
 const d={owner_id:owner,connection_id:connection,connection_version:1,credential_version:1,provider_subject:null,
 oauth_client_id:'fixture.apps.googleusercontent.com',redirect_uri:'https://clued.invalid/storage/google/callback',root_folder_id:'root',root_parent_id:'parent'};
 const oauth=await createStorageGoogleOAuth({client_id:d.oauth_client_id,client_secret:'fixture-only-client-secret',redirect_uri:d.redirect_uri,
 vault:{current_key_id:'fixture',keys:{fixture:btoa('b'.repeat(32)).replace(/=+$/,'')}},rpc:async i=>{
 if(i.action==='describe')return d;if(i.action==='prepare'){pending=i;return {status:'prepared'};}
 if(i.action==='claim'){if(claimed)throw Error('already-claimed');claimed=true;return {...d,status:'claimed',attempt_id:pending.attempt_id,verifier_envelope:pending.verifier_envelope};}
 if(i.action==='complete'){committed++;return {status:'completed',receipt_id:crypto.randomUUID()};}throw Error('unexpected');}});
 const url=new URL((await oauth.start(connection)).authorization_url);
 const input={state:url.searchParams.get('state'),code:'fixture-code/+=='};
 let result;try{result=await oauth.complete(input);}catch(e){result={reason:e.reason};}
 try{await oauth.complete(input);}catch{}
 return Response.json({...result,committed,challenge:url.searchParams.get('code_challenge')});
}};` }, bundle: true, platform: "node", format: "esm", write: false });

test("native Worker OAuth encodes PKCE/form correctly, refuses redirects and never re-exchanges", async () => {
  let mode="success", calls=[], tokenBody;
  const scope="https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly";
  const runtime=new Miniflare({host:"127.0.0.1",port:0,cf:false,telemetry:{enabled:false},workers:[{
    config:{name:"google-runtime-fixture",type:"worker",compatibilityDate:"2026-08-23",compatibilityFlags:["nodejs_compat","global_fetch_strictly_public"],
      manifest:{mainModule:"worker.js",modules:{"worker.js":{type:"esm",contents:outputFiles[0].text}}}},
    dev:{outboundService:{type:"fetcher",handler:async request=>{
      calls.push(request.url);
      assert.ok(["oauth2.googleapis.com","www.googleapis.com"].includes(new URL(request.url).hostname));
      if(typeof mode==="number") return new Response("fixture-secret-body",{status:mode,headers:{location:"https://never-follow.invalid/credential-leak"}});
      if(request.url.endsWith("/token")){
        tokenBody=new URLSearchParams(await request.text());
        if(mode==="rejected")return Response.json({error:"invalid_grant",error_description:"fixture-secret-body"},{status:400});
        return Response.json({access_token:"fixture-access-token",refresh_token:"fixture-refresh-token",token_type:"Bearer",expires_in:3600,scope});
      }
      assert.equal(request.headers.get("authorization"),"Bearer fixture-access-token");
      if(request.url.includes("/about?"))return Response.json({user:{me:true,permissionId:"fixture-user"}});
      return Response.json({id:"root",mimeType:"application/vnd.google-apps.folder",trashed:false,parents:["parent"],isAppAuthorized:true,capabilities:{canAddChildren:true}});
    }}}}]});
  try{
    assert.deepEqual(await (await runtime.dispatchFetch("http://localhost/legacy")).json(),{rejected:true});
    assert.equal(calls.length,0,"legacy redirect:error throws before outbound IO");
    let result=await (await runtime.dispatchFetch("http://localhost/oauth")).json();
    assert.equal(result.status,"completed");assert.equal(result.committed,1);assert.equal(calls.length,3);
    assert.equal(tokenBody.get("code"),"fixture-code/+==");assert.equal(tokenBody.get("client_secret"),"fixture-only-client-secret");
    assert.equal(createHash("sha256").update(tokenBody.get("code_verifier")).digest("base64url"),result.challenge);
    mode="rejected";calls=[];
    result=await (await runtime.dispatchFetch("http://localhost/oauth")).json();
    assert.equal(result.reason,"token_invalid_grant");assert.equal(result.committed,0);assert.equal(calls.length,1);
    assert.equal(JSON.stringify(result).includes("fixture-secret-body"),false);
    for(mode of [301,302,303,307,308]){
      calls=[];result=await (await runtime.dispatchFetch("http://localhost/oauth")).json();
      assert.equal(result.reason,"token_transport_unconfirmed");assert.equal(result.committed,0);assert.equal(calls.length,1);
      calls=[];assert.deepEqual(await (await runtime.dispatchFetch("http://localhost/adapter")).json(),{rejected:true});
      assert.equal(calls.length,1,"cloud adapter never follows a credential-bearing redirect");
    }
  }finally{await runtime.dispose();}
});
