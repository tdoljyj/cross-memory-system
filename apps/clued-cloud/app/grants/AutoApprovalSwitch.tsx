"use client";

export type AutoApprovalState = {
  on: boolean;
  version: number;
  persistent: true;
  excluded?: unknown;
};

export function isAutoApprovalState(value: unknown): value is AutoApprovalState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return typeof state.on === "boolean" && state.persistent === true
    && typeof state.version === "number" && Number.isSafeInteger(state.version) && state.version >= 0;
}

export default function AutoApprovalSwitch({ auto, working, onToggle }: {
  auto: unknown;
  working: boolean;
  onToggle: (enabled: boolean, baseVersion: number) => void;
}) {
  if (!isAutoApprovalState(auto)) return <section aria-label="自动审批">
    <h2>自动审批</h2>
    <p role="status">暂时无法读取自动审批状态。请刷新后重试。</p>
  </section>;

  const excluded = Array.isArray(auto.excluded) ? auto.excluded.flatMap(item => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const title = (item as Record<string, unknown>).title;
    return typeof title === "string" && title ? [title] : [];
  }) : [];
  return <section aria-labelledby="owner-auto-approval-title">
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
      <h2 id="owner-auto-approval-title" style={{ margin: 0 }}>自动审批</h2>
      <button type="button" role="switch" aria-checked={auto.on}
        aria-labelledby="owner-auto-approval-title" aria-describedby="owner-auto-approval-description"
        disabled={working} onClick={() => onToggle(!auto.on, auto.version)}
        style={{ display: "inline-flex", alignItems: "center", gap: 10, minHeight: 44, background: "transparent", border: 0, padding: "8px 12px", margin: 0 }}>
        <span aria-hidden="true" style={{ width: 48, height: 28, borderRadius: 16, display: "inline-flex", alignItems: "center", padding: 3, boxSizing: "border-box", background: auto.on ? "#E8783B" : "var(--line, #4c5b53)" }}>
          <span style={{ width: 22, height: 22, borderRadius: "50%", background: "#fff", transform: auto.on ? "translateX(20px)" : "translateX(0)", transition: "transform 120ms ease" }} />
        </span>
        <span>{auto.on ? "已开启" : "已关闭"}</span>
      </button>
    </div>
    <p id="owner-auto-approval-description">{auto.on
      ? "保持开启，直到你手动关闭。Agent 的适用申请会自动通过。"
      : "新的申请需要你确认。重新开启后会持续生效。"}</p>
    {excluded.length > 0 && <p className="context-muted">仍需你确认：{excluded.join("、")}。</p>}
    <p className="context-muted">已发出的授权可在下方单独撤销。</p>
  </section>;
}
