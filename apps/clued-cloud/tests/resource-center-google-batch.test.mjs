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
function fixture(handler=parts=>batchReply(parts.map(p=>({...p,value:{id:p.path.split("?")[0].split("/").at(-1)}}))),extra={}) {
  const calls=[], controller=new AbortController();
  const api=createStorageGoogleMetadataBatch({access_token:"synthetic-batch-access",signal:controller.signal,...extra,fetch:async(url,init)=>{
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
  const f=fixture(()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{"content-type":"multipart/mixed; boundary=x"}}),
    {batch_timeout_ms:50});
  // Without transient_retry (the probe's default) a timeout is never retried.
  // AbortSignal.timeout does not keep Node's event loop alive on its own.
  const keepAlive=setTimeout(()=>{},5000);
  try{await assert.rejects(f.api.getFiles(["a"]),/DRIVE_BATCH_TIMEOUT/);assert.equal(cancelled,true);assert.equal(f.calls.length,1);
    // With transient_retry: timed out once, retried once (a new request), then fails closed.
    cancelled=false;
    const g=fixture(()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{"content-type":"multipart/mixed; boundary=x"}}),
      {batch_timeout_ms:50,transient_retry:true,retry_delay_ms:()=>0});
    const warn=console.warn;console.warn=()=>{};
    try{await assert.rejects(g.api.getFiles(["a"]),/DRIVE_BATCH_TIMEOUT/);}finally{console.warn=warn;}
    assert.equal(cancelled,true);assert.equal(g.calls.length,2);}
  finally{clearTimeout(keepAlive);}
  assert.throws(()=>createStorageGoogleMetadataBatch({access_token:"synthetic-batch-access",signal:AbortSignal.timeout(1000),batch_timeout_ms:20000}),/DRIVE_BATCH_INVALID/);
});
test("transient 429 / 5xx / timeout batches are retried exactly once; others are not",async()=>{
  const warnings=[],warn=console.warn;console.warn=w=>warnings.push(w);
  try{
    const ok=parts=>batchReply(parts.map(p=>({...p,value:{id:p.path.split("?")[0].split("/").at(-1)}})));
    // Envelope 429, part 429, envelope 503, part 500: one retry, then success.
    for(const first of [()=>new Response("rate",{status:429}),parts=>batchReply(parts.map(p=>({...p,status:429,value:{error:{code:429}}}))),
      ()=>new Response("down",{status:503}),parts=>batchReply([{...parts[0],status:500,value:{}},...parts.slice(1).map(p=>({...p,value:{id:"x"}}))])]){
      const f=fixture((parts,init,n)=>n===1?first(parts):ok(parts),{transient_retry:true,retry_delay_ms:()=>0});
      assert.deepEqual((await f.api.getFiles(["a"])).map(v=>v.id),["a"]);assert.equal(f.calls.length,2);
    }
    // Persistent 429: exactly two requests, then the closed code.
    const p=fixture(()=>new Response("rate",{status:429}),{transient_retry:true,retry_delay_ms:()=>0});
    await assert.rejects(p.api.getFiles(["a"]),/DRIVE_BATCH_HTTP_429/);assert.equal(p.calls.length,2);
    // Non-transient codes are never retried.
    for(const code of [401,403,404,400]){
      const f=fixture(()=>new Response("no",{status:code}),{transient_retry:true,retry_delay_ms:()=>0});
      await assert.rejects(f.api.getFiles(["a"]),new RegExp("DRIVE_BATCH_HTTP_"+code));assert.equal(f.calls.length,1);
    }
    // A fetch rejecting with a platform TimeoutError is retried once.
    const t=fixture((parts,init,n)=>{if(n===1)throw new DOMException("timed out","TimeoutError");return ok(parts);},{transient_retry:true,retry_delay_ms:()=>0});
    assert.deepEqual((await t.api.getFiles(["a"])).map(v=>v.id),["a"]);assert.equal(t.calls.length,2);
    // A hung first attempt under the injected short timeout is retried once.
    const h=fixture((parts,init,n)=>n===1?new Response(new ReadableStream({}),{headers:{"content-type":"multipart/mixed; boundary=x"}}):ok(parts),
      {batch_timeout_ms:50,transient_retry:true,retry_delay_ms:()=>0});
    const keepAlive=setTimeout(()=>{},5000);
    try{assert.deepEqual((await h.api.getFiles(["a"])).map(v=>v.id),["a"]);assert.equal(h.calls.length,2);}
    finally{clearTimeout(keepAlive);}
    // The shared deadline wins over the retry delay: no second request.
    const d=fixture(()=>new Response("rate",{status:429}),{transient_retry:true,retry_delay_ms:()=>1000});
    const pending=d.api.getFiles(["a"]);setTimeout(()=>d.controller.abort(),20);
    await assert.rejects(pending,/OBSERVATION_EXPIRED/);assert.equal(d.calls.length,1);
    // Default (probe): a transient code is not retried.
    const n=fixture(()=>new Response("rate",{status:429}));
    await assert.rejects(n.api.getFiles(["a"]),/DRIVE_BATCH_HTTP_429/);assert.equal(n.calls.length,1);
    assert.ok(warnings.length>0);
    for(const w of warnings)assert.deepEqual(Object.keys(w).sort(),["code","event","outcome"]);
    assert.ok(warnings.every(w=>w.event==="storage_read_drive_transient"&&w.outcome==="retried"&&/^DRIVE_BATCH_(TIMEOUT|HTTP_429|HTTP_500)$/.test(w.code)));
  } finally{console.warn=warn;}
});
test("the retry goes through the caller's budgeted fetch",async()=>{
  let used=0;
  const api=createStorageGoogleMetadataBatch({access_token:"synthetic-batch-access",signal:AbortSignal.timeout(5000),transient_retry:true,retry_delay_ms:()=>0,fetch:async(url,init)=>{
    if(++used>1)throw new Error("DRIVE_READ_BUDGET");
    return new Response("rate",{status:429});
  }});
  const warn=console.warn;console.warn=()=>{};
  try{await assert.rejects(api.getFiles(["a"]),/DRIVE_READ_BUDGET/);assert.equal(used,2);}finally{console.warn=warn;}
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

// Decision 24422a98: as Drive asks, rate limits and 5xx are backed off and
// retried up to transient_retries times; a rate-limit 403 counts as a 429,
// any other 403 stays final.
test("transient_retries backs off with a growing delay; a rate-limit 403 part is retried, another 403 is not",async()=>{
  const warn=console.warn;console.warn=()=>{};
  try{
    const ok=parts=>batchReply(parts.map(p=>({...p,value:{id:p.path.split("?")[0].split("/").at(-1)}})));
    const delays=[];
    const r=fixture((parts,init,n)=>n<=3?new Response("rate",{status:429}):ok(parts),{transient_retries:3,retry_delay_ms:retry=>{delays.push(retry);return 0;}});
    assert.deepEqual((await r.api.getFiles(["a"])).map(v=>v.id),["a"]);assert.equal(r.calls.length,4);assert.deepEqual(delays,[0,1,2]);
    const exhausted=fixture(()=>new Response("rate",{status:429}),{transient_retries:2,retry_delay_ms:()=>0});
    await assert.rejects(exhausted.api.getFiles(["a"]),/DRIVE_BATCH_HTTP_429/);assert.equal(exhausted.calls.length,3);
    const limited=fixture((parts,init,n)=>n===1?batchReply(parts.map(p=>({...p,status:403,value:{error:{code:403,errors:[{reason:"userRateLimitExceeded"}]}}}))):ok(parts),
      {transient_retries:1,retry_delay_ms:()=>0});
    assert.deepEqual((await limited.api.getFiles(["a"])).map(v=>v.id),["a"]);assert.equal(limited.calls.length,2);
    const forbidden=fixture(parts=>batchReply(parts.map(p=>({...p,status:403,value:{error:{code:403,errors:[{reason:"insufficientFilePermissions"}]}}}))),
      {transient_retries:3,retry_delay_ms:()=>0});
    await assert.rejects(forbidden.api.getFiles(["a"]),/DRIVE_BATCH_HTTP_403/);assert.equal(forbidden.calls.length,1);
    assert.throws(()=>createStorageGoogleMetadataBatch({access_token:"synthetic-batch-access",signal:AbortSignal.timeout(1000),transient_retries:4}),/DRIVE_BATCH_INVALID/);
  }finally{console.warn=warn;}
});
