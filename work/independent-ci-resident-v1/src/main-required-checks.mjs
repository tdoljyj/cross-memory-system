// Read the effective main rules, including organization rules, through the caller's paginated GET port.
// paged receives a repository-relative route with no query and returns the combined array.
// An unpinned check has integrationId null. A failed, empty or malformed read throws.
export async function readMainRequiredChecks(paged) {
  const rules = await paged('/rules/branches/main');
  const invalid = () => { throw new Error('main required status checks are unreadable'); };
  if (!Array.isArray(rules) || rules.some(rule => typeof rule?.type !== 'string')) invalid();
  const checks = new Map();
  for (const rule of rules.filter(rule => rule.type === 'required_status_checks')) {
    const required = rule.parameters?.required_status_checks;
    if (!Array.isArray(required) || !required.length) invalid();
    for (const entry of required) {
      const integrationId = entry?.integration_id ?? null;
      const context = entry?.context;
      if (typeof context !== 'string' || !context.trim() || /[\r\n]/.test(context)
        || (integrationId !== null && (!Number.isSafeInteger(integrationId) || integrationId <= 0))) invalid();
      checks.set(JSON.stringify([context, integrationId]), { context, integrationId });
    }
  }
  if (!checks.size) invalid();
  return [...checks.values()];
}
