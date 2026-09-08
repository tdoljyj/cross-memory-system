import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {parseExact,time,checkGAShape,checkCurrentSemantics} from './context.mjs';
import {checkResultSemantics} from './grr.mjs';
const require=createRequire(new URL('../../../apps/clued-cloud/package.json',import.meta.url));
const Ajv=require('ajv'),ajv=new Ajv({allErrors:true,strictKeywords:true,format:'full'});
const read=n=>JSON.parse(fs.readFileSync(new URL(n,import.meta.url),'utf8'));
// Synthetic memory-only shape witnesses. They are never published or passed to the trusted GH/SQL path.
function shape(s){
 if('const'in s)return s.const;if(s.enum)return s.enum[0];
 if(s.type==='object')return Object.fromEntries(s.required.map(k=>[k,shape(s.properties[k])]));
 if(s.type==='array')return Array.from({length:s.minItems??0},()=>shape(s.items));
 if(s.type==='integer')return s.minimum??1;
 if(s.format==='date-time')return '2026-09-08T14:00:00Z';
 if(s.pattern?.includes('{64}'))return 'a'.repeat(64);if(s.pattern?.includes('{40}'))return 'a'.repeat(40);
 if(s.pattern?.startsWith('^sm_'))return 'sm_synthetic_shape_only';if(s.pattern?.startsWith('^ga_'))return 'ga_synthetic_shape_only';if(s.pattern?.startsWith('^grr_'))return 'grr_synthetic_shape_only';
 if(s.pattern?.startsWith('^PQUAL'))return 'PQUAL-01';return 'SYNTHETIC_SHAPE_ONLY';
}
test('raw parsing rejects duplicate keys, unsafe numbers and alternative serialization',()=>{
 for(const raw of ['{"a":1,"a":2}\n','{"n":9007199254740993}\n','{ "x":1 }\n','{"x":1}'])assert.throws(()=>parseExact(raw));
 assert.deepEqual(parseExact('{"x":1}\n'),{x:1});
});
test('JSON authorized flag and partial GA never become authority or currentness',()=>{
 assert.throws(()=>checkGAShape('{"authorized":true}\n'),/COMPLETE_GA_SCHEMA/);
 assert.throws(()=>checkCurrentSemantics({gaRaw:'{"authorization_status":"AUTHORIZED"}\n',operation:'CREATE',observation:{authorized:true}}),/COMPLETE_GA_SCHEMA/);
});
test('complete Status schema accepts only a shape witness and rejects authority fields, wrong generation, missing source and invalid calendar',()=>{
 const schema=read('status-manifest.candidate.schema.json'),validate=ajv.compile(schema),w=shape(schema);
 assert.equal(validate(w),true,JSON.stringify(validate.errors));
 for(const mutate of [x=>x.authorized=true,x=>x.control_trust_root_generation='ctrgen_352785779b64458a889d571360e2d2d5',x=>delete x.source_refs,x=>x.as_of='2026-02-30T00:00:00Z',x=>x.generation=9007199254740992]){const x=structuredClone(w);mutate(x);assert.equal(validate(x),false);}
});
test('GRR keeps original four results, complete evidence/decision fields and separate signing purpose',()=>{
 const schema=read('gate-result-receipt.candidate.schema.json'),validate=ajv.compile(schema),w=shape(schema);
 assert.equal(validate(w),true,JSON.stringify(validate.errors));
 for(const mutate of [x=>x.result='UNKNOWN',x=>x.issuer_purpose='GATE_AUTHORIZATION',x=>delete x.decision_sha256,x=>x.raw_evidence_refs=[],x=>delete x.stop_evidence_ref,x=>x.result=true]){const x=structuredClone(w);mutate(x);assert.equal(validate(x),false);}
 assert.throws(()=>checkResultSemantics({raw:JSON.stringify(w)+'\n',gaRaw:'{"authorized":true}\n',state:{}}),/COMPLETE_GA_SCHEMA/);
});

test('time comparison is numerical across optional fractions and rejects rolled calendar dates',()=>{
 assert.equal(time('2026-09-08T14:00:00Z'),time('2026-09-08T14:00:00.000Z'));
 assert.ok(time('2026-09-08T14:00:00.001Z')>time('2026-09-08T14:00:00Z'));
 for(const value of ['2026-02-30T00:00:00Z','2026-09-08T14:00:00+00:00'])assert.throws(()=>time(value));
});

test('actual isolated CLI rejects caller authority without SQL or network and exits',()=>{
 const child=spawnSync(process.execPath,[new URL('cli.mjs',import.meta.url).pathname.replace(/^\/([A-Z]:\/)/,'$1')],{input:'{"authorized":true}\n',encoding:'utf8',timeout:5000,windowsHide:true});
 assert.equal(child.error,undefined);assert.equal(child.status,1);
 assert.deepEqual(JSON.parse(child.stdout),{state:'BLOCKED',reason:'ACTUAL_SQL_BINDING_MISSING',authority_effect:'NONE'});
 assert.equal(child.stderr,'');
});

test('the actual functions parser reads observed PTY controls without evaluating tool output',()=>{
 const source=fs.readFileSync(new URL('tool-entry.functions.js',import.meta.url),'utf8');
 const parser=source.match(/^function terminalMessages\(raw\).*$/m)[0];
 const run=vm.runInNewContext('('+parser+')');
 const observed='\x1b[?25l\x1b[2J\x1b[m\x1b[H{"state":"BLOCKED","reason":"ACTUAL_SQL_BINDING_MISSING","authority_effect":"NONE"}\r\n\x1b]0;C:\\host\\pwsh.exe\x07\x1b[?25h';
 assert.equal(JSON.stringify(run(observed)),JSON.stringify([{state:'BLOCKED',reason:'ACTUAL_SQL_BINDING_MISSING',authority_effect:'NONE'}]));
 assert.equal(JSON.stringify(run('globalThis.injected=true\n')), '[]');
});
