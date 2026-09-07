# Clued Skills：维护与按需更新

`clued-developer/SKILL.md` 与 `clued-user/SKILL.md` 是两份 Skill 的唯一维护源。版本以本目录的 Git 提交及文件 SHA256 为准；执行计划中旧副本是不可改写的历史验收证据，不再作为安装源。

在已核对并对齐远端的授权仓库中，从仓库根目录运行：

```powershell
python scripts/update_clued_skills.py
python scripts/update_clued_skills.py --check
```

第一条按需安装／更新，第二条只检查一致性（不一致退出码 1）。使用可用的 Python 3.12 或更新版本。默认安装到 `$CODEX_HOME/skills`，未设置时为 `~/.codex/skills`；可通过 `--target` 指定其他目录。

命令仅使用当前 checkout，不联网、不拉取、不定时执行。需要最新版时先按仓库 Git 纪律核实 origin/main；本地候选安装不表示已发布。不要并发运行更新或在复制时编辑来源。

更新覆盖整个对应技能目录，逐文件核对 SHA256 和文件集合；无变化不写入。旧目录移动到安装目录同级的 `clued-skill-backups/`，失败时恢复该技能原目录。无关技能不受影响。两份技能逐份更新，中途失败可重新运行收敛；不宣称跨两个目录的原子事务。

今后修改：只编辑本目录 → 运行 Skill 格式校验 → 提交并推送 → 执行更新及 `--check`。不增加路由 Skill 或每轮加载说明。安装成功只证明磁盘一致；已打开任务可能保留旧上下文，新任务是否重新发现需在客户端实测。
