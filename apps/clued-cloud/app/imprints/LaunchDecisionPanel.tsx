"use client";

import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../supabase-browser";
import { runLaunchDecision, runLaunchSource, type DecisionQuote, type LaunchAnswer, type LaunchSource } from "./launch-decision";
import type { Locale } from "./imprint-model";
import type { NativeRpc } from "./imprint-client";

const COPY = {
  "zh-CN": {
    title: "上线日期问答", help: "只查所选项目的正式上线决定，显示原文，不推测日期，也不修改记录。",
    choose: "先在查询范围中选择一个有权查看的项目。", question: "你的问题", example: "例如：青芽什么时候上线？",
    search: "查询", result: "上线日期问答结果", loading: "正在核实决定…", current: "当前决定原文",
    history: "已核实的关联历史（不保证完整）", historyUnverified: "未核实到关联历史，不代表没有改过。",
    version: "记录版本", source: "打开出处", loadingSource: "正在核实出处…",
    savedSource: "已保存的出处原文", nonAuthoritative: "出处仅供核对，不等于当前有效决定。",
    noRefs: "此版本没有已保存的出处引用。", unknownRefs: "此版本的出处引用未核实。",
    messages: {
      sign_in_required: "登录状态无法确认，未显示决定正文。",
      project_not_authorized: "项目权限无法确认，未显示决定正文。",
      ambiguous_current_decision: "存在多条同名的当前决定，无法确定使用哪一条。",
      no_verified_launch_decision: "未找到可核实的正式上线决定。",
      question_outside_supported_lane: "请用中文指定一个产品并询问上线日期。",
    } as Record<string, string>,
    fallback: "暂时无法核实决定。可能有更新，请刷新后再查。",
    sourceMessages: {
      source_not_authorized: "身份或项目权限无法核实，未显示出处。",
      stale_record_version: "决定版本已变化，请重新查询后打开出处。",
      external_source_content_not_stored: "只有出处记录，没有保存可读取的全文。",
      source_content_exceeds_read_limit: "出处超出完整读取上限，未显示截断正文。",
      evidence_withdrawn: "该出处已撤回，未显示正文。",
      evidence_invalidated: "该出处已失效，未显示正文。",
    } as Record<string, string>,
    sourceFallback: "暂时无法核实出处全文。决定原文不是出处全文。",
  },
  en: {
    title: "Launch date Q&A", help: "Read the selected project's formal launch decisions. No date is inferred and nothing is written.",
    choose: "Select one authorized project in Search scope.", question: "Your question", example: "Chinese questions only, e.g. 青芽什么时候上线？",
    search: "Search", result: "Launch date answer", loading: "Verifying the decision…", current: "Current decision text",
    history: "Verified linked history (may be incomplete)", historyUnverified: "No linked history was verified. This does not mean the decision never changed.",
    version: "Record version", source: "Open source", loadingSource: "Verifying the source…",
    savedSource: "Saved source text", nonAuthoritative: "This is supporting text, not a current decision.",
    noRefs: "This version has no saved source references.", unknownRefs: "This version's source references could not be verified.",
    messages: {
      sign_in_required: "Sign-in could not be verified. No decision text was shown.",
      project_not_authorized: "Project access could not be verified. No decision text was shown.",
      ambiguous_current_decision: "There are multiple matching current decisions. No decision was chosen.",
      no_verified_launch_decision: "No verified formal launch decision was found.",
      question_outside_supported_lane: "Ask for one named product's launch date in Chinese.",
    } as Record<string, string>,
    fallback: "The decision could not be verified. Refresh and try again.",
    sourceMessages: {
      source_not_authorized: "Identity or project access could not be verified. No source was shown.",
      stale_record_version: "The decision version changed. Search again before opening a source.",
      external_source_content_not_stored: "A source reference exists, but no readable full text was saved.",
      source_content_exceeds_read_limit: "The source exceeds the full-read limit. No truncated body was shown.",
      evidence_withdrawn: "The source was withdrawn. No text was shown.",
      evidence_invalidated: "The source was invalidated. No text was shown.",
    } as Record<string, string>,
    sourceFallback: "The saved source could not be verified. The decision text is not its source text.",
  },
} as const;

export default function LaunchDecisionPanel({ session, scope, projectScopes, locale, rpc }: {
  session: Session; scope: string; projectScopes: readonly string[]; locale: Locale; rpc: NativeRpc;
}) {
  const t = COPY[locale];
  const [opened, setOpened] = useState(false);
  const allowed = projectScopes.includes(scope);
  return <details className="imprints-detail" onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>{t.title}</summary>
    {opened && (allowed
      ? <Lookup key={JSON.stringify([session.user.id, scope])} session={session} scope={scope} projectScopes={projectScopes} locale={locale} rpc={rpc} />
      : <p role="status">{t.choose}</p>)}
  </details>;
}

function abortRequest(request: { current: AbortController | null }) {
  request.current?.abort();
  request.current = null;
}

function Lookup({ session, scope, projectScopes, locale, rpc }: {
  session: Session; scope: string; projectScopes: readonly string[]; locale: Locale; rpc: NativeRpc;
}) {
  const t = COPY[locale];
  const [question, setQuestion] = useState("");
  const [pendingSession, setPendingSession] = useState<Session | null>(null);
  const [invalidSession, setInvalidSession] = useState<Session | null>(null);
  const [result, setResult] = useState<{ session: Session; scope: string; value: LaunchAnswer } | null>(null);
  const [source, setSource] = useState<{ answer: LaunchAnswer; quote: DecisionQuote; value: LaunchSource | null } | null>(null);
  const lookup = useRef<AbortController | null>(null);
  const attachment = useRef<AbortController | null>(null);
  const fence = useRef<{ session: Session; scope: string; valid: boolean } | null>(null);
  const invalid = invalidSession?.user.id === session.user.id && invalidSession.access_token === session.access_token;
  const busy = !invalid && pendingSession === session;
  const answer = !invalid && result?.session === session && result.scope === scope ? result.value : null;

  function clearResult() {
    abortRequest(lookup);
    abortRequest(attachment);
    setPendingSession(null);
    setResult(null);
    setSource(null);
  }

  useLayoutEffect(() => {
    const bound = { session, scope, valid: true };
    fence.current = bound;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      if (!bound.valid || (next?.user.id === session.user.id && next.access_token === session.access_token)) return;
      // Invalidate immediately, before old RPCs can settle and before parent
      // Session props refresh. React state, not the imperative fence, gates the DOM.
      bound.valid = false;
      abortRequest(lookup);
      abortRequest(attachment);
      setInvalidSession(session);
      setPendingSession(null);
      setResult(null);
      setSource(null);
    });
    return () => {
      bound.valid = false;
      fence.current = null;
      abortRequest(lookup);
      abortRequest(attachment);
      subscription.unsubscribe();
    };
  }, [session, scope]);

  function liveFence() {
    const bound = fence.current;
    return !invalid && bound?.session === session && bound.scope === scope && bound.valid ? bound : null;
  }

  // RPC uses the already signed token snapshot bound by the containing
  // ImprintPanel. getUser verifies that exact snapshot before and after reads.
  async function verifyOwner() {
    const { data, error } = await supabase.auth.getUser(session.access_token);
    return error ? null : data.user?.id ?? null;
  }
  async function ask(event: FormEvent) {
    event.preventDefault();
    const bound = liveFence();
    if (!bound || !question.trim()) return;
    clearResult();
    const controller = new AbortController();
    lookup.current = controller;
    setPendingSession(session);
    const active = () => bound.valid && lookup.current === controller && !controller.signal.aborted;
    const value = await runLaunchDecision({
      owner: session.user.id, sessionIdentity: session, scope, projectScopes, isCurrent: active, verifyOwner, read: rpc,
    }, question, controller.signal);
    if (active()) { setResult({ session, scope, value }); setPendingSession(null); lookup.current = null; }
  }
  async function showSource(a: LaunchAnswer, quote: DecisionQuote, evidenceId: string) {
    const bound = liveFence();
    if (!bound || a !== answer) return;
    abortRequest(attachment);
    const controller = new AbortController();
    attachment.current = controller;
    setSource({ answer: a, quote, value: null });
    const active = () => bound.valid && attachment.current === controller && !controller.signal.aborted;
    const value = await runLaunchSource({
      owner: session.user.id, sessionIdentity: session, scope, projectScopes, isCurrent: active, verifyOwner, read: rpc,
    }, a, { recordId: quote.recordId, version: quote.version, evidenceId }, controller.signal);
    if (active()) { setSource({ answer: a, quote, value }); attachment.current = null; }
  }
  function original(a: LaunchAnswer, quote: DecisionQuote) {
    const shown = source?.answer === a && source.quote === quote ? source : null;
    return <>
      <blockquote className="imprints-content">{quote.sourceText}</blockquote>
      <p>{t.version} {quote.version}</p>
      {quote.sourceRefsStatus !== "listed" && <p>{quote.sourceRefsStatus === "none" ? t.noRefs : t.unknownRefs}</p>}
      {quote.sourceIds.map((id, i) => <button key={id} type="button" onClick={() => void showSource(a, quote, id)}>{t.source} {i + 1}</button>)}
      {shown && !shown.value && <p role="status">{t.loadingSource}</p>}
      {shown?.value?.status === "source_verified" && shown.value.content !== null && <section aria-label={t.savedSource}>
        <p>{t.nonAuthoritative}</p><blockquote className="imprints-content">{shown.value.content}</blockquote>
      </section>}
      {shown?.value && shown.value.status !== "source_verified" && <p>{t.sourceMessages[shown.value.status] ?? t.sourceFallback}</p>}
    </>;
  }
  return <section aria-label={t.title}>
    <p>{t.help}</p>
    <form className="imprints-tools" onSubmit={ask}>
      <label>{t.question}<input aria-label={t.question} value={question} maxLength={96} placeholder={t.example}
        onChange={event => { clearResult(); setQuestion(event.target.value); }} /></label>
      <button type="submit" disabled={invalid || !question.trim() || busy}>{t.search}</button>
    </form>
    <div aria-live="polite" aria-label={t.result}>
      {busy && <p>{t.loading}</p>}
      {answer && !answer.current && <p>{t.messages[answer.status] ?? t.fallback}</p>}
      {answer?.current && <article><h5>{t.current}</h5>{original(answer, answer.current)}</article>}
      {answer && answer.history.length > 0 && <article><h5>{t.history}</h5>
        {answer.history.map(quote => <div key={quote.recordId}>{original(answer, quote)}</div>)}
      </article>}
      {answer?.current && answer.historyStatus === "unverified" && <p>{t.historyUnverified}</p>}
    </div>
  </section>;
}
