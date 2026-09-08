# 固定私有分支的辅助 Evidence 接线候选

状态：CANDIDATE / NO_FORMAL_EXECUTION。当前代码接通固定 Git Data API 的创建、单父提交、非强制引用推进和精确字节回读。仅辅助工程 Intent/Result/Recovery；不连接 Docker，不运行 Skill/PQUAL，不写 RootStore，不签 GA/GRR。

目标固定为私有仓库 `tdoljyj/cross-memory-system`、分支 `codex/phase2-qualification-evidence-20260908`，路径仅 `artifacts/clued-validation/phase2-entry-preparation-20260908/bootstrap/runtime-evidence/<attempt>/intent.json|result.json|recovery.json`。分支首次创建由主控在独立接受后处理；适配器没有创建分支接口。main 工程代码和接受对象继续既有 PR 与必要 CI，本包不改保护或工作流。

`publish_once` 先创建并 fsync 本地尝试凭证，随后严格读取仓库 `full_name` 和布尔 `private is True`，核对固定分支的真实预期 head。读取完整父树并拒绝已存在目标，再创建准确原字节 blob、仅新增一个普通 100644 blob 的树和单父 commit；重新核对 head 后，仅以 `force:false` 推进固定 ref。每个写请求前重新核对仓库私有性；不接受调用者提供其他分支、仓库、任意命令或覆盖对象。树比较必须保留父树所有其他叶子。

每个已确认 blob/tree/commit SHA 都以 CreateNew 本地进度记录保全；超时、响应丢失、已有凭证或目标、分支变化、保护拒绝和回读失败均保持 UNKNOWN。已知不可变对象引用随 UNKNOWN 返回，不重试、不自动删证据或释放运行容量。single-parent + non-force 保护本次分支推进不覆盖并发分支后继，**不是**外部业务副作用的原子 fencing。响应丢失时可能已创建未知对象，不能声称没有远端副作用。

成功后通过准确 commit、完整 tree、普通 blob 和原字节 SHA256/Git blob SHA/大小执行独立 GET 回读，复用已冻结 `control-root-registration/verify.py` 的 `strict_json`、`GitHub.get/bound_json`。Git 历史字节不是当前 RootSet/撤回 Canon。`encode_result/read_result_chain` 将结果绑定原 Intent 的准确引用，只是辅助 Evidence framing，不是正式 Schema/GRR。

本地 ticket 只防当前宿主盲重发，不能充远端持久化回执，也不构成跨宿主互斥或可信预算账本。任意 outcome 仍是待独立核对数据，输出强制保持 authorization_effect=NONE、execution/current-authority/qualification=false。`formal_run` 始终 BLOCKED、派发数为零，CLI 不提供发布/执行入口。

独立评估者已确认 S06 的 live sm/ga/grr 权威 Store 约束不要求纯辅助工程 Evidence 放 main；此固定非生产分支不充 ControlRoot/current Canon 或正式 GRR。真实发布由主控在本候选精确独评后串行完成，凭据只在受信宿主。此次修改没有 GitHub 写入、CI、Docker、模型或付费动作。

本次只执行新增 `test_branch_successor.py`：8/8 PASS，0 FAIL/SKIP，0.117 秒。合成 transport 和真实临时本地 ticket 覆盖严格私有性、缺失/变动 head、已存在路径、单路径树、并发推进、失联 UNKNOWN、已知对象保全、禁止重发及固定非强制 ref 请求。未执行旧 11 项；旧 main-target 源码、README、测试、索引及其真实历史结果原字节保存在 `history/main-target-49084ace/`，历史 Evidence SHA256 为 `49084acecaa6c67de6bf0fd40be92c872ac9f9810be84508328429ed972fa45d`。历史测试不宣称覆盖当前 successor，也不应作为当前测试入口。

仍缺实际 accepted Root/schema/issuer、Profile、签名 GA、当前撤回与代际、可信预算/容量、固定 Skill/action 接线和动作前后及生命周期检查。已接受 Docker OS/正常 STOP 7.281 秒观察直接复用；父崩溃未实测。详见相邻 `docker-engineering-observation/ImplementationDelta.json`。不得将本适配器称为合格 controller。

独评后补修：复用 transport 的新 attempt 在起点清空仅内存的旧对象引用，避免前置拒绝将前一次 commit 错归本次；旧 attempt 的磁盘凭证不改。只新增执行 test_attempt_scope_fix.py，1/1 PASS，0.057 秒；上方 8 项是修前源 15e50bd63701c727432c2dec4d6b06aef308176a31549671705af7a46729e178 的历史检查，没有重跑。

Git 身份后继：author 与 committer 均显式固定 Codex@DESK-W-591 / codex@local，并在创建响应及准确 commit 独立 GET 中分别校验。只执行新增 test_commit_identity_fix.py，1/1 PASS，0.021 秒，旧套件不重跑。之前 d8f125cc 索引与 f8c213 源等六文件保全在 history/branch-target-d8f125cc/，源码重建后 SHA 与已接受原字节准确一致。
