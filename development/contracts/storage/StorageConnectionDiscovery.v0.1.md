# Storage Connection Discovery v0.1：Agent 自己找存储连接编号

状态：**第 1 版已上线（PR #583，23823935，迁移与 Worker 已发布）。名称修正（§5）为候选（本 PR）。** 本文不授予迁移、发布、合并或权限变更。

日期：2026-10-06
Owner 决定：Decision `1721045d`（产品与合同一起修：Agent 自助发现已授权存储连接，不得向 Owner 索要 `connection_id`）；Decision `8d05e50a`（自助接入的存储显示可读名称，不返回 Drive ID 路径）。
Task：`1ce7cfa1`（已完成）、`7f209eed`（名称修正，project `0597aa60`）。
相关：[StorageFullCapability.v0.1.md](StorageFullCapability.v0.1.md)（读写等级）、[StorageNormalUse.v0.1.md](StorageNormalUse.v0.1.md)（normal use）。

---

## 1. 为什么

每个 `clued_storage_*` 工具都要 `connection_id`，但没有工具告诉 Agent 自己的 Binding 能用哪些连接；`clued_session_resume` 也不返回。2026-10-06，一个 Agent 往「Clued_资料中心」归档时先向 Owner 要连接编号，随后又在 Clued 记录里自己找到了。`connection_id` 是内部 ID，Owner 不应该需要知道它。

## 2. 接口

迁移 `apps/clued-cloud/supabase/migrations/20261006170000_storage_connections_list.sql`：

- `public.clued_storage_connections_v1(p_token_hash)`，只授权 `anon`（Worker 以调用方 Binding 的哈希调用，与 jobs RPC 相同）。
- 只读：不写 Receipt、不写任何行、不改授权。
- 只列出本 Binding 能用的连接。判定直接调用存储工具自己的评估函数：写入侧 `storage_policy_evaluate_v2`（动作 `inspect`，每次用一个新的 job 锁键，不对应任何 job），读取侧对 `read`、`read_content` 各调一次 `storage_read_evaluate_v1`。每次评估在自己的子事务里；被拒只表示该类不可用，不说明原因。三类都不可用的连接不出现，Agent 因此不会知道它不能用的根目录。
- 每项字段：`connection_id`、`name`（Owner 在存储页给的名称 `display_name`，没有时取根目录最后一段）、`managed_root`（登记的根路径；只是 Drive ID 时为 null，见 §5）、`project_id`、`tracks`、`inspect`、`write_levels`（策略里除 `inspect` 外的等级，顺序固定：`create_file`、`create_topic`、`modify`、`overwrite`、`modify_subtree`、`destructive`）、`read`、`normal_use`（有 `read_content`、`content_profile` 为 `normal/1`、且 Google 授权覆盖 normal）。不返回 provider subject、凭据、Receipt 或 Owner 的其它 Binding；名称修正（§5）之后也不再返回 Drive ID。最多 50 项，`complete` 标明是否截断。

Worker（`worker/storage-connections.ts`、`continuity.ts`）：

- 新工具 `clued_storage_connections`，无参数，只读。存储读或存储 jobs 任一开着就出现，两者都关时不出现、调用返回 404。
- 只列出本部署提供的工具对应的类：jobs 关闭时清空 `inspect`、`write_levels`；读关闭时清空 `read`、`normal_use`；清空后什么都不剩的连接不列出。
- 对数据库回答做精确投影：多出的字段、未知等级、重复类、非法 ID 都按 `storage_connections_unavailable` 处理。被拒、未知 Binding 和数据库故障对外是同一个固定错误码。
- 不需要 context scope（`requiredToolScopes` 返回 `[]`），与其它存储工具一样由存储评估函数决定。
- 所有存储工具的 `connection_id` 参数说明都写明：从 `clued_storage_connections` 取，不要向用户要。

列表只是提示，不是准入：每个存储调用执行时仍各自检查授权。

## 3. 合同

Agent 合同 v36 §7.11、Clued Skill 1.0.8：存储连接自己找，绝不向 Owner 要 `connection_id`；多个候选时按名称请 Owner 选；列表为空或缺等级时告诉 Owner 在 Clued 存储页为哪个存储打开哪个等级；Host 没有这个工具时先用 `clued_search_context` 在记录里找，找不到就请 Owner 重连 Clued 连接器。其它能用 Clued 工具查到的内部 ID 同样不向 Owner 要。

## 4. 上线

上线顺序：先迁移，再发布 Worker。Worker 先上而迁移未到时，工具只会返回 `storage_connections_unavailable`，不影响其它存储工具。

1. 合入本 PR（Task `1ce7cfa1`）。
2. 生产迁移 `20261006170000_storage_connections_list.sql`（`migration.production`）与 Worker 发布（`release.production`），Owner 在 Clued 页面批准（Task `1ce7cfa1`）。
3. 新合同 v36 经 `/clued-agent.md` 随 Worker 发布提供（Task `1ce7cfa1`）。

## 5. 名称修正

上线后实测：存储页自助接入的根目录登记为 `/clued-cloud/google-drive/<Drive 文件夹 ID>`，于是 `name` 显示成 Drive ID，`managed_root` 也带出 Drive ID。迁移 `20261007000000_storage_connections_display_name.sql` 以锚定补丁改 `clued_storage_connections_v1`：

- `name` 优先取档案的 `display_name`（Owner 在存储页给的文件夹名，例如「cs」），没有时仍取根路径最后一段。
- `managed_root` 匹配 `/clued-cloud/google-drive/<ID>` 时返回 null，其它根路径照常返回。Agent 用相对根目录的路径（例如 `90_待归类/note.md`），所有存储工具都接受。
- Worker 接受 null 的 `managed_root`，工具说明写明这一点并提示用相对路径。

上线顺序与第 1 版相反：先发布 Worker（接受 null），再应用迁移。若先迁移，旧 Worker 会把 null 当作非法回答，工具在两步之间返回 `storage_connections_unavailable`。

1. 合入本 PR（Task `7f209eed`）。
2. Worker 发布（`release.production`），再生产迁移 `20261007000000_storage_connections_display_name.sql`（`migration.production`），Owner 在 Clued 页面一次批准（Task `7f209eed`）。
