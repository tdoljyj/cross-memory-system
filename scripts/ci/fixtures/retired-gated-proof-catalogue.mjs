// The last gated-proof catalogue that registered the ten workflows deleted with their entries
// (clued-cloud-quality-gate, clued-components, runner-budget-policy, the six handover hook
// qualification workflows and clued-connection-authorization): the exact Git objects of main 4a3e0485. Tests whose fixtures were those
// entries, or whose frozen digests describe a catalogue that still had them, read them from here;
// nothing in this module is an active registration.
import {execFileSync} from 'node:child_process';
import {parseWorkflowProfiles} from '../clued-workflow-profile.mjs';

export const RETIRED_CATALOGUE_COMMIT='4a3e048579e766d66285246b7fa93cd545514fb3';
export const RETIRED_CATALOGUE_BLOBS=Object.freeze({profiles:'2a59cc0fee3ea1d62b6e2a18dea41b835184f28f',roles:'e23a3d9f16bd4ac0fa0791175ad070096e0314bf'});
const ROOT=new URL('../../../',import.meta.url);
const object=blob=>execFileSync('git',['cat-file','blob',blob],{cwd:ROOT,maxBuffer:8*1024*1024});
// Other retired generations are read from their immutable commit trees, never the working catalogue.
const catalogueObject=(commit,kind)=>{
  if(commit===RETIRED_CATALOGUE_COMMIT)return object(RETIRED_CATALOGUE_BLOBS[kind]);
  if(!/^[a-f0-9]{40}$/.test(commit))throw Error('retired catalogue requires a full commit SHA');
  const file=kind==='profiles'?'clued-gated-proof-profiles.json':'clued-gated-proof-role-specs.json';
  return object(`${commit}:scripts/ci/${file}`);
};
export const retiredProfilesRaw=(commit=RETIRED_CATALOGUE_COMMIT)=>catalogueObject(commit,'profiles');
export const retiredRolesRaw=(commit=RETIRED_CATALOGUE_COMMIT)=>catalogueObject(commit,'roles');
// The bytes a retired workflow had at that commit: the last Source its catalogue entry described.
export const retiredWorkflowBlob=file=>execFileSync('git',['rev-parse',`${RETIRED_CATALOGUE_COMMIT}:${file}`],{cwd:ROOT,encoding:'utf8'}).trim();
export const retiredCatalogue=(commit=RETIRED_CATALOGUE_COMMIT)=>({registry:parseWorkflowProfiles(retiredProfilesRaw(commit)),specs:JSON.parse(retiredRolesRaw(commit))});
// Puts the retired workflows' entries back into a copy of the current catalogue (registry and specs are mutated).
export function restoreRetiredEntries(registry,specs){
  const old=retiredCatalogue(),files=Object.keys(old.registry.workflows).filter(file=>!Object.hasOwn(registry.workflows,file));
  for(const file of files){registry.workflows[file]=old.registry.workflows[file];specs.workflows[file]=old.specs.workflows[file];}
  return files;
}
