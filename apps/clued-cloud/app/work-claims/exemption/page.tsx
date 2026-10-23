"use client";

import Link from "next/link";
import "../../contexts/contexts.css";

// Owner Credential v0.1 §6.2 / §11 point 3: new per-Task cap exemptions go
// through Owner Grants. When a Task is over its daily claim cap, the refusal
// carries an Owner Request whose link the Agent gives the Owner; exemptions
// granted here earlier stay valid until they expire. Old links land here.
export default function WorkClaimExemptionPage() {
  return <main className="context-page">
    <header><Link href="/">BeamingFace / 账号</Link></header>
    <h1>任务领取豁免已改为授权</h1>
    <section aria-label="现在怎么做">
      <p>一个任务 24 小时内最多领取 10 次。超过后，Agent 会收到一个确认链接并发给你；你打开链接，选“只批这一次”或“这一类管一段时间”即可，不用再手填任务 ID。</p>
      <p>之前在这里批准的豁免，到期前继续有效（最长 24 小时）。</p>
      <p><Link href="/grants">查看我的授权和等待确认的请求</Link></p>
    </section>
  </main>;
}
