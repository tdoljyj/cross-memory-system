# 600 秒同范围 Profile 后继

原 Owner 已批准单项不超过 600 秒。本版保留原 180 秒全部字节，只前向更新同一 Profile 的版本、时限及其精确 Schema 常量。原 GA 和 Vector Schema 不变。总计 7200 秒、1 GiB、新增证据预算、单活动槽及 Owner 结束时间均不变。

固定父程序引用改为同范围 `parent600.py`：原合成动作完成后刷新输出，最多等待 600 秒并响应 SIGTERM 正常退出，使真实 Running 与 STOP 可观察；外部绝对 deadline 和 30 秒停止预留仍先行约束。它不执行 Skill 文本，也不修改原 Skill/fixture 字节。完整 controller/Gate/Test 来源仍须最终一致绑定。

本版没有新增正式 PostgreSQL 副作用入口。真实历史组件测试按原时间、原源码、原始证据和实际适用性复核，不冒称在新 GA 内重跑。准备文件不签发 Profile 接受、GA 或 controller 资格。
