// Evaluated from captured, SHA-pinned bytes by Root's fixed Node bootstrap.
// payload is closed base64 JSON generated only inside Root's Host scope.
return (async()=>{
 const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
 const fail=c=>{throw Error(c);},need=(v,c)=>{if(!v)fail(c);};
 const text=Buffer.from(payload,'base64').toString('utf8'),q=JSON.parse(text);
 need(JSON.stringify(q)===text&&Object.keys(q).sort().join('|')==='head_sha|repository|schema|target_branch|workflow','EPOCH_CLOSED_INPUT');
 need(q.schema==='clued.root-ci-epoch-observation-request181/1'&&q.repository==='tdoljyj/cross-memory-system'&&/^[0-9a-f]{40}$/.test(q.head_sha)&&q.target_branch==='main'&&q.workflow==='clued-standard-runner-actor-qualification.yml','EPOCH_EXACT_SUBJECT');
 const config='C:/w/relay-qual-169/combined-source190/apps/clued-cloud/app/supabase-public-config.ts';
 for(let p=path.resolve(config);;p=path.dirname(p)){const s=fs.lstatSync(p);need(!s.isSymbolicLink(),'CONFIG_REPARSE');if(path.dirname(p)===p)break;}
 const fd=fs.openSync(config,'r');let raw;try{const s=fs.fstatSync(fd);need(s.isFile()&&s.nlink===1&&s.size<=8192,'CONFIG_FILE_BOUND');raw=fs.readFileSync(fd);const after=fs.fstatSync(fd);need(s.ino===after.ino&&s.size===after.size&&s.mtimeMs===after.mtimeMs,'CONFIG_CHANGED');}finally{fs.closeSync(fd);}
 const blob=crypto.createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex');need(blob==='193fedd8e9d5ccaea873e2cc4d0efd894e93d6ae','CONFIG_EXACT_GIT_BLOB');
 const m=/return \{ url: "(https:\/\/[^"]+)", key: "(sb_publishable_[A-Za-z0-9_-]+)" \};/.exec(raw.toString('utf8'));need(m,'PUBLIC_CONFIG_ONLY');
 const u=new URL(m[1]);need(u.protocol==='https:'&&u.username===''&&u.password===''&&u.pathname==='/'&&u.search===''&&u.hash==='','PUBLIC_ORIGIN_ONLY');
 const result=await fetch(u.origin+'/rest/v1/rpc/clued_work_verify_v1',{method:'POST',redirect:'error',signal:AbortSignal.timeout(2000),headers:{apikey:m[2],authorization:'Bearer '+m[2],'content-type':'application/json'},body:JSON.stringify({p_token_hash:null,p_input:{action:'execution_current',repository:q.repository,head_sha:q.head_sha,target_branch:q.target_branch,workflow:q.workflow}})});
 need(result.status===200,'EPOCH_HTTP_STATUS');let size=0,chunks=[];for await(const chunk of result.body){size+=chunk.length;need(size<=16384,'EPOCH_RESPONSE_BOUND');chunks.push(chunk);}
 const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
 need(value&&Object.keys(value).sort().join('|')==='epoch_current|guard_required|status'&&value.status==='ok'&&typeof value.guard_required==='boolean'&&(value.guard_required?typeof value.epoch_current==='boolean':value.epoch_current===null),'EPOCH_RAW_PROJECTION_TYPES');
 console.log(JSON.stringify({schema:'clued.root-ci-epoch-observation181/1',subject:{repository:q.repository,head_sha:q.head_sha,target_branch:q.target_branch,workflow:q.workflow},http_status:result.status,observed_at_ms:Date.now(),projection:value}));
})().catch(()=>{console.log(JSON.stringify({schema:'clued.root-public-epoch-refusal181/1',status:'REFUSED_OR_UNKNOWN_NO_RETRY'}));process.exitCode=2;});
