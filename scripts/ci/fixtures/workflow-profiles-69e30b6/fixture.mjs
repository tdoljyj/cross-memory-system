// Exact historical test fixture only. No live Source qualification or authority.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {parseWorkflowProfiles} from '../../clued-workflow-profile.mjs';
const commit='69e30b6bf1633e4637865b8c7f1ae0ff6cd746b8';
const pins={
  "profiles.disk3.json": {
    "bytes": 625503,
    "sha256": "c05abafd2c744c3c67521175972d2bbb89251aeaaac6b3b7a23af8187dad10e8"
  },
  "role-specs.json": {
    "bytes": 47590,
    "sha256": "7cddf4abf791bf0f1d7feb8fb1462888f3da462033159d59694136aba16e4fa1"
  },
  "workflow-tree.txt": {
    "bytes": 5438,
    "sha256": "8340265f7aaf6c64c0a38a09ef58e09c4214f2ca66fd2c0e4be4d9aac84fe4a8"
  },
  "profile-member-order.json": {
    "bytes": 127691,
    "sha256": "cf6837b9ec91013e8560179abcbda64811272e93d89cfd6e7303f92ace35250f"
  }
};
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=()=>{throw Error('HISTORICAL_WORKFLOW_FIXTURE_69E_INVALID');};
function read(name){const b=fs.readFileSync(new URL('./'+name,import.meta.url)),p=pins[name];
  if(!p||b.length!==p.bytes||hash(b)!==p.sha256)fail();return b.toString('utf8');}
export function loadHistoricalWorkflowProfiles69e(){
  try{
    const semantic=parseWorkflowProfiles(read('profiles.disk3.json')),order=JSON.parse(read('profile-member-order.json'));
    if(!Array.isArray(order)||order.length!==275)fail();
    const keys=new Map(order.map(row=>[JSON.stringify(row.path),row.keys]));
    if(keys.size!==order.length)fail();let visited=0;
    function restore(v,path=[]){
      if(Array.isArray(v))return v.map((x,i)=>restore(x,[...path,i]));
      if(v&&typeof v==='object'){
        const names=keys.get(JSON.stringify(path));
        if(!Array.isArray(names)||names.length!==Object.keys(v).length||new Set(names).size!==names.length||
          names.some(k=>!Object.hasOwn(v,k)))fail();visited++;
        return Object.fromEntries(names.map(k=>[k,restore(v[k],[...path,k])]));
      }return v;
    }
    const profilesRaw=JSON.stringify(restore(semantic),null,2)+'\n',rolesRaw=read('role-specs.json');
    if(visited!==275||Buffer.byteLength(profilesRaw)!==607891||
      hash(profilesRaw)!=='cdaf731653781ae1abc74bf944bdaab45bfb1bdedb4dda94f19b25f2eaca7210'||
      hash(rolesRaw)!=='7cddf4abf791bf0f1d7feb8fb1462888f3da462033159d59694136aba16e4fa1')fail();
    const workflowDirectory=read('workflow-tree.txt').trim().split('\n').map(line=>{
      const m=/^(100644) (blob) ([a-f0-9]{40})\t(\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)$/.exec(line);
      if(!m)fail();return {mode:m[1],type:m[2],sha:m[3],path:m[4]};
    });
    if(new Set(workflowDirectory.map(r=>r.path)).size!==workflowDirectory.length)fail();
    return {commit,profilesRaw,rolesRaw,workflowDirectory};
  }catch{fail();}
}
