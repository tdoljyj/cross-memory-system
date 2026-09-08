# 正式运行接线候选：远端辅助 Evidence

状态：**CANDIDATE / NO_FORMAL_EXECUTION**。当前增量只把既有私有 Git 的辅助 Intent/Result 创建和精确读回接实；不连接 Docker、不运行 Skill/PQUAL，不写 RootStore，不签 GA/GRR。实际 Docker OS/正常 STOP 的 7.281 秒观察及独立接受直接复用，不重做；父崩溃仍未实测。

剩余接线差额和直接复用函数列于相邻 `docker-engineering-observation/ImplementationDelta.json`。本目录复用 `control-root-registration/verify.py` 的精确 SHA、`strict_json`、`GitHub.get/bound_json`，不修改任何冻结包。

## 实际实现

- `publish_once` 仅允许固定私有仓库 `tdoljyj/cross-memory-system` 的 `artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/runtime-evidence/<attempt>/intent.json|result.json|recovery.json`。准确 JSON 原字节上限 64 KiB；拒重复键、不接受路径穿越、其他仓库、文件种类或任意命令。调用者没有分支、commit message、覆盖 SHA 或其他目标参数。
- 先用 CreateNew 本地 publication ticket 保留此次尝试，然后核对预期 main、调用 GitHub Contents API 的新建文件操作。请求省略更新所必需的旧 `sha`，只接受 HTTP 201；已有文件不会被更新。commit 作者使用当前实际仓库的 `Codex@DESK-W-591` 身份配置。此步骤是普通工程证据提交，绝不是签名 Authority。
- 返回后检查真实 commit parent、path、Git blob SHA、size，再做独立 GET：准确 commit → 完整未截断 tree 中的普通 `100644` blob → 该 commit 下的内容，校验原字节 SHA256、Git blob SHA、大小和严格 JSON。更新/符号链接/错误树/不同内容不接受。`read_back` 可作为未来动作前的精确持久字节读回步骤，**本函数本身从不派发动作**。
- Contents API 不提供 expected-head CAS。并发 main 变化可能已经追加了一个普通证据文件；parent 不符则保持 UNKNOWN，不能假称获得事务级 fencing。上传超时、响应丢失、回读失败、分支保护拒绝或已有 ticket 一律 UNKNOWN，保留路径和预期摘要，不自动重试。`read_back` 只恢复已知精确引用的字节事实，不把 UNKNOWN 自动升级成运行成功或释放容量。
- `encode_result` 把原 Intent 的完整不可变引用放进辅助结果字节，`read_result_chain` 校验同 attempt、两份准确历史字节和原引用一致。这个最小适配器 framing 只是辅助 Evidence 内容，**不是正式 S06 新对象/Schema，也不是 GRR 或其终态枚举**。任意 outcome 仍是待核证据，不能自报授权。结果顶层强制保持 execution/current-authority/qualification 关闭。

代码只有 library 接口；直接启动 `remote_evidence.py` 返回 BLOCKED，不提供 CLI publish/执行入口。`formal_run` 即使收到 accepted/qualified 等调用者布尔值也始终拒绝，副作用数为 0。真正的当前 RootSet、issuer 和撤回必须读取已部署的 private ControlEvidenceStore，Git 历史字节证明不替代它；该 SQL adapter 只处理 Root generation/revocation，本次未扩成 Intent/Result/GA 数据库。

## 调用边界与尚缺证据

主控在独评精确候选后，才可在已批准范围内实例化固定宿主 GitHub transport 并发布合成工程记录；凭据只留受信宿主，不能传入隔离运行。若现有 main 保护拒绝，保持拒绝，不更改保护规则、增加 token scope 或换分支绕过。main 的普通新提交可能触发现有 CI，实际发布前须由主控处理既有流程和零新增付费限制；本次没有触发任何 GitHub 写入、CI 或费用。发布操作不与主控签名/普通发布并行。

运行正式动作还需要已独立接受的实际 RootSet/schema/issuer、Profile、准确 GA 及真实签名、适用当前 Vector/独立代际、预算/容量、固定动作与 Skill、停止/撤回/fencing 和一个 GA 一个终态 GRR 的实际接线。不能用本地 ticket/fsync 充远端 sink，不能用远端上传充当前授权，不能把这份适配器当成完整合格 controller。此处不为 GA 前的工程准备增加循环前置。

实际新增检查为 11/11 PASS：合成 transport 回应和临时本地证据，真实 subprocess/network/Git 写入禁止。覆盖精确 commit/blob/tree、同键与变参不重发、写后失联、回读失败、分支竞态、内容和引用篡改、符号链接/截断 tree、HTTP 201 新建请求、跨 attempt 结果和伪授权拒绝。无真实远端 Intent/Result 往返结果，无新 OS/STOP/崩溃运行，也无资格通过。

GitHub API 的新建/更新语义及 201/200 区分见[官方 Contents API](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)。本接线沿 `bootstrap/AuthorityWiringReview.md` 的限定私有工程 Evidence 建议；实际存储适用性最终由指定独立评估者按原 S06 和已批准范围接受。
