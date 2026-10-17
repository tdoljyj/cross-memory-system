"use client";
import { type ReactNode } from 'react';
import { ACTION_LABELS } from '../../../lib/context-authorization';
import { actionsForShortcut, applyShortcut, changeTarget, sameActions, selectAction, selectGroups, selectedCount, totalCount,
  type ConsentModel, type ConsentSelection, type PermissionGroup, type Shortcut } from './consent-selection';
import styles from './consent.module.css';

const shortcuts: { id: Shortcut; title: string }[] = [{ id: 'read', title: '只读' }, { id: 'write', title: '读写' }, { id: 'all', title: '全部' }];
type UpdateSelection = (update: (previous: ConsentSelection) => ConsentSelection) => void;

function TriState({ count, total, label, ariaLabel, describedBy, hidden = false, busy, onChange }: {
  count: number; total: number; label: string; ariaLabel?: string; describedBy?: string; hidden?: boolean; busy: boolean; onChange: (checked: boolean) => void;
}) {
  const checked = count === total && total > 0;
  const mixed = count > 0 && count < total;
  return <label className={styles['selected-checkbox-label']}>
    <input type="checkbox" checked={checked} disabled={busy || total === 0} aria-label={ariaLabel || label} aria-describedby={describedBy}
      aria-checked={mixed ? 'mixed' : checked} ref={node => { if (node) node.indeterminate = mixed; }} onChange={event => onChange(event.target.checked)} />
    <span className={hidden ? styles['selected-sr-only'] : undefined}>{label}</span>
  </label>;
}

export default function ConsentPermissions({ model, selection, busy, notice, onSelection, onNotice }: {
  model: ConsentModel; selection: ConsentSelection; busy: boolean; notice: string; onSelection: UpdateSelection; onNotice: (notice: string) => void;
}) {
  const countFor = (ids: string[]) => selectedCount(selection, ids);
  const totalFor = (ids: string[]) => totalCount(model, ids);
  const count = countFor(model.allIds);
  const statusFor = (ids: string[]) => countFor(ids) === 0 ? '未授权' : countFor(ids) === totalFor(ids) ? '全部权限' : '自定义';
  function chooseGroups(ids: string[], checked: boolean, activate?: string) {
    if (busy) return;
    onNotice(''); onSelection(previous => selectGroups(model, previous, ids, checked, activate));
  }
  function chooseAction(group: PermissionGroup, action: string, checked: boolean) {
    if (busy) return;
    onNotice(''); onSelection(previous => selectAction(model, previous, group.id, action, checked));
  }
  function quickPermissions(ids: string[], ownerName: string, hideStatus = false) {
    const available = (shortcut: Shortcut) => ids.some(id => actionsForShortcut(model.byId[id], shortcut).length > 0);
    const matching = ids.length ? shortcuts.find(shortcut => available(shortcut.id) && ids.every(id => sameActions(selection.selected[id] || [], actionsForShortcut(model.byId[id], shortcut.id)))) : undefined;
    const quickStatus = !ids.length ? '未选择范围' : !matching && countFor(ids) > 0 ? '自定义' : '';
    return <div className={styles['selected-quick']}>
      <div className={styles['selected-quick-title']}>快捷权限 {!hideStatus && quickStatus && <span>{quickStatus}</span>}</div>
      <div className={styles['selected-quick-buttons']} role="group" aria-label={ownerName + '快捷权限'}>
        {shortcuts.map(shortcut => <button type="button" key={shortcut.id} aria-pressed={matching?.id === shortcut.id} disabled={busy || !available(shortcut.id)}
          onClick={() => { if (busy || !available(shortcut.id)) return; onNotice(''); onSelection(previous => applyShortcut(model, previous, ids, shortcut.id)); }}>{shortcut.title}</button>)}
      </div>
    </div>;
  }
  function permissionGroup(id: string, showShortcuts = false, embedded = false) {
    const group = model.byId[id];
    const actions = selection.selected[id] || [];
    const personal = model.personalIds.includes(id);
    const compact = personal || embedded;
    return <fieldset key={id} disabled={busy} className={styles['selected-permission-group'] + (compact ? ' ' + styles['selected-personal-permissions'] : '')} aria-label={group.resourceName}>
      {!compact && <legend>{group.title}</legend>}
      {showShortcuts && quickPermissions([id], group.resourceName, personal)}
      {!showShortcuts && !compact && <div className={styles['selected-group-head']}>
        <TriState count={actions.length} total={group.actions.length} label="本组全部权限" ariaLabel={group.resourceName + '的全部权限'} busy={busy} onChange={checked => chooseGroups([id], checked)} />
        <span>已选 {actions.length}/{group.actions.length} 项</span>
      </div>}
      {group.actions.map(action => <label className={styles['selected-action']} key={action}>
        <input type="checkbox" checked={actions.includes(action)} disabled={busy}
          aria-label={group.resourceName + ' · ' + (group.context && action === 'close' ? '关闭/撤回记录' : ACTION_LABELS[action])}
          onChange={event => chooseAction(group, action, event.target.checked)} />
        {group.context && action === 'close' ? '关闭/撤回记录' : ACTION_LABELS[action]}
      </label>)}
      {!personal && !actions.length && <p className={styles['selected-help']}>尚未授予权限，可选择快捷权限或逐项勾选。</p>}
    </fieldset>;
  }
  function collapsible(title: string, ids: string[], children: ReactNode, options: { key?: string; activate?: string; description?: string; descriptionId?: string; shared?: boolean } = {}) {
    return <div className={styles['selected-project']} key={options.key || title} role="group" aria-label={title + '权限组'}>
      <div className={styles['selected-project-toggle']}>
        <TriState count={countFor(ids)} total={totalFor(ids)} label={title + '的全部权限'} describedBy={options.descriptionId} hidden busy={busy}
          onChange={checked => chooseGroups(ids, checked, options.activate)} />
      </div>
      <details>
        <summary aria-describedby={options.descriptionId}><span>{title}</span><small>{statusFor(ids)}</small>
          {options.shared && <span className={styles['selected-description']}>共享或受邀内容，仅按本次精确选择授权。</span>}
          {options.description && <span id={options.descriptionId} className={styles['selected-description']}>{options.description}</span>}
        </summary>
        <div className={styles['selected-project-body']}>{children}</div>
      </details>
    </div>;
  }
  function projectContents(project: ConsentModel['projects'][number]) {
    const targets = selection.targets[project.id] || [];
    return <>
      <fieldset className={styles['selected-scope']} disabled={busy}>
        <legend>范围</legend>
        <div className={styles['selected-targets']}>
          {project.groupIds.map(id => <label key={id}><input type="checkbox" checked={targets.includes(id)} disabled={busy}
            aria-label={project.title + '选择范围 · ' + model.byId[id].title} onChange={event => {
              if (busy) return;
              const checked = event.target.checked;
              onNotice(checked ? '已加入这个内容范围，但尚未授权。请选择快捷权限或逐项勾选。' : '已移除这个内容范围，并清空它的授权权限。');
              onSelection(previous => changeTarget(previous, project.id, id, checked));
            }} />{model.byId[id].title}</label>)}
        </div>
      </fieldset>
      {quickPermissions(targets, project.title)}
      {project.groupIds.filter(id => targets.includes(id)).map(id => permissionGroup(id, false, targets.length === 1))}
    </>;
  }
  return <>
    <div className={styles['selected-total']} role="group" aria-label="全部权限设置">
      <TriState count={count} total={totalFor(model.allIds)} label="全部权限" busy={busy} onChange={checked => chooseGroups(model.allIds, checked, 'all')} />
      <span className={styles['selected-count']}>{count === 0 ? '未选择权限' : count === totalFor(model.allIds) ? '已全选' : '已选部分权限'}</span>
      <div className={styles['selected-top-level']}>
        {model.personalIds.map(id => {
          const group = model.byId[id];
          const profile = group.resource?.resource_id === 'profile';
          return collapsible(group.title, [id], permissionGroup(id, true), {
            key: id, description: profile ? '你的身份、偏好和长期背景。' : '不属于具体项目的待办、笔记和想法，例如购物清单、随手灵感。',
            descriptionId: profile ? 'consent-profile-description' : 'consent-global-description',
          });
        })}
        {(model.projectIds.length > 0 || model.projects.length > 0) && collapsible('项目', model.projectIds, <>
          {model.projects.map(project => collapsible(project.title, project.groupIds, projectContents(project), { key: project.id, activate: project.id, shared: project.shared }))}
          {model.futureIds.length > 0 && collapsible('以后新建的自有项目及项目内上下文', model.futureIds, <>
            <p className={styles['selected-future-note']}>未来项目记录用于以后新建的自有项目；未来项目上下文包括新项目的上下文，以及已有自有项目以后新增的上下文。两类默认权限与现有内容的例外独立。</p>
            {model.futureIds.map(id => permissionGroup(id, true))}
          </>, { description: '仅包含自有项目及项目内新增的上下文，不含共享或受邀内容。' })}
        </>, { activate: 'projects', description: '围绕具体项目保存的目标、任务、决策和进展，例如一个产品的开发记录。', descriptionId: 'consent-projects-description' })}
      </div>
    </div>
    {notice && <p className="oauth-note" role="status">{notice}</p>}
  </>;
}
