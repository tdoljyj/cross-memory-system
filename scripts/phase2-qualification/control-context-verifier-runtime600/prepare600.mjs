// Bounded configuration successor, no service calls or control instances.
import fs from 'node:fs';
const here=new URL('./',import.meta.url);
for(const name of ['context.mjs','trusted-github.mjs','grr.mjs','cli.mjs','result-terminal.mjs','host-effect.mjs','budget-evidence.mjs','late-bound-policy.mjs','source-publication.mjs','tool-entry.template.js','tool-entry.functions.js']){
 let s=fs.readFileSync(new URL(name,here),'utf8');
 s=s.replaceAll('control-context-verifier-runtime180/ControllerSourceManifest','control-context-verifier-runtime600/ControllerSourceManifest').replaceAll('control-context-verifier-runtime180/cli.mjs','control-context-verifier-runtime600/cli.mjs').replaceAll('clued_verifier180_session','clued_verifier600_session');
 if(name==='context.mjs')s=s.replaceAll("from './dispatch-evidence.mjs'","from '../control-context-verifier-runtime180/dispatch-evidence.mjs'").replaceAll('../preentry-parent/profile-runtime180/','../preentry-parent/profile-runtime600/').replaceAll('profile.max_lifetime_seconds===180','profile.max_lifetime_seconds===600').replaceAll("new URL('status-manifest.candidate.schema.json',import.meta.url)","new URL('../control-context-verifier-runtime180/status-manifest.candidate.schema.json',import.meta.url)");
 if(name==='grr.mjs')s=s.replaceAll("new URL('gate-result-receipt.candidate.schema.json',import.meta.url)","new URL('../control-context-verifier-runtime180/gate-result-receipt.candidate.schema.json',import.meta.url)");
 if(name==='result-terminal.mjs')s=s.replaceAll('expires-issued<=180000','expires-issued<=600000');
 if(name==='budget-evidence.mjs')s=s.replaceAll('budget.seconds===180','budget.seconds===600');
 if(name==='late-bound-policy.mjs')s=s.replaceAll('b.maximum_seconds===180','b.maximum_seconds===600');
 if(name==='cli.mjs')s=s.replaceAll('},180000);','},600000);');
 if(name==='host-effect.mjs')s=s.replaceAll('../preentry-parent/runtime-successor/host-tool-bridge/bridge.py','../preentry-parent/runtime-successor/host-tool-bridge600/bridge.py');
 fs.writeFileSync(new URL(name,here),s);
}
process.stdout.write(JSON.stringify({state:'CONFIGURATION_SUCCESSOR_PREPARATION_ONLY',profile600_and_host600_sources_still_require_exact_binding:true,ga_issued:false})+'\n');
