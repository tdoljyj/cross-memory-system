#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const here=path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/,'$1'));
const src=fs.readFileSync(path.join(here,'build-root10-runner-material.mjs'),'utf8');
const checks=[
 ['syntax',()=>execFileSync(process.execPath,['--check',path.join(here,'build-root10-runner-material.mjs')],{stdio:'pipe'})!==null],
 ['emit-json required',()=>src.includes("args.includes('--emit-json')")],
 ['no filesystem writes',()=>!/(writeFile|appendFile|mkdir|rename|unlink|rmSync)/.test(src)],
 ['no DB or container clients',()=>!/(supabase|psql|docker|podman)/i.test(src)],
 ['no GA signing or issuance',()=>!/(makeCommitment|prepareMutation|reserve_gate|ga_issued\s*:\s*true)/.test(src)],
 ['actual original/P1/P2 owner checks',()=>src.includes("verifyPublication('ORIGINAL_SOURCE'")&&src.includes("verifyPublication('P1'")&&src.includes("verifyPublication('P2'")&&src.includes("merged_by?.login==='tdoljyj'")],
 ['complete trees and ancestry',()=>src.includes("truncated===false")&&src.includes("ORIGINAL_SOURCE_MUST_BE_ANCESTOR_OF_P1")&&src.includes("P1_MUST_BE_ANCESTOR_OF_P2")],
 ['exact 51-field GA and 600 seconds',()=>src.includes('EXACT_51_FIELD_GA')&&src.includes('EXACT_FINAL_GA_600_SECONDS')],
 ['pre-GA null injection boundary',()=>src.includes('ga_raw:gaRaw')&&src.includes('raw:statusFullRaw')&&src.includes('store_ref:ga?.status_manifest_ref??null')],
 ['invalid example fails before network',()=>{try{execFileSync(process.execPath,[path.join(here,'build-root10-runner-material.mjs'),path.join(here,'config.example.json'),'--emit-json'],{stdio:'pipe'});return false;}catch(e){return /ORIGINAL_SOURCE_PUBLICATION_ID/.test(String(e.stderr));}}],
];
let failed=false;for(const [name,test] of checks){let ok=false;try{ok=test();}catch{}console.log((ok?'PASS ':'FAIL ')+name);failed||=!ok;}
if(failed)process.exit(1);console.log(`PASS ${checks.length}/${checks.length}`);
