"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { object, type ImprintRecord, type Locale } from "./imprint-model";
import { ImprintFailure, prepareWrite, readImprints, setAssociation, type NativeRpc, type PreparedWrite } from "./imprint-client";
import { associationInput, type AssociationRead } from "./imprint-associations";
import { suggestImprintOrganization, type ImprintSuggestions } from "./imprint-suggestions";
import { extractionInput, extractionTexts, extractionStatus, issueExtraction, prepareExtraction, promoteExtraction, promotionInput,
  type ExtractionCandidate, type ExtractionConfirmation } from "./imprint-extraction";

type Props = { record: ImprintRecord; selection: object; owner: string; rpc: NativeRpc; locale: Locale; contextId?: string; scopeLabel?: string;
  onCommitted: (message: string) => void; onRelated: (id: string, kind?: "canonical" | "development", association?: AssociationRead) => void };
export default function MixedContentEditor(props: Props) {
  // A changed session/selection/source gets an entirely new interaction. Late
  // replies can never bind an old preview or token to the new record.
  const boundary = useMemo(() => ({ record: props.record, selection: props.selection, owner: props.owner, key: crypto.randomUUID() }), [props.record, props.selection, props.owner]);
  return extractionTexts(props.record).length ? <ExtractionSession key={boundary.key} {...props} /> : null;
}
function ExtractionSession({ record, rpc, locale, contextId, scopeLabel, onCommitted, onRelated }: Props) {
  const zh = locale === "zh-CN", texts = extractionTexts(record), alive = useRef(true), inFlight = useRef(false);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [slot, setSlot] = useState(texts[0].slot), text = texts.find(value => value.slot === slot)!;
  const [own, setOwn] = useState(false), [suggestions, setSuggestions] = useState<ImprintSuggestions | null>(null);
  const [chosen, setChosen] = useState<number | null>(null), [bucket, setBucket] = useState(""), [rationale, setRationale] = useState("");
  const [candidate, setCandidate] = useState<ExtractionCandidate | null>(null), [confirmation, setConfirmation] = useState<ExtractionConfirmation | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [receipt, setReceipt] = useState("");
  const [sourceLocked, setSourceLocked] = useState(false);
  // Keep exact write payload/key across uncertain replies. A new confirmation
  // has its own key; retrying a lost promotion never requests a second token.
  const prepared = useRef<PreparedWrite | null>(null), promoted = useRef<PreparedWrite | null>(null), linked = useRef<PreparedWrite | null>(null);
  const fragment = chosen === null ? null : suggestions?.fragments[chosen] ?? null;
  function reset() { setSuggestions(null); setChosen(null); setCandidate(null); setConfirmation(null); prepared.current = null; promoted.current = null; linked.current = null; setSourceLocked(false); setError(""); setReceipt(""); }
  function changeFields() { setConfirmation(null); promoted.current = null; setError(""); }
  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { await action(); } catch (failure) {
      if (alive.current) setError(failure instanceof ImprintFailure && failure.code === "reauthentication_required"
        ? zh ? "请重新登录后再确认。原候选已保留。" : "Sign in again to confirm. The candidate is preserved."
        : failure instanceof ImprintFailure && failure.reason === "conflict"
          ? zh ? "原文已有变化，请刷新后重新核对片段。" : "The source changed. Refresh and review the fragment."
          : failure instanceof ImprintFailure && failure.reason === "unavailable"
            ? (zh ? "本次未获准完成，请刷新核对来源和候选状态。" : "This action was not admitted. Refresh and review source and candidate state.")
            : zh ? "结果未能确认。请用同一按钮核对原操作，避免重复生成。" : "Result unknown. Use the same button to recover this operation.");
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  async function review() {
    if (!own || !fragment || [...fragment.source.text].length > 300 || (fragment.kind === "task" ? !bucket : !rationale.trim())) return;
    await run(async () => {
      setSourceLocked(true);
      if (!prepared.current) prepared.current = await prepareWrite(await extractionInput(record, text, fragment.source, fragment.kind, crypto.randomUUID(), contextId));
      if (!alive.current) return;
      const value = await prepareExtraction(rpc, prepared.current);
      if (!alive.current) return; setCandidate(value);
      if (value.candidate_status !== "pending") return;
      const view = await issueExtraction(rpc, value, fragment.kind === "task" ? { execution_bucket: bucket } : { rationale: rationale.trim() });
      if (!alive.current) return; setConfirmation(view); promoted.current = null;
    });
  }
  async function confirm() {
    if (!confirmation || !prepared.current) return;
    await run(async () => {
      if (!promoted.current) promoted.current = await promotionInput(confirmation, crypto.randomUUID());
      if (!alive.current) return;
      const saved = await promoteExtraction(rpc, promoted.current);
      if (!alive.current) return; setReceipt(saved);
      const recovered = await extractionStatus(rpc, confirmation.candidate_id);
      if (alive.current) { setCandidate(recovered); if (recovered.candidate_status === "promoted") setConfirmation(null); }
    });
  }
  async function associate() {
    if (!candidate?.record_id || !candidate.record_version) return;
    await run(async () => {
      const found = await readImprints(rpc, { view: candidate.kind, scope: record.scope, query: "", include_history: false,
        id: candidate.record_id!, limit: 1, cursor: 0, ...(contextId ? { source_kind: "canonical" } : {}) }, contextId, { isCurrent: () => alive.current });
      if (!alive.current) return;
      if (found.records.length !== 1 || found.records[0].version !== candidate.record_version) throw new ImprintFailure("conflict");
      if (!linked.current) linked.current = await prepareWrite(associationInput(record, found.records[0], "add", crypto.randomUUID(), contextId));
      if (!alive.current) return;
      const saved = await setAssociation(rpc, linked.current);
      if (alive.current) onCommitted((zh ? "已生成并关联 · 回执：" : "Created and associated · Receipt: ") + saved.receipt);
    });
  }
  const mutation = confirmation && object(confirmation.confirmation_view.mutation) ? confirmation.confirmation_view.mutation : null;
  const typeFields = mutation && object(mutation.type_fields) ? mutation.type_fields : null;
  const confirmedScope = confirmation ? String(confirmation.confirmation_view.scope) : "";
  const confirmedScopeLabel = scopeLabel && confirmedScope === record.scope ? scopeLabel
    : confirmedScope === "global" ? (zh ? "个人记录" : "Personal records") : confirmedScope === "profile" ? (zh ? "个人资料" : "Profile")
      : confirmedScope.startsWith("project:") ? `${zh ? "项目" : "Project"} · ${confirmedScope.slice(8)}` : zh ? "范围待核对" : "Scope requires review";
  return <details className="imprints-editor"><summary>{zh ? "从原文提取任务或决策" : "Extract tasks or decisions from the original"}</summary>
    <p>{zh ? "逐条核对片段，再确认是否另建任务或决策。说明文字继续保留在原文；已有条目可用上方“查找并关联已有条目”。" : "Review each fragment before creating a task or decision. Explanation stays in the original. Use Find and associate above for existing records."}</p>
    {texts.length > 1 && <label>{zh ? "提取哪段正文" : "Text to review"}<select value={slot} disabled={busy || sourceLocked} onChange={event => { setSlot(event.target.value as typeof slot); reset(); }}>{texts.map(value => <option key={value.slot} value={value.slot}>{value.slot}</option>)}</select></label>}
    {record.source_kind === "development" && <><p>{zh ? "以下为上下文原始记录的正文，尚非正式结论。新条目需经本次确认。" : "This is raw context text, not an accepted conclusion. A new record requires your confirmation."}</p><pre className="imprints-content">{text.text}</pre></>}
    <label><input type="checkbox" checked={own} disabled={busy || sourceLocked} onChange={event => { setOwn(event.target.checked); reset(); }} />{zh ? "这些是我自己的表达；引用、他人要求和示例不算我的承诺。" : "These are my own words; quotations, others’ requests and examples are not my commitments."}</label>
    <button type="button" disabled={!own || busy || sourceLocked} onClick={() => { setSuggestions(suggestImprintOrganization(text.text, { sourceKind: "owner_text", mixedContent: true, locale })); setChosen(null); }}>{zh ? "查看可提取片段" : "Review extractable fragments"}</button>
    {suggestions && <div>{!suggestions.fragments.length && <p role="status">{zh ? "没有找到明确的行动或选择语句。原文保留，不自动生成条目。" : "No explicit action or choice found. The original is preserved."}</p>}
      {suggestions.fragments.map((item, index) => <div key={item.kind + ":" + item.source.start}><label><input type="radio" name={"extract-" + record.id} checked={chosen === index} disabled={busy || sourceLocked} onChange={() => { setChosen(index); setBucket(""); setRationale(""); setConfirmation(null); }} />{item.kind === "task" ? zh ? "任务片段" : "Task fragment" : zh ? "决策片段" : "Decision fragment"}</label><blockquote>{item.source.text}</blockquote>
        {[...item.source.text].length > 300 && <p>{zh ? "此片段超过300字，暂不支持整段提取；请先在原文中明确独立语句。" : "This fragment exceeds 300 characters. Make the sentence explicit in the source first."}</p>}</div>)}
    </div>}
    {fragment && candidate?.candidate_status !== "promoted" && <div>
      {fragment.kind === "task" ? <label>{zh ? "任务安排" : "Task placement"}<select value={bucket} disabled={busy || !!confirmation} onChange={event => { setBucket(event.target.value); changeFields(); }}><option value="">{zh ? "请选择" : "Choose"}</option>{[...["now", "next", "blocked", "later"]].map((value, i) => <option key={value} value={value}>{zh ? ["现在", "接下来", "阻塞", "以后"][i] : value}</option>)}</select></label>
        : <label>{zh ? "决定的理由" : "Reason for the decision"}<textarea value={rationale} maxLength={2000} disabled={busy || !!confirmation} onChange={event => { setRationale(event.target.value); changeFields(); }} /></label>}
      {!confirmation && (!candidate || candidate.candidate_status === "pending") && <button type="button" disabled={busy || (fragment.kind === "task" ? !bucket : !rationale.trim()) || [...fragment.source.text].length > 300} onClick={() => void review()}>{zh ? "准备候选并核对正式条目" : "Prepare candidate and review the formal record"}</button>}
    </div>}
    {confirmation && mutation && <section aria-label={zh ? "核对将生成的正式条目" : "Review the formal record to create"}><h5>{String(mutation.title)}</h5><pre className="imprints-content">{String(mutation.content)}</pre>
      <p>{zh ? "性质：" : "Type: "}{confirmation.confirmation_view.record_type === "task" ? zh ? "任务" : "Task" : zh ? "决策" : "Decision"}{" · "}{zh ? "范围：" : "Scope: "}{confirmedScopeLabel}</p>
      {typeFields && <p>{fragment?.kind === "task" ? (zh ? "安排：" : "Placement: ") + (zh ? ({ now: "现在", next: "接下来", blocked: "阻塞", later: "以后" } as Record<string,string>)[String(typeFields.execution_bucket)] ?? String(typeFields.execution_bucket) : String(typeFields.execution_bucket)) : (zh ? "理由：" : "Reason: ") + String(typeFields.rationale)}</p>}
      <p>{zh ? "确认后按你的明确表达保存为正式条目；相对时间仍保留原文，截止日期需另行设置。" : "Confirm to save your explicit statement as a formal record. Relative dates stay quoted; set a due date separately."}</p>
      <button type="button" disabled={busy} onClick={() => void confirm()}>{busy ? zh ? "正在核对…" : "Checking…" : zh ? "确认生成正式条目" : "Confirm formal record creation"}</button>
      <button type="button" disabled={busy} onClick={changeFields}>{zh ? "返回修改安排或理由" : "Change placement or reason"}</button>
    </section>}
    {receipt && candidate?.candidate_status !== "promoted" && <p role="status">{zh ? "已收到处理回执，正在核对结果：" : "Processing receipt received; checking the outcome: "}{receipt}</p>}
    {candidate?.candidate_status === "promoted" && candidate.record_id && <div role="status"><p>{zh ? "已生成，同一片段不会重复创建。" : "Created. This fragment will not create another copy."}</p><p>{zh ? "回执：" : "Receipt: "}{receipt || candidate.promotion_receipt_id}</p>
      <button type="button" disabled={busy} onClick={() => onRelated(candidate.record_id!, "canonical", { scope: record.scope, recordType: candidate.kind })}>{zh ? "查看生成条目" : "Open the created record"}</button>
      <button type="button" disabled={busy} onClick={() => void associate()}>{zh ? "把生成条目关联到原文" : "Associate the created record with the original"}</button>
      <button type="button" disabled={busy} onClick={reset}>{zh ? "继续核对其他片段" : "Review another fragment"}</button>
    </div>}
    {candidate && !["pending", "promoted"].includes(candidate.candidate_status) && <p role="status">{zh ? "该片段的原候选已结束，未重复创建。请刷新查看其状态。" : "The original candidate is terminal. No duplicate was created; refresh to review its status."}</p>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
