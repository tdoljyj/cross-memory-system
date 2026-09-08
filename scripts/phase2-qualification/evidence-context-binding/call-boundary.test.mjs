import assert from 'node:assert/strict';
import test from 'node:test';
import {readAndCompileWithSources} from './compiler-with-sources.mjs';
test('fabricated tokenizer is rejected before any database call',async()=>{
 let calls=0;
 await assert.rejects(readAndCompileWithSources({client:{async query(){calls++;throw Error('must not query');}},contextKey:'global',policy:{context_key:'global'},query:'orbit',tokenizer:{count:()=>1},sourceBytes:new Map()}),/TOKENIZER_NOT_BOUND/);
 assert.equal(calls,0);
});
