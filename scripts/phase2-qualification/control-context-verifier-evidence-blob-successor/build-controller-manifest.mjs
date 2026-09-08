// Build only after both owners freeze their exact sources. Never an acceptance/qualification issuer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import './context.mjs';
import '../control-context-verifier-runtime600/grr.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../../..');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const require=createRequire(new URL('../../../apps/clued-cloud/package.json',import.meta.url));
const q='scripts/phase2-qualification/';
export const fixedSeeds=[
 ...['original-inputs-blob.mjs','original_input_publisher.py','result-terminal.mjs','context.mjs','source-publication.mjs','cli.mjs','tool-entry.functions.js'].map(x=>'control-context-verifier-evidence-blob-successor/'+x),
 'nonproduction-control-store/runtime-successor/binding-evidence-successor/alter.candidate.sql',
 'nonproduction-control-store/runtime-successor/binding-evidence-successor/effective-binding.sql',
 'nonproduction-control-store/runtime-successor/intent-response-successor/alter.candidate.sql',
 'result-evidence-resolution/resolve.mjs',
 'control-context-verifier-runtime600/result-terminal.mjs',
 'scenario-observations/request-denials.mjs','scenario-observations/request-denials-packed.mjs','scenario-observations/sign-exact-live-object.mjs',
 'preentry-parent/runtime-successor/supervisor.mjs','preentry-parent/runtime-successor/sql_effect.mjs',
 'preentry-parent/runtime-successor/host-runtime600/fixed_host.py','preentry-parent/runtime-successor/host-runtime600/parent600.py',
 'preentry-parent/runtime-successor/host-tool-bridge600/bridge.py',
 'docker-engineering-observation/observe.py','docker-engineering-observation/validation.py',
 'linux-docker-driver/candidate.py','docker-isolation/probe.py','docker-isolation/prepare.py',
 'qualification-runtime/remote_evidence.py','control-root-registration/verify.py','qualification-runtime/fixed_skill_fixture.py',
 'nonproduction-control-store/install.candidate.sql',
 'nonproduction-control-store/runtime-successor/budget-reservation-successor/install.candidate.sql',
 'nonproduction-control-store/runtime-successor/runtime600-successor/alter.candidate.sql',
 'nonproduction-control-store/runtime-successor/budget-reservation-successor/client.mjs',
 'nonproduction-control-store/runtime-successor/control-objects-successor/client.mjs',
 'nonproduction-control-store/runtime-successor/client.mjs',
 'nonproduction-control-store/runtime-successor/commitment-signing/signing.mjs',
 'nonproduction-control-store/protocol-successor/validate-successor.mjs','nonproduction-control-store/protocol-successor/control-trust-root-set.schema.json',
 'preentry-parent/profile-runtime600/ProfileDefinition.json',
 'preentry-parent/profile-successor/revocation-epoch-vector.candidate.schema.json',
 'preentry-parent/profile-successor/gate-authorization.candidate.schema.json',
 ...['transport.mjs','dispatch-evidence.mjs','status-manifest.candidate.schema.json','gate-result-receipt.candidate.schema.json'].map(x=>'control-context-verifier-runtime180/'+x),
 ...['context.mjs','trusted-github.mjs','grr.mjs','cli.mjs','tool-entry.functions.js','host-effect.mjs','budget-evidence.mjs','late-bound-policy.mjs','source-publication.mjs','write-targets.mjs','positive-terminal-observations.mjs','publication-observations.mjs','historical-component-observations.mjs'].map(x=>'control-context-verifier-runtime600/'+x)
].map(x=>q+x);
const binaries=['C:/Program Files/nodejs/node.exe','C:/Program Files/GitHub CLI/gh.exe','C:/Users/Windows/AppData/Local/Programs/Python/Python312/python.exe','C:/Program Files/Docker/Docker/resources/bin/docker.exe'];
export function inside(p,root){const relative=path.relative(path.resolve(root),path.resolve(p));return relative===''||(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative));}
export function encodeManifest(entries){
 const paths=new Set();
 for(const e of entries){
  if(!e||typeof e.path!=='string'||e.path.includes('..')||/ControllerSourceManifest|Acceptance|ReviewSubject|SigningPayload|CandidateEvidence|SourceBindings|build-controller-manifest|python-import-catalog/.test(e.path))throw Error('SOURCE_ONLY_NO_SELF_OR_ACCEPTANCE_METADATA');
  const key=e.path.toLowerCase();if(paths.has(key))throw Error('DUPLICATE_SOURCE_PATH');paths.add(key);
  const exactEmptyDependency=e.role==='RUNTIME_DEPENDENCY'&&e.bytes===0&&e.sha256==='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  if(!Number.isSafeInteger(e.bytes)||(e.bytes<=0&&!exactEmptyDependency)||!/^[a-f0-9]{64}$/.test(e.sha256)||!['REPOSITORY_SOURCE','RUNTIME_DEPENDENCY'].includes(e.role))throw Error('ACTUAL_TYPED_SOURCE_BYTES_REQUIRED:'+e.path);
 }
 for(const p of fixedSeeds)if(!paths.has(p.toLowerCase()))throw Error('MISSING_FIXED_CONTROLLER_SOURCE:'+p);
 return JSON.stringify({object_type:'ControllerSourceManifest',format:'EXACT_SORTED_SOURCE_BYTES_V1_CANDIDATE',scope:'ISOLATED_TEST/SKILL_COEXISTENCE_QUALIFICATION',files:[...entries].sort((a,b)=>a.path.localeCompare(b.path,'en')),authority_effect:'NONE',qualification_issued:false})+'\n';
}
export function build(){
 const paths=new Set(fixedSeeds.map(p=>path.resolve(repo,p)));
 // Resolve and check fixed new Store files before running even the read-only import probe.
 for(const p of paths)if(!fs.existsSync(p))throw Error('FROZEN_SOURCE_NOT_AVAILABLE:'+path.relative(repo,p));
 for(const p of Object.keys(require.cache))paths.add(p);
 for(const p of [...paths])for(let parent=path.dirname(p);inside(parent,repo);parent=path.dirname(parent)){
  const meta=path.join(parent,'package.json');if(fs.existsSync(meta))paths.add(meta);if(parent===repo)break;
 }
 const python=binaries[2];if(hash(fs.readFileSync(python))!=='4d6f5f81a4bca11191c4c7c6b43632694d0a4ce74e068619d8fdc161d469859a')throw Error('EXACT_PYTHON_BINARY_DRIFT');
 const imported=JSON.parse(execFileSync(python,['-I','-S','-B',path.join(here,'python-import-catalog.py')],{encoding:'utf8',timeout:10000,maxBuffer:2*1024*1024,windowsHide:true}));
 if(imported.state!=='OBSERVED_IMPORTS_NO_HOST_EFFECT')throw Error('FIXED_IMPORT_OBSERVATION_REQUIRED');
 const pythonRoot=path.dirname(python);
 for(const p of imported.files){const absolute=path.resolve(p);if(!inside(absolute,repo)&&!inside(absolute,pythonRoot))throw Error('IMPORT_OUTSIDE_FIXED_RUNTIME');if(absolute!==path.join(here,'python-import-catalog.py'))paths.add(absolute);}
 // CPython builtins/stdlib loader also uses these fixed runtime DLLs when present.
 for(const filename of ['python312.dll','python3.dll']){const p=path.join(pythonRoot,filename);if(fs.existsSync(p))paths.add(p);}
 for(const file of ['ready-loader.mjs','launcher.mjs','read-output.mjs','message.mjs','deliver.mjs','sha256.mjs','tool-entry.functions.js'])paths.add(path.resolve(repo,'../normal600-pipe-evidence-blob/',file));
 for(const p of binaries)paths.add(path.resolve(p));
 const entries=[...paths].map(p=>{const raw=fs.readFileSync(p),name=(inside(p,repo)?path.relative(repo,p):p).replaceAll('\\','/');return {path:name,role:fixedSeeds.includes(name)?'REPOSITORY_SOURCE':'RUNTIME_DEPENDENCY',bytes:raw.length,sha256:hash(raw)};});
 for(const e of entries){const actual=fs.readFileSync(path.isAbsolute(e.path)?e.path:path.join(repo,e.path));if(actual.length!==e.bytes||hash(actual)!==e.sha256)throw Error('SOURCE_CHANGED_DURING_CATALOG');}
 const raw=encodeManifest(entries),output=path.join(here,'ControllerSourceManifest.candidate.json');
 fs.writeFileSync(output,raw,{flag:'wx'});
 return {state:'ACTUAL_SOURCE_CLOSURE_CANDIDATE_NOT_QUALIFIED',files:entries.length,sha256:hash(raw),path:path.relative(repo,output).replaceAll('\\','/'),loaded_python_modules:imported.files.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.stdout.write(JSON.stringify(build())+'\n');
