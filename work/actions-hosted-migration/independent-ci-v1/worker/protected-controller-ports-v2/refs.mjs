// Source v2 copy of protected-controller-ports-v1/refs.mjs: job contract v2 and the v4 snapshot validator.
// Read-only complete refs observation. No git fetch, token export, mutating
// GraphQL, partial-page success or caller-supplied repository/query.
import {canonical,digest} from '../../src/proof.mjs';
import {validateJobV2 as validateJob,prBaseAcceptedV2} from '../../src/job-v2.mjs';
import {validateRemoteSnapshot} from '../formal-gitleaks-v4/required-history/prepare.mjs';
const REPO='tdoljyj/cross-memory-system',SHA=/^[a-f0-9]{40}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const check=(v,c)=>{if(!v)fail(c);};
export const REFS_QUERY='query CluedCompleteRefs($prefix:String!,$after:String){repository(owner:"tdoljyj",name:"cross-memory-system"){databaseId nameWithOwner refs(refPrefix:$prefix,first:100,after:$after){totalCount edges{cursor node{name prefix target{oid __typename}}} pageInfo{hasNextPage endCursor}}}}';
// base.sha: the batch base for a batch that tests the head; a train front batch (S != H) records GitHub's (job-v2.mjs).
const samePr=(p,j)=>p?.number===j.pr&&p.state==='open'&&p.head?.sha===j.headSha&&prBaseAcceptedV2(j,p.base?.sha)&&p.base?.ref==='main'&&p.head.repo?.full_name===REPO&&p.base.repo?.full_name===REPO;
async function boundedJson(response){
  check(response?.ok===true&&response.body?.getReader,'REFS_HTTP_UNCONFIRMED');
  const reader=response.body.getReader(),parts=[];let bytes=0;
  try{for(;;){const v=await reader.read();if(v.done)break;bytes+=v.value.length;check(bytes<=2097152,'REFS_PAGE_BYTES_BOUND');parts.push(Buffer.from(v.value));}}
  finally{reader.releaseLock();}
  const raw=Buffer.concat(parts),text=raw.toString('utf8');check(Buffer.from(text).equals(raw),'REFS_UTF8_REQUIRED');
  try{return JSON.parse(text);}catch{fail('REFS_JSON_REQUIRED');}
}
// This codec is also used by offline tests. Its JSON is not a protected port,
// a Native admission, a signed result or a Host qualification.
export async function collectCompleteRemoteRefs({job,token,readPullRequest,fetchImpl,clock=Date.now,signal}={}){
  validateJob(job);check(job.repo===REPO&&typeof token==='string'&&token&&typeof readPullRequest==='function'&&typeof fetchImpl==='function','REFS_PROTECTED_TRANSPORT_REQUIRED');
  const started=clock();check(Number.isSafeInteger(started),'REFS_CLOCK_UNKNOWN');
  const guard=()=>{check(!signal?.aborted&&Number.isSafeInteger(clock())&&clock()>=started&&clock()-started<=30000,'REFS_WINDOW_EXPIRED');};
  guard();check(samePr(await readPullRequest(job.pr),job),'REFS_PR_SUBJECT_CHANGED');
  async function pass(){
    const all=[];
    for(const prefix of ['refs/heads/','refs/tags/']){
      let after=null,total=null;const cursors=new Set(),names=new Set();let complete=false;
      for(let page=0;page<100;page++){
        guard();const remaining=Math.max(1,30000-(clock()-started));
        const timeout=AbortSignal.timeout(Math.min(10000,remaining));
        const response=await fetchImpl('https://api.github.com/graphql',{method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout,
          headers:{accept:'application/vnd.github+json',authorization:`Bearer ${token}`,'content-type':'application/json','x-github-api-version':'2022-11-28','user-agent':'clued-independent-ci'},body:JSON.stringify({query:REFS_QUERY,variables:{prefix,after}})});
        const body=await boundedJson(response);guard();
        check(body&&(!Object.hasOwn(body,'errors')||Array.isArray(body.errors)&&body.errors.length===0),'REFS_GRAPHQL_ERRORS');
        const repo=body.data?.repository,c=repo?.refs;
        check(repo?.databaseId===1334673495&&repo.nameWithOwner===REPO&&Number.isSafeInteger(c?.totalCount)&&c.totalCount>=0&&c.totalCount<=10000&&
          Array.isArray(c.edges)&&c.edges.length<=100&&typeof c.pageInfo?.hasNextPage==='boolean','REFS_PAGE_SHAPE_UNKNOWN');
        if(total===null)total=c.totalCount;check(total===c.totalCount,'REFS_TOTAL_CHANGED');
        for(const edge of c.edges){const n=edge?.node;
          check(typeof edge?.cursor==='string'&&edge.cursor.length>0&&edge.cursor.length<=4096&&!cursors.has(edge.cursor)&&typeof n?.name==='string'&&n.prefix===prefix&&
            SHA.test(n.target?.oid??'')&&['Commit','Tag'].includes(n.target?.__typename)&&!(prefix==='refs/heads/'&&n.target.__typename!=='Commit'),'REFS_EDGE_UNKNOWN');
          const name=prefix+n.name;check(!names.has(name),'REFS_DUPLICATE');names.add(name);cursors.add(edge.cursor);all.push({name,objectSha:n.target.oid});check(all.length<=10000,'REFS_TOTAL_BOUND');}
        check(names.size<=total,'REFS_TOTAL_CHANGED');
        if(!c.pageInfo.hasNextPage){check(names.size===total,'REFS_INCOMPLETE');complete=true;break;}
        check(c.edges.length>0&&names.size<total&&typeof c.pageInfo.endCursor==='string'&&c.pageInfo.endCursor===c.edges.at(-1).cursor&&c.pageInfo.endCursor!==after,'REFS_CURSOR_UNKNOWN');
        after=c.pageInfo.endCursor;
      }
      check(complete,'REFS_PAGE_LIMIT');
    }
    return all.sort((a,b)=>a.name.localeCompare(b.name));
  }
  const first=await pass(),second=await pass();guard();
  check(canonical(first)===canonical(second),'REFS_SNAPSHOT_CHANGED');
  check(samePr(await readPullRequest(job.pr),job),'REFS_PR_SUBJECT_CHANGED');guard();
  check(second.find(r=>r.name==='refs/heads/main')?.objectSha===job.baseSha,'REFS_MAIN_BASE_CHANGED');
  const facts={contract:'clued.independent-ci.remote-heads-tags/1',repository:REPO,complete:true,observedAt:new Date(clock()).toISOString(),refs:second};
  validateRemoteSnapshot(facts,job,clock());
  return Object.freeze({...facts,refs:Object.freeze(second.map(v=>Object.freeze(v))),observationSha256:digest(facts)});
}
