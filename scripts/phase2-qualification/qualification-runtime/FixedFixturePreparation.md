# 固定 Skill 受查输入与合成动作原语

PREPARED / NO_FORMAL_EXECUTION。本增量不是解释 Skill 的模型，也不把读到三文件等同全部 Skill 行为通过。`isolated_action_primitive` 是供后续准确父监督器连接的单个合成 fixture 写原语；无通用命令/路径/payload 接口，不访问业务服务、模型、网络或凭据存储。直接 CLI 始终 BLOCKED，未运行隔离原语。

调用图固定：`isolated_action_primitive → check_process → read_subject → check_process → persist_fixed_fixture`。进程检查要求 Linux、uid10001、PID1、零有效/允许 capability、NoNewPrivs、seccomp filter、仅 lo 和实际环境恰好五个已验证镜像公开值。若 Docker 实际额外提供 HOME/HOSTNAME 或其他变量，本原语会拒绝；不得未经实际观察与独评擅自放开。这些局部检查不替代父侧 inspect 的挂载/只读根fs/资源限制，也不证明当前授权。

只读 `/driver` 预期精确四个文件：自身源码及 R10 已接受的 `SKILL.md`、`references/engineering.md`、`references/memory-operations.md`。三文件上限与 SHA 固定于代码，数据永不被 eval/exec/作为指令或命令执行。未来父侧需要建立精确只读目录挂载，核对整套 source/config SHA、拒链接和额外内容。第二挂载只为本 attempt 的 `/allowed`，不含宿主证据/凭据。

唯一写目标 `/allowed/fixture.json`，内容逐字节复用旧 controller 的 synthetic-v1 fixture。CreateNew/O_EXCL/O_NOFOLLOW，成功写后 fsync；已存在或中断后不覆盖、不盲重发。读取或写入错误必须由父侧保持失败/UNKNOWN，不能推断未发生副作用或释放容量。返回值只是观察，不是正式 GRR/Schema、Authority 或资格；远端原 Intent 与 result 的绑定由现有 remote_evidence 接线承担，child 本身没有 Git/Store 凭据。

覆盖边界：为 PQUAL-01 预登记的一个固定合成 fixture 动作提供最小原语；PQUAL-02–09/11–17/19–20 的授权、停止、撤回、过期、预算、幂等与恢复是父控制面责任，尚未由本原语实现或执行。PQUAL-10只许拒绝真实模型动作；PQUAL-18 后 Entry 正例排除。不得用三文件 SHA 一致替代行为测试或跳过任何负例。

具体 N/A 提案依据当前调用图：没有 Clued account、integration installation、ContextStream/context、binding 或业务凭据发行/读取，因此四业务层可在原 S06 允许的明确 Schema 与逐层理由下提出 N/A。它尚未被接受，代码也没有默认 N/A。真实 Owner 控制身份、Root 当前撤回、runner/credential/session 独立代际、适用 GA 撤回不能据此消失；后续复用 contract-candidates 的 profile/vector 规则，不新造 Wire。

本次 test_fixed_skill_fixture.py 4/4 PASS，0 FAIL/SKIP，0.001 秒：准确现有 R10 字节匹配与变动拒绝、环境额外值拒绝、进程 token/类型负例、Windows 在读取 Skill/写入前拒绝。仅纯函数和只读字节比对，没有 Docker/create/run、网络、实际 Skill 执行或资格动作。

仍需把固定动作纳入已独立接受的准确 Profile/driver/fixture/config、父 Root/GA/current 读取、每动作前远端 Intent 回读与当前控制复核、停止watchdog/结果/UNKNOWN账本；当前 CLI 闭锁不能靠 accepted=true 解锁。该具体原语用于减少后续实现工作，不宣称完整 controller 已完成。
