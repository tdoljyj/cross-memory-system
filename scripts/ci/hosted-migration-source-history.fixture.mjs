// Sealed, offline regression inputs copied byte-for-byte from immutable Git
// commits. These fixtures preserve old Source facts; they grant no live trust.
// Regeneration requires the named Git objects, but ordinary tests do not.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

const predecessor='062543d943b65be1a88baed653f7999f25649668',historical='59522b4158322e833ef152472a924c5fb40e0b24';
const expected={
  predecessor_config:{commit:predecessor,path:'scripts/ci/merge-admission-r9-source.json',bytes:33363,
    sha256:'4bd3caccde0a2d03c99068e2891796e1e49646be2321eacf9ed1a8605d63a58d'},
  historical_profiles:{commit:historical,path:'scripts/ci/clued-gated-proof-profiles.json',bytes:468322,
    sha256:'64e5e972644ad7da5dfdf541072362807e498000b4ff99ecce0102940ec37c20'},
  historical_roles:{commit:historical,path:'scripts/ci/clued-gated-proof-role-specs.json',bytes:40005,
    sha256:'9b76ef307b00ac2d8352e021d4f19cd65ea97fbc751d4ecb8e052fa23bd76f1a'},
  historical_workflow_tree:{commit:historical,path:'.github/workflows',bytes:5438,
    sha256:'76f6ee501a0af89a202b23ad6ba021d90b294bd2711daf52bcb5dd1a5f758e1e'},
};
export function decodeSourceHistoryFixture(document){
  if(document?.schema!=='clued.hosted-migration-source-history-fixture/1'||
      JSON.stringify(Object.keys(document.inputs??{}).sort())!==JSON.stringify(Object.keys(expected).sort()))
    throw Error('SEALED_SOURCE_HISTORY_MANIFEST_INVALID');
  const decoded={};
  for(const [key,metadata]of Object.entries(expected)){
    const item=document.inputs[key];
    if(!item||Object.entries(metadata).some(([k,v])=>item[k]!==v)||
        typeof item.gzip_base64!=='string'||item.gzip_base64.length>90000||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.gzip_base64))
      throw Error('SEALED_SOURCE_HISTORY_METADATA_INVALID:'+key);
    const compressed=Buffer.from(item.gzip_base64,'base64');
    if(compressed.length>65536)throw Error('SEALED_SOURCE_HISTORY_COMPRESSED_TOO_LARGE:'+key);
    const raw=gunzipSync(compressed,{maxOutputLength:metadata.bytes});
    if(raw.length!==metadata.bytes||createHash('sha256').update(raw).digest('hex')!==metadata.sha256)
      throw Error('SEALED_SOURCE_HISTORY_BYTES_MISMATCH:'+key);
    decoded[key]=new TextDecoder('utf-8',{fatal:true}).decode(raw);
  }
  return decoded;
}
export function loadSourceHistoryFixture(){
  const raw=fs.readFileSync(new URL('./fixtures/hosted-migration-source-history.v1.json',import.meta.url));
  if(raw.length>100000)throw Error('SEALED_SOURCE_HISTORY_FILE_TOO_LARGE');
  return decodeSourceHistoryFixture(JSON.parse(raw.toString('utf8')));
}
