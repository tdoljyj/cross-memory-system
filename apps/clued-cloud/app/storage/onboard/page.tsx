"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../../supabase-browser";
import { acceptPickerToken, DRIVE_FILE_SCOPE, ONBOARD_DEFAULT_ROOT_NAME, ONBOARD_DEFAULT_TRACKS, ONBOARD_DISCLOSURE_VERSION, onboardRootNameValid,
  onboardTracksValid, renderOnboardDisclosure, type OnboardChoice } from "../../../worker/storage-onboard-disclosure";

// StorageNormalUse.v0.1 N0 (§8.1): new Google Drive connection from this page.
// The click on “确认并连接 Google Drive” is the Owner's confirmation; the Worker
// renders the same disclosure from the same choice and binds its SHA-256.
const FOLDER = "application/vnd.google-apps.folder";
type Picker = { api_key: string; app_id: string; client_id: string };
type Attempt = { onboard_attempt_id: string; state: string; root: { name: string }; failure_code: string | null;
  orphans: { role: string; provider_file_id: string | null }[]; expires_at: string; retryable?: boolean };
type Config = { enabled: boolean; reason?: string; allowed?: boolean; picker?: Picker | null; refresh_available?: boolean;
  refresh_token_count?: number; attempts?: Attempt[] };
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
// Fixed page texts for the fixed reason labels; nothing else is shown.
const reasons: Record<string, string> = {
  root_shared_drive: "所选目录在共享云端硬盘中，自助接入只支持“我的云端硬盘”里的目录。",
  root_not_owned: "所选目录不属于你的 Google 账号（他人共享的目录不支持），请选择你自己的目录。",
  root_overlaps_existing: "所选目录与已连接的资料根相同、在其中或包含它，请选择其他目录。",
  root_name_changed: "所选目录的名称已变化，请重新选择并确认新的说明。",
  onboard_track_name_conflict: "所选目录下已有与子目录同名的文件夹，请修改子目录名称后重试。",
  onboard_effect_ambiguous: "Drive 中找到多个本次接入创建的同名对象，无法确定使用哪一个，请联系维护者。",
  root_multiple_parents: "所选目录有多个上级目录，不支持作为资料根。",
  root_not_folder: "所选对象不是文件夹。", root_trashed: "所选目录在回收站中。",
  root_not_authorized: "所选目录没有授权给 BeamingFace，请通过“选择已有目录”重新选择。",
  root_not_writable: "当前 Google 账号不能在所选目录中新建文件夹。",
  root_metadata_unavailable: "暂时无法读取所选目录的信息，请稍后重试。", root_ancestry_unavailable: "暂时无法核对目录的上级关系，请稍后重试。",
  onboard_effect_unconfirmed: "Drive 目录创建结果未确认，可以重试（不会重复创建）。",
  activation_unconfirmed: "连接启用未确认，请先刷新状态核对，可以重试（不会重复创建目录）。",
  onboard_expired: "本次接入已超过 30 分钟，请重新开始。",
  onboard_not_allowed: "Google 应用验证通过前，自助接入只对名单内的测试用户开放。",
  onboard_unavailable: "自助接入暂不可用，请联系维护者。", onboard_disabled: "自助接入尚未开放。",
  picker_unconfigured: "“选择已有目录”需要维护者先配置 Google Picker，目前只能新建目录。",
  refresh_unavailable: "后台自动续期尚未开放，请取消勾选后再连接。",
  refresh_token_limit: "该账号在 BeamingFace 中的 Google 授权次数已达上限，暂时不能新建连接，请联系维护者。",
  onboard_input_invalid: "目录名或子目录名不符合要求。", onboard_disclosure_changed: "说明已更新，请刷新页面后重新确认。",
  scope_mismatch: "Google 返回的权限与请求不一致，连接未建立。",
  token_exchange_unconfirmed: "Google 授权码兑换未确认，请重新开始，不要重复使用同一授权。",
  credential_commit_unconfirmed: "凭据保存未确认，请刷新状态核对。",
  onboard_run_active: "这次接入仍在处理中，请几分钟后刷新状态再重试。",
  onboard_run_superseded: "这次接入已由另一次重试接管，请刷新状态核对。",
};
const reasonText = (reason: unknown) => typeof reason === "string" && Object.hasOwn(reasons, reason) ? reasons[reason] : "操作未确认，请刷新状态后核对。";
class RequestFailure extends Error { constructor(readonly reason?: string) { super("request_failed"); } }
async function post(path: string, body: object) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new RequestFailure();
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + data.session.access_token },
    body: JSON.stringify(body), cache: "no-store", redirect: "error" });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new RequestFailure(isObject(result) && typeof result.reason === "string" && /^[a-z_]{1,64}$/.test(result.reason) ? result.reason : undefined);
  if (!isObject(result)) throw new RequestFailure();
  return result;
}
// The Picker API is loaded at run time from Google; its surface is untyped here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
type GoogleGlobal = {
  accounts: { oauth2: { initTokenClient(config: Record<string, unknown>): { requestAccessToken(options?: Record<string, unknown>): void } } };
  picker: Loose;
};
declare global { interface Window { google?: GoogleGlobal; gapi?: { load(name: string, done: () => void): void } } }
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const script = document.createElement("script");
    script.src = src; script.async = true; script.onload = () => resolve(); script.onerror = () => reject(new Error("script"));
    document.head.appendChild(script);
  });
}

export default function StorageOnboard() {
  const [config, setConfig] = useState<Config | null>(null);
  const [message, setMessage] = useState("正在读取……");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"new" | "picked">("new");
  const [name, setName] = useState(ONBOARD_DEFAULT_ROOT_NAME);
  const [picked, setPicked] = useState<{ folder_id: string; name: string } | null>(null);
  const [tracksText, setTracksText] = useState(ONBOARD_DEFAULT_TRACKS.join("\n"));
  const [masterEnabled, setMasterEnabled] = useState(true);
  const [defaultRefresh, setDefaultRefresh] = useState(true);
  const operation = useRef(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const result = await post("/v1/storage/onboard/config", {});
      setConfig(result as Config);
      if (result.refresh_available !== true) setDefaultRefresh(false);
      setMessage(result.enabled !== true ? reasonText(result.reason ?? "onboard_disabled")
        : result.allowed !== true ? reasons.onboard_not_allowed : "");
    } catch (error) {
      setConfig(null); setMessage(error instanceof RequestFailure && error.reason ? reasonText(error.reason) : "请登录 BeamingFace 后刷新页面。");
    } finally { setBusy(false); }
  }, []);
  useEffect(() => { queueMicrotask(() => void load()); }, [load]);

  const tracks = tracksText.split("\n").map(line => line.trim()).filter(Boolean);
  const root = mode === "new" ? { mode: "new" as const, name: name.trim() }
    : picked ? { mode: "picked" as const, name: picked.name, folder_id: picked.folder_id } : null;
  const choice: OnboardChoice | null = root && onboardRootNameValid(root.name) && onboardTracksValid(tracks)
    ? { root, tracks, normal_use: masterEnabled, default_refresh: defaultRefresh } : null;
  const ready = !!config?.enabled && config.allowed === true && !!choice;

  async function pickFolder() {
    const picker = config?.picker;
    if (operation.current || busy) return;
    if (!picker) { setMessage(reasons.picker_unconfigured); return; }
    operation.current = true; setBusy(true);
    try {
      await Promise.all([loadScript("https://accounts.google.com/gsi/client"), loadScript("https://apis.google.com/js/api.js")]);
      await new Promise<void>(resolve => window.gapi!.load("picker", resolve));
      const google = window.google!;
      const token = await new Promise<string | null>(resolve => google.accounts.oauth2.initTokenClient({
        client_id: picker.client_id, scope: DRIVE_FILE_SCOPE, include_granted_scopes: false,
        callback: (response: Record<string, unknown>) => resolve(acceptPickerToken(response)),
        error_callback: () => resolve(null),
      }).requestAccessToken({ prompt: "" }));
      if (!token) { setMessage("Google 返回的授权不是“仅限所选文件”，已丢弃（未撤销任何授权）。请重试选择。"); return; }
      const selected = await new Promise<{ id: string; name: string } | null>(resolve => {
        const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS).setSelectFolderEnabled(true).setIncludeFolders(true).setMimeTypes(FOLDER);
        new google.picker.PickerBuilder().addView(view).setAppId(picker.app_id).setOAuthToken(token).setDeveloperKey(picker.api_key)
          .setCallback((data: Loose) => {
            if (data.action === google.picker.Action.PICKED) {
              const doc = data.docs?.[0];
              resolve(doc && doc.mimeType === FOLDER && typeof doc.id === "string" && typeof doc.name === "string" ? { id: doc.id, name: doc.name } : null);
            } else if (data.action === google.picker.Action.CANCEL) resolve(null);
          }).build().setVisible(true);
      });
      // The access token is dropped here; it never reaches the server.
      if (!selected) { setMessage("未选择目录。"); return; }
      if (!onboardRootNameValid(selected.name)) { setMessage("该目录名称过长或含不支持的字符，请先在 Drive 中改名。"); return; }
      setPicked({ folder_id: selected.id, name: selected.name }); setMessage("");
    } catch { setMessage("无法打开 Google 目录选择器，请稍后重试。"); }
    finally { operation.current = false; setBusy(false); }
  }

  async function confirm() {
    if (operation.current || busy || !ready || !choice) return;
    operation.current = true; setBusy(true);
    try {
      const result = await post("/v1/storage/onboard/begin", { ...choice, disclosure_version: ONBOARD_DISCLOSURE_VERSION });
      if (typeof result.authorization_url !== "string") throw new RequestFailure();
      const url = new URL(result.authorization_url);
      if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth" || url.username || url.password) throw new RequestFailure();
      window.location.assign(url.href);
    } catch (error) { setMessage(reasonText(error instanceof RequestFailure ? error.reason : undefined)); }
    finally { operation.current = false; setBusy(false); }
  }

  async function retry(attempt: Attempt) {
    if (operation.current || busy) return;
    operation.current = true; setBusy(true);
    try {
      const result = await post("/v1/storage/onboard/resume", { onboard_attempt_id: attempt.onboard_attempt_id });
      setMessage(result.status === "completed" ? `已连接「${attempt.root.name}」。回执：${String(result.receipt_id)}` : reasonText(undefined));
    } catch (error) { setMessage(reasonText(error instanceof RequestFailure ? error.reason : undefined)); }
    finally { operation.current = false; setBusy(false); void load(); }
  }

  const unfinished = (config?.attempts ?? []).filter(a => (a.state !== "completed" && a.state !== "begun") || a.orphans.length > 0);
  return <main className="mx-auto max-w-3xl px-6 py-16">
    <h1 className="text-2xl font-semibold">新建 Google Drive 连接</h1>
    <p role="status" className="my-4">{message}</p>
    {unfinished.map(a => <section key={a.onboard_attempt_id} className="my-3 rounded-xl border p-3 text-sm">
      <p>「{a.root.name}」：{a.state === "failed" ? "未完成" : a.state === "expired" ? "已过期" : "处理中"}{a.failure_code ? `（${reasonText(a.failure_code)}）` : ""}</p>
      {a.orphans.length > 0 && <p>已在 Drive 中创建但未启用：{a.orphans.map(o => o.role === "root" ? "根目录" : o.role.replace(/^track:/, "子目录 ")).join("、")}。BeamingFace 不会删除它们，可在 Drive 中自行处理。</p>}
      {/* The server expires attempts after 30 minutes; an expired one is listed as expired. Retry only
          while the staged credential is kept and no other run holds the attempt. */}
      {a.retryable === true &&
        <button disabled={busy} onClick={() => void retry(a)}>重试（不会重复创建目录）</button>}
    </section>)}
    {config?.enabled && config.allowed && <div>
      <fieldset className="my-4"><legend className="font-semibold">资料根目录</legend>
        <label className="block"><input type="radio" name="root-mode" checked={mode === "new"} disabled={busy} onChange={() => setMode("new")} />
          在“我的云端硬盘”下新建目录</label>
        {mode === "new" && <input aria-label="目录名" value={name} disabled={busy} maxLength={120} onChange={event => setName(event.target.value)} />}
        <label className="block"><input type="radio" name="root-mode" checked={mode === "picked"} disabled={busy || !config.picker}
          onChange={() => setMode("picked")} />选择已有目录</label>
        {!config.picker && <p className="text-sm">{reasons.picker_unconfigured}</p>}
        {mode === "picked" && <div><button disabled={busy} onClick={() => void pickFolder()}>从 Google Drive 选择目录</button>
          <span>{picked ? `已选择：${picked.name}` : "尚未选择"}</span></div>}
      </fieldset>
      <label className="my-4 block"><span className="font-semibold">子目录（每行一个，1–32 个）</span>
        <textarea aria-label="子目录" rows={4} value={tracksText} disabled={busy} onChange={event => setTracksText(event.target.value)} /></label>
      <label className="block"><input type="checkbox" checked={masterEnabled} disabled={busy} onChange={event => setMasterEnabled(event.target.checked)} />连接后开启全部 Agent 文件操作（默认）</label>
      <label className="block"><input type="checkbox" checked={defaultRefresh} disabled={busy || !config.refresh_available}
        onChange={event => setDefaultRefresh(event.target.checked)} />连接后后台自动续签（默认选中，可随时停用）</label>
      {!defaultRefresh && <p className="text-sm">不开启后台续期时，连接约 1 小时后读写都不可用，需要回到本页重新授权。</p>}
      {(config.refresh_token_count ?? 0) >= 50 && <p className="text-sm">该账号在 BeamingFace 中的 Google 授权次数已较多。Google 超过上限时会静默作废最早的授权。</p>}
      {choice ? <div className="my-4 whitespace-pre-wrap rounded-xl border p-3 text-sm" aria-label="说明">{renderOnboardDisclosure(choice)}</div>
        : <p className="my-4 text-sm">{mode === "picked" && !picked ? "请先选择目录。" : "目录名或子目录名不符合要求：每个名称 1–160 个字符，不能含“/”或“\\”，子目录不能重复。"}</p>}
      <button disabled={busy || !ready} onClick={() => void confirm()}>确认并连接 Google Drive</button>
    </div>}
    <div className="mt-6 flex gap-4"><button disabled={busy} onClick={() => void load()}>刷新状态</button>
      <Link href="/storage/connections">返回存储连接</Link></div>
  </main>;
}
