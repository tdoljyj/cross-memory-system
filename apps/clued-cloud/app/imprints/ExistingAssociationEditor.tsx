"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { SelectionFence, type ImprintRecord, type Json, type Locale } from "./imprint-model";
import { ImprintFailure, readImprints, setAssociation, type NativeRpc, type PreparedWrite } from "./imprint-client";
import { associationInput, associations, canAssociate, eligibleAssociationTarget, findExistingAssociations,
  type Association, type AssociationMatches } from "./imprint-associations";

type Bound<T> = { record: ImprintRecord; selection: object; value: T };
export default function ExistingAssociationEditor({ record, selection, owner, rpc, locale, contextId, prepare, onCommitted, onRelated }: {
  record: ImprintRecord; selection: object; owner: string; rpc: NativeRpc; locale: Locale; contextId?: string;
  prepare: (signature: string, make: (key: string) => Json) => Promise<PreparedWrite>;
  onCommitted: (message: string) => void; onRelated: (id: string, kind?: "canonical" | "development") => void;
}) {
  const zh = locale === "zh-CN", fence = useRef(new SelectionFence());
  useLayoutEffect(() => { const active = fence.current; active.select(selection); return () => { active.select({}); active.begin("read"); active.begin("write"); }; }, [record, selection, owner]);
  const [queryState, setQuery] = useState<Bound<string> | null>(null);
  const [resultsState, setResults] = useState<Bound<AssociationMatches> | null>(null);
  const [choiceState, setChoice] = useState<Bound<{ action: "add"; target: ImprintRecord } | { action: "remove"; target: Association }> | null>(null);
  const [busyState, setBusy] = useState<Bound<"read" | "write"> | null>(null);
  const [errorState, setError] = useState<Bound<string> | null>(null);
  const bound = <T,>(value: Bound<T> | null): T | null => value?.selection === selection && value.record === record ? value.value : null;
  const query = bound(queryState) ?? "", results = bound(resultsState), choice = bound(choiceState), busy = bound(busyState), error = bound(errorState);
  const links = associations(record), editable = canAssociate(record);
  const sayError = (failure: unknown) => setError({ record, selection, value: failure instanceof ImprintFailure && failure.reason === "conflict"
    ? zh ? "原条目或关联已有更新，请刷新核对后再选。" : "The source, target or associations changed. Refresh and review before choosing again."
    : failure instanceof ImprintFailure && failure.reason === "unavailable"
      ? zh ? "当前条目不可读取或不符合关联条件，请核对范围和权限。" : "This record is unavailable or ineligible for association. Check scope and permissions."
      : zh ? "本次结果未能确认，请刷新重试；不能据此判断没有相关条目。" : "This result could not be confirmed. Refresh; this is not evidence that no related record exists." });
  async function lookup() {
    if (!editable || busy) return;
    const ticket = fence.current.begin("read"); setBusy({ record, selection, value: "read" }); setError(null); setChoice(null); setResults(null);
    try {
      const value = await findExistingAssociations(rpc, record, query, contextId, { isCurrent: () => fence.current.current(ticket) });
      if (fence.current.current(ticket)) setResults({ record, selection, value });
    } catch (failure) { if (fence.current.current(ticket)) sayError(failure); }
    finally { if (fence.current.current(ticket)) setBusy(null); }
  }
  async function confirm() {
    if (!choice || busy || !editable) return;
    const ticket = fence.current.begin("write"); setBusy({ record, selection, value: "write" }); setError(null);
    try {
      if (choice.action === "add") {
        const fresh = await readImprints(rpc, { view: choice.target.record_type as "task" | "decision", scope: record.scope,
          query: "", include_history: false, limit: 30, cursor: 0, id: choice.target.id,
          ...(contextId ? { source_kind: "canonical" as const } : {}) }, contextId, { isCurrent: () => fence.current.current(ticket) });
        if (!fence.current.current(ticket)) return;
        if (fresh.records.length !== 1 || fresh.records[0].version !== choice.target.version
          || !eligibleAssociationTarget(record, fresh.records[0], contextId)) throw new ImprintFailure("conflict");
      }
      const signature = JSON.stringify([owner, "association", contextId, record.id, record.source_kind, record.version,
        record.association_version, choice.action, choice.action === "add" ? [choice.target.id, choice.target.version] : choice.target.record_id]);
      const pending = await prepare(signature, key => associationInput(record, choice.target, choice.action, key, contextId));
      if (!fence.current.current(ticket)) return;
      const saved = await setAssociation(rpc, pending);
      if (fence.current.current(ticket)) onCommitted((zh ? choice.action === "add" ? "已关联原条目" : "已取消查阅关联"
        : choice.action === "add" ? "Original record associated" : "Reading association removed") + (zh ? " · 回执：" : " · Receipt: ") + saved.receipt);
    } catch (failure) { if (fence.current.current(ticket)) sayError(failure); }
    finally { if (fence.current.current(ticket)) setBusy(null); }
  }
  if (!Array.isArray(record.associations)) return null; // Old service DTO: no invented capability.
  const reasons = zh ? { identity: "原文提及该条目的 ID", title: "原文包含该条目的标题", terms: "标题与原文有共同词语，需核对", search: "关键词搜索结果，需核对" }
    : { identity: "The original mentions this ID", title: "The original contains this title", terms: "Shared title words; review required", search: "Keyword result; review required" };
  return <section className="imprints-editor" aria-label={zh ? "关联的任务与决策" : "Associated tasks and decisions"}>
    <h5>{zh ? "关联的任务与决策" : "Associated tasks and decisions"}</h5>
    {links.map(link => <div key={link.record_id}><button type="button" onClick={() => onRelated(link.record_id, "canonical")}>{link.title}</button>
      {editable && <button type="button" disabled={!!busy} onClick={() => setChoice({ record, selection, value: { action: "remove", target: link } })}>{zh ? "取消关联" : "Remove association"}</button>}</div>)}
    {Number(record.association_unavailable_count) > 0 && <p role="status">{zh ? "部分原有关联目前不可读取或已失效，不代表没有关联。" : "Some existing associations are unavailable or no longer current; they have not been treated as absent."}</p>}
    {editable && <details><summary>{zh ? "查找并关联已有条目" : "Find and associate an existing record"}</summary>
      <p>{zh ? "按这条印记的原文找已有任务或决策，也可输入标题中的关键词。匹配仅供核对，不会生成新任务。" : "Find existing tasks or decisions using this imprint, or enter words from their title. Matches require review and never create a task."}</p>
      <label>{zh ? "查找关键词（可选）" : "Search words (optional)"}<input aria-label={zh ? "查找已有条目关键词" : "Existing record search words"} value={query} maxLength={200} disabled={!!busy}
        onChange={event => { fence.current.begin("read"); setQuery({ record, selection, value: event.target.value }); setResults(null); setChoice(null); setError(null); }} /></label>
      <button type="button" disabled={!!busy} onClick={() => void lookup()}>{busy === "read" ? zh ? "正在查找…" : "Finding…" : zh ? "查找已有任务或决策" : "Find existing tasks or decisions"}</button>
      {results && <div>{!results.complete && <p role="status">{zh ? "本次只核对了部分条目，不能证明已查全；可输入更具体的关键词缩小范围。" : "Only part of the scope was checked. Refine the words; this is not a complete search."}</p>}
        {results.matches.length > 1 && <p>{zh ? "找到多条可能相关的记录，请逐条核对后选择。" : "Several records may be related. Review and choose one."}</p>}
        {results.matches.length === 0 && <p>{results.complete ? zh ? "本次未找到明确匹配，可调整关键词再查。" : "No clear match in this search. Try other words."
          : zh ? "已检查部分未找到明确匹配，仍有条目未核对。" : "No clear match in the checked portion; some records remain unchecked."}</p>}
        {results.matches.map(match => <div key={match.record.id}><strong>{match.record.title}</strong><p>{reasons[match.reason]}</p>
          <p>{match.record.content.slice(0, 240)}</p><button type="button" disabled={!!busy || links.some(link => link.record_id === match.record.id)}
            onClick={() => setChoice({ record, selection, value: { action: "add", target: match.record } })}>{links.some(link => link.record_id === match.record.id) ? zh ? "已关联" : "Associated" : zh ? "核对这条记录" : "Review this record"}</button></div>)}
      </div>}
    </details>}
    {choice && <section aria-label={zh ? "确认查阅关联" : "Confirm reading association"}>
      <h6>{choice.target.title}</h6>{choice.action === "add" && <><p>{choice.target.record_type === "task" ? zh ? "已有任务" : "Existing task" : zh ? "已有决策" : "Existing decision"}</p>
        <pre className="imprints-content">{choice.target.content}</pre></>}
      <p>{zh ? "仅建立或取消查阅关联，原文、任务状态和权限保持。" : "Only the reading association changes. Original text, state and permissions remain."}</p>
      <button type="button" disabled={!!busy} onClick={() => void confirm()}>{busy === "write" ? zh ? "正在保存…" : "Saving…" : choice.action === "add" ? zh ? "确认关联" : "Confirm association" : zh ? "确认取消关联" : "Confirm removal"}</button>
      <button type="button" disabled={!!busy} onClick={() => setChoice(null)}>{zh ? "返回选择" : "Back to choices"}</button>
    </section>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
