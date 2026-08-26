# Clued

Clued 是 Pixel Gravity 的统一 AI 个人上下文与授权记忆系统。当前仓库采用 Clued v1.6 的“单一在线数据源 + 两级五视图”合同。

## 当前权威边界

- 生产 Supabase（经认证 Clued API/MCP）是唯一在线 Canonical Store。
- `memory/` 是 `artifacts/clued-two-level-snapshots/current.json` 所指版本的只读物化，不接受业务写入。
- 当前根快照：`snap_f6134235591bfcbfe4ba3a674383c3e0 / cv_155`，`live_rechecked`、`views_complete=true`。
- Git `main`、根 `VERSION`、git tag、M2 指针和 `memory/manifest.json` 共同提供版本真值；不要从历史文档文件名猜版本。

## 先看这些

- `memory/manifest.json`：快照版本、Canonical 版本、完整性计数和所有文件哈希。
- `memory/profile.md`：个人级只读视图。
- `memory/global/{state,task,decision,archive,log}.md`：全局五视图。
- `memory/projects/{canonical_project_id}/...`：项目级五视图。
- `docs/clued-two-level-views/20-Memory-v16-Root-Cutover-Report.md`：真实目录迁移与可恢复证据。

## 目录合同

```text
memory/
├── profile.md
├── global/{state,task,decision,archive,log}.md
├── projects/{canonical_project_id}/{state,task,decision,archive,log}.md
├── objects/{records,projects,legacy}/
├── events/raw/
├── evidence/migration/
├── index.json
└── manifest.json
```

Canonical Record/Project/Event/Evidence 只在其对应导出目录保留一次正文；Markdown 和 `index.json` 均为派生读取。`objects/legacy/` 与 legacy Event 信封是兼容历史，不是当前事实。

## 入口

```powershell
python memory.py doctor
python memory.py status
python memory.py recall "Clued 当前状态" --tier T2 --project-id 0597aa60-9b98-4da6-a4ab-63d7705b632f
powershell -ExecutionPolicy Bypass -File sync-memory.ps1 -Pull -Access PROJECT
```

`memory.py` 的旧本地写命令以及同步脚本的业务-memory push 路径会 fail closed。Canonical 写入只使用认证的 `clued_record_mutate`、`clued_decision_supersede`、`clued_project_mutate`、`clued_evidence_ingest` 或 `clued_event_append`；成功事务已经生成 Event 与 Receipt，禁止再写一份 Markdown。

## 发布与回滚

新快照走 `canonical_export → build → validate → expected-current CAS publish`。`published/{snapshot_version}` 不可原地修改。回滚只切换快照指针和只读根/镜像，不删除或倒退已经提交的 Canonical 历史。
