"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../supabase-browser";
import "../contexts/contexts.css";
import "../confirm/owner.css";

// Who is working on what (Owner Decision 4bcc424d) and the Owner's "hand over
// to a new session" (Decision 22b9bd9e). The list shows every live claim of
// this account; the label is the Agent's own words. A handover is two Native
// steps like the race page: a single-use confirmation over the exact claim,
// then the handover itself, which moves the fence (the old session can no
// longer renew or release the claim), rotates the lease key and shows the new
// key once, here only.
// All RPCs run as this signed-in account session; Bindings and delegated OAuth
// tokens are refused by the database.
type Json = Record<string, unknown>;
type Issued = { claim_id: string; confirmation_token: string; view_digest: string; expires_at: string; view: Json };
type Handed = { claim: Json; lease_key: string; receipt_id: string };
type HandoverSetting = { enabled: boolean; version: number; available: boolean };
type PendingHandover = { delivery_id: string; receipt_id: string };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const MESSAGES: Record<string, string> = {
  direct_human_session_required: "需要你本人直接登录 BeamingFace，授权给应用的登录不能查看或交接认领。",
  confirmation_token_session_id_required: "当前登录缺少会话信息，请退出后重新登录。",
  work_claim_not_found: "找不到这条认领。",
  work_claim_not_active: "这条认领已经结束或过期，不能交接。",
  work_claim_handover_unavailable: "这条认领是旧版本签发的，没有钥匙，不能交接。等它过期后由新会话接管即可。",
  work_claim_handover_no_renewal_left: "这条认领的续期次数已用完或快到最晚到期时间，新会话接不上。请让新会话等它结束后重新领取。",
  confirmation_token_expired: "确认已超过 5 分钟有效期，请重新点“交给新会话”。",
  confirmation_token_reused: "这次确认已经用过，请重新点“交给新会话”。",
  confirmation_token_revoked: "这次确认已被新的预览取代，请使用最新的预览。",
  confirmation_token_binding_mismatch: "确认与当前登录会话或预览内容不一致，请重新开始。",
  confirmation_view_stale: "认领在两步之间被改过（范围或持有者变了），请重新点“交给新会话”。",
  work_claim_handover_setting_version_conflict: "设置已在别处改变，请刷新后再操作。",
  work_claim_handover_not_ready: "自动交接正在完成上线核验，暂时不可用。",
  work_claim_handover_text_already_delivered: "交接文字已交付过，无法再次显示。",
  work_claim_handover_stale: "这次交接已被新的交接取代，请刷新认领。",
};
class RequestFailure extends Error { constructor(message: string, readonly uncertain = false) { super(message); } }

async function rpc(name: string, input: Json): Promise<Json> {
  let result: { data: unknown; error: { message?: string; code?: string } | null };
  try {
    result = await supabase.rpc(name, { p_input: input });
  } catch { throw new RequestFailure("网络请求未完成，结果未知。", true); }
  if (result.error) {
    const code = result.error.message ?? "";
    if (MESSAGES[code]) throw new RequestFailure(MESSAGES[code]);
    throw new RequestFailure(result.error.code ? "请求被拒绝（" + code + "）。" : "网络请求未完成，结果未知。",
      !result.error.code);
  }
  const value = result.data;
  if (!object(value)) throw new RequestFailure("服务返回了无法识别的结果，结果未知。", true);
  if (value.status === "rejected" || value.status === "failed") {
    const code = typeof value.error_code === "string" ? value.error_code : String(value.status);
    throw new RequestFailure(MESSAGES[code] ?? "请求被拒绝（" + code + "）。", value.status === "failed");
  }
  return value;
}

function remaining(expiresAt: unknown, now: number) {
  const ms = Date.parse(String(expiresAt)) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "已到期";
  const minutes = Math.ceil(ms / 60000);
  return minutes < 60 ? "还剩 " + minutes + " 分钟" : "还剩 " + Math.floor(minutes / 60) + " 小时 " + (minutes % 60) + " 分钟";
}
const text = (value: unknown) => typeof value === "string" ? value : "";
const list = (value: unknown) => Array.isArray(value) ? value.map(String) : [];
// Times read in the Owner's zone, Beijing time (Decision 4bcc424d v2).
const BEIJING = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
function beijing(value: unknown) {
  const ms = Date.parse(text(value));
  return Number.isFinite(ms) ? BEIJING.format(new Date(ms)) + "（北京时间）" : "";
}
const STATES: Record<string, string> = { ACTIVE: "有效", DRAINING: "收尾中", RELEASED: "已释放", EXPIRED: "已过期", SUPERSEDED: "被接管" };
const OUTCOMES: Record<string, string> = { completed: "完成", abandoned: "放弃" };
const ENDED_HOURS = 24;
const shortId = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-/i.test(value) ? value.slice(0, 8).toLowerCase() : "";
const taskUrl = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ? "/tasks?id=" + value.toLowerCase() : null;
// "owner/repo#123" → its GitHub page; anything else is shown as text.
function pullUrl(ref: unknown) {
  const match = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#([0-9]{1,10})$/.exec(text(ref));
  return match ? "https://github.com/" + match[1] + "/" + match[2] + "/pull/" + match[3] : null;
}
// Only a claude.ai Code session link from the server is followed.
const sessionUrl = (value: unknown) => /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{8,64}$/.test(text(value)) ? text(value) : null;

function handoverText(claim: Json, key: string, receiptId: string) {
  return [
    "请接手这份 BeamingFace 工作认领（Owner 在 BeamingFace 网页上交给你的；钥匙只给你，不要外传）。",
    "任务：" + text(claim.task_title) + "（" + text(claim.task_id) + "）",
    "scope: " + text(claim.context_key),
    "claim_id: " + text(claim.claim_id),
    "fence: " + String(claim.fence),
    "lease_version: " + String(claim.lease_version),
    "lease_key: " + key,
    "先调用 clued_work_renew：带上面的 scope、claim_id、fence、lease_version 和 lease_key，progress_ref 用 handover:"
      + receiptId + "，再带上你的 holder_session_ref 和 holder_label。之后每次续租和释放都带最新的 lease_key"
      + "（换了连接身份时续租会返回新钥匙）。不要把钥匙写进文件、提交、PR、记录或日志。",
  ].join("\n");
}

export default function WorkClaimsPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [claims, setClaims] = useState<Json[] | null>(null);
  const [ended, setEnded] = useState<Json[]>([]);
  const [showEnded, setShowEnded] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [handed, setHanded] = useState<Handed | null>(null);
  const [handoverSetting, setHandoverSetting] = useState<HandoverSetting | null>(null);
  const [pendingHandover, setPendingHandover] = useState<PendingHandover | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const current = useRef<Session | null>(null);
  const epoch = useRef(0);
  const loadSerial = useRef(0);

  useEffect(() => {
    const lifetime = epoch;
    let disposed = false;
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (disposed) return;
      const changed = current.current?.user.id !== next?.user.id;
      current.current = next; setSession(next); setReady(true);
      if (!changed) return;
      ++epoch.current;
      setClaims(null); setEnded([]); setShowEnded(false); setIssued(null); setHanded(null); setError(""); setNotice(""); setWorking(false);
      setHandoverSetting(null); setPendingHandover(null);
    });
    return () => { disposed = true; ++lifetime.current; data.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (session) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  async function load(withEnded = showEnded) {
    const generation = epoch.current;
    const serial = ++loadSerial.current;
    const stillCurrent = () => epoch.current === generation && loadSerial.current === serial;
    setWorking(true); setError(""); setHandoverSetting(null);
    try {
      const listed = rpc("clued_work_claims_owner_list_v1", withEnded ? { ended_within_hours: ENDED_HOURS } : {});
      // Settings may be unavailable during a staged rollout. Their read must
      // never hold the existing claim list or Task links behind it.
      void rpc("clued_work_free_handover_setting_v1", {}).then(setting => {
        if (!stillCurrent()) return;
        if (typeof setting.enabled !== "boolean" || !Number.isSafeInteger(setting.version)) throw new Error("setting unknown");
        setHandoverSetting({ enabled: setting.enabled, version: Number(setting.version), available: setting.available === true });
      }).catch(() => {
        if (!stillCurrent()) return;
        setHandoverSetting(null); setNotice("自由交接设置暂时无法读取，请稍后刷新。");
      });
      const value = await listed;
      if (!stillCurrent()) return;
      const currentClaims = Array.isArray(value.claims) ? value.claims.filter(object) : [];
      setClaims(currentClaims);
      const resumable = currentClaims.find(claim => claim.execution_handover_pending === true
        && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(text(claim.handover_pending_delivery_id)));
      if (resumable) setPendingHandover({ delivery_id: text(resumable.handover_pending_delivery_id), receipt_id: text(resumable.receipt_id) });
      setEnded(withEnded && Array.isArray(value.ended) ? value.ended.filter(object) : []);
    } catch (failure) {
      if (stillCurrent()) setError(failure instanceof RequestFailure ? failure.message : "暂时无法读取认领。");
    } finally { if (stillCurrent()) setWorking(false); }
  }

  async function changeHandoverSetting(enabled: boolean) {
    if (!current.current || working || !handoverSetting) return;
    const generation = epoch.current;
    setWorking(true); setError("");
    try {
      const value = await rpc("clued_work_free_handover_setting_set_v1",
        { enabled, base_version: handoverSetting.version });
      if (epoch.current !== generation) return;
      if (typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.version)) {
        throw new RequestFailure("设置结果尚未确认，请刷新后核对。", true);
      }
      setHandoverSetting({ enabled: value.enabled, version: Number(value.version), available: value.available === true });
      setNotice(value.enabled ? "自由交接已开启。" : "自由交接已关闭。");
    } catch (failure) {
      if (epoch.current === generation) {
        setHandoverSetting(null);
        setError(failure instanceof RequestFailure ? failure.message : "设置结果尚未确认，请刷新后核对。");
      }
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  async function collectHandover() {
    if (!current.current || working || !pendingHandover) return;
    const generation = epoch.current;
    setWorking(true); setError("");
    try {
      const value = await rpc("clued_work_claim_handover_v1", { action: "collect", delivery_id: pendingHandover.delivery_id });
      if (epoch.current !== generation) return;
      if (value.status === "pending") { setNotice("仍在撤销旧会话的执行准入。"); return; }
      if (value.status !== "committed" || typeof value.lease_key !== "string" || !object(value.claim)
        || typeof value.receipt_id !== "string") throw new RequestFailure("交接结果尚未确认。", true);
      setHanded({ claim: value.claim, lease_key: value.lease_key, receipt_id: value.receipt_id });
      setPendingHandover(null); void load();
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法读取交接结果。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  async function preview(claimId: string) {
    if (!current.current || working) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setNotice(""); setHanded(null);
    try {
      const value = await rpc("clued_work_claim_handover_confirmation_issue_v1", { claim_id: claimId });
      if (epoch.current !== generation) return;
      if (value.status !== "issued" || typeof value.confirmation_token !== "string" || typeof value.view_digest !== "string"
        || typeof value.expires_at !== "string" || !object(value.confirmation_view)) {
        throw new RequestFailure("预览结果不完整，请重新点“交给新会话”。");
      }
      setIssued({ claim_id: claimId, confirmation_token: value.confirmation_token, view_digest: value.view_digest,
        expires_at: value.expires_at, view: value.confirmation_view });
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法生成预览。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  // The key is shown once. A repeated step 2 commits nothing new and returns
  // no key, so an uncertain result is never retried here: the Owner checks the
  // list and, if the claim already moved on, hands it over again.
  async function confirm() {
    const target = issued;
    if (!current.current || working || !target) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setIssued(null);
    try {
      const value = await rpc("clued_work_claim_handover_v1",
        { confirmation_token: target.confirmation_token, view_digest: target.view_digest });
      if (epoch.current !== generation) return;
      if (value.status === "pending" && typeof value.delivery_id === "string" && typeof value.receipt_id === "string") {
        setPendingHandover({ delivery_id: value.delivery_id, receipt_id: value.receipt_id });
        setNotice("交接正在撤销旧会话的执行准入，完成后才会生成新钥匙。");
        void load(); return;
      }
      if (value.status !== "committed") throw new RequestFailure("交接结果尚未确认。", true);
      if (typeof value.lease_key !== "string" || !object(value.claim) || typeof value.receipt_id !== "string") {
        setNotice("这次交接已经完成过，钥匙只显示一次。如果还没交给新会话，请再点一次“交给新会话”。");
      } else {
        setHanded({ claim: value.claim, lease_key: value.lease_key, receipt_id: value.receipt_id });
      }
      void load();
    } catch (failure) {
      if (epoch.current !== generation) return;
      setError(failure instanceof RequestFailure && !failure.uncertain ? failure.message
        : "交接结果尚未确认。请刷新列表：如果这条认领的编号（fence）已经变了，说明已交接，钥匙无法再显示，请再交接一次。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); setNotice("已复制，贴给新会话即可。"); }
    catch { setNotice("无法自动复制，请手动选中上面的文字复制。"); }
  }

  const now = Date.now();
  return <main className="context-page owner-confirm">
    <header><Link href="/">BeamingFace</Link> <Link href="/grants">我的授权</Link> <Link href="/work-claims/race">多份模式</Link></header>
    <h1>谁在做哪个任务</h1>
    <p className="context-muted">这里列出你名下所有正在进行的认领。开启自由交接后，已获授权的 Agent 可以直接通过 BeamingFace 交接，无需你复制钥匙。旧会话无法响应时，也可以使用“交给新会话”恢复。“标签”是 Agent 自己报的，BeamingFace 无法核实。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 BeamingFace</Link> 后查看认领。</p> : <>
      <p className="context-muted">已登录 {session.user.email || session.user.id}</p>
      <section aria-label="自由交接设置">
        <style>{`.context-page .handover-free-toggle{display:inline-flex;align-items:center;gap:12px;position:relative;font-weight:600}.handover-free-toggle input{position:absolute;left:0;top:0;width:44px;height:26px;opacity:0;margin:0;z-index:1;cursor:pointer}.handover-free-track{display:inline-block;width:44px;height:26px;border-radius:14px;background:#c8c8ce;padding:3px;box-sizing:border-box}.handover-free-track::after{content:"";display:block;width:20px;height:20px;background:#fff;border-radius:50%;box-shadow:0 1px 3px #0002;transition:transform .12s}.handover-free-toggle input:checked+.handover-free-track{background:#f47a36}.handover-free-toggle input:checked+.handover-free-track::after{transform:translateX(18px)}.handover-free-toggle input:focus-visible+.handover-free-track{outline:2px solid #bf520b;outline-offset:3px}.handover-free-toggle input:disabled{cursor:default}.handover-free-toggle input:disabled+.handover-free-track{opacity:.55}@media(prefers-reduced-motion:reduce){.handover-free-track::after{transition:none}}`}</style>
        {handoverSetting ? <label className="handover-free-toggle"><input type="checkbox" role="switch" aria-label="自由交接"
          checked={handoverSetting.enabled} disabled={working}
          onChange={event => void changeHandoverSetting(event.target.checked)} /><span className="handover-free-track" aria-hidden="true" /><span>自由交接</span></label>
          : <p role="status">自由交接：设置读取中，当前无法修改。</p>}
        <p className="context-muted">默认开启。允许已获授权的 Agent 通过 BeamingFace 直接交接认领，无需你复制钥匙。关闭后，新的自动交接会被服务拒绝。</p>
        {handoverSetting && !handoverSetting.available && <p role="status">自由交接尚未开放，设置会在开放后生效。</p>}
      </section>
      {pendingHandover && <section aria-label="交接处理中" role="status">
        <h2>交接处理中</h2><p>正在撤销旧会话的执行准入，完成后会显示交接文字。</p>
        <button type="button" disabled={working} onClick={() => void collectHandover()}>检查交接状态</button>
      </section>}
      {handed && <section aria-label="交接文字" role="status"><h2>交接文字（只显示这一次）</h2>
        <p>把下面整段贴给新会话。离开或刷新本页后不会再显示；交给错了就再交接一次，这段会作废。</p>
        <pre>{handoverText(handed.claim, handed.lease_key, handed.receipt_id)}</pre>
        <button type="button" onClick={() => void copy(handoverText(handed.claim, handed.lease_key, handed.receipt_id))}>复制交接文字</button>
        <button type="button" onClick={() => setHanded(null)}>我已交给新会话，关闭</button>
      </section>}
      {issued && <section aria-label="交接预览"><h2>确认交给新会话</h2>
        <p>任务：{text(issued.view.task_title)}（{shortId(issued.view.task_id)}）</p>
        <p>现在的持有者：{text(issued.view.holder_name)}{text(issued.view.holder_vendor) && "（" + text(issued.view.holder_vendor) + "）"}
          {text(issued.view.holder_label) && " · 自报：" + text(issued.view.holder_label)}</p>
        <p>交接会更换钥匙并撤销旧会话的执行准入。服务确认旧准入已撤销后，才会交付新钥匙；钥匙只显示一次。认领编号保持不变。</p>
        <p>预览有效期至 {new Date(issued.expires_at).toLocaleTimeString()}。</p>
        <button type="button" disabled={working} onClick={() => void confirm()}>确认交接</button>
        <button type="button" disabled={working} onClick={() => setIssued(null)}>取消</button>
      </section>}
      <section aria-label="进行中的认领"><h2>进行中的认领</h2>
        {claims === null ? <p role="status">正在读取…</p> : claims.length === 0 ? <p className="context-muted">目前没有进行中的认领。</p>
          : claims.map(claim => claimRow(claim, now,
            claim.handover_available === true ? () => void preview(text(claim.claim_id)) : null, working || handed !== null))}
      </section>
      <label><input type="checkbox" checked={showEnded} disabled={working}
        onChange={event => { setShowEnded(event.target.checked); void load(event.target.checked); }} /> 显示最近 {ENDED_HOURS} 小时结束的认领</label>
      {showEnded && <section aria-label="最近结束的认领"><h2>最近 {ENDED_HOURS} 小时结束的认领</h2>
        {ended.length === 0 ? <p className="context-muted">没有。</p>
          : ended.map(claim => claimRow(claim, now, null, working))}
      </section>}
      <button type="button" disabled={working} onClick={() => void load()}>刷新</button>
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </main>;
}

// One claim, one block: who (client, connection, session), on what (Task and
// scope), since when and until when, how far, and what it may change. Every
// field the Agent reported about itself is marked as self-reported.
function claimRow(claim: Json, now: number, onHandover: (() => void) | null, working: boolean) {
  const pull = pullUrl(claim.bound_pr);
  const link = sessionUrl(claim.holder_session_url);
  const ref = text(claim.holder_session_ref);
  const codex = /codex/i.test(text(claim.holder_client) + " " + text(claim.holder_vendor)) && ref && !link;
  const state = text(claim.state) || text(claim.status);
  const live = state === "ACTIVE" || state === "DRAINING";
  const renewals = Number.isInteger(claim.renewals) ? String(claim.renewals) : "?";
  const maxRenewals = Number.isInteger(claim.max_renewals) ? String(claim.max_renewals) : "?";
  const task = taskUrl(claim.task_id);
  return <div key={text(claim.claim_id)} className="owner-grant">
    <dl>
      <dt>Agent</dt><dd>{text(claim.holder_client) ? <>{text(claim.holder_client)} <span className="context-muted">（Agent 自报）</span></> : <span className="context-muted">客户端未报</span>}
        {" · 连接 "}{text(claim.holder_name)}{text(claim.holder_vendor) && "（" + text(claim.holder_vendor) + "）"}{claim.holder_connection_live === false && " · 连接已断开"}</dd>
      <dt>会话</dt><dd>{text(claim.holder_session_title) ? <>{text(claim.holder_session_title)} <span className="context-muted">（Agent 自报）</span></> : <span className="context-muted">标题未报</span>}
        {" · "}{link ? <a href={link} target="_blank" rel="noreferrer">打开会话 {ref}</a> : ref ? <code>{ref}</code> : <span className="context-muted">会话 ID 未报</span>}
        {codex && <>{" · "}<code>codex resume {ref}</code></>}</dd>
      <dt>在做什么</dt><dd>{text(claim.holder_label) ? <>{text(claim.holder_label)} <span className="context-muted">（Agent 自报）</span></> : <span className="context-muted">（Agent 没有填标签）</span>}</dd>
      <dt>任务</dt><dd>{text(claim.task_title) || "（无标题）"} {task ? <Link href={task}><code>{text(claim.task_id)}</code></Link> : <code>{text(claim.task_id)}</code>} · {text(claim.context_key)}</dd>
      <dt>认领</dt><dd><code>{text(claim.claim_id)}</code> · fence {String(claim.fence)}{claim.lease_key_required === true && " · 已交接过，续租必须带钥匙"}</dd>
      <dt>状态</dt><dd>{claim.execution_handover_pending === true ? "交接处理中" : STATES[state] ?? state}{state === "RELEASED" && text(claim.released_outcome) && "（" + (OUTCOMES[text(claim.released_outcome)] ?? text(claim.released_outcome)) + "）"}
        {!live && text(claim.ended_at) && " · 结束于 " + beijing(claim.ended_at)}</dd>
      <dt>领取</dt><dd>{beijing(claim.issued_at)}</dd>
      <dt>到期</dt><dd>{beijing(claim.expires_at)}{live && " · " + remaining(claim.expires_at, now)}</dd>
      <dt>最晚到期</dt><dd>{beijing(claim.hard_deadline_at)}</dd>
      <dt>续期</dt><dd>{renewals} / {maxRenewals} 次{text(claim.progress_ref) && <> · 最近进展 <code>{text(claim.progress_ref)}</code></>}</dd>
      <dt>关联 PR</dt><dd>{pull ? <a href={pull} target="_blank" rel="noreferrer">{text(claim.bound_pr)}</a> : text(claim.bound_pr) ? <code>{text(claim.bound_pr)}</code> : <span className="context-muted">无</span>}</dd>
      <dt>触发来源</dt><dd>{list(claim.trigger_refs).length ? list(claim.trigger_refs).map(item => <code key={item}>{item} </code>) : <span className="context-muted">无</span>}</dd>
      <dt>改动范围</dt><dd><ul>{list(claim.write_set).map(item => <li key={item}><code>{item}</code></li>)}</ul></dd>
    </dl>
    {onHandover && <div className="owner-actions"><button type="button" disabled={working} onClick={onHandover}>交给新会话</button></div>}
    <hr />
  </div>;
}
