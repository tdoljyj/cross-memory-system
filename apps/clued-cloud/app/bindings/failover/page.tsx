"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../../supabase-browser";
import "../../contexts/contexts.css";
import "../../confirm/owner.css";

// Automatic ci-admission takeover (merge train step 2b, migration
// 20261031090000, DESIGN.md §41.6a, Task a3701d3d). The Owner marks which
// resident-node connections may take over CI admission automatically, in
// which order, and turns the master switch on or off. Every change is the
// Native two-step confirmation: Clued renders the change and issues a
// single-use token; "确认" commits exactly that. The page also shows each
// node's latest heartbeat and self-report, the watchdog's last run, and the
// recent alerts and automatic handovers.
type Json = Record<string, unknown>;
type Pending = { confirmation_token: string; view_digest: string; view: Json };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const objects = (value: unknown): Json[] => Array.isArray(value) ? value.filter(object) : [];
const MESSAGES: Record<string, string> = {
  direct_human_session_required: "需要你本人直接登录 BeamingFace，授权给应用的登录不能改这些设置。",
  confirmation_token_session_id_required: "当前登录缺少会话信息，请退出后重新登录。",
  resident_failover_input_invalid: "请求不完整，请刷新页面。",
  resident_failover_unchanged: "设置已经是这样了，请刷新页面。",
  resident_failover_version_conflict: "设置刚被改过，请刷新页面后再操作。",
  resident_failover_binding_invalid: "名单里有连接已撤销、已过期或不属于当前账号，请刷新页面。",
  resident_failover_scope_missing: "名单里有连接缺少 context:read 权限，不能当常驻节点。",
  resident_failover_purpose_invalid: "停车位和“其他”用途的连接不是常驻节点，不能自动接班。",
  resident_failover_heartbeat_holds_role: "这个连接持有 CI 准入（包括停车位和“其他”用途），不能当心跳连接。",
  resident_failover_heartbeat_is_node: "这个连接是某个节点的 CI 连接，不能再当心跳连接。",
  resident_failover_heartbeat_linked: "这个心跳连接已经挂在另一个节点上，请先解除。",
  resident_failover_heartbeat_not_linked: "这个连接现在没有挂靠，请刷新页面。",
  resident_failover_node_invalid: "这个节点的 CI 连接已失效或还没有登记节点，请刷新页面。",
  confirmation_token_expired: "确认已超过 5 分钟有效期，请重新点一次。",
  confirmation_token_revoked: "确认已被更新的操作取代，请按页面当前内容操作。",
  confirmation_token_reused: "这个确认已经用过了，请刷新页面。",
  confirmation_token_binding_mismatch: "确认要在发起它的同一次登录里完成，请重新点一次。",
  confirmation_view_stale: "设置或连接在你查看后发生了变化，请刷新页面后重试。",
};
// Why a marked connection cannot take over right now, in plain words.
const REASONS: Record<string, string> = {
  connection_unavailable: "连接已失效",
  holds_role: "已经持有 CI 准入",
  heartbeat_stale: "20 分钟内没有心跳",
  not_standby: "不是备用状态",
  probe_not_clear: "最近一次探测没有确认自己不持有",
  state_halted: "已停机（HALT）",
  state_paused: "已暂停（PAUSE）",
  state_intake_paused: "暂停接新中",
  state_unknown: "报不出状态",
  service_not_running: "服务没在运行或状态太旧",
  source_unknown: "没有报 Source",
  source_differs_from_holder: "Source 与当前持有者不同",
  source_differs: "Source 与其他常驻节点不同",
  cooldown: "6 小时内刚交出过 CI 准入",
  auto_handed_out: "被自动交出过，要等你手动移交一次才会再被选",
  too_few_heartbeats: "持有者失联期间心跳不到 2 次",
};
const ALERTS: Record<string, string> = {
  holder_never_heartbeated: "当前持有者在标资格（或打开总开关）之后还没发过心跳，所以不会自动接班",
  receiver_not_alive: "当前持有者失联，但备用节点这段时间也只到了不到 2 次心跳（可能是服务端或网络中断），所以没有交接",
  switch_off: "当前持有者失联，有可接班的节点，但总开关关着，所以没有交接",
  handover_refused: "交接时服务端核对没通过，没有交接",
  watchdog_error: "看门狗这次运行出错",
};
const MODES: Record<string, string> = { ACTIVE: "当班", STANDBY: "备用", UNCERTAIN: "不确定" };
const STATES: Record<string, string> = { NORMAL: "正常", HALTED: "已停机", PAUSED: "已暂停", INTAKE_PAUSED: "暂停接新", UNKNOWN: "报不出状态" };
class RequestFailure extends Error {}

async function rpc(name: string, input: Json): Promise<Json> {
  let result: { data: unknown; error: { message?: string; code?: string } | null };
  try {
    result = await supabase.rpc(name, { p_input: input });
  } catch { throw new RequestFailure("网络请求未完成，请刷新后查看结果。"); }
  if (result.error) {
    const code = result.error.message ?? "";
    throw new RequestFailure(MESSAGES[code] ?? (result.error.code ? "请求被拒绝（" + code + "）。" : "网络请求未完成，请刷新后查看结果。"));
  }
  const value = result.data;
  if (!object(value)) throw new RequestFailure("服务返回了无法识别的结果。");
  if (value.status === "rejected" || value.status === "failed") {
    const code = typeof value.error_code === "string" ? value.error_code : String(value.status);
    throw new RequestFailure(MESSAGES[code] ?? "请求被拒绝（" + code + "）。");
  }
  return value;
}
const clock = (value: unknown) => {
  if (value === null || value === undefined || value === "") return "从来没有";
  const time = new Date(String(value));
  return Number.isNaN(time.getTime()) ? String(value) : time.toLocaleString("zh-CN", { hour12: false });
};
const label = (binding: Json | null | undefined) => String(binding?.agent_name ?? "（已删除的连接）")
  + (binding?.vendor ? "（" + String(binding.vendor) + "）" : "") + (binding?.live === false ? "，已失效" : "");
const ids = (list: Json[]) => list.map(item => String(item.binding_id));
const short = (value: unknown) => typeof value === "string" && value.length > 12 ? value.slice(0, 12) : String(value ?? "无");

export default function ResidentFailoverPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<Json | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const current = useRef<Session | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    const lifetime = epoch;
    let disposed = false;
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      if (disposed) return;
      const changed = current.current?.user.id !== next?.user.id;
      current.current = next; setSession(next); setReady(true);
      if (!changed) return;
      ++epoch.current;
      setData(null); setPending(null); setError(""); setNotice(""); setWorking(false);
    });
    return () => { disposed = true; ++lifetime.current; listener.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (session) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  // A reload after a failed confirmation keeps its message on screen.
  async function load(clear = true) {
    const generation = epoch.current;
    setWorking(true); if (clear) setError("");
    try {
      const value = await rpc("clued_resident_failover_v1", {});
      if (epoch.current === generation) setData(value);
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法读取设置。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  const setting = object(data?.setting) ? data.setting : null;
  const version = Number(setting?.version ?? 0);
  const members = objects(data?.members);

  // Step 1: Clued renders the change and issues a token for exactly that.
  async function issue(input: Json) {
    if (!current.current || working) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setNotice(""); setPending(null);
    try {
      const value = await rpc("clued_resident_failover_confirmation_issue_v1", { ...input, base_version: version });
      if (epoch.current !== generation) return;
      if (value.status !== "issued" || typeof value.confirmation_token !== "string" || typeof value.view_digest !== "string"
        || !object(value.confirmation_view)) throw new RequestFailure("确认内容不完整，请刷新页面。");
      setPending({ confirmation_token: value.confirmation_token, view_digest: value.view_digest, view: value.confirmation_view });
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法生成确认。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }
  const askMembers = (list: string[]) => issue({ change: "members", members: list });
  const askSwitch = (enabled: boolean) => issue({ change: "switch", enabled });
  const askLink = (heartbeat: string, node: string) =>
    issue({ change: "heartbeat_link", heartbeat_binding_id: heartbeat, node_binding_id: node });
  const askUnlink = (heartbeat: string) => issue({ change: "heartbeat_unlink", heartbeat_binding_id: heartbeat });
  const move = (index: number, by: number) => {
    const list = ids(members);
    const other = index + by;
    if (other < 0 || other >= list.length) return;
    [list[index], list[other]] = [list[other], list[index]];
    void askMembers(list);
  };

  // Step 2: commit exactly the view on screen.
  async function confirm() {
    if (!current.current || working || !pending) return;
    const generation = epoch.current;
    const target = pending;
    let failed = false;
    setWorking(true); setError("");
    try {
      const result = await rpc("clued_resident_failover_set_v1",
        { confirmation_token: target.confirmation_token, view_digest: target.view_digest });
      if (epoch.current !== generation) return;
      setPending(null);
      if (target.view.change === "switch") setNotice(result.enabled === true
        ? "已打开自动接班总开关。持有者失联 30 分钟后，看门狗会按次序把 CI 准入交给第一个健康的节点。"
        : "已关闭自动接班总开关。看门狗照常检查和提醒，但不会交接。");
      else if (target.view.change === "heartbeat_link") setNotice("已挂靠：" + label(object(target.view.heartbeat) ? target.view.heartbeat : null)
        + " 发的心跳记到节点 " + label(object(target.view.node) ? target.view.node : null) + "。")
      else if (target.view.change === "heartbeat_unlink") setNotice("已解除：" + label(object(target.view.heartbeat) ? target.view.heartbeat : null)
        + " 发的心跳不再被接受。")
      else setNotice("已保存可自动接班的节点和次序。");
    } catch (failure) {
      failed = true;
      if (epoch.current === generation) { setPending(null); setError(failure instanceof RequestFailure ? failure.message : "结果未知，请刷新页面核对。"); }
    } finally { if (epoch.current === generation) setWorking(false); }
    if (epoch.current === generation) await load(!failed);
  }

  // A connection id is a public identifier; copying it needs no confirmation.
  async function copy(bindingId: string) {
    setError(""); setNotice("");
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard) throw new Error("clipboard");
      await navigator.clipboard.writeText(bindingId);
      setNotice("已复制连接编号 " + bindingId + "。");
    } catch { setError("浏览器没有允许复制，请手动选中编号复制。"); }
  }

  const view = pending?.view ?? null;
  const memberIds = ids(members);
  const holders = objects(data?.holders);
  const resident = holders.find(h => h.purpose === "resident-node" || h.purpose === "unspecified") ?? null;
  const candidates = objects(data?.connections).filter(c => !memberIds.includes(String(c.binding_id))
    && c.purpose !== "parking" && c.purpose !== "other");
  const nodes = objects(data?.nodes);
  const watchdog = object(data?.watchdog) ? data.watchdog : null;
  const alerts = objects(data?.alerts);
  const allBindings = objects(data?.bindings);
  const nodeBindings = allBindings.filter(b => b.is_node === true);
  const find = (id: unknown) => [...members, ...nodes, ...objects(data?.connections)].find(b => String(b.binding_id) === String(id)) ?? null;
  const nameOf = (id: unknown) => {
    const found = [...members, ...nodes, ...objects(data?.connections)].find(b => String(b.binding_id) === String(id));
    return found ? String(found.agent_name ?? id) : String(id ?? "");
  };
  const busy = working || !!pending;
  const describeAlert = (alert: Json) => {
    if (alert.receipt_kind === "CI_ADMISSION_AUTO_HANDOVER") return "已自动把 CI 准入从 " + nameOf(alert.from_binding_id) + " 移交给 "
      + nameOf(alert.to_binding_id) + "（" + (alert.trigger === "service_not_running" ? "服务连续 30 分钟没在运行"
        : alert.trigger === "connection_unavailable" ? "它的 CI 连接已失效" : "失联 30 分钟")
      + "），" + clock(alert.effective_at) + " 起生效。";
    if (alert.receipt_kind === "CI_ADMISSION_FAILOVER_NO_TARGET") return "当前持有者 " + nameOf(alert.holder)
      + " 失联，但没有可以接班的节点，没有交接，请你处理。";
    return (ALERTS[String(alert.reason)] ?? "提醒（" + String(alert.reason ?? "") + "）") + "。";
  };
  const listView = (list: unknown) => objects(list).map(m => String(m.rank) + ". " + label(m)).join("；") || "（空）";

  return <main className="context-page owner-confirm">
    <header><Link href="/">BeamingFace</Link> <Link href="/bindings">专用 Binding</Link></header>
    <h1>CI 准入自动接班</h1>
    <p className="context-muted">持有 CI 准入的常驻节点失联 30 分钟（或连续 30 分钟报“服务没在运行”）时，服务端的看门狗按你排的次序，把 CI 准入交给第一个健康的备用节点，交接 5 分钟后生效。只有你在这里列出的连接才会被选中；总开关关着时只提醒、不交接。停机、暂停或暂停接新的持有者永远不会被自动交出。</p>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 BeamingFace</Link> 后管理自动接班。</p> : <>
      <p className="context-muted">已登录 {session.user.email || session.user.id}</p>
      {view && <section aria-label="确认更改" className="owner-note"><h2>确认更改</h2>
        <p className="context-muted">以下内容由 BeamingFace 生成。</p>
        {view.change === "switch" ? <dl>
          <dt>总开关</dt><dd>{view.enabled ? "打开：持有者失联时自动交接" : "关闭：只提醒，不交接"}</dd>
          <dt>可自动接班的节点</dt><dd>{listView(view.members)}</dd>
        </dl> : view.change === "heartbeat_link" ? <dl>
          <dt>心跳连接</dt><dd>{label(object(view.heartbeat) ? view.heartbeat : null)}：以后只能发心跳，不能做 CI 准入</dd>
          <dt>记到节点</dt><dd>{label(object(view.node) ? view.node : null)}</dd>
          {object(view.replaces) && <><dt>替换</dt><dd>{label(view.replaces)}（它发的心跳不再被接受）</dd></>}
        </dl> : view.change === "heartbeat_unlink" ? <dl>
          <dt>解除心跳连接</dt><dd>{label(object(view.heartbeat) ? view.heartbeat : null)}（它发的心跳不再被接受）</dd>
          <dt>原来记到节点</dt><dd>{label(object(view.node) ? view.node : null)}</dd>
        </dl> : <dl>
          <dt>改之前</dt><dd>{listView(view.members_before)}</dd>
          <dt>改之后</dt><dd>{listView(view.members)}</dd>
          {objects(view.removed).length > 0 && <><dt>取消资格</dt><dd>{objects(view.removed).map(label).join("、")}（以后不会被自动选中）</dd></>}
        </dl>}
        <div className="owner-actions">
          <button type="button" disabled={working} onClick={() => void confirm()}>确认</button>
          <button type="button" disabled={working} onClick={() => setPending(null)}>取消</button>
        </div></section>}
      {data === null ? <p role="status">正在读取…</p> : <>
        <section aria-label="总开关"><h2>总开关</h2>
          <p>{setting?.enabled ? "开着（" + clock(setting.enabled_at) + " 打开）" : "关着"}</p>
          <button type="button" disabled={busy} onClick={() => void askSwitch(!setting?.enabled)}>
            {setting?.enabled ? "关闭自动接班…" : "打开自动接班…"}</button>
        </section>
        <section aria-label="看门狗"><h2>看门狗</h2>
          <p>最近一次运行：{clock(watchdog?.last_tick_at)}</p>
          {watchdog?.stale !== false && <p role="alert">看门狗超过 5 分钟没有运行，自动接班现在不会发生。</p>}
          <p className="context-muted">当前持有 CI 准入的常驻节点：{resident ? label(find(resident.binding_id) ?? resident) : "无"}</p>
        </section>
        <section aria-label="可自动接班的节点"><h2>可自动接班的节点（按次序）</h2>
          {members.length === 0 ? <p className="context-muted">还没有列出任何连接，自动接班不会选中任何节点。</p>
            : members.map((member, index) => <div key={String(member.binding_id)} className="owner-grant">
              <p>{String(member.rank)}. {label(member)}</p>
              <div className="context-row">
                <button type="button" disabled={busy || index === 0} onClick={() => move(index, -1)}>上移</button>
                <button type="button" disabled={busy || index === members.length - 1} onClick={() => move(index, 1)}>下移</button>
                <button type="button" disabled={busy}
                  onClick={() => void askMembers(memberIds.filter(id => id !== String(member.binding_id)))}>取消资格</button>
              </div></div>)}
          {candidates.length > 0 && <div className="context-row">{candidates.map(candidate =>
            <button key={String(candidate.binding_id)} type="button" disabled={busy}
              onClick={() => void askMembers([...memberIds, String(candidate.binding_id)])}>{"加入：" + label(candidate)}</button>)}</div>}
        </section>
        <section aria-label="各节点心跳"><h2>各节点心跳</h2>
          {nodes.length === 0 ? <p className="context-muted">还没有节点发过心跳。</p> : nodes.map(entry => {
            const node = object(entry.node) ? entry.node : null;
            const halt = node && object(node.halt) ? node.halt : null;
            return <div key={String(entry.binding_id)} className="owner-grant"><dl>
              <dt>连接</dt><dd>{label(entry)}{entry.rank ? "，次序 " + String(entry.rank) : "，没有自动接班资格"}</dd>
              {!node ? <><dt>节点</dt><dd>这个连接还没有登记节点，发不了心跳。</dd></> : <>
                <dt>节点</dt><dd>{String(node.name ?? "")}</dd>
                <dt>最近心跳</dt><dd>{clock(node.last_heartbeat_at)}{node.heartbeat_via_link === true
                  ? "（来自挂靠的心跳连接 " + String(node.heartbeat_from_agent_name ?? node.heartbeat_from_binding_id ?? "") + "）" : ""}</dd>
                <dt>自报</dt><dd>{(MODES[String(node.mode)] ?? "模式未知") + "，" + (STATES[String(node.state)] ?? "状态未知")
                  + (node.state === "INTAKE_PAUSED" ? "（到 " + clock(node.intake_paused_until) + "）" : "")
                  + (node.state === "UNKNOWN" && node.readable_state ? "，之前最近一次：" + (STATES[String(node.readable_state)] ?? "") : "")}</dd>
                {node.state === "HALTED" && halt && <><dt>停机详情</dt><dd>{"原因 " + String(halt.code ?? "未知")
                  + (halt.at ? "，" + clock(halt.at) + " 停机" : "") + (halt.pr ? "，出事的 PR " + String(halt.pr) : "")
                  + (halt.head ? "，head " + short(halt.head) : "")}</dd></>}
                <dt>服务</dt><dd>{node.service_running === false ? "没在运行" : node.service_running === true ? "在运行" : "未知"}
                  {typeof node.snapshot_age_seconds === "number" ? "，状态快照 " + Math.round(node.snapshot_age_seconds / 60) + " 分钟前" : ""}</dd>
                <dt>Source</dt><dd>{short(node.ci_source_manifest_sha256)}</dd>
              </>}
            </dl></div>;
          })}
        </section>
        <section aria-label="连接编号"><h2>连接编号</h2>
          <p className="context-muted">装心跳连接时，把这个编号填给安装脚本的 -HeartbeatBindingId。</p>
          {allBindings.length === 0 ? <p className="context-muted">目前没有有效的连接。</p>
            : <ul>{allBindings.map(binding => {
              const id = String(binding.binding_id);
              const link = object(binding.heartbeat_for) ? binding.heartbeat_for : null;
              // A connection can carry heartbeats when it is not a node, holds no CI admission and can read.
              const canLink = !link && binding.is_node !== true && !binding.purpose
                && Array.isArray(binding.scopes) && binding.scopes.includes("context:read");
              return <li key={id}>{label(binding)}：<code style={{ fontFamily: "monospace" }}>{id}</code>{" "}
                <button type="button" onClick={() => void copy(id)}>复制</button>
                {link ? "（心跳连接，挂靠到节点 " + String(link.node_agent_name ?? link.node_binding_id ?? "") + "）" : ""}
                {binding.is_node === true ? "（节点的 CI 连接）" : ""}
                {link && <button type="button" disabled={busy} onClick={() => void askUnlink(id)}>解除心跳挂靠…</button>}
                {canLink && nodeBindings.map(node => <button key={String(node.binding_id)} type="button" disabled={busy}
                  onClick={() => void askLink(id, String(node.binding_id))}>{"挂为 " + String(node.agent_name ?? "") + " 的心跳连接…"}</button>)}</li>;
            })}</ul>}
        </section>
        <section aria-label="提醒"><h2>最近的提醒与自动交接</h2>
          {alerts.length === 0 ? <p className="context-muted">最近 7 天没有提醒。</p>
            : <ul>{alerts.map(alert => <li key={String(alert.receipt_id)}>{clock(alert.created_at)}：{describeAlert(alert)}
              {alert.receipt_kind !== "CI_ADMISSION_AUTO_HANDOVER" && objects(alert.candidates).length > 0 && <> 各节点：{objects(alert.candidates)
                .map(c => nameOf(c.binding_id) + "：" + (Array.isArray(c.reasons) && c.reasons.length
                  ? c.reasons.map(r => REASONS[String(r)] ?? String(r)).join("、") : "可以接班")).join("；")}</>}</li>)}</ul>}
        </section>
      </>}
      <button type="button" disabled={working} onClick={() => void load()}>刷新</button>
    </>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </main>;
}
