import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import test from "node:test";
import {build} from "esbuild";
import {Miniflare} from "miniflare";
import {batchRequests,batchReply} from "./google-batch-fixture.mjs";
const dir=await mkdtemp(path.join(os.tmpdir(),"clued-metadata-batch-")),outfile=path.join(dir,"batch.mjs");
await build({entryPoints:[fileURLToPath(new URL("../worker/storage-google-metadata-batch.ts",import.meta.url))],outfile,bundle:true,platform:"node",format:"esm"});
const {createStorageGoogleMetadataBatch}=await import(pathToFileURL(outfile));
function fixture(handler=parts=>batchReply(parts.map(p=>({...p,value:{id:p.path.split("?")[0].split("/").at(-1)}})))) {
  const calls=[], controller=new AbortController();
  const api=createStorageGoogleMetadataBatch({access_token:"synthetic-batch-access",signal:controller.signal,fetch:async(url,init)=>{
    assert.equal(url,"https://www.googleapis.com/batch/drive/v3");
    assert.equal(init.method,"POST");assert.equal(init.redirect,"manual");
    assert.equal(new Headers(init.headers).get("authorization"),"Bearer synthetic-batch-access");
    const parts=batchRequests(init.body);calls.push(parts);
    for(const p of parts){assert.match(p.path,/^\/drive\/v3\/files/);assert.ok(!p.path.includes("alt="));}
    return handler(parts,init,calls.length);
  }});
  return {api,calls,controller};
}
test("closed transport correlates shuffled IDs, splits at 32 and never accepts injected IDs",async()=>{
  const f=fixture(parts=>batchReply(parts.map(p=>({...p,value:{id:p.path.split("?")[0].split("/").at(-1)}})).reverse()));
  const ids=Array.from({length:65},(_,i)=>"id"+i);
  assert.deepEqual((await f.api.getFiles(ids)).map(v=>v.id),ids);
  assert.deepEqual(f.calls.map(c=>c.length),[32,32,1]);
  for(const ids of [["id","id"],["a\r\nDELETE /"],["https://evil.invalid"],[]])await assert.rejects(f.api.getFiles(ids),/DRIVE_BATCH_INVALID/);
  assert.equal(f.calls.length,3);
});
test("missing, duplicate, extra and unknown response IDs, failed subrequests and malformed MIME reject without fallback",async()=>{
  const cases=[
    parts=>batchReply(parts.slice(1)),
    parts=>batchReply([parts[0],parts[0]]),
    parts=>batchReply([...parts,parts[0]]),
    parts=>batchReply([{...parts[0],id:"unknown"},parts[1]]),
    parts=>batchReply([{...parts[0],status:403},parts[1]]),
    parts=>batchReply(parts,{transform:s=>s.slice(0,-5)}),
    parts=>batchReply(parts,{transform:s=>s.replace("Content-ID:","Content-ID: <forged>\r\nContent-ID:")}),
    parts=>batchReply(parts,{transform:s=>s.replace("Content-Type: application/http","Content-Type: text/plain")}),
    parts=>batchReply(parts,{transform:s=>s.replace("Content-Length: 10","Content-Length: 999")}),
    parts=>batchReply(parts,{transform:s=>s.replace("--batch_fixture_123--","--forged--")}),
  ];
  for(const transform of cases){
    const f=fixture(parts=>transform(parts.map(p=>({...p,value:{id:"a"}}))));
    await assert.rejects(f.api.getFiles(["a","b"]),/DRIVE_(BATCH|METADATA)/);
    assert.equal(f.calls.length,1);
  }
});
test("pagination stays bound to each folder and completes all pages before returning",async()=>{
  let first=true;
  // First page returns a continuation for b only.
  const g=fixture(parts=>{
    if(first){first=false;return batchReply(parts.map(p=>({...p,value:{files:[],...(p.path.includes("%27b%27")?{nextPageToken:"b-next"}:{})}})).reverse());}
    return batchReply(parts.map(p=>{const u=new URL(p.path,"https://www.googleapis.com");assert.equal(u.searchParams.get("q"),"'b' in parents and trashed = false");assert.equal(u.searchParams.get("pageToken"),"b-next");return {...p,value:{files:[{id:"b-child"}]}};}));
  });
  assert.deepEqual(await g.api.listFolders(["a","b"]),[[],[{id:"b-child"}]]);
  assert.deepEqual(g.calls.map(c=>c.length),[2,1]);
});
test("cycles, incompleteSearch, pagination exhaustion and global entry limits fail closed",async()=>{
  for(const [value,reason,maxCalls] of [[{files:[],nextPageToken:"cycle"},/PAGINATION_INVALID/,2],
    [{files:[],incompleteSearch:true},/LIST_INVALID/,1],
    [{files:Array.from({length:5001},()=>({id:"x"}))},/ENUMERATION_LIMIT/,1]]){
    const f=fixture(parts=>batchReply(parts.map(p=>({...p,value}))));
    await assert.rejects(f.api.listFolders(["a","b"]),reason);assert.equal(f.calls.length,maxCalls);
  }
  const f=fixture((parts,_,n)=>batchReply(parts.map(p=>({...p,value:{files:[],nextPageToken:"page"+n}}))));
  await assert.rejects(f.api.listFolders(["a"]),/PAGINATION_LIMIT/);assert.equal(f.calls.length,100);
});
test("appAuthorizedOnly keeps only Clued's entries before the entry limit; the read path keeps everything",async()=>{
  // StorageNormalUse §3.1: a normal (drive.readonly) token lists the Owner's files too.
  const owner=Array.from({length:5001},(_,i)=>({id:"owner"+i,isAppAuthorized:false}));
  const reply=()=>fixture(parts=>batchReply(parts.map(p=>({...p,value:{files:[...owner,{id:"clued-"+p.path.match(/%27([a-z])%27/)[1],isAppAuthorized:true},{id:"unmarked"}]}}))));
  const write=reply();
  assert.deepEqual(await write.api.listFolders(["a","b"],{appAuthorizedOnly:true}),
    [[{id:"clued-a",isAppAuthorized:true}],[{id:"clued-b",isAppAuthorized:true}]]);
  for(const part of write.calls[0])assert.match(new URL(part.path,"https://www.googleapis.com").searchParams.get("fields"),/files\([^)]*isAppAuthorized/);
  await assert.rejects(reply().api.listFolders(["a","b"]),/ENUMERATION_LIMIT/);
  await assert.rejects(reply().api.listFolders(["a"],{appAuthorizedOnly:"yes"}),/DRIVE_BATCH_INVALID/);
});
test("actual streamed-byte and per-part bounds reject before parsing or accepting a prefix",async()=>{
  const f=fixture(parts=>batchReply(parts.map(p=>({...p,value:{id:"a",padding:"x".repeat(2*1024*1024)}}))));
  await assert.rejects(f.api.getFiles(["a"]),/SIZE_LIMIT/);
  let cancelled=false,reads=0;
  const g=fixture(()=>new Response(new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}}),{headers:{"content-type":"multipart/mixed; boundary=x","content-length":"1"}}));
  await assert.rejects(g.api.getFiles(["a"]),/SIZE_LIMIT/);assert.equal(cancelled,true);assert.ok(reads<=18);
});
test("entry overflow in the first batch stops later batches; retained bytes are capped across calls",async()=>{
  const f=fixture(parts=>batchReply(parts.map(p=>({...p,value:{files:Array.from({length:400},()=>({id:"x"}))}}))));
  await assert.rejects(f.api.listFolders(Array.from({length:65},(_,i)=>"folder"+i)),/ENUMERATION_LIMIT/);
  assert.equal(f.calls.length,1);
  const g=fixture(parts=>batchReply(parts.map(p=>({...p,value:{id:"a",padding:"x".repeat(1536*1024)}}))));
  for(let i=0;i<21;i++)assert.equal((await g.api.getFiles(["a"]))[0].id,"a");
  await assert.rejects(g.api.getFiles(["a"]),/SIZE_LIMIT/);assert.equal(g.calls.length,22);
});
test("shared deadline cancels a hung body, and an already expired signal dispatches nothing",async()=>{
  let cancelled=false;
  const f=fixture(()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{"content-type":"multipart/mixed; boundary=x"}}));
  const promise=f.api.getFiles(["a"]);setTimeout(()=>f.controller.abort(),20);
  await assert.rejects(promise,/OBSERVATION_EXPIRED/);assert.equal(cancelled,true);assert.equal(f.calls.length,1);
  await assert.rejects(f.api.getFiles(["b"]),/OBSERVATION_EXPIRED/);assert.equal(f.calls.length,1);
});
test("per-request budget includes response body consumption, not just response headers",async()=>{
  let cancelled=false;
  const f=fixture(()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{"content-type":"multipart/mixed; boundary=x"}}));
  const keepAlive=setTimeout(()=>{},11000);
  try{await assert.rejects(f.api.getFiles(["a"]),/DRIVE_BATCH_TIMEOUT/);assert.equal(cancelled,true);assert.equal(f.calls.length,1);}
  finally{clearTimeout(keepAlive);}
});
test("native workerd multipart roundtrip preserves metadata-only request envelope and rejects redirects",async()=>{
  const {outputFiles}=await build({stdin:{resolveDir:fileURLToPath(new URL("../",import.meta.url)),sourcefile:"batch-runtime.ts",contents:`
import {createStorageGoogleMetadataBatch} from './worker/storage-google-metadata-batch.ts';
export default {async fetch(){try {const api=createStorageGoogleMetadataBatch({access_token:'synthetic-batch-access',signal:AbortSignal.timeout(20000)});return Response.json(await api.getFiles(['a','b']));}catch{return Response.json({denied:true});}}};`},bundle:true,platform:"node",format:"esm",write:false});
  let redirect=false,calls=0;
  const runtime=new Miniflare({host:"127.0.0.1",port:0,cf:false,telemetry:{enabled:false},workers:[{
    config:{name:"batch-runtime-fixture",type:"worker",compatibilityDate:"2026-08-23",compatibilityFlags:["nodejs_compat","global_fetch_strictly_public"],manifest:{mainModule:"worker.js",modules:{"worker.js":{type:"esm",contents:outputFiles[0].text}}}},
    dev:{outboundService:{type:"fetcher",handler:async request=>{
      calls++;assert.equal(request.url,"https://www.googleapis.com/batch/drive/v3");assert.equal(request.method,"POST");
      assert.equal(request.headers.get("authorization"),"Bearer synthetic-batch-access");
      if(redirect)return new Response(null,{status:302,headers:{location:"https://never-follow.invalid"}});
      return batchReply(batchRequests(await request.text()).map(p=>({...p,value:{id:p.path.split("?")[0].split("/").at(-1)}})).reverse());
    }}}}]});
  try{assert.deepEqual(await(await runtime.dispatchFetch("http://localhost/")).json(),[{id:"a"},{id:"b"}]);
    redirect=true;assert.deepEqual(await(await runtime.dispatchFetch("http://localhost/")).json(),{denied:true});assert.equal(calls,2);}
  finally{await runtime.dispose();}
});
