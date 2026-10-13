import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../worker/result-sanitization.ts',import.meta.url),'utf8');
const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const exports = {}; vm.runInNewContext(compiled,{exports,Set,Object,Array});
const sanitize = (value,tool) => JSON.parse(JSON.stringify(exports.sanitizeCluedResult(value,tool)));

for (const enabled of [true,false]) test(`resume keeps the service review policy (${enabled}) while stripping account identities`,()=>{
  const policy = {enabled,version:enabled?0:1,default:enabled,execution_authority:false,authority_effect:'independent_read_only_review'};
  const result = sanitize({status:'restored',user_id:'private-account',binding_id:'private-binding',independent_review:policy},'clued_session_resume');
  assert.deepEqual(result,{status:'restored',independent_review:policy});
});
test('checkpoint renewal keeps current policy and no policy is manufactured when the service omits it',()=>{
  const result = sanitize({status:'committed',session_renewal:{user_id:'private-account',independent_review:{enabled:false,version:1,execution_authority:false}}},'clued_session_checkpoint');
  assert.equal(result.session_renewal.independent_review.enabled,false);
  assert.equal(result.session_renewal.independent_review.execution_authority,false);
  assert.ok(!('user_id' in result.session_renewal));
  assert.ok(!('independent_review' in sanitize({status:'restored'},'clued_session_resume')));
});
