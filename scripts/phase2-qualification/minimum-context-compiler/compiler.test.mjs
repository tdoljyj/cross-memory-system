import assert from 'node:assert/strict';
import test from 'node:test';
import {createTokenizer,target} from './tokenizer.mjs';
import {compileSearchResult} from './compiler.mjs';
const tokenizer=await createTokenizer();
const fixture=()=>({status:'ok',mode:'lexical',context_key:'global',query:'orbit',results:[{kind:'record',id:'orbit-task',version:3,scope:'global',record_type:'task',record_schema_version:1,status:'active',lifecycle_status:'active',title:'Orbit checklist',content:'Only local scratch output; no external calls. Evaluate orbit timing.',updated_at:'2026-09-08T00:00:00Z',type_fields:{internal_note:'SYNTHETIC_UNSELECTED_FIELD'}}]});
const policy=()=>({context_key:'global',task:'Prepare orbit checklist context',token_budget:2048,required_records:[{id:'orbit-task',version:3,fields:['title','content','updated_at']}],critical_constraints:[{record_id:'orbit-task',field:'content',exact_text:'Only local scratch output; no external calls.'}]});
test('real pinned o200k encoder counts actual full pack, preserves source/version/time/constraints and excludes unselected fields',()=>{
 const compiled=compileSearchResult(fixture(),policy(),tokenizer);assert.equal(compiled.token_count,tokenizer.count(compiled.text));assert.ok(compiled.token_count<=2048);
 assert.equal(tokenizer.roundtrip(compiled.text),compiled.text);assert.equal(tokenizer.roundtrip('中文 😀 e\u0301 <|endoftext|>'),'中文 😀 e\u0301 <|endoftext|>');
 assert.match(compiled.text,/Only local scratch output; no external calls/);assert.match(compiled.text,/2026-09-08T00:00:00Z/);
 assert.ok(!compiled.text.includes('SYNTHETIC_UNSELECTED_FIELD'));assert.equal(compiled.provenance.selected_records[0].version,3);
 console.log(JSON.stringify({actual_target:target.model_mapping,encoding:target.encoding,actual_pack_tokens:compiled.token_count,pack_sha256:compiled.text_sha256,model_calls:0}));
});
test('oversized required context is rejected instead of truncating critical constraints or estimating token counts',()=>{
 const result=fixture();result.results[0].content+=' '+('nebula orbital telemetry '.repeat(4000));
 assert.throws(()=>compileSearchResult(result,policy(),tokenizer),/INSUFFICIENT_AUTHORIZED_CONTEXT/);
 assert.throws(()=>compileSearchResult(fixture(),{...policy(),token_budget:2049},tokenizer),/INVALID_TOKEN_BUDGET/);
 assert.throws(()=>compileSearchResult(fixture(),policy(),{target,count:()=>1}),/TOKENIZER_NOT_BOUND/);
});
test('wrong scope, stale version, ambiguous/historical/missing source and ungrounded constraints all fail closed',()=>{
 const mutate=[r=>r.results[0].scope='profile',r=>r.results[0].version=2,r=>r.results.push({...r.results[0]}),r=>r.results[0].lifecycle_status='revoked',r=>r.results[0].record_schema_version=null,r=>r.results=[],r=>r.results[0].content='No constraint source'];
 for(const f of mutate){const result=fixture();f(result);assert.throws(()=>compileSearchResult(result,policy(),tokenizer));}
 const p=policy();p.required_records[0].fields=['title'];assert.throws(()=>compileSearchResult(fixture(),p,tokenizer),/CONSTRAINT_FIELD_NOT_AUTHORIZED/);
});
test('unknown target model/encoding is not silently mapped to the current Codex host',async()=>{
 await assert.rejects(createTokenizer({model:'gpt-6-astra'}),/Unknown target-model/);
 await assert.rejects(createTokenizer({encoding:'guessed-tokenizer'}),/Unsupported target encoding/);
});
