import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
export const target=Object.freeze({package:'js-tiktoken',version:'1.0.21',encoding:'o200k_base',model_mapping:'gpt-4.1-2025-04-14',measurement:'Exact standalone UTF-8 Context Pack text; not chat-envelope or provider billing tokens',host_acceptance:'NOT_BOUND_BY_THIS_ENGINEERING_MODULE'});
export const dependencyHashes=Object.freeze({
 'node_modules/js-tiktoken/package.json':'5040ae37366971233fd53ef33360bc8d94159fa55c0c541f5663980b53b6b3b3',
 'node_modules/js-tiktoken/dist/lite.js':'e7f8d0900a29c70a1155838cff633f5a66eef660bd3c4fb452882ec7cc4a316c',
 'node_modules/js-tiktoken/dist/chunk-VL2OQCWN.js':'4095335817189ee393ce99588744e53d04f1dd32b6c9a7d4a9f365d5e4569035',
 'node_modules/js-tiktoken/dist/ranks/o200k_base.js':'a9e8a0c1f332c58f1a9cef2f8d7be59b31bb4b42531a3a0a64d9ad3b3d19033b',
 'node_modules/base64-js/index.js':'829eadd8a1a441d25be0cb93b00e16a0d0c20fd294db95d8f2ed87e6954b7182'
});
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const verifiedInstances=new WeakSet();
export const isBoundTokenizer=value=>verifiedInstances.has(value);
export async function createTokenizer({encoding=target.encoding,model=target.model_mapping}={}){
 assert.equal(encoding,target.encoding,'Unsupported target encoding');assert.equal(model,target.model_mapping,'Unknown target-model mapping; do not infer current Codex tokenizer');
 for(const [file,expected] of Object.entries(dependencyHashes))assert.equal(sha(await fs.readFile(new URL(file,import.meta.url))),expected,'Tokenizer dependency drift: '+file);
 const {Tiktoken,getEncodingNameForModel}=await import('js-tiktoken/lite');
 const {default:ranks}=await import('js-tiktoken/ranks/o200k_base');
 assert.equal(getEncodingNameForModel(model),encoding);
 const instance=new Tiktoken(ranks);
 const bound=Object.freeze({target,count(text){assert.equal(typeof text,'string');return instance.encode(text,[],[]).length;},roundtrip(text){return instance.decode(instance.encode(text,[],[]));}});
 verifiedInstances.add(bound);return bound;
}
