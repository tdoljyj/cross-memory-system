import assert from 'node:assert/strict';
import {artifact,assemble,writeNew} from './assembly-common.mjs';
const [payloadPath,acceptancePath,acceptanceSha,reportPath,reportSha,out]=process.argv.slice(2);
assert.ok(out&&process.argv.length===8,'Usage: node assemble-signed-root.mjs <payload-repo-path> <actual-acceptance-repo-path> <acceptance-sha256> <actual-signature-report-repo-path> <independently-verified-report-sha256> <new-output-directory>');
const payload=artifact(payloadPath),acceptance=artifact(acceptancePath,acceptanceSha),report=artifact(reportPath,reportSha);
const {root,binding,shape}=assemble(payload,acceptance,report);
const evidence={state:'ASSEMBLED_LOCAL_INPUT_NOT_REGISTERED',shape,actual_report:{path:report.path,sha256:report.sha256,git_blob:report.blob},signature_verification_responsibility:'Actual API signature and blob verification supplied by independent pinned report; this helper only cross-checks exact local bindings',preconditions:['Report has been durably written and read back from the approved private Evidence branch','Fresh Owner/empty prefix/current revocation check','Atomic accepted_binding plus first append; read back afterward'],database_writes:0,authority_effect:'NONE'};
writeNew(out,{'RootSet.json':root,'AcceptedBinding.json':binding,'AssemblyObservation.json':evidence});
console.log(JSON.stringify(evidence));
