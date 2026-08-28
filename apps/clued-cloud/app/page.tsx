"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { createClient, Session } from "@supabase/supabase-js";
import Link from "next/link";
import { presentCluedRecord, presentCluedRecordDisplay, type CluedRecord } from "./record-presentation";

const SUPABASE_URL = "https://ccxsikzwxlolxqlosril.supabase.co";
const SUPABASE_PUBLISHABLE_KEY =
  "sb_publishable_tVKKh7Ok4FhBhHtHyZfwBA_i2RJD2Fg";
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const LANGUAGE_STORAGE_KEY = "clued-language";

type View = "loading" | "login" | "create" | "set-password" | "account";
type Locale = "zh-CN" | "en";
type Binding = {
  id: string;
  vendor: string;
  agent_name: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};
type IssuedBinding = { token: string; mcpUrl: string; binding: Binding };
type Project = {
  id: string;
  name: string;
  certainty_status: "unconfirmed" | "confirmed";
  progress_status: "not_started" | "active" | "paused" | "completed" | "archived";
  summary: string | null;
  confidence: number;
  version: number;
  updated_at: string;
};
type RecordView = "state" | "task" | "decision" | "archive" | "log";
type RecordLevel = "global" | "project";
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
    homeLabel: "Clued home",
    byline: "Clued by Pixel Gravity",
    languageLabel: "Language",
    eyebrow: "Private context infrastructure",
    headlineOne: "One you.",
    headlineTwo: "Every AI.",
    lede: "Keep a single, user-controlled memory layer and share only the context each authorized AI needs.",
    principlesLabel: "Clued principles",
    privateDefault: "Private by default",
    scopedAccess: "Scoped access",
    revocable: "Revocable",
    securingSession: "Securing your session…",
    accountLabel: "Clued account",
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
    newAccount: "New to Clued? Create an account",
    invitationAccepted: "Invitation accepted",
    setPasswordTitle: "Set your password",
    finishActivationBefore: "Finish activating",
    finishActivationAfter: ". Use 8–128 characters.",
    newPassword: "New password",
    confirmPassword: "Confirm password",
    confirmPlaceholder: "Repeat your password",
    saving: "Saving…",
    activateClued: "Activate Clued",
    accountActive: "Account active",
    accountReadyTitle: "You’re in.",
    accountReadyCopy: "Your Clued identity is ready. Device and AI bindings will appear here as they are connected.",
    memoriesTitle: "My memories",
    memoriesCopy: "Create and manage the private context you want Clued to remember.",
    memoryTitle: "Title",
    memoryTitlePlaceholder: "What should Clued remember?",
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
    memoryError: "Clued could not update your memories. Please try again.",
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
    vendor: "Provider",
    agentName: "Agent name",
    agentPlaceholder: "e.g. My ChatGPT",
    createBinding: "Create AI connection",
    creatingBinding: "Creating secure connection…",
    connectionReady: "Connection ready",
    connectionReadyCopy: "Add this MCP endpoint and one-time token to the AI client. Clued never shows the token again.",
    mcpEndpoint: "MCP endpoint",
    bindingToken: "One-time binding token",
    copy: "Copy",
    copied: "Copied",
    activeConnections: "Authorized AI connections",
    noConnections: "No AI connections yet.",
    lastUsed: "Last used",
    neverUsed: "Not used yet",
    revoke: "Revoke",
    bindingError: "Clued could not update AI connections. The continuity database may still need its migration.",
    continuityProtocol: "Automatic protocol: restore → work events → checkpoint",
    projectsTitle: "Projects",
    projectsCopy: "A mention starts as unconfirmed. Explicit intent or real work promotes the same project without losing its history.",
    newProject: "Project name",
    newProjectPlaceholder: "Mention or add a project",
    addUnconfirmed: "Add as unconfirmed",
    addingProject: "Adding…",
    unconfirmedProjects: "Unconfirmed projects",
    confirmedProjects: "Confirmed projects",
    noUnconfirmedProjects: "No unconfirmed projects.",
    noConfirmedProjects: "No confirmed projects.",
    confirmProject: "Confirm",
    dismissProject: "Dismiss",
    projectError: "Clued could not update projects. The lifecycle migration may still need to be applied.",
    progressNotStarted: "Not started",
    progressActive: "Active",
    progressPaused: "Paused",
    progressCompleted: "Completed",
    progressArchived: "Archived",
    workViewsTitle: "Current work",
    workViewsCopy: "Read global priority first, then project State, Tasks and Decisions. Log and Archive are evidence on demand; every view keeps the same canonical ID.",
    globalLevel: "Global",
    projectLevel: "Project",
    chooseProject: "Choose a confirmed project",
    stateView: "State",
    taskView: "Tasks",
    decisionView: "Decisions",
    archiveView: "Archive",
    logView: "Log",
    noWorkRecords: "No records in this view.",
    workRecordTitle: "Title",
    workRecordContent: "Detail",
    canonicalIdLabel: "Canonical ID",
    viewStructuredRecord: "View structured record",
    addWorkRecord: "Add canonical record",
    workViewsError: "Clued could not load the unified work views.",
    signingOut: "Signing out…",
    signOut: "Sign out",
    copyright: "© 2026 Pixel Gravity",
    previewStatus: "Clued · Controlled Public Preview",
    invalidLink: "This sign-in link is invalid or has expired. Request a new invitation.",
    invalidCredentials: "Email or password is incorrect.",
    passwordTooShort: "Use at least 8 characters for your password.",
    passwordMismatch: "The passwords do not match.",
    accountExists: "An account with this email already exists. Sign in instead.",
    rateLimited: "Too many attempts. Please wait a moment and try again.",
    genericAuthError: "Clued could not complete that request. Please try again.",
    confirmationSent: "Check your email to confirm your Clued account.",
    passwordSet: "Password set. Your Clued account is ready.",
  },
  "zh-CN": {
    homeLabel: "Clued 首页",
    byline: "Clued by Pixel Gravity",
    languageLabel: "语言",
    eyebrow: "私人上下文基础设施",
    headlineOne: "一个你。",
    headlineTwo: "每个 AI，都懂你。",
    lede: "用一个由你掌控的统一记忆层，只向每个已授权的 AI 分享它真正需要的上下文。",
    principlesLabel: "Clued 原则",
    privateDefault: "默认私密",
    scopedAccess: "范围可控",
    revocable: "随时撤销",
    securingSession: "正在安全恢复登录状态…",
    accountLabel: "Clued 账户",
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
    newAccount: "第一次使用 Clued？创建账户",
    invitationAccepted: "邀请已接受",
    setPasswordTitle: "设置密码",
    finishActivationBefore: "完成账户激活：",
    finishActivationAfter: "。密码请使用 8–128 个字符。",
    newPassword: "新密码",
    confirmPassword: "确认密码",
    confirmPlaceholder: "再次输入密码",
    saving: "正在保存…",
    activateClued: "激活 Clued",
    accountActive: "账户已激活",
    accountReadyTitle: "登录成功",
    accountReadyCopy: "你的 Clued 身份已经就绪。设备和 AI 连接将在接入后显示在这里。",
    memoriesTitle: "我的记忆",
    memoriesCopy: "新增并管理你希望 Clued 长期记住的私人上下文。",
    memoryTitle: "标题",
    memoryTitlePlaceholder: "希望 Clued 记住什么？",
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
    memoryError: "Clued 暂时无法更新你的记忆，请重试。",
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
    vendor: "厂商",
    agentName: "智能体名称",
    agentPlaceholder: "例如：我的 ChatGPT",
    createBinding: "创建 AI 连接",
    creatingBinding: "正在创建安全连接…",
    connectionReady: "连接已就绪",
    connectionReadyCopy: "把这个 MCP 地址和一次性令牌添加到 AI 客户端。Clued 不会再次显示令牌。",
    mcpEndpoint: "MCP 地址",
    bindingToken: "一次性绑定令牌",
    copy: "复制",
    copied: "已复制",
    activeConnections: "已授权的 AI 连接",
    noConnections: "还没有 AI 连接。",
    lastUsed: "上次使用",
    neverUsed: "尚未使用",
    revoke: "撤销",
    bindingError: "Clued 暂时无法更新 AI 连接；连续性数据库迁移可能尚未生效。",
    continuityProtocol: "自动协议：恢复 → 工作事件 → 检查点",
    projectsTitle: "项目",
    projectsCopy: "提到项目时先进入未确定；明确意图或开始实质工作后，原项目会直接晋级，历史不会丢失。",
    newProject: "项目名称",
    newProjectPlaceholder: "提到或添加一个项目",
    addUnconfirmed: "加入未确定项目",
    addingProject: "正在添加…",
    unconfirmedProjects: "未确定项目",
    confirmedProjects: "已确定项目",
    noUnconfirmedProjects: "暂无未确定项目。",
    noConfirmedProjects: "暂无已确定项目。",
    confirmProject: "确定",
    dismissProject: "忽略",
    projectError: "Clued 暂时无法更新项目；项目生命周期迁移可能尚未生效。",
    progressNotStarted: "未开始",
    progressActive: "进行中",
    progressPaused: "已暂停",
    progressCompleted: "已完成",
    progressArchived: "已归档",
    workViewsTitle: "当前工作",
    workViewsCopy: "先读全局优先级，再读项目状态、任务和决策；日志与归档仅按需作证据，每个视图保留同一个 canonical ID。",
    globalLevel: "全局",
    projectLevel: "项目",
    chooseProject: "选择一个已确定项目",
    stateView: "状态",
    taskView: "任务",
    decisionView: "决策",
    archiveView: "归档",
    logView: "日志",
    noWorkRecords: "此视图暂无记录。",
    workRecordTitle: "标题",
    workRecordContent: "详细内容",
    canonicalIdLabel: "Canonical ID",
    viewStructuredRecord: "查看结构化记录",
    addWorkRecord: "新增 canonical 记录",
    workViewsError: "Clued 暂时无法加载统一工作视图。",
    signingOut: "正在退出…",
    signOut: "退出登录",
    copyright: "© 2026 Pixel Gravity",
    previewStatus: "Clued · 受控公开预览",
    invalidLink: "此登录链接无效或已过期，请重新申请邀请。",
    invalidCredentials: "电子邮件或密码不正确。",
    passwordTooShort: "密码至少需要 8 个字符。",
    passwordMismatch: "两次输入的密码不一致。",
    accountExists: "该电子邮件已注册，请直接登录。",
    rateLimited: "尝试次数过多，请稍后再试。",
    genericAuthError: "Clued 暂时无法完成此请求，请重试。",
    confirmationSent: "确认邮件已发送，请前往邮箱完成 Clued 账户确认。",
    passwordSet: "密码设置成功，你的 Clued 账户已就绪。",
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
  const supabase = useMemo(
    () =>
      createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
        },
      }),
    [],
  );

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
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [bindingVendor, setBindingVendor] = useState("OpenAI");
  const [bindingAgentName, setBindingAgentName] = useState("");
  const [bindingBusy, setBindingBusy] = useState(false);
  const [bindingError, setBindingError] = useState(false);
  const [issuedBinding, setIssuedBinding] = useState<IssuedBinding | null>(null);
  const [copiedField, setCopiedField] = useState<"endpoint" | "token" | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectName, setProjectName] = useState("");
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState(false);
  const [recordsEnabled, setRecordsEnabled] = useState(false);
  const [recordView, setRecordView] = useState<RecordView>("state");
  const [recordLevel, setRecordLevel] = useState<RecordLevel>("global");
  const [recordProjectId, setRecordProjectId] = useState("");
  const [records, setRecords] = useState<CluedRecord[]>([]);
  const [recordTitle, setRecordTitle] = useState("");
  const [recordContent, setRecordContent] = useState("");
  const [recordBusy, setRecordBusy] = useState(false);
  const [recordError, setRecordError] = useState(false);
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
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const query = new URLSearchParams(window.location.search);
      const accessToken = hash.get("access_token");
      const refreshToken = hash.get("refresh_token");
      const authType = hash.get("type") ?? query.get("type");

      let nextSession: Session | null = null;
      let authError: Error | null = null;

      if (accessToken && refreshToken) {
        const result = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        nextSession = result.data.session;
        authError = result.error;
      } else if (query.get("code")) {
        const result = await supabase.auth.exchangeCodeForSession(
          query.get("code") as string,
        );
        nextSession = result.data.session;
        authError = result.error;
      } else {
        const result = await supabase.auth.getSession();
        nextSession = result.data.session;
        authError = result.error;
      }

      if (!mounted) return;

      if (authError) {
        setError("invalidLink");
        setView("login");
        return;
      }

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
      setSession(nextSession);
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, [supabase]);

  useEffect(() => {
    if (!session || view !== "account") return;
    let cancelled = false;
    Promise.allSettled([
      fetch("/api/bindings", {
        headers: { authorization: `Bearer ${session.access_token}` },
      }).then(async (response) => {
        if (!response.ok) throw new Error("binding-list-failed");
        return response.json() as Promise<{ bindings: Binding[] }>;
      }),
      fetch("/v1/projects", {
        headers: { authorization: `Bearer ${session.access_token}` },
      }).then(async (response) => {
        if (!response.ok) throw new Error("project-list-failed");
        return response.json() as Promise<{ projects: Project[] }>;
      }),
    ])
      .then(([bindingResult, projectResult]) => {
        if (cancelled) return;
        if (bindingResult.status === "fulfilled") {
          setBindings(bindingResult.value.bindings.filter((binding) => !binding.revoked_at));
          setBindingError(false);
        } else {
          setBindingError(true);
        }
        if (projectResult.status === "fulfilled") {
          setProjects(projectResult.value.projects);
          setProjectError(false);
        } else {
          setProjectError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session, view]);

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

  useEffect(() => {
    if (!session || view !== "account" || !recordsEnabled) return;
    if (recordLevel === "project" && !recordProjectId) {
      return;
    }
    let cancelled = false;
    const query = new URLSearchParams({ level: recordLevel, record_type: recordView });
    if (recordLevel === "project") query.set("project_id", recordProjectId);
    fetch(`/v1/records?${query}`, {
      headers: { authorization: `Bearer ${session.access_token}` },
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("record-list-failed");
        return response.json() as Promise<{ records: CluedRecord[] }>;
      })
      .then((result) => {
        if (!cancelled) {
          setRecords(result.records);
          setRecordError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setRecordError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [recordLevel, recordProjectId, recordView, recordsEnabled, session, view]);

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
    setSession(null);
    setEmail("");
    setView("login");
    resetNotices();
  }

  async function handleCreateBinding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setBindingBusy(true);
    setBindingError(false);
    setIssuedBinding(null);
    try {
      const response = await fetch("/api/bindings", {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          vendor: bindingVendor,
          agentName: bindingAgentName || `${bindingVendor} agent`,
          scopes: ["context:read", "context:write", "audit:read"],
        }),
      });
      if (!response.ok) throw new Error("binding-create-failed");
      const result = (await response.json()) as IssuedBinding;
      setIssuedBinding(result);
      setBindings((current) => [result.binding, ...current]);
      setBindingAgentName("");
    } catch {
      setBindingError(true);
    } finally {
      setBindingBusy(false);
    }
  }

  async function handleRevokeBinding(id: string) {
    if (!session) return;
    setBindingBusy(true);
    setBindingError(false);
    try {
      const response = await fetch(`/api/bindings?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${session.access_token}` },
      });
      if (!response.ok) throw new Error("binding-revoke-failed");
      setBindings((current) => current.filter((binding) => binding.id !== id));
      if (issuedBinding?.binding.id === id) setIssuedBinding(null);
    } catch {
      setBindingError(true);
    } finally {
      setBindingBusy(false);
    }
  }

  async function copyValue(field: "endpoint" | "token", value: string) {
    await navigator.clipboard.writeText(value);
    setCopiedField(field);
    window.setTimeout(() => setCopiedField(null), 1600);
  }

  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !projectName.trim()) return;
    setProjectBusy(true);
    setProjectError(false);
    try {
      const response = await fetch("/v1/projects/observe", {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: projectName.trim(),
          intent: "possible",
          confidence: 1,
          source_ref: "clued-project-ui",
          idempotency_key: crypto.randomUUID(),
        }),
      });
      if (!response.ok) throw new Error("project-create-failed");
      const result = (await response.json()) as { project: Project | null };
      if (result.project) {
        setProjects((current) => [result.project as Project, ...current.filter((item) => item.id !== result.project?.id)]);
      }
      setProjectName("");
    } catch {
      setProjectError(true);
    } finally {
      setProjectBusy(false);
    }
  }

  async function updateProject(project: Project, action: string, extra: Record<string, unknown> = {}) {
    if (!session) return;
    setProjectBusy(true);
    setProjectError(false);
    try {
      const response = await fetch(`/v1/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${session.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action,
          base_version: project.version,
          idempotency_key: crypto.randomUUID(),
          ...extra,
        }),
      });
      if (!response.ok) throw new Error("project-update-failed");
      const result = (await response.json()) as { project: Project };
      setProjects((current) =>
        action === "dismiss"
          ? current.filter((item) => item.id !== project.id)
          : current.map((item) => (item.id === project.id ? result.project : item)),
      );
    } catch {
      setProjectError(true);
    } finally {
      setProjectBusy(false);
    }
  }

  async function handleCreateRecord(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || recordView === "archive" || recordView === "log") return;
    if (recordLevel === "project" && !recordProjectId) return;
    setRecordBusy(true);
    setRecordError(false);
    const idempotencyKey = crypto.randomUUID();
    const input: Record<string, unknown> = {
      action: "create",
      idempotency_key: idempotencyKey,
      scope: recordLevel,
      record_type: recordView,
      title: recordTitle,
      content: recordContent,
      source_ref: "clued-work-ui",
    };
    if (recordLevel === "project") input.project_id = recordProjectId;
    if (recordView === "state") {
      input.status = "current";
      input.record_key = "current-work";
    } else if (recordView === "task") {
      input.status = "backlog";
    } else if (recordView === "decision") {
      input.status = "active";
      input.record_key = `decision:${idempotencyKey}`;
    }
    try {
      const response = await fetch("/v1/records", {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error("record-write-failed");
      const result = (await response.json()) as { record: CluedRecord };
      setRecords((current) => [result.record, ...current.filter((item) => item.id !== result.record.id)]);
      setRecordTitle("");
      setRecordContent("");
    } catch {
      setRecordError(true);
    } finally {
      setRecordBusy(false);
    }
  }

  const projectProgressLabels = {
    not_started: t.progressNotStarted,
    active: t.progressActive,
    paused: t.progressPaused,
    completed: t.progressCompleted,
    archived: t.progressArchived,
  };
  const unconfirmedProjects = projects.filter((project) => project.certainty_status === "unconfirmed");
  const confirmedProjects = projects.filter((project) => project.certainty_status === "confirmed");
  const visibleRecords = recordLevel === "project" && !recordProjectId ? [] : records;
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
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span>Clued</span>
        </Link>
        <div className="header-actions">
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
                    {projectBusy ? t.addingProject : t.addUnconfirmed}
                  </button>
                </form>
                {projectError && <p className="notice error">{t.projectError}</p>}
                <div className="project-columns">
                  {([
                    ["unconfirmed", t.unconfirmedProjects, t.noUnconfirmedProjects, unconfirmedProjects],
                    ["confirmed", t.confirmedProjects, t.noConfirmedProjects, confirmedProjects],
                  ] as const).map(([certainty, title, empty, items]) => (
                    <section className="project-group" key={certainty}>
                      <h4>{title}<span>{items.length}</span></h4>
                      {items.length === 0 ? <p className="empty-bindings">{empty}</p> : items.map((project) => (
                        <article className="project-item" key={project.id}>
                          <div>
                            <strong>{project.name}</strong>
                            <span>{projectProgressLabels[project.progress_status]}</span>
                          </div>
                          <div className="project-actions">
                            {certainty === "unconfirmed" && (
                              <button type="button" onClick={() => updateProject(project, "confirm")} disabled={projectBusy}>
                                {t.confirmProject}
                              </button>
                            )}
                            <select
                              aria-label={`${project.name} progress`}
                              value={project.progress_status}
                              onChange={(event) => updateProject(project, "set_progress", { progress_status: event.target.value })}
                              disabled={projectBusy}
                            >
                              {Object.entries(projectProgressLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                            </select>
                            <button type="button" onClick={() => updateProject(project, "dismiss")} disabled={projectBusy}>
                              {t.dismissProject}
                            </button>
                          </div>
                        </article>
                      ))}
                    </section>
                  ))}
                </div>
              </div>
              {recordsEnabled && (
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
                      {confirmedProjects.map((project) => (
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
                  {recordError && <p className="notice error">{t.workViewsError}</p>}
                  <div className="record-list">
                    {visibleRecords.length === 0 ? (
                      <p className="empty-bindings">{t.noWorkRecords}</p>
                    ) : visibleRecords.map((record) => {
                      const item = presentCluedRecord(record, recordViewLabels[recordView]);
                      const display = presentCluedRecordDisplay(record, recordViewLabels[recordView]);
                      return (
                        <article className="record-item" key={item.id}>
                          <div>
                            <strong>{item.title}</strong>
                            <span>{item.status} · v{item.version ?? "n/a"} · {t.canonicalIdLabel}: {item.id}</span>
                          </div>
                          <p>{display.summary || item.conclusion}</p>
                          {display.rawDetails && (
                            <details className="record-details">
                              <summary>{t.viewStructuredRecord}</summary>
                              <pre>{display.rawDetails}</pre>
                            </details>
                          )}
                          <time dateTime={item.updatedAt}>{new Date(item.updatedAt).toLocaleString(locale)}</time>
                        </article>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="continuity-panel">
                <div className="continuity-heading">
                  <div>
                    <h3>{t.continuityTitle}</h3>
                    <p>{t.continuityCopy}</p>
                  </div>
                  <span className="protocol-badge">{t.continuityProtocol}</span>
                </div>

                <form className="binding-form" onSubmit={handleCreateBinding}>
                  <label>
                    {t.vendor}
                    <select
                      value={bindingVendor}
                      onChange={(event) => setBindingVendor(event.target.value)}
                    >
                      <option>OpenAI</option>
                      <option>Anthropic</option>
                      <option>Google</option>
                      <option>Microsoft</option>
                      <option>DeepSeek</option>
                      <option>Other</option>
                    </select>
                  </label>
                  <label>
                    {t.agentName}
                    <input
                      value={bindingAgentName}
                      onChange={(event) => setBindingAgentName(event.target.value)}
                      placeholder={t.agentPlaceholder}
                      maxLength={80}
                    />
                  </label>
                  <button className="primary-button" type="submit" disabled={bindingBusy}>
                    {bindingBusy ? t.creatingBinding : t.createBinding}
                  </button>
                </form>

                {bindingError && <p className="notice error">{t.bindingError}</p>}

                {issuedBinding && (
                  <div className="issued-binding" role="status">
                    <strong>{t.connectionReady}</strong>
                    <p>{t.connectionReadyCopy}</p>
                    <div className="credential-row">
                      <span>{t.mcpEndpoint}</span>
                      <code>{issuedBinding.mcpUrl}</code>
                      <button type="button" onClick={() => copyValue("endpoint", issuedBinding.mcpUrl)}>
                        {copiedField === "endpoint" ? t.copied : t.copy}
                      </button>
                    </div>
                    <div className="credential-row">
                      <span>{t.bindingToken}</span>
                      <code>{issuedBinding.token}</code>
                      <button type="button" onClick={() => copyValue("token", issuedBinding.token)}>
                        {copiedField === "token" ? t.copied : t.copy}
                      </button>
                    </div>
                  </div>
                )}

                <div className="binding-list">
                  <h4>{t.activeConnections}</h4>
                  {bindings.length === 0 ? (
                    <p className="empty-bindings">{t.noConnections}</p>
                  ) : (
                    bindings.map((binding) => (
                      <div className="binding-item" key={binding.id}>
                        <div>
                          <strong>{binding.agent_name}</strong>
                          <span>{binding.vendor}</span>
                          <small>
                            {t.lastUsed}: {binding.last_used_at ? new Date(binding.last_used_at).toLocaleString(locale) : t.neverUsed}
                          </small>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRevokeBinding(binding.id)}
                          disabled={bindingBusy}
                        >
                          {t.revoke}
                        </button>
                      </div>
                    ))
                  )}
                </div>
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
        <span>{t.previewStatus}</span>
      </footer>
    </main>
  );
}
