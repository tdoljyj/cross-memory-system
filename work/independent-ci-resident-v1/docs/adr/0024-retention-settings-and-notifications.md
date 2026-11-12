# 0024：归档保留配置与正常通知

状态：本地候选；Task `0ee7142e`。本变更不部署配置、不清理主机数据。

缺少 `owner/retention-keep.json` 继续拒绝删除，但不再只有内部拒绝回执。服务写告警回执，伴随程序只读服务回执，把固定文案送入现有用户通知队列；同类问题每天至多一次，通知失败不记成功。服务不写用户目录，伴随程序不写、封存或修复服务回执。磁盘和归档体积提醒也进入这个通道。

可选配置 `owner/retention-settings.json` 使用 `clued.independent-ci.retention-settings/1`。缺文件保留旧默认：各成功/失败类 20 GiB、至少 10 目录、每轮最多 16 个删除。无效、不可读、重定向或读取中变化的配置拒绝清理；每次删除前重新确认配置和保留清单。Linux 工具从既有 Owner 目录读取同一文件，不接受任意命令路径。

字段：

- `windows` / `linux`：可分别指定 `success`、`failure`；每类必须同时给出非负安全整数 `classBudgetBytes` 和正安全整数 `minKeepPerClass`。未指定类用旧默认。
- `emptyKeep`：`legacy`（缺省）保持显式空清单仍按额度清理的旧行为，并告警尚待确认；`refuse` 拒绝空清单；`allow` 明确允许按额度清理。空清单始终不表示无上限删除。
- `generations`：`enabled` 布尔值、`keepNewest: 3`、`protected` 精确目录名数组。缺省不删除旧代；有多余候选时提示。仅维护工具在显式 `--apply` 加 `enabled: true` 时清理 `archive/gN` 或 `archive/gN-数字`，按不同代号留最近三个，同时保护当前代和显式名单；`live`、`generations/`、回退档案不在写边界。整个库存先核验正式代际记录；未知/未结束升级、改变授权或边界均拒绝后续清理。删除失败记录可能部分完成，不冒充已完整删除。
- `disk`：非负安全整数 `thresholdBytes` 和不重复的盘符数组 `drives`（如 `C:`、`D:`）。缺省 C:、30 GiB。读盘失败也提示，不阻断批次。

示例只展示旧默认与关闭的代际清理，不替 Owner 决定额度或启用：

```json
{
  "contract": "clued.independent-ci.retention-settings/1",
  "emptyKeep": "legacy",
  "generations": { "enabled": false, "keepNewest": 3, "protected": [] },
  "disk": { "thresholdBytes": 32212254720, "drives": ["C:", "D:"] }
}
```

`archive/` 现有 ACL 只有 SYSTEM/Administrators 可写，Owner 只读，服务无访问权。因此服务不巡查该目录；伴随程序仅以 Owner 读权限盘点并通知。维护工具 `node tools/retention-generations.mjs --root <resident-root>` 默认预览；实际删除另需明确 `--apply`、Owner 配置及既有维护身份。工具不提权、不改 ACL，也不启动升级服务。它随仓库交付，不假装已取得运行权限。

额度、空清单策略和代际清理启用由 Owner 决定。冻结升级通道保持原样；虚拟盘迁移仍属独立 M5-b 工作。Windows 本地测试与静态复核不替代 Linux CI、正式打包和部署验收。
