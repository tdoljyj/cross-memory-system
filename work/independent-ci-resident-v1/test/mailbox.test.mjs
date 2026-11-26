import test from 'node:test';
import assert from 'node:assert/strict';
import {REQUEST_CONTRACT,RESPONSE_CONTRACT,validateResponse} from '../src/mailbox.mjs';
import {Companion,parsePull} from '../src/companion.mjs';
import {lane} from '../src/companion-main.mjs';
import {mailboxCompanion} from '../src/service-ports.mjs';

const start=Date.parse('2026-11-03T12:21:46.690Z');
const request={contract:REQUEST_CONTRACT,requestId:'abc0f111-867b-44ad-aa49-37c91a90fb03',kind:'pr-head',
  batchId:'0000000000000000-000000000000',pr:984,createdAt:new Date(start).toISOString(),deadline:new Date(start+120000).toISOString()};
const mergeSha='1eabe1cbd887d8d8166e7cf6b78c57b0948e4a42';
const pull={number:984,state:'merged',headSha:'a'.repeat(40)};
const response=(fields={},now=start)=>({contract:RESPONSE_CONTRACT,requestId:request.requestId,kind:request.kind,
  ok:true,code:null,proof:null,directory:null,verified:null,usage:null,pull,jobTree:null,memory:null,prune:null,
  observedAt:new Date(now).toISOString(),...fields});
const refuses=(value,q=request)=>assert.throws(()=>validateResponse(value,q),{code:'MAILBOX_RESPONSE_PULL_REFUSED'});

test('optional mergeSha retains exact legacy replies and one typed advisory SHA',()=>{
  const old=response(),current=response({pull:{...pull,mergeSha}});
  assert.equal(validateResponse(old,request),old);
  assert.equal(validateResponse(current,request),current);
  assert.equal(current.pull.mergeSha,mergeSha);
  assert.equal(RESPONSE_CONTRACT,'clued.independent-ci.resident-companion-response/4');
  for(const state of ['open','closed','merged'])assert.equal(validateResponse(response({pull:{...pull,state,mergeSha}}),request).pull.state,state);
});

test('mergeSha rejects coercion, LF/CRLF, null, nonhex and every other extra field',()=>{
  for(const value of [null,undefined,false,true,0,1,{},[],[mergeSha],new String(mergeSha),
    '',mergeSha.slice(1),mergeSha+'0',mergeSha.toUpperCase(),'g'.repeat(40),mergeSha+'\n',mergeSha+'\r\n','\n'+mergeSha]){
    refuses(response({pull:{...pull,mergeSha:value}}));
  }
  for(const value of [{...pull,extra:true},{...pull,mergeSha,extra:true},{...pull,mergeSha,command:'arbitrary'},
    {...pull,mergeSha,number:985},{...pull,mergeSha,state:'unknown'},{...pull,mergeSha,headSha:'invalid'}])refuses(response({pull:value}));
  refuses(response({pull:{number:984,state:'merged',mergeSha}}));
});

test('optional pull metadata remains exclusive to pr-head and other response guards stay closed',()=>{
  const other={...request,kind:'linux-quiescence'};
  refuses(response({kind:other.kind,pull:{...pull,mergeSha}}),other);
  assert.throws(()=>validateResponse({...response(),extra:true},request),{code:'MAILBOX_RESPONSE_KEYS_REFUSED'});
  assert.throws(()=>validateResponse(response({requestId:'00000000-0000-4000-8000-000000000000'}),request),{code:'MAILBOX_RESPONSE_IDENTITY_REFUSED'});
  assert.throws(()=>validateResponse(response({ok:'true'}),request),{code:'MAILBOX_RESPONSE_STATUS_REFUSED'});
});

test('actual parsePull and service adapter preserve the merged/ref-move metadata',async()=>{
  // The merge SHA is from the already-read PR984 metadata. Other values are
  // inert fixtures: no GitHub read, child process or real mailbox operation.
  const parsed=parsePull(JSON.stringify({number:984,state:'closed',merged:true,head:pull.headSha,mergeSha}),984);
  assert.deepEqual(parsed,{...pull,mergeSha});
  const observed=validateResponse(response({pull:parsed}),request);
  let sent=null;
  const port=mailboxCompanion({send:async(kind,fields,timeout)=>{sent={kind,fields,timeout};return request;},
    await:async()=>observed},async()=>{});
  assert.equal((await port.prHead(984)).mergeSha,mergeSha);
  assert.deepEqual(sent,{kind:'pr-head',fields:{batchId:request.batchId,pr:984},timeout:120000});
});

test('real step/lane answer a merged PR on first pass instead of looping until expiry',async()=>{
  let now=start,answer=null,calls=0,steps=0,rejections=0;
  const self=new Companion({cfg:{},clock:()=>now,readPull:()=>['fixture:no-OS'],
    run:async()=>{calls++;return{code:0,stdout:JSON.stringify({number:984,state:'closed',merged:true,head:pull.headSha,mergeSha})};},
    mailbox:{beat:async()=>{},pending:async()=>answer?[]:[request],
      respond:async(q,fields)=>{try{answer=validateResponse(response({ok:false,...fields,pull:fields.pull??null},now),q);return answer;}catch(e){rejections++;throw e;}}}});
  await lane({runner:{busy:false},work:async()=>{steps++;await self.step();},
    sleep:async ms=>{now+=ms;},everyMs:2000,stop:()=>answer!==null||steps>65});
  assert.equal(steps,1);assert.equal(calls,1);assert.equal(rejections,0);
  assert.equal(answer.ok,true);assert.equal(answer.code,null);assert.equal(answer.pull.state,'merged');
  assert.equal(answer.pull.mergeSha,mergeSha);assert.equal(Date.parse(answer.observedAt),start);
});

test('real step still refuses expired requests without calling the PR handler',async()=>{
  let calls=0,answer=null;
  const now=Date.parse(request.deadline)+1;
  const companion=new Companion({cfg:{},clock:()=>now,mailbox:{beat:async()=>{},pending:async()=>[request],
    respond:async(q,fields)=>{answer=validateResponse(response({ok:false,pull:null,...fields},now),q);}},
    run:async()=>{calls++;throw Error('EXPIRED_HANDLER_FORBIDDEN');}});
  await companion.step();
  assert.equal(calls,0);assert.equal(answer.ok,false);assert.equal(answer.code,'COMPANION_REQUEST_EXPIRED');
});
