// Engineering candidate only: no provider, filesystem, API, Canonical or Receipt writes.
import crypto from 'node:crypto';
import {TextDecoder} from 'node:util';

// Conservative implementation bounds, not accepted Slice A/Provider token budgets.
export const limits=Object.freeze({maxSourceBytes:1048576,maxChunkBytes:65536,maxChunks:4096});
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const decoder=()=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});

export function prepareSourceBytes({bytes,source_ref,expected_content_hash,expected_size_bytes,chunk_bytes=4096}){
 if(!Buffer.isBuffer(bytes))throw Error('Source bytes must be an explicit Buffer');
 if(typeof source_ref!=='string'||source_ref.length<1||source_ref.length>1000)throw Error('Invalid source reference');
 if(!Number.isSafeInteger(expected_size_bytes)||expected_size_bytes<0||expected_size_bytes>limits.maxSourceBytes)throw Error('Source size outside candidate bound');
 if(!Number.isSafeInteger(chunk_bytes)||chunk_bytes<4||chunk_bytes>limits.maxChunkBytes)throw Error('Invalid chunk byte limit');
 if(typeof expected_content_hash!=='string'||!/^[a-f0-9]{64}$/.test(expected_content_hash))throw Error('Expected SHA-256 required');
 if(bytes.length!==expected_size_bytes)throw Error('Source size mismatch');
 // Copy once; all hashes, offsets and returned text refer to the same stable byte snapshot.
 const source=Buffer.from(bytes),content_hash=digest(source);
 if(content_hash!==expected_content_hash)throw Error('Source bytes do not match expected digest');
 decoder().decode(source); // Reject malformed UTF-8; do not silently replace bytes or normalize text.
 const chunks=[];
 for(let start=0;start<source.length;){
  if(chunks.length===limits.maxChunks)throw Error('Chunk count exceeds candidate bound');
  let end=Math.min(start+chunk_bytes,source.length);
  // UTF-8 continuation bytes cannot start the next chunk. chunk_bytes>=4 guarantees progress.
  while(end<source.length&&(source[end]&0xc0)===0x80)end--;
  if(end<=start)throw Error('Unable to preserve UTF-8 byte boundary');
  const part=source.subarray(start,end);
  chunks.push({source_ref,source_content_hash:content_hash,byte_start:start,byte_end_exclusive:end,content_hash:digest(part),text:decoder().decode(part)});
  start=end;
 }
 return {state:'LOCAL_SOURCE_BYTES_VERIFIED_CANDIDATE',source:{source_ref,content_hash,size_bytes:source.length},chunks,
  byte_encoding:'UTF-8_NO_NORMALIZATION',authority_effect:'NONE',persisted:false,source_ownership_verified:false,token_count:null};
}
