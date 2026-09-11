import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {planSourceBatches} from './control-context-verifier-root5-window5-forward11-successor/source-publication.mjs';
import {planRefs} from './control-context-verifier-original-input-capacity-successor/ref-plan.mjs';
const refs=n=>Array.from({length:n},(_,i)=>({uri:'https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/'+i.toString(16).padStart(40,'0'),sha256:i.toString(16).padStart(64,'0')}));
test('128/129/131 ordered source refs use the unchanged 128-item primitive',()=>{for(const n of [128,129,131]){const r=refs(n),plan=planSourceBatches(r,new Array(n).fill(1));assert.deepEqual(plan.batches.map(x=>x.refs.length),n===128?[128]:[128,n-128]);assert.deepEqual(plan.batches.flatMap(x=>x.refs),r);for(const b of plan.batches)assert.doesNotThrow(()=>planRefs(b.refs,b.sizes));}assert.throws(()=>planRefs(refs(131),new Array(131).fill(1)),/BOUNDED_EXACT_REFS_AND_TREE_SIZES/);});
const source=fs.readFileSync(new URL('./control-context-verifier-root5-window5-forward11-successor/source-publication.mjs',import.meta.url),'utf8');
const body=source.slice(source.indexOf('export function planSourceBatches'),source.indexOf('export function verifySourcePublication')).replaceAll('export function','function');
// Test-only module isolation injects a reader double into exact source bytes.
// The production reader has no callback or caller-selected executor parameter.
const isolated=reader=>new Function('planRefs','readSourceBlobRefsBounded','need',body+';return readCompleteSourceSet;')(planRefs,reader,(v,m)=>{if(!v)throw Error(m);});
test('missing sizes and a malformed last ref fail before any network reader',()=>{let calls=0;const run=isolated(()=>calls++),r=refs(131);assert.throws(()=>run(r,[1]));r[130].uri='invalid';assert.throws(()=>run(r,new Array(131).fill(1)));assert.equal(calls,0);});
test('a contradictory same URI across two batches fails before any reader',()=>{let calls=0;const run=isolated(()=>calls++),r=refs(131);r[130].uri=r[0].uri;assert.throws(()=>run(r,new Array(131).fill(1)),/CONTRADICTORY_CROSS_BATCH_SOURCE/);assert.equal(calls,0);});
test('a full-source encoding estimate over the preserved allowance fails before reads',()=>{let calls=0;assert.throws(()=>isolated(()=>calls++)(refs(2),[20000000,20000000]),/PLANNED_FULL_SOURCE_ENCODING_LIMIT/);assert.equal(calls,0);});
test('any failed batch rejects the complete source read',()=>{let calls=0;assert.throws(()=>isolated(()=>{if(++calls===2)throw Error('actual reader failure');})(refs(131),new Array(131).fill(1)),/actual reader failure/);assert.equal(calls,2);});
test('successful reads retain every original source in order and grant no authority',()=>{const received=[],r=refs(131),result=isolated(batch=>received.push(...batch))(r,new Array(131).fill(1));assert.deepEqual(received,r);assert.equal(result.count,131);assert.equal(result.authority_effect,'NONE');});
