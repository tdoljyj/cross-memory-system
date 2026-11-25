// This narrow read-only lane returns records; it does not infer a launch date,
// count changes, or treat search matches, revision excerpts, or quotes as authority.
import { readSource, type NativeRpc } from "./imprint-client";
import { object, uuid, type Json } from "./imprint-model";

const pageSize = 30;
const maxPages = 3;
const maxLinked = 8;
const maxBody = 12_000;
const names = /^[\p{L}\p{N} ._・-]{1,32}$/u;
const stableId = (value: unknown): value is string => typeof value === "string" && uuid(value) && value === value.toLowerCase();
const version = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isProject = (scope: string) => scope.startsWith("project:") && stableId(scope.slice(8));
const modes = new Set(["saved_title_content_literal", "qualified_saved_source_and_retained_body_literal"]);
const deniedCodes = new Set(["42501", "PGRST301", "PGRST302", "not_authorized", "imprint_scope_not_found"]);
const retainedStates = new Set(["retained", "withdrawn", "invalidated"]);

type Authority = {
  owner: string;
  scope: string;
  projectScopes: readonly string[];
  sessionIdentity: object;
  isCurrent: () => boolean;
  verifyOwner: () => Promise<string | null>;
  read: NativeRpc;
};
type RefStatus = "listed" | "none" | "unverified";
export type DecisionQuote = Readonly<{
  recordId: string; version: number; sourceText: string; sourceIds: readonly string[]; sourceRefsStatus: RefStatus;
}>;
export type LaunchAnswer = Readonly<{
  status: string; current: DecisionQuote | null; history: readonly DecisionQuote[];
  historyStatus: "unverified" | "verified_linked_subset";
}>;
type CanonicalDecision = Readonly<{ title: string; quote: DecisionQuote; predecessors: readonly string[] | null }>;
type SourceSelection = Readonly<{ recordId: string; version: number; evidenceId: string }>;
export type LaunchSource = Readonly<{ status: string; content: string | null }>;
const signed = new WeakMap<LaunchAnswer, Pick<Authority, "owner" | "scope" | "sessionIdentity">>();
const unavailable = (status: string): LaunchAnswer => ({ status, current: null, history: [], historyStatus: "unverified" });
const sourceFailure = (status: string): LaunchSource => ({ status, content: null });

function productName(input: string): string | null {
  if (input.length > 96) return null;
  const text = input.trim().replace(/[？?。]$/u, "").trim();
  if (!text || /[\r\n\t]/u.test(text)) return null;
  const question = text.match(/^(.+?)\s*(?:现在|目前)?(?:定在)?(?:什么时候|哪天|何时)上线$/u)
    ?? text.match(/^(.+?)\s*的?上线(?:日期|时间)(?:是什么|定在哪天|是哪天)?$/u);
  if (!question) return null;
  let name = question[1].trim().replace(/^请问\s*/u, "").trim();
  if ((name.startsWith("「") && name.endsWith("」")) || (name.startsWith("《") && name.endsWith("》"))) name = name.slice(1, -1);
  return names.test(name) && !/(?:这个|那个|哪个|一下|我们|你们|谁|和|以及|之前|以前|上一次)/u.test(name) ? name : null;
}

function exactTitle(product: string, title: unknown) {
  return typeof title === "string" && [product, "「" + product + "」", "《" + product + "》"].some(p =>
    ["上线日期", "上线时间", "上线日期决定", "上线时间决定"].some(s =>
      [p + s, p + " " + s, p + "的" + s, p + "：" + s, p + ": " + s, "关于" + p + "的" + s].includes(title.trim())));
}

function validDecisionIdentity(r: Json, scope: string) {
  return stableId(r.id) && r.scope === scope && r.project_id === scope.slice(8) && r.record_type === "decision";
}
function exactIds(x: unknown, max: number): readonly string[] | null {
  return Array.isArray(x) && x.length <= max && x.every(stableId) && new Set(x).size === x.length ? Object.freeze([...x]) : null;
}
function canonical(r: Json, scope: string, historical: boolean): CanonicalDecision | null {
  if (!validDecisionIdentity(r, scope) || !stableId(r.id) || !version(r.version)
      || r.source_semantics !== "canonical_record" || r.record_schema_version !== 1 || r.record_currentness !== (historical ? "HISTORY" : "CURRENT")
      || r.authoritative !== !historical || (historical ? r.lifecycle_status !== "superseded" : r.lifecycle_status !== "active")
      || typeof r.title !== "string" || typeof r.content !== "string" || !r.content.trim() || r.content.length > maxBody) return null;
  const refs = exactIds(r.source_refs, 20);
  const predecessors = !object(r.relations) ? null : r.relations.supersedes === undefined
    ? Object.freeze([]) : exactIds(r.relations.supersedes, 16);
  return { title: r.title, quote: Object.freeze({ recordId: r.id, version: r.version, sourceText: r.content,
    sourceIds: refs ?? Object.freeze([]), sourceRefsStatus: !refs ? "unverified" : refs.length ? "listed" : "none" }), predecessors };
}

function strictPage(value: unknown, cursor: number, history: boolean, expectedMode: string | null, limit: number) {
  if (!object(value) || value.status !== "ok" || value.read_semantics !== "strict_current"
      || typeof value.search_mode !== "string" || !modes.has(value.search_mode) || (expectedMode !== null && value.search_mode !== expectedMode)
      || !object(value.coverage) || value.coverage.latest_saved_objects !== true || value.coverage.diagnostic_history_requested !== history
      || value.current_projection_unavailable !== false || value.projection_rebuild_required !== false || value.selection_complete !== true
      || !Array.isArray(value.records) || value.records.length > limit || !value.records.every(object)
      || !object(value.page) || value.page.cursor !== cursor || typeof value.page.complete !== "boolean") return null;
  if (value.page.complete ? value.page.next_cursor !== null : (value.records.length !== limit || value.page.next_cursor !== cursor + limit)) return null;
  return { rows: value.records as Json[], next: value.page.complete ? null : cursor + limit, mode: value.search_mode };
}

export async function runLaunchDecision(a: Authority, question: string, signal?: AbortSignal): Promise<LaunchAnswer> {
  if (!a.owner) return unavailable("sign_in_required");
  if (!isProject(a.scope) || !a.projectScopes.includes(a.scope)) return unavailable("project_not_authorized");
  const product = productName(question);
  if (!product) return unavailable("question_outside_supported_lane");
  const active = () => a.isCurrent() && !signal?.aborted;
  let denied = false;
  const failure = (status: string) => unavailable(!active() ? "query_cancelled" : denied ? "project_not_authorized" : status);
  try {
    if (!active() || await a.verifyOwner() !== a.owner || !active()) return failure("sign_in_required");
    let mode: string | null = null;
    async function fetchPage(cursor: number, include_history: boolean, limit: number, id?: string) {
      if (denied || !active()) return null;
      const result = await a.read("clued_imprint_read_v1", { p_input: { scope: a.scope, view: "decision",
        record_type: "decision", include_history, limit, cursor, ...(id === undefined ? { query: product } : { id }) } }, signal);
      denied = result.status === 401 || result.status === 403
        || deniedCodes.has(result.error?.code ?? "") || deniedCodes.has(result.error?.message ?? "");
      if (!active() || denied || result.error) return null;
      const page = strictPage(result.data, cursor, include_history, mode, limit);
      if (page) mode = page.mode;
      return page;
    }
    const seen = new Set<string>();
    let cursor = 0, done = false;
    let discovery: CanonicalDecision | null = null;
    for (let i = 0; i < maxPages; i++) {
      const page = await fetchPage(cursor, false, pageSize);
      if (!page) return failure("current_search_unavailable");
      for (const row of page.rows) {
        if (!validDecisionIdentity(row, a.scope) || !stableId(row.id) || seen.has(row.id)) return failure("current_search_unverified");
        seen.add(row.id);
        if (!exactTitle(product, row.title)) continue;
        const match = canonical(row, a.scope, false);
        if (!match) return failure("current_search_unverified");
        if (discovery) return failure("ambiguous_current_decision");
        discovery = match;
      }
      if (page.next === null) { done = true; break; }
      cursor = page.next;
    }
    if (!done) return failure("current_search_incomplete");
    if (!discovery) return failure("no_verified_launch_decision");
    async function readById(id: string, historical: boolean) {
      const row = await fetchPage(0, historical, 1, id);
      return row?.next === null && row.rows.length === 1 && row.rows[0].id === id ? canonical(row.rows[0], a.scope, historical) : null;
    }
    const head = await readById(discovery.quote.recordId, false);
    if (!head || JSON.stringify(head) !== JSON.stringify(discovery)) return failure("decision_changed_or_unavailable");
    const history: DecisionQuote[] = [];
    const chain = new Set([head.quote.recordId]);
    let node = head;
    for (let i = 0; i < maxLinked; i++) {
      if (node.predecessors?.length !== 1 || chain.has(node.predecessors[0])) break;
      const id = node.predecessors[0];
      const prior = await readById(id, true);
      // A supersedes edge alone is not a subject identifier. Stop at a
      // malformed cross-product/cross-topic link; do not display or follow it.
      if (!prior || !exactTitle(product, prior.title)) break;
      chain.add(id);
      history.push(prior.quote);
      node = prior;
    }
    const recheck = await readById(head.quote.recordId, false);
    if (!recheck || JSON.stringify(recheck) !== JSON.stringify(head)) return failure("decision_changed_or_unavailable");
    if (!active() || await a.verifyOwner() !== a.owner || !active()) return failure("sign_in_required");
    const answer: LaunchAnswer = Object.freeze({ status: "answered_with_sources", current: head.quote, history: Object.freeze(history),
      historyStatus: history.length ? "verified_linked_subset" : "unverified" });
    signed.set(answer, { owner: a.owner, scope: a.scope, sessionIdentity: a.sessionIdentity });
    return answer;
  } catch { return failure("query_unavailable"); }
}

const sourceReasons = new Set(["external_source_content_not_stored", "captured_segment_unavailable",
  "source_content_exceeds_read_limit", "stale_record_version", "evidence_withdrawn", "evidence_invalidated"]);
const exactFields = (x: unknown, keys: readonly string[]): x is Json => object(x) && Object.keys(x).length === keys.length
  && keys.every(k => Object.hasOwn(x, k));
export async function runLaunchSource(a: Authority, answer: LaunchAnswer, pick: SourceSelection, signal?: AbortSignal): Promise<LaunchSource> {
  const active = () => a.isCurrent() && !signal?.aborted;
  const membership = signed.get(answer);
  if (!active()) return sourceFailure("source_cancelled");
  if (!membership || membership.owner !== a.owner || membership.scope !== a.scope || membership.sessionIdentity !== a.sessionIdentity
      || !isProject(a.scope) || !a.projectScopes.includes(a.scope)) return sourceFailure("source_not_authorized");
  if (!exactFields(pick, ["recordId", "version", "evidenceId"]) || !stableId(pick.recordId)
      || !version(pick.version) || !stableId(pick.evidenceId)) return sourceFailure("source_not_linked");
  const row = [answer.current, ...answer.history].find(r => r?.recordId === pick.recordId && r.version === pick.version);
  if (!row || !row.sourceIds.includes(pick.evidenceId)) return sourceFailure("source_not_linked");
  const evidenceId = pick.evidenceId;
  const historical = row !== answer.current;
  const state: { called: boolean; denied: boolean; proof?: { content: string; status: string }; unavailableReason?: string } = { called: false, denied: false };
  try {
    if (!active() || await a.verifyOwner() !== a.owner || !active()) return sourceFailure("source_not_authorized");
    const guarded: NativeRpc = async (name, args, requestSignal) => {
      const input = args.p_input;
      if (state.denied || !active() || name !== "clued_imprint_source_v1" || !exactFields(args, ["p_input"])
          || !exactFields(input, ["record_id", "evidence_id", "record_version", "include_history"])
          || input.record_id !== row.recordId || input.evidence_id !== evidenceId || input.record_version !== row.version
          || input.include_history !== historical) {
        state.denied = true;
        return { data: null, error: { code: "not_authorized" } };
      }
      // The generic reader may recover transport failures; this UI never repeats
      // a disclosure read. An interrupted request remains unverified.
      if (state.called) throw new Error("source_single_read_exhausted");
      state.called = true;
      const raw = await a.read(name, args, requestSignal ?? signal);
      state.denied = !active() || raw.status === 401 || raw.status === 403
        || deniedCodes.has(raw.error?.code ?? "") || deniedCodes.has(raw.error?.message ?? "");
      const v = raw.data;
      if (!state.denied && !raw.error && object(v) && v.status === "ok" && v.available === true && v.complete === true
          && typeof v.content === "string" && v.content.trim() && v.record_id === row.recordId
          && v.record_version === row.version && v.source_record_version === row.version && !Object.hasOwn(v, "historical_record_version")
          && object(v.evidence) && v.evidence.id === evidenceId && v.record_currentness === (historical ? "HISTORY" : "CURRENT")
          && v.authoritative === false && v.current_input_eligible === false && v.source_semantics === (historical ? "historical_evidence" : "linked_evidence")
          && typeof v.evidence_status === "string" && (historical ? retainedStates.has(v.evidence_status) : v.evidence_status === "retained")) {
        state.proof = { content: v.content, status: v.evidence_status };
      }
      if (!state.denied && !raw.error && object(v) && v.status === "ok" && v.available === false
          && v.authoritative === false && v.current_input_eligible === false && typeof v.content !== "string"
          && typeof v.unavailable_reason === "string" && sourceReasons.has(v.unavailable_reason)) {
        if (v.unavailable_reason === "stale_record_version" ? version(v.record_version) && v.record_version !== row.version
            : v.record_id === row.recordId && v.record_version === row.version && v.source_record_version === row.version
              && object(v.evidence) && v.evidence.id === evidenceId && !Object.hasOwn(v, "historical_record_version")) {
          state.unavailableReason = v.unavailable_reason;
        }
      }
      return state.denied ? { data: null, error: { code: "not_authorized" } } : raw;
    };
    const value = await readSource(guarded, row.recordId, evidenceId, historical, row.version, { isCurrent: active, signal });
    if (!active()) return sourceFailure("source_cancelled");
    if (state.denied || await a.verifyOwner() !== a.owner || !active()) return sourceFailure("source_not_authorized");
    if (!state.called) return sourceFailure("source_unavailable");
    if (!value.available) return sourceFailure(state.unavailableReason === value.reason ? value.reason : "source_unavailable");
    const proof = state.proof;
    if (!proof || value.content !== proof.content || value.historical !== historical || value.evidenceStatus !== proof.status)
      return sourceFailure("source_unavailable");
    if (proof.status === "withdrawn") return sourceFailure("evidence_withdrawn");
    if (proof.status === "invalidated") return sourceFailure("evidence_invalidated");
    return { status: "source_verified", content: proof.content };
  } catch {
    return sourceFailure(!active() ? "source_cancelled" : state.denied ? "source_not_authorized" : "source_unavailable");
  }
}
