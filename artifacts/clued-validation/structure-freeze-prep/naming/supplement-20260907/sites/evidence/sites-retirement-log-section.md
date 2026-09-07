
---

## 26. 2026-08-24：ChatGPT Sites 项目已永久删除

### 26.1 删除前提与用户授权

- version 4 源码已保存到私有仓库 `apps/clued-cloud/`，正式 Cloudflare Worker `clued-cloud` 已运行 Kernel `0.3.0`，P0 与双 Binding 生产验收均通过。
- 用户先明确要求“直接删除 Sites 项目”，随后在永久删除前再次确认“确认永久删除 Sites 项目”。
- 删除目标仅为 ChatGPT Sites 项目 `Clued / clued-cloud`；不包含 Cloudflare Worker、正式域名、Supabase、GitHub 源码、DNS 或 Binding 数据。

### 26.2 实际删除与复查

- 在 ChatGPT Sites 设置的危险区域输入 URL slug `clued-cloud` 并执行“永久删除”。
- UI 返回明确结果：`已永久删除 Clued`。
- 删除后 Sites 列表显示“你还没有创建任何站点”；Sites 管理接口再次列举返回 `0` 个项目。
- 已删除内容包括 `https://clued-cloud.tdoljyj.chatgpt.site`、Sites 部署和 Sites 版本历史；该删除不可在 Sites 中直接恢复，如需重建必须从私有仓库源码重新创建。

### 26.3 当前生产真值与下一步

- 正式产品入口保持 `https://clued.pixelgrav.com`，仍由 Cloudflare Worker `clued-cloud` 提供 Kernel `0.3.0`。
- Supabase Canonical Context、生产 Worker Version、回滚 LKG、DNS、私有源码和已完成的双 Binding 验收均未受影响。
- 后续不得再把 ChatGPT Sites 当作 Clued 的生产部署或必要回滚来源。

> 下一步：继续补齐 Clued Cloud 的真实用户 Memory CRUD 与账号产品闭环；Sites 清理已经完成，不再列为待办。

