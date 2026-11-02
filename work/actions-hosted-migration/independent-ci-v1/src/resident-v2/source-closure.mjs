// The exact Source v2 closure (DESIGN S4, S5, S12): every repository file the installed Source needs, for
// prepare-record.mjs (--closure: the Owner-accepted pins) and the resident package (--source-files).
// Computed, not hand-listed: a static walk of the relative imports (static, dynamic and
// `new URL('./x', import.meta.url)` references) from the fixed entry points, plus the fixed non-JS files
// those entries run or read. source-closure.json is the committed result; a test recomputes it, so an
// import that is added without regenerating the closure fails offline instead of on the host.
//   node source-closure.mjs --repo-root <checkout> --out <new file>
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical } from '../proof.mjs';
import { ENTRY_V2 } from './layout.mjs';

export const CLOSURE_CONTRACT = 'clued.independent-ci.source-closure/2';
const CI = 'work/actions-hosted-migration/independent-ci-v1/';
// Node entry points: the four stage entries, the bridge v4 halves, the resident-side tools, the evaluator.
export const WALK_ENTRIES = Object.freeze([...Object.values(ENTRY_V2),
  ...['worker/protected-job-bridge-v4/linux-worker.mjs', 'worker/protected-job-bridge-v4/relay-record.mjs', 'worker/protected-job-bridge-v4/windows-issuer.mjs',
    'worker/protected-job-bridge-v4/bridge-manifest.mjs', 'src/resident-v2/derive-batch.mjs', 'src/resident-v2/invoke-stage.mjs'].map(p => CI + p),
  'scripts/ci/clued-work-admission.mjs'].sort());
// Files the entries execute or read without importing them.
export const FIXED_FILES = Object.freeze([
  '.gitleaks.toml', '.github/workflows/gitleaks.yml', '.github/workflows/trivy.yml', '.github/workflows/contract-placement.yml',
  'config/merge-admission-policy.json', 'scripts/ci/reviewed_gitleaks.py',
  'scripts/ci/clued-control-workflow-sources.json', 'scripts/ci/clued-gated-proof-profiles.json', 'scripts/ci/clued-gated-proof-role-specs.json',
  'scripts/ci/clued-production-publisher-sources.json', 'scripts/ci/clued-publisher-qualification-sources.json',
  ...['runtime/verify-install-acl.ps1',
    'src/resident-v2/acl-model.json', 'src/resident-v2/archive-windows-spool.ps1', 'src/resident-v2/build-bundle.ps1', 'src/resident-v2/hold-record.ps1',
    'src/resident-v2/migrate-acl.ps1', 'src/resident-v2/prepare-workspaces.py',
    'src/resident-v2/windows/FormalPublicBoundaryV2.cs', 'src/resident-v2/windows/FormalSession0V2.cs', 'src/resident-v2/windows/ScmPidHandshakeV2.cs',
    'src/resident-v2/windows/ResidentScmV2.cs', 'src/resident-v2/windows/NodeProfileV2.cs',
    'worker/protected-job-bridge-v4/relay-public.ps1', 'worker/protected-job-bridge-v4/formal-spool-acl.ps1'].map(p => CI + p)].sort());

const SPECIFIERS = [/(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]/g, /import\(\s*['"]([^'"]+)['"]\s*\)/g, /new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
  /import\s*['"](\.{1,2}\/[^'"]+)['"]/g];
const fail = code => { throw Object.assign(new Error(code), { code }); };
// References that exist in reachable modules but name no file, on code paths no Source v2 entry calls:
// worker/required-gitleaks/prepare.mjs is imported only for noLinks() (required-trivy-v2/plans.mjs); its
// superseded reviewedSelfTestPlan() names a shim that only formal-gitleaks-v3/v4 ship.
export const KNOWN_UNUSED_REFERENCES = Object.freeze([CI + 'worker/required-gitleaks/selftest-shim.mjs']);

export function computeClosure(repoRoot) {
  const seen = new Set(), queue = [...WALK_ENTRIES];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const file = path.join(repoRoot, ...rel.split('/'));
    if (KNOWN_UNUSED_REFERENCES.includes(rel) && !fs.existsSync(file)) continue;
    if (!fs.existsSync(file)) fail(`SOURCE_CLOSURE_FILE_MISSING:${rel}`);
    seen.add(rel);
    if (!/\.m?js$/.test(rel)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const re of SPECIFIERS) for (const m of text.matchAll(re)) {
      const spec = m[1];
      if ((!spec.startsWith('./') && !spec.startsWith('../')) || spec.endsWith('/')) continue; // directories (source roots) are not files
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (target.startsWith('../')) fail(`SOURCE_CLOSURE_ESCAPE:${rel}`);
      queue.push(target);
    }
  }
  for (const f of FIXED_FILES) { if (!fs.existsSync(path.join(repoRoot, ...f.split('/')))) fail(`SOURCE_CLOSURE_FILE_MISSING:${f}`); seen.add(f); }
  return [...seen].sort();
}

export const closureDocument = repoRoot => ({ contract: CLOSURE_CONTRACT, paths: computeClosure(repoRoot) });

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const a = process.argv.slice(2), root = a[a.indexOf('--repo-root') + 1], out = a[a.indexOf('--out') + 1];
  if (a.length !== 4 || !root || !out) { console.error('SOURCE_CLOSURE_ARGUMENTS_REQUIRED'); process.exitCode = 2; }
  else { const d = closureDocument(root); fs.writeFileSync(out, canonical(d) + '\n', { flag: 'wx' }); console.log(JSON.stringify({ status: 'SOURCE_CLOSURE_WRITTEN', files: d.paths.length })); }
}
