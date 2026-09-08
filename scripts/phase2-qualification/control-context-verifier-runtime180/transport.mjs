// The same pure functions are embedded verbatim into the fixed functions entry.
export function parseSqlResult(result){
 if(result?.isError===true||!Array.isArray(result?.content)||result.content.length!==1||result.content[0]?.type!=='text')throw Error('EXACT_NONERROR_SQL_BLOCK_REQUIRED');
 const envelope=JSON.parse(result.content[0].text);
 if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||Object.keys(envelope).length!==1||typeof envelope.result!=='string')throw Error('EXACT_SQL_RESULT_ENVELOPE_REQUIRED');
 const lines=envelope.result.split(/\r?\n/),starts=[],ends=[];
 for(let i=0;i<lines.length;i++){let m=lines[i].match(/^<untrusted-data-([A-Za-z0-9-]+)>$/);if(m)starts.push({i,id:m[1]});m=lines[i].match(/^<\/untrusted-data-([A-Za-z0-9-]+)>$/);if(m)ends.push({i,id:m[1]});}
 if(starts.length!==1||ends.length!==1||starts[0].id!==ends[0].id||starts[0].i>=ends[0].i)throw Error('EXACT_PAIRED_SQL_BOUNDARIES_REQUIRED');
 const rows=JSON.parse(lines.slice(starts[0].i+1,ends[0].i).join('\n'));
 if(!Array.isArray(rows)||rows.length!==1||!rows[0]||typeof rows[0]!=='object'||Array.isArray(rows[0]))throw Error('EXACT_SINGLE_SQL_ROW_REQUIRED');
 return rows[0];
}
export function recordQuery(intent){
 if(!intent||typeof intent.gaId!=='string'||!/^ga_[A-Za-z0-9_.-]+$/.test(intent.gaId)||!/^intent_[a-f0-9]{64}$/.test(intent.key)||!['CREATE','START'].includes(intent.body?.operation)||typeof intent.body.raw!=='string'||intent.body.raw.length>131072||!/^[a-f0-9]{64}$/.test(intent.body.sha256))throw Error('FIXED_INTENT_QUERY_INPUT');
 const quote=x=>"'"+x.replaceAll("'","''")+"'";
 return 'select clued_control.record_effect_intent('+quote(intent.gaId)+','+quote(intent.key)+','+quote(JSON.stringify(intent.body))+'::jsonb) as recorded';
}
export function dispatchQuery(intent,sequence,key){
 recordQuery(intent);
 if(!Number.isSafeInteger(sequence)||sequence<1||!/^clued_[a-f0-9]{64}$/.test(key))throw Error('FIXED_DISPATCH_QUERY_INPUT');
 const quote=x=>"'"+x.replaceAll("'","''")+"'";
 return 'select clued_control.dispatch_recorded_intent('+quote(intent.gaId)+','+quote(intent.body.operation+'_SENT')+','+quote(key)+','+sequence+','+quote(intent.body.sha256)+') as dispatched';
}
