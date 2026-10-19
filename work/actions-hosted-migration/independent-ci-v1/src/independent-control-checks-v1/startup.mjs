import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {publishInstalledControlChecks} from './publisher.mjs';
export async function main(argv=process.argv.slice(2),output=process.stdout){
 if(argv.length!==1||argv[0]!=='--run'){output.write(JSON.stringify({status:'BLOCKED',reason:'FIXED_INDEPENDENT_CONTROL_RUN_REQUIRED',productionAuthorized:false,automaticRetryAllowed:false})+'\n');return 2;}
 try{const result=await publishInstalledControlChecks();output.write(JSON.stringify(result)+'\n');return result.status==='SETTLED'&&result.productionAuthorized===true?0:2;}catch{output.write(JSON.stringify({status:'UNCERTAIN',reason:'INDEPENDENT_CONTROL_TERMINAL_UNCONFIRMED',productionAuthorized:false,automaticRetryAllowed:false,sideEffectsMayHaveStarted:true})+'\n');return 2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await main();
