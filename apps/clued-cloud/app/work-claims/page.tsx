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
// then the handover itself, which moves the fence (the old session is refused
// from then on), rotates the lease key and shows the new key once, here only.
// All RPCs run as this signed-in account session; Bindings and delegated OAuth
// tokens are refused by the database.
type Json = Record<string, unknown>;
type Issued = { claim_id: string; confirmation_token: string; view_digest: string; expires_at: string; view: Json };
type Handed = { claim: Json; lease_key: string; receipt_id: string };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const MESSAGES: Record<string, string> = {
  direct_human_session_required: "需要你本人直接登录 Clued，授权给应用的登录不能查看或交接认领。",
  confirmation_token_session_id_required: "当前登录缺少会话信息，请退出后重新登录。",
  work_claim_not_found: "找不到这条认领。",
  work_claim_not_active: "这条认领已经结束或过期，不能交接。",
  work_claim_handover_unavailable: "这条认领是旧版本签发的，没有钥匙，不能交接。等它过期后由新会话接管即可。",
  confirmation_token_expired: "确认已超过 5 分钟有效期，请重新点“交给新会话”。",
  confirmation_token_reused: "这次确认已经用过，请重新点“交给新会话”。",
  confirmation_token_revoked: "这次确认已被新的预览取代，请使用最新的预览。",
  confirmation_token_binding_mismatch: "确认与当前登录会话或预览内容不一致，请重新开始。",
  confirmation_view_stale: "认领在两步之间被改过（范围或持有者变了），请重新点“交给新会话”。",
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
const shortId = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-/i.test(value) ? value.slice(0, 8).toLowerCase() : "";
// "owner/repo#123" → its GitHub page; anything else is shown as text.
function pullUrl(ref: unknown) {
  const match = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#([0-9]{1,10})$/.exec(text(ref));
  return match ? "https://github.com/" + match[1] + "/" + match[2] + "/pull/" + match[3] : null;
}
// Only a claude.ai Code session link from the server is followed.
const sessionUrl = (value: unknown) => /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{8,64}$/.test(text(value)) ? text(value) : null;

function handoverText(claim: Json, key: string, receiptId: string) {
  return [
    "请接手这份 Clued 工作认领（Owner 在 Clued 网页上交给你的；钥匙只给你，不要外传）。",
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
  const [issued, setIssued] = useState<Issued | null>(null);
  const [handed, setHanded] = useState<Handed | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const current = useRef<Session | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    const lifetime = epoch;
    let disposed = false;
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (disposed) return;
      const changed = current.current?.user.id !== next?.user.id;
      current.current = next; setSession(next); setReady(true);
      if (!changed) return;
      ++epoch.current;
      setClaims(null); setIssued(null); setHanded(null); setError(""); setNotice(""); setWorking(false);
    });
    return () => { disposed = true; ++lifetime.current; data.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (session) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  async function load() {
    const generation = epoch.current;
    setWorking(true); setError("");
    try {
      const value = await rpc("clued_work_claims_owner_list_v1", {});
      if (epoch.current !== generation) return;
      setClaims(Array.isArray(value.claims) ? value.claims.filter(object) : []);
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法读取认领。");
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
    <header><Link href="/">Clued</Link> <Link href="/grants">我的授权</Link> <Link href="/work-claims/race">多份模式</Link></header>
    <h1>谁在做哪个任务</h1>
    <p className="context-muted">这里列出你名下所有正在进行的认领。“标签”是 Agent 自己报的，Clued 无法核实。某个会话卡住时，可以把它的认领“交给新会话”：原会话立即失效，新会话凭这里显示一次的交接文字接着干。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 Clued</Link> 后查看认领。</p> : <>
      <p className="context-muted">已登录 {session.user.email || session.user.id}</p>
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
        <p>交接后：原会话的续租和释放都会被拒绝（它拿不到新钥匙）；新钥匙只显示一次；之后每次续租和释放都必须带钥匙。认领编号不变，PR 里的认领标记不用改。</p>
        <p>预览有效期至 {new Date(issued.expires_at).toLocaleTimeString()}。</p>
        <button type="button" disabled={working} onClick={() => void confirm()}>确认交接</button>
        <button type="button" disabled={working} onClick={() => setIssued(null)}>取消</button>
      </section>}
      <section aria-label="进行中的认领"><h2>进行中的认领</h2>
        {claims === null ? <p role="status">正在读取…</p> : claims.length === 0 ? <p className="context-muted">目前没有进行中的认领。</p>
          : claims.map(claim => {
            const pull = pullUrl(claim.bound_pr);
            const link = sessionUrl(claim.holder_session_url);
            return <div key={text(claim.claim_id)} className="owner-grant">
              <dl>
                <dt>任务</dt><dd>{text(claim.task_title) || "（无标题）"} <code>{shortId(claim.task_id)}</code></dd>
                <dt>谁在做</dt><dd>{text(claim.holder_label) ? <>{text(claim.holder_label)} <span className="context-muted">（Agent 自报）</span></> : <span className="context-muted">（Agent 没有填标签）</span>}</dd>
                <dt>连接</dt><dd>{text(claim.holder_name)}{text(claim.holder_vendor) && "（" + text(claim.holder_vendor) + "）"}{claim.holder_connection_live === false && " · 已断开"}</dd>
                <dt>会话</dt><dd>{link ? <a href={link} target="_blank" rel="noreferrer">打开会话</a>
                  : text(claim.holder_session_ref) ? <code>{text(claim.holder_session_ref)}</code> : <span className="context-muted">未报</span>}</dd>
                <dt>到期</dt><dd>{remaining(claim.expires_at, now)}{claim.status === "DRAINING" && " · 收尾中"}</dd>
                <dt>关联 PR</dt><dd>{pull ? <a href={pull} target="_blank" rel="noreferrer">{text(claim.bound_pr)}</a> : <span className="context-muted">无</span>}</dd>
                <dt>编号</dt><dd><code>认领 {shortId(claim.claim_id)}</code> · fence {String(claim.fence)}{claim.lease_key_required === true && " · 已交接过，续租必须带钥匙"}</dd>
              </dl>
              {claim.handover_available === true && <div className="owner-actions">
                <button type="button" disabled={working} onClick={() => void preview(text(claim.claim_id))}>交给新会话</button></div>}
              <hr />
            </div>;
          })}
      </section>
      <button type="button" disabled={working} onClick={() => void load()}>刷新</button>
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </main>;
}
