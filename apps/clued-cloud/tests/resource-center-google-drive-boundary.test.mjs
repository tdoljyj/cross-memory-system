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
test(mode+': duplicate names and a forged or moved root fail closed',async()=>{
  const duplicate=fixture({},mode);duplicate.files.push(item('spoof','Clued_资料中心','parent'));await assert.rejects(duplicate.scan(),/PATH_AMBIGUOUS|ROOT_CHANGED/);
  const alias=fixture({},mode);alias.files[1].parents=['other'];await assert.rejects(alias.scan(),/ROOT_CHANGED/);
});
// Decision 24422a98 (job 3f6c2a1e, DRIVE_BOUNDARY_DEPTH_LIMIT): unrelated deep
// or large content outside the managed root no longer fails every write.
test(mode+': an unrelated folder nested deeper than the limit is observed, not descended, and does not fail the scan',async()=>{
  // The production case: CI-transfer/z1-desk/package/source/... nine levels deep.
  const f=fixture({},mode);f.files.splice(2);
  f.files.push(item('d0','CI-transfer','parent'));
  for(let i=1;i<=10;i++)f.files.push(item('d'+i,'level'+i,'d'+(i-1)));
  f.files.push(item('deepfile','setup.exe','d10','application/octet-stream'));
  const result=await f.scan();
  assert.deepEqual(result,[]);
  assert.deepEqual(result.partial.map(p=>[p.path.split('/').length,p.reason]),[[11,'depth']]);
  assert.equal(Object.keys(result).includes('partial'),false);
  // A Clued-named island at the truncation point is still observed by its own name.
  const named=fixture({},mode);named.files.splice(2);named.files.push(item('d0','CI-transfer','parent'));
  for(let i=1;i<=7;i++)named.files.push(item('d'+i,'level'+i,'d'+(i-1)));
  named.files.push(item('island','Clued-hidden','d7'));named.files.push(item('below','x','island'));
  const found=await named.scan();
  assert.deepEqual(found.map(r=>r.path),['/drive/CI-transfer/level1/level2/level3/level4/level5/level6/level7/Clued-hidden']);
  assert.deepEqual(found.partial.map(p=>p.reason),['depth']);
  // The depth limit stays a cost bound: the folder below it is never listed.
  const listed=[];const original=named.config.list_folder;named.config.list_folder=async id=>{listed.push(id);return original(id);};
  await named.scan();assert.equal(listed.includes('island'),false);
});
test(mode+': past the entry limit folders are observed but not descended; the parent namespace is always scanned first',async()=>{
  const f=fixture({boundary_scan_max_entries:3},mode);f.files.splice(2);
  f.files.push(item('big','big','parent'));
  for(let i=0;i<5;i++)f.files.push(item('n'+i,'n'+i,'big'));
  f.files.push(item('deep','Clued-deep','n4'));
  f.files.push(item('drop','Clued_说明.md','parent','text/plain'));
  const result=await f.scan();
  // The sibling drop beside the root is found; the over-limit folders are reported as partial.
  assert.deepEqual(result.map(r=>r.path),['/drive/Clued_说明.md']);
  assert.ok(result.partial.length>0 && result.partial.every(p=>p.reason==='entries'));
});
test(mode+': a shortcut outside the root is an observed entry and is never followed',async()=>{
  const f=fixture({},mode);f.files.splice(2);
  f.files.push(item('link','link','parent','application/vnd.google-apps.shortcut'));
  const listed=[];const original=f.config.list_folder;f.config.list_folder=async id=>{listed.push(id);return original(id);};
  assert.deepEqual(await f.scan(),[]);assert.equal(listed.includes('link'),false);
  // A Clued-named shortcut created by Clued outside the root is still an island.
  const island=fixture({},mode);island.files.splice(2);
  island.files.push(item('link','Clued_快捷方式','parent','application/vnd.google-apps.shortcut'));
  assert.deepEqual((await island.scan()).map(r=>r.path),['/drive/Clued_快捷方式']);
});
test(mode+': folder identity drift and unqualified external allowlists cannot yield a clean scan',async()=>{
  const f=fixture({},mode);let reads=0;
  const original=f.config.get_file;f.config.get_file=async id=>{const value=await original(id);if(id==='parent'&&++reads>1)value.name='renamed';return value;};
  await assert.rejects(f.scan(),/BOUNDARY_CHANGED/);
  // A version that moves during the scan (anything changed inside) is not a boundary change.
  const busy=fixture({},mode);busy.files.splice(2);let n=0;const get=busy.config.get_file;
  busy.config.get_file=async id=>{const value=await get(id);value.version=String(++n);return value;};
  assert.deepEqual(await busy.scan(),[]);
  assert.throws(()=>createGoogleDriveBoundaryScanner(fixture({registered_external_roots:['/drive/work']},mode).config),/PROFILE_UNQUALIFIED/);
});
test(mode+': another registered root of the same owner (Decision b18eff80) is skipped only by its exact ID beside the managed root',async()=>{
  // An N0-onboarded root next to Clued_资料中心, with its tracks and a Clued-named file inside.
  const build=sibling=>{
    const f=fixture({},mode);f.files.splice(2);
    f.files.push(item('n0','Clued_N0验收_新建','parent'),item('n0track','资料','n0'),item('n0file','Clued_笔记.md','n0track','text/plain'));
    if(sibling!==undefined)f.config.registered_sibling_roots=sibling;
    return f;
  };
  const before=await build().scan();
  assert.deepEqual(before.map(r=>r.path).sort(),['/drive/Clued_N0验收_新建','/drive/Clued_N0验收_新建/资料','/drive/Clued_N0验收_新建/资料/Clued_笔记.md']);
  assert.deepEqual(await build(['n0']).scan(),[]);
  // A sibling root does not hide other islands beside it.
  const other=build(['n0']);other.files.push(item('drop','Clued_说明.md','parent','text/plain'));
  assert.deepEqual((await other.scan()).map(r=>r.path),['/drive/Clued_说明.md']);
  // Same name, different ID: still an island.
  const spoof=fixture({},mode);spoof.files.splice(2);spoof.files.push(item('spoof','Clued_N0验收_新建','parent'));
  spoof.config.registered_sibling_roots=['n0'];
  assert.deepEqual((await spoof.scan()).map(r=>r.path),['/drive/Clued_N0验收_新建']);
  // The ID counts only directly in the managed root's parent, and only as a folder.
  const nested=fixture({},mode);nested.files.splice(3);nested.files.push(item('n0','Clued-moved','ordinary'));
  nested.config.registered_sibling_roots=['n0'];
  assert.deepEqual((await nested.scan()).map(r=>r.path),['/drive/work/Clued-moved']);
  const asFile=fixture({},mode);asFile.files.splice(2);asFile.files.push(item('n0','Clued_N0.md','parent','text/plain'));
  asFile.config.registered_sibling_roots=['n0'];
  assert.deepEqual((await asFile.scan()).map(r=>r.path),['/drive/Clued_N0.md']);
});
test(mode+': malformed registered_sibling_roots fail closed before any read',async()=>{
  for(const bad of [null,'n0',[''],['n0','n0'],['bad/id'],['root'],['parent'],[1],Array.from({length:65},(_,i)=>'s'+i)]){
    const f=fixture({},mode);f.config.registered_sibling_roots=bad;
    f.config.get_file=async()=>assert.fail('no read');f.config.list_folder=async()=>assert.fail('no read');
    assert.throws(()=>createGoogleDriveBoundaryScanner(f.config),/PROFILE_UNQUALIFIED/);
  }
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
    return Response.json(calls===1?{files:[],nextPageToken:'two',incompleteSearch:false}:{files:[item('a','a','parent'),item('b','b','parent')],incompleteSearch:false});
  });
  assert.equal((await api.listFolder('parent')).length,2);assert.equal(calls,2);
  await assert.rejects(build(async()=>Response.json({files:[],incompleteSearch:true})).listFolder('parent'),/LIST_INVALID/);
  await assert.rejects(build(async()=>Response.json({files:[],nextPageToken:'again'})).listFolder('parent'),/PAGINATION_INVALID/);
  const narrow=createGoogleDriveMetadataApi({get_credential:async()=>({access_token:'synthetic-test-token',scope:'https://www.googleapis.com/auth/drive.file'}),fetch:async()=>{assert.fail('no request');}});
  await assert.rejects(narrow.listFolder('parent'),/NAMESPACE_VISIBILITY_UNPROVEN/);
});
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

// StorageNormalUse.v0.1 §3.1 / Clued Decision fd94bd2f: both credential profiles list
// the whole Drive's metadata. The island rule counts only Clued-named entries the
// Clued app created or opened (isAppAuthorized === true); a missing field still
// counts. Every structural check applies to every listed entry, whoever owns it.
const ownerFixture=(mode,{noFlag=false,overrides={}}={})=>{
  const f=fixture(overrides,mode);f.files.splice(2);
  const owner=new Set();
  const add=(entry,at)=>{owner.add(entry.id);if(at===undefined)f.files.push(entry);else f.files.splice(at,0,entry);return entry;};
  // Listings carry isAppAuthorized; the direct read (get_file) does not, as with
  // the unbatched metadata API. Owner entries are false, Clued's own true.
  f.config.list_folder=async id=>structuredClone(f.files.filter(x=>x.parents.includes(id)))
    .map(x=>noFlag?x:{...x,isAppAuthorized:!owner.has(x.id)});
  return {f,add};
};
for(const mode of ['single','batched']){
test(mode+': Owner Clued-named doc and folder outside the root (isAppAuthorized false) scan clean',async()=>{
  const {f,add}=ownerFixture(mode);
  add(item('o-doc','Clued_单一数据源方案','parent','application/vnd.google-apps.document'));
  add(item('o-folder','Clued 旧资料','parent'));add(item('o-inner','notes.txt','o-folder','text/plain'));
  assert.deepEqual(await f.scan(),[]);
});
test(mode+': an app-authorized Clued-named stray outside the root is still flagged',async()=>{
  const {f,add}=ownerFixture(mode);add(item('o-doc','Clued_单一数据源方案','parent','application/vnd.google-apps.document'));
  f.files.push(item('stray','Clued_说明.md','parent','text/plain'));
  assert.deepEqual((await f.scan()).map(r=>[r.code,r.path]),[['UNAUTHORIZED_WORKSPACE_MUTATION','/drive/Clued_说明.md']]);
});
test(mode+': a listing without isAppAuthorized is treated as app-authorized (fail closed)',async()=>{
  const {f,add}=ownerFixture(mode,{noFlag:true});
  add(item('o-doc','Clued_单一数据源方案','parent','application/vnd.google-apps.document'));
  assert.deepEqual((await f.scan()).map(r=>r.path),['/drive/Clued_单一数据源方案']);
});
test(mode+': Owner entries keep every structural failure',async()=>{
  const cases=[
    [/PATH_AMBIGUOUS/,add=>{add(item('o-a','same','parent','text/plain'));add(item('o-b','same','parent','text/plain'));}],
    [/PATH_AMBIGUOUS/,add=>add(item('o-spoof','Clued_资料中心','parent'))],
    [/ROOT_CHANGED/,add=>add(item('o-spoof','Clued_资料中心','parent'),1)],
  ];
  for(const [expected,arrange,overrides] of cases){
    const {f,add}=ownerFixture(mode,{overrides});arrange(add);
    await assert.rejects(f.scan(),expected,String(expected));
  }
});
test(mode+': identity comparisons ignore only the listed isAppAuthorized field and the Drive version',async()=>{
  const {f,add}=ownerFixture(mode);add(item('o-folder','work','parent'));add(item('o-inner','a.txt','o-folder','text/plain'));
  assert.deepEqual(await f.scan(),[]);
  const get=f.config.get_file;f.config.get_file=async id=>{const v=await get(id);if(id==='o-folder')v.version='2';return v;};
  assert.deepEqual(await f.scan(),[]);
  f.config.get_file=async id=>{const v=await get(id);if(id==='o-folder')v.parents=['elsewhere'];return v;};
  await assert.rejects(f.scan(),/BOUNDARY_CHANGED/);
});
}
test('the scanner listing requests isAppAuthorized and returns every entry unfiltered',async()=>{
  const scope='https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.metadata.readonly';
  const seen=[];
  const api=createGoogleDriveMetadataApi({get_credential:async()=>({access_token:'synthetic-test-token',scope}),fetch:async url=>{
    const u=new URL(url);seen.push(u.searchParams.get('fields'));
    const listed=[{...item('mine','mine','parent'),isAppAuthorized:true},{...item('owner','Clued_x','parent'),isAppAuthorized:false}];
    return Response.json({files:/isAppAuthorized/.test(u.searchParams.get('fields'))?listed:listed.map(({isAppAuthorized:_,...x})=>x),incompleteSearch:false});
  }});
  assert.deepEqual((await api.listFolder('parent',{app_authorized:true})).map(x=>[x.id,x.isAppAuthorized]),[['mine',true],['owner',false]]);
  assert.match(seen[0],/files\([^)]*isAppAuthorized/);
  assert.equal((await api.listFolder('parent')).length,2);assert.doesNotMatch(seen[1],/isAppAuthorized/);
  assert.throws(()=>api.listFolder('parent',{app_authorized:'yes'}),/app_authorized must be boolean/);
});
