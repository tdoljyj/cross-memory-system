# Linux Docker 固定接线候选

状态：**工程准备；没有 Docker 执行器，run/formal 均拒绝。** 这是原冻结包的独立后继目录，不改变 `docker-isolation`。它提供固定 argv、纯状态机和独立本地 Intent，供后续最小执行器逐项接线；不是可运行的合格控制器。

受查固定 driver 为相邻 `docker-isolation/probe.py`，SHA256 `2168145b42166b4de1ea470b4fd232549d661542761ffe279955d0ace5580523`。本包引用、核验该字节，不复制或执行它。真实 image digest、Linux host、Docker 构建及镜像本地身份仍未提供；测试中重复十六进制字符仅为合成形状夹具，绝不是实际镜像。

## 当前实现

- `candidate.py` 只接受 `image`（固定 Python 仓库与 digest）和 `run_key`（32 位十六进制）。没有任意命令、可执行文件、mount、环境、模型、付费或权限参数。所有候选命令固定 `/usr/bin/docker`，容器操作只接受完整 64 位 ID；不存在 shell、exec、rm、pull 或自动重试接口。
- create 计划固定非 root、只读 rootfs、network none、cap-drop ALL、no-new-privileges、CPU/内存/PID/tmpfs/日志限制、private IPC、关闭镜像 healthcheck 及仅两项合成挂载。Linux 路径固定为 `/tmp/clued-linux-docker-candidate/<run_key>/probe.py` 与 `allowed`，没有进行实际 staging。
- `prepare` 在本目录 `work/<run_key>` 原子创建独立保留目录；CreateNew 写入 Intent、fsync、独立读回。相同 key、变参、半写或坏旧文件均保留 UNKNOWN，不覆盖旧记录。Intent 失败后仍保留该 key。它是本地工程记录，不是完整抗崩溃事务或正式远端 sink。
- `simulate` 只计算候选顺序：Intent → create 已派发状态 → 精确 ID → pre-start inspect 模型 → start 已派发状态 → typed running 观察；STOP 必须有独立 Intent，再生成 exact-ID stop、wait，最后核对 wait exit code 与 exact-ID exited/Pid=0/非零 RFC3339 时间的一致性。结果始终带 `ENGINEERING_MODEL_ONLY`、executed=false、qualified=false。状态名如 RUNNING/STOPPED 表达合成状态机结果，不是实际运行/进程树证据。
- 丢失、超时、撤回、持久化失败或无效观察进入粘性 UNKNOWN；再次 create/start 或自行提供 reconcile 成功均不能解除 UNKNOWN。已知 ID 不丢失。未知运行的真实停止与独立恢复接线仍未实现，不能把本模型用于现场故障恢复。
- pre-start 模型核对安全配置、命令、身份和准确两项 mount；本初版保守要求镜像 Env=[]，并禁止镜像卷及 healthcheck 动作。普通 Python 镜像自带环境可能因此被拒绝，需未来精确环境绑定的独立接受后继；不能把形状验证当镜像来源证明或任意放宽 allowlist。

纯检查入口：`python -I -S -B -X utf8 scripts/phase2-qualification/linux-docker-driver/test_candidate.py`。11 项测试实际通过，全部是纯函数或隔离临时目录的本地证据读写；未调用 Docker、探针、镜像拉取、CI、WSL 或模型。精确源摘要和观察边界见 `PreparationEvidence.json`。

## 真实执行前仍缺什么

本次没有接真实 subprocess、Docker image/container inspect、staging/权限设置、超时监督、活体子孙观察、撤回后的优先停止、停止结果持久化或 UNKNOWN 的独立恢复。`simulate` 接收的字典是不可信工程输入，不是平台回执；不能把返回 argv 交给通用执行器直接运行。生产/正式入口也不接受调用者提交一个形状正确的授权字典来解锁。

后续只有实际独立接受的精确 host/image/dependency/driver/config/fixture/Skill、有效 Profile 与短期 GA、现有 store/control generations 和当前完整撤回 vector、预算/单一容量及已核实零付费条件、动作前远端持久 Intent 和读回、受控无凭据宿主调用、真实隔离及停止证据都齐备，才可接固定执行器。宿主环境与 Docker endpoint 不能由继承环境选取；必须核对 `/usr/bin/docker` 实际文件、daemon 和 scope，而非仅信任路径字符串。

实际 staging 还需同范围专用目录、不可链接且不可被替换的源/写路径、固定 driver 摘要和容器内允许 UID 的最小权限。当前的路径拒绝和本地 fsync 没有证明防 TOCTOU、父目录抗崩溃落盘、恶意宿主抗篡改或 OS 隔离。真正的网络拒绝、凭据哨兵、文件拒绝和全树停止只能由独立读取的真实探针/宿主观察建立；普通 Docker/CI 成功和本测试的模拟 STOPPED 都不能代替。

不创建新 controller 信任根，不改旧 pins，不注册 control root，不将 Skill 当代码，不新增 workflow，不触发任何运行或费用。所有正式资格、R11、PQUAL、HS Gate 和 Entry 结论保持未签发。
