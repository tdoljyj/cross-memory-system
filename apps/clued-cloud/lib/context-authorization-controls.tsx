"use client";
import { ACTION_LABELS, ALL_PROJECTS, OPERATION_LABELS, authorizationDisplayOrder, availablePresets, isAllContexts, isMacro, resourceGroups, resourceKey, resourceTitle,
  type OperationPreset, type Resource, type Selection } from "./context-authorization";

export default function ContextAuthorizationControls({ rows, selected, preset, range, custom, busy, notice, allowLegacyProjectPolicy = false, onRange, onPreset, onResource, onAction }: {
  rows: Resource[]; selected: Selection; preset: OperationPreset; range: "all" | "specified"; custom: boolean; busy: boolean; notice?: string;
  allowLegacyProjectPolicy?: boolean;
  onRange: (range: "all" | "specified") => void; onPreset: (preset: OperationPreset) => void;
  onResource: (row: Resource, checked: boolean) => void; onAction: (row: Resource, action: string, checked: boolean) => void;
}) {
  const macro = rows.find(isAllContexts);
  const activeRows = rows.filter(row => (selected[resourceKey(row)] || []).length);
  const options = availablePresets(activeRows.length ? activeRows : macro && range === "all" ? [macro] : rows);
  return <section className="oauth-roles" aria-label="上下文授权范围和操作">
    <fieldset className="oauth-range" disabled={busy}><legend>范围</legend>
      {macro && <label><input type="radio" name="context-range" checked={range === "all"} onChange={() => onRange("all")} />全部上下文（含以后新建的）</label>}
      <label><input type="radio" name="context-range" checked={range === "specified"} onChange={() => onRange("specified")} />指定范围</label>
      {range === "all" && <p>包含个人资料、个人记录及全部自有项目的正式记录和上下文，以后新建的自有项目与上下文也自动包含；共享或受邀资源需单独选择。</p>}
      {range === "specified" && <><p>{rows.some(row => row.resource_id === ALL_PROJECTS && (selected[resourceKey(row)] || []).length) ? "原自有项目正式记录策略仍包含未来项目；它不包含项目用途上下文，属于自定义范围。" : "只授权勾选的具体资源和环境，不包含未来新建资源。"}</p>{resourceGroups(rows).map(group => <section key={group.key}>
        <h3>{group.name}</h3>{group.rows.map(row => <label key={resourceKey(row)} className="oauth-project-choice">
          <input type="checkbox" checked={(selected[resourceKey(row)] || []).length > 0} onChange={event => onResource(row, event.target.checked)} />
          {row.resource_kind === "scope" && row.resource_id.startsWith("project:") ? "项目正式记录" : resourceTitle(row)}
        </label>)}
      </section>)}</>}
    </fieldset>
    <h2 style={{ fontSize: 18 }}>操作权限</h2><div className="oauth-role-list">{options.map(value => <button key={value} type="button" disabled={busy}
      aria-pressed={!custom && preset === value} onClick={() => onPreset(value)}><strong>{OPERATION_LABELS[value]}</strong>
      <small>{value === "reader" ? "读取所选内容" : value === "developer" ? "读取、新增和修改" : "本次客户端申请且资源支持的全部操作"}</small></button>)}</div>
    {custom && <p role="status">自定义：已逐项调整。重新套用预设将替换已选资源的自定义动作，不加入未选资源。</p>}
    {!options.includes("developer") && <p>本次未具备读取和写入申请；简单模式只提供只读。其他实际可申请动作可在高级中选择。</p>}
    {notice && <p role="status">{notice}</p>}
    <details className="oauth-advanced"><summary>高级：逐项调整动作</summary>
      {authorizationDisplayOrder(range === "all" && macro ? [macro] : rows.filter(row => !isMacro(row) || allowLegacyProjectPolicy && row.resource_id === ALL_PROJECTS)).map(row => <fieldset key={resourceKey(row)} disabled={busy}>
        <legend>{resourceTitle(row)}</legend><details><summary>资源详情</summary><p>{row.resource_id} · {row.environment}</p></details>
        <label><input className="oauth-group-checkbox" type="checkbox" disabled={busy}
          checked={row.actions.length > 0 && row.actions.every(action => (selected[resourceKey(row)] || []).includes(action))}
          aria-checked={(selected[resourceKey(row)] || []).length > 0 && (selected[resourceKey(row)] || []).length < row.actions.length ? 'mixed' : row.actions.length > 0 && row.actions.every(action => (selected[resourceKey(row)] || []).includes(action))}
          ref={node => { if (node) node.indeterminate = (selected[resourceKey(row)] || []).length > 0 && (selected[resourceKey(row)] || []).length < row.actions.length; }}
          onChange={() => { const checked = !row.actions.every(action => (selected[resourceKey(row)] || []).includes(action)); row.actions.forEach(action => onAction(row, action, checked)); }} />本组全部权限</label>
        <span>已选 {(selected[resourceKey(row)] || []).length}/{row.actions.length} 项</span>
        {row.actions.map(action => <label key={action}><input type="checkbox" checked={(selected[resourceKey(row)] || []).includes(action)}
          onChange={event => onAction(row, action, event.target.checked)} />{row.resource_kind === "context" && action === "close" ? "关闭／撤回记录" : ACTION_LABELS[action] || action}</label>)}
      </fieldset>)}
    </details>
  </section>;
}
