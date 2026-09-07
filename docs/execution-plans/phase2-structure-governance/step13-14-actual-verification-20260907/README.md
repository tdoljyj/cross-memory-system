# Step13 / Step14 实际迁移后核验

Step13：18项检查、12次真实调用通过；原P2调用者回归29/29通过。18个既有消费者已映射到实际目标；27条授权和18类回执合同保留。64个after状态、39个输入锁匹配；3490个已跟踪受保护/工作流文件与迁移前逐字节摘要一致。外部服务未重复运行，不把不变源码声称为新的运行资格。

Step14：28项检查、33次真实调用通过。19个旧文档路径已移除且历史目标字节保全；根与scripts两套旧业务写命令均真实返回拒绝，未产生新Canonical状态。六个shim保留业务只读兼容及原有受控工程维护能力；没有执行CommitRepo，也没有把所有工程动作概括成只读。

首次Step13运行因测试从仓库外直接执行而缺模块根；失败记录保留。修正为真实支持入口后通过，未改仓库实现：在仓库根使用 `python -m unittest discover -s tests -p test_p2_verification_context.py`。

证据以BeforeBoundary、实际迁移事务Receipt、Freeze摘要、精确执行输入和verify_migration.py版本相互绑定。TargetConsumerBindingManifest、HistoricalNameSealManifest、LegacyWriteClosureEvidence是这些实际结果的限定投影，不签新Authority。

Step17核验入口已准备，尚未执行，必须等待Step16四Gate真实结果。后续Step15若合法增加/更改workflow或其他接线，应提供精确已审允许差异；不能对旧源无条件接受漂移。memory/apps/artifacts业务/源制品边界仍须与BeforeBoundary精确一致。Step15、16、18、19的实际执行和不可绕过证明未由本次结果替代。
