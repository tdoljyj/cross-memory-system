// PR push binding check. PR prose and commit trailers never establish authority.
//
// node scripts/ci/pr-repush-preflight.mjs --repo owner/name --pr N --head <planned 40-hex SHA>
//     [--claim <diagnostic UUID>] [--scope global|project:<UUID>] [--base <SHA>] [--target <branch>]
// --head is the local head about to be pushed; the remote PR may still name an older head.
// GitHub supplies the actual PR/base/target metadata. Native alone supplies Task,
// scope and current claim; an omitted --scope is unknown, never global.
// Existing CLUED_CONTEXT_READ_TOKEN and public Supabase configuration supply the
// authorized read transport. This script never reads Host credentials or lease keys.
//
// Exit 0: binding check passed, NOT execution admission.
// Exit 1: a confirmed binding/Task/PR conflict needs resolution.
// Exit 2: invalid input or UNCONFIRMED transport/subject; nothing is authorized.
// Exit 3: DISCOVERY_PENDING, NOT execution-ready. Unknown/open lifecycle or a
// missing head grant must not prevent the normal holder-key authorization +
// push/create -> existing qualified CI discovery flow. Local claim guards still
// apply; ordinary Agents cannot activate a relation and need not edit PR prose.
// --claim is diagnostic only. --body-governs is accepted as deprecated, without authority.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePullRequestBinding, cluedRpc } from './clued-work-admission.mjs';
import { collectPRPaths, planPRWriteSet } from './clued-pr-write-set.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SCOPE = /^(global|project:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const USAGE = 'usage: pr-repush-preflight.mjs --repo owner/name --pr N --head <40-hex sha> [--claim <diagnostic uuid>] [--scope global|project:<uuid>] [--base <40-hex sha>] [--target <branch>] [--write-set] [--body-governs]';
const branchValid = v => typeof v === 'string' && BRANCH.test(v) && !v.includes('..') && !v.includes('//') && !v.endsWith('/');

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length;) {
    const key = argv[i];
    if (key === '--write-set') {
      if(out.writeSet) return {error:'--write-set given twice'};
      out.writeSet=true;i++;continue;
    }
    if (key === '--body-governs') {
      if (out.bodyGoverns) return { error: '--body-governs given twice' };
      out.bodyGoverns = true; i++; continue;
    }
    if (!['--repo', '--pr', '--head', '--claim', '--scope', '--base', '--target'].includes(key))
      return { error: 'unknown argument (use --name value)' };
    const name = key.slice(2), value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: key + ' needs a value' };
    if (Object.hasOwn(out, name)) return { error: key + ' given twice' };
    out[name] = value; i += 2;
  }
  for (const key of ['repo', 'pr', 'head']) if (!Object.hasOwn(out, key)) return { error: '--' + key + ' is required' };
  if (!REPO.test(out.repo) || ['.', '..'].includes(out.repo.split('/')[1])) return { error: '--repo must be owner/name' };
  if (!/^[1-9][0-9]{0,9}$/.test(out.pr)) return { error: '--pr must be a pull request number' };
  if (!SHA.test(out.head)) return { error: '--head must be the full 40-hex lower-case SHA' };
  if (out.claim !== undefined && !UUID.test(out.claim)) return { error: '--claim must be a lower-case diagnostic UUID' };
  if (out.scope !== undefined && !SCOPE.test(out.scope)) return { error: '--scope must be global or project:<lower-case uuid>' };
  if (out.base !== undefined && !SHA.test(out.base)) return { error: '--base must be the full 40-hex lower-case SHA' };
  if (out.target !== undefined && !branchValid(out.target)) return { error: '--target must be a valid branch name' };
  return { args: { ...out, repo: out.repo.toLowerCase(), pr: Number(out.pr), bodyGoverns: out.bodyGoverns === true } };
}

class MetadataError extends Error {}
export function readPrMetadata(repo, pr, run = spawnSync) {
  // No shell, interpolation, PR code execution, or raw stderr forwarding.
  const r = run('gh', ['api', 'repos/' + repo + '/pulls/' + pr, '--method', 'GET'],
    { encoding: 'utf8', shell: false, windowsHide: true, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new MetadataError('PR metadata unavailable');
  try { return JSON.parse(r.stdout); } catch { throw new MetadataError('PR metadata invalid'); }
}
export function readPrFilesPage(repo,pr,page,run=spawnSync) {
  if(!REPO.test(repo)||!Number.isSafeInteger(pr)||pr<1||!Number.isSafeInteger(page)||page<1||page>30)
    throw new MetadataError('file subject invalid');
  const r=run('gh',['api',`repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`,'--method','GET'],
    {encoding:'utf8',shell:false,windowsHide:true,timeout:20_000,maxBuffer:4*1024*1024});
  if(r.error||r.status!==0)throw new MetadataError('PR files unavailable');
  try{return JSON.parse(r.stdout);}catch{throw new MetadataError('PR files invalid');}
}
export function createDefaultPorts({ env = process.env, fetchImpl = globalThis.fetch, run = spawnSync } = {}) {
  return {
    env, workspace: env.GITHUB_WORKSPACE || fileURLToPath(new URL('../../', import.meta.url)),
    readPrMetadata: (repo, pr) => readPrMetadata(repo, pr, run),
    readPrFilesPage: (repo,pr,page) => readPrFilesPage(repo,pr,page,run),
    fetchImpl: (url, init) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) }),
  };
}
export const defaultPorts = createDefaultPorts();

// Classification only: the caller has already used the one shared Native
// normalizer through resolvePullRequestBinding. No admission is synthesized.
export function checkRepush({ binding, claim }) {
  const state = binding.binding_status;
  const notes = claim && binding.claim && claim !== binding.claim.claim_id ? ['CLAIM_CHANGED'] : [];
  if (state === 'bound') return { ok: true, exitCode: 0, state: 'BOUND', notes };
  if (state === 'conflict') return { ok: false, exitCode: 1, state: 'BINDING_CONFLICT', notes };
  if (state === 'no_live_claim' && ['task_not_current', 'claim_not_current', 'holder_not_authorized'].includes(binding.reason))
    return { ok: false, exitCode: 1, state: 'CURRENT_CLAIM_REQUIRED', notes };
  return { ok: false, exitCode: 3, state: 'DISCOVERY_PENDING', notes };
}

export async function main(argv = process.argv.slice(2), ports = defaultPorts, out = process.stdout, err = process.stderr) {
  try {
    const parsed = parseArgs(argv);
    if (parsed.error) { err.write(parsed.error + '\n' + USAGE + '\n'); return 2; }
    const { args } = parsed;
    if (args.bodyGoverns) out.write('DEPRECATED: --body-governs has no authority; PR prose is not used.\n');
    const env = ports.env ?? {};
    if (typeof env.CLUED_CONTEXT_READ_TOKEN !== 'string' || !env.CLUED_CONTEXT_READ_TOKEN.trim()
      || typeof ports.fetchImpl !== 'function') {
      err.write('UNCONFIRMED: authorized Native read transport is unavailable; binding was not checked.\n'); return 2;
    }
    let pr;
    try { pr = await ports.readPrMetadata(args.repo, args.pr); }
    catch { err.write('UNCONFIRMED: PR metadata could not be read.\n'); return 2; }
    if (!pr || pr.number !== args.pr || typeof pr.base?.repo?.full_name !== 'string'
      || pr.base.repo.full_name.toLowerCase() !== args.repo || !SHA.test(pr.base?.sha ?? '')
      || !SHA.test(pr.head?.sha ?? '') || !branchValid(pr.base?.ref)) {
      err.write('UNCONFIRMED: PR repository/base/target metadata does not match the requested subject.\n'); return 2;
    }
    if ((args.base !== undefined && args.base !== pr.base.sha) || (args.target !== undefined && args.target !== pr.base.ref)) {
      out.write('BINDING_CONFLICT: PR base or target changed; check the current subject before proceeding.\n'); return 1;
    }
    if (pr.state !== 'open') {
      if (pr.state !== 'closed') { err.write('UNCONFIRMED: PR lifecycle metadata is invalid.\n'); return 2; }
      out.write('BINDING_CONFLICT: the PR is closed; binding checks do not reopen it.\n'); return 1;
    }
    // --head is intentionally the planned local push head, not remote pr.head.sha.
    const subject = { number: pr.number, head: { sha: args.head }, base: { sha: pr.base.sha, ref: pr.base.ref } };
    let binding;
    try {
      binding = await resolvePullRequestBinding(ports.fetchImpl, { ...env, GITHUB_REPOSITORY: args.repo }, subject,
        { workspace: ports.workspace, ...(args.scope === undefined ? {} : { scope: args.scope }), readOnly: true });
    } catch {
      // Transport exceptions and rejected/malformed Native bodies are opaque:
      // neither private tokens nor server/gh stderr enter stdout or stderr.
      err.write('UNCONFIRMED: Native binding could not be verified for the exact subject.\n'); return 2;
    }
    const result = checkRepush({ binding, claim: args.claim });
    let writeSetPlan;
    if(args.writeSet && result.exitCode===0) {
      try {
        // A binding projection is identity only; obtain the ordinary Native
        // read's full live write_set before making a non-mutating union plan.
        const response=await cluedRpc(ports.fetchImpl,env,ports.workspace,'clued_work_verify_v1',
          {scope:binding.scope,claim_id:binding.claim.claim_id});
        const current=response.body?.claim;
        if(response.status!==200||response.body?.status!=='ok'||response.body?.verdict!=='ADMITTED'
          ||current?.status!=='ACTIVE'||current.execution_handover_pending!==false
          ||current.context_key!==binding.scope||current.task_id!==binding.task_id
          ||['claim_id','fence','execution_epoch','lease_version'].some(k=>current[k]!==binding.claim[k]))
          throw new MetadataError('Native generation changed');
        if(typeof ports.readPrFilesPage!=='function')throw new MetadataError('complete files reader unavailable');
        const packet=await collectPRPaths({repository:args.repo,prNumber:args.pr,
          readPR:()=>ports.readPrMetadata(args.repo,args.pr),
          readPage:page=>ports.readPrFilesPage(args.repo,args.pr,page)});
        if(packet.headSha!==pr.head.sha||packet.baseSha!==pr.base.sha||packet.targetBranch!==pr.base.ref)
          throw new MetadataError('PR moved while resolving Native identity');
        writeSetPlan={...planPRWriteSet({claim:current,packet}),planned_head_sha:args.head};
      } catch {
        err.write('UNCONFIRMED: complete PR resources or current Native generation could not be verified.\n');return 2;
      }
    }
    if (result.notes.includes('CLAIM_CHANGED')) out.write('CLAIM_CHANGED: the diagnostic claim differs; Native current claim is ' + binding.claim.claim_id + '. PR prose needs no change.\n');
    if (result.exitCode === 0) {
      out.write('BOUND: 绑定检查通过 — PR #' + args.pr + ', Task ' + binding.task_id + ', claim ' + binding.claim.claim_id
        + ', scope ' + binding.scope + ', planned head ' + args.head + '. This is not execution admission.\n');
      if(writeSetPlan)out.write('WRITE_SET_PLAN: '+JSON.stringify(writeSetPlan)+'\n');
    } else if (result.exitCode === 3) {
      out.write('DISCOVERY_PENDING: 绑定检查待发现或授权；非执行就绪。Use the existing holder-key authorization and normal push/create flow; qualified CI discovers the open PR. Do not activate a relation or edit PR prose to pass this check.\n');
    } else {
      out.write(result.state + ': 绑定检查未通过；resolve the Native Task/current-claim conflict. No execution is authorized.\n');
    }
    return result.exitCode;
  } catch {
    try { err.write('UNCONFIRMED: binding check could not complete.\n'); } catch {}
    return 2;
  }
}

// Node resolves the entry identity through links; an importer basename is not authority.
if (import.meta.main) process.exitCode = await main();
