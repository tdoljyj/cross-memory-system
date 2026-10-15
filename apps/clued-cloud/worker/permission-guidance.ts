// PermissionSimplification.v0.1 §3.2 (Task 39e53a76): a permission refusal says
// what the connection is missing and gives the clued_owner_request arguments
// that ask the Owner for it. The suggestion grants nothing; the Owner still
// approves it on the signed-in confirm page. Whenever the missing context or
// action cannot be told from the call, the refusal carries no suggestion.

type Json = Record<string, unknown>;

export const PERMISSION_DENIAL_CODES = ['insufficient_scope', 'binding_not_authorized', 'resource_action_not_authorized'] as const;

const CONTEXT = /^(global|profile|project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Project lifecycle is checked against system:projects and Development
// Contexts against their own entries; neither is a connection.permission
// resource, so these tools never get a suggestion.
const NO_SUGGESTION_TOOLS = new Set(['clued_project_mutate', 'clued_project_list', 'clued_context']);

function contextOf(args: Json, toolName: string): string | null {
  // clued_search_context's scope is the search mode (all or context), not a
  // context: its context is context_key.
  const scope = toolName === 'clued_search_context' ? undefined : args.scope;
  const projectId = typeof args.project_id === 'string' ? args.project_id.toLowerCase() : null;
  if ((args.level === 'project' || scope === 'project') && projectId && UUID.test(projectId)) return `project:${projectId}`;
  const replacement = args.replacement && typeof args.replacement === 'object' ? (args.replacement as Json).scope : undefined;
  const named = [scope, args.context_key, args.event_scope, replacement].find(value => value !== undefined && value !== null);
  if (named !== undefined) return typeof named === 'string' && CONTEXT.test(named.toLowerCase()) ? named.toLowerCase() : null;
  // The database reads such calls as personal records (global); a call naming a project in some
  // other way is not guessed.
  return projectId ? null : 'global';
}

function actionOf(scope: string | undefined, toolName: string, args: Json): string | null {
  if (scope === 'context:read') return 'read';
  if (scope === 'audit:read') return 'audit';
  if (scope !== 'context:write') return null;
  if (toolName === 'clued_record_mutate' && (args.operation === 'close' || args.operation === 'restore')) return args.operation;
  return 'write';
}

// The smallest preset role (PermissionSimplification §3.1) that covers the
// missing action on a project, as a connection.permission resource. Offered
// next to suggested_request, which asks for that one action only.
const ROLES: Record<string, { role: string; title: string }> = {
  read: { role: 'reader', title: '只读' },
  write: { role: 'developer', title: '项目开发者' },
  close: { role: 'developer', title: '项目开发者' },
  restore: { role: 'developer', title: '项目开发者' },
  audit: { role: 'full', title: '全部' },
};
function roleFor(context: string, action: string) {
  const role = context.startsWith('project:') ? ROLES[action] : undefined;
  return role ? { ...role, resources: [`permission:${context}/${role.role}`] } : null;
}

/** The tool error for a permission refusal; missingScopes are the scopes the call needs that the connection lacks (or all it needs, for a database refusal). */
export function permissionDenial(code: string, toolName: unknown, rawArgs: unknown, missingScopes: readonly string[] | null) {
  const name = typeof toolName === 'string' ? toolName : '';
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Json;
  const scope = missingScopes?.[0];
  const context = NO_SUGGESTION_TOOLS.has(name) ? null : contextOf(args, name);
  const action = context ? actionOf(scope, name, args) : null;
  if (!context || !action) {
    return { status: 'rejected', error: { code, category: 'permission',
      message: 'This connection is not allowed to make this call. Tell the Owner which call was refused; reconnecting with the needed permission ticked is the fallback.' } };
  }
  const resource = `permission:${context}/${action}`;
  const role = roleFor(context, action);
  const day = new Date().toISOString().slice(0, 10).split('-').join('');
  return {
    status: 'rejected',
    error: {
      code, category: 'permission',
      message: `This connection lacks ${action} on ${context}. Call clued_owner_request with suggested_request as is, give the Owner the confirm_url it returns, and once it reads approved_once retry on this same connection. No reconnect is needed; do not send the Owner to /grants. If clued_owner_request refuses it, ask the Owner to reconnect this Host with the permission ticked.`,
      missing: { context, action, ...(scope ? { scope } : {}) },
      suggested_request: { action: 'connection.permission', resources: [resource], idempotency_key: `${resource}:${day}` },
      ...(role ? { suggested_role: role } : {}),
    },
  };
}

export function permissionDenialResult(denial: ReturnType<typeof permissionDenial>) {
  return { content: [{ type: 'text', text: JSON.stringify(denial) }], structuredContent: denial, isError: true };
}
