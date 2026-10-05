"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { type Session } from '@supabase/supabase-js';
import { supabase } from '../../supabase-browser';
import Link from 'next/link';

type Resource = { resource_kind: 'scope' | 'context'; resource_id: string; environment: string; name?: string; actions: string[] };
type Details = { request_id: string; version: number; client_name: string; client_id: string; requested_scopes: string[]; eligible: Resource[]; user: { id: string; email?: string } };
const actionLabels: Record<string, string> = { read: '读取', write: '新增和修改', close: '关闭和归档', restore: '恢复', feedback_submit: '提交反馈', audit: '查看审计回执' };
const environmentLabels: Record<string, string> = { canonical: '正式记忆', test: '测试环境', preview: '预览环境', production: '生产环境' };
const rowKey = (row: Resource) => JSON.stringify([row.resource_kind, row.resource_id, row.environment]);
// Preset roles (PermissionSimplification.v0.1 §3.1, Decision b32fc5b9) are packaged
// selections of the same rows; 高级 shows every row and any change there makes the
// role 自定义. 全部 takes "我的全部项目（含以后新建的）" (project:*) as its range whenever
// that row is on offer (Decision d4c06a24), so the page opens on every eligible action;
// the Owner can still switch the range back to 指定项目.
type Role = 'reader' | 'developer' | 'full' | 'custom';
const ALL_PROJECTS = 'project:*';
const ROLES: { role: Exclude<Role, 'custom'>; title: string; text: string }[] = [
  { role: 'reader', title: '只读', text: '所选范围内每处：读取' },
  { role: 'developer', title: '项目开发者', text: '所选项目：读取、新增和修改、关闭和归档、恢复；个人记忆：读取' },
  { role: 'full', title: '全部', text: '个人记忆、个人资料、所选项目：全部权限' },
];
const PROJECT_ACTIONS: Record<Exclude<Role, 'custom'>, string[]> = {
  reader: ['read'], developer: ['read', 'write', 'close', 'restore'], full: ['read', 'write', 'close', 'restore', 'audit'],
};
const isProject = (row: Resource) => row.resource_kind === 'scope' && row.resource_id.startsWith('project:') && row.resource_id !== ALL_PROJECTS;
function preset(rows: Resource[], role: Exclude<Role, 'custom'>, allProjects: boolean, chosen: string[]) {
  return Object.fromEntries(rows.map(row => {
    let want: string[];
    if (row.resource_kind === 'context') want = role === 'full' ? row.actions : role === 'reader' ? ['read'] : [];
    else if (row.resource_id === ALL_PROJECTS) want = allProjects ? PROJECT_ACTIONS[role] : [];
    else if (isProject(row)) want = !allProjects && chosen.includes(row.resource_id) ? PROJECT_ACTIONS[role] : [];
    else if (role === 'full') want = row.actions;
    else want = role === 'developer' && row.resource_id !== 'global' ? [] : ['read'];
    return [rowKey(row), row.actions.filter(action => want.includes(action))];
  }));
}
const lifetimeDays = [1, 7, 30, 90, 365];
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
function validDetails(value: unknown): value is Details {
  return isObject(value) && typeof value.request_id === 'string' && typeof value.version === 'number'
    && Number.isSafeInteger(value.version) && value.version > 0 && typeof value.client_name === 'string'
    && typeof value.client_id === 'string' && Array.isArray(value.requested_scopes)
    && value.requested_scopes.every(scope => typeof scope === 'string')
    && isObject(value.user) && typeof value.user.id === 'string' && Array.isArray(value.eligible)
    && value.eligible.every(row => isObject(row) && (row.resource_kind === 'scope' || row.resource_kind === 'context')
      && typeof row.resource_id === 'string' && typeof row.environment === 'string'
      && Array.isArray(row.actions) && row.actions.every(action => typeof action === 'string'));
}

export default function DelegatedConsent({ requestId }: { requestId: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [role, setRole] = useState<Role>('full');
  const [allProjects, setAllProjects] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [days, setDays] = useState(30);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const currentSession = useRef<Session | null>(null);
  const accountEpoch = useRef(0);
  const readNumber = useRef(0);
  const readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);

  const clearAccountWork = useCallback(() => {
    const epoch = ++accountEpoch.current;
    readController.current?.abort();
    writeController.current?.abort();
    writeController.current = null;
    setDetails(null); setSelected({}); setPassword(''); setError('');
    setSending(false); setAuthBusy(false); setLoading(false);
    return epoch;
  }, []);

  const load = useCallback(async (who: Session, epoch: number) => {
    if (accountEpoch.current !== epoch || currentSession.current?.user.id !== who.user.id) return;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const number = ++readNumber.current;
    setLoading(true); setError(''); setDetails(null); setSelected({});
    try {
      const response = await fetch(`/oauth/request?request_id=${encodeURIComponent(requestId)}`, {
        headers: { Authorization: `Bearer ${who.access_token}` }, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      const value: unknown = await response.json();
      if (!response.ok) throw new Error(isObject(value) && typeof value.error === 'string' ? value.error : '无法读取授权请求。');
      if (!validDetails(value)) throw new Error('授权服务返回了不完整的资源列表。');
      if (value.user.id !== who.user.id) throw new Error('授权请求与当前账户不匹配，请重新读取。');
      if (accountEpoch.current !== epoch || currentSession.current?.user.id !== who.user.id || number !== readNumber.current || controller.signal.aborted) return;
      const projects = value.eligible.filter(isProject).map(row => row.resource_id);
      const all = value.eligible.some(row => row.resource_kind === 'scope' && row.resource_id === ALL_PROJECTS);
      setDetails(value); setRole('full'); setAllProjects(all); setChosen(projects);
      setSelected(preset(value.eligible, 'full', all, projects));
    } catch (failure) {
      if (accountEpoch.current === epoch && number === readNumber.current && !controller.signal.aborted) {
        setError(failure instanceof Error && !(failure instanceof TypeError) ? failure.message : '授权暂不可用，请稍后重试。');
      }
    } finally {
      if (accountEpoch.current === epoch && number === readNumber.current && !controller.signal.aborted) setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    let disposed = false;
    let firstEvent = true;
    let timer: number | undefined;
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (disposed) return;
      const changed = firstEvent || currentSession.current?.user.id !== nextSession?.user.id;
      firstEvent = false;
      currentSession.current = nextSession;
      setSession(nextSession);
      if (!changed) return;
      const epoch = clearAccountWork();
      window.clearTimeout(timer);
      if (nextSession) {
        setLoading(true);
        // Keep the auth callback synchronous. An old account cannot refill this page.
        timer = window.setTimeout(() => { void load(nextSession, epoch); }, 0);
      }
    });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      readController.current?.abort();
      writeController.current?.abort();
      data.subscription.unsubscribe();
    };
  }, [load, clearAccountWork]);

  async function reload() {
    const who = currentSession.current;
    if (who && !writeController.current) await load(who, accountEpoch.current);
  }
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAuthBusy(true); setError('');
    const epoch = accountEpoch.current;
    try {
      const { error: failure } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (failure && accountEpoch.current === epoch) setError('登录失败，请检查邮箱和密码。');
    } catch {
      if (accountEpoch.current === epoch) setError('暂时无法登录，请稍后重试。');
    } finally {
      if (accountEpoch.current === epoch) { setPassword(''); setAuthBusy(false); }
    }
  }
  async function switchAccount() {
    // Invalidate in-flight results as soon as switching starts, even if sign-out fails.
    const epoch = clearAccountWork();
    setAuthBusy(true);
    try {
      const { error: failure } = await supabase.auth.signOut({ scope: 'local' });
      if (failure && accountEpoch.current === epoch) setError('未能退出当前账户，请重新读取授权请求后重试。');
    } catch {
      if (accountEpoch.current === epoch) setError('未能退出当前账户，请重新读取授权请求后重试。');
    } finally {
      if (accountEpoch.current === epoch) setAuthBusy(false);
    }
  }

  const decide = useCallback(async (action: 'approve' | 'deny') => {
    const who = currentSession.current;
    const epoch = accountEpoch.current;
    if (!who || !details || details.user.id !== who.user.id || writeController.current || loading || authBusy) return;
    const controller = new AbortController();
    writeController.current = controller;
    setSending(true); setError('');
    try {
      const entries = details.eligible.map(row => ({ resource_kind: row.resource_kind, resource_id: row.resource_id, environment: row.environment,
        actions: row.actions.filter(permission => (selected[rowKey(row)] || []).includes(permission)) })).filter(row => row.actions.length);
      const response = await fetch(`/oauth/decision?request_id=${encodeURIComponent(requestId)}`, {
        method: 'POST', credentials: 'same-origin', signal: controller.signal,
        headers: { Authorization: `Bearer ${who.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, selected: entries, days, version: details.version }),
      });
      const value: unknown = await response.json();
      if (accountEpoch.current !== epoch || currentSession.current?.user.id !== who.user.id || controller.signal.aborted) return;
      if (!response.ok || !isObject(value) || typeof value.redirect_url !== 'string' || !value.redirect_url) {
        throw new Error(isObject(value) && typeof value.error === 'string' ? value.error : '授权未完成，请从客户端重新连接。');
      }
      window.location.assign(value.redirect_url);
    } catch (failure) {
      if (accountEpoch.current === epoch && !controller.signal.aborted) {
        setError(failure instanceof Error && !(failure instanceof TypeError) ? failure.message : '授权结果尚未确认，请检查连接管理，或从客户端重新发起授权。');
      }
    } finally {
      if (accountEpoch.current === epoch && !controller.signal.aborted) {
        if (writeController.current === controller) writeController.current = null;
        setSending(false);
      }
    }
  }, [details, loading, authBusy, selected, requestId, days]);

  function choose(next: Exclude<Role, 'custom'>, nextAll = allProjects, nextChosen = chosen) {
    if (!details) return;
    setRole(next); setAllProjects(nextAll); setChosen(nextChosen);
    setSelected(preset(details.eligible, next, nextAll, nextChosen));
  }
  // A change in 高级 makes the role 自定义.
  function edit(change: (old: Record<string, string[]>) => Record<string, string[]>) {
    setRole('custom'); setSelected(change);
  }
  const busy = loading || authBusy || sending;
  const projectRows = details?.eligible.filter(isProject) || [];
  const offersAll = !!details?.eligible.some(row => row.resource_kind === 'scope' && row.resource_id === ALL_PROJECTS);
  const count = Object.values(selected).reduce((n, actions) => n + actions.length, 0);
  // project:* is expanded onto each of the Owner's projects when the grant is written,
  // so 高级 shows those actions ticked and locked on each project row.
  const allRow = details?.eligible.find(row => row.resource_kind === 'scope' && row.resource_id === ALL_PROJECTS);
  const allActions = allRow ? selected[rowKey(allRow)] || [] : [];
  const covered = (row: Resource, action: string) => isProject(row) && allActions.includes(action);
  const shown = (row: Resource) => row.actions.filter(action => (selected[rowKey(row)] || []).includes(action) || covered(row, action));
  const editable = (row: Resource) => row.actions.filter(action => !covered(row, action));
  const groups = [
    { name: '个人记忆', rows: details?.eligible.filter(row => row.resource_kind === 'scope' && !row.resource_id.startsWith('project:')) || [] },
    { name: '项目协作', rows: details?.eligible.filter(row => row.resource_kind === 'scope' && row.resource_id.startsWith('project:')) || [] },
    { name: '项目开发', rows: details?.eligible.filter(row => row.resource_kind === 'context') || [] },
  ].filter(group => group.rows.length);
  return <main className="oauth-shell"><section className="oauth-card oauth-consent" aria-busy={busy}>
    <Link className="oauth-brand" href="/"><span className="brand-mark" aria-hidden="true">◆</span><span>CLUED</span></Link>
    {busy && <p role="status">正在核验授权…</p>}
    {error && <div className="oauth-error" role="alert"><strong>尚未完成</strong><p>{error}</p><button type="button" disabled={busy} onClick={() => void reload()}>重新读取请求</button></div>}
    {!busy && !session && <><h1>登录 Clued 以继续</h1><p className="oauth-copy">开发和个人使用共用同一个账户。登录后选择允许此客户端使用的资源。</p>
      <form className="oauth-form" onSubmit={signIn}>
        <label>邮箱<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label>密码<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
        <button className="primary-button" disabled={busy} type="submit">登录并继续</button>
      </form><p><Link href="/oauth/account" target="_blank" rel="noopener noreferrer">忘记密码</Link></p><p>没有账户的开发者，请在<Link href="/oauth/projects" target="_blank" rel="noopener noreferrer">开发项目页面</Link>注册，并打开项目所有者提供的邀请链接。</p></>}
    {session && !details && <div className="oauth-details"><p>登录账户：{session.user.email || session.user.id}</p><button className="oauth-secondary" type="button" disabled={authBusy} onClick={() => void switchAccount()}>切换账户</button></div>}
    {details && <>
      <h1>允许 {details.client_name} 使用 Clued</h1>
      <dl className="oauth-details"><div><dt>当前账户</dt><dd className="oauth-account-inline">{details.user.email || details.user.id}<button className="oauth-account-switch" type="button" disabled={busy} onClick={() => void switchAccount()}>切换账户</button></dd></div><div><dt>客户端标识</dt><dd style={{ overflowWrap: 'anywhere' }}>{details.client_id}</dd></div></dl>
      <p className="oauth-copy">先选一个角色和范围；需要逐项调整时打开下方的“高级”。仍需点击最下方按钮确认授权。</p>
      {details.eligible.length > 0 && <section className="oauth-roles" aria-label="角色">
        <h2 style={{ fontSize: 18 }}>角色</h2>
        <div className="oauth-role-list">{ROLES.map(item => <button key={item.role} type="button" aria-pressed={role === item.role}
          disabled={busy} onClick={() => choose(item.role, item.role === 'full' ? offersAll || allProjects : allProjects)}><strong>{item.title}</strong><small>{item.text}</small></button>)}</div>
        {role === 'custom' && <p role="status">自定义：你在“高级”里改过勾选。点上面的角色可以重新套用。</p>}
        {role !== 'custom' && (projectRows.length > 0 || offersAll) && <fieldset className="oauth-range" disabled={busy}>
          <legend>项目范围</legend>
          <label><input type="radio" name="project-range" checked={!allProjects} onChange={() => choose(role, false)} />指定项目</label>
          {offersAll && <label><input type="radio" name="project-range" checked={allProjects} onChange={() => choose(role, true)} />我的全部项目（含以后新建的）</label>}
          {allProjects && <small>以后新建的项目也自动包含在内；只包含你自己的项目，不含别人共享给你的。可以随时在连接管理里收窄。</small>}
          {!allProjects && projectRows.map(row => <label key={rowKey(row)} className="oauth-project-choice">
            <input type="checkbox" checked={chosen.includes(row.resource_id)} onChange={event => choose(role, false,
              event.target.checked ? [...chosen.filter(id => id !== row.resource_id), row.resource_id] : chosen.filter(id => id !== row.resource_id))} />
            {row.name || row.resource_id}</label>)}
        </fieldset>}
      </section>}
      {!details.eligible.length && <p role="status">身份已验证，尚无可授权的业务资源。项目开发资格需要资源所有者授予。</p>}
      <p><Link href="/oauth/projects" target="_blank" rel="noopener noreferrer">查看或接受开发项目邀请</Link></p>
      <details className="oauth-advanced"><summary>高级：逐项勾选（当前已选 {count} 项）</summary>
      <p className="oauth-scroll-hint">在下方区域滚动查看全部权限；每组可单独全选或清空。每组的全选仅作用于当前资源及环境。</p>
      <div className="oauth-permissions oauth-permissions-scroll" role="region" aria-label="可授权的资源和权限" tabIndex={0}>
        {groups.map(group => <section key={group.name}><h2 style={{ fontSize: 18 }}>{group.name}</h2>{group.rows.map(row => <fieldset key={rowKey(row)} disabled={busy} style={{ marginBottom: 10, border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: 12 }}>
          <legend>{row.name || (row.resource_id === 'global' ? '我的个人记忆' : row.resource_id)} · {environmentLabels[row.environment] || row.environment}</legend>
          <div className="oauth-group-actions">
            <label>
              <input className="oauth-group-checkbox" type="checkbox"
                checked={row.actions.length > 0 && shown(row).length === row.actions.length}
                aria-checked={shown(row).length > 0 && shown(row).length < row.actions.length ? 'mixed' : row.actions.length > 0 && shown(row).length === row.actions.length}
                ref={node => { if (node) node.indeterminate = shown(row).length > 0 && shown(row).length < row.actions.length; }}
                disabled={busy || editable(row).length === 0}
                onChange={() => edit(old => {
                  const own = editable(row);
                  const current = (old[rowKey(row)] || []).filter(action => !own.includes(action));
                  return { ...old, [rowKey(row)]: own.every(action => (old[rowKey(row)] || []).includes(action)) ? current : [...current, ...own] };
                })}
              />本组全部权限
            </label>
            <span>已选 {shown(row).length}/{row.actions.length} 项</span>
          </div>
          {row.actions.map(action => <label key={action} style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' }}>
            <input type="checkbox" checked={shown(row).includes(action)} disabled={covered(row, action)} onChange={event => {
              const checked = event.target.checked;
              edit(old => { const current = (old[rowKey(row)] || []).filter(a => a !== action); return { ...old, [rowKey(row)]: checked ? [...current, action] : current }; });
            }} />{row.resource_kind === "context" && action === "close" ? "关闭/撤回记录" : actionLabels[action] || action}
          </label>)}
          {row.actions.some(action => covered(row, action)) && <small className="oauth-range-note">由“我的全部项目（含以后新建的）”覆盖，批准后这个项目自动获得勾上的权限。要单独调整这个项目，请把“项目范围”改回“指定项目”。</small>}
          {row.resource_id === ALL_PROJECTS && !(selected[rowKey(row)] || []).length && <small className="oauth-range-note">这一组只在“项目范围”选“我的全部项目（含以后新建的）”时才勾选；选“指定项目”时，权限落在各个项目自己的组里。</small>}
          {row.resource_kind === 'context' && row.actions.includes('write') && <small>修改已有内容前，可另外选择读取权限来核对当前版本；系统不会自动追加。</small>}
        </fieldset>)}</section>)}
      </div></details>
      <label className="oauth-form">授权有效期<select disabled={busy} value={days} onChange={e => setDays(Number(e.target.value))}>{lifetimeDays.map(n => <option key={n} value={n}>{n} 天</option>)}</select></label>
      <p className="oauth-note">此选择不包含成员管理、生产发布或大规模导出。可以随时在<Link href="/oauth/connections" target="_blank" rel="noopener noreferrer">连接管理</Link>中减少或撤销权限。</p>
      <div className="oauth-actions"><button className="oauth-secondary" type="button" disabled={busy} onClick={() => void decide('deny')}>取消</button><button className="primary-button" type="button" disabled={busy || count === 0} onClick={() => void decide('approve')}>允许所选权限</button></div>
    </>}
  </section></main>;
}
