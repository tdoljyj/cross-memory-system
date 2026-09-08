# Kernel Stability Hardening 正式横向基线

用户指定正式 Baseline ID：`CLUED-PHASE2-KERNEL-STABILITY-HARDENING-INTEGRATION-v0.1-20260908`。

本目录保留正式原文的精确 38,666 字节，SHA-256 为 `936cb966a75765ca156f5706237467b940ea32891bbc98c2c21ec9a8b8ec06a0`。冻结前候选 `1e421dcd3a262b3e20185d83beae8c3a981bf12e806f9df9dede521d0458bd24` 不作为执行对象。变更本原文必须采用独立后继修订与新的身份，不能沿用当前 Baseline ID / SHA。

当前仅接入执行基线、准备合同与负例、复用已有风险证据；不宣称 Stability Contract Freeze 或能力实现。R07–R10 / A01–A11 当前适用 P0 优先，checkpoint 修复仍走原有主线普通工程路径。此次接入不创建新 P0、新权限或新的业务事实源。

正式顺序保留原文：当前 P0 → Step 1–4 风险盘点 → Step 5–8 合同草案与负例 → Step 9–11 独立审查、Architecture Acceptance、Structure Freeze → Stability Contract Freeze → 满足既有条件后 HS-0 → Step 12–16 实施及运行对齐 → 正式 R11 → HS-1 → Step 17–18 → HS-2 → Slice A + HS-2.5 → Step 19–21 → 全部既有条件 PASS 后 HS-3 → HS-4。

历史 21 步已接受的 Naming / Structure 对象按适用性复用；历史接受不能代替新 Stability 合同的验收。Step 12–14 的局部遥测、日志与告警不计作 R11。与更高优先级基线的顺序、Authority 或 Gate 冲突登记 Review Finding，不自行解决为扩权或跳步。
