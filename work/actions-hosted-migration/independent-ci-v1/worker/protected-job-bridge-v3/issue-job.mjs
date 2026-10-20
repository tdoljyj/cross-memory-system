// Read only fixed complete public issue data to choose one of three literal
// policies. This never authenticates admission or creates a qualified context.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {canonical} from '../../src/proof.mjs';
import {protectedPath} from '../qualification.mjs';
import {fixedPolicyPath} from '../formal-fixed-role-policy-v2/policy.mjs';
import {validateIssue,decode} from './protocol.mjs';
const ROOT='/var/lib/clued-independent-ci/formal-spool/incoming',MAX=1048576;
const fail=c=>{throw Object.assign(new Error(c),{code:c});},check=(v,c)=>{if(!v)fail(c);};
export function jobFromPublicIssueBytes(raw,marker,now=Date.now()){
  check(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=MAX&&Buffer.isBuffer(marker)&&marker.length>0&&marker.length<=4096,'FIXED_PUBLIC_ISSUE_BOUND');
  let r;try{r=JSON.parse(marker.toString('utf8'));}catch{fail('FIXED_PUBLIC_ISSUE_READY_REQUIRED');}
  check(canonical(r)===marker.toString('utf8')&&Object.keys(r).sort().join('|')==='bytes|contract|sha256'&&r.contract==='clued.independent-ci.complete-public-file/1'&&r.bytes===raw.length&&r.sha256===createHash('sha256').update(raw).digest('hex'),'FIXED_PUBLIC_ISSUE_READY_REQUIRED');
  const issue=validateIssue(decode(raw),now);fixedPolicyPath(issue.job.role);return structuredClone(issue.job);
}
async function read(file){await protectedPath(file);const h=await fsp.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const a=await h.stat();check(a.isFile()&&a.nlink===1&&a.size>0&&a.size<=MAX,'FIXED_PUBLIC_ISSUE_BOUND');const b=await h.readFile(),z=await h.stat(),n=await fsp.lstat(file);check([z,n].every(x=>x.dev===a.dev&&x.ino===a.ino&&x.size===a.size&&x.mtimeMs===a.mtimeMs&&x.nlink===1&&!x.isSymbolicLink())&&b.length===a.size,'FIXED_PUBLIC_ISSUE_CHANGED');return b;}finally{await h.close();}}
export async function readFixedIssueJob(){return jobFromPublicIssueBytes(await read(ROOT+'/issue.json'),await read(ROOT+'/issue.ready.json'));}
