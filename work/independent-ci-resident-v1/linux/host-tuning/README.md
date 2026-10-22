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
| `clued-wsl-host-tuning` | `f25babf71670a777d306d44023ba37b957d84e88639018fbfc6f1f13ccab889c` |
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
   - `KEY_OVERRIDDEN_AT_BOOT`：排在后面的 sysctl 文件会在开机时覆盖这里的某项设置。
   - `PREVIOUS_APPLY_NOT_ROLLED_BACK`：上一次 apply 没做完。先用那次的保存文件回退。
4. 另开一次 `wsl.exe`，运行 `verify --conf ... --saved <apply 输出的 saved>`。要求：
   - 状态为 `HOST_TUNING_VERIFIED`；
   - `ringEffective: true`：apply 之后新开的通道，发送环大小都是 61440。
   - 如果是 `false`（新通道仍是 208896），说明 WSL 中继自己设了缓冲，65536 不起作用，立即回退；
   - `null` 表示 apply 之后还没有新通道，再跑一次 verify 即可。
5. 回退：`... rollback --saved <apply 输出的 saved>`。
   - 保存文件名是 `previous-<UTC>-<6 位十六进制>.json`，就用 apply 输出里的那一个。
   - 回退会写回原值，并把 apply 建的配置文件移进状态目录，不删除。
   - 配置文件已被改动过时拒绝（`DROP_IN_CHANGED_SINCE_APPLY`）。

## 判定

- 生效后至少看 60 个 Linux 段，用跨启动的写法检查：`journalctl _TRANSPORT=kernel --since <apply 时间> --grep 'page allocation failure'`。
  - 不能用 `journalctl -k`：它只看本次启动。
  - 同一失败 10 秒内只打印一条，所以行数只是下限。
- 同时统计 `UtilAcceptVsock` 报错和 worker 的 `UNCERTAIN / ACTUAL_SCANNER_OBSERVATION_MISSING`。`verify` 的 `memory` 一栏记录了各 zone 的 free、boost、水位、伙伴块和 `page_reporting_order`。
- 下次 WSL 重启后再跑一次 `verify`，确认 systemd-sysctl 在开机时重新应用了这个文件。

离线测试：在 `work/independent-ci-resident-v1` 下运行 `python -I -B -m unittest discover -s test -p "test_host_tuning.py"`。在 Linux 上运行还会多测一项符号链接拒绝。
