// Preserve the signed ordered refs. Share only identical immutable fetches within this batch.
import crypto from 'node:crypto';
const prefix='https://api.github.com/repos/tdoljyj/cross-memory-system/git/blobs/';
const need=(v,m)=>{if(!v)throw Error(m);},sha=x=>crypto.createHash('sha256').update(x).digest('hex');
export function planRefs(refs,sizes){
 need(Array.isArray(refs)&&refs.length>0&&refs.length<=128&&Array.isArray(sizes)&&sizes.length===refs.length,'BOUNDED_EXACT_REFS_AND_TREE_SIZES');
 const unique=[],indices=[],seen=new Map();
 for(let i=0;i<refs.length;i++){
  const r=refs[i],size=sizes[i];need(r&&Object.keys(r).sort().join(',')==='sha256,uri'&&typeof r.uri==='string'&&r.uri.startsWith(prefix)&&/^[a-f0-9]{40}$/.test(r.uri.slice(prefix.length))&&/^[a-f0-9]{64}$/.test(r.sha256)&&Number.isSafeInteger(size)&&size>=0&&size<=32*1024*1024,'EXACT_IMMUTABLE_REF_AND_SIZE');
  let index=seen.get(r.uri);if(index!==undefined){const prior=unique[index];need(prior.ref.sha256===r.sha256&&prior.size===size,'CONTRADICTORY_SAME_URI_HASH_OR_SIZE');}
  else{index=unique.length;seen.set(r.uri,index);unique.push({ref:r,size});}indices.push(index);
 }
 return {unique,indices};
}
export function validateBlob(ref,blob,expectedSize){
 need(blob&&blob.sha===ref.uri.slice(prefix.length)&&blob.encoding==='base64'&&typeof blob.content==='string'&&Number.isSafeInteger(blob.size)&&blob.size>=0&&blob.size===expectedSize,'GITHUB_BLOB_RESPONSE_AND_TREE_SIZE');
 const bytes=Buffer.from(blob.content,'base64');need(bytes.length===blob.size&&sha(bytes)===ref.sha256,'GITHUB_BLOB_RAW_SHA');
 need(crypto.createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex')===blob.sha,'GITHUB_BLOB_ID');return bytes;
}
export function checkExpandedBlobBytes(blobs){
 let bytes=0;for(const blob of blobs){bytes+=Buffer.byteLength(JSON.stringify(blob));need(bytes<=32*1024*1024,'EXPANDED_IMMUTABLE_BLOB_RESPONSE_LIMIT');}return bytes;
}
