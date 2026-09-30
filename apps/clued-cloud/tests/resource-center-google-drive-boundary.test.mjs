import assert from 'node:assert/strict';
import test from 'node:test';
import {createGoogleDriveBoundaryScanner} from '../../../kernel/host/resource-center-google-drive-boundary.mjs';
import {createGoogleDriveMetadataApi} from '../../../kernel/host/resource-center-google-drive-metadata.mjs';
const FOLDER='application/vnd.google-apps.folder',root='/drive/Clued_资料中心';
const item=(id,name,parent,mimeType=FOLDER)=>({id,name,parents:parent?[parent]:[],mimeType,version:'1',trashed:false});
function fixture(overrides={},mode='single'){
  const files=[item('parent','drive'),item('root','Clued_资料中心','parent'),item('ordinary','work','parent'),
    item('island','Clued-old','ordinary'),item('drop','Clued_说明.md','parent','text/plain')];
  const config={trusted_profile:{registration_status:'registered',managed_root:root,allowed_root_children:['track'],...overrides},
    root_folder_id:'root',root_parent_id:'parent',scan_roots:[{folder_id:'parent',path:'/drive'}],
    get_file:async id=>structuredClone(files.find(f=>f.id===id)),list_folder:async id=>structuredClone(files.filter(f=>f.parents.includes(id)))};
  // Batched adapters read through the single-item functions at call time, so
  // a test that replaces get_file/list_folder drives both modes identically.
  if(mode==='batched')Object.assign(config,{get_files:ids=>Promise.all(ids.map(id=>config.get_file(id))),
    list_folders:ids=>Promise.all(ids.map(id=>config.list_folder(id)))});
  return {files,config,scan:()=>createGoogleDriveBoundaryScanner(config)()};
}
for(const mode of ['single','batched']){
test(mode+': remote metadata boundary detects root drop and nested sibling island without model or content',async()=>{
  const f=fixture({},mode),result=await f.scan();
  assert.equal(result.length,2);assert.ok(result.every(r=>r.code==='UNAUTHORIZED_WORKSPACE_MUTATION'));
  assert.deepEqual(result.map(r=>r.path).sort(),['/drive/Clued_说明.md','/drive/work/Clued-old'].sort());
});
test(mode+': empty sibling namespace with exact root is clean; missing root is unknown, never clean',async()=>{
  const f=fixture({},mode);f.files.splice(2);assert.deepEqual(await f.scan(),[]);
  f.config.list_folder=async()=>[];await assert.rejects(f.scan(),/ROOT_NOT_LISTED/);
});
test(mode+': duplicate names, forged root ID, shortcuts and truncated depth fail closed',async()=>{
  const duplicate=fixture({},mode);duplicate.files.push(item('spoof','Clued_资料中心','parent'));await assert.rejects(duplicate.scan(),/PATH_AMBIGUOUS|ROOT_CHANGED/);
  const shortcut=fixture({},mode);shortcut.files.push(item('shortcut','link','parent','application/vnd.google-apps.shortcut'));await assert.rejects(shortcut.scan(),/SHORTCUT_UNQUALIFIED/);
  const depth=fixture({boundary_scan_max_depth:1},mode);await assert.rejects(depth.scan(),/DEPTH_LIMIT/);
  const entries=fixture({boundary_scan_max_entries:1},mode);await assert.rejects(entries.scan(),/ENTRY_LIMIT/);
  const alias=fixture({},mode);alias.files[1].parents=['other'];await assert.rejects(alias.scan(),/ROOT_CHANGED/);
});
test(mode+': folder identity drift and unqualified external allowlists cannot yield a clean scan',async()=>{
  const f=fixture({},mode);let reads=0;
  const original=f.config.get_file;f.config.get_file=async id=>{const value=await original(id);if(id==='parent'&&++reads>1)value.version='2';return value;};
  await assert.rejects(f.scan(),/BOUNDARY_CHANGED/);
  assert.throws(()=>createGoogleDriveBoundaryScanner(fixture({registered_external_roots:['/drive/work']},mode).config),/PROFILE_UNQUALIFIED/);
});
test(mode+': rename between parent enumeration and child GET cannot hide a Clued sibling behind its old path',async()=>{
  const f=fixture({},mode);f.files.splice(3);const original=f.config.get_file;
  f.config.get_file=async id=>{const value=await original(id);if(id==='ordinary'){value.name='Clued-hidden';value.version='2';}return value;};
  await assert.rejects(f.scan(),/BOUNDARY_CHANGED/);
});
}
test('folder enumeration exhausts empty and multi-result pages; partial search or repeated tokens deny',async()=>{
  let calls=0;const scopes='https://www.googleapis.com/auth/drive.metadata.readonly';
  const build=fetch=>createGoogleDriveMetadataApi({get_credential:async()=>({access_token:'synthetic-test-token',scope:scopes}),fetch});
  const api=build(async url=>{
    const u=new URL(url);assert.equal(u.searchParams.get('q'),"'parent' in parents and trashed = false");calls++;
    return Response.json(calls===1?{files:[],nextPageToken:'two',incompleteSearch:false}:{files:[item('a','a','parent'),item('b','b','parent')].map(f=>({...f,isAppAuthorized:true})),incompleteSearch:false});
  });
  assert.equal((await api.listFolder('parent')).length,2);assert.equal(calls,2);
  await assert.rejects(build(async()=>Response.json({files:[],incompleteSearch:true})).listFolder('parent'),/LIST_INVALID/);
  await assert.rejects(build(async()=>Response.json({files:[],nextPageToken:'again'})).listFolder('parent'),/PAGINATION_INVALID/);
  const narrow=createGoogleDriveMetadataApi({get_credential:async()=>({access_token:'synthetic-test-token',scope:'https://www.googleapis.com/auth/drive.file'}),fetch:async()=>{assert.fail('no request');}});
  await assert.rejects(narrow.listFolder('parent'),/NAMESPACE_VISIBILITY_UNPROVEN/);
});
// StorageNormalUse §3.1: a normal (drive.readonly) credential lists the Owner's
// whole Drive. The write-path metadata API keeps only app-authorized entries, so
// the scan observes the same namespace a drive.file credential observed.
function driveFixture(scope){
  const files=[item('parent','My Drive'),item('root','Clued_资料中心','parent'),item('track','track','root')]
    .map(f=>({...f,isAppAuthorized:true}));
  const owner=(id,name,parent,mimeType)=>files.push({...item(id,name,parent,mimeType),isAppAuthorized:false});
  const fetch=async url=>{
    const u=new URL(url),q=u.searchParams.get('q'),wants=(u.searchParams.get('fields')??'').includes('isAppAuthorized');
    const project=({isAppAuthorized,...rest})=>wants?{...rest,isAppAuthorized}:rest;
    if(q){
      const parent=/'([^']+)' in parents/.exec(q)[1];
      return Response.json({files:files.filter(f=>f.parents.includes(parent)).map(project),incompleteSearch:false});
    }
    const found=files.find(f=>f.id===u.pathname.split('/').at(-1));
    return found?Response.json(project(found)):new Response('',{status:404});
  };
  const api=createGoogleDriveMetadataApi({get_credential:async()=>({access_token:'synthetic-test-token',scope}),fetch});
  const scanner=mode=>createGoogleDriveBoundaryScanner({
    trusted_profile:{registration_status:'registered',managed_root:'/My Drive/Clued_资料中心',allowed_root_children:['track']},
    root_folder_id:'root',root_parent_id:'parent',scan_roots:[{folder_id:'parent',path:'/My Drive'}],
    get_file:api.getFile,list_folder:api.listFolder,
    ...(mode==='batched'?{get_files:ids=>Promise.all(ids.map(id=>api.getFile(id))),list_folders:ids=>Promise.all(ids.map(id=>api.listFolder(id)))}:{})});
  return {files,owner,scan:mode=>scanner(mode)()};
}
const NORMAL='https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly https://www.googleapis.com/auth/drive.readonly';
const LEGACY='https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly';
for(const mode of ['single','batched']){
test(mode+': normal-scope scan ignores Owner files that drive.file never listed',async()=>{
  const f=driveFixture(NORMAL);
  // Owner material everywhere: Clued-named documents beside the root, a root child
  // outside allowed_root_children, duplicate names, a shortcut, a deep tree and many entries.
  f.owner('doc','Clued_单一数据源方案.gdoc','parent','application/vnd.google-apps.document');
  f.owner('dup1','Clued_单一数据源方案.gdoc','parent','application/vnd.google-apps.document');
  f.owner('start','00_从这里开始','root');f.owner('dupTrack','track','root');
  f.owner('link','shortcut','parent','application/vnd.google-apps.shortcut');
  let deep='parent';for(let i=0;i<12;i++){f.owner('deep'+i,'level'+i,deep);deep='deep'+i;}
  f.owner('island','Clued-old','deep3');
  for(let i=0;i<120;i++)f.owner('bulk'+i,'photo.png','track','image/png');
  f.owner('spoof','Clued_资料中心','parent');
  assert.deepEqual(await f.scan(mode),[]);
});
test(mode+': normal-scope scan still flags app-authorized unexpected entries exactly as before',async()=>{
  const normal=driveFixture(NORMAL),legacy=driveFixture(LEGACY);
  for(const f of [normal,legacy]){
    f.files.push({...item('drop','Clued_说明.md','parent','text/plain'),isAppAuthorized:true});
    f.files.push({...item('work','work','parent'),isAppAuthorized:true},{...item('nest','Clued-old','work'),isAppAuthorized:true});
    f.owner('ownerDoc','Clued_notes','parent','text/plain');
  }
  const paths=async f=>(await f.scan(mode)).map(r=>[r.code,r.path]).sort();
  const expected=[['UNAUTHORIZED_WORKSPACE_MUTATION','/My Drive/Clued_说明.md'],['UNAUTHORIZED_WORKSPACE_MUTATION','/My Drive/work/Clued-old']];
  assert.deepEqual(await paths(normal),expected);assert.deepEqual(await paths(legacy),expected);
  // An app-authorized duplicate or shortcut still fails closed.
  const dup=driveFixture(NORMAL);dup.files.push({...item('w1','work','parent'),isAppAuthorized:true},{...item('w2','work','parent'),isAppAuthorized:true});
  await assert.rejects(dup.scan(mode),/PATH_AMBIGUOUS/);
  const spoof=driveFixture(NORMAL);spoof.files.push({...item('spoof','Clued_资料中心','parent'),isAppAuthorized:true});
  await assert.rejects(spoof.scan(mode),/PATH_AMBIGUOUS|ROOT_CHANGED/);
});
}
test('batched scan covers a level of folders per call and matches the single-item result',async()=>{
  // 3 levels: 12 top-level folders under the scan root, 3 children each, one file per child.
  const build=mode=>{
    const f=fixture({},mode);f.files.splice(2);
    for(let i=0;i<12;i++){
      f.files.push(item('t'+i,'top'+i,'parent'));
      for(let j=0;j<3;j++){f.files.push(item(`c${i}_${j}`,'child'+j,'t'+i));f.files.push(item(`d${i}_${j}`,'note.txt',`c${i}_${j}`,'text/plain'));}
    }
    f.files.push(item('nested','Clued-hidden','c3_1'));
    let calls=0;const get=f.config.get_file,list=f.config.list_folder;
    f.config.get_file=async id=>{calls++;return get(id);};f.config.list_folder=async id=>{calls++;return list(id);};
    if(mode==='batched')Object.assign(f.config,{get_files:async ids=>{calls++;return Promise.all(ids.map(get));},
      list_folders:async ids=>{calls++;return Promise.all(ids.map(list));}});
    return {f,calls:()=>calls};
  };
  const single=build('single'),batched=build('batched');
  const one=await single.f.scan(),many=await batched.f.scan();
  assert.deepEqual(many.map(r=>r.path).sort(),one.map(r=>r.path).sort());
  assert.deepEqual(one.map(r=>r.path),['/drive/top3/child1/Clued-hidden']);
  // Single mode: 2 root reads + 3 per folder (read, list, recheck) for 1+12+36+1 folders.
  assert.equal(single.calls(),2+3*50);
  // Batched mode: root read, then one read and one list per level (4 levels), one recheck, one root recheck.
  assert.equal(batched.calls(),1+2*4+1+1);
});
