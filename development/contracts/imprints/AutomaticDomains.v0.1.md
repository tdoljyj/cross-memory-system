# Automatic domain organization v0.1

Task d5dee826-27d7-452b-8948-48fe8ae8a961; Owner Decision b8638aba-752a-43a5-9e01-00acfdf0ae1f.

New ordinary Canonical Records and owned Context records adopt the existing
`imprint-explicit-local.v1` saved-purpose rules at creation, atomically with
their existing write. Domains remain independent organization metadata;
multiple domains reference the same source ID. No Task/Decision extraction,
Record/Currentness/authority change, model call or permission expansion occurs.

Examples: `保存用途：工作汇报、课程学习、创作游戏剧情。` gets work,
learning and creation; `我保存这份资料用于家庭预算。` gets daily;
`我收藏这篇文章用于兴趣探索。` gets interest. `英文电影` or `客户的教程`
alone abstain. This first batch recognizes explicit uses, not general semantic
classification. Quotes, reported/conditional uses, code and unsupported text
carriers abstain; inputs over 65,536 characters abstain without truncation.
The generated SQL uses the same exported purpose/domain regex catalog as
the existing read-only suggestions, with stricter automatic quote handling.

Canonical automatic organization references its original M1 create Receipt.
Context automatic organization references its original committed record_put
operation; its private Receipt is never passed off as a public M1 Receipt.
Only new version-1 active source writes qualify. Existing data, source updates,
reads and history do not trigger classification or backfill. Raw Context text
comes from string body.content, otherwise string body.text, never arbitrary
JSON/metadata/source_refs. Shared-writer operations are excluded.

Native manual organization keeps its existing source/version CAS and Receipt.
Changing or clearing automatic tags replaces their provenance and stays final
across source edits, rereads and retries. Organization version 1 for an automatic
classification is visible through the existing DTO; manual clients must use
that returned version. All new functions are private and not client-callable.

Release acceptance: real PostgreSQL verifies both source write paths, independent
organization CAS/replay/manual clearing, rollback, no update/backfill, foreign
scope and quote/provenance negatives. Independent exact-diff review must pass
before migration/deploy, followed by Native page checks in both directories.
