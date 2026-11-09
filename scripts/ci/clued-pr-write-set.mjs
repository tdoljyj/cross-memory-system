// Read-only facts and holder renewal plans. A plan is never a claim, CI grant,
// execution verdict or permission to write. Native still owns every mutation.
export class PRWriteSetError extends Error {
  constructor(code) { super(code); this.name='PRWriteSetError'; this.code=code; }
}
const need=(ok,code)=>{if(!ok)throw new PRWriteSetError(code);};
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const pathOK=s=>typeof s==='string'&&s.length>0&&s.length<=4096&&!/[\x00-\x1f\x7f\\]/.test(s)
  &&!s.startsWith('/')&&!s.split('/').some(p=>!p||p==='.'||p==='..');
const statuses=new Set(['added','removed','modified','renamed','copied','changed','unchanged']);
function snapshot(pr,repository,number,subjectCheck) {
  need(pr?.number===number&&pr.state==='open'&&sha(pr.head?.sha)&&sha(pr.base?.sha)
    &&typeof pr.base?.repo?.full_name==='string'&&pr.base.repo.full_name.toLowerCase()===repository
    &&typeof pr.base?.ref==='string'&&pr.base.ref
    &&Number.isSafeInteger(pr.changed_files)&&pr.changed_files>=0&&pr.changed_files<=3000
    &&(!subjectCheck||subjectCheck(pr)===true),'pr_subject_changed');
  return {repository,prNumber:number,headSha:pr.head.sha,baseSha:pr.base.sha,targetBranch:pr.base.ref,fileCount:pr.changed_files};
}
function filePaths(files) {
  const names=new Set(),paths=new Set();
  for(const file of files){
    need(pathOK(file?.filename)&&!names.has(file.filename)&&statuses.has(file.status)
      &&(file.status!=='renamed'||pathOK(file.previous_filename)),'invalid_pr_files');
    names.add(file.filename);paths.add(file.filename);
    if(file.status==='renamed')paths.add(file.previous_filename);
  }
  return [...paths].sort();
}

export async function collectPRPaths({repository,prNumber,readPR,readPage,maxPages=30,subjectCheck}={}) {
  need(typeof repository==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    &&!repository.split('/').some(p=>p==='.'||p==='..')&&Number.isSafeInteger(prNumber)&&prNumber>0
    &&typeof readPR==='function'&&typeof readPage==='function'
    &&Number.isSafeInteger(maxPages)&&maxPages>0&&maxPages<=30,'invalid_pr_subject');
  repository=repository.toLowerCase();
  const before=snapshot(await readPR(),repository,prNumber,subjectCheck),files=[];
  let complete=false;
  for(let page=1;page<=maxPages;page++){
    const rows=await readPage(page);
    need(Array.isArray(rows)&&rows.length<=100,'invalid_pr_files');
    files.push(...rows);filePaths(files);
    need(files.length<=before.fileCount,'pr_files_changed');
    if(files.length===before.fileCount){complete=true;break;}
    need(rows.length===100,'incomplete_pr_files');
  }
  need(complete,'pr_files_page_limit');
  const after=snapshot(await readPR(),repository,prNumber,subjectCheck);
  need(JSON.stringify(after)===JSON.stringify(before),'pr_subject_changed');
  return Object.freeze({...before,complete:true,paths:Object.freeze(filePaths(files)),
    files:Object.freeze(files.map(f=>Object.freeze({...f})))});
}

function covers(pattern,target){
  const tail=pattern.endsWith('/**');
  if(tail)pattern=pattern.slice(0,-3);
  let re='^';
  for(let i=0;i<pattern.length;i++){
    const c=pattern[i];
    if(c==='*'){if(pattern[i+1]==='*'){re+='.*';i++;}else re+='[^/]*';}
    else re+=c.replace(/[|\\{}()[\]^$+?.]/g,'\\$&');
  }
  return new RegExp(re+(tail?'(?:/.*)?':'')+'$').test(target);
}

export function planPRWriteSet({claim,packet,plannedTargets=[]}={}) {
  need(packet?.complete===true&&Array.isArray(packet.files)&&packet.fileCount===packet.files.length
    &&Array.isArray(packet.paths)&&JSON.stringify(filePaths(packet.files))===JSON.stringify(packet.paths),'pr_packet_unconfirmed');
  need(Array.isArray(claim?.write_set)&&claim.write_set.length>0
    &&claim.write_set.every(s=>typeof s==='string'&&s),'claim_write_set_invalid');
  need(Array.isArray(plannedTargets),'edit_targets_invalid');
  const current=new Set(claim.write_set),all=[...packet.paths,...plannedTargets];
  for(const target of all){
    need(pathOK(target),'edit_target_invalid');
    if([...current].some(p=>covers(p,target)))continue;
    need(target.length<=400&&!/[\s*?\[\]]/.test(target),'write_set_path_not_representable');
    current.add(target);
  }
  need(current.size<=200,'write_set_capacity_exceeded');
  return Object.freeze({read_only:true,repository:packet.repository,pr_number:packet.prNumber,
    head_sha:packet.headSha,base_sha:packet.baseSha,target_branch:packet.targetBranch,
    claim_id:claim.claim_id,task_id:claim.task_id,scope:claim.context_key,
    fence:claim.fence,execution_epoch:claim.execution_epoch,lease_version:claim.lease_version,
    changed_paths:[...packet.paths],write_set:[...current].sort(),requires_renewal:current.size!==new Set(claim.write_set).size});
}
