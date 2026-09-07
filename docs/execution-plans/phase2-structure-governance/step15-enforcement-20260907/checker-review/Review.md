# 迁移后边界校验独立审查

结论：**修复后，12 项定向 fixture 测试通过；原发布核心 42 项回归通过。** 这不代表实际 Step15/18 通过。

测试只从真实 ExecutionInputs.candidate.json 读取 45 份已保全 payload 和 39 个锁定治理来源，并逐字节核对摘要后，在隔离目录重建 64 个目标/封存状态。Synthetic Freeze 明示 fixture_only / authority_effect NONE，没有改实际安装、接受记录或冻结决定。

发现并实证修复了一个问题：校验脚本先 resolve Freeze 入参，抹掉了目录 junction 路段，然后再检查链接。修复前单独负例失败，因为该链接别名竟得到 PASS；修复后先保留词法路径检查，两个目录链接负例均拒绝。原始失败见 before-repair/FixtureTestReport.json，修复后完整结果及全部来源摘要见 after-repair/FixtureTestReport.json。

另外，发布器原本把派生审计事件放在冻结的 TM19 目录内，会被后续边界校验视为额外写入。依父任务明确指示，事件改到 artifacts/clued-validation/phase2-publication-receipts/，没有放宽三个冻结 namespace 的写入集合；42 项现有测试重新通过。

覆盖包括合法 64 路径/39 锁、目标字节篡改、已接受来源篡改/缺失、三处 namespace 额外写入、封存旧入口重开、目标变目录、治理目录链接、Freeze 链接、输入与 Freeze 摘要漂移。还明确验证：允许 Activation.json 作为派生文件例外，不等于接受它；真正读取仍必须经过 publication.py 的远端证据复验。

摘要、文件版本和测试限制见 Review.json。
