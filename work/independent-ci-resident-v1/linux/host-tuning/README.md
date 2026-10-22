# WSL 主机调优：hv_sock 环形缓冲与 kswapd 水位（Task `7c2e4386`）

常驻执行器 Linux 侧所在的 WSL 虚拟机要加三项内核设置，防止 Windows→WSL 的 hv_sock 连接因内存碎片建不起来。2026-10-22 07:49Z 和 13:22Z 两次 order-7 分配失败，烧掉了两个 trivy 段的 head。

| 设置 | 默认 | 改成 | 作用 |
|---|---|---|---|
| `net.core.rmem_default`、`net.core.wmem_default` | 212992 | 65536 | 新 hv_sock 通道的两块环形缓冲合起来从 order 7（512 KiB 连续）降到 order 5（128 KiB） |
| `vm.watermark_scale_factor` | 10 | 200 | kswapd 提早回收，平时每个 zone 多留约 2% 空闲 |

这个配置不属于常驻层钉住的文件，改它不会触发每批的漂移 HALT。现场生效，不需要重启 WSL，也不需要 Windows UAC。公司节点（Windows + WSL）安装时同样执行一次。

## 步骤

在 Owner 会话里用 `wsl -d Ubuntu-24.04 -u root` 运行；时间窗口由协调会话排。

1. 复制到 root 目录并核对哈希。`PKG` 是本目录在 WSL 里的路径。
   ```
   S=/var/lib/clued-wsl-host-tuning/staging-$(date -u +%Y%m%dT%H%M%SZ)
   install -d -o root -g root -m 0700 /var/lib/clued-wsl-host-tuning "$S"
   install -o root -g root -m 0700 "$PKG/clued-wsl-host-tuning" "$S/"
   install -o root -g root -m 0600 "$PKG/60-clued-ci-hvsock-memory.conf" "$S/"
   sha256sum "$S"/*
   ```
2. 先只读看计划：`python3.12 -I -B "$S/clued-wsl-host-tuning" plan --conf "$S/60-clued-ci-hvsock-memory.conf"`。
3. 生效：`... apply --conf "$S/60-clued-ci-hvsock-memory.conf" --plan <planSha256>`。
   - 有 `clued-ci-*` 单元在运行时拒绝（`CI_UNIT_ACTIVE`）。
   - 目标位置已有不同内容的文件时拒绝（`DROP_IN_DIFFERS_OWNER_DECIDES`）。
4. 另开一次 `wsl.exe` 运行 `verify`，要求 `HOST_TUNING_VERIFIED`，并且 `ringEffective: true`，即新开通道的 `write_avail` 是 61440。
   - 如果是 `false`，说明 WSL 中继自己设了缓冲，65536 不起作用，立即回退。
5. 回退：`... rollback --saved /var/lib/clued-wsl-host-tuning/previous-<UTC>.json`。写回原值，配置文件移进状态目录，不删除。

## 判定

- 生效后 24 小时内，或至少 20 个 Linux 段内，`journalctl -k --grep 'page allocation failure'` 不应再出现。
- 下次 WSL 重启后再跑一次 `verify`，确认 systemd-sysctl 在开机时重新应用了这个文件。

离线测试：在 `work/independent-ci-resident-v1` 下运行 `python -I -m unittest discover -s test -p "test_host_tuning.py"`。
