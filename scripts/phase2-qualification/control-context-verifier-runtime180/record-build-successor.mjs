// Exact forward preparation record; preserves prior candidate/SourceBindings bytes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../../..');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const info=p=>{const b=fs.readFileSync(p);return {path:path.relative(repo,p).replaceAll('\\','/'),bytes:b.length,sha256:sha(b)};};
const prior=JSON.parse(fs.readFileSync(path.join(here,'SourceBindings.json')));
const additional=['manifest-path.test.mjs','ManifestPathCorrection.json','stop-and-empty-dependency.test.mjs','record-build-successor.mjs'];
const files=[...prior.files.map(e=>e.path),...additional.map(n=>path.relative(repo,path.join(here,n)))].map(p=>info(path.resolve(repo,p)));
const external=prior.external_fixed_sources.map(e=>info(path.join(repo,e.path)));
const history=fs.readdirSync(path.join(here,'history-before-stop-correction')).sort().map(n=>info(path.join(here,'history-before-stop-correction',n)));
const objects=['ControllerSourceManifest.candidate.json','GateDefinitionCandidate.json','preentry-skill-qualification.json','RegistrySuccessorCandidate.json','StaticInputChangeSet.json'].map(n=>info(path.join(here,n)));
const bindings={state:'EXACT_FORWARD_SOURCE_BINDINGS_FOR_INDEPENDENT_REVIEW',predecessor_source_bindings_sha256:'1c28671cf8d2820c971dfca597619807ca9b16c52622fe5a55d8df394a214e8c',files,external_fixed_sources:external,historical_sources:history,actual_generated_objects:objects};
const raw=JSON.stringify(bindings,null,2)+'\n';fs.writeFileSync(path.join(here,'SuccessorSourceBindings.json'),raw);
const report={state:'ACTUAL_MANIFEST_AND_STATIC_SUCCESSOR_BUILT_NOT_QUALIFIED',predecessor_candidate_sha256:'270551fad13e299727022d8894bd7bb8a316800a0979a571f0e9177f8507b595',successor_source_bindings_sha256:sha(raw),changes:[{finding:'Mixed Windows path separators caused false outside-runtime rejection',correction:'Native resolved relative-path boundary, fixed roots unchanged',test:{pass:1,fail:0,duration_ms:106.94}},{finding:'Actual Python Lib/urllib/__init__.py is a legitimate zero-byte dependency',correction:'Retain dependency with size0 and exact SHA256 of empty bytes; implementation sources remain nonempty; double-read actual bytes still required',actual_path:'C:/Users/Windows/AppData/Local/Programs/Python/Python312/Lib/urllib/__init__.py',actual_sha256:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',test:{pass:1,fail:0,duration_ms:110.7786}},{finding:'GRR outer STOP wrapper did not bind complete inspect identity/exit',correction:'Require same full observation.Id, numeric integer Pid0, Runningfalse, Statusexited, nonzero valid calendar FinishedAt matching original fixed Docker STOP semantics',actual_positive_source:{path:'scripts/phase2-qualification/docker-engineering-observation/work/observation/main-after-stop.stdout',bytes:9091,sha256:'2481ef1f263a714083f51cfa4f213bf43f0df0a071ce54bf7de5b3c56b781f82'},test:{pass:1,fail:0,test_ms:1.3022,wrong_id_pid_calendar_mutations_rejected:true}}],actual_build:{controller_manifest_files:192,observed_python_files:105,wx_manifest_write_succeeded:true,wx_static_objects_write_succeeded:true,objects},old_nine_tests_rerun:false,original_candidate_and_bindings_preserved:true,history_before_stop_correction_preserved:true,current_formal_pqual_run:false,controller_qualification_issued:false,authority_effect:'NONE'};
const out=JSON.stringify(report,null,2)+'\n';fs.writeFileSync(path.join(here,'StopAndManifestBuildSuccessor.json'),out);
process.stdout.write(JSON.stringify({report_sha256:sha(out),source_bindings_sha256:sha(raw),files:files.length,external:external.length})+'\n');
