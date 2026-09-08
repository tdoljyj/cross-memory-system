# 固定 Docker 隔离与 STOP 工程观察

**候选代码已准备，待指定独立评估者核准精确计划；尚未创建或运行容器。** 目的仅是实际建立 GA 前所需的非生产合成 OS 隔离和停止工程事实，不加载 Skill，不执行 PQUAL、正式 GA 或 Slice A。`formal` 始终拒绝；本脚本没有授权记录或资格签发功能。实际调用由主控在独立计划接受后执行。

精确输入和摘要见 `EngineeringObservationPlan.json`。唯一镜像为已拉取的官方 Python `285a713…` manifest，config `1148adc…`；只接受当前 Engine 29.7.2、Linux amd64、固定 Windows CLI 摘要及 `npipe:////./pipe/dockerDesktopLinuxEngine`。宿主 CLI 使用本次独立空 Docker config，不继承 Docker context、DOCKER_HOST、注册表登录或宿主凭据。子进程环境只构造 SystemRoot/WINDIR 和本次 TEMP/TMP；不复制宿主环境。五项镜像自带公开 Env 逐字校验，公共 GPG 指纹不是私钥；这个局部适配不修改旧候选的 Env=[] 规则。

容器只挂载本次完整复制并校验过的固定 `docker-isolation/probe.py`（只读）和专用合成 `allowed` 目录（可写）。控制/证据目录、仓库、Docker socket 和宿主配置均不挂载。UID/GID 10001、network none、只读 rootfs、全部 capabilities 移除、no-new-privileges、CPU 0.5、内存及 swap 总额各 128 MiB、PID 16、tmpfs 16 MiB、限定日志、关闭镜像 healthcheck；没有任意命令/镜像/路径/环境/预算参数。

## 一次性顺序与证据

本目录 `work/observation` 通过原子 mkdir 保留一次性运行槽。存在任何旧目录或损坏证据即 UNKNOWN，不覆盖、重置或重新 create。固定源码/CLI/宿主 Python 摘要、nonce、起止预算写入 CreateNew Intent、fsync 并读回；每次 CLI 调用也先 CreateNew request，再保存原始 stdout/stderr 与结果摘要。容器响应完整 ID 持久化后才允许 start。

顺序为 host/image 只读检查 → 固定 watchdog ready → create → inspect 身份/资源/命令/Env/两挂载 → start → 读取真实 probe 文件并检查活体容器 → STOP Intent → 停止前再次核对身份 → exact-ID stop/wait/inspect。Docker Desktop 路径只接受本次准确 Windows 路径或其 `/run/desktop/mnt/host/<drive>/…` 同路径形式，未观察到的其他映射不自动放宽。

探针实际检查允许目录写入、只读根文件系统写拒绝、合成 canary 文件读拒绝、零有效/允许 capabilities、NoNewPrivs、只有 lo、回环正控制、TEST-NET 地址网络 ENETUNREACH/EPERM/EACCES、父凭据哨兵未继承和抗 SIGTERM 的真实子进程。超时或连接被拒绝不充当网络隔离证明。最终 exact-ID exited、Pid=0、有效非零结束时间与 wait exit code 相符才记录 STOP；此前活体子进程及隔离/STOP 原始证据交独立复核，不能把一条布尔字段当整个资格通过。

所有 CLI 调用共享同一绝对 90 秒截止，并有较短单次超时。观察窗口约 55 秒前结束；独立固定 watchdog 约第 65 秒接管停止，父失联仍可从本次 nonce/name/image 只读恢复准确 ID 后停止。watchdog 不因父退出、结果字符串或截止时间自动认为容器已停止。daemon/宿主失效可能导致停止无法完成：这时保持 UNKNOWN 和容量，不能承诺软件 deadline 等于物理终止。

父进程正常停止与 guard 到时停止可能重叠；两者仅对同一个已验证完整 ID 发 STOP，各自写独立证据，不产生第二次 create/start。停止后保留停止容器及所有证据供独评，不使用 rm/prune，不删镜像/卷/旧证据。所有结果 `capacity_release_authorized=false`，由独立核对实际停止后主控处理容量；任何 timeout、持久化失败、身份漂移和中断结果不明均不能自行恢复成成功或重派发。

## 预算与当前限制

依主控的保守工程计量，先前 Owner 窗口内的受控工程观察预扣 1320 秒上界，并非实测累计；本次预留 90 秒，累计上界 1410 ≤7200 秒。前述上界覆盖 09:28:59Z 至 09:50:51.106049Z 的历史单活动观察，不声称以前用量为零，也不是正式预算账本。

主控 metadata-only、nofollow 统计三个固定范围共 179 文件、19,264,968 字节：`scripts/phase2-qualification` 458,631，`artifacts/clued-validation/phase2-entry-preparation-20260908` 767,041，`ia/work/python-image-binding` 18,039,296。本次新增证据预留 134,217,728 字节，上界共 153,482,696 <1 GiB。此统计包含代码作为保守计量，仅覆盖这些明确范围，不声称所有历史磁盘开销；不把镜像根 fs 或旧克隆混作新增测试证据。脚本单条输出限制 128 KiB、观察目录总证据限制 128 MiB，超限停止并保全未知状态。

初版 13 项纯逻辑/临时证据检查已实际通过；独评后修复“证据写入跨过截止仍启动”和“watchdog 最终就绪漏查 nonce/deadline”两点，新增 3 项定点纯检查全部通过，旧 13 项没有重跑。精确新旧源码和检查摘要分别记录于计划。启动 CLI 前在日志打开后再次检查绝对截止；就绪循环、最终就绪接受及 start 前都核对 guard 的实际存活和准确身份。测试不启动 Docker。没有对真实 Docker 执行此脚本，没有 host crash、STOP 或隔离成功结论。文件读写/fsync 不构成正式远端 sink、不可篡改控制根或完整崩溃一致性证明。真实计划批准、撤回/窗口和预算由主控在调用前核验，不接受用户提供一个形状正确的本地 JSON 来代替权威。后续正式 Profile/GA/vector/sink/Skill 资格仍独立办理。

待独立评估者批准后，主控唯一工程调用为：`python -I -S -B -X utf8 scripts/phase2-qualification/docker-engineering-observation/observe.py observe`。`watchdog` 是同一固定脚本内部子进程入口，不是第二次观察入口；缺少本次已保留 Intent 时拒绝。纯检查入口为同目录 `test_observation.py`，不调用上述工程入口。
