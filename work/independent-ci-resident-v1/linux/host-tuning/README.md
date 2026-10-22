# WSL 主机调优：hv_sock 环形缓冲与 kswapd 水位（Task `7c2e4386`）

常驻执行器 Linux 侧所在的 WSL 虚拟机要加四项内核设置，防止 Windows→WSL 的 hv_sock 连接因内存碎片建不起来。2026-10-22 07:49Z 和 13:22Z 两次 order-7 分配失败，烧掉了两个 trivy 段的 head。

| 设置 | 默认 | 改成 | 作用 |
|---|---|---|---|
| `net.core.rmem_default`、`net.core.wmem_default` | 212992 | 65536 | 新 hv_sock 通道的两块环形缓冲合起来，从 order 7（512 KiB 连续）降到 order 5（128 KiB） |
| `vm.watermark_scale_factor` | 10 | 200 | kswapd 提早回收，平时每个 zone 多留约 2% 空闲 |
| `vm.watermark_boost_factor` | 15000 | 3500 | boost 上限按 high 水位的比例算。上一行把 high 抬高约 4 倍，这一项把 boost 上限维持在现在的绝对值 |

- 这个配置不属于常驻层钉住的文件，改它不会触发每批的漂移 HALT。
- 现场生效：不需要重启 WSL，也不需要 Windows UAC。
- 公司节点（Windows + WSL）安装时同样执行一次。

## 步骤

在 Owner 会话里用 `wsl -d Ubuntu-24.04 -u root` 运行，时间窗口由协调会话排。

| 文件 | sha256 |
|---|---|
| `clued-wsl-host-tuning` | `e310e2e75f90023ca9abfffe0681aa3a790ecd16172c0844c965f9117385669d` |
| `60-clued-ci-hvsock-memory.conf` | `7ef616b66f216de6ea6a9da1d151477db18f66a924cfe02bfecc9015667b0a06` |

1. 复制到 root 目录，核对上表哈希。`PKG` 是本目录在 WSL 里的路径；哈希不一致就停下。
   ```
   S=/var/lib/clued-wsl-host-tuning/staging-$(date -u +%Y%m%dT%H%M%SZ)
   install -d -o root -g root -m 0700 /var/lib/clued-wsl-host-tuning "$S"
   install -o root -g root -m 0700 "$PKG/clued-wsl-host-tuning" "$S/"
   install -o root -g root -m 0600 "$PKG/60-clued-ci-hvsock-memory.conf" "$S/"
   sha256sum "$S"/*
   ```
2. 只读看计划：`python3.12 -I -B "$S/clued-wsl-host-tuning" plan --conf "$S/60-clued-ci-hvsock-memory.conf"`。
   - 输出的 `planSha256` 必须等于 KooYomi 里 Owner 批准时记下的值，`bootOverrides` 必须为空。
   - 不一致就不要 apply：说明计划绑定的现值、文件状态或开机覆盖情况已经变了，要重新审批。
3. 生效：`... apply --conf "$S/60-clued-ci-hvsock-memory.conf" --plan <已批准的 planSha256>`。以下情况会拒绝：
   - `CI_UNIT_ACTIVE`：此刻有 `clued-ci-*` 单元在运行。它只看这一瞬间的 Linux 单元，看不到批次里 Windows 侧的阶段，也看不到检查之后才启动的单元，所以窗口仍要由协调会话排。
   - `DROP_IN_DIFFERS_OWNER_DECIDES`：目标位置已有内容不同的文件。
   - `KEY_OVERRIDDEN_AT_BOOT`：排在后面的 sysctl 文件显式设了同一键，或者有键名完全相同的 `-key` 行，开机时会覆盖或取消这里的设置。通配项不会覆盖显式键，不算。
   - `PREVIOUS_APPLY_NOT_ROLLED_BACK`：上一次 apply 没做完。先用那次的保存文件回退。
4. 另开一次 `wsl.exe`，运行 `verify --conf ... --saved <apply 输出的 saved>`。要求：
   - 状态为 `HOST_TUNING_VERIFIED`；
   - `ringEffective: true`：apply 之后新开的通道，发送环大小都是 61440。
   - 如果是 `false`（新通道全是 208896），说明 WSL 中继自己设了缓冲，65536 不起作用，立即回退；
   - 新旧大小同时出现仍算 `true`：WSL 在 sysctl 生效前建好的监听（开机时或 apply 之前）连进来的通道保持旧大小，重启之后必然如此；
   - `null` 表示 apply 之后还没有新通道，再跑一次 verify 即可。
5. 回退：`... rollback --saved <apply 输出的 saved>`。
   - 保存文件名是 `previous-<UTC>-<6 位十六进制>.json`，就用 apply 输出里的那一个；`PREVIOUS_APPLY_NOT_ROLLED_BACK` 的 `detail` 也会列出它。
   - 回退成功后，这个保存文件改名为 `rolled-back-…`，之后不再挡 apply。
   - 回退会写回原值，并把 apply 建的配置文件移进状态目录，不删除。
   - 配置文件已被改动过时拒绝（`DROP_IN_CHANGED_SINCE_APPLY`）。

## 内存守护（可选，与上面的配置分开批准）

`clued-wsl-memguard` 每 60 秒运行一次，批次进行中也照常运行：
- 先按当前的 `net.core` 值算出 hv_sock 环形缓冲的阶数，再把各 zone 中不小于这个阶数的空闲块加起来。分配要在所有 zone 都凑不出块时才会失败，所以只看合计。
- 合计少于 64 块时执行一次 `compact_memory`。如果 5 分钟内上一次整理只多出不到 8 块、而且之后仍低于 64 块，这一遍就跳过整理，免得对正在跑的扫描反复做无效的全量整理。上一次整理把合计拉回到 64 块以上的，下一次照常整理，不升级成丢缓存。
- 还不够时执行 `drop_caches=1`（只丢干净的页缓存，不碰 slab、脏页和被映射的页），然后再整理一次。丢缓存最多 5 分钟一次，而且先写时间戳再丢。
- 时间用 `CLOCK_BOOTTIME`。每一遍都先确认两个 `/proc` 文件和自己的状态目录可写，再做任何动作。
- 做了动作时往 journal 写一行 JSON；没有动作时每 10 分钟写一行计数，观察期能看出离阈值还有多远。
- 单元设了 120 秒超时，卡住的一遍会以 timeout 结束，`guard-verify` 能发现。

它只写这两个 `/proc/sys/vm` 文件和自己在 `/run` 下的时间戳，不启停、也不读常驻执行器的任何东西。

| 文件 | 安装位置 | sha256 |
|---|---|---|
| `clued-wsl-memguard` | `/usr/local/lib/clued-wsl-host-tuning/`（0755） | `d27630a90c9d0fa727c088c5717eefdd581b31e0c73cfd62738b4822f505a591` |
| `clued-wsl-memguard.service` | `/etc/systemd/system/`（0644） | `df73066d7cdb6d0e5c1254462359797fc963406827213f6fe2857264fe644592` |
| `clued-wsl-memguard.timer` | `/etc/systemd/system/`（0644） | `f43a942ac473938b8f3d10d5b2fa79b96bcdb16d32286c9a9cd4638ce6cc4321` |

步骤与上面相同：
1. 把三个文件也复制进 `$S` 并核对哈希。
2. `guard-plan --pkg "$S"`：`planSha256` 必须等于批准值。
3. `guard-apply --pkg "$S" --plan <批准值>`：只新建文件，然后 `daemon-reload`、`enable --now` 定时器，并立即跑一遍。
   - 第一遍失败时，先停用定时器，再以 `GUARD_FIRST_RUN_FAILED` 拒绝，`detail` 是保存文件；随后用它回退。
   - 已有未回退的保存文件时拒绝（`PREVIOUS_GUARD_APPLY_NOT_ROLLED_BACK`）。只有文件一致、定时器在运行、上一遍成功时，才报 `GUARD_ALREADY_APPLIED`。
4. `guard-verify --pkg "$S"`：文件一致、定时器已启用且在运行、服务单元已加载、至少运行过一次、上一遍成功。
5. 回退：`guard-rollback --saved <guard-apply 输出的 saved>`。
   - 有文件被改过就拒绝，什么都不动。
   - 否则把定时器恢复到 apply 前记录的状态（原来没装就停用），执行 `reset-failed`，再把它装的文件移进状态目录；保存文件随后退役。
6. 平时查看：`journalctl -u clued-wsl-memguard.service --since <时间>`。

## 判定

- 生效后至少看 60 个 Linux 段，用跨启动的写法检查：`journalctl _TRANSPORT=kernel --since <apply 时间> --grep 'page allocation failure'`。
  - 不能用 `journalctl -k`：它只看本次启动。
  - 同一失败 10 秒内只打印一条，所以行数只是下限。
- 同时统计 `UtilAcceptVsock` 报错和 worker 的 `UNCERTAIN / ACTUAL_SCANNER_OBSERVATION_MISSING`。`verify` 的 `memory` 一栏记录了各 zone 的 free、boost、水位、伙伴块和 `page_reporting_order`。
- 下次 WSL 重启后再跑一次 `verify`，确认 systemd-sysctl 在开机时重新应用了这个文件。

离线测试：在 `work/independent-ci-resident-v1` 下运行 `python -I -B -m unittest discover -s test -p "test_host_tuning.py"`。在 Linux 上运行还会多测一项符号链接拒绝。
