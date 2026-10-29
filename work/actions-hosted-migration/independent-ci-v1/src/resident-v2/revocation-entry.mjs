// Fixed controller maintenance entry. All effect authority comes from the
// held record and the separately qualified controller/supervisor ports.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runEntry, controllerPrincipal, controllerPorts, observationLog } from './entry-runtime.mjs';
import { STATE_V2 } from './layout.mjs';
import { validateRevocationFacts, revocationQualification } from './revocation-run.mjs';

export async function main(argv=process.argv.slice(2),output=process.stdout) {
  return runEntry({argv,entryRole:'revocation-maintenance',moduleUrl:import.meta.url,output,
    successStatuses:['REVOCATION_MAINTENANCE','PENDING'],body:async({args,inputs,held,live,sourceRoot})=>{
      if(!revocationQualification(inputs.record,{reserveMs:300_000}))return {status:'BLOCKED',reason:'REVOCATION_QUALIFICATION_REQUIRED',sideEffects:0};
      const {appKey,nativeToken}=await controllerPrincipal(inputs.record);
      const log=observationLog(STATE_V2.receipts,inputs.jobs[0].id);
      const ports=controllerPorts({record:inputs.record,appKey,nativeToken,policyText:held.policyText,sourceRoot,live,log});
      const {runIndependentRevocationMaintenance}=await import('../../../../../scripts/ci/clued-independent-revocation-controller.mjs');
      // Once maintenance may have begun, a thrown/malformed result is UNKNOWN,
      // never runEntry's pre-effect BLOCKED/0 fallback.
      let result;
      try {
        result=await runIndependentRevocationMaintenance({record:inputs.record,ports,live,sourceRoot,
          invocation:{nonce:args.nonce,configSha256:args.configSha256,plan:inputs.plan,job:inputs.jobs[0]}});
        if (!result || !['REVOCATION_MAINTENANCE','PENDING','BLOCKED','UNCERTAIN'].includes(result.status)
          || !Number.isSafeInteger(result.sideEffects) || result.sideEffects<0) throw Error('invalid maintenance result');
        const facts=validateRevocationFacts(result.revocation);
        if ((result.status==='REVOCATION_MAINTENANCE' && !facts.complete) || (result.status==='PENDING' && facts.complete)) throw Error('inconsistent maintenance result');
        return result;
      } catch {
        return {status:'UNCERTAIN',reason:'REVOCATION_MAINTENANCE_UNCONFIRMED',
          sideEffects:Number.isSafeInteger(result?.sideEffects)&&result.sideEffects>=0?result.sideEffects:1,revocation:null};
      }
    }});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await main();
