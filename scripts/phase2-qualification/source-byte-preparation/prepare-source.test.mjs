import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {prepareSourceBytes,limits} from './prepare-source.mjs';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const input=(bytes,extra={})=>({bytes,source_ref:'synthetic:session-a',expected_content_hash:hash(bytes),expected_size_bytes:bytes.length,...extra});

test('exact bytes survive UTF-8 boundaries, BOM, CRLF, combining marks and source attribution',()=>{
 const bytes=Buffer.from('\ufeff来源A\r\n保留😀和e\u0301，不归一化。\n');
 for(const chunk_bytes of [4,5,7,16,4096]){
  const result=prepareSourceBytes(input(bytes,{chunk_bytes}));
  assert.deepEqual(Buffer.concat(result.chunks.map(x=>Buffer.from(x.text))),bytes);
  let next=0;
  for(const part of result.chunks){assert.equal(part.byte_start,next);assert.ok(part.byte_end_exclusive-part.byte_start<=chunk_bytes);assert.equal(part.content_hash,hash(bytes.subarray(part.byte_start,part.byte_end_exclusive)));assert.equal(part.source_content_hash,hash(bytes));assert.equal(part.source_ref,'synthetic:session-a');next=part.byte_end_exclusive;}
  assert.equal(next,bytes.length);assert.equal(result.token_count,null);assert.equal(result.authority_effect,'NONE');
 }
});
test('damaged bytes, wrong sizes, invalid UTF-8 and exceeded bounds are rejected',()=>{
 const original=Buffer.from('fixed source'),changed=Buffer.from(original);changed[0]^=1;
 assert.throws(()=>prepareSourceBytes({...input(original),bytes:changed}),/digest/);
 assert.throws(()=>prepareSourceBytes(input(original,{expected_size_bytes:original.length+1})),/size mismatch/);
 for(const bytes of [Buffer.from([0xc0,0xaf]),Buffer.from([0xed,0xa0,0x80]),Buffer.from([0xf0,0x9f])])assert.throws(()=>prepareSourceBytes(input(bytes)),/encoded data/);
 assert.throws(()=>prepareSourceBytes(input(Buffer.alloc(limits.maxSourceBytes+1))),/bound/);
 assert.throws(()=>prepareSourceBytes(input(Buffer.from('a'),{chunk_bytes:3})),/chunk byte limit/);
 assert.throws(()=>prepareSourceBytes(input(Buffer.alloc(4*(limits.maxChunks+1),0x61),{chunk_bytes:4})),/Chunk count/);
});
test('empty source and repeated bytes are deterministic without collapsing distinct source identities',()=>{
 const empty=prepareSourceBytes(input(Buffer.alloc(0)));assert.deepEqual(empty.chunks,[]);assert.equal(empty.source.size_bytes,0);
 const bytes=Buffer.from('same exact content');
 const a=prepareSourceBytes(input(bytes)),again=prepareSourceBytes(input(bytes));assert.deepEqual(a,again);
 const b=prepareSourceBytes(input(bytes,{source_ref:'synthetic:session-b'}));
 assert.equal(a.source.content_hash,b.source.content_hash);assert.notEqual(a.chunks[0].source_ref,b.chunks[0].source_ref);
 assert.equal(a.persisted,false);assert.equal(a.source_ownership_verified,false);
 bytes.fill(0);assert.equal(a.chunks[0].text,'same exact content');
});
