"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { type Session } from '@supabase/supabase-js';
import { supabase } from '../../supabase-browser';
import Link from 'next/link';
import { type Resource } from '../../../lib/context-authorization';
import ConsentPermissions from './consent-permissions';
import { consentModel, consentSubmission, EMPTY_SELECTION, initialConsentSelection, requestedConsentResources, selectedCount, type ConsentSelection } from './consent-selection';
import styles from './consent.module.css';

type Details = { request_id: string; version: number; client_name: string; client_id: string; requested_scopes: string[]; eligible: Resource[]; user: { id: string; email?: string } };
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
      && Array.isArray(row.actions) && row.actions.every(action => typeof action === 'string')
      && ['name', 'project_id', 'project_name', 'context_name', 'ownership'].every(key => row[key] === undefined || row[key] === null || typeof row[key] === 'string'));
}

export default function DelegatedConsent({ requestId }: { requestId: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [details, setDetails] = useState<Details | null>(null);
  const [selection, setSelection] = useState<ConsentSelection>(EMPTY_SELECTION);
  const [selectionNotice, setSelectionNotice] = useState('');
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
    setDetails(null); setSelection(EMPTY_SELECTION); setPassword(''); setError(''); setSelectionNotice('');
    setSending(false); setAuthBusy(false); setLoading(false);
    return epoch;
  }, []);

  const load = useCallback(async (who: Session, epoch: number) => {
    if (accountEpoch.current !== epoch || currentSession.current?.user.id !== who.user.id) return;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const number = ++readNumber.current;
    setLoading(true); setError(''); setDetails(null); setSelection(EMPTY_SELECTION);
    try {
      const response = await fetch(`/oauth/request?request_id=${encodeURIComponent(requestId)}`, {
        headers: { Authorization: `Bearer ${who.access_token}` }, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      const value: unknown = await response.json();
      if (!response.ok) throw new Error(isObject(value) && typeof value.error === 'string' ? value.error : '无法读取授权请求。');
      if (!validDetails(value)) throw new Error('授权服务返回了不完整的资源列表。');
      if (value.user.id !== who.user.id) throw new Error('授权请求与当前账户不匹配，请重新读取。');
      if (accountEpoch.current !== epoch || currentSession.current?.user.id !== who.user.id || number !== readNumber.current || controller.signal.aborted) return;
      const bounded = { ...value, eligible: requestedConsentResources(value.eligible, value.requested_scopes) };
      const initial = initialConsentSelection(consentModel(bounded.eligible));
      setDetails(bounded); setSelectionNotice(''); setSelection(initial);
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
    const model = consentModel(details.eligible);
    const submission = consentSubmission(details.eligible, model, selection);
    if (action === 'approve' && (model.invalid || !model.supportsFuturePolicies || submission.tooMany || !selectedCount(selection, model.allIds))) return;
    const controller = new AbortController();
    writeController.current = controller;
    setSending(true); setError('');
    try {
      const entries = action === 'deny' ? [] : submission.selected;
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
  }, [details, loading, authBusy, selection, requestId, days]);

  const busy = loading || authBusy || sending;
  const model = consentModel(details?.eligible || []);
  const count = selectedCount(selection, model.allIds);
  const submission = consentSubmission(details?.eligible || [], model, selection);
  const consentReady = !model.invalid && model.supportsFuturePolicies;
  return <main className="oauth-shell"><section className={'oauth-card oauth-consent ' + styles['selected-consent']} aria-busy={busy}>
    <Link className="oauth-brand" href="/">BeamingFace</Link>
    {busy && <p role="status">正在核验授权…</p>}
    {error && <div className="oauth-error" role="alert"><strong>尚未完成</strong><p>{error}</p><button type="button" disabled={busy} onClick={() => void reload()}>重新读取请求</button></div>}
    {!busy && !session && <><h1>登录 BeamingFace 以继续</h1><p className="oauth-copy">开发和个人使用共用同一个账户。登录后选择允许此客户端使用的资源。</p>
      <form className="oauth-form" onSubmit={signIn}>
        <label>邮箱<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label>密码<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
        <button className="primary-button" disabled={busy} type="submit">登录并继续</button>
      </form><p><Link href="/oauth/account" target="_blank" rel="noopener noreferrer">忘记密码</Link></p><p>没有账户的开发者，请在<Link href="/oauth/projects" target="_blank" rel="noopener noreferrer">开发项目页面</Link>注册，并打开项目所有者提供的邀请链接。</p></>}
    {session && !details && <div className="oauth-details"><p>登录账户：{session.user.email || session.user.id}</p><button className="oauth-secondary" type="button" disabled={authBusy} onClick={() => void switchAccount()}>切换账户</button></div>}
    {details && <>
      <h1>允许 {details.client_name} 使用 BeamingFace</h1>
      <dl className="oauth-details"><div><dt>当前账户</dt><dd className="oauth-account-inline">{details.user.email || details.user.id}<button className="oauth-account-switch" type="button" disabled={busy} onClick={() => void switchAccount()}>切换账户</button></dd></div><div><dt>客户端标识</dt><dd style={{ overflowWrap: 'anywhere' }}>{details.client_id}</dd></div></dl>
      <p className="oauth-copy">按内容选择权限，可展开后使用只读、读写或全部快捷设置，再逐项调整。</p>
      {model.allIds.length > 0 ? <ConsentPermissions model={model} selection={selection} busy={busy} notice={selectionNotice}
        onSelection={setSelection} onNotice={setSelectionNotice} />
        : <p role="status">身份已验证，尚无可授权的业务资源。</p>}
      {!consentReady && <p className="oauth-note" role="alert">授权服务尚未提供完整的权限设置，请重新读取请求后继续。</p>}
      {submission.tooMany && <p className="oauth-note" role="alert">当前选择超过 100 个授权范围，无法在保留这些具体权限的同时提交。请减少所选范围后继续。</p>}
      <p><Link href="/oauth/projects" target="_blank" rel="noopener noreferrer">查看项目资格与邀请</Link></p>
      <label className={styles['selected-lifetime']}>授权有效期<select disabled={busy} value={days} onChange={e => { setDays(Number(e.target.value)); setSelectionNotice(''); }}>{lifetimeDays.map(n => <option key={n} value={n}>{n} 天</option>)}</select></label>
      <p className="oauth-note">此选择不包含成员管理、生产发布或大规模导出。可以随时在<Link href="/oauth/connections" target="_blank" rel="noopener noreferrer">连接管理</Link>中减少或撤销权限。</p>
      <div className="oauth-actions"><button className="oauth-secondary" type="button" disabled={busy} onClick={() => void decide('deny')}>取消</button><button className="primary-button" type="button" disabled={busy || !consentReady || submission.tooMany || count === 0} onClick={() => void decide('approve')}>允许所选权限</button></div>
    </>}
  </section></main>;
}
