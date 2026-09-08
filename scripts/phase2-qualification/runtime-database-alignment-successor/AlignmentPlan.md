# 正常资格恢复的最小对齐准备

首选完成当前 ga_18ce 的真实非通过 GRR 后，只恢复 `execution_transition` 为 2026-09-08 19:21:23 实际保存的原函数。S06 取消与幂等对账约束的是行为和证据，独立核对未发现该临时恢复分支必须常驻的要求。恢复功能不再常驻必须如实记录；以后同类事故不能自动重用本次仅绑定 ga_18ce 的恢复接受。

原函数 DDL SHA256：e75e18bbe3c7ed3125aba7b7b2c5db95e23b8022cd05b5bf0e818440becbca88。来源是本地保留的真实 `recovery-install-preflight.json`（bfa43e28367d6b213b7b6e1455161868a8e5dae4d7067fd02e29f3c1aedc4b60），不是从旧源码猜测现场函数。该文件含动态控制记录，不复制到 Git。

`prepare-restoration.mjs` 只接受当前原 GA 已有真实唯一非通过 Receipt、已无 active/pending、Root/旧绑定/代际/预算不变的完整实际终态前检。生成一个事务内前检、原函数 CREATE OR REPLACE、完整后检与回读。前后保护全部 14 个函数的字节与权限、8 表权限/RLS，以及完整控制状态；只允许该函数恢复，绝不回退任何当前行、事件、结果或计费。脚本不调用 SQL、不签名、不启动进程，不触碰生产。

恢复后需要实际独立确认 14 个函数与原 19:21 完全相同、原 201 源字节仍一致，才可判断旧 runtime acceptance 6dad / qualification bae2 的当前适用性。源一致不自动等于新资格结果。已接受的外置 fresh-input 调度仅改变取实时输入的时机，也仍需真实运行验证；失败不得重复派发。

这条路径不需要新 Root、Binding rotation API、Profile/Gate/schema、controller digest、qualification 或 runtime metadata 副本。保留原 execution_binding、Status 对象和所有接受记录；新 GA 仍需真正的新实例 ID、实际预算预留与签名，status/current/期限与独立代际按原流程核查，不能复制旧已撤回 GA。是否需要新的 Status 取决于真实当前性和原源是否仍一致，不预造观察或代际。

备选常驻后继仅在明确需要时另做：新的完整 controller source、Host/Scope/Test executor、资格/Runtime接受、Status及当前Binding需要单向重新绑定；当前immutable execution_binding没有合法替换入口，不能裸UPDATE或把新值假称旧接受。此次停止准备该较大路线，不新增事件协议或第二控制域。
