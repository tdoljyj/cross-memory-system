"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { type Session } from "@supabase/supabase-js";
import { supabase, restoreBrowserSession } from "./supabase-browser";
import Link from "next/link";
import ImprintPanel from "./imprints/ImprintPanel";
import { NativeReadFailure, readNativeJson, runNativeRead } from "./native-read-recovery";
import {
  formatRecordTime,
  presentCluedLogCard,
  presentCluedRecord,
  presentCluedRecordDisplay,
  type CluedRecord,
} from "./record-presentation";

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const LANGUAGE_STORAGE_KEY = "clued-language";

type View = "loading" | "login" | "create" | "set-password" | "account";
type Locale = "zh-CN" | "en";
type Project = {
  id: string;
  name: string;
  progress_status: "not_started" | "active" | "paused" | "completed" | "archived";
  summary: string | null;
  version: number;
  updated_at: string;
};
type RecordView = "state" | "task" | "decision" | "archive" | "log";
type RecordLevel = "global" | "project";
type RecordListState = {
  key: string;
  selectionToken: object | null;
  status: "idle" | "loading" | "ready" | "unknown" | "error";
  records: CluedRecord[];
};
type NoticeKey =
  | "invalidLink"
  | "invalidCredentials"
  | "passwordTooShort"
  | "passwordMismatch"
  | "accountExists"
  | "rateLimited"
  | "genericAuthError"
  | "confirmationSent"
  | "passwordSet";

const copy = {
  en: {
    homeLabel: "BeamingFace home",
    byline: "Discover × Continue",
    languageLabel: "Language",
    eyebrow: "Follow your curiosity",
    headlineOne: "Good finds.",
    headlineTwo: "Happy faces.",
    lede: "Interesting content, useful apps, and new things to try. Follow your interests and see what people have made.",
    principlesLabel: "BeamingFace principles",
    privateDefault: "Private by default",
    scopedAccess: "Scoped access",
    revocable: "Revocable",
    securingSession: "Securing your session…",
    accountLabel: "BeamingFace account",
    createTitle: "Create your account",
    welcomeTitle: "Welcome back",
    createDescription: "Start with your email. You’ll confirm it before signing in.",
    loginDescription: "Sign in to manage your memory and authorized AI connections.",
    email: "Email",
    password: "Password",
    passwordPlaceholder: "8–128 characters",
    pleaseWait: "Please wait…",
    createAccount: "Create account",
    signIn: "Sign in",
    existingAccount: "Already have an account? Sign in",
    newAccount: "New to BeamingFace? Create an account",
    invitationAccepted: "Invitation accepted",
    setPasswordTitle: "Set your password",
    finishActivationBefore: "Finish activating",
    finishActivationAfter: ". Use 8–128 characters.",
    newPassword: "New password",
    confirmPassword: "Confirm password",
    confirmPlaceholder: "Repeat your password",
    saving: "Saving…",
    activateClued: "Activate BeamingFace",
    accountActive: "Account active",
    accountReadyTitle: "You’re in.",
    accountReadyCopy: "Your BeamingFace identity is ready.",
    memoriesTitle: "My memories",
    memoriesCopy: "Create and manage the private context you want BeamingFace to remember.",
    memoryTitle: "Title",
    memoryTitlePlaceholder: "What should BeamingFace remember?",
    memoryContent: "Memory",
    memoryContentPlaceholder: "Write the useful detail, decision, preference, or context.",
    addMemory: "Add memory",
    updateMemory: "Save changes",
    savingMemory: "Saving…",
    cancelEdit: "Cancel",
    noMemories: "No memories yet. Add the first one above.",
    memoryUpdatedAt: "Updated",
    editMemory: "Edit",
    deleteMemory: "Delete",
    confirmDelete: "Delete this memory? The content will be removed, while an audit receipt is retained.",
    memoryError: "BeamingFace could not update your memories. Please try again.",
    memoryCreated: "Memory added.",
    memoryUpdated: "Memory updated.",
    memoryDeleted: "Memory deleted.",
    auditTitle: "Recent memory activity",
    auditCopy: "Receipts record the action and a content digest, not deleted text.",
    noAudit: "No memory activity yet.",
    auditCreate: "Created",
    auditUpdate: "Updated",
    auditDelete: "Deleted",
    untitledMemory: "Memory",
    continuityTitle: "AI continuity",
    continuityCopy: "Authorize an AI once. It can then restore this context at session start and checkpoint changes before handoff.",
    connectHow: "Claude and ChatGPT connect from the client itself (OAuth). For CI, runners and scripts, issue a scoped token with an expiry on the connections page.",
    manageConnections: "Manage connections and issue tokens",
    continuityProtocol: "Automatic protocol: restore → work events → checkpoint",
    projectsTitle: "Projects",
    projectsCopy: "Once BeamingFace recognizes an item as a Project, it is created here. Recognition confidence stays in private evidence; work progress remains independent.",
    newProject: "Project name",
    newProjectPlaceholder: "Add a project",
    addProject: "Create project",
    addingProject: "Adding…",
    projectList: "Your projects",
    noProjects: "No projects yet.",
    projectsLoading: "Reading projects…",
    projectsReadUnknown: "The project list could not be confirmed. This does not mean there are no projects.",
    retryProjectRead: "Read projects again",
    archiveProject: "Archive",
    projectError: "The project change was not confirmed. Your input is kept; please try again.",
    progressNotStarted: "Not started",
    progressActive: "Active",
    progressPaused: "Paused",
    progressCompleted: "Completed",
    progressArchived: "Archived",
    workViewsTitle: "Current work",
    workViewsCopy: "Read overall priorities and plans first, then each project's State, Tasks and Decisions. Log and Archive provide evidence when needed; each view refers to the same record.",
    globalLevel: "Overall planning",
    projectLevel: "Project",
    chooseProject: "Choose a project",
    stateView: "State",
    taskView: "Tasks",
    decisionView: "Decisions",
    archiveView: "Archive",
    logView: "Log",
    noWorkRecords: "No records in this view.",
    workRecordsLoading: "Checking this view…",
    workRecordsUnknown: "Current information could not be confirmed. Please refresh after reconciliation.",
    workRecordsSelectProject: "Select a project to view its records.",
    workRecordTitle: "Title",
    workRecordContent: "Detail",
    canonicalIdLabel: "Canonical ID",
    versionNotRecorded: "Version not recorded",
    viewRawRecord: "View raw record",
    viewEvidence: "View evidence and raw record",
    evidenceLabel: "Readable evidence",
    metadataLabel: "Metadata",
    rawRecordLabel: "Raw record",
    viewFullJson: "View complete JSON",
    addWorkRecord: "Add canonical record",
    workViewsError: "BeamingFace could not load the unified work views.",
    signingOut: "Signing out…",
    signOut: "Sign out",
    copyright: "© 2026 BeamingFace",
    previewStatus: "BeamingFace · Controlled Public Preview",
    invalidLink: "This sign-in link is invalid or has expired. Request a new invitation.",
    invalidCredentials: "Email or password is incorrect.",
    passwordTooShort: "Use at least 8 characters for your password.",
    passwordMismatch: "The passwords do not match.",
    accountExists: "An account with this email already exists. Sign in instead.",
    rateLimited: "Too many attempts. Please wait a moment and try again.",
    genericAuthError: "BeamingFace could not complete that request. Please try again.",
    confirmationSent: "Check your email to confirm your BeamingFace account.",
    passwordSet: "Password set. Your BeamingFace account is ready.",
  },
  "zh-CN": {
    homeLabel: "BeamingFace 首页",
    byline: "发现 × 继续",
    languageLabel: "语言",
    eyebrow: "顺着兴趣逛下去",
    headlineOne: "好的发现，",
    headlineTwo: "会写在脸上。",
    lede: "有趣的内容，好用的应用，还有让人眼前一亮的新玩法。",
    principlesLabel: "BeamingFace 原则",
    privateDefault: "默认私密",
    scopedAccess: "范围可控",
    revocable: "随时撤销",
    securingSession: "正在安全恢复登录状态…",
    accountLabel: "BeamingFace 账户",
    createTitle: "创建账户",
    welcomeTitle: "欢迎回来",
    createDescription: "输入电子邮件并设置密码，确认邮箱后即可登录。",
    loginDescription: "登录后管理你的记忆和已授权的 AI 连接。",
    email: "电子邮件",
    password: "密码",
    passwordPlaceholder: "8–128 个字符",
    pleaseWait: "请稍候…",
    createAccount: "创建账户",
    signIn: "登录",
    existingAccount: "已有账户？登录",
    newAccount: "第一次使用 BeamingFace？创建账户",
    invitationAccepted: "邀请已接受",
    setPasswordTitle: "设置密码",
    finishActivationBefore: "完成账户激活：",
    finishActivationAfter: "。密码请使用 8–128 个字符。",
    newPassword: "新密码",
    confirmPassword: "确认密码",
    confirmPlaceholder: "再次输入密码",
    saving: "正在保存…",
    activateClued: "激活 BeamingFace",
    accountActive: "账户已激活",
    accountReadyTitle: "登录成功",
    accountReadyCopy: "你的 BeamingFace 身份已经就绪。",
    memoriesTitle: "我的记忆",
    memoriesCopy: "新增并管理你希望 BeamingFace 长期记住的私人上下文。",
    memoryTitle: "标题",
    memoryTitlePlaceholder: "希望 BeamingFace 记住什么？",
    memoryContent: "记忆内容",
    memoryContentPlaceholder: "写下有用的细节、决定、偏好或上下文。",
    addMemory: "新增记忆",
    updateMemory: "保存修改",
    savingMemory: "正在保存…",
    cancelEdit: "取消编辑",
    noMemories: "还没有记忆，请先新增第一条。",
    memoryUpdatedAt: "更新时间",
    editMemory: "编辑",
    deleteMemory: "删除",
    confirmDelete: "确定删除这条记忆吗？正文会被移除，但会保留审计回执。",
    memoryError: "BeamingFace 暂时无法更新你的记忆，请重试。",
    memoryCreated: "记忆已新增。",
    memoryUpdated: "记忆已更新。",
    memoryDeleted: "记忆已删除。",
    auditTitle: "最近记忆活动",
    auditCopy: "回执只记录动作与内容摘要，不保留已删除正文。",
    noAudit: "还没有记忆活动。",
    auditCreate: "已新增",
    auditUpdate: "已更新",
    auditDelete: "已删除",
    untitledMemory: "记忆",
    continuityTitle: "AI 连续性",
    continuityCopy: "只授权一次。此后 AI 会在会话开始恢复上下文，在交接或结束前提交检查点。",
    connectHow: "Claude、ChatGPT 在客户端里直接连接（OAuth）。CI、runner、脚本请到连接管理页签发只含所需权限、带有效期的令牌。",
    manageConnections: "管理连接和签发令牌",
    continuityProtocol: "自动协议：恢复 → 工作事件 → 检查点",
    projectsTitle: "项目",
    projectsCopy: "BeamingFace 识别为项目后会直接在这里创建；识别置信度只保留在后台证据中，工作进度独立管理。",
    newProject: "项目名称",
    newProjectPlaceholder: "添加一个项目",
    addProject: "创建项目",
    addingProject: "正在添加…",
    projectList: "你的项目",
    noProjects: "暂无项目。",
    projectsLoading: "正在读取项目…",
    projectsReadUnknown: "项目列表尚未读到，不能据此判断没有项目。",
    retryProjectRead: "重新读取项目",
    archiveProject: "归档",
    projectError: "项目变更尚未确认，已保留输入，请重试。",
    progressNotStarted: "未开始",
    progressActive: "进行中",
    progressPaused: "已暂停",
    progressCompleted: "已完成",
    progressArchived: "已归档",
    workViewsTitle: "当前工作",
    workViewsCopy: "先看整体优先级与安排，再看各项目的状态、任务和决策；需要核对时再查日志与归档，各视图引用同一条记录。",
    globalLevel: "整体安排",
    projectLevel: "项目",
    chooseProject: "选择一个项目",
    stateView: "状态",
    taskView: "任务",
    decisionView: "决策",
    archiveView: "归档",
    logView: "日志",
    noWorkRecords: "此视图暂无记录。",
    workRecordsLoading: "正在核对当前视图…",
    workRecordsUnknown: "当前信息尚未核实，请在完成对账后刷新。",
    workRecordsSelectProject: "请选择要查看的项目。",
    workRecordTitle: "标题",
    workRecordContent: "详细内容",
    canonicalIdLabel: "Canonical ID",
    versionNotRecorded: "版本未记录",
    viewRawRecord: "查看原始记录",
    viewEvidence: "查看证据与原始记录",
    evidenceLabel: "可读证据",
    metadataLabel: "元数据",
    rawRecordLabel: "原始记录",
    viewFullJson: "查看完整 JSON",
    addWorkRecord: "新增 canonical 记录",
    workViewsError: "BeamingFace 暂时无法加载统一工作视图。",
    signingOut: "正在退出…",
    signOut: "退出登录",
    copyright: "© 2026 BeamingFace",
    previewStatus: "BeamingFace · 受控公开预览",
    invalidLink: "此登录链接无效或已过期，请重新申请邀请。",
    invalidCredentials: "电子邮件或密码不正确。",
    passwordTooShort: "密码至少需要 8 个字符。",
    passwordMismatch: "两次输入的密码不一致。",
    accountExists: "该电子邮件已注册，请直接登录。",
    rateLimited: "尝试次数过多，请稍后再试。",
    genericAuthError: "BeamingFace 暂时无法完成此请求，请重试。",
    confirmationSent: "确认邮件已发送，请前往邮箱完成 BeamingFace 账户确认。",
    passwordSet: "密码设置成功，你的 BeamingFace 账户已就绪。",
  },
} as const;

function detectLocale(): Locale {
  const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (saved === "zh-CN" || saved === "en") return saved;
  return navigator.languages.some((language) =>
    language.toLowerCase().startsWith("zh"),
  )
    ? "zh-CN"
    : "en";
}

function authErrorDetails(message: string): {
  key: NoticeKey;
  minimumPasswordLength?: number;
} {
  const normalized = message.toLowerCase();
  const minimumPasswordMatch = normalized.match(
    /password.*at least\s+(\d+)\s+characters?/,
  );
  if (minimumPasswordMatch) {
    return {
      key: "passwordTooShort",
      minimumPasswordLength: Number(minimumPasswordMatch[1]),
    };
  }
  if (normalized.includes("already registered") || normalized.includes("already exists")) {
    return { key: "accountExists" };
  }
  if (normalized.includes("rate") || normalized.includes("too many")) {
    return { key: "rateLimited" };
  }
  return { key: "genericAuthError" };
}

function authErrorText(
  key: NoticeKey,
  locale: Locale,
  minimumPasswordLength?: number,
): string {
  if (key === "passwordTooShort" && minimumPasswordLength !== undefined) {
    return locale === "zh-CN"
      ? `密码至少需要 ${minimumPasswordLength} 个字符。`
      : `Use at least ${minimumPasswordLength} characters for your password.`;
  }
  return copy[locale][key];
}

export default function Home() {

  const [locale, setLocale] = useState<Locale>("en");
  const [view, setView] = useState<View>("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<NoticeKey | "">("");
  const [error, setError] = useState<NoticeKey | "">("");
  const [minimumPasswordError, setMinimumPasswordError] = useState<number>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsOwner, setProjectsOwner] = useState<object | null>(null);
  const [projectReload, setProjectReload] = useState(0);
  const projectSelectionKey = JSON.stringify([session?.user.id, session?.access_token, view, projectReload]);
  const projectSelectionToken = useMemo(() => ({ key: projectSelectionKey }), [projectSelectionKey]);
  const projectsConfirmed = !!session && view === "account" && projectsOwner === projectSelectionToken;
  const visibleProjects = projectsConfirmed ? projects : [];
  const projectActor = useRef({ subject: "", token: "", epoch: 0 });
  const projectReadGeneration = useRef(0);
  const [projectName, setProjectName] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState(false);
  const [projectReadError, setProjectReadError] = useState<object | null>(null);
  const projectReadFailed = projectReadError === projectSelectionToken;
  const pendingProjectCreate = useRef<{ subject: string; name: string; body: string } | null>(null);

  function observeProjectSession(next: Session | null) {
    const subject = next?.user.id ?? "", token = next?.access_token ?? "";
    if (projectActor.current.subject !== subject || projectActor.current.token !== token) {
      if (projectActor.current.subject !== subject) {
        setProjectName("");
        setRecordTitle("");
        setRecordContent("");
      }
      projectActor.current = { subject, token, epoch: projectActor.current.epoch + 1 };
      setProjectsOwner(null);
      setProjects([]);
      setProjectBusy(false);
      setProjectError(false);
      setProjectReadError(null);
      if (pendingProjectCreate.current?.subject !== subject) pendingProjectCreate.current = null;
    }
  }

  useEffect(function clearChangedProjectCreate() {
    const pending = pendingProjectCreate.current;
    if (pending && (pending.subject !== session?.user.id || pending.name !== projectName.trim())) {
      pendingProjectCreate.current = null;
    }
  }, [session?.user.id, projectName]);
  const [recordsEnabled, setRecordsEnabled] = useState(false);
  const [recordView, setRecordView] = useState<RecordView>("state");
  const [recordLevel, setRecordLevel] = useState<RecordLevel>("global");
  const [recordProjectId, setRecordProjectId] = useState("");
  const [recordList, setRecordList] = useState<RecordListState>({ key: "", selectionToken: null, status: "idle", records: [] });
  const [recordTitle, setRecordTitle] = useState("");
  const [recordContent, setRecordContent] = useState("");
  const [recordBusy, setRecordBusy] = useState(false);
  const [recordError, setRecordError] = useState(false);
  const recordSelectionKey = JSON.stringify([session?.user.id, session?.access_token, view, recordsEnabled,
    recordLevel, recordProjectId, recordView]);
  const recordSelectionToken = useMemo(() => ({ key: recordSelectionKey }), [recordSelectionKey]);
  const activeRecordSelection = useRef(recordSelectionToken);
  const recordReadGeneration = useRef(0);
  const recordCreateKey = JSON.stringify([session?.user.id, recordLevel, recordProjectId, recordView,
    recordTitle.trim(), recordContent.trim()]);
  const pendingRecordCreate = useRef<{ key: string; body: string } | null>(null);
  useEffect(function clearChangedRecordCreate() {
    if (pendingRecordCreate.current?.key !== recordCreateKey) pendingRecordCreate.current = null;
  }, [recordCreateKey]);
  const t = copy[locale];

  useEffect(() => {
    const languageTimer = window.setTimeout(() => {
      const nextLocale = detectLocale();
      setLocale(nextLocale);
      document.documentElement.lang = nextLocale;
    }, 0);
    return () => window.clearTimeout(languageTimer);
  }, []);

  useEffect(() => {
    let mounted = true;

    async function restoreSession() {
      const { session: nextSession, error: authError, authType } = await restoreBrowserSession();

      if (!mounted) return;

      if (authError) {
        setError("invalidLink");
        setView("login");
        return;
      }

      observeProjectSession(nextSession);
      setSession(nextSession);
      if (nextSession && (authType === "invite" || authType === "recovery")) {
        setEmail(nextSession.user.email ?? "");
        setView("set-password");
      } else {
        setView(nextSession ? "account" : "login");
      }
    }

    restoreSession();

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      observeProjectSession(nextSession);
      setSession(nextSession);
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session || view !== "account") return;
    let cancelled = false;
    const controller = new AbortController();
    const readGeneration = ++projectReadGeneration.current;
    const epoch = projectActor.current.epoch;
    const subject = session.user.id, token = session.access_token;
    const selection = projectSelectionToken;
    const current = () => !cancelled && !controller.signal.aborted && projectReadGeneration.current === readGeneration
      && projectActor.current.epoch === epoch && projectActor.current.subject === subject && projectActor.current.token === token;
    void runNativeRead("projects.list", async ({ signal, traceId, observe }) => {
      const response = await fetch("/v1/projects", {
        headers: { authorization: `Bearer ${token}`, ...(traceId ? { "x-kooyumi-read-trace": traceId } : {}) }, cache: "no-store", signal,
      });
      let responseTraceMatched: boolean | undefined;
      try {
        if (traceId) responseTraceMatched = response.headers.get("x-kooyumi-read-trace") === traceId;
      } catch { /* Echo inspection is diagnostic only, never a read precondition. */ }
      observe("response_headers", response.status, responseTraceMatched);
      const result = await readNativeJson(response) as { projects?: Project[] } | null;
      observe("json_decoded", response.status);
      if (!result || !Array.isArray(result.projects) || !result.projects.every(project => project
        && typeof project.id === "string" && typeof project.name === "string")) {
        throw new NativeReadFailure({ category: "payload", phase: "payload", status: response.status, type: "PayloadError" });
      }
      observe("payload_validated", response.status);
      return result.projects;
    }, { isCurrent: current, signal: controller.signal })
      .then(rows => {
        if (!current()) return;
        setProjects(rows);
        setProjectsOwner(selection);
        setProjectReadError(null);
      })
      .catch(() => {
        if (!current()) return;
        setProjects([]);
        setProjectsOwner(null);
        setProjectReadError(selection);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [session, view, projectSelectionToken, projectReload]);

  useEffect(() => {
    if (!session || view !== "account") return;
    let cancelled = false;
    fetch("/v1/records/config", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("record-config-failed");
        return response.json() as Promise<{ enabled: boolean }>;
      })
      .then((result) => {
        if (!cancelled) setRecordsEnabled(result.enabled);
      })
      .catch(() => {
        if (!cancelled) setRecordsEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, view]);

  async function refreshRecordList(key: string, selectionToken: object, token: string,
    level: RecordLevel, projectId: string, type: RecordView, signal?: AbortSignal) {
    const generation = ++recordReadGeneration.current;
    setRecordList({ key, selectionToken, status: "loading", records: [] });
    const current = () => activeRecordSelection.current === selectionToken
      && recordReadGeneration.current === generation && !signal?.aborted;
    const query = new URLSearchParams({ level, record_type: type });
    if (level === "project") query.set("project_id", projectId);
    try {
      const response = await fetch(`/v1/records?${query}`, {
        headers: { authorization: `Bearer ${token}` }, cache: "no-store", signal,
      });
      if (!response.ok) throw new Error("record-list-failed");
      const result = await response.json() as { records?: CluedRecord[];
        current_projection_unavailable?: boolean; projection_rebuild_required?: boolean };
      if (!Array.isArray(result.records)) throw new Error("invalid-record-list");
      if (!current()) return;
      const unknown = result.current_projection_unavailable === true || result.projection_rebuild_required === true;
      setRecordList({ key, selectionToken, status: unknown ? "unknown" : "ready", records: unknown ? [] : result.records });
    } catch {
      if (current()) setRecordList({ key, selectionToken, status: "error", records: [] });
    }
  }

  useEffect(function loadRecordView() {
    activeRecordSelection.current = recordSelectionToken;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      if (activeRecordSelection.current !== recordSelectionToken) return;
      setRecordError(false);
      setRecordBusy(false);
      if (!session || view !== "account" || !recordsEnabled || (recordLevel === "project" && !recordProjectId)) {
        ++recordReadGeneration.current;
        setRecordList({ key: recordSelectionKey, selectionToken: recordSelectionToken, status: "idle", records: [] });
        return;
      }
      void refreshRecordList(recordSelectionKey, recordSelectionToken, session.access_token,
        recordLevel, recordProjectId, recordView, controller.signal);
    }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [recordSelectionKey, recordSelectionToken, recordLevel, recordProjectId, recordView, recordsEnabled, session, view]);

  function resetNotices() {
    setError("");
    setMessage("");
    setMinimumPasswordError(undefined);
  }

  function changeLocale(nextLocale: Locale) {
    setLocale(nextLocale);
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, nextLocale);
    document.documentElement.lang = nextLocale;
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    resetNotices();
    setBusy(true);
    const result = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (result.error) {
      setError("invalidCredentials");
      return;
    }
    observeProjectSession(result.data.session);
    setSession(result.data.session);
    setPassword("");
    setView("account");
  }

  async function handleCreateAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    resetNotices();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError("passwordTooShort");
      setMinimumPasswordError(MIN_PASSWORD_LENGTH);
      return;
    }
    setBusy(true);
    const result = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (result.error) {
      const details = authErrorDetails(result.error.message);
      setError(details.key);
      setMinimumPasswordError(details.minimumPasswordLength);
      return;
    }
    setPassword("");
    setMessage("confirmationSent");
  }

  async function handleSetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    resetNotices();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError("passwordTooShort");
      setMinimumPasswordError(MIN_PASSWORD_LENGTH);
      return;
    }
    if (password !== confirmPassword) {
      setError("passwordMismatch");
      return;
    }
    setBusy(true);
    const result = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (result.error) {
      const details = authErrorDetails(result.error.message);
      setError(details.key);
      setMinimumPasswordError(details.minimumPasswordLength);
      return;
    }
    window.history.replaceState({}, "", window.location.pathname);
    setPassword("");
    setConfirmPassword("");
    setMessage("passwordSet");
    setView("account");
  }

  async function handleSignOut() {
    setBusy(true);
    await supabase.auth.signOut();
    setBusy(false);
    observeProjectSession(null);
    setSession(null);
    setEmail("");
    setView("login");
    resetNotices();
  }

  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !projectName.trim()) return;
    const name = projectName.trim();
    const subject = session.user.id, token = session.access_token;
    const epoch = projectActor.current.epoch, selection = projectSelectionToken;
    const current = () => projectActor.current.subject === subject && projectActor.current.token === token
      && projectActor.current.epoch === epoch;
    if (pendingProjectCreate.current?.subject !== session.user.id || pendingProjectCreate.current?.name !== name) {
      pendingProjectCreate.current = {
        subject: session.user.id,
        name,
        body: JSON.stringify({
          operation: "create",
          project_schema_version: 2,
          base_version: null,
          idempotency_key: crypto.randomUUID(),
          mutation: { name, progress_status: "not_started", aliases: [] },
          recognition: {
            confidence: 1,
            reason: "The account owner explicitly created this Project.",
            source: "v2_explicit_create",
            source_refs: [],
          },
        }),
      };
    }
    const pending = pendingProjectCreate.current;
    setProjectBusy(true);
    setProjectError(false);
    try {
      const response = await fetch("/v1/projects", {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.access_token}`,
          "content-type": "application/json",
        },
        body: pending.body,
      });
      if (!response.ok) throw new Error("project-create-failed");
      const result = (await response.json()) as {
        status: string;
        replayed?: boolean;
        target_refs?: { role: string; kind: string; id: string }[];
        supplemental?: { project?: Project };
      };
      if (!current() || pendingProjectCreate.current !== pending) return;
      if (result.status !== "committed") throw new Error("project-create-not-committed");
      let project = result.supplemental?.project;
      if (!project && result.replayed) {
        const projectId = result.target_refs?.find((ref) => ref.role === "primary" && ref.kind === "project")?.id;
        if (!projectId) throw new Error("project-create-reference-missing");
        const listed = await fetch("/v1/projects?limit=200", {
          headers: { authorization: `Bearer ${session.access_token}` },
        });
        if (!listed.ok) throw new Error("project-create-reload-failed");
        const data = (await listed.json()) as { projects?: Project[] };
        if (!current() || pendingProjectCreate.current !== pending) return;
        project = data.projects?.find((item) => item.id === projectId);
      }
      if (!project?.id) throw new Error("project-create-not-confirmed");
      const created = project;
      ++projectReadGeneration.current;
      setProjects((rows) => [created, ...rows.filter((item) => item.id !== created.id)]);
      setProjectsOwner(selection);
      setProjectReload(value => value + 1);
      pendingProjectCreate.current = null;
      setProjectName("");
    } catch {
      if (current() && pendingProjectCreate.current === pending) setProjectError(true);
    } finally {
      if (current() && (!pendingProjectCreate.current || pendingProjectCreate.current === pending)) setProjectBusy(false);
    }
  }

  async function updateProject(project: Project, action: "set_progress" | "archive", extra: Record<string, unknown> = {}) {
    if (!session) return;
    const subject = session.user.id, token = session.access_token, epoch = projectActor.current.epoch;
    const current = () => projectActor.current.subject === subject && projectActor.current.token === token
      && projectActor.current.epoch === epoch;
    setProjectBusy(true);
    setProjectError(false);
    try {
      const terminal = project.progress_status === "completed" || project.progress_status === "archived";
      let operation: "update" | "complete" | "archive" | "restore";
      const mutation: Record<string, unknown> = {};
      if (action === "archive") {
        operation = "archive";
      } else {
        const progress = extra.progress_status;
        if (progress === project.progress_status) return;
        if (terminal) {
          if (progress !== "active") throw new Error("project-restore-required");
          operation = "restore";
        } else if (progress === "completed") {
          operation = "complete";
        } else if (progress === "archived") {
          operation = "archive";
        } else if (progress === "not_started" || progress === "active" || progress === "paused") {
          operation = "update";
          mutation.progress_status = progress;
        } else {
          throw new Error("unsupported-project-progress");
        }
      }
      const response = await fetch(`/v1/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${session.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          operation,
          project_schema_version: 2,
          base_version: project.version,
          idempotency_key: crypto.randomUUID(),
          mutation,
        }),
      });
      if (!response.ok) throw new Error("project-update-failed");
      const result = (await response.json()) as { status: string; supplemental?: { project?: Project } };
      const updated = result.supplemental?.project;
      if (result.status !== "committed" || updated?.id !== project.id || updated.version <= project.version) {
        throw new Error("project-update-not-committed");
      }
      if (!current()) return;
      ++projectReadGeneration.current;
      setProjects((rows) => rows.map((item) => item.id === project.id ? updated : item));
      setProjectReload(value => value + 1);
    } catch {
      if (current()) setProjectError(true);
    } finally {
      if (current()) setProjectBusy(false);
    }
  }

  async function handleCreateRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || recordBusy || recordView === "archive" || recordView === "log") return;
    if (recordLevel === "project" && !recordProjectId) return;
    if (!recordTitle.trim() || !recordContent.trim()) return;
    const submissionKey = recordSelectionKey;
    const submissionToken = recordSelectionToken;
    const current = () => activeRecordSelection.current === submissionToken;
    setRecordBusy(true);
    setRecordError(false);
    ++recordReadGeneration.current;
    setRecordList({ key: submissionKey, selectionToken: submissionToken, status: "loading", records: [] });
    const idempotencyKey = crypto.randomUUID();
    const input: Record<string, unknown> = {
      operation: "create",
      id: crypto.randomUUID(),
      idempotency_key: idempotencyKey,
      record_schema_version: 1,
      lifecycle_status: "active",
      base_version: null,
      scope: recordLevel === "project" ? `project:${recordProjectId}` : "global",
      record_type: recordView,
      source_refs: [],
      source_unavailable_reason: "Direct user entry in BeamingFace",
      mutation: {
        title: recordTitle.trim(),
        content: recordContent.trim(),
        type_fields: recordView === "task" ? { execution_bucket: "later" }
          : recordView === "decision" ? { rationale: recordContent.trim() } : { state_kind: "manual" },
        relations: {},
      },
      authority: "user_explicit",
      user_confirmed: true,
      confidence: 1,
      confidence_reason: "Direct user entry in BeamingFace",
    };
    if (pendingRecordCreate.current?.key !== recordCreateKey) {
      pendingRecordCreate.current = { key: recordCreateKey, body: JSON.stringify(input) };
    }
    const pending = pendingRecordCreate.current;
    try {
      const response = await fetch("/v1/records", {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.access_token}`,
          "content-type": "application/json",
        },
        body: pending.body,
      });
      if (!response.ok) throw new Error("record-write-failed");
      const result = (await response.json()) as { status?: string; receipt_id?: string };
      if (result.status !== "committed" || !result.receipt_id) throw new Error("record-write-not-committed");
      if (!current() || pendingRecordCreate.current !== pending) return;
      pendingRecordCreate.current = null;
      setRecordTitle("");
      setRecordContent("");
      await refreshRecordList(submissionKey, submissionToken, session.access_token, recordLevel, recordProjectId, recordView);
    } catch {
      if (current()) {
        setRecordError(true);
        setRecordList({ key: submissionKey, selectionToken: submissionToken, status: "error", records: [] });
      }
    } finally {
      if (current()) setRecordBusy(false);
    }
  }

  const projectProgressLabels = {
    not_started: t.progressNotStarted,
    active: t.progressActive,
    paused: t.progressPaused,
    completed: t.progressCompleted,
    archived: t.progressArchived,
  };
  const recordStatus = !session || view !== "account" || !recordsEnabled || (recordLevel === "project" && !recordProjectId)
    ? "idle" : recordList.key === recordSelectionKey && recordList.selectionToken === recordSelectionToken ? recordList.status : "loading";
  const visibleRecords = recordStatus === "ready" ? recordList.records : [];
  const recordViewLabels: Record<RecordView, string> = {
    state: t.stateView,
    task: t.taskView,
    decision: t.decisionView,
    archive: t.archiveView,
    log: t.logView,
  };

  const isCreate = view === "create";
  const isPasswordSetup = view === "set-password";

  return (
    <main className="shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar">
        <Link className="brand" href="/" aria-label={t.homeLabel}>
          <span className="brand-mark" aria-hidden="true" />
          <span>BeamingFace</span>
        </Link>
        <div className="header-actions">
          <Link href="/contexts">{locale === "zh-CN" ? "上下文" : "Contexts"}</Link>
          <Link href="/grants">{locale === "zh-CN" ? "我的授权" : "Grants"}</Link>
          <Link href="/agent-messages">{locale === "zh-CN" ? "Agent 消息" : "Agent messages"}</Link>
          <Link href="/merge-queue">{locale === "zh-CN" ? "合并排队" : "Merge queue"}</Link>
          <span className="byline">{t.byline}</span>
          <div className="language-switch" role="group" aria-label={t.languageLabel}>
            <button
              type="button"
              className={locale === "zh-CN" ? "active" : ""}
              onClick={() => changeLocale("zh-CN")}
              aria-pressed={locale === "zh-CN"}
            >
              中文
            </button>
            <button
              type="button"
              className={locale === "en" ? "active" : ""}
              onClick={() => changeLocale("en")}
              aria-pressed={locale === "en"}
            >
              EN
            </button>
          </div>
        </div>
      </header>

      <section className="content">
        <div className="intro">
          <p className="eyebrow">{t.eyebrow}</p>
          <h1>
            {t.headlineOne}
            <br />
            <span>{t.headlineTwo}</span>
          </h1>
          <p className="lede">{t.lede}</p>
          <div className="trust-row" aria-label={t.principlesLabel}>
            <span>{t.privateDefault}</span>
            <span>{t.scopedAccess}</span>
            <span>{t.revocable}</span>
          </div>
        </div>

        <div className={view === "account" ? "auth-card auth-card-account" : "auth-card"}>
          {view === "loading" && (
            <div className="loading-state" role="status">
              <span className="spinner" />
              <p>{t.securingSession}</p>
            </div>
          )}

          {(view === "login" || view === "create") && (
            <>
              <div className="card-heading">
                <p className="step-label">{t.accountLabel}</p>
                <h2>{isCreate ? t.createTitle : t.welcomeTitle}</h2>
                <p>{isCreate ? t.createDescription : t.loginDescription}</p>
              </div>

              <form
                className="auth-form"
                onSubmit={isCreate ? handleCreateAccount : handleLogin}
              >
                <label>
                  {t.email}
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    required
                  />
                </label>
                <label>
                  {t.password}
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={t.passwordPlaceholder}
                    autoComplete={isCreate ? "new-password" : "current-password"}
                    minLength={MIN_PASSWORD_LENGTH}
                    maxLength={MAX_PASSWORD_LENGTH}
                    required
                  />
                </label>
                {error && (
                  <p className="notice error">
                    {authErrorText(error, locale, minimumPasswordError)}
                  </p>
                )}
                {message && <p className="notice success">{t[message]}</p>}
                <button className="primary-button" type="submit" disabled={busy}>
                  {busy ? t.pleaseWait : isCreate ? t.createAccount : t.signIn}
                </button>
              </form>

              <button
                className="text-button"
                type="button"
                onClick={() => {
                  resetNotices();
                  setPassword("");
                  setView(isCreate ? "login" : "create");
                }}
              >
                {isCreate ? t.existingAccount : t.newAccount}
              </button>
            </>
          )}

          {isPasswordSetup && (
            <>
              <div className="card-heading">
                <p className="step-label">{t.invitationAccepted}</p>
                <h2>{t.setPasswordTitle}</h2>
                <p>
                  {t.finishActivationBefore} <strong>{email}</strong>
                  {t.finishActivationAfter}
                </p>
              </div>
              <form className="auth-form" onSubmit={handleSetPassword}>
                <label>
                  {t.newPassword}
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={t.passwordPlaceholder}
                    autoComplete="new-password"
                    minLength={MIN_PASSWORD_LENGTH}
                    maxLength={MAX_PASSWORD_LENGTH}
                    required
                  />
                </label>
                <label>
                  {t.confirmPassword}
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder={t.confirmPlaceholder}
                    autoComplete="new-password"
                    minLength={MIN_PASSWORD_LENGTH}
                    maxLength={MAX_PASSWORD_LENGTH}
                    required
                  />
                </label>
                {error && <p className="notice error">{t[error]}</p>}
                <button className="primary-button" type="submit" disabled={busy}>
                  {busy ? t.saving : t.activateClued}
                </button>
              </form>
            </>
          )}

          {view === "account" && (
            <div className="account-state">
              <div className="status-dot" aria-hidden="true" />
              <p className="step-label">{t.accountActive}</p>
              <h2>{t.accountReadyTitle}</h2>
              <p className="account-email">{session?.user.email}</p>
              <p className="account-copy">{t.accountReadyCopy}</p>
              {message && <p className="notice success">{t[message]}</p>}
              <div className="projects-panel">
                <div className="continuity-heading">
                  <div>
                    <h3>{t.projectsTitle}</h3>
                    <p>{t.projectsCopy}</p>
                  </div>
                </div>
                <form className="project-create-form" onSubmit={handleCreateProject}>
                  <label>
                    {t.newProject}
                    <input
                      value={projectName}
                      onChange={(event) => setProjectName(event.target.value)}
                      placeholder={t.newProjectPlaceholder}
                      maxLength={120}
                      required
                    />
                  </label>
                  <button className="primary-button" type="submit" disabled={projectBusy}>
                    {projectBusy ? t.addingProject : t.addProject}
                  </button>
                </form>
                {projectError && <p className="notice error">{t.projectError}</p>}
                {!projectsConfirmed && !projectReadFailed && <p className="notice" role="status">{t.projectsLoading}</p>}
                {projectReadFailed && <p className="notice error" role="alert">{t.projectsReadUnknown}
                  <button type="button" onClick={() => setProjectReload(value => value + 1)}>{t.retryProjectRead}</button>
                </p>}
                <div className="project-columns">
                  <section className="project-group">
                      <h4>{t.projectList}<span>{projectsConfirmed ? visibleProjects.length : "—"}</span></h4>
                      {projectsConfirmed && visibleProjects.length === 0 ? <p className="empty-bindings">{t.noProjects}</p> : visibleProjects.map((project) => (
                        <article className="project-item" key={project.id}>
                          <div>
                            <strong>{project.name}</strong>
                            <span>{projectProgressLabels[project.progress_status]}</span>
                          </div>
                          <div className="project-actions">
                            <select
                              aria-label={`${project.name} progress`}
                              value={project.progress_status}
                              onChange={(event) => updateProject(project, "set_progress", { progress_status: event.target.value })}
                              disabled={projectBusy}
                            >
                              {Object.entries(projectProgressLabels)
                                .filter(([value]) => !["completed", "archived"].includes(project.progress_status) || value === "active" || value === project.progress_status)
                                .map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                            </select>
                            {project.progress_status !== "archived" && <button type="button" onClick={() => updateProject(project, "archive")} disabled={projectBusy}>
                              {t.archiveProject}
                            </button>}
                          </div>
                        </article>
                      ))}
                    </section>
                </div>
              </div>
              {recordsEnabled && session && <ImprintPanel key={session.user.id} session={session} projects={visibleProjects} locale={locale} />}
              {recordsEnabled && (
                <details className="legacy-work-views">
                  <summary>{locale === "zh-CN" ? "查看原有工作视图" : "Original work views"}</summary>
                <div className="records-panel">
                  <div className="continuity-heading">
                    <div>
                      <h3>{t.workViewsTitle}</h3>
                      <p>{t.workViewsCopy}</p>
                    </div>
                    <span className="protocol-badge">V2</span>
                  </div>
                  <div className="record-levels" role="group" aria-label={t.workViewsTitle}>
                    {(["global", "project"] as const).map((level) => (
                      <button
                        type="button"
                        className={recordLevel === level ? "active" : ""}
                        onClick={() => setRecordLevel(level)}
                        key={level}
                      >
                        {level === "global" ? t.globalLevel : t.projectLevel}
                      </button>
                    ))}
                  </div>
                  {recordLevel === "project" && (
                    <select
                      aria-label={t.chooseProject}
                      value={recordProjectId}
                      onChange={(event) => setRecordProjectId(event.target.value)}
                    >
                      <option value="">{t.chooseProject}</option>
                      {visibleProjects.map((project) => (
                        <option value={project.id} key={project.id}>{project.name}</option>
                      ))}
                    </select>
                  )}
                  <div className="record-tabs" role="tablist" aria-label={t.workViewsTitle}>
                    {(Object.keys(recordViewLabels) as RecordView[]).map((item) => (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={recordView === item}
                        className={recordView === item ? "active" : ""}
                        onClick={() => setRecordView(item)}
                        key={item}
                      >
                        {recordViewLabels[item]}
                      </button>
                    ))}
                  </div>
                  {recordView !== "archive" && recordView !== "log" && (
                    <form className="record-form" onSubmit={handleCreateRecord}>
                      <input
                        aria-label={t.workRecordTitle}
                        value={recordTitle}
                        onChange={(event) => setRecordTitle(event.target.value)}
                        placeholder={t.workRecordTitle}
                        maxLength={120}
                        required
                      />
                      <textarea
                        aria-label={t.workRecordContent}
                        value={recordContent}
                        onChange={(event) => setRecordContent(event.target.value)}
                        placeholder={t.workRecordContent}
                        maxLength={8000}
                        rows={3}
                        required
                      />
                      <button className="primary-button" type="submit" disabled={recordBusy}>
                        {recordBusy ? t.savingMemory : t.addWorkRecord}
                      </button>
                    </form>
                  )}
                  {(recordError || recordStatus === "error") && <p className="notice error" role="alert">{t.workViewsError}</p>}
                  {recordStatus === "loading" && <p className="notice" role="status">{t.workRecordsLoading}</p>}
                  {recordStatus === "unknown" && <p className="notice" role="status">{t.workRecordsUnknown}</p>}
                  {recordStatus === "idle" && recordLevel === "project" && <p className="notice">{t.workRecordsSelectProject}</p>}
                  <div className="record-list">
                    {recordStatus === "ready" && visibleRecords.length === 0 ? (
                      <p className="empty-bindings">{t.noWorkRecords}</p>
                    ) : visibleRecords.map((record) => {
                      const item = presentCluedRecord(record, recordViewLabels[recordView]);
                      const display = presentCluedRecordDisplay(record, recordViewLabels[recordView], locale);
                      if (record.record_type === "log") {
                        const card = presentCluedLogCard(record, recordViewLabels[recordView], locale);
                        return (
                          <article className={`record-item log-card tone-${card.tone}`} key={item.id}>
                            <div className="log-card-head">
                              <span className="log-card-dot" aria-hidden="true" />
                              <strong>{card.title}</strong>
                              <time className="log-card-time" dateTime={item.updatedAt}>
                                {formatRecordTime(item.updatedAt, locale)}
                              </time>
                            </div>
                            <p className="log-card-summary">{card.summary}</p>
                            {card.tags.length > 0 && (
                              <div className="log-card-tags">
                                {card.tags.map((tag) => (
                                  <span className="log-card-tag" key={tag}>{tag}</span>
                                ))}
                              </div>
                            )}
                            {card.rawDetails && (
                              <details className="record-details">
                                <summary>{t.viewEvidence}</summary>
                                {card.evidence.length > 0 && (
                                  <div className="log-detail-group">
                                    <h5>{t.evidenceLabel}</h5>
                                    <dl className="log-detail-list">
                                      {card.evidence.map((detail, index) => (
                                        <div className="log-detail-row" key={`${detail.label}-${index}`}>
                                          <dt>{detail.label}</dt>
                                          <dd>{detail.value}</dd>
                                        </div>
                                      ))}
                                    </dl>
                                  </div>
                                )}
                                <div className="log-detail-group">
                                  <h5>{t.metadataLabel}</h5>
                                  <dl className="log-detail-list">
                                    {card.metadata.map((detail) => (
                                      <div className="log-detail-row" key={detail.label}>
                                        <dt>{detail.label}</dt>
                                        <dd>{detail.value}</dd>
                                      </div>
                                    ))}
                                  </dl>
                                </div>
                                <details className="record-raw-details">
                                  <summary>{t.viewFullJson}</summary>
                                  <div className="log-detail-group">
                                    <h5>{t.rawRecordLabel}</h5>
                                    <pre>{card.rawDetails}</pre>
                                  </div>
                                </details>
                              </details>
                            )}
                          </article>
                        );
                      }
                      return (
                        <article className="record-item" key={item.id}>
                          <div>
                            <strong>{display.title}</strong>
                            <span className="record-meta">
                              {display.status} · {t.canonicalIdLabel}: {item.id} ·{" "}
                              <time dateTime={display.updatedAt}>{new Date(display.updatedAt).toLocaleString(locale)}</time>
                            </span>
                          </div>
                          <p>{display.summary || item.conclusion}</p>
                          <span className="record-version-badge">
                            {item.version === null ? t.versionNotRecorded : `v${item.version}`}
                          </span>
                          {display.rawDetails && (
                            <details className="record-details">
                              <summary>{t.viewRawRecord}</summary>
                              <pre>{display.rawDetails}</pre>
                            </details>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </div>
                </details>
              )}
              <div className="continuity-panel">
                <div className="continuity-heading">
                  <div>
                    <h3>{t.continuityTitle}</h3>
                    <p>{t.continuityCopy}</p>
                  </div>
                  <span className="protocol-badge">{t.continuityProtocol}</span>
                </div>

                <p className="binding-how">
                  {t.connectHow} <Link href="/oauth/connections">{t.manageConnections}</Link>
                </p>
              </div>
              <button
                className="secondary-button"
                type="button"
                onClick={handleSignOut}
                disabled={busy}
              >
                {busy ? t.signingOut : t.signOut}
              </button>
            </div>
          )}
        </div>
      </section>

      <footer>
        <span>{t.copyright}</span>
        <a href="/THIRD-PARTY-NOTICES.txt">{locale === "zh-CN" ? "开源许可" : "Open-source licenses"}</a>
        <span>{t.previewStatus}</span>
      </footer>
    </main>
  );
}
