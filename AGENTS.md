# 全局指令 · 跨会话记忆加载

每个新会话开始后，先主动、完整地读取以下记忆文件（绝对路径），据此理解用户身份、审美、决策与当前进度，再回应或行动。不要等用户要求。

- 用户画像：C:\Users\17531\Documents\Codex\memory\画像.md
- 当前状态：C:\Users\17531\Documents\Codex\memory\状态.md
- 决策记录：C:\Users\17531\Documents\Codex\memory\决策.md（已否决的绝不重复推荐）
- 待办：C:\Users\17531\Documents\Codex\memory\待办.md

记忆规则（新会话）：
- 记忆文件是唯一跨会话数据源：不假设聊天记录或过程细节会自动延续，未写入记忆的内容在新会话等同不存在。
- 开场先读完四个文件再行动；读状态.md 时注意其中的「新会话处理规则」。
- 过程中形成新进展 / 新决策 / 新否决项时立即写回对应文件；会话收尾统一复查补写。
- 只沉淀稳定长期信息，不写一次性临时信息。

关键节点或会话收尾时，把新进展、新决策、新否决项写回上述文件，只放这一处。

记忆同步（每会话收尾）：
- 复查补写四个记忆文件后，运行记忆同步：powershell -ExecutionPolicy Bypass -File "C:\Users\<用户名>\.codex\projects\codex-memory-system\sync-memory.ps1"（复制记忆 → 本地 git 提交 → 推送到 GitHub 私有仓库；多机共用时脚本会自动先拉后推）
