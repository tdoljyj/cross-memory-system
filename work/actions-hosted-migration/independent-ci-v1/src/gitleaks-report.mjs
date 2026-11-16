// Trusted projection of a bounded --redact JSON report. Match, Secret, author,
// messages and all other scanner text are deliberately discarded before storage.
import { digest } from './proof.mjs';

const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/, LIMIT = 10;
const fail = () => { throw Object.assign(new Error('GITLEAKS_REPORT_INVALID'), { code: 'GITLEAKS_REPORT_INVALID' }); };
const check = v => { if (!v) fail(); };
const keys = (v, expected) => v && Object.getPrototypeOf(v) === Object.prototype
  && Object.keys(v).sort().join('|') === expected.split('|').sort().join('|');
function location(v) {
  check(keys(v, 'rule|file|line|endLine|commit') && typeof v.rule === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(v.rule)
    && typeof v.file === 'string' && v.file.length > 0 && v.file.length <= 512 && !/[\x00-\x1f\x7f]/.test(v.file)
    && Number.isSafeInteger(v.line) && v.line > 0 && Number.isSafeInteger(v.endLine) && v.endLine >= v.line && SHA.test(v.commit));
  return v;
}
export function summarizeGitleaksReport(raw, prepared, auditExitCode) {
  check(typeof raw === 'string' && Buffer.byteLength(raw) <= 16777216 && [0, 1].includes(auditExitCode));
  let rows; try { rows = JSON.parse(raw); } catch { fail(); }
  // gitleaks encodes its nil finding slice as null on a clean run.
  if (rows === null) rows = [];
  check(Array.isArray(rows) && (rows.length > 0) === (auditExitCode === 1));
  check(SHA.test(prepared.headSha) && SHA.test(prepared.baseSha) && Array.isArray(prepared.prCommits)
    && prepared.prCommits.every(s => SHA.test(s)) && new Set(prepared.prCommits).size === prepared.prCommits.length);
  const commits = new Set(prepared.prCommits), pr = { count: 0, locations: [] }, other = { count: 0, locations: [] };
  for (const row of rows) {
    const v = location({ rule: row?.RuleID, file: row?.File, line: row?.StartLine, endLine: row?.EndLine, commit: row?.Commit });
    const group = commits.has(v.commit) ? pr : other; group.count++;
    if (group.locations.length < LIMIT) group.locations.push(v);
  }
  return validateGitleaksReport({ contract: 'clued.independent-ci.gitleaks-report/1', headSha: prepared.headSha, baseSha: prepared.baseSha,
    prCommitSetSha256: digest([...commits].sort()), auditExitCode, pr, other }, prepared);
}
export function validateGitleaksReport(r, job) {
  check(keys(r, 'contract|headSha|baseSha|prCommitSetSha256|auditExitCode|pr|other') && r.contract === 'clued.independent-ci.gitleaks-report/1'
    && SHA.test(r.headSha) && r.headSha === job.headSha && SHA.test(r.baseSha) && r.baseSha === job.baseSha
    && HASH.test(r.prCommitSetSha256) && [0, 1].includes(r.auditExitCode));
  for (const group of [r.pr, r.other]) {
    check(keys(group, 'count|locations') && Number.isSafeInteger(group.count) && group.count >= 0
      && Array.isArray(group.locations) && group.locations.length === Math.min(group.count, LIMIT));
    group.locations.forEach(location);
  }
  check((r.pr.count + r.other.count > 0) === (r.auditExitCode === 1));
  return r;
}
// A signed, whitelisted projection is validated again at the publication edge;
// neither an arbitrary log string nor an extra JSON field can reach GitHub.
export function gitleaksCheckSummary(r, job) {
  validateGitleaksReport(r, job);
  const escape = s => s.replace(/[&<>`|\[\]\\*_]/g, c => `&#${c.charCodeAt(0)};`);
  const group = (title, g) => [`${title}: ${g.count}`, ...g.locations.map(v =>
    `- ${escape(v.rule)} | ${escape(v.file)}:${v.line}-${v.endLine} | ${v.commit}`),
    ...(g.count > g.locations.length ? [`仅显示前 ${g.locations.length} 条；另有 ${g.count - g.locations.length} 条。`] : [])].join('\n');
  const text = `\n\ngitleaks PR 范围：${r.baseSha}..${r.headSha}（包含随后被删除内容的提交补丁）。\n`
    + group('PR 新增提交发现（决定检查结论）', r.pr) + '\n\n'
    + group('独立全历史审计告警（PR 范围外，不阻塞本 PR）', r.other)
    + '\n匹配正文不予保留；扫描使用 --redact。';
  check(Buffer.byteLength(text) <= 60000);
  return text;
}
