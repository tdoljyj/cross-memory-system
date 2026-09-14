#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const arg=n=>{const i=process.argv.indexOf(n);return i<0?null:process.argv[i+1];};
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(arg('--repo-root')??path.join(here,'../../..'));
const cdir=path.join(repo,'scripts/phase2-qualification/control-context-verifier-recovery-successor-root9'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const manifestRaw=fs.readFileSync(path.join(cdir,'ControllerSourceManifest.candidate.json')),manifest=JSON.parse(manifestRaw);
assert.equal(manifest.generation_id,'ctrgen_308a1dfc185cff633892638581e0a34c');assert.equal(manifest.files.length,22);assert.ok(manifest.files.every(x=>x.path.startsWith('scripts/phase2-qualification/control-context-verifier-recovery-successor-root9/')));
for(const item of manifest.files){const bytes=fs.readFileSync(path.join(repo,item.path));assert.equal(bytes.length,item.bytes);assert.equal(sha(bytes),item.sha256);}
const expected={STATUS:'2bbd9352b79da288b1a161f32cf59fc946e4cd68167b608fbd3d994617df65e9',GATE_AUTHORIZATION:'751afdf957b8055ea28d5fbc9ae7bcea2b384c0b005bc53263244cf1612d1004',GATE_RESULT:'ffafc9eb63a2148176dca0e66d5a22bf07ee9f0a5462c966d42a79d247f0088c'};
for(const [purpose,digest] of Object.entries(expected)){const p=path.join(repo,'scripts/phase2-qualification/control-trust-root-issuer-qualifications-root9/IssuerQualification.'+purpose+'.root9.candidate.json'),raw=fs.readFileSync(p),v=JSON.parse(raw);assert.equal(sha(raw),digest);assert.equal(v.control_trust_root_generation,'ctrgen_308a1dfc185cff633892638581e0a34c');assert.equal(v.authority_effect,'NONE');assert.equal(v.authority_basis.owner_merge_verified,false);assert.equal(Object.hasOwn(v,'signature_binding'),false);assert.equal(Object.hasOwn(v,'controller_digest'),false);assert.ok(v.accepted_issuer_purposes.some(x=>x.purpose===purpose&&x.accepted===true));}
const context=fs.readFileSync(path.join(cdir,'context.mjs'),'utf8');for(const digest of Object.values(expected))assert.ok(context.includes(digest));assert.ok(!context.includes('9448bfdb54ca8c7872c655852be54e9597858621e8b7a17d92f842a76d59d7d9'));assert.ok(!context.includes('5c9e34d0740c59321146dd13866e127866954fc2186be5b1bdfa607870f4f5b9'));
const all=[];for(const walk of [repo]){const todo=[walk];while(todo.length){const p=todo.pop();for(const d of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,d.name);if(d.isDirectory())todo.push(q);else all.push(path.relative(repo,q));}}}
assert.equal(all.some(p=>p.endsWith('.sql')),false);assert.equal(all.some(p=>/RuntimeAcceptance|Status26|CAS/i.test(p)),false);
console.log(JSON.stringify({state:'STAGE1_PAYLOAD_OFFLINE_PASS_NOT_AUTHORITY',controller_sha256:sha(manifestRaw),controller_directory:'scripts/phase2-qualification/control-context-verifier-recovery-successor-root9',controller_files:22,issuer_qualifications:3,root8_path_overwritten:false,root8_pins:0,sql_files:0,signatures_created:0,owner_merge_verified:false,authority_effect:'NONE'}));
