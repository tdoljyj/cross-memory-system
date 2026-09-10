import crypto from 'node:crypto';
export function validateMessage(bytes,notice,expectedSequence){
 if(Object.keys(notice).sort().join(',')!=='bytes,sequence,sha256'||notice.sequence!==expectedSequence||![1,2].includes(expectedSequence)||!Number.isSafeInteger(notice.bytes)||notice.bytes<3||notice.bytes>4*1024*1024+1||!/^[a-f0-9]{64}$/.test(notice.sha256))throw Error('EXACT_TWO_MESSAGE_NOTICE');
 if(bytes.length!==notice.bytes||crypto.createHash('sha256').update(bytes).digest('hex')!==notice.sha256)throw Error('EXACT_ACTUAL_MESSAGE_BYTES');
 const raw=bytes.toString('utf8');if(!Buffer.from(raw,'utf8').equals(bytes)||!raw.endsWith('\n')||raw.slice(0,-1).includes('\n')||raw.includes('\r'))throw Error('ONE_EXACT_UTF8_JSON_LINE');
 const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw Error('ORIGINAL_MESSAGE_OBJECT');return {raw,value};
}
