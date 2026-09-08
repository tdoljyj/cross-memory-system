import {recordQuery,dispatchQuery} from './transport.mjs';
import {canonicalDigest} from '../nonproduction-control-store/protocol-successor/validate-successor.mjs';
const need=(ok,reason)=>{if(!ok)throw Error(reason);};
export function checkDispatchEvidence({record,dispatch,intent,dispatchKey,project,operation}){
 need(record?.project===project&&record.query===recordQuery(intent),'ACTUAL_FIXED_RECORD_QUERY');
 const recorded=record.row?.recorded;
 need(recorded?.status==='RECORDED'&&recorded.phase==='INTENT_RECORDED'&&Number.isSafeInteger(recorded.sequence)&&recorded.sequence>0,'NEW_COMMITTED_INTENT_REQUIRED');
 const expectedQuery=dispatchQuery(intent,recorded.sequence,dispatchKey);
 need(dispatch?.project===project&&dispatch.query===expectedQuery,'ACTUAL_FIXED_DISPATCH_QUERY');
 const response=dispatch.row?.dispatched,prior=response?.prior_committed_intent_readback;
 need(response?.status==='RECORDED'&&response.phase===operation+'_SENT'&&Number.isSafeInteger(response.sequence),'NO_EFFECT_ON_DUPLICATE_OR_UNKNOWN');
 need(prior?.sequence===recorded.sequence&&prior.idempotency_key===intent.key&&prior.request?.ga_id===intent.gaId&&prior.request.operation==='INTENT_RECORDED'&&canonicalDigest(prior.request.body)===canonicalDigest(intent.body),'EXACT_PRIOR_COMMITTED_INTENT_BYTES');
 const currentSource=response.current_context,events=currentSource?.events?.filter(e=>e.idempotency_key===dispatchKey);
 need(events?.length===1&&events[0].sequence===response.sequence&&events[0].request.ga_id===intent.gaId&&events[0].request.operation===operation+'_SENT'&&events[0].request.body.intent_sequence===recorded.sequence&&events[0].request.body.intent_sha256===intent.body.sha256,'EXACT_CURRENT_DISPATCH_EVENT');
 need(currentSource.current?.sequence===response.sequence,'EXACT_DISPATCH_CURRENT_SEQUENCE');
 return {state:'DISPATCH_EVIDENCE_MATCHED_NOT_ADMISSION',currentSource,expectedQuery,response};
}
