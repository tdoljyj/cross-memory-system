"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createClient, type Session } from '@supabase/supabase-js';
import Link from 'next/link';

const supabase = createClient('https://ccxsikzwxlolxqlosril.supabase.co', 'sb_publishable_tVKKh7Ok4FhBhHtHyZfwBA_i2RJD2Fg');
type Resource = { resource_kind: 'scope' | 'context'; resource_id: string; environment: string; name?: string; actions: string[] };
type Details = { request_id: string; version: number; client_name: string; client_id: string; requested_scopes: string[]; eligible: Resource[]; user: { id: string; email?: string } };
const actionLabels: Record<string, string> = { read: '读取', write: '新增和修改', close: '关闭和归档', restore: '恢复', feedback_submit: '提交反馈', audit: '查看审计回执' };
const environmentLabels: Record<string, string> = { canonical: '正式记忆', test: '测试环境', preview: '预览环境', production: '生产环境' };
const rowKey = (row: Resource) => JSON.stringify([row.resource_kind, row.resource_id, row.environment]);
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
  const [days, setDays] = useState(7);
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
      setDetails(value);
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

  const busy = loading || authBusy || sending;
  const count = Object.values(selected).reduce((n, actions) => n + actions.length, 0);
  return <main className="oauth-shell"><section className="oauth-card" aria-busy={busy}>
    <Link className="oauth-brand" href="/"><span className="brand-mark" aria-hidden="true">◆</span><span>CLUED</span></Link>
    {busy && <p role="status">正在核验授权…</p>}
    {error && <div className="oauth-error" role="alert"><strong>尚未完成</strong><p>{error}</p><button type="button" disabled={busy} onClick={() => void reload()}>重新读取请求</button></div>}
    {!busy && !session && <><h1>登录 Clued 以继续</h1><p className="oauth-copy">开发和个人使用共用同一个账户。登录后选择允许此客户端使用的资源。</p>
      <form className="oauth-form" onSubmit={signIn}>
        <label>邮箱<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label>密码<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
        <button className="primary-button" disabled={busy} type="submit">登录并继续</button>
      </form><p><Link href="/oauth/account" target="_blank" rel="noopener noreferrer">忘记密码</Link></p><p>没有账户的开发者，请先通过项目邀请完成账户注册与资格确认。</p></>}
    {session && <div className="oauth-details"><p>登录账户：{session.user.email || session.user.id}</p><button className="oauth-secondary" type="button" disabled={authBusy} onClick={() => void switchAccount()}>切换账户</button></div>}
    {details && <>
      <h1>允许 {details.client_name} 使用 Clued</h1>
      <dl className="oauth-details"><div><dt>当前账户</dt><dd>{details.user.email || details.user.id}</dd></div><div><dt>客户端标识</dt><dd style={{ overflowWrap: 'anywhere' }}>{details.client_id}</dd></div></dl>
      <p className="oauth-copy">只勾选本次需要的权限。每个连接分别授权；安装 Skill 不会增加权限。</p>
      {!details.eligible.length && <p role="status">身份已验证，尚无可授权的业务资源。项目开发资格需要资源所有者授予。</p>}
      <div className="oauth-permissions">
        {details.eligible.map(row => <fieldset key={rowKey(row)} disabled={busy} style={{ marginBottom: 16, border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: 12 }}>
          <legend>{row.name || (row.resource_id === 'global' ? '我的个人记忆' : row.resource_id)} · {environmentLabels[row.environment] || row.environment}</legend>
          {row.actions.map(action => <label key={action} style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
            <input type="checkbox" checked={(selected[rowKey(row)] || []).includes(action)} onChange={event => {
              const checked = event.target.checked;
              setSelected(old => ({ ...old, [rowKey(row)]: checked ? [...(old[rowKey(row)] || []), action] : (old[rowKey(row)] || []).filter(a => a !== action) }));
            }} />{actionLabels[action] || action}
          </label>)}
          {row.resource_kind === 'context' && row.actions.includes('write') && <small>修改已有内容前，可另外选择读取权限来核对当前版本；系统不会自动追加。</small>}
        </fieldset>)}
      </div>
      <label className="oauth-form">授权有效期<select disabled={busy} value={days} onChange={e => setDays(Number(e.target.value))}><option value={1}>1 天</option><option value={7}>7 天</option><option value={30}>30 天</option></select></label>
      <p className="oauth-note">此选择不包含成员管理、生产发布或大规模导出。可以随时在<Link href="/oauth/connections" target="_blank" rel="noopener noreferrer">连接管理</Link>中减少或撤销权限。</p>
      <div className="oauth-actions"><button className="oauth-secondary" type="button" disabled={busy} onClick={() => void decide('deny')}>取消</button><button className="primary-button" type="button" disabled={busy || count === 0} onClick={() => void decide('approve')}>允许所选权限</button></div>
    </>}
  </section></main>;
}
