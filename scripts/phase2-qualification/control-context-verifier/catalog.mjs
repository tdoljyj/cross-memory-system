// Local source catalog only; does not activate a runtime or contact a service.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {sha} from './trusted-github.mjs';
import './context.mjs';
import './grr.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'../../..');
const require=createRequire(new URL('../../../apps/clued-cloud/package.json',import.meta.url));
const entry=p=>{const raw=fs.readFileSync(p);return {path:path.relative(repo,p).replaceAll('\\','/'),bytes:raw.length,sha256:sha(raw)};};
const dependencies=new Set(Object.keys(require.cache));
for(const modulePath of [...dependencies]){
 for(let p=path.dirname(modulePath);p.startsWith(repo);p=path.dirname(p)){
  const meta=path.join(p,'package.json');if(fs.existsSync(meta))dependencies.add(meta);
  if(p===repo)break;
 }
}
const external=[
 '../preentry-parent/profile-successor/ProfileDefinition.json',
 '../preentry-parent/profile-successor/revocation-epoch-vector.candidate.schema.json',
 '../preentry-parent/profile-successor/gate-authorization.candidate.schema.json',
 '../preentry-parent/profile-successor/signing/ProfileSigningPayload.json',
 '../nonproduction-control-store/protocol-successor/validate-successor.mjs',
 '../nonproduction-control-store/protocol-successor/control-trust-root-set.schema.json',
 '../nonproduction-control-store/runtime-successor/commitment-signing/signing.mjs'
].map(p=>entry(path.resolve(here,p)));
const local=fs.readdirSync(here).filter(n=>!['SourceBindings.json','CandidateEvidence.json'].includes(n)).sort().map(n=>entry(path.join(here,n)));
const catalog={state:'SOURCE_CATALOG_FOR_INDEPENDENT_CLOSED_RUNTIME_REVIEW_ONLY',original_source:{zip_path:'C:/Users/Windows/Documents/Codex/2026-09-07/ni-6/work/candidate-source/Clued_Phase2_三轨修订与补证_完整审查候选包_v0.2.7.1_Manifest修复_20260906.zip',member:'Clued_Phase2_三轨修订与补证_v0.2.7_20260906/sources/architecture_v024/sources/Clued_Kernel_Next_多厂商连续性与执行基础设施完整整合方案_v3.3.md',sha256:'f967fdf3e63028d29ed191160698726b5d707aaae63bd951f6ba2e8584936fec',bytes:557313,lines:[3435,3437,3439,3441,3878,3879,3880,3885,3891,4308,4309,4310,4320,4346]},files:local,external_sources:external,actual_loaded_commonjs_and_resolution_metadata:[...dependencies].sort().map(entry),executables:['C:/Program Files/nodejs/node.exe','C:/Program Files/GitHub CLI/gh.exe'].map(p=>{const e=entry(p);return {...e,path:p};}),boundary:'Observed loaded source inventory, not an independently qualified source closure. Host owner must bind and check this with its own supervisor/host before launch. No actual authorization or signature instance.'};
fs.writeFileSync(path.join(here,'SourceBindings.json'),JSON.stringify(catalog,null,2)+'\n');
process.stdout.write(JSON.stringify({files:local.length,external:external.length,dependency_files:dependencies.size,source_bindings_sha256:sha(fs.readFileSync(path.join(here,'SourceBindings.json')))})+'\n');
