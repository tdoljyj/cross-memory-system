"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { NativeRpc } from "./imprint-client";
import { VIEW_LABELS, type Locale } from "./imprint-model";
import type { Json } from "./imprint-model";
import { bulkCounts, previewBulk, readBulk, writeBulk, type BulkBatch, type BulkPreview, type BulkSelection } from "./imprint-bulk";

export default function ImprintBulkPanel({ rpc, locale, selection, scopeLabel, onChanged, onOpenRecord, owner, describeSavedScope }: {
  rpc: NativeRpc; locale: Locale; selection: BulkSelection; scopeLabel: string; owner: string; onChanged: () => void; onOpenRecord: (id: string) => void;
  describeSavedScope: (selection: Json) => string;
}) {
  const zh = locale === "zh-CN";
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [batch, setBatch] = useState<BulkBatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState("");
  const live = useRef(true), paused = useRef(false);
  const batchRef = useRef<BulkBatch | null>(null);
  function accept(value: BulkBatch) { batchRef.current = value; setBatch(value); }
  // Invalidate synchronously with a committed account/scope/context replacement,
  // before an old Promise continuation can dispatch its next write.
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; paused.current = true; }; }, []);
  const failed = () => { batchRef.current = null; setBatch(null); setMessage(zh ? "结果尚未确认。请先读取批次进度，再决定是否继续；不要重复创建批次。" : "The result is unconfirmed. Read saved progress before continuing."); };
  async function status() {
    setBusy(true); setMessage(""); batchRef.current = null; setBatch(null);
    try { const value = await readBulk(rpc); if (live.current) accept(value); }
    catch { if (live.current) failed(); }
    finally { if (live.current) setBusy(false); }
  }
  async function rehearse() {
    setBusy(true); setPreviewing(true); setMessage(""); setProgress(""); setPreview(null); batchRef.current = null; setBatch(null); paused.current = false;
    try {
      const value = await previewBulk(rpc, selection, { owner, isCurrent: () => live.current && !paused.current,
        onProgress: (scanned, total, ready) => { if (live.current) setProgress(zh ? `已预演 ${scanned}/${total} 条，找到可补标签 ${ready} 条。` : `Previewed ${scanned}/${total}; ready ${ready}.`); } });
      if (!live.current) return;
      if (paused.current) throw new Error("preview_cancelled");
      setPreview(value); const saved = await readBulk(rpc);
      if (paused.current) throw new Error("preview_cancelled");
      if (live.current) accept(saved);
    } catch { if (live.current) { setProgress(""); setPreview(null); failed();
      if (paused.current) setMessage(zh ? "已停止预演，没有修改标签。" : "Preview stopped. Labels have not changed."); } }
    finally { if (live.current) { setBusy(false); setPreviewing(false); } }
  }
  async function begin() {
    if (!preview || busy) return;
    setBusy(true); setMessage(""); batchRef.current = null; setBatch(null);
    try {
      const value = await writeBulk(rpc, "begin", { selection, digest: preview.digest, proof: preview.proof, items: preview.items }, crypto.randomUUID(), () => live.current);
      if (live.current) { accept(value); setMessage(zh ? "批次已保存，尚未修改标签。核对后点击继续处理。" : "Batch saved. Labels have not changed. Review and continue."); }
    } catch { if (live.current) { setPreview(null); failed(); } }
    finally { if (live.current) setBusy(false); }
  }
  async function run(action: "advance" | "undo" | "cancel") {
    if (busy || !batchRef.current?.available) return;
    setBusy(true); setMessage(""); paused.current = false;
    try {
      let current = await readBulk(rpc);
      if (!live.current) return;
      accept(current);
      for (let step = 0; step < 100 && live.current && !paused.current && current.available; step++) {
        const counts = bulkCounts(current);
        if (action === "advance" && (current.state !== "running" || !counts.pending)) break;
        if (action === "undo" && (current.state === "running" || !counts.applied)) break;
        await writeBulk(rpc, action, { batch_id: current.batch_id, base_version: current.version },
          `imprint-bulk:${current.batch_id}:${current.version}:${action}`, () => live.current && !paused.current);
        // A write is single-attempt. Reconcile actual durable progress after it.
        current = await readBulk(rpc);
        if (!live.current) return;
        accept(current);
        if (action === "cancel") break;
      }
      if (live.current) onChanged();
    } catch { if (live.current) failed(); }
    finally { if (live.current) setBusy(false); }
  }
  const counts = batch ? bulkCounts(batch) : null;
  const labels = VIEW_LABELS[locale];
  const stateLabel: Record<string, string> = zh ? { pending: "待处理", applied: "已补标签", conflict: "冲突未改", undone: "已撤销", undo_conflict: "撤销冲突" } : {};
  return <details className="imprints-card" data-imprint-bulk="first-batch">
    <summary>{zh ? "整理旧印记 · 首批最多100条" : "Organize old imprints · first batch up to 100"}</summary>
    <p>{zh ? `预演范围：${scopeLabel}。按保存的正文给出领域建议，不受搜索词或当前视图筛选影响。两处入口处理的是同一批记录。` : `Preview scope: ${scopeLabel}. Suggestions use saved bodies, independently of search or view filters. Both entrances share one batch.`}</p>
    <p>{zh ? "保留已有标签及手动清空的选择；历史、待核对和个人资料不会批量修改。不确定的留待逐条确认。关联和任务／决策提取仍在每条印记内确认。" : "Existing labels and manual empty choices are protected. History, unqualified records and Profile stay unchanged. Uncertain suggestions, associations and extraction require individual review."}</p>
    <p>{zh ? "此批只盘点和整理正式保存的记录，上下文候选不在本批修改范围。" : "This batch inventories accepted saved records. Context candidates are outside its write scope."}</p>
    <button type="button" disabled={busy} onClick={() => void rehearse()}>{zh ? "盘点并预演（不修改内容）" : "Inventory and preview (read only)"}</button>{" "}
    <button type="button" disabled={busy} onClick={() => void status()}>{zh ? "读取已保存进度" : "Read saved progress"}</button>
    {progress && <p role="status">{progress}</p>}
    {busy && previewing && <button type="button" onClick={() => { paused.current = true; }}>{zh ? "停止预演" : "Stop preview"}</button>}
    {preview && <div data-bulk-preview={preview.digest}>
      <p>{zh ? `完整盘点 ${preview.counts.total} 条，${preview.counts.characters} 字符：不符合批次条件 ${preview.counts.ineligible}，已有标记受保护 ${preview.counts.protected}，待逐条核对 ${preview.counts.needs_review}，可补标签 ${preview.counts.ready}。本批计划 ${preview.items.length} 条。` : `Complete inventory: ${preview.counts.total} records, ${preview.counts.characters} characters. Ineligible ${preview.counts.ineligible}; protected ${preview.counts.protected}; review needed ${preview.counts.needs_review}; ready ${preview.counts.ready}. Planned ${preview.items.length}.`}</p>
      <p>{zh ? `个人记录 ${preview.counts.personal}，个人资料 ${preview.counts.profile}，项目记录 ${preview.counts.project}；当前有效 ${preview.counts.current}，历史 ${preview.counts.history}，其他待核对 ${preview.counts.other_currentness}。` : `Personal ${preview.counts.personal}; Profile ${preview.counts.profile}; project ${preview.counts.project}. Current ${preview.counts.current}; history ${preview.counts.history}; other qualifications ${preview.counts.other_currentness}.`}</p>
      <p>{zh ? `已有自动标记 ${preview.counts.automatic_marked}，人工或来源未注明的标记 ${preview.counts.manual_or_unspecified_marked}，无标记 ${preview.counts.unmarked}。可补标签正文 ${preview.counts.ready_characters} 字符，待逐条核对正文 ${preview.counts.review_characters} 字符。` : `Automatic marks ${preview.counts.automatic_marked}; manual or unspecified marks ${preview.counts.manual_or_unspecified_marked}; unmarked ${preview.counts.unmarked}. Ready bodies ${preview.counts.ready_characters} characters; review bodies ${preview.counts.review_characters}.`}</p>
      {!preview.items.length && <p>{zh ? "没有可可靠自动归类的条目。本次预演不会执行写入；待核对内容仍保留原样。" : "No confident automatic candidates. No writes will run; review-needed records stay unchanged."}</p>}
      {preview.items.length > 0 && <ol>{preview.items.map(item => <li key={item.record_id} data-bulk-record-id={item.record_id}>{item.title || item.record_id} · {item.domains.map(domain => labels[domain]).join("、")} <button type="button" onClick={() => onOpenRecord(item.record_id)}>{zh ? "阅读全文" : "Read full body"}</button></li>)}</ol>}
      {preview.review_sample.length > 0 && <details><summary>{zh ? "待逐条核对的示例（最多20条）" : "Review-needed sample (up to 20)"}</summary><ul>{preview.review_sample.map(item => <li key={item.record_id}>{item.title || item.record_id} <button type="button" onClick={() => onOpenRecord(item.record_id)}>{zh ? "阅读全文" : "Read full body"}</button></li>)}</ul></details>}
      {!batch?.available && preview.items.length > 0 && <button type="button" disabled={busy || batch === null} onClick={() => void begin()}>{zh ? `确认这${preview.items.length}条，保存首批计划` : `Confirm ${preview.items.length} records and save plan`}</button>}
    </div>}
    {batch && !batch.available && <p>{zh ? "尚未建立首批计划。预演不会占用批次数量。" : "No saved batch. Preview does not use the batch allowance."}</p>}
    {batch?.available && counts && <div data-bulk-batch-id={batch.batch_id} data-bulk-state={batch.state}>
      <p>{zh ? "原批次范围：" : "Saved batch scope: "}{describeSavedScope(batch.selection)}{batch.selection.context_id ? (zh ? " · 上下文" : " · Context") : ""}</p>
      <p>{zh ? `同一首批共 ${batch.items.length} 条：待处理 ${counts.pending}，已补标签 ${counts.applied}，冲突未改 ${counts.conflict}，已撤销 ${counts.undone}，撤销冲突 ${counts.undo_conflict}。${batch.state === "running" ? "可继续处理。" : batch.state === "cancelled" ? "已停止后续处理。" : "处理已结束。"}` : `Saved first batch: ${batch.items.length}. Pending ${counts.pending}, applied ${counts.applied}, conflict ${counts.conflict}, undone ${counts.undone}, undo conflict ${counts.undo_conflict}. State: ${batch.state}.`}</p>
      <p>{zh ? "关闭页面或切换范围会暂停；已完成的保存不会丢失。首批最多100个对象，停止、撤销或重开页面不会重新计算额度。" : "Closing the page or switching scope pauses the runner. Saved progress remains. Cancel, Undo and reopening never reset the 100-object allowance."}</p>
      {batch.state === "running" && <><button type="button" disabled={busy} onClick={() => void run("advance")}>{zh ? "继续处理首批" : "Continue batch"}</button>{" "}<button type="button" disabled={busy} onClick={() => void run("cancel")}>{zh ? "停止此批次" : "Stop batch"}</button></>}
      {busy && <button type="button" onClick={() => { paused.current = true; }}>{zh ? "当前一条完成后暂停" : "Pause after current item"}</button>}
      {batch.state !== "running" && counts.applied > 0 && <><p>{zh ? "撤销会将本批新增标签恢复为空，并保留为空的人工选择。后来改过的记录或标签不会被覆盖；逐条报告冲突。" : "Undo clears this batch's added labels and preserves an explicit empty choice. Later source or label edits are protected and reported as conflicts."}</p><button type="button" disabled={busy} onClick={() => void run("undo")}>{zh ? "撤销本批已补标签" : "Undo applied labels"}</button></>}
      <details><summary>{zh ? "逐条结果与回执" : "Item results and receipts"}</summary><ul>{batch.items.map(item => <li key={item.record_id} data-bulk-record-id={item.record_id}>{item.record_id} · {stateLabel[item.state!] ?? item.state} {item.error_code ?? ""} {item.receipt_id ?? ""} {item.undo_receipt_id ?? ""}</li>)}</ul></details>
    </div>}
    <p role="status" aria-live="polite">{busy ? (zh ? "正在核对或处理…" : "Checking or processing…") : message}</p>
  </details>;
}
