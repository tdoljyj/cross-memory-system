// No-authority regression of the exact frozen entry's evaluated Linux command.
// A read-only isolated container has no Docker socket, no network, and no GA input.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const need=(ok,why)=>{if(!ok)throw Error(why)};
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const repo=path.resolve(process.argv[2]??'.');
const rel='scripts/phase2-qualification/control-context-verifier-root10-single-window';
const source=fs.readFileSync(path.join(repo,rel,'tool-entry.functions.js'),'utf8');
const manifestRaw=fs.readFileSync(path.join(repo,rel,'ControllerSourceManifest.candidate.json'));
const manifest=JSON.parse(manifestRaw),expected=sha(manifestRaw);
need(manifest.files.length===33&&manifest.qualification_issued===false,'EXACT_NO_AUTHORITY_33_FILE_MANIFEST');
for(const e of manifest.files){const b=fs.readFileSync(path.join(repo,e.path));need(b.length===e.bytes&&sha(b)===e.sha256,'EXACT_FROZEN_FILE:'+e.path)}
const extract=raw=>{
 const match=raw.match(/const linuxCmd=`([\s\S]*?)`;\s*const dockerExe=/);need(match,'EXACT_TEMPLATE_FOUND');
 const interpolations=match[1].match(/\$\{[^}]*\}/g)??[];need(interpolations.length===1&&interpolations[0]==='${expected}','EXACT_EXPECTED_ONLY_INTERPOLATION');
 return Function('expected','return `'+match[1]+'`')(expected);
};
const command=extract(source);
const image='clued-root9-toolhost@sha256:c2ee561dddcb5de59ba6d0a1cd8cd0d17ce50c9f916436075771629a6e0dab71';
const run=cmd=>spawnSync('docker',['run','--rm','--network','none','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=128m','--pids-limit','128','--memory','768m','--cpus','1','--security-opt','no-new-privileges','--cap-drop','ALL','--mount',`type=bind,src=${repo},dst=/home/user/cross-memory-system,readonly`,'--mount','type=volume,src=clued-root9-node-modules,dst=/home/user/cross-memory-system/apps/clued-cloud,readonly',image,'/usr/bin/dash','-ec',cmd],{encoding:'utf8',windowsHide:true,timeout:90000,maxBuffer:1024*1024});
const actual=run(command);
const messages=(actual.stdout??'').split(/\r?\n/).flatMap(line=>{try{return[JSON.parse(line)]}catch{return[]}});
const noInput=messages.find(m=>m.state==='BLOCKED'&&m.reason==='BOUNDED_STDIN_INPUT_REQUIRED');
need(!actual.error&&noInput,'CORRECTED_EXACT_ENTRY_MUST_REACH_REAL_CLI_NO_INPUT_REFUSAL:'+JSON.stringify({status:actual.status,stdout:actual.stdout,stderr:actual.stderr,error:actual.error?.message}));
const fixed='encoded=(json.dumps(entries,separators=(",",":"))+"\\\\n").encode()';
const broken='encoded=(json.dumps(entries,separators=(",",":"))+"\\n").encode()';
need(source.split(fixed).length===2,'ONE_EXACT_ESCAPE_CORRECTION');
const oldSource=source.replace(fixed,broken),negative=run(extract(oldSource));
need(negative.status!==0&&negative.stderr.includes('SyntaxError: unterminated string literal')&&!negative.stdout.includes('BOUNDED_STDIN_INPUT_REQUIRED'),'OLD_TEMPLATE_MUST_FAIL_BEFORE_CLI');
const report={state:'EXACT_GENERATED_TOOL_ENTRY_CORRECTION_REGRESSION_PASS',observed_at:new Date().toISOString(),controller_sha256:expected,source_sha256:sha(source),source_bytes:Buffer.byteLength(source),manifest_file_count:33,positive:{status:actual.status,stdout:actual.stdout,stderr:actual.stderr,command_sha256:sha(command)},negative:{status:negative.status,stdout:negative.stdout,stderr:negative.stderr,command_sha256:sha(extract(oldSource))},isolation:{network:'none',read_only_root:true,read_only_repository:true,docker_socket_mounted:false,stdin:'absent'},ga_issued:false,database_write:false,formal_pqual_claimed:false,authority_effect:'NONE'};
const output=JSON.stringify(report,null,2)+'\n';
if(process.argv[3])fs.writeFileSync(process.argv[3],output,{flag:'wx'});
process.stdout.write(output);
