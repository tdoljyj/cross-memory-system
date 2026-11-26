"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../supabase-browser";
import "../contexts/contexts.css";
import "../confirm/owner.css";

// The account setting carries the version the page showed. The resident
// queue display is read independently from the merge slot list and setting.
type Json = Record<string, unknown>;
type Ordering = "fifo" | "priority";
type Setting = { ordering: Ordering; version: number; isDefault: boolean; updatedAt: string | null };
type Entry = { claimId: string; title: string; state: string; position: number; pr: string | null;
  holder: string | null; autoPriority: number | null };
type Queue = { ref: string; entries: Entry[] };
type View = { setting: Setting; queues: Queue[] };
type Timestamp = string | number | null;
type Pull = { pr: number; headSha: string | null };
type Pending = Pull & { position: number | null; since: Timestamp; holdText: string | null };
type Batch = Pull & { stage: number | null; stageName: string | null; since: Timestamp; stageSince: Timestamp };
type Stall = { code: string; level: "red" | "yellow"; since: Timestamp; text: string };
type NodeView = {
  node: {
    source: string | null; generation: number | null; consistent: boolean | null;
    upgrade: { state: string; phase: string | null; since: Timestamp } | null;
    selfcheck: { result: string; observedAt: Timestamp } | null;
  };
  executor: { state: string };
  current: Batch | null;
  pending: Pending[];
  unqueued: Pull[];
  train: { last: { at: Timestamp; mode: string | null; front: { pr: number } | null } | null };
  alerts: string[];
  stall: Stall | null;
};
type ResidentNode = {
  name: string; holder: boolean; silent: boolean; heartbeatAt: number; reportedMode: string | null;
  reportedState: string | null; viewReportedAt: number; view: NodeView | null;
};
type ResidentQueue = { observedAt: number; nodes: ResidentNode[] };
const object = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const MESSAGES: Record<string, string> = {
  direct_human_session_required: "需要你本人直接登录 BeamingFace，授权给应用的登录不能查看或切换合并顺序。",
  merge_queue_setting_session_required: "当前登录缺少会话信息，请退出后重新登录。",
  merge_queue_setting_version_conflict: "合并顺序在你打开页面后被改过，已显示最新状态，请确认后再切换。",
};
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

function parseSetting(value: unknown): Setting {
  if (!object(value) || (value.ordering !== "fifo" && value.ordering !== "priority") || typeof value.version !== "number")
    throw new RequestFailure("服务返回了无法识别的结果。");
  return { ordering: value.ordering, version: value.version, isDefault: value.default === true,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null };
}

function parseEntry(value: unknown): Entry {
  if (!object(value) || typeof value.claim_id !== "string" || typeof value.position !== "number")
    throw new RequestFailure("服务返回了无法识别的结果。");
  return { claimId: value.claim_id, title: typeof value.task_title === "string" ? value.task_title : "（没有标题的任务）",
    state: typeof value.state === "string" ? value.state : "", position: value.position,
    pr: typeof value.bound_pr === "string" ? value.bound_pr : null,
    holder: typeof value.holder_label === "string" ? value.holder_label : null,
    autoPriority: typeof value.auto_priority === "number" ? value.auto_priority : null };
}

function parseView(value: Json): View {
  if (!Array.isArray(value.queues)) throw new RequestFailure("服务返回了无法识别的结果。");
  return { setting: parseSetting(value.setting), queues: value.queues.map((queue) => {
    if (!object(queue) || typeof queue.ref !== "string" || !Array.isArray(queue.entries))
      throw new RequestFailure("服务返回了无法识别的结果。");
    return { ref: queue.ref, entries: queue.entries.map(parseEntry) };
  }) };
}

// merge:<owner>/<name>:<branch> in plain words.
function queueName(ref: string): string {
  const match = /^merge:([^:]+):(.+)$/.exec(ref);
  return match ? match[1] + " 的 " + match[2] + " 分支" : ref;
}

const ORDERING_TITLE: Record<Ordering, string> = { fifo: "按排队先后", priority: "按任务优先级" };
const MINUTE = 60_000;
const SHANGHAI_TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
// The resident view is for the fleet's configured repository and branch.
const RESIDENT_REF = "merge:tdoljyj/cross-memory-system:main";
const TRAIN_MODE: Record<string, string> = { on: "on", "revoke-only": "只撤不发", shadow: "影子" };
const HEARTBEAT_STATE: Record<string, string> = {
  NORMAL: "正常", HALTED: "已停止", PAUSED: "已暂停", INTAKE_PAUSED: "暂停接新单", UNKNOWN: "未知",
};
const EXECUTOR_STATE: Record<string, string> = {
  ...HEARTBEAT_STATE, STARTING: "启动中", IDLE: "空闲", RUNNING: "在跑", WAITING: "等待中", PARKED: "暂挂",
  DEFERRED: "已推迟", STOPPED: "已停止", BACKFILL_PENDING: "等待补跑",
};
const SELFCHECK: Record<string, string> = { PASS: "通过", FAIL: "未通过", STALE: "过期" };
const UPGRADING = new Set(["WAITING_GRANT", "WAITING_DRAIN", "DEFERRED", "RUNNING", "ROLLING_BACK"]);

function timestamp(value: unknown): number {
  return typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
}

function elapsed(at: number, now: number): string {
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / MINUTE)) + " 分钟" : "时长未知";
}

function timeLabel(at: number, now: number): string {
  return Number.isFinite(at) ? SHANGHAI_TIME.format(at) + "（" + elapsed(at, now) + "前）" : "时间未知";
}

function parseResidentQueue(value: Json): ResidentQueue {
  const observedAt = timestamp(value.observed_at);
  if (!Number.isFinite(observedAt) || !Array.isArray(value.nodes))
    throw new RequestFailure("服务返回了无法识别的节点状态。");

  const nodes = value.nodes.map((node: unknown): ResidentNode => {
    if (!object(node) || typeof node.holder !== "boolean" || typeof node.silent !== "boolean")
      throw new RequestFailure("服务返回了无法识别的节点状态。");
    const name = node.name ?? node.node_name;
    const view = node.view;
    if (typeof name !== "string" || (view !== null && (!object(view) || view.contract !== "clued.merge-queue-node-view/1"
      || !object(view.node) || !object(view.executor) || !object(view.train)
      || !Array.isArray(view.pending) || !Array.isArray(view.unqueued) || !Array.isArray(view.alerts))))
      throw new RequestFailure("服务返回了无法识别的节点状态。");
    return {
      name, holder: node.holder, silent: node.silent, heartbeatAt: timestamp(node.last_heartbeat_at),
      reportedMode: typeof node.reported_mode === "string" ? node.reported_mode : null,
      reportedState: typeof node.reported_state === "string" ? node.reported_state : null,
      viewReportedAt: timestamp(node.view_reported_at), view: view as NodeView | null,
    };
  });
  return { observedAt, nodes };
}

function stageLabel(batch: Batch) {
  return batch.stage === null ? "段位未知" : "第 " + batch.stage + " 段";
}

const pullLabel = (pull: Pull) => "PR #" + pull.pr + (pull.headSha ? "（提交 " + pull.headSha.slice(0, 8) + "）" : "");

const reportsActive = (node: ResidentNode) => !node.silent && Number.isFinite(node.heartbeatAt) && node.reportedMode === "ACTIVE";

function renderNodeDetails(node: ResidentNode, now: number) {
  const facts = node.view?.node;
  const role = node.holder && reportsActive(node) ? "当班"
    : !node.silent && node.reportedMode === "STANDBY" ? "备用" : "角色不确定";
  const heartbeat = Number.isFinite(node.heartbeatAt) ? "心跳 " + timeLabel(node.heartbeatAt, now) : "尚无心跳";
  if (!facts) return <li key={node.name}>
    {node.name} · {role} · {heartbeat}
    {node.reportedState && " · 心跳报告" + (HEARTBEAT_STATE[node.reportedState] ?? node.reportedState)}
    {" · 这台节点还没有上报队列视图"}
  </li>;

  const { upgrade, selfcheck } = facts;
  const executor = node.view?.executor.state;
  return <li key={node.name}>
    {node.name} · {role}
    {facts.generation != null && " · 第 " + facts.generation + " 代"}
    {facts.source && "（Source " + facts.source.slice(0, 12) + "）"}
    {typeof facts.consistent === "boolean" && (facts.consistent ? " · 两侧版本一致" : " · 两侧版本不一致")}
    {selfcheck && " · 自检" + (SELFCHECK[selfcheck.result] ?? "未知") + "（" + timeLabel(timestamp(selfcheck.observedAt), now) + "）"}
    {" · "}{heartbeat}
    {executor && " · 执行器 " + (EXECUTOR_STATE[executor] ?? executor)}
    {upgrade && UPGRADING.has(upgrade.state.toUpperCase()) &&
      " · 升级中：" + (upgrade.phase ?? "等待阶段读数") + "（自 " + timeLabel(timestamp(upgrade.since), now) + "）"}
  </li>;
}

function renderResidentStatus(queue: ResidentQueue) {
  const { observedAt: now, nodes } = queue;
  const active = nodes.filter(reportsActive);
  const holders = active.filter(node => node.holder);
  const duty = holders.length === 1 ? holders[0] : null;
  const view = duty?.view ?? null;
  const batch = view?.current;
  const train = view?.train.last;
  const red: string[] = [];
  const yellow: string[] = [];
  for (const node of nodes) {
    if (node.silent) {
      red.push(Number.isFinite(node.heartbeatAt)
        ? "节点 " + node.name + " 已 " + elapsed(node.heartbeatAt, now) + "没有心跳"
        : "节点 " + node.name + " 没有心跳");
    } else if (node.view && now - node.viewReportedAt > 21 * MINUTE) {
      yellow.push(node.name + " 队列视图未更新，下面是 " + timeLabel(node.viewReportedAt, now) + "的旧读数");
    }
    const stall = node.view?.stall;
    if (stall) {
      const reason = stall.text + "（" + stall.code + "，自 " + timeLabel(timestamp(stall.since), now) + " 起）";
      if (stall.level === "red") red.push("卡住了：" + reason);
      if (stall.level === "yellow") yellow.push(reason);
    }
  }
  if (holders.length === 0) red.push("现在没有当班节点");
  if (active.length > 1) red.push("检测到双活：" + active.map(node => node.name).join("、") + " 都报告为当班");

  const pending = [...(view?.pending ?? [])].sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
  const notifications = nodes.flatMap(node => (node.view?.alerts ?? []).map(text => ({ name: node.name, text }))).slice(0, 10);
  return <>
    <section aria-label="常驻 CI 状态">
      {red.map((message, index) => <p key={index} role="alert" style={{ color: "#ffaaaa" }}>{message}</p>)}
      {yellow.map((message, index) => <p key={index} role="status" className="owner-warning">注意：{message}</p>)}
      {!red.length && !yellow.length && duty && <p role="status">
        运转正常：{duty.name} 当班，{batch ? "在跑 PR #" + batch.pr + " " + stageLabel(batch) : view ? "空闲" : "等待队列视图"}
      </p>}
    </section>
    {view && duty && <>
      <section aria-label="车头与在跑">
        <h2>{queueName(RESIDENT_REF)}</h2>
        <p>{train?.front ? "车头（持有合并位）：PR #" + train.front.pr : "现在没有车头"}</p>
        {train && <p className="context-muted">列车上次运行 {timeLabel(timestamp(train.at), now)}，模式 {TRAIN_MODE[train.mode ?? ""] ?? "未知"}</p>}
        <p>{batch
          ? <>正在跑：PR #{batch.pr} · {stageLabel(batch)}{batch.stageName && "（" + batch.stageName + "）"}
            {" · 本段已 "}{elapsed(timestamp(batch.stageSince), now)} · 本批已 {elapsed(timestamp(batch.since), now)} · 节点 {duty.name}</>
          : "现在没有批次在跑"}</p>
      </section>
      <section aria-label="排队">
        <h2>排队</h2>
        <p className="context-muted">顺序以当班节点本机队列为准</p>
        {pending.length ? <ol>
          {pending.map(row => <li key={row.pr + ":" + row.headSha}>
            {row.position == null ? "等候中" : "第 " + row.position + " 位"} · {pullLabel(row)}
            {" · 已等 "}{elapsed(timestamp(row.since), now)}{row.holdText && " · " + row.holdText}
          </li>)}
        </ol> : <p className="context-muted">现在没有 PR 在排队。</p>}
      </section>
      {view.unqueued.length > 0 && <section aria-label="还没入队的开放 PR">
        <h2>还没入队的开放 PR</h2>
        {view.stall && <p>{view.stall.text}</p>}
        <ul>{view.unqueued.map(pull => <li key={pull.pr + ":" + pull.headSha}>{pullLabel(pull)} · 节点还没有接它</li>)}</ul>
      </section>}
    </>}
    <section aria-label="节点">
      <h2>节点</h2>
      {nodes.length ? <ul>{nodes.map(node => renderNodeDetails(node, now))}</ul>
        : <p className="context-muted">没有节点读数。</p>}
    </section>
    {notifications.length > 0 && <section aria-label="节点通知">
      <h2>节点通知</h2>
      <ul>{notifications.map(({ name, text }, index) => <li key={name + ":" + index}>{name} · {text}</li>)}</ul>
    </section>}
  </>;
}

export default function MergeQueuePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [resident, setResident] = useState<ResidentQueue | "unavailable" | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const current = useRef<Session | null>(null);
  const epoch = useRef(0);
  const residentRequest = useRef<number | null>(null);

  useEffect(() => {
    const lifetime = epoch;
    let disposed = false;
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      if (disposed) return;
      const changed = current.current?.user.id !== next?.user.id;
      current.current = next; setSession(next); setReady(true);
      if (!changed) return;
      ++epoch.current;
      setView(null); setResident(null); setError(""); setNotice(""); setWorking(false);
    });
    return () => { disposed = true; ++lifetime.current; data.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (session) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  useEffect(() => {
    if (!session) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    function syncPolling() {
      clearInterval(timer);
      if (document.hidden) return;
      void loadResident();
      timer = setInterval(() => {
        if (!document.hidden) void loadResident();
      }, MINUTE);
    }
    syncPolling();
    document.addEventListener("visibilitychange", syncPolling);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", syncPolling);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  async function loadResident() {
    const generation = epoch.current;
    if (!current.current || residentRequest.current === generation) return;
    residentRequest.current = generation;
    try {
      const value = parseResidentQueue(await rpc("clued_merge_queue_resident_v1", {}));
      if (epoch.current === generation) setResident(value);
    } catch {
      if (epoch.current === generation) setResident("unavailable");
    } finally {
      if (residentRequest.current === generation) residentRequest.current = null;
    }
  }

  async function load(keepMessages = false) {
    const generation = epoch.current;
    setWorking(true);
    if (!keepMessages) { setError(""); setNotice(""); }
    try {
      const value = parseView(await rpc("clued_merge_queue_v1", {}));
      if (epoch.current === generation) setView(value);
    } catch (failure) {
      if (epoch.current === generation) setError(failure instanceof RequestFailure ? failure.message : "暂时无法读取合并排队。");
    } finally { if (epoch.current === generation) setWorking(false); }
  }

  async function turn(ordering: Ordering) {
    if (!current.current || working || !view) return;
    const generation = epoch.current;
    setWorking(true); setError(""); setNotice("");
    let reload = false;
    try {
      const value = await rpc("clued_merge_queue_ordering_set_v1", { ordering, base_version: view.setting.version });
      if (epoch.current !== generation) return;
      const setting = parseSetting(value);
      setView((previous) => previous ? { ...previous, setting } : previous);
      setNotice("已保存设置：" + ORDERING_TITLE[setting.ordering] + "。");
      reload = true;
    } catch (failure) {
      if (epoch.current !== generation) return;
      setError(failure instanceof RequestFailure ? failure.message : "结果未知，请刷新页面核对。");
      reload = true;
    } finally { if (epoch.current === generation) setWorking(false); }
    if (reload && epoch.current === generation) await load(true);
  }

  const setting = view?.setting ?? null;
  const other: Ordering = setting?.ordering === "priority" ? "fifo" : "priority";
  return <main className="context-page owner-confirm">
    <header><Link href="/">BeamingFace</Link> <Link href="/work-claims">谁在做哪个任务</Link> <Link href="/agent-messages">Agent 消息</Link></header>
    <h1>合并排队</h1>
    {!ready ? <p role="status">正在读取登录状态…</p> : !session ? <p><Link href="/">登录 BeamingFace</Link> 后管理合并排队。</p> : <>
      <p className="context-muted">已登录 {session.user.email || session.user.id}</p>
      {resident === null ? <p role="status">正在读取节点状态…</p>
        : resident === "unavailable" ? <p role="status">暂时读不到节点状态</p>
        : renderResidentStatus(resident)}
      <section aria-label="合并顺序" className="owner-note">
        <h2>合并顺序开关</h2>
        <p className="context-muted">现在切换不改变常驻 CI 的实际合并顺序，实际顺序以上面“排队”为准。</p>
        {setting === null ? <p role="status">{working ? "正在读取…" : "暂未读到合并顺序。"}</p> : <>
          <p>现在：<strong>{ORDERING_TITLE[setting.ordering]}</strong>{setting.isDefault ? "（默认）" : ""}</p>
          {setting.updatedAt && <p className="context-muted">上次更改：{timeLabel(timestamp(setting.updatedAt), Date.now())}</p>}
          <div className="owner-actions">
            <button type="button" disabled={working} onClick={() => void turn(other)}>改为{ORDERING_TITLE[other]}</button>
          </div>
        </>}
      </section>
      {view && <section aria-label="合并位队列">
        <h2>合并位队列</h2>
        {view.queues.length === 0 ? <p className="context-muted">现在没有 PR 持有或等待合并位。</p> : view.queues.map((queue) =>
          <div key={queue.ref}>
            <p><strong>{queueName(queue.ref)}</strong></p>
            <ol>
              {queue.entries.map((entry) => <li key={entry.claimId}>
                {entry.state === "head" ? "第一位，正在合并" : "第 " + entry.position + " 位，等候"}
                {" · "}{entry.title}
                {entry.pr ? " · 拉取请求 " + entry.pr : " · 还没有拉取请求"}
                {" · 自动优先级 "}{entry.autoPriority === null ? "无" : String(entry.autoPriority)}
                {entry.holder ? " · " + entry.holder : ""}
              </li>)}
            </ol>
          </div>)}
      </section>}
      <button type="button" disabled={working} onClick={() => { void load(); void loadResident(); }}>刷新</button>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </>}
  </main>;
}
