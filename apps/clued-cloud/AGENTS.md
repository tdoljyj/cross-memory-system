# Clued continuity rules

These rules apply to every task in this repository.

1. Invoke `$clued-continuity` before inspecting, changing, testing, or deploying Clued.
2. Restore the current canonical state from the persistent Library file `Clued_工作日志.md`. Do not ask the user to repeat context already available there.
3. Identify the exact execution target before acting. Keep the ChatGPT Sites deployment separate from the production Cloudflare Worker `clued-cloud` at `https://clued.pixelgrav.com`.
4. Treat Cloudflare DNS as healthy unless new direct evidence proves otherwise. Do not recommend DNS changes based only on a stale page or a deployment mismatch.
5. Preserve decisions with their reasons, actions with evidence, failures, retracted conclusions, blockers, and one explicit next action.
6. Before finishing, update the same `Clued_工作日志.md` file. Never create competing canonical logs.
7. Treat AI continuity as a Clued product requirement: an authorized new session must restore who the user is, what the work is, where it stopped, why decisions were made, and what happens next.
8. Use scoped maturity language. A validated memory-kernel milestone does not mean the end-to-end Clued cloud product is mature.

Do not run the real flat-to-directory migration, Trial 3B, push, tag, release, purge, or touch the real flat binding without the user's separate authorization after an executable migration transaction has been implemented and validated.
