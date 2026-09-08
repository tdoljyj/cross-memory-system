import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {dependencyHashes} from './tokenizer.mjs';

test('redirecting dependency metadata or package self-reference is rejected before dynamic import',{timeout:30000},async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'clued-tokenizer-metadata-'));
 try{
  for(const mode of ['dependency-main','root-self-reference']){
   const copy=path.join(temp,mode);await fs.mkdir(copy);
   await fs.copyFile(new URL('tokenizer.mjs',import.meta.url),path.join(copy,'tokenizer.mjs'));
   for(const relative of Object.keys(dependencyHashes)){const dest=path.join(copy,relative);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(new URL(relative,import.meta.url),dest);}
   const relative=mode==='dependency-main'?'node_modules/base64-js/package.json':'package.json';
   const file=path.join(copy,relative),metadata=JSON.parse(await fs.readFile(file,'utf8'));
   const marker=path.join(temp,mode+'-EXECUTED');
   const body="import fs from 'node:fs'; fs.writeFileSync("+JSON.stringify(marker)+",'UNVERIFIED_CODE_EXECUTED'); throw Error('UNVERIFIED_CODE_EXECUTED');\n";
   const evil=path.join(path.dirname(file),'redirected.mjs');await fs.writeFile(evil,body);
   if(mode==='dependency-main')metadata.main='redirected.mjs';
   else{metadata.name='js-tiktoken';metadata.exports={'./lite':'./redirected.mjs','./ranks/o200k_base':'./redirected.mjs'};}
   await fs.writeFile(file,JSON.stringify(metadata)+'\n');
   const module=await import(pathToFileURL(path.join(copy,'tokenizer.mjs')));
   await assert.rejects(module.createTokenizer(),e=>e.message.includes('Tokenizer dependency drift: '+relative));
   await assert.rejects(fs.access(marker),e=>e.code==='ENOENT');
  }
 }finally{
  const target=path.resolve(temp);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('clued-tokenizer-metadata-'))throw Error('Unsafe metadata test cleanup');
  await fs.rm(target,{recursive:true,force:true});
 }
});
