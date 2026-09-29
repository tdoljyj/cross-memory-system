"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "../../supabase-browser";
type Connection = { id: string; provider: string; state: string; version: number; profile_id: string };
type RecoveryView = { job_id: string; status: string; receipt_id: string };
const recoveryLabels: Record<string, string> = { queued: "已排队", prepared: "已准备", started: "已开始，结果待核对", uncertain: "结果待核对",
  committed: "已登记完成", cancelled: "已取消", denied: "已拒绝", attention_required: "需要核查" };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
type RefreshStatus = { enabled: boolean; version: number; connection_version: number; failures: number; pending: boolean; next_refresh_at: string | null };
const probeStages: Record<string, string> = { request: "请求验证", prepare: "账号与目录当前状态", descriptor: "目录配置", credential: "连接凭据与有效期",
  identity: "Google 账号身份", directories: "Google 目录元数据与权限", boundary: "父级与同级目录边界", receipt: "最终状态复核与回执" };
const probeReasons: Record<string, string> = { DIRECTORY_NOT_APP_AUTHORIZED: "至少一个已登记目录尚未向当前 Google 应用授权", DIRECTORY_NOT_WRITABLE: "至少一个目录不允许新建子项",
  IDENTITY_INVALID: "提供方返回的对象身份字段不完整或无效", PARENT_INVALID: "父目录身份不符合登记", LAYOUT_INVALID: "登记布局不符合检查合同",
  DIRECTORY_CHANGED: "目录名称、位置或版本发生变化", PATH_AMBIGUOUS: "目录存在同名或身份冲突", SHORTCUT_UNQUALIFIED: "检测到尚未纳入资格验证的快捷方式",
  DIRECTORY_NOT_LISTED: "目录枚举结果缺少已登记对象", ENUMERATION_INVALID: "目录枚举未确认", ENTRY_LIMIT: "目录数量超过本次检查上限",
  OBSERVATION_EXPIRED: "本次检查超过时间限制", CLOCK_INVALID: "检查时钟未确认",
  PROVIDER_AUTHENTICATION_REJECTED: "Google 未接受当前访问凭据", PROVIDER_ACCESS_REJECTED: "Google 拒绝了这次元数据访问",
  PROVIDER_OBJECT_UNAVAILABLE: "Google 未返回所查询的登记对象", PROVIDER_RATE_LIMITED: "Google 暂时限制了请求频率",
  PROVIDER_SERVER_UNAVAILABLE: "Google 服务暂时不可用", PROVIDER_RESPONSE_REJECTED: "Google 未接受这次请求",
  PROVIDER_TIMEOUT: "Google 单次元数据请求超时", RUNTIME_SUBREQUEST_LIMIT: "云端运行环境达到单次外部请求上限",
  PROVIDER_REDIRECT_REJECTED: "Google 请求出现不允许的跳转", PROVIDER_RESPONSE_INVALID: "Google 响应格式无效",
  METADATA_ID_MISMATCH: "Google 返回的对象 ID 与查询不一致", PAGINATION_INVALID: "目录分页标记无效或重复",
  PAGINATION_LIMIT: "目录分页超过本次检查上限", NAMESPACE_VISIBILITY_UNPROVEN: "目录枚举所需的只读元数据权限未确认",
  UNAUTHORIZED_WORKSPACE_MUTATION: "发现未登记的 Clued 资料位置（UNAUTHORIZED_WORKSPACE_MUTATION）",
  BOUNDARY_PROFILE_UNQUALIFIED: "边界配置未通过验证", BOUNDARY_IDENTITY_INVALID: "边界对象身份无效",
  BOUNDARY_ROOT_CHANGED: "资料根身份发生变化", BOUNDARY_ALIAS_OR_CYCLE: "边界存在重复引用或循环",
  BOUNDARY_FOLDER_INVALID: "边界目录类型无效", BOUNDARY_CHANGED: "扫描期间边界发生变化",
  BOUNDARY_ENUMERATION_INVALID: "边界枚举不完整", BOUNDARY_ENTRY_LIMIT: "边界条目超过检查上限",
  BOUNDARY_PATH_AMBIGUOUS: "边界存在同名或路径冲突", BOUNDARY_SHORTCUT_UNQUALIFIED: "边界存在未验证的快捷方式",
  BOUNDARY_DEPTH_LIMIT: "边界目录深度超过检查上限", BOUNDARY_ROOT_NOT_LISTED: "边界枚举缺少资料根" };
class ProbeRequestError extends Error {}
async function request(path: string, body: object | undefined, stillCurrent: () => boolean = () => true) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("请先登录 Clued，再返回此页。");
  if (!stillCurrent()) throw new Error("账号或页面已变化，请重新确认。");
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: "Bearer " + data.session.access_token },
    body: JSON.stringify(body), cache: "no-store", redirect: "error" });
  if (!response.ok) {
    if (path === "/v1/storage/google/probe" && response.status === 403) {
      const failure: unknown = await response.json().catch(() => null);
      if (isObject(failure) && failure.execution_permitted === false && isObject(failure.diagnostic)) {
        const { stage, reason } = failure.diagnostic;
        if (typeof stage === "string" && Object.hasOwn(probeStages, stage) && typeof reason === "string" &&
          (reason === "UNCONFIRMED" || Object.hasOwn(probeReasons, reason))) {
          throw new ProbeRequestError(`目录检查未确认：${probeStages[stage]}${reason === "UNCONFIRMED" ? "" : `；${probeReasons[reason]}`}。不会自动重试或开启文件写入。`);
        }
      }
    }
    throw new Error(response.status === 404 ? "账号存储连接尚未开放，原入口未切换。" : "操作未确认，请刷新状态后检查；不会自动重试或放宽权限。");
  }
  const value: unknown = await response.json();
  const current = await supabase.auth.getSession();
  if (current.error || current.data.session?.user.id !== data.session.user.id) throw new Error("账号已变化，请重新读取连接。");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("响应未确认。");
  return value as Record<string, unknown>;
}
const labels: Record<string, string> = { awaiting_provider: "等待 Google 授权", active: "Google 连接已建立（不代表文件写入已启用）", reauthorization_required: "需要重新授权", revoked: "已停用" };
export default function StorageConnections() {
  const [connections, setConnections] = useState<Connection[]>([]), [message, setMessage] = useState("正在读取……"), [busy, setBusy] = useState(false);
  const [renewals, setRenewals] = useState<Record<string, RefreshStatus>>({});
  const [probeMessages, setProbeMessages] = useState<Record<string, string>>({});
  const [recoveryJobs, setRecoveryJobs] = useState<Record<string, string>>({}), [recoveryViews, setRecoveryViews] = useState<Record<string, RecoveryView>>({});
  const [profileId, setProfileId] = useState(""), [decisionId, setDecisionId] = useState("");
  const registrationBusy = useRef(false);
  const operationBusy = useRef(false);
  const revision = useRef(0);
  const refresh = useCallback(async () => {
    const epoch = ++revision.current;
    setRenewals({});
    setProbeMessages({});
    setRecoveryJobs({}); setRecoveryViews({});
    setBusy(true);
    try { const result = await request("/v1/storage/account", { action: "list" });
      if (epoch !== revision.current) return;
      if (!Array.isArray(result.connections) || !result.connections.every(c => c && typeof c.id === "string" && typeof c.provider === "string" && typeof c.state === "string" && Number.isSafeInteger(c.version))) throw new Error("连接列表未确认。");
      setConnections(result.connections); setMessage(result.connections.length ? "" : "暂无已登记连接。请先完成受治理目录登记。");
    } catch (error) { if (epoch === revision.current) { setConnections([]); setMessage(error instanceof Error ? error.message : "无法读取连接。"); } }
    finally { if (epoch === revision.current) setBusy(false); }
  }, []);
  useEffect(() => {
    let disposed = false;
    const liveRevision = revision;
    const scheduleRead = () => queueMicrotask(() => { if (!disposed) void refresh(); });
    const { data } = supabase.auth.onAuthStateChange(() => {
      if (disposed) return;
      ++revision.current; setConnections([]); setRenewals({}); setProfileId(""); setDecisionId("");
      setProbeMessages({});
      setRecoveryJobs({}); setRecoveryViews({});
      // Do not await Supabase calls from inside its auth callback lock.
      scheduleRead();
    });
    scheduleRead();
    return () => { disposed = true; ++liveRevision.current; data.subscription.unsubscribe(); };
  }, [refresh]);
  async function recover(c: Connection, action: "inspect" | "settle" | "authorize") {
    if (operationBusy.current || registrationBusy.current || busy) return;
    const job = recoveryJobs[c.id]?.trim(), prior = recoveryViews[c.id];
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!job || !uuid.test(job)) { setMessage("请填写原存储任务 ID；不要生成新任务重试。"); return; }
    if (action === "settle" || action === "authorize") {
      if (!["active", "reauthorization_required"].includes(c.state) || prior?.job_id !== job || !["started", "uncertain"].includes(prior.status)) return;
      if (!window.confirm(action === "authorize"
        ? `为原任务 ${job} 重新取得同一 Google 账号的两项既有权限？只更新服务端凭据；不恢复已停用连接、Agent 权限或后台续签，不重新创建文件。Google 最终同意由你确认。`
        : `核对原任务 ${job} 的 Google 元数据，并在结果一致时登记原回执？不会重新创建文件、恢复权限或续签。`)) return;
    }
    const epoch = revision.current;
    operationBusy.current = true; setBusy(true);
    setRecoveryViews(old => { const next = { ...old }; delete next[c.id]; return next; });
    try {
      if (action === "authorize") {
        const result = await request("/v1/storage/google/recovery/start", { connection_id: c.id, job_id: job }, () => epoch === revision.current);
        if (epoch !== revision.current) return;
        if (typeof result.authorization_url !== "string") throw new Error("Unconfirmed");
        const url = new URL(result.authorization_url);
        if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password) throw new Error("Unconfirmed");
        window.location.assign(url.href); return;
      }
      const result = await request("/v1/storage/recovery", { action, connection_id: c.id, job_id: job }, () => epoch === revision.current);
      if (epoch !== revision.current) return;
      if (result.execution_permitted !== false || result.job_id !== job || typeof result.receipt_id !== "string" || !uuid.test(result.receipt_id)) throw new Error("Unconfirmed");
      if (action === "inspect") {
        if (result.connection_id !== c.id || typeof result.status !== "string" || !Object.hasOwn(recoveryLabels, result.status)) throw new Error("Unconfirmed");
        setRecoveryViews(old => ({ ...old, [c.id]: { job_id: job, status: result.status as string, receipt_id: result.receipt_id as string } }));
        setMessage("已读取原任务；回执不代表重新取得写入权限。");
      } else {
        if (result.status !== "committed") throw new Error("Unconfirmed");
        setMessage(`原任务结果已核验并登记。回执：${result.receipt_id}。没有重新写入文件或恢复权限。`);
      }
    } catch {
      if (epoch === revision.current) setMessage("原任务结果尚未确认。请查询原任务回执；不会自动重试、重新创建文件或恢复权限。如凭据失效，可在此页为原任务重新授权。");
    } finally { operationBusy.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function observeDirectories(c: Connection) {
    if (operationBusy.current || registrationBusy.current || busy || c.state !== "active") return;
    const epoch = revision.current;
    operationBusy.current = true; setBusy(true);
    const report = (value: string) => { setMessage(value); setProbeMessages(old => ({ ...old, [c.id]: value })); };
    report("正在只读检查已登记目录；不会创建文件或开启写入。");
    try {
      const result = await request("/v1/storage/google/probe", { connection_id: c.id }, () => epoch === revision.current);
      if (epoch !== revision.current) return;
      if (result.status !== "metadata_observed" || result.execution_permitted !== false ||
        typeof result.attempt_id !== "string" || !/^[0-9a-f-]{36}$/.test(result.attempt_id) ||
        typeof result.receipt_id !== "string" || !/^[0-9a-f-]{36}$/.test(result.receipt_id)) throw new Error("目录检查回执未确认；文件写入保持关闭。");
      report(`已登记目录的访问与元数据检查已记录。回执：${result.receipt_id}。这不是完整存储资格验收，不会开启文件写入。`);
      const b = result.boundary_observation;
      if (isObject(b) && b.contract === "clued.storage-boundary-observation/1" && b.status === "clean" &&
        b.digest_format === "sorted-json/1" && Number.isSafeInteger(b.observed_at_ms) && Number(b.observed_at_ms) >= 0 &&
        b.policy_version === "clued.resource-center-mutation-policy/1" && b.scanner_contract === "clued.google-drive-boundary/1" &&
        typeof b.descriptor_sha256 === "string" && /^[a-f0-9]{64}$/.test(b.descriptor_sha256) &&
        typeof b.scan_config_sha256 === "string" && /^[a-f0-9]{64}$/.test(b.scan_config_sha256)) {
        // Only validated, explicit fields may enter the owner-visible evidence summary.
        const evidence = { attempt_id: result.attempt_id, receipt_id: result.receipt_id,
          boundary_observation: { contract: b.contract, status: b.status, observed_at_ms: b.observed_at_ms,
            policy_version: b.policy_version, scanner_contract: b.scanner_contract, digest_format: b.digest_format,
            descriptor_sha256: b.descriptor_sha256, scan_config_sha256: b.scan_config_sha256 }, execution_permitted: false };
        report(`目录检查回执：${result.receipt_id}。本次父级与同级边界只读扫描未发现违规；这只是观察时点检测，不是原子快照。边界结果需连同受审发布版本另存验收证据，不包含在旧目录回执合同中。不会开启文件写入。验收摘要：${JSON.stringify(evidence)}`);
      }
    } catch (error) {
      if (epoch === revision.current) report(error instanceof ProbeRequestError ? error.message : "目录检查未确认；可能需要核对目录授权、当前版本或等待凭据续签。不会自动重试或开启文件写入。");
    } finally { operationBusy.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function register() {
    if (registrationBusy.current || busy) return;
    const profile = profileId.trim(), decision = decisionId.trim();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    if (!uuid.test(profile) || !uuid.test(decision)) { setMessage("请填写有效的已登记目录 ID 和当前授权 Decision ID。"); return; }
    const epoch = revision.current;
    if (!window.confirm("登记这一个已治理目录的账号连接？目录和授权由服务端核验；此步骤不授予 Google 访问、后台续签或 Agent 文件写入权限。")) return;
    registrationBusy.current = true; setBusy(true);
    try {
      // Stable per-owner receipt identity survives page reload and a lost reply.
      // A revoked connection is not revived by replay; it stays visible as revoked.
      const result = await request("/v1/storage/account", { action: "register", profile_id: profile, source_decision_id: decision,
        idempotency_key: `storage-register-ui-v1:${profile}:${decision}` }, () => epoch === revision.current);
      if (epoch !== revision.current) return;
      if (result.status !== "committed" || typeof result.receipt_id !== "string") throw new Error("登记回执未确认，请刷新状态核对；不要另建重复连接。");
      await refresh();
    } catch (error) {
      if (epoch === revision.current) setMessage(error instanceof Error ? error.message : "登记未确认，请刷新核对；再次提交相同目录与授权会沿用同一请求。");
    } finally { registrationBusy.current = false; if (epoch === revision.current) setBusy(false); }
  }
  async function renewal(c: Connection, action: "status" | "enable" | "disable") {
    if (operationBusy.current || busy) return;
    const previous = renewals[c.id];
    if (action !== "status" && !previous) return;
    if (action === "enable" && !window.confirm("允许 Clued 服务端持续续签这条 Google 连接，直到你主动停用？手机、平板或电脑退出登录不影响续签。仅保留现有授权范围，不新增文件写入权限。")) return;
    if (action === "disable" && !window.confirm("停用后不再发起新的后台续签。已经开始的续签需要核对结果，不能靠重新开启跳过。")) return;
    const epoch = revision.current; operationBusy.current = true; setBusy(true);
    try {
      if (action !== "status") await request("/v1/storage/refresh", { action, connection_id: c.id, base_version: previous.connection_version,
        delegation_version: previous.version, idempotency_key: crypto.randomUUID(), ...(action === "enable" ? { until_revoked: true } : {}) }, () => epoch === revision.current);
      if (epoch !== revision.current) return;
      const value = await request("/v1/storage/refresh", { action: "status", connection_id: c.id }, () => epoch === revision.current);
      if (epoch !== revision.current) return;
      if (typeof value.enabled !== "boolean" || !Number.isSafeInteger(value.version) || !Number.isSafeInteger(value.connection_version) ||
        !Number.isSafeInteger(value.failures) || typeof value.pending !== "boolean" || !(value.next_refresh_at === null || typeof value.next_refresh_at === "string")) throw new Error("续签状态未确认。");
      setRenewals(old => ({ ...old, [c.id]: value as RefreshStatus }));
      setConnections(old => old.map(item => item.id === c.id ? { ...item, version: Number(value.connection_version) } : item));
      setMessage(action === "status" ? "" : "设置已确认。");
    } catch (error) {
      if (epoch === revision.current) {
        setRenewals(old => { const next = { ...old }; delete next[c.id]; return next; });
        setMessage(error instanceof Error ? error.message : "续签设置未确认，请重新查询状态。");
      }
    } finally { operationBusy.current = false; if (epoch === revision.current) setBusy(false); }
  }
  return <main className="mx-auto max-w-3xl px-6 py-16"><h1 className="text-2xl font-semibold">存储管理</h1>
    <p className="my-4">仅当前登录账号可处理受治理目录、原任务核对和续签设置。所有操作仍由服务端核验。</p>
    <p role="status" className="my-4">{message}</p>
    <section className="my-4 rounded-xl border p-4"><h2>登记已治理目录</h2>
      <p className="my-2 text-sm">仅引用服务端已登记的目录与当前授权，不接受自定义磁盘路径。登记不代表写入已启用；相同请求可安全核对回执，已停用连接不会自动恢复。</p>
      <label className="my-2 block">已登记目录 ID<input className="block w-full rounded border p-2" value={profileId} disabled={busy}
        autoComplete="off" onChange={event => setProfileId(event.target.value)} /></label>
      <label className="my-2 block">当前授权 Decision ID<input className="block w-full rounded border p-2" value={decisionId} disabled={busy}
        autoComplete="off" onChange={event => setDecisionId(event.target.value)} /></label>
      <button disabled={busy || !profileId.trim() || !decisionId.trim()} onClick={() => void register()}>登记账号连接</button>
    </section>
    {connections.map(c => <section className="my-4 rounded-xl border p-4" key={c.id}>
      <h2>{c.provider} · {labels[c.state] ?? "状态待确认"}</h2><p className="my-2 break-all text-sm">连接：{c.id}</p>
      <details className="my-4 rounded border p-3"><summary>核对未确认的原存储任务</summary>
        <p className="my-2 text-sm">使用原任务 ID 查询结果。核验仅读取 Google 元数据并登记原回执，不会重派文件操作、恢复权限或开启续签。</p>
        <label className="my-2 block">原存储任务 ID<input className="block w-full rounded border p-2" autoComplete="off" disabled={busy}
          value={recoveryJobs[c.id] ?? ""} onChange={event => {
            setRecoveryJobs(old => ({ ...old, [c.id]: event.target.value }));
            setRecoveryViews(old => { const next = { ...old }; delete next[c.id]; return next; });
          }} /></label>
        <button disabled={busy || !recoveryJobs[c.id]?.trim()} onClick={() => void recover(c, "inspect")}>查询原任务回执</button>
        {recoveryViews[c.id] && <><p role="status" className="my-2 break-all">{recoveryLabels[recoveryViews[c.id].status]}；回执：{recoveryViews[c.id].receipt_id}</p>
          {["active", "reauthorization_required"].includes(c.state) && ["started", "uncertain"].includes(recoveryViews[c.id].status) &&
            <><button disabled={busy} onClick={() => void recover(c, "settle")}>核验并登记原结果（不重写）</button>
              <button disabled={busy} onClick={() => void recover(c, "authorize")}>重新授权以核对原任务（凭据失效时）</button></>}</>}
      </details>
      {c.state === "active" && <div className="my-2"><button disabled={busy} onClick={() => void observeDirectories(c)}>检查已登记目录（只读）</button>
        <p className="text-sm">只核对服务端登记目录的访问与元数据，不读取文件正文，不授予 Agent 写入权限。</p>
        {probeMessages[c.id] && <p role="status" aria-live="polite" className="my-2 break-all">{probeMessages[c.id]}</p>}</div>}
      <div className="mt-4 border-t pt-4"><h3>账号级后台续签</h3>
        <p className="my-2 text-sm">新连接在授权时默认选择自动续签，可取消或随时停用；已有停用设置不会自动恢复。由服务端执行，不依赖任何设备在线，不授予 Agent 整理或写入文件的权限。</p>
        <button disabled={busy} onClick={() => void renewal(c, "status")}>查询续签状态</button>
        {renewals[c.id] && <><p role="status" className="my-2">{renewals[c.id].enabled ? "后台续签已开启" : "后台续签已关闭"}
          {renewals[c.id].pending ? "；存在尚未确认的续签。请核对结果，必要时重新授权 Google。" : ""}
          {renewals[c.id].failures > 0 ? `；连续失败 ${renewals[c.id].failures} 次。` : ""}</p>
          <button disabled={busy || (!renewals[c.id].enabled && (c.state !== "active" || renewals[c.id].pending))}
            onClick={() => void renewal(c, renewals[c.id].enabled ? "disable" : "enable")}>{renewals[c.id].enabled ? "停用后台续签" : "授权开启后台续签"}</button></>}
      </div>
    </section>)}
    <div className="mt-6 flex gap-4"><button disabled={busy} onClick={() => void refresh()}>刷新状态</button><Link href="/storage/connections">返回存储连接</Link></div>
  </main>;
}
