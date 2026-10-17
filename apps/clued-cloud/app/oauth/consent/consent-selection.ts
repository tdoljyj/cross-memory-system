import { ALL_CONTEXTS, ALL_PROJECTS, ENVIRONMENT_LABELS, resourceKey, type Resource } from '../../../lib/context-authorization';

export type Shortcut = 'read' | 'write' | 'all';
export const FUTURE_PROJECT_RECORDS = 'owned-project-records:future';
export const FUTURE_PROJECT_CONTEXTS = 'owned-project-contexts:future';
export type PermissionGroup = {
  id: string; title: string; resourceName: string; actions: string[]; context: boolean;
  resource: Resource; future?: 'records' | 'contexts';
};
export type ConsentProject = { id: string; title: string; groupIds: string[]; shared: boolean };
export type ConsentModel = {
  groups: PermissionGroup[]; byId: Record<string, PermissionGroup>; personalIds: string[];
  projects: ConsentProject[]; projectIds: string[]; futureIds: string[]; allIds: string[]; invalid: boolean; supportsFuturePolicies: boolean;
};
export type ConsentSelection = { selected: Record<string, string[]>; targets: Record<string, string[]> };
export const RECORD_ACTIONS = ['read', 'write', 'close', 'restore', 'audit'];
export const CONTEXT_ACTIONS = ['read', 'write', 'close', 'feedback_submit'];
export const EMPTY_SELECTION: ConsentSelection = { selected: {}, targets: {} };
const ownership = (row: Resource) => (row as Resource & { ownership?: string }).ownership;
const futureKind = (row: Resource) => row.resource_kind !== 'scope' || row.environment !== 'canonical' ? undefined
  : row.resource_id === FUTURE_PROJECT_RECORDS ? 'records' : row.resource_id === FUTURE_PROJECT_CONTEXTS ? 'contexts' : undefined;
const legalActions = (row: Resource) => row.resource_id === ALL_CONTEXTS && row.resource_kind === 'scope'
  ? [...RECORD_ACTIONS, 'feedback_submit'] : row.resource_kind === 'context' || futureKind(row) === 'contexts' ? CONTEXT_ACTIONS : RECORD_ACTIONS;

export function requestedConsentResources(rows: Resource[], scopes: string[]): Resource[] {
  const allowed = (action: string) => action === 'read' ? scopes.includes('context:read') : action === 'audit' ? scopes.includes('audit:read') : scopes.includes('context:write');
  // Preserve zero-action future rows: their typed presence identifies the supported policy contract.
  return rows.map(row => ({ ...row, actions: legalActions(row).filter(action => row.actions.includes(action) && allowed(action)) }));
}

// Display groups keep the service's canonical resource key. A display name never identifies a grant.
export function consentModel(rows: Resource[]): ConsentModel {
  const groups: PermissionGroup[] = [];
  const projects = new Map<string, ConsentProject>();
  const seen = new Set<string>();
  let invalid = false;
  for (const row of rows) {
    if (row.resource_kind === 'scope' && [ALL_CONTEXTS, ALL_PROJECTS].includes(row.resource_id)) continue;
    const id = resourceKey(row);
    if (seen.has(id)) { invalid = true; continue; }
    seen.add(id);
    const future = futureKind(row);
    if (future) {
      if (ownership(row) !== 'self') { invalid = true; continue; }
      const context = future === 'contexts';
      const actions = (context ? CONTEXT_ACTIONS : RECORD_ACTIONS).filter(action => row.actions.includes(action));
      if (actions.length) groups.push({ id, title: context ? '未来项目上下文' : '未来项目记录',
        resourceName: context ? '未来项目上下文' : '未来项目记录', context, actions, future, resource: row });
      continue;
    }
    const personal = row.resource_kind === 'scope' && ['profile', 'global'].includes(row.resource_id);
    const scopeProjectId = row.resource_kind === 'scope' && row.resource_id.startsWith('project:') ? row.resource_id.slice(8) : null;
    const projectId = row.project_id || scopeProjectId;
    if ((!personal && row.resource_kind !== 'context' && !row.resource_id.startsWith('project:'))
      || (row.resource_kind === 'scope' && row.environment !== 'canonical')
      || (scopeProjectId && row.project_id && scopeProjectId !== row.project_id)) { invalid = true; continue; }
    if (!row.actions.length) continue;
    const context = row.resource_kind === 'context';
    const actions = (context ? CONTEXT_ACTIONS : RECORD_ACTIONS).filter(action => row.actions.includes(action));
    if (!actions.length) continue;
    const projectTitle = row.project_name || (!context ? row.name : undefined) || '项目（名称暂不可用）';
    const contextName = row.context_name || row.name;
    const title = personal ? row.resource_id === 'profile' ? '个人资料' : '个人记录'
      : context ? `${contextName && contextName !== projectTitle ? contextName : '上下文'} · ${ENVIRONMENT_LABELS[row.environment] || row.environment}` : '项目记录';
    groups.push({ id, title, resourceName: personal ? title : `${projectTitle} ${title}`, context, actions, resource: row });
    if (!personal) {
      // A context without project metadata remains an exact selectable resource, never an owned wildcard.
      const key = projectId || `context:${row.resource_id}`;
      const shared = ownership(row) === 'membership';
      if (!projects.has(key)) projects.set(key, { id: key, title: projectId ? projectTitle : '上下文（所属项目暂不可用）', groupIds: [], shared });
      const project = projects.get(key)!;
      project.groupIds.push(id);
      project.shared = project.shared || shared;
      if (row.project_name) project.title = row.project_name;
    }
  }
  const currentGroups = new Map(groups.map(group => [group.id, group]));
  const projectTitleCounts = new Map<string, number>();
  for (const project of projects.values()) projectTitleCounts.set(project.title, (projectTitleCounts.get(project.title) || 0) + 1);
  for (const project of projects.values()) {
    if (projectTitleCounts.get(project.title)! > 1) project.title += `（${project.id.replace(/^context:/, '').slice(0, 8)}）`;
    project.groupIds.sort((a, b) => Number(currentGroups.get(a)!.context) - Number(currentGroups.get(b)!.context));
    const projectGroups = project.groupIds.map(id => currentGroups.get(id)!);
    const titleCounts = new Map<string, number>();
    for (const group of projectGroups) titleCounts.set(group.title, (titleCounts.get(group.title) || 0) + 1);
    for (const group of projectGroups) {
      if (titleCounts.get(group.title)! > 1) group.title += `（${group.resource!.resource_id.slice(0, 8)}）`;
      group.resourceName = `${project.title} ${group.title}`;
    }
  }
  const byId = Object.fromEntries(groups.map(group => [group.id, group]));
  const personalIds = ['profile', 'global'].flatMap(kind => groups.filter(group => group.resource?.resource_kind === 'scope' && group.resource.resource_id === kind).map(group => group.id));
  const futureIds = ['records', 'contexts'].flatMap(kind => groups.filter(group => group.future === kind).map(group => group.id));
  const supportsFuturePolicies = ['records', 'contexts'].every(kind => rows.some(row => futureKind(row) === kind && ownership(row) === 'self'));
  const projectIds = [...projects.values()].flatMap(project => project.groupIds).concat(futureIds);
  return { groups, byId, personalIds, projects: [...projects.values()], projectIds, futureIds,
    allIds: [...personalIds, ...projectIds], invalid, supportsFuturePolicies };
}

export function initialConsentSelection(model: ConsentModel): ConsentSelection {
  const defaultSelected = (group: PermissionGroup) => ownership(group.resource) === 'self';
  return { selected: Object.fromEntries(model.groups.map(group => [group.id, defaultSelected(group) ? [...group.actions] : []])),
    targets: Object.fromEntries(model.projects.map(project => [project.id, project.groupIds.filter(id => defaultSelected(model.byId[id]))])) };
}
export const actionsForShortcut = (group: PermissionGroup, shortcut: Shortcut) => group.actions.filter(action => shortcut === 'all' || action === 'read' || shortcut === 'write' && action === 'write');
export const selectedCount = (state: ConsentSelection, ids: string[]) => ids.reduce((count, id) => count + (state.selected[id] || []).length, 0);
export const totalCount = (model: ConsentModel, ids: string[]) => ids.reduce((count, id) => count + model.byId[id].actions.length, 0);
export const sameActions = (a: string[], b: string[]) => a.length === b.length && a.every(action => b.includes(action));

export function selectGroups(model: ConsentModel, state: ConsentSelection, ids: string[], checked: boolean, activate?: string): ConsentSelection {
  const selected = { ...state.selected, ...Object.fromEntries(ids.map(id => [id, checked ? [...model.byId[id].actions] : []])) };
  const affected = !checked || !activate ? [] : activate === 'all' || activate === 'projects' ? model.projects : model.projects.filter(project => project.id === activate);
  return { selected, targets: { ...state.targets, ...Object.fromEntries(affected.map(project => [project.id, [...project.groupIds]])) } };
}
export function applyShortcut(model: ConsentModel, state: ConsentSelection, ids: string[], shortcut: Shortcut): ConsentSelection {
  return { ...state, selected: { ...state.selected, ...Object.fromEntries(ids.map(id => [id, actionsForShortcut(model.byId[id], shortcut)])) } };
}
export function selectAction(model: ConsentModel, state: ConsentSelection, id: string, action: string, checked: boolean): ConsentSelection {
  return { ...state, selected: { ...state.selected, [id]: model.byId[id].actions.filter(value => value === action ? checked : (state.selected[id] || []).includes(value)) } };
}
export function changeTarget(state: ConsentSelection, projectId: string, id: string, checked: boolean): ConsentSelection {
  const targets = state.targets[projectId] || [];
  return { targets: { ...state.targets, [projectId]: checked ? [...targets.filter(value => value !== id), id] : targets.filter(value => value !== id) },
    selected: { ...state.selected, [id]: [] } };
}

export function selectedConsentResources(model: ConsentModel, state: ConsentSelection): Resource[] {
  return model.groups.flatMap(group => {
    const actions = group.actions.filter(action => (state.selected[group.id] || []).includes(action));
    const { resource_kind, resource_id, environment } = group.resource;
    return actions.length ? [{ resource_kind, resource_id, environment, actions }] : [];
  });
}

export function consentSubmission(rows: Resource[], model: ConsentModel, state: ConsentSelection): { selected: Resource[]; tooMany: boolean; compressed: boolean } {
  const selected = selectedConsentResources(model, state);
  if (selected.length <= 100) return { selected, tooMany: false, compressed: false };
  const macros = rows.filter(row => row.resource_kind === 'scope' && row.resource_id === ALL_CONTEXTS && row.environment === 'canonical');
  const current = rows.filter(row => !futureKind(row) && !(row.resource_kind === 'scope' && [ALL_CONTEXTS, ALL_PROJECTS].includes(row.resource_id)));
  const future = rows.filter(row => futureKind(row));
  const futureActions = future.flatMap(row => state.selected[resourceKey(row)] || []);
  const mask = macros.length === 1 ? macros[0].actions.filter(action => futureActions.includes(action)) : [];
  const projected = (row: Resource) => legalActions(row).filter(action => mask.includes(action));
  const matches = (row: Resource) => sameActions(state.selected[resourceKey(row)] || [], projected(row))
    && projected(row).every(action => row.actions.includes(action));
  const equivalent = !model.invalid && model.supportsFuturePolicies && mask.length > 0
    && current.every(row => ['self', 'membership'].includes(ownership(row) || ''))
    && ['profile', 'global'].every(id => current.some(row => row.resource_kind === 'scope' && row.resource_id === id && ownership(row) === 'self'))
    && current.filter(row => ownership(row) === 'self').every(matches) && future.every(matches);
  if (!equivalent) return { selected, tooMany: true, compressed: false };
  // Legacy compression is allowed only for the same complete owned selection and both future defaults.
  // Shared/invited grants retain their exact resource, environment and independently selected actions.
  const memberKeys = new Set(current.filter(row => ownership(row) === 'membership').map(resourceKey));
  const compressed = [{ resource_kind: 'scope' as const, resource_id: ALL_CONTEXTS, environment: 'canonical', actions: mask },
    ...selected.filter(row => memberKeys.has(resourceKey(row)))];
  return { selected: compressed, tooMany: compressed.length > 100, compressed: true };
}
