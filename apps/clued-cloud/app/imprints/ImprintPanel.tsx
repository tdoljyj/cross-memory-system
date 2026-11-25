"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { type Session } from "@supabase/supabase-js";
import { supabase } from "../supabase-browser";
import { DOMAIN_KEYS, RECORD_TYPES, VIEW_KEYS, VIEW_LABELS, SelectionFence, beijingInput, canEditDue, dueIso,
  evidenceReferences, immediateAuthoritativeRecord, normalizedDomains, recordIdentity, relatedReferences, sourceKind, uniqueRecords, uuid,
  type Domain, type ImprintRecord, type ImprintView, type Locale, type ReadInput, type ReadPage } from "./imprint-model";
import { ImprintFailure, mutateRecord, noteInput, organizationInput, prepareWrite, readImprints, readRevision, readSource, setOrganization, taskDueInput,
  type NativeRpc, type PreparedWrite, type SourceRead } from "./imprint-client";
import { suggestImprintOrganization, type ImprintSuggestions } from "./imprint-suggestions";
import ExistingAssociationEditor from "./ExistingAssociationEditor";
import MixedContentEditor from "./MixedContentEditor";
import ImprintBulkPanel from "./ImprintBulkPanel";
import LaunchDecisionPanel from "./LaunchDecisionPanel";
import type { AssociationRead } from "./imprint-associations";
import { searchRevisions, searchSources, type RevisionRead } from "./imprint-search";

const COPY = {
  "zh-CN": {
    title: "印记", description: "从不同入口找回同一条内容，正文与状态只维护一份。", scope: "查询范围", allScopes: "所有有权查看的范围", global: "个人记录", query: "搜索当前视图", search: "搜索", refresh: "刷新", type: "内容性质", anyType: "全部性质", extraDomain: "追加领域（同时满足）", anyDomain: "不追加", history: "包含旧版本及待核对内容", coverage: "搜索已保存的标题、正文和可读取的来源全文；勾选历史可查实际留存的旧版本。普通印记从本功能启用后的更新开始保留旧正文，以前未保存的版本无法恢复。", loading: "正在读取印记…", unknown: "读取结果未知，不能据此判断没有内容。请刷新重试。", unavailable: "当前读取或保存未获准、未接入或暂不可用。", conflict: "对象已有更新，请刷新并核对后再保存。", empty: "这个范围内没有匹配的印记。未归类内容可到全部查看。", more: "加载更多", partial: "还有内容未加载。", complete: "本次查询结果已显示。", noteTitle: "保存普通印记", saveScope: "保存到", titleField: "标题", contentField: "完整正文", save: "保存印记", saving: "正在保存…", saved: "已保存", savedNote: "普通印记已保存；未归类也能在全部找到。", openAll: "到全部查看", unclassified: "未归类", domains: "领域", editDomains: "修改这条印记的领域", domainsHelp: "只修改当前对象；关联任务、决定和来源不会自动改标签。留空也可保存。", saveDomains: "保存领域", savedDomains: "领域已保存", details: "阅读全文与出处", full: "完整正文", identity: "对象 ID", version: "版本", state: "状态", currentness: "当前性", historical: "这份内容不是已确认的当前有效记录；历史或待核对内容不授权执行。", relations: "关联记录", related: "读取关联记录", source: "已保存出处", sourceButton: "读取来源", sourceBody: "已保存来源正文", sourceMetadata: "来源定位与保存信息", locatorOnly: "只有来源定位信息，没有可读取的已保存全文。", sourceMissing: "来源全文目前不可读取；定位信息不等于全文已经收齐。", noSource: "没有可读取的已保存来源引用。", due: "任务期限（北京时间）", dueHelp: "留空表示没有期限；只修改期限，不改执行正文或生命周期。", dueReadOnly: "终态或当前性未确认的任务不能在这里修改期限。", saveDue: "保存期限", savedDue: "期限已保存", closure: "结案说明", recordDetail: "关联印记详情", close: "关闭详情", receipt: "保存回执", clearQuery: "清除搜索", typeNames: { task: "任务", decision: "决策", note: "笔记／记录", state: "事实／状态", profile_fact: "个人事实" },
    lifecycle: { active: "有效", completed: "已完成", cancelled: "已取消", archived: "已归档", superseded: "已替代", revoked: "已撤销", closed: "已关闭" },
    currentNames: { CURRENT: "当前有效", HISTORY: "历史", UNKNOWN: "尚未确认", STALE: "已过时", SHADOWED_BY_ACTIVE_EVENT: "有后续信息待核对", NOT_CURRENT_FOR_EXECUTION: "不适合当前执行", NOT_AUTHORIZED: "无读取权限" },
  },
  en: {
    title: "Imprints", description: "Different entrances, one identity, one body and one state.", scope: "Search scope", allScopes: "All authorized scopes", global: "Personal records", query: "Search this view", search: "Search", refresh: "Refresh", type: "Content type", anyType: "Any type", extraDomain: "Additional domain (intersection)", anyDomain: "None", history: "Include retained revisions and records requiring review", coverage: "Search saved titles, bodies and readable source text. Include history to search retained revisions. Ordinary imprint history is retained from updates after this feature was enabled; previously unsaved bodies cannot be recovered.", loading: "Reading imprints…", unknown: "The read result is unknown. This does not mean there is no content. Refresh to retry.", unavailable: "The read or save is not admitted, connected or available at present.", conflict: "This object has changed. Refresh and review it before saving.", empty: "No matching imprints in this scope. Unclassified content remains in All.", more: "Load more", partial: "More content has not been loaded.", complete: "This query's results are displayed.", noteTitle: "Save an ordinary imprint", saveScope: "Save in", titleField: "Title", contentField: "Full body", save: "Save imprint", saving: "Saving…", saved: "Saved", savedNote: "The ordinary imprint was saved. Unclassified content can be found in All.", openAll: "View in All", unclassified: "Unclassified", domains: "Domains", editDomains: "Edit this imprint's domains", domainsHelp: "Only this object changes. Related tasks, decisions and sources keep their own labels. An empty selection is allowed.", saveDomains: "Save domains", savedDomains: "Domains saved", details: "Read full body and sources", full: "Full body", identity: "Object ID", version: "Version", state: "State", currentness: "Currentness", historical: "This is not confirmed current content. History or content requiring review does not authorize execution.", relations: "Related records", related: "Read related record", source: "Saved source references", sourceButton: "Read source", sourceBody: "Saved source text", sourceMetadata: "Source locator and storage information", locatorOnly: "Only a locator is available; no saved full text can be read.", sourceMissing: "The source text cannot currently be read. A locator is not proof that the full text was captured.", noSource: "No readable saved source reference.", due: "Task deadline (Beijing time)", dueHelp: "Leave empty for no deadline. Only the deadline changes; execution text and lifecycle are preserved.", dueReadOnly: "Terminal tasks and tasks without confirmed currentness cannot have their deadline edited here.", saveDue: "Save deadline", savedDue: "Deadline saved", closure: "Closure summary", recordDetail: "Related imprint detail", close: "Close detail", receipt: "Save receipt", clearQuery: "Clear search", typeNames: { task: "Task", decision: "Decision", note: "Note / record", state: "Fact / state", profile_fact: "Personal fact" },
    lifecycle: { active: "Active", completed: "Completed", cancelled: "Cancelled", archived: "Archived", superseded: "Superseded", revoked: "Revoked", closed: "Closed" },
    currentNames: { CURRENT: "Current", HISTORY: "History", UNKNOWN: "Unknown", STALE: "Stale", SHADOWED_BY_ACTIVE_EVENT: "Later information requires review", NOT_CURRENT_FOR_EXECUTION: "Not current for execution", NOT_AUTHORIZED: "Not authorized" },
  },
};
type Bound<T> = { selection: object; value: T };
type List = ReadPage & { status: "loading" | "ready" | "unknown" | "unavailable"; error?: string };
type Attempts = Map<string, Promise<PreparedWrite>>;
function failureText(failure: unknown, locale: Locale): string {
  const t = COPY[locale];
  if (failure instanceof ImprintFailure && failure.code === "IDEMPOTENCY_KEY_CONFLICT") return locale === "zh-CN"
    ? "这次保存与同一请求的已有记录不一致，请核对原操作。不要通过更换请求键强行重试。" : "This save differs from an existing request. Review the original operation; do not force a retry with a new request key.";
  if (failure instanceof ImprintFailure && failure.code === "development_formal_view_unavailable") return locale === "zh-CN"
    ? "正式任务／决策投影尚未提供；候选仍可在全部及领域视图中查看。" : "The accepted task / decision projection is not available; candidates remain readable in All and domain views.";
  return failure instanceof ImprintFailure && failure.reason === "conflict" ? t.conflict
    : failure instanceof ImprintFailure && failure.reason === "unavailable" ? t.unavailable : t.unknown;
}
function attempt(attempts: Attempts, signature: string, make: (key: string) => Record<string, unknown>): Promise<PreparedWrite> {
  let pending = attempts.get(signature);
  if (!pending) {
    pending = prepareWrite(make(globalThis.crypto.randomUUID()));
    attempts.set(signature, pending);
    void pending.catch(() => { if (attempts.get(signature) === pending) attempts.delete(signature); });
  }
  return pending;
}

export default function ImprintPanel({ session, projects, locale, developmentContextId, developmentContextName }: {
  session: Session; projects: { id: string; name: string }[]; locale: Locale; developmentContextId?: string; developmentContextName?: string;
}) {
  const t = COPY[locale];
  const labels = VIEW_LABELS[locale];
  const scopeLabel = (value: string) => value === "global" ? t.global : value === "profile" ? (locale === "zh-CN" ? "个人资料" : "Profile")
    : value.startsWith("project:") ? `${projects.find(project => "project:" + project.id === value)?.name ?? (locale === "zh-CN" ? "项目" : "Project")} · ${value.slice(8)}`
      : locale === "zh-CN" ? "范围待核对" : "Scope requires review";
  const [view, setView] = useState<ImprintView>("all");
  const [scope, setScope] = useState("all");
  const [searchText, setSearchText] = useState("");
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState(false);
  const [kind, setKind] = useState("");
  const [extraDomain, setExtraDomain] = useState<Domain | "">("");
  const development = developmentContextId !== undefined;
  const readScope = development && scope !== "all" && !projects.some(project => "project:" + project.id === scope) ? "all" : scope;
  const allScopeLabel = development ? (locale === "zh-CN" ? "当前上下文" : "Current context") : t.allScopes;
  const key = JSON.stringify([session.user.id, session.access_token, development ? "development" : "user", developmentContextId, view, readScope, query, history, kind, extraDomain]);
  const selection = useMemo(() => ({ key }), [key]);
  const fence = useRef(new SelectionFence());
  useLayoutEffect(() => { const activeFence = fence.current; activeFence.select(selection); return () => { activeFence.select({}); }; }, [selection]);
  const [attempts] = useState<Attempts>(() => new Map());
  useLayoutEffect(() => { attempts.clear(); }, [session.user.id, attempts]);
  const [list, setList] = useState<Bound<List> | null>(null);
  const [detail, setDetail] = useState<Bound<{ loading: boolean; record: ImprintRecord | null; error: string }> | null>(null);
  const [notice, setNotice] = useState<Bound<string> | null>(null);
  const [note, setNote] = useState({ owner: session.user.id, title: "", content: "", scope: "global" });
  const [noteBusy, setNoteBusy] = useState<Bound<boolean> | null>(null);
  // Bind the SDK request to this Session snapshot. Its shared auth client may
  // change accounts while awaiting; a later account must not receive this write.
  const rpc: NativeRpc = (name, args, signal) => {
    const request = supabase.rpc(name, args).setHeader("Authorization", "Bearer " + session.access_token);
    return signal ? request.abortSignal(signal) : request;
  };
  const input = (cursor = 0): ReadInput => ({ view, scope: readScope, query, include_history: history, limit: 30, cursor,
    ...(kind ? { record_type: kind } : {}), ...(extraDomain ? { domains: [extraDomain] } : {}) });
  const visible = list?.selection === selection ? list.value : null;
  const visibleDetail = detail?.selection === selection ? detail.value : null;
  const draft = note.owner === session.user.id ? note : { owner: session.user.id, title: "", content: "", scope: "global" };
  const busy = noteBusy?.selection === selection && noteBusy.value;
  const say = (message: string) => setNotice({ selection, value: message });
  async function load(cursor = 0) {
    const ticket = fence.current.begin("read");
    const previous = cursor > 0 && list?.selection === selection ? list.value.records : [];
    setList({ selection, value: { status: "loading", records: [], page: { next_cursor: null, complete: false } } });
    try {
      const page = await readImprints(rpc, input(cursor), developmentContextId, { isCurrent: () => fence.current.current(ticket) });
      if (fence.current.current(ticket)) setList({ selection, value: { ...page, records: uniqueRecords([...previous, ...page.records]), status: "ready" } });
    } catch (failure) {
      if (fence.current.current(ticket)) setList({ selection, value: { status: failure instanceof ImprintFailure && failure.reason === "unavailable" ? "unavailable" : "unknown", records: [], page: { next_cursor: null, complete: false }, error: failureText(failure, locale) } });
    }
  }
  useEffect(() => { const activeFence = fence.current; let cancelled = false; queueMicrotask(() => { if (!cancelled) void load(); });
    return () => { cancelled = true; activeFence.begin("read"); }; /* callbacks belong to this exact selection */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);
  async function openRecord(id: string, sourceNamespace?: "canonical" | "development", association?: AssociationRead) {
    const ticket = fence.current.begin("detail");
    setDetail({ selection, value: { loading: true, record: null, error: "" } });
    try {
      const result = await readImprints(rpc, { view: association?.recordType ?? "all", scope: association?.scope ?? "all", query: "", include_history: !association, limit: 30, cursor: 0, id,
        ...(development && sourceNamespace ? { source_kind: sourceNamespace } : {}) }, developmentContextId,
        { isCurrent: () => fence.current.current(ticket) });
      if (association && (result.records.length !== 1 || result.records[0].id !== id
        || result.records[0].scope !== association.scope || result.records[0].record_type !== association.recordType
        || sourceKind(result.records[0]) === "development" || result.records[0].record_schema_version !== 1
        || result.records[0].record_currentness !== "CURRENT" || result.records[0].lifecycle_status !== "active"
        || result.records[0].authoritative !== true || (development && result.records[0].context_id !== developmentContextId)))
        throw new ImprintFailure("unavailable", "association_target_unavailable");
      if (fence.current.current(ticket)) setDetail({ selection, value: { loading: false, record: result.records[0] ?? null, error: result.records.length ? "" : t.unavailable } });
    } catch (failure) { if (fence.current.current(ticket)) setDetail({ selection, value: { loading: false, record: null, error: failureText(failure, locale) } }); }
  }
  async function saveNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (development || busy || !draft.title.trim() || !draft.content.trim()) return;
    const ticket = fence.current.begin("note"); setNoteBusy({ selection, value: true });
    const signature = JSON.stringify([session.user.id, "note", draft.scope, draft.title.trim(), draft.content]);
    try {
      const pending = await attempt(attempts, signature, idempotency => noteInput(globalThis.crypto.randomUUID(), idempotency, draft.scope, draft.title, draft.content));
      if (!fence.current.current(ticket)) return;
      const result = await mutateRecord(rpc, pending);
      if (!fence.current.current(ticket)) return;
      attempts.delete(signature);
      setNote(current => current.owner === draft.owner && current.title === draft.title && current.content === draft.content && current.scope === draft.scope ? { ...current, title: "", content: "" } : current);
      say(`${t.savedNote} ${t.identity}: ${String(pending.input.id)} · ${t.receipt}: ${result.receipt}`);
      await load();
    } catch (failure) { if (fence.current.current(ticket)) say(failureText(failure, locale)); }
    finally { if (fence.current.current(ticket)) setNoteBusy({ selection, value: false }); }
  }
  function search(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (searchText.trim() === query) void load(); else setQuery(searchText.trim()); }
  function committed(message: string) { if (fence.current.selected(selection)) { say(message); setDetail(null); void load(); } }
  const changeNote = (field: "title" | "content" | "scope", value: string) => setNote({ ...draft, [field]: value });
  return <section className="imprints-panel records-panel" aria-label={development ? (locale === "zh-CN" ? "上下文印记" : "Context imprints") : t.title}>
    <div className="continuity-heading"><div><h3>{development ? (locale === "zh-CN" ? "上下文印记" : "Context imprints") : t.title}{developmentContextName ? ` · ${developmentContextName}` : ""}</h3><p>{t.description}</p></div></div>
    <p className="context-muted">{locale === "zh-CN" ? "新内容会按正文中明确的活动和用途自动归类，例如客户 Logo 方案归入工作和创作。不确定的留在全部；手动修改或清空后会保留你的选择。" : "New content is organized by clear activities and uses, such as a client logo proposal under Work and Creation. Uncertain content stays in All. Manual edits, including clearing labels, keep your choice."}</p>
    <div className="record-tabs" role="tablist" aria-label={t.title}>
      {VIEW_KEYS.map((item, index) => <button type="button" role="tab" key={item} aria-selected={view === item} tabIndex={view === item ? 0 : -1}
        className={view === item ? "active" : ""} onClick={() => setView(item)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % VIEW_KEYS.length : event.key === "ArrowLeft" ? (index + VIEW_KEYS.length - 1) % VIEW_KEYS.length : event.key === "Home" ? 0 : event.key === "End" ? VIEW_KEYS.length - 1 : null;
          if (next !== null) { event.preventDefault(); setView(VIEW_KEYS[next]); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus(); }
        }}>{labels[item]}</button>)}
    </div>
    <div className="imprints-filters">
      <label>{t.scope}<select aria-label={t.scope} value={readScope} onChange={event => setScope(event.target.value)}><option value="all">{allScopeLabel}</option>{!development && <option value="global">{t.global}</option>}{projects.map(project => <option key={project.id} value={"project:" + project.id}>{project.name}</option>)}</select></label>
      <label>{t.type}<select aria-label={t.type} value={kind} onChange={event => setKind(event.target.value)}><option value="">{t.anyType}</option>{[...new Set([...RECORD_TYPES, ...(kind ? [kind] : []), ...(development ? visible?.records.map(record => record.record_type) ?? [] : [])])].map(item => <option key={item} value={item}>{(t.typeNames as Record<string, string>)[item] ?? item}</option>)}</select></label>
      <label>{t.extraDomain}<select aria-label={t.extraDomain} value={extraDomain} onChange={event => setExtraDomain(event.target.value as Domain | "")}><option value="">{t.anyDomain}</option>{DOMAIN_KEYS.map(item => <option key={item} value={item}>{labels[item]}</option>)}</select></label>
      <label><input type="checkbox" checked={history} onChange={event => setHistory(event.target.checked)} />{t.history}</label>
    </div>
    {!development && view === "decision" && <LaunchDecisionPanel session={session} scope={readScope}
      projectScopes={projects.map(project => "project:" + project.id)} locale={locale} rpc={rpc} />}
    <form className="imprints-tools" onSubmit={search}><label>{t.query}<input aria-label={t.query} type="search" maxLength={500} value={searchText} onChange={event => setSearchText(event.target.value)} /></label><button type="submit">{t.search}</button><button type="button" onClick={() => { setSearchText(""); setQuery(""); }}>{t.clearQuery}</button><button type="button" onClick={() => void load()}>{t.refresh}</button></form>
    <p className="context-muted">{labels[view]} · {readScope === "all" ? allScopeLabel : readScope === "global" ? t.global : projects.find(project => "project:" + project.id === readScope)?.name ?? readScope}{query ? ` · ${query}` : ""}</p>
    <ImprintBulkPanel key={key} rpc={rpc} locale={locale} owner={session.user.id} selection={{ scope: readScope, ...(developmentContextId ? { context_id: developmentContextId } : {}) }}
      describeSavedScope={saved => saved.scope === "all" ? (locale === "zh-CN" ? "所有自有记录" : "All owned records") : saved.scope === "global" ? t.global
        : projects.find(project => "project:" + project.id === saved.scope)?.name ?? (locale === "zh-CN" ? "已保存的项目范围" : "Saved project scope")}
      scopeLabel={readScope === "all" ? allScopeLabel : scopeLabel(readScope)} onChanged={() => void load()} onOpenRecord={id => void openRecord(id, "canonical")} />
    <p className="context-muted">{development ? (locale === "zh-CN" ? "搜索当前上下文及所属项目的正文，正式记录的已保存来源也能检索。历史只包含实际留存的版本；候选不自动成为任务或决策。" : "Search this context and its project's bodies, including saved readable sources of accepted records. History contains only retained versions; candidates do not become tasks or decisions.") : t.coverage}</p>
    {!development && <p className="context-muted">{locale === "zh-CN" ? "当前入口覆盖已保存记录与已链接的来源。尚未汇聚未链接的输入片段，也不宣称所有外部聊天和旧正文版本已保存。" : "This entrance covers saved records and linked sources. Unlinked intake segments are not aggregated; external chats and every old body revision are not claimed to be captured."}</p>}
    {!development && <form className="record-form" aria-label={t.noteTitle} onSubmit={saveNote}><h4>{t.noteTitle}</h4>
      <label>{t.saveScope}<select aria-label={t.saveScope} value={draft.scope} onChange={event => changeNote("scope", event.target.value)}><option value="global">{t.global}</option>{projects.map(project => <option key={project.id} value={"project:" + project.id}>{project.name}</option>)}</select></label>
      <label>{t.titleField}<input aria-label={t.titleField} required maxLength={120} value={draft.title} onChange={event => changeNote("title", event.target.value)} /></label>
      <label>{t.contentField}<textarea aria-label={t.contentField} required maxLength={8000} rows={4} value={draft.content} onChange={event => changeNote("content", event.target.value)} /></label>
      <button type="submit" className="primary-button" disabled={!!busy}>{busy ? t.saving : t.save}</button>
    </form>}
    {notice?.selection === selection && <p role="status" className="notice">{notice.value}<button type="button" onClick={() => { setView("all"); setKind(""); setExtraDomain(""); setScope("all"); setSearchText(""); setQuery(""); }}>{t.openAll}</button></p>}
    <div role="tabpanel" aria-label={labels[view]} className="imprints-grid">
      {(!visible || visible.status === "loading") && <p role="status">{t.loading}</p>}
      {visible?.status === "unknown" && <p role="alert">{t.unknown}</p>}
      {visible?.status === "unavailable" && <p role="alert">{visible.error ?? t.unavailable}</p>}
      {visible?.status === "ready" && <>{visible.selection_complete === false && <p role="status" className="notice">{locale === "zh-CN" ? "部分内容待核对，本页不能证明全部当前内容已收齐。可保留阅读已合格内容；需要诊断原记录时显式开启历史。" : "Some content requires review. This page does not prove all current content has been collected. Qualified content remains readable; explicitly include history to diagnose other records."}</p>}
        {visible.records.length === 0 && visible.selection_complete !== false && <p>{t.empty}</p>}{visible.records.map(record => <ImprintCard key={recordIdentity(record)} record={record} selection={selection} owner={session.user.id} rpc={rpc} locale={locale} scopeLabel={scopeLabel(record.scope)} attempts={attempts} onCommitted={committed} onRelated={openRecord} includeHistory={history} developmentContextId={developmentContextId} />)}
        {(!visible.page.complete || visible.selection_complete !== false) && <p className="context-muted">{visible.page.complete ? t.complete : t.partial}</p>}{visible.page.next_cursor !== null && <button type="button" onClick={() => void load(visible.page.next_cursor!)}>{t.more}</button>}</>}
    </div>
    {visibleDetail && <section className="imprints-detail" aria-label={t.recordDetail}><h4>{t.recordDetail}</h4><button type="button" onClick={() => { fence.current.begin("detail"); setDetail(null); }}>{t.close}</button>{visibleDetail.loading && <p role="status">{t.loading}</p>}{visibleDetail.error && <p role="alert">{visibleDetail.error}</p>}{visibleDetail.record && <ImprintCard key={"detail-" + recordIdentity(visibleDetail.record)} record={visibleDetail.record} selection={selection} owner={session.user.id} rpc={rpc} locale={locale} scopeLabel={scopeLabel(visibleDetail.record.scope)} attempts={attempts} onCommitted={committed} onRelated={openRecord} expanded includeHistory={history} developmentContextId={developmentContextId} />}</section>}
  </section>;
}

function ImprintCard({ record, selection, owner, rpc, locale, scopeLabel, attempts, onCommitted, onRelated, expanded = false, includeHistory, developmentContextId }: {
  record: ImprintRecord; selection: object; owner: string; rpc: NativeRpc; locale: Locale; scopeLabel: string; attempts: Attempts;
  onCommitted: (message: string) => void; onRelated: (id: string, sourceNamespace?: "canonical" | "development", association?: AssociationRead) => void; expanded?: boolean; includeHistory: boolean; developmentContextId?: string;
}) {
  const t = COPY[locale], labels = VIEW_LABELS[locale];
  const development = developmentContextId !== undefined;
  const fence = useRef(new SelectionFence());
  useLayoutEffect(() => { const activeFence = fence.current; activeFence.select(selection); return () => { activeFence.select({}); activeFence.begin("write"); activeFence.begin("source"); activeFence.begin("revision"); }; }, [record, selection]);
  const [draft, setDraft] = useState({ record, selection, domains: record.domains, due: beijingInput(record.type_fields.due_at) });
  const domains = draft.record === record && draft.selection === selection ? draft.domains : record.domains;
  const due = draft.record === record && draft.selection === selection ? draft.due : beijingInput(record.type_fields.due_at);
  const [busyState, setBusy] = useState<(Bound<string> & { record: ImprintRecord }) | null>(null);
  const [errorState, setError] = useState<(Bound<string> & { record: ImprintRecord }) | null>(null);
  const [sourceState, setSource] = useState<(Bound<{ loading: boolean; value: SourceRead | null; error: string }> & { record: ImprintRecord }) | null>(null);
  const [revisionState, setRevision] = useState<(Bound<{ loading: boolean; value: RevisionRead | null; error: string; version: number }> & { record: ImprintRecord }) | null>(null);
  const [suggestionState, setSuggestions] = useState<(Bound<ImprintSuggestions> & { record: ImprintRecord }) | null>(null);
  const busy = busyState?.selection === selection && busyState.record === record ? busyState.value : "";
  const error = errorState?.selection === selection && errorState.record === record ? errorState.value : "";
  const source = sourceState?.selection === selection && sourceState.record === record ? sourceState.value : null;
  const revision = revisionState?.selection === selection && revisionState.record === record ? revisionState.value : null;
  const suggestions = suggestionState?.selection === selection && suggestionState.record === record ? suggestionState.value : null;
  async function saveDomains(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const chosen = normalizedDomains(domains), ticket = fence.current.begin("write"); setBusy({ selection, record, value: "domains" }); setError(null);
    try {
      const signature = JSON.stringify([owner, development ? "development" : "user", developmentContextId, sourceKind(record), "domains", record.id, record.version, record.organization_version, chosen]);
      const pending = await attempt(attempts, signature, key => organizationInput(record, chosen, key, developmentContextId));
      if (!fence.current.current(ticket)) return;
      const result = await setOrganization(rpc, pending, developmentContextId);
      if (fence.current.current(ticket)) { attempts.delete(signature); onCommitted(`${t.savedDomains} · ${t.receipt}: ${result.receipt}`); }
    } catch (failure) { if (fence.current.current(ticket)) setError({ selection, record, value: failureText(failure, locale) }); }
    finally { if (fence.current.current(ticket)) setBusy(null); }
  }
  async function saveDue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (development || busy || !canEditDue(record)) return;
    const ticket = fence.current.begin("write"); setBusy({ selection, record, value: "due" }); setError(null);
    try {
      const iso = dueIso(due), signature = JSON.stringify([owner, "due", record.id, record.version, iso]);
      const pending = await attempt(attempts, signature, key => taskDueInput(record, key, iso));
      if (!fence.current.current(ticket)) return;
      const result = await mutateRecord(rpc, pending);
      if (fence.current.current(ticket)) { attempts.delete(signature); onCommitted(`${t.savedDue} · ${t.receipt}: ${result.receipt}`); }
    } catch (failure) { if (fence.current.current(ticket)) setError({ selection, record, value: failureText(failure, locale) }); }
    finally { if (fence.current.current(ticket)) setBusy(null); }
  }
  async function sourceRead(evidence: string, historicalVersion?: number) {
    if (development && sourceKind(record) !== "canonical") return;
    const ticket = fence.current.begin("source"); setSource({ selection, record, value: { loading: true, value: null, error: "" } });
    try { const value = await readSource(rpc, record.id, evidence, includeHistory, record.version, { isCurrent: () => fence.current.current(ticket) }, historicalVersion); if (fence.current.current(ticket)) setSource({ selection, record, value: { loading: false, value, error: "" } }); }
    catch (failure) { if (fence.current.current(ticket)) setSource({ selection, record, value: { loading: false, value: null, error: failureText(failure, locale) } }); }
  }
  async function revisionRead(version: number) {
    if (!includeHistory) return;
    const ticket = fence.current.begin("revision"); setRevision({ selection, record, value: { loading: true, value: null, error: "", version } });
    try {
      const value = await readRevision(rpc, record, version, developmentContextId, { isCurrent: () => fence.current.current(ticket) });
      if (fence.current.current(ticket)) setRevision({ selection, record, value: { loading: false, value, error: "", version } });
    } catch (failure) { if (fence.current.current(ticket)) setRevision({ selection, record, value: { loading: false, value: null, error: failureText(failure, locale), version } }); }
  }
  const sources = evidenceReferences(record), relations = relatedReferences(record);
  const matchedRevisions = searchRevisions(record), matchedSources = searchSources(record);
  const historyMatch = matchedRevisions.length > 0 || matchedSources.some(item => item.source_record_version < record.version);
  const matchTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(locale, { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "";
  return <article className="imprints-card record-item" data-record-id={record.id} data-source-kind={sourceKind(record) ?? "canonical"} data-currentness={record.record_currentness}>
    <h4>{record.title || (locale === "zh-CN" ? "未命名印记" : "Untitled imprint")}</h4>{immediateAuthoritativeRecord(record) && <p className="context-muted">{locale === "zh-CN" ? "即时权威上下文" : "Verified authoritative context"}</p>}<p className="imprints-card-meta">{development && sourceKind(record) === "development" ? (locale === "zh-CN" ? "原始种类：" : "Original kind: ") + record.record_type : (t.typeNames as Record<string, string>)[record.record_type] ?? record.record_type} · {record.lifecycle_status === null ? (locale === "zh-CN" ? "兼容记录，生命周期未提供" : "Compatibility record; lifecycle not provided") : (t.lifecycle as Record<string, string>)[record.lifecycle_status.toLowerCase()] ?? record.lifecycle_status} · {(t.currentNames as Record<string, string>)[record.record_currentness] ?? t.currentNames.UNKNOWN}</p>
    {development && sourceKind(record) === "development" && <p className="notice">{record.qualification === "candidate" || record.authority === "candidate" ? (locale === "zh-CN" ? "候选内容：不代表已接受的任务或决策。" : "Development candidate: not an accepted task or decision.") : (locale === "zh-CN" ? "上下文记录的接受资格未提供，不推断为正式结论。" : "Acceptance qualification is unavailable; no accepted conclusion is inferred.")}</p>}
    {historyMatch && <p className="notice">{locale === "zh-CN" ? "历史版本命中（非当前）：详情中保留最新正文，并分别显示匹配的历史版本。" : "Historical-version match (not current): details preserve the latest body and show matching retained revisions separately."}</p>}
    {record.source_semantics === "legacy_compatibility" && <p className="context-muted">{locale === "zh-CN" ? "兼容记录：保留原有身份与正文，不视为正式当前结论。" : "Compatibility record: original identity and body are retained; this is not an authoritative current conclusion."}</p>}
    <div className="imprints-domains">{record.domains.length ? record.domains.map(key => <span key={key}>{labels[key]}</span>) : <span>{t.unclassified}</span>}</div>
    <details className="record-details" open={expanded || undefined}><summary>{t.details}</summary>
      <dl><dt>{t.identity}</dt><dd><code>{record.id}</code></dd><dt>{t.version}</dt><dd>{record.version}</dd><dt>{t.scope}</dt><dd>{scopeLabel}</dd><dt>{t.currentness}</dt><dd>{(t.currentNames as Record<string, string>)[record.record_currentness] ?? t.currentNames.UNKNOWN}</dd></dl>
      {record.record_currentness !== "CURRENT" && <p className="notice">{t.historical}</p>}
      <h5>{t.full}</h5><pre className="imprints-content">{record.content}</pre>
      {matchedRevisions.length > 0 && <section aria-label={locale === "zh-CN" ? "历史版本命中" : "Historical-version matches"}><h5>{locale === "zh-CN" ? "历史版本命中" : "Historical-version matches"}</h5>
        <p>{locale === "zh-CN" ? "以下为实际留存、匹配本次查询的历史原文，不替代最新正文，也不作为当前输入。" : "These retained historical bodies match this query. They do not replace the latest body and are not current input."}</p>
        {matchedRevisions.length ? matchedRevisions.map(item => <div key={String(item.matched_record_version)}><h6>{t.version} {String(item.matched_record_version)} · {locale === "zh-CN" ? "历史，非当前" : "History, not current"} · {matchTime(item.updated_at)}</h6>
          {item.source_kind === "development" ? <pre className="imprints-content">{item.content}</pre> : <><blockquote className="imprints-content">{item.snippet}</blockquote><button type="button" onClick={() => void revisionRead(item.version)}>{locale === "zh-CN" ? "读取这个版本的完整正文" : "Read this revision in full"}: {item.version}</button></>}
        </div>)
          : <p>{locale === "zh-CN" ? "匹配版本的完整结果未能核实，请重新读取，不从摘要拼出原文。" : "The matched revisions could not be verified. Read again; full text is not reconstructed from a summary."}</p>}
      </section>}
      {record.matched_revisions_truncated === true && <p role="status">{locale === "zh-CN" ? `已显示 ${matchedRevisions.length} 个历史命中，共 ${String(record.matched_revision_count)} 个；可缩小关键词继续查找。` : `Showing ${matchedRevisions.length} of ${String(record.matched_revision_count)} historical matches. Narrow the query to find more.`}</p>}
      {revision && <section aria-label={locale === "zh-CN" ? "历史版本完整正文" : "Full historical revision"}>
        <h5>{locale === "zh-CN" ? "历史版本" : "Historical revision"} {revision.version} · {locale === "zh-CN" ? "非当前内容" : "Not current content"}</h5>
        {revision.loading && <p role="status">{t.loading}</p>}{revision.error && <p role="alert">{revision.error}</p>}
        {revision.value?.available && revision.value.record && <><p>{matchTime(revision.value.record.updated_at)}</p><pre className="imprints-content">{revision.value.record.content}</pre>
          {Array.isArray(revision.value.record.source_refs) && revision.value.record.source_refs.filter(uuid).map(id => <button type="button" key={id} onClick={() => void sourceRead(id, revision.version)}>{t.sourceButton}: {id}</button>)}
        </>}
        {revision.value && !revision.value.available && <p role="alert">{revision.value.reason === "stale_record_version" ? t.conflict
          : revision.value.reason === "revision_content_exceeds_read_limit" ? (locale === "zh-CN" ? "这个版本超过单次完整读取上限，未截断展示。可缩小搜索定位原文。" : "This revision exceeds the full-read limit. It has not been shown as truncated full text; narrow the search to locate it.")
            : (locale === "zh-CN" ? "这份历史正文目前不可读取，请刷新后核对。" : "This retained body is unavailable. Refresh and review.")}</p>}
      </section>}
      {matchedSources.length > 0 && <section aria-label={locale === "zh-CN" ? "来源全文命中" : "Source-text matches"}><h5>{locale === "zh-CN" ? "来源全文命中" : "Source-text matches"}</h5>
        <p>{locale === "zh-CN" ? "以下片段来自已保存的可读取来源；来源原话不自动成为当前结论。" : "These excerpts match saved readable sources. Source words are not automatically current conclusions."}</p>
        {matchedSources.map(item => <div key={`${item.evidence_id}:${item.source_record_version}`}><h6>{t.version} {item.source_record_version} · {matchTime(item.record_updated_at)}{item.historical_record_version ? (locale === "zh-CN" ? " · 历史来源" : " · Historical source") : ""}</h6>
          <blockquote className="imprints-content">{item.snippet}</blockquote><button type="button" onClick={() => void sourceRead(item.evidence_id, item.historical_record_version ?? undefined)}>{t.sourceButton}: {item.evidence_id}</button>
        </div>)}
        {record.matched_sources_truncated === true && <p role="status">{locale === "zh-CN" ? `已显示 ${matchedSources.length} 个来源命中，共 ${String(record.matched_source_count)} 个；可缩小关键词继续查找。` : `Showing ${matchedSources.length} of ${String(record.matched_source_count)} source matches. Narrow the query to find more.`}</p>}
      </section>}
      {record.legacy_missing_fields && <details><summary>{locale === "zh-CN" ? "原有元数据（未提供项保留为空）" : "Original metadata (missing values remain null)"}</summary><pre>{JSON.stringify(record.legacy_missing_fields, null, 2)}</pre></details>}
      {development && Array.isArray(record.history) && record.history.length > 0 && <details><summary>{locale === "zh-CN" ? "实际保留的版本历史" : "Retained version history"}</summary><pre className="imprints-content">{JSON.stringify(record.history, null, 2)}</pre></details>}
      {typeof record.closure_summary === "string" && record.closure_summary && <><h5>{t.closure}</h5><pre className="imprints-content">{record.closure_summary}</pre></>}
      {Object.keys(record.relations).length > 0 && <div><h5>{t.relations}</h5>{relations.map(id => <button type="button" key={id} onClick={() => void onRelated(id, development ? sourceKind(record) ?? undefined : undefined)}>{t.related}: {id}</button>)}<details><summary>{t.relations}</summary><pre>{JSON.stringify(record.relations, null, 2)}</pre></details></div>}
      <ExistingAssociationEditor record={record} selection={selection} owner={owner} rpc={rpc} locale={locale}
        contextId={developmentContextId} prepare={(signature, make) => attempt(attempts, signature, make)} onCommitted={onCommitted} onRelated={onRelated} />
      <MixedContentEditor record={record} selection={selection} owner={owner} rpc={rpc} locale={locale} scopeLabel={scopeLabel}
        contextId={developmentContextId} onCommitted={onCommitted} onRelated={onRelated} />
      <h5>{t.source}</h5>{development && sourceKind(record) !== "canonical" ? <p>{locale === "zh-CN" ? "此上下文原始记录的来源读取尚未接入。当前显示自身完整正文及实际返回的历史，不借用用户来源接口。" : "Source reading is not connected for this original development record. Its own full body and returned history are readable; user source APIs are not used."}</p> : sources.length ? sources.map(id => <button type="button" key={id} onClick={() => void sourceRead(id)}>{t.sourceButton}: {id}</button>) : <p>{t.noSource}</p>}
      {record.source_refs.length > 0 && <details><summary>{t.sourceMetadata}</summary><pre>{JSON.stringify(record.source_refs, null, 2)}</pre></details>}
      {source && <div className="imprints-source">{source.loading && <p role="status">{t.loading}</p>}{source.error && <p role="alert">{source.error}</p>}{source.value && <>{source.value.historical && <p className="notice">{locale === "zh-CN" ? "历史／诊断来源阅读，不能作为当前输入。" : "Historical / diagnostic source reading; never eligible as current input."}{source.value.evidenceStatus === "withdrawn" ? (locale === "zh-CN" ? "已撤回。" : " Withdrawn.") : source.value.evidenceStatus === "invalidated" ? (locale === "zh-CN" ? "已失效。" : " Invalidated.") : ""}</p>}{source.value.available && source.value.content !== null ? <><h5>{t.sourceBody}</h5><pre className="imprints-content">{source.value.content}</pre></> : <p>{source.value.reason === "stale_record_version" ? t.conflict : source.value.reason === "source_content_exceeds_read_limit" ? (locale === "zh-CN" ? "来源超过单次完整读取上限，未截断展示。可缩小搜索定位原文。" : "This source exceeds the full-read limit and has not been shown as truncated full text. Narrow the search to locate it.") : source.value.available ? t.locatorOnly : t.sourceMissing}</p>}{source.value.evidence && <details><summary>{t.sourceMetadata}</summary><pre>{JSON.stringify(source.value.evidence, null, 2)}</pre></details>}</>}</div>}
    </details>
    <details className="imprints-editor"><summary>{t.editDomains}</summary><form onSubmit={saveDomains}><p>{t.domainsHelp}</p>
      <button type="button" disabled={!!busy} onClick={() => setSuggestions({ selection, record,
        value: suggestImprintOrganization(record.content, { sourceKind: "unknown", locale }) })}>{locale === "zh-CN" ? "查看领域建议" : "Review domain suggestions"}</button>
      {suggestions && <section aria-label={locale === "zh-CN" ? "领域候选建议" : "Candidate domain suggestions"}>
        <p>{locale === "zh-CN" ? "本地候选建议：参考正文中明确的活动和用途，不生成任务或决策；这里的建议需要确认后保存。" : "Local candidates based on clear activities and uses. They do not create tasks or decisions; suggestions here require confirmation and saving."}</p>
        {suggestions.domains.length ? <><ul>{suggestions.domains.map(item => <li key={item.domain}><strong>{labels[item.domain]}</strong><p>{item.reason}</p><blockquote>{item.source.text}</blockquote></li>)}</ul>
          <button type="button" disabled={!!busy} onClick={() => setDraft({ record, selection, due,
            domains: normalizedDomains([...domains, ...suggestions.domains.map(item => item.domain)]) })}>{locale === "zh-CN" ? "采用这些建议" : "Use these suggestions"}</button></>
          : <p>{locale === "zh-CN" ? "没有足够明确的用途依据，请按实际用途手动勾选。" : "No sufficiently explicit purpose was found. Choose domains manually for the actual use."}</p>}
      </section>}
      <fieldset disabled={!!busy}><legend>{t.domains}</legend><div className="imprints-checkboxes">{DOMAIN_KEYS.map(key => <label key={key}><input type="checkbox" checked={domains.includes(key)} onChange={event => setDraft({ record, selection, due, domains: normalizedDomains(event.target.checked ? [...domains, key] : domains.filter(item => item !== key)) })} />{labels[key]}</label>)}</div></fieldset><button type="submit" disabled={!!busy || JSON.stringify(normalizedDomains(domains)) === JSON.stringify(record.domains)}>{busy === "domains" ? t.saving : t.saveDomains}</button></form></details>
    {!development && record.record_type === "task" && (canEditDue(record) ? <form className="imprints-editor" onSubmit={saveDue}><label>{t.due}<input type="datetime-local" aria-label={`${t.due}: ${record.title}`} value={due} onChange={event => setDraft({ record, selection, domains, due: event.target.value })} disabled={!!busy} /></label><p>{t.dueHelp}</p><button type="submit" disabled={!!busy || due === beijingInput(record.type_fields.due_at)}>{busy === "due" ? t.saving : t.saveDue}</button></form> : <p className="context-muted">{t.dueReadOnly}</p>)}
    {error && <p role="alert" className="notice error">{error}</p>}
  </article>;
}
