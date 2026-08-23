# Context mirrors

本目录保存经用户明确授权、用于生产切换前连续性的上下文镜像。

## 目录约定

```text
memory/contexts/
└── projects/
    └── <product-slug>/
        └── 日志.md
```

当前 Clued 路径：`projects/clued/日志.md`，对应当前仓库所有者的 `project:clued` 工作日志与长期记忆，不是产品开发日志。

`routes.json` 是低成本、确定性的意图→读取集合合同。当前工作/待办/优先级类问题必须读取全局 `状态.md + 待办.md + 决策.md`，并在已授权且相关时追加项目日志；项目日志不得替代全局记忆。

## 边界

- 本目录不是生产多租户数据面。
- 生产客户日志按 `user_id + context_key` 隔离存入 Clued Canonical Context；客户不需要 GitHub 账号。
- 不把嵌套日志加入旧版 `memory/index.json`；该索引继续服务 L1–L6 平面文件与既有同步护栏。
- 未获用户明确授权，不得把日志复制到公共仓库、Skill、提示词、CI 产物或构建输出。
