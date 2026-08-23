# Clued

Clued 是 Pixel Gravity 的统一 AI 个人上下文与授权记忆系统。

## 只看这三个文件

- [CURRENT_STATUS.md](CURRENT_STATUS.md)：当前到底做到哪、版本是多少、哪个分支有效。
- [docs/README.md](docs/README.md)：文档和证据分别放在哪里。
- [memory/contexts/projects/clued/日志.md](memory/contexts/projects/clued/日志.md)：当前仓库所有者在 `project:clued` 上下文中的工作日志与长期记忆（私有仓库生产前镜像）。

不要再从文件名里的 `vNext`、`R3`、`R4`、`R5`、`v0.1` 猜当前版本。

## 当前结论

| 项目 | 当前口径 |
|---|---|
| 唯一产品主线 | `main` |
| `main` 仓库基线 | `vNext-2.0` |
| 最新内核候选 | `Clued Kernel R5.1 Beta Candidate` |
| 候选产品版本 | `0.2.0` |
| Runtime 兼容线 | `0.2.x` |
| 协议版本 | `0.3.0` |
| 合同版本 | `1.1.0` |
| 语义召回 | Disabled；R4 terminal NO-GO |
| 正式 Release | 尚未发布 |

R5.1 候选目前仍在 `r5.1-fast-close`，没有借本次仓库整理合并进 `main`。

## 目录

| 目录 | 用途 |
|---|---|
| `clued/` | Clued Runtime、授权、生命周期与同步控制 |
| `memory_engine/` | 记忆对象、写入、召回、冲突、审计 |
| `memory/` | 旧 L1–L6 Canonical Memory 与按用户上下文组织的生产前镜像；禁止当普通文档整理 |
| `adapters/` | 智能体/CLI 适配层 |
| `memory_eval/` | 召回评测实现 |
| `memory_eval_baseline/` | 冻结基线产物 |
| `tests/` | 自动化验证 |
| `tools/` | 迁移与试运行工具 |
| `docs/` | 架构、Gate、证据和历史资料 |

## 入口

```powershell
python clued.py --help
python memory.py --help
python sync-memory.py doctor
```

真实迁移、真实 Binding 切换、语义召回启用、发布和部署仍受单独授权约束。
