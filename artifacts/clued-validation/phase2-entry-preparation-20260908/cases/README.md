# PQUAL 20 项输入与独立工程验证

这是资格测试的准备包。20 项正式场景均为 **NOT_EXECUTED**；本地控制器检查为 **LOCAL_ENGINEERING_ONLY**，不签发资格、R11、Entry、Slice A、模型或生产接受。

[QualificationCases.json](QualificationCases.json) 保留 PQUAL-01 至 PQUAL-20，一项不删。每项列出源场景、精确故障变体、动作、预期结果、证据要求与可复用的本地检查。它是执行计划，未新增运行协议。实际 Authority、Profile、GA、controller 资格、OS 隔离和证据落点仍须从现有受权来源取得；未解析引用不得用字符串占位制造正式可执行输入。

## 本地验证

最终独立执行为 **28/28 PASS，0 FAIL**，见 [IndependentVerification.json](IndependentVerification.json)。受查 controller SHA256：`ec72de3116c6e2af88a10c9a980414c11586dd17feffb82fa0ffba32823cc26f`。该结果只适用于这些精确字节和本地检查范围。

审查发现已有结果重放缺少资格边界及内容绑定检查，维护者已修复；独立验证已覆盖伪造资格字段、摘要不符、result/intent 截断及目标漂移。损坏后的既存动作保持 UNKNOWN 或明确拒绝，均不重执行。未以新签名、信任根或额外生产权限解决本地证据错误。

在仓库根运行：

```powershell
python artifacts/clued-validation/phase2-entry-preparation-20260908/cases/verify_candidate.py --controller scripts/phase2-qualification/controller.py --out-dir C:/path/to/new-isolated-attempt
```

输出目录必须尚不存在，每次执行保留独立 attempt。脚本动态绑定 controller SHA256，以真实子进程运行固定合成动作；不调用任何生产或模型接口。运行中撤销、停止、证据落盘失败通过实际文件故障注入观察；原始成功证据和注入故障目录分别保留，不删除失败历史。

检查覆盖：合成动作、同 key 重放与变参拒绝、正式模式和未列入白名单动作拒绝、runner 与 control generation 漂移、动作前及运行中 STOP/撤销、父环境哨兵不继承、目录越界和自定义载荷拒绝、进程超时与确认终止、真实结果持久化失败、UNKNOWN 不盲重试、只读 reconcile、结果资格字段/摘要篡改、JSON 截断与目标漂移。

**不能由这些本地检查证明的事项：**

- 真实 Owner、issuer、委托、Profile、GA、R05–R10 与 R14 的合法性。
- OS 文件系统、网络及宿主密钥存储隔离。环境哨兵不继承仅证明该子进程环境边界。
- 真实服务撤销、缩权、独立代际、分布式 fencing、授权过期/续期、预算及远端进程失联收敛。
- 新 Skill 的真实任务比较、模型实时调用、真人效率测量或 Slice A 集成验收。

## 成本与顺序

先复用已有源合同和这次独立检查；当前 controller 字节未变时不重复同一轮。第 1 路收口现有证据与资格输入、第 2 路维护 controller、第 3 路独立负测，文件写集分离。共享授权、撤销、停止状态与发布必须串行。取得真实受权运行通道后再填精确绑定并执行全部 20 项；单个外部缺口只阻断对应资格结论，不停止无关准备工作。

P0 20 项不可删减。部分本地探针同时覆盖多个源场景的局部边界，不代表对应正式场景已经通过；无凭证、无调用或纯静态推导均不得计为实际资格 Evidence。
