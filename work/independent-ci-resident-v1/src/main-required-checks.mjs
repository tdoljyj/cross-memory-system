// Read the effective main rules, including organization rules, through the caller's paginated GET port.
// paged receives a repository-relative route with no query and returns the combined array.
// An unpinned check has integrationId null; so does integration_id -1 ("any source", which Source v2 allows). A failed read throws what the
// port throws; an empty or malformed answer throws RulesShapeError.
export class RulesShapeError extends Error {}
// A failing read of the rules is shown to people (the PR line, the Owner's toast) only once it has lasted this long. A flap of the network
// (one or two missed rounds of a one-minute loop) clears by itself, and a message that appears and vanishes teaches the Owner to ignore it;
// ten minutes is longer than the usual flap and far shorter than the 12-hour watch of a head, so nothing is lost by waiting.
export const RULES_UNREADABLE_REPORT_AFTER_MS = 10 * 60_000;
export async function readMainRequiredChecks(paged) {
  const rules = await paged('/rules/branches/main');
  const invalid = () => { throw new RulesShapeError('main required status checks are unreadable'); };
  if (!Array.isArray(rules) || rules.some(rule => typeof rule?.type !== 'string')) invalid();
  const checks = new Map();
  for (const rule of rules.filter(rule => rule.type === 'required_status_checks')) {
    const required = rule.parameters?.required_status_checks;
    if (!Array.isArray(required) || !required.length) invalid();
    for (const entry of required) {
      const integrationId = entry?.integration_id === -1 ? null : (entry?.integration_id ?? null);
      const context = entry?.context;
      if (typeof context !== 'string' || !context.trim() || /[\r\n]/.test(context)
        || (integrationId !== null && (!Number.isSafeInteger(integrationId) || integrationId <= 0))) invalid();
      checks.set(JSON.stringify([context, integrationId]), { context, integrationId });
    }
  }
  if (!checks.size) invalid();
  return [...checks.values()];
}
