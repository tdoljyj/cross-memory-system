"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { createClient, Session } from "@supabase/supabase-js";
import Link from "next/link";

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
type Memory = {
  id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
};
type MemoryAudit = {
  id: string;
  memory_id: string;
  action: "create" | "update" | "delete";
  details: { title?: unknown };
  occurred_at: string;
};
type MemoryNotice = "created" | "updated" | "deleted" | "";
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

function authErrorKey(message: string): NoticeKey {
  const normalized = message.toLowerCase();
  if (normalized.includes("password") && normalized.includes("at least")) {
    return "passwordTooShort";
  }
  if (normalized.includes("already registered") || normalized.includes("already exists")) {
    return "accountExists";
  }
  if (normalized.includes("rate") || normalized.includes("too many")) {
    return "rateLimited";
  }
  return "genericAuthError";
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
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [bindingVendor, setBindingVendor] = useState("OpenAI");
  const [bindingAgentName, setBindingAgentName] = useState("");
  const [bindingBusy, setBindingBusy] = useState(false);
  const [bindingError, setBindingError] = useState(false);
  const [issuedBinding, setIssuedBinding] = useState<IssuedBinding | null>(null);
  const [copiedField, setCopiedField] = useState<"endpoint" | "token" | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryAudit, setMemoryAudit] = useState<MemoryAudit[]>([]);
  const [memoryTitle, setMemoryTitle] = useState("");
  const [memoryContent, setMemoryContent] = useState("");
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryError, setMemoryError] = useState(false);
  const [memoryNotice, setMemoryNotice] = useState<MemoryNotice>("");
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
    fetch("/api/bindings", {
      headers: { authorization: `Bearer ${session.access_token}` },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("binding-list-failed");
        return response.json() as Promise<{ bindings: Binding[] }>;
      })
      .then((result) => {
        if (!cancelled) {
          setBindings(result.bindings.filter((binding) => !binding.revoked_at));
          setBindingError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setBindingError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session, view]);

  useEffect(() => {
    if (!session || view !== "account") return;
    let cancelled = false;
    const headers = { authorization: `Bearer ${session.access_token}` };

    Promise.all([
      fetch("/api/memories", { headers, cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error("memory-list-failed");
        return response.json() as Promise<{ memories: Memory[] }>;
      }),
      fetch("/api/memories/audit", { headers, cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error("memory-audit-failed");
        return response.json() as Promise<{ audit: MemoryAudit[] }>;
      }),
    ])
      .then(([memoryResult, auditResult]) => {
        if (cancelled) return;
        setMemories(memoryResult.memories);
        setMemoryAudit(auditResult.audit);
        setMemoryError(false);
      })
      .catch(() => {
        if (!cancelled) setMemoryError(true);
      });

    return () => {
      cancelled = true;
    };
  }, [session, view]);

  function resetNotices() {
    setError("");
    setMessage("");
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
      setError(authErrorKey(result.error.message));
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
      setError(authErrorKey(result.error.message));
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
    setMemories([]);
    setMemoryAudit([]);
    resetMemoryForm();
    setMemoryError(false);
    setMemoryNotice("");
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

  async function refreshMemoryAudit() {
    if (!session) return;
    const response = await fetch("/api/memories/audit", {
      headers: { authorization: `Bearer ${session.access_token}` },
      cache: "no-store",
    });
    if (!response.ok) throw new Error("memory-audit-failed");
    const result = (await response.json()) as { audit: MemoryAudit[] };
    setMemoryAudit(result.audit);
  }

  function resetMemoryForm() {
    setMemoryTitle("");
    setMemoryContent("");
    setEditingMemoryId(null);
  }

  async function handleSaveMemory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    const editing = Boolean(editingMemoryId);
    setMemoryBusy(true);
    setMemoryError(false);
    setMemoryNotice("");
    try {
      const query = editingMemoryId ? `?id=${encodeURIComponent(editingMemoryId)}` : "";
      const response = await fetch(`/api/memories${query}`, {
        method: editing ? "PATCH" : "POST",
        headers: {
          authorization: `Bearer ${session.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: memoryTitle, content: memoryContent }),
      });
      if (!response.ok) throw new Error("memory-save-failed");
      const result = (await response.json()) as { memory: Memory };
      setMemories((current) =>
        editing
          ? current.map((memory) => (memory.id === result.memory.id ? result.memory : memory))
          : [result.memory, ...current],
      );
      resetMemoryForm();
      setMemoryNotice(editing ? "updated" : "created");
      await refreshMemoryAudit();
    } catch {
      setMemoryError(true);
    } finally {
      setMemoryBusy(false);
    }
  }

  function handleEditMemory(memory: Memory) {
    setEditingMemoryId(memory.id);
    setMemoryTitle(memory.title);
    setMemoryContent(memory.content);
    setMemoryError(false);
    setMemoryNotice("");
  }

  async function handleDeleteMemory(memory: Memory) {
    if (!session || !window.confirm(t.confirmDelete)) return;
    setMemoryBusy(true);
    setMemoryError(false);
    setMemoryNotice("");
    try {
      const response = await fetch(`/api/memories?id=${encodeURIComponent(memory.id)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${session.access_token}` },
      });
      if (!response.ok) throw new Error("memory-delete-failed");
      setMemories((current) => current.filter((item) => item.id !== memory.id));
      if (editingMemoryId === memory.id) resetMemoryForm();
      setMemoryNotice("deleted");
      await refreshMemoryAudit();
    } catch {
      setMemoryError(true);
    } finally {
      setMemoryBusy(false);
    }
  }

  async function copyValue(field: "endpoint" | "token", value: string) {
    await navigator.clipboard.writeText(value);
    setCopiedField(field);
    window.setTimeout(() => setCopiedField(null), 1600);
  }

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
                {error && <p className="notice error">{t[error]}</p>}
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
              <div className="memory-panel">
                <div className="memory-heading">
                  <div>
                    <h3>{t.memoriesTitle}</h3>
                    <p>{t.memoriesCopy}</p>
                  </div>
                  <span className="memory-count">{memories.length}</span>
                </div>

                <form className="memory-form" onSubmit={handleSaveMemory}>
                  <label>
                    {t.memoryTitle}
                    <input
                      value={memoryTitle}
                      onChange={(event) => setMemoryTitle(event.target.value)}
                      placeholder={t.memoryTitlePlaceholder}
                      maxLength={120}
                      required
                    />
                  </label>
                  <label>
                    {t.memoryContent}
                    <textarea
                      value={memoryContent}
                      onChange={(event) => setMemoryContent(event.target.value)}
                      placeholder={t.memoryContentPlaceholder}
                      maxLength={8000}
                      rows={4}
                      required
                    />
                  </label>
                  <div className="memory-form-actions">
                    <button className="primary-button" type="submit" disabled={memoryBusy}>
                      {memoryBusy
                        ? t.savingMemory
                        : editingMemoryId
                          ? t.updateMemory
                          : t.addMemory}
                    </button>
                    {editingMemoryId && (
                      <button
                        className="memory-cancel"
                        type="button"
                        onClick={resetMemoryForm}
                        disabled={memoryBusy}
                      >
                        {t.cancelEdit}
                      </button>
                    )}
                  </div>
                </form>

                {memoryError && <p className="notice error">{t.memoryError}</p>}
                {memoryNotice && (
                  <p className="notice success">
                    {memoryNotice === "created"
                      ? t.memoryCreated
                      : memoryNotice === "updated"
                        ? t.memoryUpdated
                        : t.memoryDeleted}
                  </p>
                )}

                <div className="memory-list">
                  {memories.length === 0 ? (
                    <p className="empty-bindings">{t.noMemories}</p>
                  ) : (
                    memories.map((memory) => (
                      <article className="memory-item" key={memory.id}>
                        <div className="memory-item-heading">
                          <strong>{memory.title}</strong>
                          <small>
                            {t.memoryUpdatedAt}: {new Date(memory.updated_at).toLocaleString(locale)}
                          </small>
                        </div>
                        <p>{memory.content}</p>
                        <div className="memory-item-actions">
                          <button
                            type="button"
                            onClick={() => handleEditMemory(memory)}
                            disabled={memoryBusy}
                          >
                            {t.editMemory}
                          </button>
                          <button
                            className="danger"
                            type="button"
                            onClick={() => handleDeleteMemory(memory)}
                            disabled={memoryBusy}
                          >
                            {t.deleteMemory}
                          </button>
                        </div>
                      </article>
                    ))
                  )}
                </div>

                <div className="memory-audit">
                  <div>
                    <h4>{t.auditTitle}</h4>
                    <p>{t.auditCopy}</p>
                  </div>
                  {memoryAudit.length === 0 ? (
                    <p className="empty-bindings">{t.noAudit}</p>
                  ) : (
                    memoryAudit.slice(0, 8).map((event) => (
                      <div className="audit-item" key={event.id}>
                        <span className={`audit-action audit-${event.action}`}>
                          {event.action === "create"
                            ? t.auditCreate
                            : event.action === "update"
                              ? t.auditUpdate
                              : t.auditDelete}
                        </span>
                        <strong>
                          {typeof event.details.title === "string"
                            ? event.details.title
                            : t.untitledMemory}
                        </strong>
                        <time dateTime={event.occurred_at}>
                          {new Date(event.occurred_at).toLocaleString(locale)}
                        </time>
                      </div>
                    ))
                  )}
                </div>
              </div>
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
