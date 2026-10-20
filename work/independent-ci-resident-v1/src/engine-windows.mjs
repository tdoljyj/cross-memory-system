// Windows engine for the resident executor: derive one batch from the installed Source v2 and run
// its eight fixed stages through the Source v2 stage invoker (resident-v2/invoke-stage.mjs: sealed stage
// directory, swap-broker request, generic helper, native receipt + entry outcome -> one stage fact).
//
// The pure parsers below are unit-tested. Every v2 entry point is checked first and its absence fails
// closed with SOURCE_V2_REQUIRED. Contracts used (DESIGN §7):
//   derive-batch.mjs --subject-json --batch-key --batch-id --out  -> RESIDENT_BATCH_DERIVED (S4)
//   invoke-stage.mjs --batch-dir --stage --work-manifest-sha256 --batch-key -> stage fact /2 (S1, S11, S12)
//   archive-windows-spool.ps1 -BatchKey -Reason -> {verified, directory, moved, code} (S14)
//   companion check-refs before stage 2 (S9, lesson b29) and the v4 bridge pump for stages 2, 4, 6 (S7)
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CODE, HEX64, check, fail, parseBoundedJson } from './canonical.mjs';
import { writeNew, ensureDir } from './store.mjs';

export const RUNNER_SERVICE = 'actions.runner.tdoljyj-cross-memory-system.clued-ci-home-win-02';
export const ORIGINAL_BINARY = '"C:\\ProgramData\\CluedControl\\runner\\bin\\RunnerService.exe"';
export const DESCRIPTOR_CONTRACT = 'clued.independent-ci.resident-batch-descriptor/2';
const V2 = ['work', 'actions-hosted-migration', 'independent-ci-v1', 'src', 'resident-v2'];

// The terminal fact the Source v2 stage invoker prints (stage-fact.mjs#buildStageFact keeps the v1 field
// names that run-batch.ps1:92 checked; contract /2 adds the bound entry outcome).
export const STAGE_FACT_CONTRACT = 'clued.independent-ci.resident-stage-fact/2';
export function parseStageFact(text, expectedManifestSha256) {
  const f = parseBoundedJson(Buffer.from(text, 'utf8'), 1024 * 1024, 'STAGE_FACT_REFUSED');
  if (f.contract !== undefined && f.contract !== STAGE_FACT_CONTRACT) return { ok: false, code: 'STAGE_TERMINAL_UNCONFIRMED', proof: { windowsTreeZero: false, serviceOriginalStopped: false }, nativeReceiptSha256: null };
  const restored = f.original_binary_restored === true && f.complete_original_readback === true;
  const treeZero = f.tree_cleanup_confirmed === true && f.tree_active_processes === 0 && f.root_exit_confirmed === true;
  const ok = f.state === 'FORMAL_CHILD_COMPLETED_ORIGINAL_STOPPED_NO_QUALIFICATION' && restored && treeZero
    && f.manifest_sha256 === expectedManifestSha256 && f.scm_start_call_issued === true && f.configuration_conflict_detected === false;
  const code = ok ? null : (typeof f.failure_code === 'string' && CODE.test(f.failure_code) ? f.failure_code : (typeof f.state === 'string' && CODE.test(f.state) ? f.state : 'STAGE_TERMINAL_UNCONFIRMED'));
  return { ok, code, proof: { windowsTreeZero: treeZero, serviceOriginalStopped: restored }, nativeReceiptSha256: HEX64.test(f.native_receipt_sha256 ?? '') ? f.native_receipt_sha256 : null };
}

// Independent SCM readback (sc.exe qc / queryex), so "original and stopped" never rests on the
// stage's own report alone. The account must still be .\clued-control (the broker never changes it).
export function parseScQc(text) {
  const bin = /BINARY_PATH_NAME\s*:\s*(.+)\r?$/m.exec(text)?.[1]?.trim() ?? null;
  const start = /START_TYPE\s*:\s*(\d+)/.exec(text)?.[1] ?? null;
  const account = /SERVICE_START_NAME\s*:\s*(.+)\r?$/m.exec(text)?.[1]?.trim() ?? null;
  return { binary: bin, startType: start === null ? null : Number(start), account };
}
export function parseScQueryex(text) {
  const state = /STATE\s*:\s*(\d+)/.exec(text)?.[1] ?? null;
  const pid = /PID\s*:\s*(\d+)/.exec(text)?.[1] ?? null;
  return { state: state === null ? null : Number(state), pid: pid === null ? null : Number(pid) };
}
export const originalStopped = (qc, q) => qc.binary === ORIGINAL_BINARY && qc.startType === 3 && /^(\.|TURING)\\clued-control$/i.test(qc.account ?? '') && q.state === 1 && q.pid === 0;

export class WindowsEngine {
  // ports: { run (Runner.run), busy() (Runner.busy), companionMailbox, sleep, clock,
  //          paths: { sourceRoot, workRoot, outboxRoot, nodeExe, powershellExe, scExe } }
  constructor(ports) { Object.assign(this, ports); }

  v2(name) { return path.join(this.paths.sourceRoot, ...V2, name); }
  async requireV2(name) { const p = this.v2(name); try { await fs.access(p); } catch { fail('SOURCE_V2_REQUIRED'); } return p; }

  async scReadback() {
    const qc = parseScQc((await this.run([this.paths.scExe, 'qc', RUNNER_SERVICE], { timeoutMs: 15_000 })).stdout);
    const q = parseScQueryex((await this.run([this.paths.scExe, 'queryex', RUNNER_SERVICE], { timeoutMs: 15_000 })).stdout);
    return originalStopped(qc, q);
  }

  async derive(subject, key) {
    const entry = await this.requireV2('derive-batch.mjs');
    const batchId = `${key.slice(0, 16)}-${randomBytes(6).toString('hex')}`;
    const out = path.join(this.paths.workRoot, batchId);
    // The jobs' createdAt (job contract v2) is the derivation time; it is not part of any id or key.
    const v2 = { repo: subject.repo, pr: subject.pr, headSha: subject.headSha, baseSha: subject.baseSha, sourceManifestSha256: subject.sourceManifestSha256,
      attempt: subject.attempt, createdAt: new Date(this.clock()).toISOString() };
    const r = await this.run([this.paths.nodeExe, entry, '--subject-json', JSON.stringify(v2), '--batch-key', key, '--batch-id', batchId, '--out', out], { timeoutMs: 10 * 60_000 });
    check(r.code === 0, 'RESIDENT_DERIVATION_REFUSED');
    const v = parseBoundedJson(Buffer.from(r.stdout, 'utf8'), 1024 * 1024, 'RESIDENT_DERIVATION_REFUSED');
    check(v.status === 'RESIDENT_BATCH_DERIVED' && v.batchKey === key && v.batchId === batchId && HEX64.test(v.packageSha256) && HEX64.test(v.ciSourceManifestSha256 ?? '')
      && /^[0-9a-f]{40}$/.test(v.sourceCommit ?? '') && HEX64.test(v.gitleaksTomlSha256 ?? '') && Array.isArray(v.stages) && v.stages.length === 8, 'RESIDENT_DERIVATION_REFUSED');
    const linuxJobIds = v.stages.filter(s => [2, 4, 6].includes(s.number)).map(s => s.jobId);
    check(linuxJobIds.length === 3 && linuxJobIds.every(j => HEX64.test(j)), 'RESIDENT_DERIVATION_REFUSED');
    // Public descriptor (/2) for the companion's bundle and ws-prep, and (through /mnt/c, read-only) the
    // Linux units: everything they re-derive job ids from, nothing they could execute.
    const dir = path.join(this.paths.outboxRoot, batchId);
    await ensureDir(dir);
    await writeNew(path.join(dir, 'descriptor.json'), { contract: DESCRIPTOR_CONTRACT, batchId, batchKey: key, repo: subject.repo, pr: subject.pr,
      headSha: subject.headSha, baseSha: subject.baseSha, attempt: subject.attempt, ciSourceManifestSha256: v.ciSourceManifestSha256, sourceCommit: v.sourceCommit,
      gitleaksTomlSha256: v.gitleaksTomlSha256, linuxJobIds, createdAt: v2.createdAt });
    return { batchId, key, dir: out, packageSha256: v.packageSha256, stages: v.stages, ciSourceManifestSha256: v.ciSourceManifestSha256 };
  }

  // Windows half of a protocol archive through the Source v2 handle-based tool (never Node path
  // renames on the Owner-writable spool, see archive.mjs header).
  async archiveWindows(batch, reason) {
    const tool = await this.requireV2('archive-windows-spool.ps1');
    const r = await this.run([this.paths.powershellExe, '-NoProfile', '-NonInteractive', '-File', tool, '-BatchKey', batch.key, '-Reason', reason], { timeoutMs: 120_000 });
    const v = r.code === 0 ? parseBoundedJson(Buffer.from(r.stdout, 'utf8'), 65536, 'WINDOWS_ARCHIVE_UNCONFIRMED') : null;
    return { verified: v?.verified === true, directory: typeof v?.directory === 'string' ? v.directory : null, moved: v?.moved ?? null };
  }

  async archiveLinux(batch, reason) {
    const answer = await this.companionMailbox.await(await this.companionMailbox.send('archive-linux', { batchId: batch.batchId, reason }, 6 * 60_000), this.sleep);
    return { verified: answer?.ok === true && answer.verified === true, directory: answer?.directory ?? null };
  }

  async runStage(batch, stage) {
    const row = batch.stages[stage.number - 1];
    check(row && row.number === stage.number && HEX64.test(row.workManifestSha256) && HEX64.test(row.jobId), 'RESIDENT_STAGE_ROW_INVALID');
    // Before the second and third Linux role, archive the previous role's protocol records on both
    // hosts, exactly as run-batch.ps1:81 does today; otherwise a stale issue.ready would be relayed.
    if ([4, 6].includes(stage.number)) {
      const reason = `between-roles-${stage.number}`;
      const w = await this.archiveWindows(batch, reason);
      const l = await this.archiveLinux(batch, reason);
      if (w.verified !== true || l.verified !== true) return { ok: false, code: 'BETWEEN_ROLES_ARCHIVE_UNCONFIRMED', proof: {} };
    }
    // Lesson b29: no push between the bundle and the first scanner stage. A moved ref is a clean,
    // transient refusal before anything ran (eligible for the automatic attempt 2).
    if (stage.number === 2) {
      const refs = await this.companionMailbox.await(await this.companionMailbox.send('check-refs', { batchId: batch.batchId }, 6 * 60_000), this.sleep);
      if (refs?.ok !== true) {
        const code = refs?.code === 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' ? 'REMOTE_REFS_CHANGED_SINCE_BUNDLE' : 'GITHUB_TRANSIENT_UNAVAILABLE';
        return { ok: false, code, proof: { windowsTreeZero: true, serviceOriginalStopped: await this.scReadback() } };
      }
    }
    const invoke = await this.requireV2('invoke-stage.mjs');
    const relay = stage.linuxWorker
      ? this.companionMailbox.send('relay-stage', { batchId: batch.batchId, stage: stage.number, jobId: row.jobId }, stage.runMilliseconds + 120_000)
      : null;
    const r = await this.run([this.paths.nodeExe, invoke, '--batch-dir', batch.dir, '--stage', String(stage.number), '--work-manifest-sha256', row.workManifestSha256,
      '--batch-key', batch.key], { timeoutMs: stage.runMilliseconds + 360_000 });
    if (r.timedOut || r.code === null) return { ok: false, code: 'STAGE_INVOKER_TERMINAL_UNCONFIRMED', proof: { windowsTreeZero: false, serviceOriginalStopped: false } };
    const fact = parseStageFact(r.stdout, row.workManifestSha256);
    const scOk = await this.scReadback();
    if (relay) {
      const answer = await this.companionMailbox.await(await relay, this.sleep);
      if (fact.ok && answer?.ok !== true) return { ok: false, code: answer?.code ?? 'COMPANION_PUMP_UNCONFIRMED', proof: { ...fact.proof, serviceOriginalStopped: fact.proof.serviceOriginalStopped && scOk } };
    }
    const ok = fact.ok && scOk;
    return { ok, code: ok ? null : (fact.code ?? 'SCM_READBACK_NOT_ORIGINAL'), proof: { ...fact.proof, serviceOriginalStopped: fact.proof.serviceOriginalStopped && scOk }, factsSha256: fact.nativeReceiptSha256 };
  }

  // Windows quiescence: SCM shows the original binary, Manual, STOPPED, pid 0 under clued-control,
  // and this service has no child process still running (the runner never kills; busy = unknown).
  async windowsQuiescence() {
    const scOk = await this.scReadback();
    const idle = this.busy() === false;
    return { windowsTreeZero: idle, serviceOriginalStopped: scOk };
  }

  async closeBatch(batch) {
    const w = await this.archiveWindows(batch, 'success-close');
    const l = await this.archiveLinux(batch, 'success-close');
    return { verified: w.verified === true && l.verified === true, archived: w.moved };
  }

  async archiveFailure(batch, reason) {
    if (!batch) return { verified: true, directory: 'archive-nothing-derived' };
    return this.archiveWindows(batch, reason);
  }
}
