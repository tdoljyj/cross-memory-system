# Clued Skill：维护与按需更新

`clued/SKILL.md` 是唯一主动入口；记忆业务与工程维护流程分别维护在同一包的 `references/memory-operations.md` 和 `references/engineering.md` 中，按实际操作加载。版本以本目录的 Git 提交及逐文件 SHA256 为准。原 `clued-developer`、`clued-user`、`clued-continuity` 不再作为主动入口或安装源；它们的 Git 历史及执行计划中的旧验收副本保持原有历史含义，不改写为本次验收。

在已核对并对齐远端的授权仓库中，从仓库根目录运行：

```powershell
python scripts/update_clued_skills.py
python scripts/update_clued_skills.py --check
```

第一条按需安装／更新并退役目标端的三个旧入口，第二条只检查一致性（内容不一致或旧入口仍存在时退出码 1）。使用可用的 Python 3.12 或更新版本。默认安装到 `$CODEX_HOME/skills`，未设置时为 `~/.codex/skills`；可通过 `--target` 指定隔离测试目录。修改源文件本身不会更新已安装的 Skill。

命令仅使用当前 checkout，不联网、不拉取、不定时执行。需要最新版时先按仓库 Git 纪律核实 origin/main；本地候选安装不表示已发布。不要并发运行更新或在复制时编辑来源。

更新覆盖整个 `clued` 技能目录，逐文件核对 SHA256 和文件集合；无变化不写入。已安装的 `clued` 原目录与存在的三个旧入口移动到安装目录同级的 `clued-skill-backups/`，保留原文件及自定义内容。新包复制验证完成后才切换；进程内失败会恢复已移动的原目录。备份与失败候选均在发现目录之外，无关技能不受影响。此文件系统操作不宣称断电或进程被终止时的跨目录原子事务；异常中断后先核对输出、备份和目标，再恢复或重试，不删除原始备份。

今后修改：编辑本包 → 运行 Skill 格式及受影响行为验证 → 按现行工程授权提交与推送 → 在对应端明确更新并运行 `--check`。版本核查只按任务触发，不定时执行。安装成功只证明磁盘一致；已打开任务可能保留旧上下文，新任务是否仅发现 `clued` 仍需在客户端实测。

Skill 迁移不创建账户、不修改 MCP Binding、不增加权限，也不替代真实客户端 OAuth 与读写验收。工程流程遵守根 `AGENTS.md` 的统一 `-AlignAndVerify`／`-Pull` 入口，已经内置 doctor 的同一请求不得再单独运行 doctor。正式受治理合同、历史冻结文件与发布主体不因合并 Skill 而改变。
