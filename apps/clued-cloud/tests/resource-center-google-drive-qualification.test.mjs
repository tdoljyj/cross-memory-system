import assert from "node:assert/strict";
import test from "node:test";
import {createGoogleDriveDirectoryProbe} from "../../../kernel/host/resource-center-google-drive-qualification.mjs";
import {createGoogleDriveMetadataApi} from "../../../kernel/host/resource-center-google-drive-metadata.mjs";
const FOLDER="application/vnd.google-apps.folder",root="/drive/Clued_资料中心";
const item=(id,name,parent)=>({id,name,parents:parent?[parent]:[],mimeType:FOLDER,version:"1",trashed:false,
  isAppAuthorized:true,capabilities:{canAddChildren:true}});
function fixture() {
  const files=[item("parent","drive"),item("root","Clued_资料中心","parent"),item("track","10_E","root"),item("topic","主题","track")];
  const config={trusted_layout:{contract:"clued.storage-directory-layout/1",managed_root:root,root_folder_id:"root",root_parent_id:"parent",
    allowed_root_children:["10_E"],directories:[{path:root,provider_file_id:"root"},{path:root+"/10_E",provider_file_id:"track"},
      {path:root+"/10_E/主题",provider_file_id:"topic"}]},clock:()=>1000,
    get_file:async id=>structuredClone(files.find(f=>f.id===id)),list_folder:async id=>structuredClone(files.filter(f=>f.parents?.includes(id)))};
  return {files,config,run:()=>createGoogleDriveDirectoryProbe(config)()};
}
test("root, track and topic require independent application access; observation is not permission",async()=>{
  const f=fixture(),result=await f.run();
  assert.equal(result.status,"metadata_observed"); assert.equal(result.execution_permitted,false);
  assert.deepEqual(result.directories.map(x=>x.provider_file_id),["root","track","topic"]);
  assert.equal(Object.hasOwn(result,"admission"),false);
});

test("trusted outer My Drive boundary may omit parents but never becomes a writable directory",async()=>{
  const f=fixture();delete f.files[0].parents;
  const result=await f.run();
  assert.equal(result.status,"metadata_observed");assert.equal(result.execution_permitted,false);
  assert.deepEqual(result.directories.map(x=>x.provider_file_id),["root","track","topic"]);
  assert.equal(Object.hasOwn(f.files[0],"parents"),false);
});

test("missing parents is not accepted for any managed directory or enumerated child",async()=>{
  for(const target of ["root","track","topic"]) {
    const f=fixture();delete f.files.find(x=>x.id===target).parents;
    await assert.rejects(f.run(),/IDENTITY_INVALID/);
  }
  const f=fixture(),list=f.config.list_folder;
  f.config.list_folder=async id=>[...await list(id),{...item("unparented","unparented"),parents:undefined}];
  await assert.rejects(f.run(),/IDENTITY_INVALID/);
});

test("outer boundary malformed parents and identity still fail closed",async()=>{
  for(const change of [{parents:null},{parents:undefined},{parents:"root"},{parents:["invalid/id"]},
    {version:"0"},{version:""},{trashed:true},{id:"other"},{mimeType:"application/vnd.google-apps.shortcut"}]) {
    const f=fixture(),get=f.config.get_file;
    f.config.get_file=async id=>id==="parent"?{...await get(id),...change}:get(id);
    await assert.rejects(f.run(),/QUALIFICATION_(IDENTITY_INVALID|PARENT_INVALID)/);
  }
});

test("parentless boundary keeps raw-metadata drift and exact child-parent checks",async()=>{
  const f=fixture();delete f.files[0].parents;const get=f.config.get_file;let reads=0;
  f.config.get_file=async id=>{const file=await get(id);if(id==="parent"&&++reads>1)file.parents=[];return file;};
  await assert.rejects(f.run(),/DIRECTORY_CHANGED/);
  const wrong=fixture();delete wrong.files[0].parents;wrong.files[1].parents=["elsewhere"];
  await assert.rejects(wrong.run(),/DIRECTORY_CHANGED/);
});
for (const target of ["root","track","topic"]) {
  test(`${target} missing own app authorization cannot inherit root access`,async()=>{
    const f=fixture();f.files.find(x=>x.id===target).isAppAuthorized=false;
    await assert.rejects(f.run(),/DIRECTORY_NOT_APP_AUTHORIZED/);
  });
  test(`${target} lacking create-child capability denies`,async()=>{
    const f=fixture();f.files.find(x=>x.id===target).capabilities.canAddChildren=false;
    await assert.rejects(f.run(),/DIRECTORY_NOT_WRITABLE/);
  });
}
for (const mutate of [f=>f.files[3].parents=["root"],f=>f.files[3].name="改名",f=>f.files[3].trashed=true,
  f=>f.files[3].mimeType="application/vnd.google-apps.shortcut",f=>f.files[3].version="0"]) {
  test("identity/type/parent/version drift refuses observation",async()=>{
    const f=fixture();mutate(f);await assert.rejects(f.run(),/QUALIFICATION_/);
  });
}
test("duplicate names, aliases, omitted listings and shortcuts fail closed",async()=>{
  const a=fixture();a.files.push(item("shadow","主题","track"));await assert.rejects(a.run(),/PATH_AMBIGUOUS/);
  const b=fixture();b.config.list_folder=async()=>[];await assert.rejects(b.run(),/DIRECTORY_NOT_LISTED/);
  const c=fixture();c.files.push({...item("link","link","topic"),mimeType:"application/vnd.google-apps.shortcut"});
  await assert.rejects(c.run(),/SHORTCUT_UNQUALIFIED/);
});
test("list-to-GET and final version drift cannot yield success",async()=>{
  const a=fixture(),list=a.config.list_folder;
  a.config.list_folder=async id=>(await list(id)).map(f=>f.id==="topic"?{...f,version:"2"}:f);
  await assert.rejects(a.run(),/DIRECTORY_CHANGED/);
  const b=fixture(),get=b.config.get_file;let n=0;
  b.config.get_file=async id=>{const f=await get(id);if(id==="topic"&&++n>1)f.version="2";return f;};
  await assert.rejects(b.run(),/DIRECTORY_CHANGED/);
});
test("layout input is frozen and rejects external, missing-parent, duplicate, control-folder and injected fields",async()=>{
  const good=fixture(),probe=createGoogleDriveDirectoryProbe(good.config);
  good.config.trusted_layout.directories[1].path="/outside";assert.equal((await probe()).status,"metadata_observed");
  for(const mutate of [d=>d.directories[2].path="/outside",d=>d.directories.splice(1,1),
    d=>d.directories[2].provider_file_id="root",d=>d.allowed_root_children.push("00_从这里开始"),
    d=>d.directories[1].token="injected"]) {
    const f=fixture();mutate(f.config.trusted_layout);assert.throws(()=>createGoogleDriveDirectoryProbe(f.config),/LAYOUT_INVALID/);
  }
});
test("expired or reversed clocks do not produce valid observations",async()=>{
  for (const end of [61001,999,NaN]) {
    const f=fixture();let n=0;f.config.clock=()=>++n===1?1000:end;
    await assert.rejects(f.run(),/OBSERVATION_EXPIRED/);
  }
});
test("metadata authorization fields are opt-in; provider requests remain GET metadata only",async()=>{
  const f=fixture(),urls=[];
  const api=createGoogleDriveMetadataApi({authorization_details:true,get_credential:async()=>({access_token:"synthetic-access-token",
    scope:"https://www.googleapis.com/auth/drive.metadata.readonly"}),fetch:async(url,init)=>{
    urls.push(url);assert.equal(init.method,"GET");assert.equal(init.redirect,"error");const u=new URL(url);
    assert.equal(u.origin,"https://www.googleapis.com");assert.equal(u.searchParams.has("alt"),false);
    assert.match(u.searchParams.get("fields"),/isAppAuthorized,capabilities\(canAddChildren\)/);
    if(u.pathname.endsWith("/files"))return Response.json({files:f.files.filter(x=>x.parents.includes("root")),incompleteSearch:false});
    return Response.json(f.files.find(x=>x.id==="root"));
  }});
  assert.equal((await api.getFile("root")).isAppAuthorized,true);assert.equal((await api.listFolder("root")).length,1);
  assert.equal(urls.length,2);assert.throws(()=>createGoogleDriveMetadataApi({authorization_details:"yes",get_access_token:()=>"token"}),/boolean/);
});
test("first and middle calls crossing the shared deadline stop all subsequent reads",async()=>{
  for (const crossAt of [1,3]) {
    const f=fixture(),get=f.config.get_file;let reads=0,now=1000;
    f.config.clock=()=>now;
    f.config.get_file=async id=>{reads++;const value=await get(id);if(reads===crossAt)now=61000;return value;};
    await assert.rejects(f.run(),/OBSERVATION_EXPIRED/);assert.equal(reads,crossAt);
  }
});
test("shared timeout aborts a pending provider fetch and ends a hung callback",async()=>{
  for(const ignoresSignal of [false,true]) {
    const f=fixture();f.config.timeout_ms=10;let signal;
    f.config.get_file=async(_,options)=>{signal=options.signal;return new Promise((_,reject)=>{
      if(!ignoresSignal)signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
    });};
    await assert.rejects(f.run(),/OBSERVATION_EXPIRED/);assert.equal(signal.aborted,true);
  }
});
test("metadata pagination and delayed credential loading stop dispatch after cancellation",async()=>{
  const controller=new AbortController();let calls=0;
  const api=createGoogleDriveMetadataApi({get_credential:async()=>({access_token:"synthetic-access-token",
    scope:"https://www.googleapis.com/auth/drive.metadata.readonly"}),fetch:async(_,init)=>{
      calls++;controller.abort(new Error("deadline"));assert.equal(init.signal.aborted,true);
      return Response.json({files:[],nextPageToken:"another"});
    }});
  await assert.rejects(api.listFolder("root",{signal:controller.signal}),/deadline/);assert.equal(calls,1);
  const second=new AbortController();const delayed=createGoogleDriveMetadataApi({get_credential:async()=>{
    second.abort(new Error("deadline"));return {access_token:"synthetic-access-token"};
  },fetch:async()=>assert.fail("no fetch after delayed credential expires")});
  await assert.rejects(delayed.getFile("root",{signal:second.signal}),/deadline/);
});
