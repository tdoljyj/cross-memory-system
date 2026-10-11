const authenticationKeys = new Set([
  'user_id',
  'actor_user_id',
  'binding_id',
  'actor_binding_id',
]);

const workClaimTools = new Set([
  'clued_work_claim',
  'clued_work_renew',
  'clued_work_release',
  'clued_work_verify',
  'clued_work_takeover',
]);

type EnvelopePosition = 'root' | 'search_row' | 'work_claim' | 'nested';

/** Remove service authentication identities while preserving opaque user JSON.
 * Canonical export snapshots contain service rows and must still be traversed.
 * A checkpoint snapshot belongs to the user only at its known result location.
 */
export function sanitizeCluedResult(value: unknown, toolName?: string): unknown {
  function envelope(current: unknown, position: EnvelopePosition): unknown {
    if (Array.isArray(current)) return current.map(child => envelope(child, 'nested'));
    if (!current || typeof current !== 'object') return current;

    const row = current as Record<string, unknown>;
    const entries = Object.entries(row).flatMap(([key, child]): [string, unknown][] => {
      if (authenticationKeys.has(key)) return [];

      // These values are user-provided JSON; their field names cannot establish
      // that an identity belongs to Clued's authentication envelope.
      if (key === 'type_fields' || key === 'relations' || key === 'payload') return [[key, child]];

      // A claim's budget stores the caller's open JSON declaration plus a
      // service profile_id. Other service budgets do not share that boundary.
      if (position === 'work_claim' && key === 'budget') return [[key, child]];
      if (position === 'root') {
        if (workClaimTools.has(toolName ?? '') && key === 'claim') {
          return [[key, envelope(child, 'work_claim')]];
        }
        const claimRows = (toolName === 'clued_session_resume' && key === 'active_work_claims') ||
          (toolName === 'clued_work_claims_active' && key === 'claims');
        if (claimRows && Array.isArray(child)) {
          return [[key, child.map(claim => envelope(claim, 'work_claim'))]];
        }
      }

      const userSnapshot = key === 'snapshot' && (
        (position === 'root' && (toolName === 'clued_session_resume' || toolName === 'clued_session_checkpoint')) ||
        (position === 'search_row' && row.kind === 'checkpoint')
      );
      if (userSnapshot) return [[key, child]];

      // Only direct search results are tagged rows. An arbitrary nested object
      // declaring kind=checkpoint does not change its service-envelope status.
      if (position === 'root' && toolName === 'clued_search_context' && key === 'results' && Array.isArray(child)) {
        return [[key, child.map(result => envelope(result, 'search_row'))]];
      }
      return [[key, envelope(child, 'nested')]];
    });

    // Unlike assignment to {}, this retains an own JSON "__proto__" property
    // without invoking the prototype setter or changing the result prototype.
    return Object.fromEntries(entries);
  }

  return envelope(value, 'root');
}
