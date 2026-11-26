// Rule 41ab823a (DESIGN §75): the scans H already carries, as stage 1 of a front batch names them (Source
// published-on-github-v2.mjs#headScansOf: App 5368905's newest scanner check of each name on H that tested H itself): [{ role, externalId }],
// each scan role once, the staged external id. Mirrored here (a test cross-checks both): a value that does not have exactly that shape is
// none, so the front batch scans as before. No imports: the engine parses it (engine-windows.mjs#parseStageOutcome) and the executor
// checks it again (executor.mjs#frontScansReused) without either depending on the other.
export const HEAD_SCAN_ROLES = Object.freeze(['gitleaks', 'trivy', 'contract-placement']);
export const HEAD_SCAN_EXTERNAL_ID = /^independent-ci:staged:v2:[a-f0-9]{64}:a[1-9]$/;
export function stageHeadScans(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > HEAD_SCAN_ROLES.length) return null;
  const ok = v.every(x => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === 2 && HEAD_SCAN_ROLES.includes(x.role)
    && typeof x.externalId === 'string' && HEAD_SCAN_EXTERNAL_ID.test(x.externalId)) && new Set(v.map(x => x.role)).size === v.length;
  return ok ? HEAD_SCAN_ROLES.flatMap(role => v.filter(x => x.role === role).map(x => ({ role, externalId: x.externalId }))) : null;
}
