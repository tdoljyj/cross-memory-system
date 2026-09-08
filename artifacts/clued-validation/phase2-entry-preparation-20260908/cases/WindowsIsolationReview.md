# Windows 隔离探针独立审阅

范围：LOCAL_ENGINEERING_ONLY。未签发 controller、Skill、Profile、GA、R11 或 Slice A 资格。Python controller 的既有 28 项未重跑，受查字节未变。

## 受查对象

- 源码：`scripts/phase2-qualification/windows-isolation/AppContainerProbe.cs`，SHA256 `c1a15d489df2beae41e69d05b45edafdad1133717716c39f1efede0e2ff58f4e`。
- 实际执行二进制：SHA256 `f89fbf0582b0e88f9c194372e7e07996d3e07240d5bbb48fea00335b5a03a643`。
- 复用了维护者 Attempt01、Attempt02 与 Attempt01Cleanup 的真实观察。Attempt01 ACL 恢复失败保留，未改成成功。
- 另做一次独立执行以补齐父进程确已注入合成环境哨兵的可保存证据。仅固定合成子进程、新专用目录、随机临时 AppContainer profile、单个新建 canary 的临时 DACL 和本机 loopback listener；未修改全局安全设置。

## 独立结果

详见 [IndependentObservation.json](windows-isolation-independent/IndependentObservation.json)。

| 检查 | 实际观察 | 结论边界 |
|---|---|---|
| AppContainer 身份 | 父侧与子侧均读到 is_appcontainer=true、同 SID、capability_count=0 | 证明此次固定子进程的 Token 属性 |
| 专用目录 | allowed_write=true | 仅此次专用合成目标 |
| 外部合成文件 | outside_read_denied=true、Windows 错误 5 | 证明该 canary 被拒绝；不外推为整个宿主不可读 |
| 环境哨兵 | 父侧已存在=true，子侧 credential_canary_inherited=false | 证明该环境变量不继承；不代表任意密钥存储双向隔离 |
| 停止 | 停止前存活，termination_observed=true，退出码 77 | 固定子进程被确认终止；不是远端任务或分布式容量收敛 |
| 临时清理 | profile 删除 HRESULT=0，目录移除=true，canary ACL 恢复=true | 独立运行的有限清理完成 |
| 网络 | 宿主 loopback 正例连接成功；子侧 TIMEOUT_NOT_DENIAL_PROOF | **网络拒绝未证实**，不能以超时或零 capability 代替明确拒绝证据 |

独立读取仅核对上述三次已知 profile 的精确路径，全部 AC 及 profile 父目录均已不存在；Attempt01 新建 canary 已不存在。见 [CleanupVerification.json](windows-isolation-independent/CleanupVerification.json)。未枚举其他 profile、未删除其他文件。

## 静态审阅和剩余边界

源码使用固定的自身子进程、显式环境块、关闭句柄继承，并读取父侧与子侧 Token；临时 profile 和 canary 清理均在 finally 中处理。对 timeout 保留非拒绝结论，与实际观察一致。

这个探针尚未承载 Python controller 或新 Skill，不支持把其结果移植成当前 controller 的宿主隔离资格。未证明一般代码、文件系统整体、互联网/全部网络、宿主密钥存储的双向隔离；未绑定合法 issuer、Authority、Profile 和 GA。静态源码审阅与二进制实际执行分别记录摘要，不据此声称完成正式可复现构建或供应链资格。缺失项仍需实际合法控制证据与适用独立资格记录。
