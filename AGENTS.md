# 全局指令 · 跨会话记忆加载

每个新会话开始后，先主动、完整地读取以下记忆文件（绝对路径，%USERPROFILE% 即本机用户目录），据此理解用户身份、审美、决策与当前进度，再回应或行动。不要等用户要求。

- 用户画像：%USERPROFILE%\Documents\Codex\memory\画像.md
- 当前状态：%USERPROFILE%\Documents\Codex\memory\状态.md
- 决策记录：%USERPROFILE%\Documents\Codex\memory\决策.md（已否决的绝不重复推荐）
- 待办：%USERPROFILE%\Documents\Codex\memory\待办.md
- 归档：%USERPROFILE%\Documents\Codex\memory\归档.md（已解决 / 历史审计项，按需查，不作为当前状态）

记忆规则（新会话）：
- 记忆文件是唯一跨会话数据源：不假设聊天记录或过程细节会自动延续，未写入记忆的内容在新会话等同不存在。
- 开场先做「读前对齐」（见下），再读文件；读状态.md 时注意其中的「新会话处理规则」。
- 过程中形成新进展 / 新决策 / 新否决项时立即写回对应文件；会话收尾统一复查补写。
- 只沉淀稳定长期信息，不写一次性临时信息。

读前对齐（新会话，多机共用防止读到旧记忆）：
1. 若 %USERPROFILE%\.codex\projects\codex-memory-system\.sync-failed 存在，先告知用户上次同步失败，并读出其中时间戳。
2. 运行：powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\.codex\projects\codex-memory-system\sync-memory.ps1" -Pull
3. -Pull 会尝试把远端更新自动回写工作记忆目录；若输出提示「could not auto-write / pending write-back」（shell 因内容目录只读而回写失败），用 apply_patch 把仓库 memory 目录中较新的文件写回 %USERPROFILE%\Documents\Codex\memory 对应文件，再重跑 -Pull 清除 .pending-writeback 标记；无更新则直接读取。

关键节点或会话收尾时，把新进展、新决策、新否决项写回上述文件，只放这一处。

记忆同步（每会话收尾）：
- 复查补写记忆文件后，运行：powershell -ExecutionPolicy Bypass -File "%USERPROFILE%\.codex\projects\codex-memory-system\sync-memory.ps1"（复制记忆 → 本地 git 提交 → 与远端对账 → 推送到 GitHub 私有仓库；失败会写 .sync-failed 标记，下次会话开场提醒；若 .pending-writeback 标记存在会先拒绝推送，需先按第 3 步回写）
