# BeamingFace Skill：维护与按需更新

BeamingFace（原 Clued）Skill 的 `clued/SKILL.md` 是唯一主动入口；记忆业务与工程维护流程分别维护在同一包的 `references/memory-operations.md` 和 `references/engineering.md` 中，按实际操作加载。版本号写在 `clued/SKILL.md` 的 `metadata.version`，与 `config/clued-components.json` 中 `skill.clued` 的版本和内容摘要绑定（见下文“组件版本”）。原 `clued-developer`、`clued-user`、`clued-continuity` 不再作为主动入口或安装源；它们的 Git 历史及执行计划中的旧验收副本保持原有历史含义，不改写为本次验收。

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

Skill 1.0.22 的新客户端默认入口为 `https://kooyumi.pixelgrav.com/mcp`，合同与公开元数据也从该域读取；Skill ID `clued`、工具名和 Canonical ID 保持兼容。既有旧域授权连接继续使用自身的 resource、issuer 和 Binding；切换新域走该客户端正常 OAuth，不复制旧 token。更新 Skill 本身不改变任何连接授权。

## 组件版本

Skill、Agent 合同、Claude Code hooks、本地脚本和 MCP 服务的版本统一登记在 `config/clued-components.json`（规则见 `development/contracts/components/ComponentVersioning.v0.2.md`）。每个组件的文件内容有摘要；内容变了版本必须升，CI 的 `clued-components` 检查会拒绝没升版本的改动。

改动一个组件：

```sh
python3 scripts/clued_components.py bump skill.clued 1.1.0   # 升版本并改写 SKILL.md 里的版本号
python3 scripts/clued_components.py update                   # 重新记录内容摘要
node apps/clued-cloud/scripts/generate-agent-contract.mjs    # 让服务端报告的新版本号跟上
python3 scripts/clued_components.py check --base origin/main
```

查看本机各组件版本：`python3 scripts/clued_components.py versions`。

版本与 git tag：根 `VERSION` 的值就是产品版本 tag 名（如 `Clued-v1.6`），指向把 VERSION 改成该值的提交；每次生产发布成功会打 `release/<日期>-r<run 编号>`，说明里写明 VERSION 和各组件版本。两者都由 `clued-release-tags` 工作流自动创建，规则见 `ComponentVersioning.v0.2.md` §6。

过期检测：Claude Code 开会话时，`scripts/hooks/clued_version_check.py` 读取服务的 `/.well-known/clued-continuity` 中的组件版本，与本 checkout 和本机安装的 BeamingFace Skill 副本（`~/.claude/skills`、claude.ai 同步副本、`$CODEX_HOME/skills`）比对，旧版本、无版本号或文件不全都会提示；`clued_session_resume` 返回后再比对一次组件版本；合同变化只要求通过 `clued_agent_bootstrap`（全部分段）或 `/clued-agent.md` 读取当前全文，不作为 Skill 过期或重装的理由。仍携带 `references/agent-contract.md` 的安装副本属于旧 Skill 包。只在会话开始和 resume 时检查，不定时运行；`CLUED_VERSION_CHECK=off` 关闭，`=offline` 不读服务。

Agent 合同只有仓库源 `protocol/agent/agent-contract.md`，由服务交付，Skill 和插件包不携带原文。合同独立升版本，合同变化不再导致 Skill 升版本或重装。首次换成不含合同的 Skill 需要按既有安装流程更新一次；后续自动安装改进仍由其独立任务负责。
