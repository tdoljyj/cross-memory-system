// Conservative PostgreSQL jsonb text size for this string/integer/object request domain.
const need=(v,m)=>{if(!v)throw Error(m);};
function pgText(value){
 if(value===null||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'){need(Number.isSafeInteger(value),'SAFE_INTEGER_REQUEST_DOMAIN');return String(value);}
 if(typeof value==='string'){need(!value.includes('\0')&&Buffer.from(value).toString('utf8')===value,'POSTGRES_VALID_UNICODE_STRING');return JSON.stringify(value);}
 if(Array.isArray(value))return '['+value.map(pgText).join(', ')+']';
 need(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype,'PLAIN_JSON_REQUEST_DOMAIN');
 return '{'+Object.keys(value).map(k=>pgText(k)+': '+pgText(value[k])).join(', ')+'}';
}
export function measureDecisionRequest(request){
 need(request?.operation==='DECISION_RESERVED'&&/^ga_[A-Za-z0-9_-]{1,128}$/.test(request.ga_id)&&/^[A-Za-z0-9_-]{1,128}$/.test(request.idempotency_key)&&Number.isSafeInteger(request.expected_sequence)&&request.expected_sequence>=0&&request.expected_sequence<=999999999999999,'EXACT_ACTUAL_DECISION_REQUEST');
 need(Object.keys(request).sort().join(',')==='body,expected_sequence,ga_id,idempotency_key,operation'&&Object.keys(request.body??{}).sort().join(',')==='decision_raw,decision_sha256,evidence_index_raw,evidence_index_sha256,result','ORIGINAL_COMPLETE_DECISION_BODY');
 const request_json=JSON.stringify(request),compact=Buffer.byteLength(request_json),postgres=Buffer.byteLength(pgText(request));
 return {request_json,request_utf8_bytes:compact,postgres_jsonb_text_bytes:postgres,limit_bytes:131072,within_limit:postgres<=131072,scope:'Entire actual request, including complete nested decision/index strings; PostgreSQL object-key order does not affect byte count in this restricted domain.'};
}
