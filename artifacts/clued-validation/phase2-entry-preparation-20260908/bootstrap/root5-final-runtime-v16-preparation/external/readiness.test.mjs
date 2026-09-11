// Candidate-only regression. These fixtures are not signed observations or results.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {controller,sha} from './dependencies.mjs';
import {createResultTools} from './result-materials.mjs';
import {readAdditionalComponents} from './component-readback.mjs';
const historical=JSON.parse(fs.readFileSync(new URL('../env-order-repair-approved-execution/final-run-root5-v15-20260911/Material.CREATE.json',import.meta.url)));
function fixture(){const m=structuredClone(historical),r=JSON.parse(m.runtime_acceptance.raw),g=JSON.parse(m.ga_raw);r.controller_digest=controller;r.accepted_subject.expected_ga.controller_digest=controller;g.controller_digest=controller;g.target_revision='a'.repeat(40);m.ga_raw=JSON.stringify(g)+'\n';m.runtime_acceptance.raw=JSON.stringify(r)+'\n';return m;}
test('current result tools accept Root5 reviewer and truly late-bound target with preserved scope',()=>{const m=fixture();const result=createResultTools(m);assert.equal(result.ga.target_revision,'a'.repeat(40));assert.equal(sha(m.execution_scope.raw),result.ga.scope_digest);assert.notEqual(result.scope.controller_source_manifest.sha256,controller);});
test('changed scope bytes remain rejected',()=>{const m=fixture();m.execution_scope.raw+=' ';assert.throws(()=>createResultTools(m),/EXACT_CURRENT_SCOPE_RAW_REF/);});
test('changed fixed GA fields remain rejected during result preparation',()=>{const m=fixture(),g=JSON.parse(m.ga_raw);g.scope_digest='0'.repeat(64);m.ga_raw=JSON.stringify(g)+'\n';assert.throws(()=>createResultTools(m),/EXACT_ACCEPTED_GA_FIELD:scope_digest/);});
test('additional readback uses current controller and still rejects missing cases before network',()=>assert.throws(()=>readAdditionalComponents({ga_raw:fixture().ga_raw,entries:[],applicability:{}}),/ONE_READBACK_PER_FIXED_SUPPLEMENTARY_CASE/));
