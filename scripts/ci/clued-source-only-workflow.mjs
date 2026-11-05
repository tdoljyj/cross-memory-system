// Source metadata recognition only. No acceptance, execution proof, dispatch or activation.
import {compileRegisteredWorkflow,decodeWorkflowProfiles,native617PendingWorkflowCatalogue,
  registeredWorkflowSource,rolesForSource,roleDefinitionDigest,workflowBlob} from './clued-workflow-profile.mjs';
import {createHash} from 'node:crypto';

export const COMPONENT_VERSION='1.0.0';
export const REGISTERED_SOURCE='REGISTERED_SOURCE';
export const SOURCE_METADATA_ONLY_DISABLED='SOURCE_METADATA_ONLY_DISABLED';
const CONTRACT='clued.catalogue-workflow-source-recognition/1';
const hash=text=>createHash('sha256').update(text).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
// Exact already recorded technical Source bytes and complete definitions. These
// pins carry no current Host/TTL/Operator/installation acceptance or permission.
export const SOURCE_ONLY_METADATA_PINS=freeze({
  '.github/workflows/clued-handover-external-qualification.yml':{
    blob:'689a1c5fcdbefa5353715f55e39c0fc08a9f5230',
    source_sha256:'c42ab88ddb6e8f0774ec55cecf3507578870f8233d6ec11c09162212f3442d5f',
    workflow_definition_sha256:'6167e3acdc666d97021e8dd068c9b1b02a14b87ad7a7ee4116f81a832af7ed30',
    job_id:'qualify',full_role_sha256:'a77530f06f94f08370d3fe759d31042687f4f34430d60849f520a2b0526d2ef9'},
  '.github/workflows/clued-handover-disposable-idle.yml':{
    blob:'97c39730ce75f2ea2427c9fa3845f9df32e998f8',
    source_sha256:'133554a025b122737198289925920b31992191a96a5321242d3c78cf119acf66',
    workflow_definition_sha256:'ed7a2f81f6c43de8b473a60f30a7a155c7c3197fec6c2a3a09c71d49c1b8ba66',
    job_id:'disposable-idle',full_role_sha256:'d6dce50d38f3a75a290776243f8065ad69cbfd4fa68327f75a8ce3055965fd3d'}
});
const deny=()=>freeze({contract:CONTRACT,source_identified:false,kind:null,execution_eligible:false,
  reason:'CATALOGUE_SOURCE_NOT_IDENTIFIED'});
const need=value=>{if(!value)throw Error('CATALOGUE_SOURCE_NOT_IDENTIFIED');};

// Snapshot descriptor values once. No getter/toJSON/function or foreign error
// value is evaluated or copied into the returned, deeply frozen descriptor.
function snapshot(value){
  let nodes=0;const seen=new Set();
  function copy(v,depth=0){
    need(++nodes<=250000&&depth<=64);
    if(v===null||typeof v==='boolean')return v;
    if(typeof v==='string'){need(v.isWellFormed());return v;}
    if(typeof v==='number'){need(Number.isFinite(v));return v;}
    need(v&&typeof v==='object'&&!seen.has(v));
    const array=Array.isArray(v),proto=Object.getPrototypeOf(v);
    need(array?proto===Array.prototype:proto===Object.prototype||proto===null);
    seen.add(v);const descriptors=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(descriptors);
    need(keys.every(key=>typeof key==='string'&&Object.hasOwn(descriptors[key],'value')&&
      (array&&key==='length'||descriptors[key].enumerable)&&!['__proto__','prototype','constructor'].includes(key)));
    let result;
    if(array){
      const length=descriptors.length?.value;
      need(Number.isSafeInteger(length)&&length<=20000&&keys.length===length+1);result=[];
      for(let index=0;index<length;index++){
        need(Object.hasOwn(descriptors,String(index)));result.push(copy(descriptors[index].value,depth+1));
      }
    }else{
      result={};for(const key of keys)result[key]=copy(descriptors[key].value,depth+1);
    }
    seen.delete(v);return result;
  }
  const result=copy(value);need(Buffer.byteLength(JSON.stringify(result))<=2097152);return result;
}
function independentRoles(specs,file,blob,primaryIds){
  const roles=rolesForSource(specs,file,blob);
  need(Array.isArray(primaryIds)&&primaryIds.length>0&&new Set(primaryIds).size===primaryIds.length&&
    Array.isArray(roles)&&roles.length===primaryIds.length&&roles.every(role=>
      ['definition_sha256|job_id','definition|definition_sha256|job_id'].includes(Object.keys(role).sort().join('|'))&&
      primaryIds.includes(role.job_id)&&(!Object.hasOwn(role,'definition')||
        role.definition&&roleDefinitionDigest(role.definition)===role.definition_sha256)));
  return roles;
}

function metadataDescriptors(registry,roleSpecs){
  // Preserve every top-level catalogue scope. Only the active file map is
  // narrowed to the complete three pending subjects needed by this checker.
  const names=registry.native617_pending_sources.map(entry=>entry.file);
  const pendingView={...registry,workflows:Object.fromEntries(names.filter(name=>
    Object.hasOwn(registry.workflows,name)).map(name=>[name,registry.workflows[name]]))};
  const pending=native617PendingWorkflowCatalogue(pendingView,roleSpecs);
  need(pending.structurally_valid===true&&pending.passed===false&&pending.host_qualified===false&&
    pending.execution_permitted===false);
  // Validate both exact External subjects even when only one is requested.
  // The whole-definition pin binds paths/triggers and the independent role
  // pin binds execution steps; caller-supplied assertions cannot replace either.
  const verified=new Map();
  for(const [name,pin] of Object.entries(SOURCE_ONLY_METADATA_PINS)){
    const entries=pending.entries.filter(entry=>entry.file===name&&entry.workflow_blob===pin.blob);
    need(entries.length===1);const entry=entries[0];
    need(entry.source_sha256===pin.source_sha256&&workflowBlob(entry.source_yaml)===pin.blob&&
      hash(entry.source_yaml)===pin.source_sha256&&
      roleDefinitionDigest(entry.workflow_definition)===pin.workflow_definition_sha256);
    const rows=roleSpecs.native617_pending_sources.filter(row=>row.file===name&&row.workflow_blob===pin.blob);
    need(rows.length===1&&rows[0].roles.length===1);const roles=rows[0].roles,role=roles[0];
    need(role.job_id===pin.job_id&&role.definition_sha256===pin.full_role_sha256&&
      roleDefinitionDigest(role.definition)===pin.full_role_sha256);
    verified.set(name,{entry,roles});
  }
  const descriptors=new Map();
  for(const [file,{entry,roles}] of verified){
    const fixed=SOURCE_ONLY_METADATA_PINS[file],blob=fixed.blob;
    // Pure command/path projection using the exact pinned definition. The
    // compiler's registered result is never returned, stored or granted.
    const projection=compileRegisteredWorkflow(entry.source_yaml,{primary_ids:[fixed.job_id],
      accepted_roles:roles,parseYaml:()=>entry.workflow_definition});
    const profile={schema:'clued.source-only-workflow-profile/1',registration_status:'source_metadata_only_disabled',
      execution_eligible:false,workflow_blob:blob,source_sha256:fixed.source_sha256,
      primary_ids:projection.primary_ids,pull_request:projection.pull_request,gated:projection.gated,
      routes:projection.routes.map(route=>({...route,execution_eligible:false}))};
    descriptors.set(file,freeze({contract:CONTRACT,source_identified:true,kind:SOURCE_METADATA_ONLY_DISABLED,
      execution_eligible:false,file,blob,host_qualified:false,operator_accepted:false,runtime_authorized:false,
      profile,roles}));
  }
  return descriptors;
}


// Only descriptor reads are used by the one-off adapter. Large catalogue data
// are copied exactly once inside the factory, never once for argument unpacking.
function fields(input,expected){
  need(input&&typeof input==='object'&&!Array.isArray(input));
  const proto=Object.getPrototypeOf(input);need(proto===Object.prototype||proto===null);
  const descriptors=Object.getOwnPropertyDescriptors(input),keys=Reflect.ownKeys(descriptors);
  need(keys.length===expected.length&&keys.every(key=>typeof key==='string'&&expected.includes(key)&&
    Object.hasOwn(descriptors[key],'value')&&descriptors[key].enumerable));
  return Object.fromEntries(expected.map(key=>[key,descriptors[key].value]));
}

export function createCatalogueSourceReader(input){
  try{
    const args=snapshot(input);
    need(args&&Object.keys(args).sort().join('|')==='registry|roleSpecs');
    const registry=freeze(decodeWorkflowProfiles(args.registry)),roleSpecs=freeze(args.roleSpecs);
    // Request-local immutable data only. This stores no raw re-read, Owner
    // currentness, acceptance, TTL or admission result; callers reverify those.
    const ordinaryCache=new Map();let metadata=null,metadataAttempted=false;
    return Object.freeze(function readCatalogueSource(request){
      try{
        const {file,blob}=fields(request,['file','blob']);
        need(typeof file==='string'&&file.length<=255&&/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(file)&&
          typeof blob==='string'&&/^[a-f0-9]{40}$/.test(blob));
        const fixed=SOURCE_ONLY_METADATA_PINS[file];
        if(fixed?.blob===blob){
          // Validate all three pending/active boundaries before any ordinary
          // lookup for a disabled subject. A self-registration anywhere in the
          // shared pending set must not turn a sibling into an ordinary Source.
          if(!metadataAttempted){
            metadataAttempted=true;
            try{metadata=metadataDescriptors(registry,roleSpecs);}catch{metadata=null;}
          }
          return metadata?.get(file)??deny();
        }
        const key=file+'\0'+blob;
        if(ordinaryCache.has(key))return ordinaryCache.get(key);
        const root=registry.workflows[file];
        if(!root)return deny();
        // Retain all schema/future/native catalogue scopes and the complete
        // target root+accepted_sources. Existing core relation validation still
        // runs; it no longer traverses unrelated active file Sources each time.
        const view={...registry,workflows:{[file]:root}};
        const ordinary=registeredWorkflowSource(view,file,blob);
        if(!ordinary.passed)return deny();
        const roles=independentRoles(roleSpecs,file,blob,ordinary.profile.primary_ids);
        const descriptor=freeze({contract:CONTRACT,source_identified:true,kind:REGISTERED_SOURCE,
          execution_eligible:true,file,blob,profile:ordinary.profile,roles});
        // Cache only verified static identities: arbitrary unknown inputs cannot
        // grow a request-local map or become proof/authorization cache entries.
        ordinaryCache.set(key,descriptor);return descriptor;
      }catch{return deny();}
    });
  }catch{return Object.freeze(()=>deny());}
}

export function recognizeCatalogueWorkflow(input){
  try{
    const {registry,roleSpecs,file,blob}=fields(input,['registry','roleSpecs','file','blob']);
    return createCatalogueSourceReader({registry,roleSpecs})({file,blob});
  }catch{return deny();}
}
